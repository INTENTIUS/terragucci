/**
 * The CI images terragucci publishes (terragucci#19), one per toolchain. Each
 * carries one tool at a fixed version plus the terragucci bundle. A pipeline
 * runs in the image for its binary, pinned by digest once the image is
 * published; a repo that pins another version installs it in the job with
 * `terragucci install`.
 */
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

/** The four CI images a release builds and publishes, by name. */
export const ciImages = ["tofu", "terraform", "terragrunt", "choudoufu"] as const;

export const REGISTRY = "ghcr.io/intentius";

/** The tool versions the images carry, and the defaults when a repo pins none. */
export const TOOL_VERSIONS = {
  tofu: "1.13.1",
  terraform: "1.14.9",
  terragrunt: "1.2.0",
  /** A choudoufu release (INTENTIUS/choudoufu), not the OpenTofu version it is forked from. */
  choudoufu: "0.31.0",
} as const;

/**
 * The sha256 of each image release chant records none for, by architecture
 * (chant issue 4784). An image and `terragucci install` check the archive
 * against its release's checksums file and against this sum, so a tampered
 * checksums file fails too. Copied from the releases' own files:
 * terraform_1.14.9_SHA256SUMS on the terraform releases site and the
 * SHA256SUMS of terragrunt's v1.2.0 release. Move them with TOOL_VERSIONS.
 * tofu 1.13.1 and choudoufu 0.31.0 are chant's (CI_TOOL_SHA256).
 */
export const TOOL_SHA256: Partial<Record<keyof typeof TOOL_VERSIONS, { amd64: string; arm64: string }>> = {
  terraform: {
    amd64: "2e5cffc20a0b48a67a76268723bd5a10b8666f69b2aa4f04906e206726bedd63",
    arm64: "863002085b886453795d9ff4b8989b8468784478150b70ba8a1df3e3ad66da99",
  },
  terragrunt: {
    amd64: "45b6df8a8494c8cfe34b4abf919e894709557163e4d3b5704d11083002ab787a",
    arm64: "b069ce4310572bc46ee6f057057acc4bc6a9077ef8687e157a64b0551290a371",
  },
};

export interface ImageRef {
  repository: string;
  tag: string;
  /** The registry digest, known once the image is published. */
  digest?: string;
}

export function imageTag(tool: keyof typeof TOOL_VERSIONS, version = VERSION): string {
  if (tool === "terragrunt") return `${version}-tg${TOOL_VERSIONS.terragrunt}-tofu${TOOL_VERSIONS.tofu}`;
  return `${version}-${tool === "terraform" ? "tf" : tool}${TOOL_VERSIONS[tool]}`;
}

/** The image a pipeline for `binary` runs in. */
export function imageFor(binary: Binary, table: Record<string, string> = digests): ImageRef {
  const repository = `${REGISTRY}/terragucci-${binary}`;
  const tag = imageTag(binary);
  return { repository, tag, digest: table[`${repository}:${tag}`] };
}

/** The image a Terragrunt repo's pipeline runs in: Terragrunt and OpenTofu. */
export function terragruntImage(table: Record<string, string> = digests): ImageRef {
  const repository = `${REGISTRY}/terragucci-terragrunt`;
  const tag = imageTag("terragrunt");
  return { repository, tag, digest: table[`${repository}:${tag}`] };
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
