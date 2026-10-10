/**
 * What each repo shape refuses, in one table. Config check reads it twice,
 * once for the shape the settings declare (a `terragrunt:` or `atmos:` block,
 * `synth`) and once for the shape detection finds, and init, the jobs'
 * commands and the stages read it through the Shape (./shape.ts). A refusal
 * is worded for the shape: an Atmos user never reads about an app or synth.
 *
 * This file imports types only, so config.ts can use it without a cycle.
 */
import type { ProjectSettings } from "./config";

/** How a repo's roots come to be: found on disk, written by a synth command, written from Atmos stacks, or Terragrunt units. */
export type ShapeKind = "roots" | "synth" | "atmos" | "terragrunt";

/** What a setting asks the pipeline to do, which a shape may refuse. */
export type Feature = "roots" | "synth" | "generate" | "drift-pr" | "rollouts" | "oidc-roles" | "steps" | "ephemeral";

/** The key each feature is set by, as a problem names it. */
export const FEATURE_KEY: Record<Feature, string> = {
  roots: "roots",
  synth: "synth",
  generate: "generate",
  "drift-pr": "respond.drift",
  rollouts: "rollouts",
  "oidc-roles": "oidc.roles",
  steps: "steps",
  ephemeral: "ephemeral",
};

export const ROOTS_NOT_ATMOS = "an Atmos repo's roots are the instances atmos describe stacks lists, so remove roots and leave an instance out with metadata.enabled: false";
export const ROOTS_NOT_TERRAGRUNT = "a Terragrunt repo's units are the ones terragrunt find lists, so remove roots and leave units out with terragrunt.exclude";
export const SYNTH_NOT_ATMOS = "synth is for roots a command writes; an Atmos repo's jobs write its instances with terragucci atmos write, so remove synth";
export const SYNTH_NOT_TERRAGRUNT = "synth is for roots a command writes, such as CDK Terrain's stacks; a Terragrunt repo's units are its own, so remove synth";

/**
 * What `synth` rules out, each because it would edit the roots the synth
 * command writes. Those files are output, not in git: a change to them is
 * lost at the next synth, and their source is the app's code (a CDK Terrain
 * app's TypeScript), which terragucci does not edit.
 */
export const SYNTH_DRIFT_PR_SHORT = "synth writes the roots, so a live value belongs in the app that writes them, which terragucci does not edit";
export const SYNTH_DRIFT_PR = "the drift pull request writes each live value into a root's own files, and with synth the command writes those files and git does not hold them, so the value belongs in the app that writes them, which terragucci does not edit; set respond.drift to attribute, which names who changed each value in the drift issue, or to off";
export const SYNTH_ROLLOUTS = "a rollout moves a pin in each root's files or its lock file, and with synth the command writes those files and git does not hold them, so the pin is in the app that writes them; move it there, and leave rollouts unset";

/**
 * Why `generate` is refused with `synth`: the roots are the synth command's
 * output, so a file generate wrote into one is gone at the next synth, and the
 * app already says what generate would, through its constructs.
 */
export const SYNTH_GENERATE = "with synth the roots are written by the synth command, and the app sets what generate would write through its constructs: the backend with a backend construct (S3Backend, GcsBackend, AzurermBackend, LocalBackend, HttpBackend, PgBackend, ConsulBackend, CosBackend, OssBackend, SwiftBackend, or CloudBackend and RemoteBackend for HCP Terraform), each provider with its provider construct, and required_version with the stack's addOverride(\"terraform.required_version\", ...); a file generate wrote into a synthesized root is gone at the next synth and would declare a second backend beside the app's, so set these in the app and leave generate unset";

/** An Atmos instance's directory is written by `terragucci atmos write` from its component and its stack, so git holds neither the copy nor anything written into it. */
export const ATMOS_DRIFT_PR_SHORT = "an Atmos instance is written from its component and its stack, so a live value belongs in the stack's vars or the component, which terragucci does not edit";
export const ATMOS_DRIFT_PR = "the drift pull request writes each live value into a root's own files, and an Atmos instance's files are copies terragucci atmos write makes of its component, with its vars from the stack, so the value belongs in the stack's vars or the component, which terragucci does not edit; set respond.drift to attribute, which names who changed each value in the drift issue, or to off";
export const ATMOS_ROLLOUTS = "a rollout moves a pin wave by wave, and an Atmos instance runs its component's files, which every instance of the component shares across stacks and waves, so no wave can move a pin alone; leave rollouts unset and move the pin in the component";
export const ATMOS_GENERATE = "Atmos writes each instance's backend and provider override from the stack's backend and providers settings, and a file generate wrote would declare a second backend beside it; set them in the stack YAML and leave generate unset";
export const ATMOS_EPHEMERAL = "ephemeral gives each copy a state key of its own by rewriting a root's backend key, and an Atmos instance's state is named by its stack's backend and its workspace, which terragucci atmos write sets; leave ephemeral unset";
export const OIDC_ROLES_NOT_TERRAGRUNT = "roles by root glob are for plain roots; in a Terragrunt repo, set terragrunt.credentials";

/** The shape each feature is refused in, with why. A shape and feature not listed are allowed. */
const TABLE: Record<ShapeKind, Partial<Record<Feature, string>>> = {
  roots: {},
  synth: { generate: SYNTH_GENERATE, "drift-pr": SYNTH_DRIFT_PR, rollouts: SYNTH_ROLLOUTS },
  atmos: { roots: ROOTS_NOT_ATMOS, synth: SYNTH_NOT_ATMOS, generate: ATMOS_GENERATE, "drift-pr": ATMOS_DRIFT_PR, rollouts: ATMOS_ROLLOUTS, ephemeral: ATMOS_EPHEMERAL },
  terragrunt: { roots: ROOTS_NOT_TERRAGRUNT, synth: SYNTH_NOT_TERRAGRUNT, "oidc-roles": OIDC_ROLES_NOT_TERRAGRUNT },
};

/** Why `kind` refuses `feature`, or undefined when it does not. */
export function refusal(kind: ShapeKind, feature: Feature): string | undefined {
  return TABLE[kind][feature];
}

/** Whether the settings ask for `feature`. */
export function wants(s: ProjectSettings, feature: Feature): boolean {
  switch (feature) {
    case "roots":
      return s.roots !== undefined;
    case "synth":
      return typeof s.synth === "string" && s.synth.trim() !== "";
    case "generate":
      return s.generate !== undefined;
    case "drift-pr":
      return Boolean(s.drift) && (s.respond?.drift ?? "pull-request") === "pull-request";
    case "rollouts":
      return Boolean(s.rollouts) && (s.respond?.rollout ?? "next-wave") !== "off";
    case "oidc-roles":
      return typeof s.oidc === "object" && s.oidc !== null && (s.oidc as { roles?: unknown }).roles !== undefined;
    case "steps":
      return Array.isArray(s.steps) && s.steps.length > 0;
    case "ephemeral":
      return s.ephemeral !== undefined;
  }
}

/** The shape a project's settings declare by their keys alone: what config check can tell without the repo. */
export function declaredKind(s: ProjectSettings): ShapeKind {
  if (s.terragrunt !== undefined) return "terragrunt";
  if (s.atmos !== undefined) return "atmos";
  if (typeof s.synth === "string" && s.synth.trim() !== "") return "synth";
  return "roots";
}

/**
 * Every refusal `kind` makes of what the settings ask for, each as
 * `<where>.<key>: <why>`. A Terragrunt repo's steps are refused step by step
 * (terragruntStepsRefusal in ./steps.ts), which the Shape adds.
 */
export function shapeProblems(kind: ShapeKind, s: ProjectSettings, where: string): string[] {
  const out: string[] = [];
  for (const f of Object.keys(FEATURE_KEY) as Feature[]) {
    if (!wants(s, f)) continue;
    const why = refusal(kind, f);
    if (why) out.push(`${where}.${FEATURE_KEY[f]}: ${why}`);
  }
  return out;
}
