// A root's own OpenTofu or Terraform version: where it is read from, how the
// stages install it once per version, and what the report and the note say.
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyWave } from "../src/apply";
import { main } from "../src/cli";
import { validateConfig } from "../src/config";
import { init } from "../src/init";
import type { Tool } from "../src/install";
import { RootBinaries, rootPin, versionFileRelease } from "../src/pins";
import { checkScript } from "../src/render";
import { runStage } from "../src/report/stage";
import { binariesLine } from "../src/report/views";
import type { Report } from "../src/report/schema";
import { git, tmp, write } from "./helpers";

const TOFU = spawnSync("tofu", ["version"]).status === 0;

/** A stand-in for tofu that says it is `version`, and logs each command and the root it ran in to $LOG as `<version> <command> <root>`. */
function fakeTofu(dir: string, version: string): string {
  mkdirSync(dir, { recursive: true });
  const bin = join(dir, "tofu");
  writeFileSync(bin, `#!/usr/bin/env bash
if [ "$1" = version ]; then echo '{"terraform_version":"${version}"}'; exit 0; fi
dir="\${1#-chdir=}"; root="$(basename "$dir")"
echo "${version} $2 $root" >> "$LOG"
case "$2" in
  plan) for a in "$@"; do case "$a" in -out=*) echo "$root" > "\${a#-out=}" ;; esac; done; echo "Plan: 1 to add" ;;
  show) cat "$PLANS/$(cat "\${@: -1}").json" ;;
  apply) echo "Apply complete! Resources: 1 added, 0 changed, 0 destroyed." ;;
esac
exit 0
`);
  chmodSync(bin, 0o755);
  return bin;
}

const tf = 'resource "terraform_data" "x" {\n  input = 1\n}\n';

describe("versionFileRelease", () => {
  it.each([
    ["1.10.6\n", "1.10.6"],
    ["# pinned for the legacy provider\nv1.9.1\n", "1.9.1"],
    ["  1.11.0-rc1  \n", "1.11.0-rc1"],
    ["latest\n", undefined],
    ["min-required\n", undefined],
    ["latest:^1.9\n", undefined],
    ["", undefined],
  ])("%j names %s", (text, release) => {
    expect(versionFileRelease(text)).toBe(release);
  });
});

describe("rootPin", () => {
  const repo = write(tmp(), {
    "legacy/.opentofu-version": "1.9.1\n",
    "legacy/main.tf": tf,
    "exact/main.tf": 'terraform {\n  required_version = "= 1.10.6"\n}\n',
    "range/main.tf": 'terraform {\n  required_version = ">= 1.10"\n}\n',
    "both/.opentofu-version": "1.11.2\n",
    "both/main.tf": 'terraform {\n  required_version = "1.10.6"\n}\n',
    "tf/.terraform-version": "1.14.0\n",
    "tf/main.tf": tf,
    "plain/main.tf": tf,
  });

  it("reads a version file, then an exact required_version; a range is no pin", () => {
    expect(rootPin(repo, "legacy", "tofu")).toEqual({ version: "1.9.1", source: ".opentofu-version" });
    expect(rootPin(repo, "exact", "tofu")).toEqual({ version: "1.10.6", source: "required_version" });
    expect(rootPin(repo, "both", "tofu")).toEqual({ version: "1.11.2", source: ".opentofu-version" });
    expect(rootPin(repo, "range", "tofu")).toBeUndefined();
    expect(rootPin(repo, "plain", "tofu")).toBeUndefined();
  });

  it("reads the file of the binary the repo runs", () => {
    expect(rootPin(repo, "tf", "terraform")).toEqual({ version: "1.14.0", source: ".terraform-version" });
    expect(rootPin(repo, "tf", "tofu")).toBeUndefined();
    expect(rootPin(repo, "legacy", "terraform")).toBeUndefined();
  });

  it("takes terragucci.yml's glob first, and pins nothing for choudoufu", () => {
    const version = { "leg*": "1.8.8", "plain": "1.10.6" };
    expect(rootPin(repo, "legacy", "tofu", version)).toEqual({ version: "1.8.8", source: "terragucci.yml version leg*" });
    expect(rootPin(repo, "plain", "tofu", version)).toEqual({ version: "1.10.6", source: "terragucci.yml version plain" });
    expect(rootPin(repo, "exact", "tofu", version)).toEqual({ version: "1.10.6", source: "required_version" });
    expect(rootPin(repo, "legacy", "tofu", "1.10.6")).toEqual({ version: "1.9.1", source: ".opentofu-version" });
    expect(rootPin(repo, "exact", "choudoufu", version)).toBeUndefined();
  });
});

describe("RootBinaries", () => {
  it("runs the job's binary for a root with no pin or a pin it carries, and installs any other version once", async () => {
    const dir = tmp();
    const job = fakeTofu(join(dir, "job"), "1.13.1");
    const repo = write(tmp(), {
      "a/main.tf": tf,
      "b/.opentofu-version": "1.13.1\n",
      "c/.opentofu-version": "1.10.6\n",
      "d/main.tf": 'terraform {\n  required_version = "1.10.6"\n}\n',
    });
    const installs: string[] = [];
    const installer = async (tool: Tool, version: string): Promise<string> => {
      installs.push(`${tool} ${version}`);
      fakeTofu(join(dir, version), version);
      return join(dir, version);
    };
    const binaries = new RootBinaries(repo, job, undefined, { PATH: process.env.PATH }, installer);
    const [a, b, c, d] = await Promise.all(["a", "b", "c", "d"].map((r) => binaries.resolve(r)));
    expect(a).toEqual({ path: job, name: "tofu", version: "1.13.1" });
    expect(b).toEqual({ path: job, name: "tofu", version: "1.13.1", pin: ".opentofu-version" });
    expect(c).toEqual({ path: join(dir, "1.10.6", "tofu"), name: "tofu", version: "1.10.6", pin: ".opentofu-version" });
    expect(d).toEqual({ path: join(dir, "1.10.6", "tofu"), name: "tofu", version: "1.10.6", pin: "required_version" });
    expect(installs).toEqual(["tofu 1.10.6"]);
  });

  it("names the root and its pin when the version cannot be installed", async () => {
    const job = fakeTofu(join(tmp(), "job"), "1.13.1");
    const repo = write(tmp(), { "old/.opentofu-version": "1.5.7\n" });
    const binaries = new RootBinaries(repo, job, undefined, { PATH: process.env.PATH }, async () => {
      throw new Error("https://github.com/opentofu/opentofu/releases/download/v1.5.7/tofu_1.5.7_SHA256SUMS answered 404");
    });
    await expect(binaries.resolve("old")).rejects.toThrow(/^old pins tofu 1\.5\.7 \(\.opentofu-version\), which was not installed: .*answered 404/);
  });

  it("refuses off Linux by default, rather than fetch a build that would not run", async () => {
    if (process.platform === "linux") return;
    const job = fakeTofu(join(tmp(), "job"), "1.13.1");
    const repo = write(tmp(), { "old/.opentofu-version": "1.10.6\n" });
    await expect(new RootBinaries(repo, job, undefined, { PATH: process.env.PATH }).resolve("old")).rejects.toThrow(/Linux builds/);
  });
});

/** A plan that creates one resource, as show -json prints it. */
const created = JSON.stringify({ resource_changes: [{ address: "terraform_data.x", mode: "managed", type: "terraform_data", name: "x", change: { actions: ["create"], before: null, after: { input: "1" }, after_unknown: {} } }] });

describe("a stage whose roots run two versions", () => {
  afterEach(() => vi.unstubAllEnvs());

  function setup(pinA = "1.10.6"): { dir: string; repo: string; job: string; log: string; installer: (tool: Tool, version: string) => Promise<string>; installs: string[] } {
    const dir = tmp("tg-pins-");
    const plans = join(dir, "plans");
    mkdirSync(plans);
    for (const r of ["a", "b"]) writeFileSync(join(plans, `${r}.json`), created);
    const log = join(dir, "run.log");
    vi.stubEnv("PLANS", plans);
    vi.stubEnv("LOG", log);
    const repo = join(dir, "work");
    write(repo, { "a/main.tf": tf, ...(pinA ? { "a/.opentofu-version": `${pinA}\n` } : {}), "b/main.tf": tf });
    const installs: string[] = [];
    const installer = async (tool: Tool, version: string): Promise<string> => {
      installs.push(`${tool} ${version}`);
      fakeTofu(join(dir, "installed", version), version);
      return join(dir, "installed", version);
    };
    return { dir, repo, job: fakeTofu(join(dir, "job"), "1.13.1"), log, installer, installs };
  }

  it("tf-plan plans a pinned root with its own version and the other with the job's, and the report and note name both", async () => {
    const { repo, job, log, installer, installs } = setup();
    const logs: string[] = [];
    const { report, dir } = await runStage("tf-plan", repo, { binary: job, layers: [["a", "b"]], installer, env: { ...process.env } }, (l) => logs.push(l));
    const lines = readFileSync(log, "utf-8").trim().split("\n");
    expect(lines.filter((l) => l.endsWith(" a")).every((l) => l.startsWith("1.10.6 "))).toBe(true);
    expect(lines.filter((l) => l.endsWith(" b")).every((l) => l.startsWith("1.13.1 "))).toBe(true);
    expect(lines).toContain("1.10.6 plan a");
    expect(lines).toContain("1.13.1 plan b");
    expect(installs).toEqual(["tofu 1.10.6"]);
    expect(logs).toContain("a: tofu 1.10.6 (.opentofu-version)");
    expect(report.roots.map((r) => [r.path, r.binary])).toEqual([
      ["a", { name: "tofu", version: "1.10.6", pin: ".opentofu-version" }],
      ["b", { name: "tofu", version: "1.13.1" }],
    ]);
    expect(readFileSync(join(dir, "note.md"), "utf-8")).toContain("Binaries: tofu 1.10.6 for `a` (.opentofu-version); tofu 1.13.1 for 1 root.");
    expect(readFileSync(join(dir, "report.html"), "utf-8")).toContain('<span class="binary">tofu 1.10.6 (.opentofu-version)</span>');
  });

  it("tf-plan with no pin runs the job's binary for every root, installs nothing, and the note says nothing of binaries", async () => {
    const { repo, job, log, installer, installs } = setup("");
    const { report, dir } = await runStage("tf-plan", repo, { binary: job, layers: [["a", "b"]], installer, env: { ...process.env } }, () => {});
    expect(readFileSync(log, "utf-8").trim().split("\n").every((l) => l.startsWith("1.13.1 "))).toBe(true);
    expect(installs).toEqual([]);
    expect(report.roots.map((r) => r.binary?.version)).toEqual(["1.13.1", "1.13.1"]);
    expect(readFileSync(join(dir, "note.md"), "utf-8")).not.toContain("Binaries:");
  });

  it("a pin that cannot be installed fails that root alone, naming the pin", async () => {
    const { repo, job } = setup();
    const { report } = await runStage("tf-plan", repo, { binary: job, layers: [["a", "b"]], installer: async () => { throw new Error("answered 404"); }, env: { ...process.env } }, () => {});
    expect(report.roots.map((r) => [r.path, r.status])).toEqual([["a", "failed"], ["b", "planned"]]);
    expect(report.roots[0].error).toMatch(/a pins tofu 1\.10\.6 \(\.opentofu-version\), which was not installed: answered 404/);
  });

  it("tf-apply plans and applies each root of one wave with its own version, and the wave's report names both", async () => {
    const { repo, job, log, installer, installs } = setup();
    git(repo, "init", "-q", "-b", "main");
    git(repo, "add", "-A");
    git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "one");
    vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(await applyWave(repo, { wave: 1, layers: [["a", "b"]], binary: job, gate: "never", installer, env: { PATH: process.env.PATH } })).toBe(0);
    } finally {
      vi.restoreAllMocks();
    }
    const lines = readFileSync(log, "utf-8").trim().split("\n");
    expect(lines).toEqual(expect.arrayContaining(["1.10.6 plan a", "1.10.6 apply a", "1.13.1 plan b", "1.13.1 apply b"]));
    expect(lines.filter((l) => l.endsWith(" a")).every((l) => l.startsWith("1.10.6 "))).toBe(true);
    expect(installs).toEqual(["tofu 1.10.6"]);
    const report = JSON.parse(readFileSync(join(repo, "terragucci-report", "report.json"), "utf-8")) as Report;
    expect(report.roots.map((r) => [r.path, r.binary])).toEqual([
      ["a", { name: "tofu", version: "1.10.6", pin: ".opentofu-version" }],
      ["b", { name: "tofu", version: "1.13.1" }],
    ]);
  });
});

describe.skipIf(!TOFU)("a real tofu root pinned to the version on the path", () => {
  it("plans with the tofu on the path and installs nothing", { timeout: 60_000 }, async () => {
    const version = (JSON.parse(spawnSync("tofu", ["version", "-json"], { encoding: "utf-8" }).stdout) as { terraform_version: string }).terraform_version;
    const repo = write(tmp(), { "a/main.tf": `terraform {\n  required_version = "${version}"\n}\n\n${tf}` });
    const { report } = await runStage("tf-plan", repo, { binary: "tofu", layers: [["a"]], installer: async () => { throw new Error("installed"); } }, () => {});
    expect(report.roots[0]).toMatchObject({ status: "planned", binary: { name: "tofu", version, pin: "required_version" } });
  });
});

describe("terragucci binary", () => {
  it("prints the binary a root runs on stdout and what it is on stderr", async () => {
    const job = fakeTofu(join(tmp(), "job"), "1.13.1");
    const repo = write(tmp(), { "a/main.tf": tf, "b/.opentofu-version": "1.13.1\n" });
    const cwd = process.cwd();
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      process.chdir(repo);
      expect(await main(["binary", "a", "--binary", job])).toBe(0);
      expect(await main(["binary", "b", "--binary", job])).toBe(0);
      expect(await main(["binary"])).toBe(2);
    } finally {
      process.chdir(cwd);
    }
    expect(out.mock.calls.map((c) => c[0])).toEqual([job, job]);
    expect(err.mock.calls.map((c) => String(c[0]))).toEqual(expect.arrayContaining(["a: tofu 1.13.1", "b: tofu 1.13.1 (.opentofu-version)"]));
    vi.restoreAllMocks();
  });
});

describe("the note's binaries line", () => {
  const root = (path: string, binary?: { name: string; version?: string; pin?: string }) => ({ path, ...(binary ? { binary } : {}) });
  it("names each pinned root with its pin and counts the rest, by binary", () => {
    const report = { roots: [root("0", { name: "tofu", version: "1.13.1" }), root("a", { name: "tofu", version: "1.9.1", pin: ".opentofu-version" }), root("b", { name: "tofu", version: "1.13.1" }), root("c", { name: "tofu", version: "1.13.1" }), root("d", { name: "tofu", version: "1.9.1", pin: "terragucci.yml version d" })] } as unknown as Report;
    expect(binariesLine(report)).toBe("Binaries: tofu 1.9.1 for `a` (.opentofu-version) and `d` (terragucci.yml version d); tofu 1.13.1 for 3 roots.");
  });
  it("says nothing when no root pinned", () => {
    expect(binariesLine({ roots: [root("a", { name: "tofu", version: "1.13.1" })] } as unknown as Report)).toBeUndefined();
  });
});

describe("version per root glob in terragucci.yml", () => {
  const problems = (raw: unknown): string => {
    try {
      validateConfig(raw, "terragucci.yml");
      return "";
    } catch (e) {
      return (e as Error).message;
    }
  };
  it("takes a map of glob to release in a repo's own file", () => {
    expect(problems({ version: { "envs/legacy/*": "1.9.1", "**": "1.10.6" } })).toBe("");
    expect(problems({ version: "1.10.6" })).toBe("");
  });
  it("refuses a release that is not one, choudoufu, and a map in a control repo", () => {
    expect(problems({ version: { a: 1.1 } })).toMatch(/version\["a"\] must be a release version/);
    expect(problems({ version: { a: "latest" } })).toMatch(/version\["a"\] must be a release version/);
    expect(problems({ version: ["1.9.1"] })).toMatch(/version must be a release version, or a map/);
    expect(problems({ binary: "choudoufu", version: { a: "0.24.0" } })).toMatch(/choudoufu runs one release/);
    expect(problems({ defaults: { version: { a: "1.9.1" } }, projects: { "github.com/o/r": {} } })).toMatch(/defaults\.version: a version per root glob goes in the project's own terragucci\.yml/);
  });
});

describe("init with roots that pin their own version", () => {
  it("names the pins, and the check job runs each root with the binary terragucci binary names for it", async () => {
    const repo = write(tmp(), {
      "terragucci.yml": 'forge: github\nbinary: tofu\nversion:\n  "envs/old": "1.8.8"\n',
      "envs/old/main.tf": 'terraform {\n  backend "local" {}\n}\n',
      "envs/legacy/main.tf": 'terraform {\n  backend "local" {}\n}\n',
      "envs/legacy/.opentofu-version": "1.9.1\n",
      "envs/new/main.tf": 'terraform {\n  backend "local" {}\n}\n',
    });
    const r = await init(repo, { dryRun: true });
    expect(r.pins).toEqual([
      { root: "envs/legacy", version: "1.9.1", source: ".opentofu-version" },
      { root: "envs/old", version: "1.8.8", source: "terragucci.yml version envs/old" },
    ]);
    const pipeline = r.files[0].content;
    expect(pipeline).toContain('bin="$(terragucci binary "$dir" --binary tofu)"');
    expect(pipeline).toContain('terragucci check-root "$dir" --binary "$bin"');
  });

  it("with no pin, writes the check job as before", async () => {
    const repo = write(tmp(), { "terragucci.yml": "forge: github\nbinary: tofu\n", "envs/a/main.tf": 'terraform {\n  backend "local" {}\n}\n' });
    const r = await init(repo, { dryRun: true });
    expect(r.pins).toEqual([]);
    expect(r.files[0].content).not.toContain("terragucci binary");
    expect(checkScript("tofu", ["envs/a"])).toBe(checkScript("tofu", ["envs/a"], undefined, false));
  });

  it("takes the repo's own .opentofu-version as the version every job installs", async () => {
    const repo = write(tmp(), { "terragucci.yml": "forge: github\n", ".opentofu-version": "1.10.6\n", "envs/a/main.tf": 'terraform {\n  backend "local" {}\n}\n' });
    const r = await init(repo, { dryRun: true });
    expect(r.binary.value).toBe("tofu");
    expect(r.version).toEqual({ value: "1.10.6", reason: ".opentofu-version" });
    expect(r.pins).toEqual([]);
    expect(r.files[0].content).toContain("terragucci install tofu 1.10.6");
  });

  it("takes a version map in a Terragrunt repo, pinning its units by glob", async () => {
    const repo = write(tmp(), { "terragucci.yml": 'forge: github\nversion:\n  "live/*": "1.9.1"\n', "root.hcl": "", "live/a/terragrunt.hcl": 'include "root" {\n  path = find_in_parent_folders("root.hcl")\n}\n' });
    expect((await init(repo, { dryRun: true, terragrunt: "/nonexistent/terragrunt" })).pins).toEqual([{ root: "live/a", version: "1.9.1", source: "terragucci.yml version live/*" }]);
  });
});

it("the stage's report schema lists a root's binary", () => {
  const schema = JSON.parse(readFileSync(join(__dirname, "../src/report/report.schema.json"), "utf-8"));
  expect(schema.properties.roots.items.properties.binary.required).toEqual(["name"]);
});
