/**
 * The CI images terragucci publishes (terragucci#19), one per toolchain and
 * built on two bases: Debian (the default) and Chainguard's Wolfi images. Each
 * carries one tool at a fixed version plus the terragucci bundle. A pipeline
 * runs in the image for its binary, pinned by digest once the image is
 * published; a repo that pins another version installs it in the job with
 * `terragucci install`. `image.base` in terragucci.yml picks the set.
 */
import * as chantCiImage from "@intentius/chant/ci-image";
// A named import, so the bundle carries the version and not the whole package.json.
import { version as VERSION } from "../package.json";
import type { Binary } from "./config";

/**
 * The images' digests, keyed by `<repository>:<tag>`. The release's build
 * (scripts/build-cli.mjs with `CHANT_RELEASE_DIGESTS`, chant issue 4657)
 * defines it from the archives the release's cut built; any other build of
 * the bundle, and the tests, have none, so `init` writes the tags bare.
 */
declare const __TERRAGUCCI_IMAGE_DIGESTS__: Record<string, string> | undefined;
const digests: Record<string, string> = typeof __TERRAGUCCI_IMAGE_DIGESTS__ !== "undefined" ? __TERRAGUCCI_IMAGE_DIGESTS__ : {};

/** The four CI images a release builds and publishes in each set, by name. */
export const ciImages = ["tofu", "terraform", "terragrunt", "choudoufu"] as const;

/** The base a set of the CI images is built on. `debian` is the default. */
export type ImageBase = "debian" | "chainguard";

/** The two sets a release builds and publishes. */
export const IMAGE_BASES = ["debian", "chainguard"] as const;

/**
 * The first chant release whose image helper takes `base` (`CI_IMAGE_BASE_FLOOR` in `@intentius/chant/ci-image`).
 * images/images.ts builds the Chainguard set only on a chant that carries it. It is the chant package.json pins
 * once the pin has moved there (test/images.test.ts keeps the two in step), and it is written out here for the
 * same reason as CHANT_PIN in ./comment-allow.
 */
export const CI_IMAGE_BASE_CHANT_FLOOR = "0.124.113";

/**
 * Whether the installed chant takes `base` in productImageStages (it exports CI_IMAGE_BASE_FLOOR). An older chant
 * ignores the field and would write the Debian image under the Chainguard name, so images/stages.ts refuses there.
 */
export function chantTakesImageBase(chant: object = chantCiImage): boolean {
  return Reflect.has(chant, "CI_IMAGE_BASE_FLOOR");
}

/** The suffix a Chainguard image's tag and release name carry: `tofu` is the Debian image, `tofu-chainguard` the other. */
export const CHAINGUARD_SUFFIX = "-chainguard";

/** The name a release gives an image in a set: `tofu` on Debian, `tofu-chainguard` on Chainguard. */
export function releaseImageName(name: (typeof ciImages)[number], base: ImageBase = "debian"): string {
  return base === "chainguard" ? `${name}${CHAINGUARD_SUFFIX}` : name;
}

export const REGISTRY = "ghcr.io/intentius";

/**
 * The tool versions the images carry, and the defaults when a repo pins none.
 * chant records the sha256 of each by architecture (CI_TOOL_SHA256 in
 * `@intentius/chant/ci-image`, chant issue 4908), and an image's build
 * checks each engine against it.
 */
export const TOOL_VERSIONS = {
  tofu: "1.13.1",
  terraform: "1.14.9",
  terragrunt: "1.2.0",
  /** A choudoufu release (INTENTIUS/choudoufu), not the OpenTofu version it is forked from. */
  choudoufu: "0.31.0",
} as const;

export interface ImageRef {
  repository: string;
  tag: string;
  /** The registry digest, known once the image is published. */
  digest?: string;
}

/**
 * An image's tag. The Chainguard set shares each repository with the Debian set and ends its tags in `-chainguard`,
 * so a tag names its set.
 */
export function imageTag(tool: keyof typeof TOOL_VERSIONS, version = VERSION, base: ImageBase = "debian"): string {
  const suffix = base === "chainguard" ? CHAINGUARD_SUFFIX : "";
  if (tool === "terragrunt") return `${version}-tg${TOOL_VERSIONS.terragrunt}-tofu${TOOL_VERSIONS.tofu}${suffix}`;
  return `${version}-${tool === "terraform" ? "tf" : tool}${TOOL_VERSIONS[tool]}${suffix}`;
}

/** The image a pipeline for `binary` runs in, from the `base` set. */
export function imageFor(binary: Binary, table: Record<string, string> = digests, base: ImageBase = "debian"): ImageRef {
  const repository = `${REGISTRY}/terragucci-${binary}`;
  const tag = imageTag(binary, VERSION, base);
  return { repository, tag, digest: table[`${repository}:${tag}`] };
}

/** The image a Terragrunt repo's pipeline runs in: Terragrunt and OpenTofu. */
export function terragruntImage(table: Record<string, string> = digests, base: ImageBase = "debian"): ImageRef {
  const repository = `${REGISTRY}/terragucci-terragrunt`;
  const tag = imageTag("terragrunt", VERSION, base);
  return { repository, tag, digest: table[`${repository}:${tag}`] };
}

/**
 * Whether this build can name a Chainguard image. A release's build carries the digest of each image the release
 * published, in both sets, and a table with none of the Chainguard set's belongs to a release that published
 * Debian images alone. A build with no table at all (a checkout, the tests) names images by tag, as it does for
 * Debian, and is not refused.
 */
export function carriesBase(base: ImageBase, table: Record<string, string> = digests): boolean {
  if (base === "debian" || Object.keys(table).length === 0) return true;
  return Object.keys(table).some((reference) => reference.endsWith(CHAINGUARD_SUFFIX));
}

/** How a pipeline names the image: by digest when it is known, with the tag kept beside it. */
export function imageReference(ref: ImageRef): string {
  return ref.digest ? `${ref.repository}:${ref.tag}@${ref.digest}` : `${ref.repository}:${ref.tag}`;
}

/**
 * The opt-in decision service image, `terragucci-decide` (terragucci#29). It
 * is not one of the CI images: no pipeline runs in it, `just images` does not
 * build it and images/budget.json does not hold it. It serves Laya's English
 * checkpoint on CPU behind the Jev request and response shape, with the
 * package, the CPU torch build and the checkpoint's Hub commit all pinned here,
 * and the weights baked in so the container never reaches the Hub.
 */
export const DECIDE_IMAGE = {
  /** The `laya` release on PyPI; its `laya-serve` speaks `POST /v1/systemone`. */
  laya: "0.3.28",
  /** The CPU build of torch, from download.pytorch.org/whl/cpu. */
  torch: "2.14.0",
  /** pip itself, installed from the hash-locked file so the build never takes whatever pip is newest (`venv --upgrade-deps` would). */
  pip: "26.2.1",
  /** The checkpoint: its Hub repo, Laya's name for it and the reviewed commit in laya/revisions.py. */
  checkpoint: {
    repo: "convaiinnovations/laya",
    name: "english",
    revision: "55cf4c4ebb4ebe31b2550e8bdf3bd21b99753851",
    /** SHA-256 of model.safetensors at that commit, from the Hub's LFS pointer; the build and every load check it. */
    weightsSha256: "891102d372688fc2a094dac56a384bc537b87c63f21f9f3dac0be2b7cbc8d86c",
  },
  /** The port the service listens on inside the container. */
  port: 8790,
} as const;

/**
 * The model id the decide image answers as: package, checkpoint and commit,
 * so a recorded decision names exactly what answered it. A request naming any
 * other model is refused.
 */
export const LAYA_MODEL = `laya-${DECIDE_IMAGE.laya}-${DECIDE_IMAGE.checkpoint.name}@${DECIDE_IMAGE.checkpoint.revision.slice(0, 12)}`;

/** The decide image's reference: the package version and the Laya release it carries. */
export function decideImage(version = VERSION): string {
  return `${REGISTRY}/terragucci-decide:${version}-laya${DECIDE_IMAGE.laya}`;
}
