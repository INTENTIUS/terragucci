import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import pkg from "../package.json" with { type: "json" };
import config from "../../../chant.config";
import { CHANT_PIN, chantAtLeast } from "../src/comment-allow";
import { ConfigError } from "../src/config";
import { carriesBase, chantTakesImageBase, CI_IMAGE_BASE_CHANT_FLOOR, ciImages, IMAGE_BASES, imageFor, imageReference, imageTag, releaseImageName, terragruntImage, TOOL_VERSIONS } from "../src/images";
import { init } from "../src/init";
import { renderPipeline } from "../src/render";
import { git, twoRootRepo, write } from "./helpers";

const DIGEST = "sha256:" + "a".repeat(64);
const CHAINGUARD_DIGEST = "sha256:" + "c".repeat(64);

/** The images dir's Dockerfile for an image of a set: Dockerfile.tofu, Dockerfile.tofuChainguard. */
const dockerfileOf = (name: string, base: "debian" | "chainguard" = "debian"): string =>
  readFileSync(join(import.meta.dirname, "../../../images", `Dockerfile.${name}${base === "chainguard" ? "Chainguard" : ""}`), "utf-8");

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

  it.each(["github", "forgejo", "gitlab"] as const)("a %s pipeline runs every job in the pinned image", (forge) => {
    const image = `ghcr.io/intentius/terragucci-tofu:${imageTag("tofu")}@${DIGEST}`;
    const out = renderPipeline({ forge, binary: "tofu", version: TOOL_VERSIONS.tofu, image, layers: [["a"]], env: {} }).content;
    // terragucci's jobs, chant's plan and commit jobs, and chant's wave, status and stale-notes jobs: each names the pinned image.
    const doc = parseYAML(out.split("\n").filter((l) => !l.startsWith("#")).join("\n")) as Record<string, any>;
    const jobs = forge === "gitlab" ? Object.entries(doc).filter(([k, j]) => k !== "stages" && k !== "include" && j && typeof j === "object" && "script" in j) : Object.entries(doc.jobs);
    expect(jobs.length).toBeGreaterThan(8);
    for (const [name, job] of jobs as [string, any][]) {
      const named = forge === "gitlab" ? (typeof job.image === "string" ? job.image : job.image?.name) : typeof job.container === "string" ? job.container : job.container?.image;
      expect(named, name).toBe(image);
    }
    expect(out).toContain("pinned by digest");
    expect(out).not.toContain("terragucci install");
    // No tool is downloaded: no curl, no unzip (as words; the report hand-over's zlib.gunzipSync is neither).
    expect(out).not.toMatch(/\bcurl\b|\bunzip\b/);
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
    // Every job that runs the binary; chant's plan-note job runs pr-post alone, in the plan notes pipeline.
    expect(text.split('dir="$(terragucci install tofu 1.12.0)"').length - 1).toBe(text.split(/^\s+(?:after_)?script:/m).length - 2);
    expect(text).toMatch(/^plan-note:\n(?:.*\n)*?  script:\n    - npx --no-install terragucci components pr-post --open/m);
    expect(text).toContain('export PATH="$dir:$PATH"');
  });

  // The Chainguard set: the same four images on Chainguard's bases (INTENTIUS/chant#5445), rendered from images/images.ts.
  describe("the Chainguard set", () => {
    it.each(ciImages)("names the %s image beside the Debian one, with a tag ending in -chainguard", (name) => {
      const pick = (base: "debian" | "chainguard") => (name === "terragrunt" ? terragruntImage({}, base) : imageFor(name, {}, base));
      const debian = pick("debian");
      const chainguard = pick("chainguard");
      expect(chainguard.repository).toBe(debian.repository);
      expect(chainguard.tag).toBe(`${debian.tag}-chainguard`);
      expect(imageReference(chainguard)).toBe(`ghcr.io/intentius/terragucci-${name}:${imageTag(name, undefined, "chainguard")}`);
      expect(releaseImageName(name, "chainguard")).toBe(`${name}-chainguard`);
      expect(releaseImageName(name)).toBe(name);
    });

    it("names the Terragrunt image of each set by the digest the release recorded for it", () => {
      const table = {
        [`ghcr.io/intentius/terragucci-terragrunt:${imageTag("terragrunt")}`]: DIGEST,
        [`ghcr.io/intentius/terragucci-terragrunt:${imageTag("terragrunt", undefined, "chainguard")}`]: CHAINGUARD_DIGEST,
      };
      expect(terragruntImage(table).digest).toBe(DIGEST);
      expect(terragruntImage(table, "chainguard").digest).toBe(CHAINGUARD_DIGEST);
    });

    it.each(ciImages)("renders the %s image on Chainguard's pinned bases, from apk, ending as a user that is not root", (name) => {
      const dockerfile = dockerfileOf(name, "chainguard");
      const froms = dockerfile.split("\n").filter((l) => l.startsWith("FROM "));
      expect(froms.length).toBe(2);
      expect(froms[0]).toMatch(/^FROM cgr\.dev\/chainguard\/wolfi-base:latest@sha256:[0-9a-f]{64} AS fetch$/);
      expect(froms[1]).toMatch(/^FROM cgr\.dev\/chainguard\/node:latest-dev@sha256:[0-9a-f]{64}$/);
      const final = dockerfile.slice(dockerfile.lastIndexOf("\nFROM "));
      const lines = final.split("\n").filter(Boolean);
      expect(lines[1]).toBe("USER root");
      expect(lines.at(-1)).toBe("USER 65532");
      expect(final).toContain("ENV CHANT_IMAGE_USER=65532");
      expect(final).toMatch(/^ENV USER=terragucci$/m);
      expect(final).toMatch(/^ENV HOME=\/tmp$/m);
      expect(final).toMatch(/^LABEL io\.intentius\.chant\.image\.base="chainguard"$/m);
      const runs = final.split("\n").filter((l) => l.startsWith("RUN "));
      const apk = runs.findIndex((l) => l.startsWith("RUN apk add --no-cache ") && l.includes(" git "));
      expect(apk).toBeGreaterThanOrEqual(0);
      expect(runs.indexOf("RUN git config --system --add safe.directory '*'")).toBeGreaterThan(apk);
      expect(final).not.toContain("apt-get");
    });

    it.each(ciImages)("keeps the %s Debian image on Debian's bases, as root", (name) => {
      const dockerfile = dockerfileOf(name);
      expect(dockerfile).toMatch(/^FROM node:22-bookworm-slim@sha256:[0-9a-f]{64}$/m);
      expect(dockerfile).toMatch(/^LABEL io\.intentius\.chant\.image\.base="debian"$/m);
      expect(dockerfile).not.toMatch(/^USER /m);
      expect(dockerfile).not.toContain("CHANT_IMAGE_USER");
    });

    // Under the supply-chain group a release refuses a FROM that names no digest (release-image-base-unpinned).
    it.each(IMAGE_BASES.flatMap((base) => ciImages.map((name) => [name, base] as const)))("pins every FROM of the %s image of the %s set by digest", (name, base) => {
      for (const line of dockerfileOf(name, base).split("\n").filter((l) => l.startsWith("FROM "))) expect(line).toMatch(/@sha256:[0-9a-f]{64}/);
    });

    it("tells a chant that takes base from one that does not", () => {
      expect(chantTakesImageBase({ CI_IMAGE_BASE_FLOOR: "0.124.113" })).toBe(true);
      expect(chantTakesImageBase({ CI_IMAGE_FLOOR: "0.124.60" })).toBe(false);
    });

    it("is declared on a chant that carries base, at the floor this package writes down", async () => {
      const chant = (await import("@intentius/chant/ci-image")) as Record<string, unknown>;
      // Before the pin moves to the release that carries it, the installed chant may be older or a local build of it.
      if (typeof chant.CI_IMAGE_BASE_FLOOR === "string") expect(chant.CI_IMAGE_BASE_FLOOR).toBe(CI_IMAGE_BASE_CHANT_FLOOR);
      // Once chant's floor is the pin, the images are declared on a chant that has it.
      if (chantAtLeast(CHANT_PIN, CI_IMAGE_BASE_CHANT_FLOOR)) expect(typeof chant.CI_IMAGE_BASE_FLOOR).toBe("string");
    });
  });

  // The release publishes both sets, and the bundle records both sets' digests.
  describe("the release", () => {
    const r = (config as { release: { images: { name: string; dockerfile: string }[]; publish: { type: string; image?: string; repository?: string; tags?: string[]; sbom?: unknown }[] } }).release;

    it("builds eight images, four in each set, each from its own Dockerfile", () => {
      expect(r.images.map((i) => i.name)).toEqual([...ciImages, ...ciImages.map((n) => `${n}-chainguard`)]);
      for (const i of r.images) expect(i.dockerfile).toMatch(/^images\/Dockerfile\.[A-Za-z]+$/);
      expect(r.images.find((i) => i.name === "tofu-chainguard")!.dockerfile).toBe("images/Dockerfile.tofuChainguard");
      expect(r.images.find((i) => i.name === "tofu")!.dockerfile).toBe("images/Dockerfile.tofu");
    });

    it("pushes each image to its repository under the tag a pipeline names, the Chainguard tags in the same repositories", () => {
      const oci = r.publish.filter((p) => p.type === "oci");
      expect(oci.length).toBe(8);
      for (const p of oci) {
        const name = p.image!.replace(/^dist\/images\//, "").replace(/\.tar$/, "");
        const base = name.endsWith("-chainguard") ? "chainguard" : "debian";
        const tool = name.replace(/-chainguard$/, "") as (typeof ciImages)[number];
        expect(p.repository).toBe(`ghcr.io/intentius/terragucci-${tool}`);
        expect(p.tags).toEqual([imageTag(tool, "{label}", base)]);
        // The image's SBOM is the scan's, from its layers: no target turns it off under supply-chain.
        expect(p.sbom).toBeUndefined();
      }
      expect(r.publish.filter((p) => p.sbom === false)).toEqual([]);
    });

    it("turns the supply-chain group on", () => {
      const declaration = JSON.parse(readFileSync(join(import.meta.dirname, "../../../chant.workspace.json"), "utf-8"));
      expect(declaration.security).toEqual(["supply-chain"]);
      expect(chantAtLeast(declaration.minReader, "0.124.33")).toBe(true);
    });
  });

  describe("image.base in terragucci.yml", () => {
    const tofuDebian = `ghcr.io/intentius/terragucci-tofu:${imageTag("tofu")}`;
    const tofuChainguard = `ghcr.io/intentius/terragucci-tofu:${imageTag("tofu", undefined, "chainguard")}`;
    const both = { [tofuDebian]: DIGEST, [tofuChainguard]: CHAINGUARD_DIGEST };

    async function pipeline(yml: string | undefined, imageDigests: Record<string, string> | undefined): Promise<string> {
      const dir = write(twoRootRepo(), yml === undefined ? {} : { "terragucci.yml": yml });
      git(dir, "init", "-q");
      git(dir, "remote", "add", "origin", "https://github.com/a/b.git");
      const result = await init(dir, { binary: "tofu", ...(imageDigests ? { imageDigests } : {}) });
      return readFileSync(result.files[0].path, "utf-8");
    }

    it("runs every job in the Debian image's digest by default and for debian", async () => {
      for (const yml of [undefined, "image:\n  base: debian\n"]) {
        const text = await pipeline(yml, both);
        expect(text).toContain(`${tofuDebian}@${DIGEST}`);
        expect(text).not.toContain(CHAINGUARD_DIGEST);
      }
    });

    it("runs every job in the Chainguard image's digest for chainguard, with no other change to the file", async () => {
      const debian = await pipeline(undefined, both);
      const chainguard = await pipeline("image:\n  base: chainguard\n", both);
      expect(chainguard).toContain(`${tofuChainguard}@${CHAINGUARD_DIGEST}`);
      expect(chainguard).not.toContain(`@${DIGEST}`);
      // Swapping the one image's tag and digest back gives the Debian file: nothing else in the pipeline depends on the set.
      expect(chainguard.split(tofuChainguard).join(tofuDebian).split(CHAINGUARD_DIGEST).join(DIGEST)).toBe(debian);
    });

    it("names the Chainguard image by tag when the build carries no digests", async () => {
      expect(await pipeline("image:\n  base: chainguard\n", undefined)).toContain(`${tofuChainguard}\n`);
    });

    it("refuses chainguard when the release recorded digests for the Debian images alone", async () => {
      await expect(pipeline("image:\n  base: chainguard\n", { [tofuDebian]: DIGEST })).rejects.toThrow(/image\.base: chainguard names an image set this terragucci release did not publish/);
      await expect(pipeline("image:\n  base: chainguard\n", { [tofuDebian]: DIGEST })).rejects.toBeInstanceOf(ConfigError);
      // A repo's own image is its own: the release's sets do not matter to it.
      await expect(pipeline("image:\n  name: registry.example.com/infra/tg:1\n  base: chainguard\n", { [tofuDebian]: DIGEST })).resolves.toContain("registry.example.com/infra/tg:1");
    });

    it("knows which builds carry the Chainguard digests", () => {
      expect(carriesBase("debian", { [tofuDebian]: DIGEST })).toBe(true);
      expect(carriesBase("chainguard", {})).toBe(true);
      expect(carriesBase("chainguard", { [tofuDebian]: DIGEST })).toBe(false);
      expect(carriesBase("chainguard", both)).toBe(true);
    });
  });
});
