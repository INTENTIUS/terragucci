/**
 * The CI images terragucci publishes (chant#3422), one per toolchain. Each
 * carries one tool at a fixed version plus the terragucci bundle. A pipeline
 * runs in the image for its binary, pinned by digest once the image is
 * published; a repo that pins another version installs it in the job with
 * `terragucci install`.
 */
import pkg from "../package.json" with { type: "json" };
import digests from "./image-digests.json" with { type: "json" };
import type { Binary } from "./config";

export const REGISTRY = "ghcr.io/intentius";

/** The tool versions the images carry, and the defaults when a repo pins none. */
export const TOOL_VERSIONS = {
  tofu: "1.13.1",
  terraform: "1.14.0",
  terragrunt: "1.1.6",
} as const;

export interface ImageRef {
  repository: string;
  tag: string;
  /** The registry digest, known once the image is published. */
  digest?: string;
}

export function imageTag(tool: "tofu" | "terraform" | "terragrunt", version = pkg.version): string {
  if (tool === "terragrunt") return `${version}-tg${TOOL_VERSIONS.terragrunt}-tofu${TOOL_VERSIONS.tofu}`;
  return `${version}-${tool === "tofu" ? "tofu" : "tf"}${TOOL_VERSIONS[tool]}`;
}

/** The image a pipeline for `binary` runs in, or undefined when terragucci publishes none for it. */
export function imageFor(binary: Binary, table: Record<string, string> = digests): ImageRef | undefined {
  if (binary !== "tofu" && binary !== "terraform") return undefined;
  const repository = `${REGISTRY}/terragucci-${binary}`;
  const tag = imageTag(binary);
  return { repository, tag, digest: table[`${repository}:${tag}`] };
}

/** How a pipeline names the image: by digest when it is known, with the tag kept beside it. */
export function imageReference(ref: ImageRef): string {
  return ref.digest ? `${ref.repository}:${ref.tag}@${ref.digest}` : `${ref.repository}:${ref.tag}`;
}
