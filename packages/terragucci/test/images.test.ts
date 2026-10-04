import { readFileSync } from "node:fs";
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
  ] as const)("%s runs in %s", (binary, ref) => {
    expect(imageReference(imageFor(binary, {})!)).toBe(ref);
  });

  it("a published image is named by digest, with its tag kept", () => {
    const tag = `ghcr.io/intentius/terragucci-tofu:${imageTag("tofu")}`;
    expect(imageReference(imageFor("tofu", { [tag]: DIGEST })!)).toBe(`${tag}@${DIGEST}`);
  });

  it("there is no image for choudoufu or cdktn yet", () => {
    expect(imageFor("choudoufu")).toBeUndefined();
    expect(imageFor("cdktn")).toBeUndefined();
  });

  it.each([
    ["github", "container:\n      image: "],
    ["forgejo", "container:\n      image: "],
    ["gitlab", "image:\n    name: "],
  ] as const)("a %s pipeline runs every job in the pinned image", (forge, shape) => {
    const image = `ghcr.io/intentius/terragucci-tofu:${imageTag("tofu")}@${DIGEST}`;
    const out = renderPipeline({ forge, binary: "tofu", version: TOOL_VERSIONS.tofu, image, layers: [["a"]], env: {} }).content;
    expect(out.split(shape + image).length - 1).toBe(3);
    expect(out).toContain("pinned by digest");
    expect(out).not.toContain("terragucci install");
    expect(out).not.toMatch(/curl|unzip/);
  });

  it("a repo pinning a version the image does not carry installs it in each job", async () => {
    const dir = write(twoRootRepo(), { "network/versions.tf": 'terraform {\n  required_version = "1.12.0"\n}\n', "app/versions.tf": 'terraform {\n  required_version = "1.12.0"\n}\n' });
    git(dir, "init", "-q");
    git(dir, "remote", "add", "origin", "https://gitlab.com/a/b.git");
    const r = await init(dir, { binary: "tofu" });
    const text = readFileSync(r.files[0].path, "utf-8");
    expect(r.version).toEqual({ value: "1.12.0", reason: "required_version" });
    expect(text.split('dir="$(terragucci install tofu 1.12.0)"').length - 1).toBe(3);
    expect(text).toContain('export PATH="$dir:$PATH"');
  });
});
