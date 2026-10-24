// Prepared images: the recipe's files and tf-check's mirror step, on small fixtures. Nothing is built or pulled.
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { imageMirror, imageName, imageProblems, MIRROR_DIR } from "../src/config";
import { checkMirror, hostPlatform, lockFiles, mirrorHas, planRecipe } from "../src/image-recipe";
import { checkScript } from "../src/render";
import { terragruntCheckScript } from "../src/render-terragrunt";
import { tmp, write } from "./helpers";

const lock = (providers: Record<string, string>): string =>
  Object.entries(providers)
    .map(([a, v]) => `provider "${a}" {\n  version     = "${v}"\n  constraints = "~> ${v}"\n  hashes = [\n    "h1:abc=",\n  ]\n}\n`)
    .join("\n");

const AWS = "registry.opentofu.org/hashicorp/aws";
const RANDOM = "registry.opentofu.org/hashicorp/random";

/** A repo with three roots: two lock the same providers, one locks another set, and a fourth has no lock file. */
function repo(): string {
  return write(tmp(), {
    "network/main.tf": 'provider "aws" {}\n',
    "network/.terraform.lock.hcl": lock({ [AWS]: "5.80.0" }),
    "app/main.tf": 'provider "aws" {}\n',
    "app/.terraform.lock.hcl": lock({ [AWS]: "5.80.0" }),
    "data/main.tf": 'provider "aws" {}\nprovider "random" {}\n',
    "data/.terraform.lock.hcl": lock({ [AWS]: "5.81.0", [RANDOM]: "3.6.0" }),
    "data/.terraform/providers/x/.terraform.lock.hcl": lock({ [AWS]: "1.0.0" }),
    "nolock/main.tf": 'provider "aws" {}\n',
  });
}

/** A packed mirror, as providers mirror writes it, holding these providers for linux_amd64. */
function mirror(entries: [string, string][]): string {
  const files: Record<string, string> = {};
  for (const [a, v] of entries) files[`${a}/terraform-provider-${a.split("/")[2]}_${v}_linux_amd64.zip`] = "zip";
  return write(tmp(), { ".keep": "", ...files });
}

describe("image config", () => {
  it("takes a reference or a map of name and mirror", () => {
    expect(imageProblems("registry.example.com/infra/tg:1", "config.image")).toEqual([]);
    expect(imageProblems({ name: "registry.example.com/infra/tg:1", mirror: true }, "config.image")).toEqual([]);
    expect(imageProblems({ name: "r/x:1", mirror: "/opt/providers" }, "config.image")).toEqual([]);
    expect(imageProblems({ mirror: true }, "config.image")[0]).toMatch(/config\.image\.name must be an image reference/);
    expect(imageProblems({ name: "r/x:1", mirror: "relative" }, "config.image")[0]).toMatch(/mirror must be true/);
    expect(imageProblems({ name: "r/x:1", labels: 1 }, "config.image")[0]).toMatch(/labels is not a setting/);
    expect(imageName({ name: "r/x:1", mirror: true })).toBe("r/x:1");
    expect(imageName("r/x:1")).toBe("r/x:1");
    expect(imageMirror("r/x:1")).toBeUndefined();
    expect(imageMirror({ name: "r/x:1" })).toBeUndefined();
    expect(imageMirror({ name: "r/x:1", mirror: true })).toBe(MIRROR_DIR);
  });
});

describe("image recipe", () => {
  it("writes one mirror module per distinct lock file, the CLI config, the Dockerfile and the build script", () => {
    const dir = repo();
    expect(lockFiles(dir)).toEqual(["app/.terraform.lock.hcl", "data/.terraform.lock.hcl", "network/.terraform.lock.hcl"]);
    const r = planRecipe(dir, { from: "ghcr.io/intentius/terragucci-tofu:1.0.0-tofu1.13.1", platforms: ["linux/amd64", "linux/arm64"] });
    expect(r.locks).toEqual(["app/.terraform.lock.hcl", "data/.terraform.lock.hcl", "network/.terraform.lock.hcl"]);
    expect(r.providers).toEqual([`${AWS} 5.80.0`, `${AWS} 5.81.0`, `${RANDOM} 3.6.0`]);
    const byPath = Object.fromEntries(r.files.map((f) => [f.path, f]));
    expect(Object.keys(byPath).sort()).toEqual(["Dockerfile", "build.sh", "mirror/01/.terraform.lock.hcl", "mirror/01/versions.tf", "mirror/02/.terraform.lock.hcl", "mirror/02/versions.tf", "terragucci.tfrc"]);
    expect(byPath["mirror/01/versions.tf"]!.content).toContain(`p0 = { source = "${AWS}", version = "= 5.80.0" }`);
    expect(byPath["mirror/01/versions.tf"]!.content).toContain("app/.terraform.lock.hcl, network/.terraform.lock.hcl");
    expect(byPath["mirror/02/versions.tf"]!.content).toContain(`p1 = { source = "${RANDOM}", version = "= 3.6.0" }`);
    expect(byPath["terragucci.tfrc"]!.content).toContain(`filesystem_mirror {\n    path = "${MIRROR_DIR}"`);
    expect(byPath["terragucci.tfrc"]!.content).not.toContain("direct");
    const docker = byPath["Dockerfile"]!.content;
    expect(docker).toContain("FROM ghcr.io/intentius/terragucci-tofu:1.0.0-tofu1.13.1\n");
    expect(docker).toContain('tofu -chdir="$d" providers mirror -platform="${TARGETOS}_${TARGETARCH}" /usr/share/terragucci/providers');
    expect(docker).toContain("ENV TF_CLI_CONFIG_FILE=/usr/share/terragucci/terragucci.tfrc");
    expect(byPath["build.sh"]!.content).toContain('docker buildx build --platform linux/amd64,linux/arm64 --push -t "$IMAGE" .');
    expect(byPath["build.sh"]!.mode).toBe(0o755);
  });

  it("builds FROM the terragucci image for the binary and one platform by default", () => {
    const r = planRecipe(repo(), { binary: "terraform" });
    expect(r.from).toMatch(/^ghcr\.io\/intentius\/terragucci-terraform:/);
    expect(r.platforms).toEqual(["linux/amd64"]);
    expect(r.files.find((f) => f.path === "Dockerfile")!.content).toContain('terraform -chdir="$d" providers mirror');
    // A Terragrunt repo builds FROM the Terragrunt image, whose OpenTofu runs the mirror.
    const tg = planRecipe(repo(), { binary: "terraform", terragrunt: true });
    expect(tg.from).toMatch(/terragucci-terragrunt:/);
    expect(tg.files.find((f) => f.path === "Dockerfile")!.content).toContain('tofu -chdir="$d" providers mirror');
  });

  it("writes an empty mirror for a repo with no lock file, and refuses a platform that is not os/arch", () => {
    const r = planRecipe(write(tmp(), { "a/main.tf": "" }), { from: "x:1" });
    expect(r.locks).toEqual([]);
    expect(r.files.map((f) => f.path)).toContain("mirror/.keep");
    expect(() => planRecipe(repo(), { from: "x:1", platforms: ["amd64"] })).toThrow(/os\/arch/);
  });
});

describe("check-mirror", () => {
  it("reads the packed and unpacked layouts for the job's platform", () => {
    const m = write(tmp(), { [`${AWS}/terraform-provider-aws_5.80.0_linux_amd64.zip`]: "z", [`${RANDOM}/3.6.0/linux_arm64/terraform-provider-random`]: "b" });
    expect(mirrorHas(m, AWS, "5.80.0", "linux_amd64")).toBe(true);
    expect(mirrorHas(m, AWS, "5.80.0", "linux_arm64")).toBe(false);
    expect(mirrorHas(m, RANDOM, "3.6.0", "linux_arm64")).toBe(true);
    expect(hostPlatform("linux", "x64")).toBe("linux_amd64");
  });

  it("passes when the mirror covers every lock file, and a root with no lock file is not a gap", () => {
    const result = checkMirror(repo(), mirror([[AWS, "5.80.0"], [AWS, "5.81.0"], [RANDOM, "3.6.0"]]), { platform: "linux_amd64", previous: null });
    expect(result.ok).toBe(true);
    expect(result.log).toEqual([expect.stringMatching(/covers every provider in 3 lock files for linux_amd64/)]);
  });

  it("warns on a provider new in this change, naming it and the rebuild", () => {
    const dir = repo();
    const prev = (l: string): string | undefined => (l === "data/.terraform.lock.hcl" ? lock({ [AWS]: "5.81.0" }) : undefined);
    const result = checkMirror(dir, mirror([[AWS, "5.80.0"], [AWS, "5.81.0"]]), { platform: "linux_amd64", previous: prev });
    expect(result.ok).toBe(true);
    expect(result.log).toEqual([expect.stringMatching(/^WARNING image mirror: registry\.opentofu\.org\/hashicorp\/random 3\.6\.0 \(data\/\.terraform\.lock\.hcl\).*rebuild the image.*next run fails/)]);
    expect(result.report.join("\n")).toContain("new in this change");
  });

  it("fails when the gap was already there at the run before", () => {
    const dir = repo();
    const prev = (l: string): string | undefined => (l === "data/.terraform.lock.hcl" ? lock({ [AWS]: "5.81.0", [RANDOM]: "3.6.0" }) : undefined);
    const result = checkMirror(dir, mirror([[AWS, "5.80.0"], [AWS, "5.81.0"]]), { platform: "linux_amd64", previous: prev });
    expect(result.ok).toBe(false);
    expect(result.log[0]).toMatch(/^FAILED image mirror: registry\.opentofu\.org\/hashicorp\/random 3\.6\.0 .*was not at the run before either; rebuild the image/);
  });

  it("reads the run before from git: the commit's first parent", () => {
    const dir = repo();
    const m = mirror([[AWS, "5.80.0"], [AWS, "5.81.0"]]);
    const g = (...a: string[]): void => void execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: dir });
    g("init", "-q");
    g("add", ".");
    g("commit", "-qm", "one");
    // The first commit has no parent, so its gap warns.
    expect(checkMirror(dir, m, { platform: "linux_amd64" }).ok).toBe(true);
    write(dir, { "README.md": "x" });
    g("add", ".");
    g("commit", "-qm", "two");
    // Still stale on the next commit: it fails.
    expect(checkMirror(dir, m, { platform: "linux_amd64" }).ok).toBe(false);
  });

  it("fails when the image has no mirror at the directory image.mirror names", () => {
    const result = checkMirror(repo(), "/nonexistent/terragucci-mirror", { platform: "linux_amd64", previous: null });
    expect(result.ok).toBe(false);
    expect(result.log[0]).toMatch(/not in the job's image/);
  });
});

describe("the check job", () => {
  it("runs check-mirror before any init only with image.mirror", () => {
    expect(checkScript("tofu", ["a"])).not.toContain("check-mirror");
    const s = checkScript("tofu", ["a"], undefined, false, false, false, false, true);
    expect(s.indexOf("terragucci check-mirror || failed=1")).toBeGreaterThan(-1);
    expect(s.indexOf("terragucci check-mirror")).toBeLessThan(s.indexOf("init -backend=false"));
    expect(terragruntCheckScript({ version: "1", parallelism: 1, exclude: [], mirror: true } as never, "tofu")).toContain("terragucci check-mirror");
  });
});
