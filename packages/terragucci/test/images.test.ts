import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import pkg from "../package.json" with { type: "json" };
import { imageFor, imageReference, imageTag, TOOL_VERSIONS } from "../src/images";
import { init } from "../src/init";
import { renderPipeline } from "../src/render";
import { git, twoRootRepo, write } from "./helpers";

const DIGEST = "sha256:" + "a".repeat(64);

describe("images", () => {
  it.each([
    ["tofu", `ghcr.io/intentius/terragucci-tofu:${pkg.version}-tofu${TOOL_VERSIONS.tofu}`],
    ["terraform", `ghcr.io/intentius/terragucci-terraform:${pkg.version}-tf${TOOL_VERSIONS.terraform}`],
    ["choudoufu", `ghcr.io/intentius/terragucci-choudoufu:${pkg.version}-choudoufu${TOOL_VERSIONS.choudoufu}`],
  ] as const)("%s runs in %s", (binary, ref) => {
    expect(imageReference(imageFor(binary, {})!)).toBe(ref);
  });

  it("a published image is named by digest, with its tag kept", () => {
    const tag = `ghcr.io/intentius/terragucci-tofu:${imageTag("tofu")}`;
    expect(imageReference(imageFor("tofu", { [tag]: DIGEST })!)).toBe(`${tag}@${DIGEST}`);
  });

  it("a choudoufu repo's pipeline runs in the choudoufu image, and its required_version is not taken as a choudoufu release", async () => {
    const dir = write(twoRootRepo(), { "network/versions.tf": 'terraform {\n  required_version = "1.13.1"\n}\n', "app/versions.tf": 'terraform {\n  required_version = "1.13.1"\n}\n' });
    git(dir, "init", "-q");
    git(dir, "remote", "add", "origin", "https://github.com/a/b.git");
    const r = await init(dir, { binary: "choudoufu" });
    const text = readFileSync(r.files[0].path, "utf-8");
    expect(r.version).toEqual({ value: TOOL_VERSIONS.choudoufu, reason: "the image" });
    expect(text).toContain(`image: ghcr.io/intentius/terragucci-choudoufu:${imageTag("choudoufu")}`);
    expect(text).not.toContain("terragucci install");
  });

  it.each([
    ["github", "container:\n      image: "],
    ["forgejo", "container:\n      image: "],
    ["gitlab", "image:\n    name: "],
  ] as const)("a %s pipeline runs every job in the pinned image", (forge, shape) => {
    const image = `ghcr.io/intentius/terragucci-tofu:${imageTag("tofu")}@${DIGEST}`;
    const out = renderPipeline({ forge, binary: "tofu", version: TOOL_VERSIONS.tofu, image, layers: [["a"]], env: {} }).content;
    // check, fmt, plan, one apply wave, tips; GitHub and Forgejo also render the plan-note job, the comment re-plan job and its note job, and the comment apply job.
    expect(out.split(shape + image).length - 1).toBe(forge === "gitlab" ? 5 : 9);
    expect(out).toContain("pinned by digest");
    expect(out).not.toContain("terragucci install");
    expect(out).not.toMatch(/curl|unzip/);
  });

  // A job's user often differs from its checkout's owner (root in a github.com
  // container job, the runner's user on the workspace), so each CI image marks
  // every directory safe for git in its system config, after git is installed.
  it.each(["tofu", "terraform", "terragrunt", "choudoufu"])("the %s image lets git into a checkout another user owns", (name) => {
    const dockerfile = readFileSync(join(import.meta.dirname, "../../../images", `Dockerfile.${name}`), "utf-8");
    const final = dockerfile.slice(dockerfile.lastIndexOf("\nFROM "));
    const runs = final.split("\n").filter((l) => l.startsWith("RUN "));
    const git = runs.findIndex((l) => l.includes("install -y --no-install-recommends git "));
    expect(git).toBeGreaterThanOrEqual(0);
    expect(runs.indexOf("RUN git config --system --add safe.directory '*'")).toBeGreaterThan(git);
  });

  // A uid with no passwd entry leaves Go without a user name, and tofu with an OTLP
  // endpoint fails on it, so every CI image's final stage defaults USER and HOME.
  it.each(["tofu", "terraform", "terragrunt", "choudoufu"])("the %s image sets USER and HOME for a uid with no passwd entry", (name) => {
    const dockerfile = readFileSync(join(import.meta.dirname, "../../../images", `Dockerfile.${name}`), "utf-8");
    const final = dockerfile.slice(dockerfile.lastIndexOf("\nFROM "));
    expect(final).toMatch(/^ENV USER=\S+/m);
    expect(final).toMatch(/^ENV HOME=\/tmp/m);
  });

  it("a repo pinning a version the image does not carry installs it in each job", async () => {
    const dir = write(twoRootRepo(), { "network/versions.tf": 'terraform {\n  required_version = "1.12.0"\n}\n', "app/versions.tf": 'terraform {\n  required_version = "1.12.0"\n}\n' });
    git(dir, "init", "-q");
    git(dir, "remote", "add", "origin", "https://gitlab.com/a/b.git");
    const r = await init(dir, { binary: "tofu" });
    const text = readFileSync(r.files[0].path, "utf-8");
    expect(r.version).toEqual({ value: "1.12.0", reason: "required_version" });
    expect(text.split('dir="$(terragucci install tofu 1.12.0)"').length - 1).toBe(text.split(/^\s+(?:after_)?script:/m).length - 1);
    expect(text).toContain('export PATH="$dir:$PATH"');
  });
});
