/**
 * What the two sets of CI images share: the engines and the stages of one image on a base. images/images.ts declares the
 * Debian set and images/chainguard.ts the Chainguard set, so neither file passes chant's limit on declarations in one file.
 */
import { productImageStages, type CiImageTool } from "@intentius/chant/ci-image";
import pkg from "../packages/terragucci/package.json" with { type: "json" };
import { CI_IMAGE_BASE_CHANT_FLOOR, chantTakesImageBase, TOOL_VERSIONS, toolSha256, type ImageBase } from "../packages/terragucci/src/images";

/**
 * Each engine with its pinned version, written out so no lookup computes a key, and the sums terragucci records for a
 * release chant records none for (TOOL_SHA256); left undefined, chant checks its own (CI_TOOL_SHA256).
 */
export const ENGINES = {
  tofu: { tool: "tofu", version: TOOL_VERSIONS.tofu, sha256: toolSha256("tofu") },
  terraform: { tool: "terraform", version: TOOL_VERSIONS.terraform, sha256: toolSha256("terraform") },
  terragrunt: { tool: "terragrunt", version: TOOL_VERSIONS.terragrunt, sha256: toolSha256("terragrunt") },
  choudoufu: { tool: "choudoufu", version: TOOL_VERSIONS.choudoufu, sha256: toolSha256("choudoufu") },
} satisfies Record<string, CiImageTool>;

/**
 * The stages of one CI image. Each image binds them to a constant before its
 * Dockerfile, because a resource's properties are read statically (EVL001):
 * the call that computes the stages runs here, and the declaration names the result.
 */
export const ciStages = (name: string, description: string, tools: CiImageTool[], base: ImageBase) => {
  if (base === "chainguard" && !chantTakesImageBase()) {
    throw new Error(`images/chainguard.ts: the Chainguard image set (${name}) needs chant ${CI_IMAGE_BASE_CHANT_FLOOR} or later, whose productImageStages takes base (CI_IMAGE_BASE_FLOOR); the installed chant does not carry it`);
  }
  return productImageStages({
    name: `terragucci-${name}`,
    product: "terragucci",
    description: base === "chainguard" ? `${description}, on Chainguard images` : description,
    source: "https://github.com/INTENTIUS/terragucci",
    tools,
    // What the bundle imports at run time from /usr/local/node_modules, which is on its module
    // path: the installed chant it is built against (the release the package pins, whose core
    // subpaths the bundle leaves external) and the HCL parser the tips and rollouts read with.
    npm: [`@intentius/chant@${pkg.dependencies["@intentius/chant"]}`, `@cdktn/hcl2json@${pkg.devDependencies["@cdktn/hcl2json"]}`],
    // chant's bin, which a wave job runs (`chant run wave`) and approve and the relay record
    // through, as the release the package pins.
    chant: pkg.dependencies["@intentius/chant"],
    bundle: { file: "packages/terragucci/dist/terragucci.mjs", bin: "terragucci" },
    base,
  });
};

