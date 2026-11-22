/**
 * `promotion` in terragucci.yml: the order a release moves through the
 * environments, mapped onto chant's `components promote`, `rollback` and the
 * release gate.
 *
 * chant deploys a release by component, and a component's deploy names the
 * root it applies. `init` writes each root of an environment of `promotion`
 * as a component in `terragucci.component.ts`. Each component's step carries its
 * root per environment as `environments` (a step's inputs per environment),
 * which chant resolves for the run's environment, so a release cut from one
 * commit records each environment's own roots, and a promote to staging
 * deploys the staging roots' files only.
 *
 * A root's component name is its path with the segment that names its
 * environment taken out, in kebab case: `envs/dev/network` and
 * `envs/prod/network` are both `envs-network`. A root whose path has no such
 * segment keeps its whole path as its name.
 *
 * An environment whose gate is `always` or `on-destructive` waits for one
 * approval per promote. With `.chant/pipeline.ts`, which init writes beside
 * the components from the same terragucci.yml, that approval is the stage's
 * gate in the pipeline, and the environment's components carry no gate of
 * their own (`componentGated`). With no pipeline of terragucci's (a repo's
 * own `.chant/pipeline.ts`), each component gets a gate step named after the
 * environment before its root, which chant's release gate binds to the
 * release, the environment and the planned change set. A gate asks on every
 * promote, so `on-destructive` asks as `always` does here. `never` deploys
 * with no approval, as it applies on merge with none.
 *
 * Before a promote or rollback deploys into an environment whose components
 * carry no gate, `releaseApproval` reads the pipeline where chant's promote
 * reads it, the default branch's tip, and refuses unless that pipeline gates
 * the stage. chant's rollback passes the components' gates only, so a
 * rollback into such a stage runs as a promote of the earlier release,
 * through the stage's gate, and pauses the stage afterwards when it sets
 * `pause_after_rollback`.
 *
 * chant.config.ts lists the environments in `promotion`'s order
 * (./chant-config.ts), which chant's `promotionOrder` reads: `promote --to`
 * defaults `--from` to the step before and refuses a skipped one.
 */
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { devDependencies } from "../package.json";
import { ConfigError, type ProjectSettings } from "./config";
import { environmentOf } from "./environments";
import { pipelineGatedStages, stageGateAtBase, stageGatePolicy } from "./pipeline";

/** The components file, at the repo's root beside chant.config.ts. */
export const PROMOTION_COMPONENTS = "terragucci.component.ts";

/** The first line of a components file terragucci init wrote. */
export const PROMOTION_MARKER = "// Written by terragucci init from promotion in terragucci.yml: each root of an environment as a chant component.";

/** What a component gate's description tells people. */
export const releaseApproveLine = (env: string): string => `terragucci approve release ${env}`;

/** Why the merge path's steps opt out of a rollback, and the promote path's too: going back is a promote of an earlier release. */
export const PROMOTION_NO_ROLLBACK = "a root goes back by deploying an earlier release: terragucci rollback <env> --release <label>";

/** One component: its name, and in each environment that has it, the root it applies and the components it follows there. */
export interface PromotionComponent {
  name: string;
  byEnv: Record<string, { root: string; dependsOn: string[] }>;
}

export interface PromotionPlan {
  components: PromotionComponent[];
  /** Environments of `promotion` whose gate asks a person, in order. */
  gated: string[];
  /** Environments of `gated` whose components carry the gate step: those `.chant/pipeline.ts` does not gate. */
  componentGated: string[];
  /** Why the file cannot be written; empty when it can. */
  problems: string[];
  /** What a person may want to know, such as a component one environment has and the one before it lacks. */
  notes: string[];
}

/** A root's component name: its path without the segment that names `env`, in kebab case. */
export function componentName(root: string, env: string): string {
  const parts = root.split("/").filter((p) => p !== "" && p !== ".");
  const kept = parts.filter((p) => p !== env);
  const path = (kept.length > 0 ? kept : parts).join("-");
  return path.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "root";
}

/** Each environment of `promotion`'s roots as components, from the roots init found and their order. */
export function promotionPlan(input: {
  promotion: readonly string[];
  roots: readonly string[];
  settings: Pick<ProjectSettings, "environments" | "gate">;
  /** For each root, every root it must follow (Discovered.order). */
  order: ReadonlyMap<string, ReadonlySet<string>>;
  /** Whether `.chant/pipeline.ts` is the one these settings write, so each stage it gates takes its approval there. */
  pipeline?: boolean;
}): PromotionPlan {
  const { promotion, settings } = input;
  const problems: string[] = [];
  const notes: string[] = [];
  const byName = new Map<string, PromotionComponent>();
  for (const env of promotion) {
    const roots = input.roots.filter((r) => environmentOf(r, settings) === env).sort();
    if (roots.length === 0) problems.push(`environment ${env} of promotion has no roots; its globs match none of the roots found`);
    const names = new Map(roots.map((r) => [r, componentName(r, env)]));
    const owner = new Map<string, string>();
    for (const [root, name] of names) {
      const other = owner.get(name);
      if (other !== undefined) problems.push(`${other} and ${root} of environment ${env} both make the component ${name}; a release deploys each component once in an environment`);
      owner.set(name, root);
    }
    for (const [root, name] of names) {
      const dependsOn = [...(input.order.get(root) ?? [])].filter((u) => names.has(u) && u !== root).map((u) => names.get(u)!);
      const c = byName.get(name) ?? { name, byEnv: {} };
      c.byEnv[env] = { root, dependsOn: [...new Set(dependsOn)].sort() };
      byName.set(name, c);
    }
  }
  const components = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  for (const c of components) {
    for (let i = 1; i < promotion.length; i++) {
      const env = promotion[i]!;
      if (c.byEnv[env] && !c.byEnv[promotion[i - 1]!]) notes.push(`${c.byEnv[env]!.root} is the component ${c.name} in ${env}, and ${promotion[i - 1]} has no root of that name, so a promote to ${env} has no release of it to bring`);
    }
  }
  const gated = promotion.filter((env) => stageGatePolicy(settings, env) !== "never");
  // The decision is the pipeline's own: the stages pipelineGatedStages reads from the same settings the pipeline is written from.
  const byPipeline = input.pipeline ? pipelineGatedStages({ ...settings, promotion: [...promotion] }) : [];
  const componentGated = gated.filter((env) => !byPipeline.includes(env));
  return { components, gated, componentGated, problems, notes };
}

/** A component's export name: its name with `-` as `_`, after `root_`, so no name is a keyword and no two collide. */
const exportName = (name: string): string => `root_${name.replace(/-/g, "_")}`;

/** The comment line naming the environments whose one approval is their stage gate in `.chant/pipeline.ts`. */
const STAGE_GATED_LINE = "// Approved once, at the stage's gate in .chant/pipeline.ts: ";

/** The text of terragucci.component.ts: one export per component, each step carrying its root and gate per environment as `environments`. */
export function promotionComponentsText(plan: Pick<PromotionPlan, "components" | "gated" | "componentGated">, promotion: readonly string[]): string {
  const byStage = plan.gated.filter((env) => !plan.componentGated.includes(env));
  const lines: string[] = [
    PROMOTION_MARKER,
    "// Each step names its root, and its gate, in the environments it applies in; chant picks the entry of the environment it compiles or deploys.",
    "// Run terragucci init again after adding or moving a root, or changing promotion or an environment's gate.",
    ...(byStage.length > 0 ? [`${STAGE_GATED_LINE}${byStage.join(", ")}; ${releaseApproveLine("<env>")}`] : []),
    ...(plan.componentGated.length > 0 ? [`// chant-disable COMP004 -- each gate waits for a person: ${releaseApproveLine("<env>")}`] : []),
    'import type { Component } from "@intentius/chant/components";',
    "",
    `const NO_ROLLBACK = ${JSON.stringify(PROMOTION_NO_ROLLBACK)};`,
  ];
  for (const c of plan.components) {
    const envs = promotion.filter((env) => c.byEnv[env]);
    const dependsOn = [...new Set(envs.flatMap((env) => c.byEnv[env]!.dependsOn))].sort();
    const gatedEnvs = envs.filter((env) => plan.componentGated.includes(env));
    const gate =
      gatedEnvs.length > 0
        ? `{ kind: "gate", gate: "release", environments: { ${gatedEnvs.map((env) => `${JSON.stringify(env)}: { gate: ${JSON.stringify(env)}, description: ${JSON.stringify(`approve with ${releaseApproveLine(env)}`)} }`).join(", ")} } }, `
        : "";
    const apply = `{ kind: "terraform-apply", noRollback: NO_ROLLBACK, environments: { ${envs.map((env) => `${JSON.stringify(env)}: { root: ${JSON.stringify(c.byEnv[env]!.root)} }`).join(", ")} } }`;
    lines.push("", `export const ${exportName(c.name)}: Component = { name: ${JSON.stringify(c.name)}, dependsOn: ${JSON.stringify(dependsOn)}, deploy: [{ phase: "Apply", steps: [${gate}${apply}] }] };`);
  }
  return `${lines.join("\n")}\n`;
}

/** Whether `text` is a components file terragucci init wrote. */
export const promotionComponentsWrittenByTerragucci = (text: string): boolean => text.startsWith(PROMOTION_MARKER);

/** The environments a components file terragucci init wrote gives a gate step, read back from its gate steps' `environments`. */
export function componentGateEnvironments(text: string): string[] {
  const found = new Set<string>();
  for (const step of text.matchAll(/\{ kind: "gate", gate: "release", environments: \{(.*?)\} \} \}/g)) {
    for (const env of step[1]!.matchAll(/"([^"]+)": \{ gate: /g)) found.add(env[1]!);
  }
  return [...found];
}

/**
 * Where a promote or rollback into `env` takes its approval: the
 * components' release gate (`component`), the stage's gate in the pipeline
 * chant reads at the default branch's tip (`stage`, with whether a rollback
 * pauses the stage), or a refusal when `env` waits for a person and neither
 * gates it. A components file the repo wrote itself keeps its own gates.
 */
export function releaseApproval(repo: string, env: string, settings: Pick<ProjectSettings, "environments" | "gate">): { via: "component" } | { via: "stage"; pauseAfterRollback: boolean } | { refused: string } {
  const path = join(repo, PROMOTION_COMPONENTS);
  const text = existsSync(path) ? readFileSync(path, "utf-8") : "";
  if (!promotionComponentsWrittenByTerragucci(text) || componentGateEnvironments(text).includes(env)) return { via: "component" };
  if (stageGatePolicy(settings, env) === "never") return { via: "component" };
  const stage = stageGateAtBase(repo, env);
  if (stage.gated) return { via: "stage", pauseAfterRollback: stage.pauseAfterRollback };
  return { refused: `${env}'s approval is its stage gate in .chant/pipeline.ts, which chant reads on the default branch, and ${stage.why}; run terragucci init, commit .chant/pipeline.ts with ${PROMOTION_COMPONENTS} and push them` };
}

// ── terragucci promote and rollback ─────────────────────────────────────────

/** The terraform lexicon terragucci builds with, which a promote's `terraform-apply` step loads. */
export const TERRAFORM_LEXICON = `@intentius/chant-lexicon-terraform@${devDependencies["@intentius/chant-lexicon-terraform"]}`;

/** The usage lines, as the CLI and its reference print them. */
export const PROMOTE_USAGE = "terragucci promote --to <env> [--release <label>] [--from <env>] [--allow-skip] [--urgent --reason <text>] [--dry-run] [--json]";
export const ROLLBACK_USAGE = "terragucci rollback <env> --release <label> [--dry-run] [--json]";

/** What a parsed `promote` or `rollback` line holds: its positionals and flags, as cli.ts parses them. */
export interface ReleaseLine {
  args: string[];
  flags: Record<string, string | boolean | undefined>;
}

const flagValue = (flags: ReleaseLine["flags"], name: string, usage: string): string | undefined => {
  const v = flags[name];
  if (v === true || v === "") throw new ConfigError(`--${name} takes a value: ${usage}`);
  return typeof v === "string" ? v : undefined;
};

/**
 * chant's command line for `terragucci promote` or `rollback`: `components
 * promote --to <env>` with `--release`, `--from`, `--allow-skip`, `--urgent`
 * with its `--reason`, and `--dry-run` as given, or `components rollback <env>
 * --release <label>`. `--urgent` is chant's (#5355): one proven approval from
 * the stage's `urgent.role` passes its gate for one named release, and the
 * reason goes on the stage's ledger, so it takes `--release` and `--reason`.
 */
export function releaseArgv(verb: "promote" | "rollback", line: ReleaseLine): string[] {
  const usage = verb === "promote" ? PROMOTE_USAGE : ROLLBACK_USAGE;
  const allowed = verb === "promote" ? ["to", "release", "from", "allow-skip", "urgent", "reason", "dry-run", "json"] : ["release", "dry-run", "json"];
  const extra = Object.keys(line.flags).filter((k) => line.flags[k] !== undefined && !allowed.includes(k));
  if (extra.length) throw new ConfigError(`${verb} does not take ${extra.map((k) => `--${k}`).join(", ")}: ${usage}`);
  const release = flagValue(line.flags, "release", usage);
  const switches = [...(line.flags["dry-run"] === true ? ["--dry-run"] : []), ...(line.flags.json === true ? ["--json"] : [])];
  if (verb === "promote") {
    if (line.args.length) throw new ConfigError(`promote names its environment with --to, not ${line.args.join(" ")}: ${usage}`);
    const to = flagValue(line.flags, "to", usage);
    if (!to) throw new ConfigError(`promote needs --to <env>, the environment the release goes to: ${usage}`);
    const from = flagValue(line.flags, "from", usage);
    const urgent = line.flags.urgent === true;
    const reason = flagValue(line.flags, "reason", usage);
    if (reason !== undefined && !urgent) throw new ConfigError(`--reason goes with --urgent, whose use the stage's ledger records: ${usage}`);
    if (urgent && !release) throw new ConfigError(`--urgent promotes one release: it needs --release <label>: ${usage}`);
    if (urgent && !reason) throw new ConfigError(`--urgent needs --reason <text>, which the stage's ledger records: ${usage}`);
    return ["components", "promote", "--to", to, ...(release ? ["--release", release] : []), ...(from ? ["--from", from] : []), ...(line.flags["allow-skip"] === true ? ["--allow-skip"] : []), ...(urgent ? ["--urgent", "--reason", reason!] : []), ...switches];
  }
  if (line.args.length !== 1) throw new ConfigError(`rollback takes one environment: ${usage}`);
  if (!release) throw new ConfigError(`rollback needs --release <label>, the earlier release ${line.args[0]} goes back to: ${usage}`);
  return ["components", "rollback", line.args[0]!, "--release", release, ...switches];
}

/**
 * chant's command line for a rollback into a stage whose approval is the
 * pipeline's: a promote of the earlier release, which passes the stage's
 * gate, since chant's rollback passes the components' gates only.
 */
export function stageRollbackArgv(rollback: readonly string[]): string[] {
  const [, , env, , release, ...switches] = rollback;
  return ["components", "promote", "--to", env!, "--release", release!, ...switches];
}

/** Why a promote cannot run from `repo`, or undefined: no components file, or no terraform lexicon where chant looks for it. */
export function releaseRefusal(repo: string, resolveFrom: readonly string[] = [join(repo, "package.json"), fileURLToPath(import.meta.url)]): string | undefined {
  if (!existsSync(join(repo, PROMOTION_COMPONENTS))) return `${PROMOTION_COMPONENTS} is missing: set promotion in terragucci.yml and run terragucci init, which writes each environment's roots as components`;
  const found = resolveFrom.some((from) => {
    try {
      createRequire(from).resolve("@intentius/chant-lexicon-terraform");
      return true;
    } catch {
      return false;
    }
  });
  if (!found) return `chant deploys each root with the terraform lexicon's terraform-apply step, and @intentius/chant-lexicon-terraform is not installed here: npm i -D ${TERRAFORM_LEXICON}`;
  return undefined;
}

/**
 * The variables a `terragucci promote` adds for `agent.verify-failed`
 * (chant#5339): `CHANT_AGENT_FACTS` with `verify-failed` added to what the
 * shell already names, and `CHANT_RELAY_KEY` from `relay_key_secret`'s
 * variable when the shell holds that one by its own name. chant's promote
 * then records a failed verify step or a soak check that starts failing as
 * a fact for the agent. Empty when the key is unset or the promote is a
 * rollback, which runs no soak.
 */
export function promoteAgentFactsEnv(settings: Pick<ProjectSettings, "agent">, env: NodeJS.ProcessEnv): Record<string, string> {
  const v = settings.agent?.["verify-failed"];
  if (v === undefined || v === false || !settings.agent?.token_env) return {};
  const named = (env.CHANT_AGENT_FACTS ?? "").split(",").map((t) => t.trim()).filter((t) => t !== "");
  const out: Record<string, string> = { CHANT_AGENT_FACTS: [...new Set([...named, "verify-failed"])].join(",") };
  const relay = typeof v === "object" && v.relay_key_secret ? v.relay_key_secret : "CHANT_RELAY_KEY";
  if (!env.CHANT_RELAY_KEY && relay !== "CHANT_RELAY_KEY" && env[relay]) out.CHANT_RELAY_KEY = env[relay]!;
  return out;
}

/** terragucci's words for a promote or rollback: its approve line names the environment's release gate. */
export function releaseWords<W extends { approve: string }>(words: W): W {
  return { ...words, approve: "terragucci approve release {target} {sign}" };
}
