/**
 * terragucci's CI images on Chainguard's bases: the same four images as images/images.ts, on `cgr.dev/chainguard/node`
 * and `wolfi-base` (chant's productImageStages `base: "chainguard"`), pinned by digest, installing with apk, running
 * Wolfi's Node (not 22) and ending as user 65532. chant writes each export as images/Dockerfile.<export name>, and the
 * release names each image <name>-chainguard (chant.config.ts). On a chant that lacks `base`, loading this file throws
 * a message naming the release it needs (images/stages.ts).
 */
import { Dockerfile } from "@intentius/chant-lexicon-docker";
import { TOOL_VERSIONS } from "../packages/terragucci/src/images";
import { ciStages, ENGINES } from "./stages";

const tofuChainguardStages = ciStages("tofu", `OpenTofu ${TOOL_VERSIONS.tofu} and the terragucci engine`, [ENGINES.tofu], "chainguard");
const terraformChainguardStages = ciStages("terraform", `Terraform ${TOOL_VERSIONS.terraform} and the terragucci engine`, [ENGINES.terraform], "chainguard");
const terragruntChainguardStages = ciStages(
  "terragrunt",
  `Terragrunt ${TOOL_VERSIONS.terragrunt}, OpenTofu ${TOOL_VERSIONS.tofu} and the terragucci engine`,
  [ENGINES.tofu, ENGINES.terragrunt],
  "chainguard",
);
const choudoufuChainguardStages = ciStages("choudoufu", `choudoufu ${TOOL_VERSIONS.choudoufu} and the terragucci engine`, [ENGINES.choudoufu], "chainguard");

export const tofuChainguard = new Dockerfile({ stages: tofuChainguardStages });

export const terraformChainguard = new Dockerfile({ stages: terraformChainguardStages });

export const terragruntChainguard = new Dockerfile({ stages: terragruntChainguardStages });

export const choudoufuChainguard = new Dockerfile({ stages: choudoufuChainguardStages });

