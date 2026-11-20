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
 * An environment whose gate is `always` or `on-destructive` gets a gate step
 * named after it before each of its roots, which chant's release gate binds to
 * the release, the environment and the planned change set. A component gate
 * asks on every change, so `on-destructive` asks as `always` does here.
 * `never` deploys with no approval, as it applies on merge with none.
 *
 * chant.config.ts lists the environments in `promotion`'s order
 * (./chant-config.ts), which chant's `promotionOrder` reads: `promote --to`
 * defaults `--from` to the step before and refuses a skipped one.
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { devDependencies } from "../package.json";
import { ConfigError, normalizeGate, type ProjectSettings } from "./config";
import { environmentOf, topGate } from "./environments";

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
  const gated = promotion.filter((env) => (normalizeGate(settings.environments?.[env]?.gate) ?? topGate(settings)) !== "never");
  return { components, gated, problems, notes };
}

/** A component's export name: its name with `-` as `_`, after `root_`, so no name is a keyword and no two collide. */
const exportName = (name: string): string => `root_${name.replace(/-/g, "_")}`;

/** The text of terragucci.component.ts: one export per component, each step carrying its root and gate per environment as `environments`. */
export function promotionComponentsText(plan: Pick<PromotionPlan, "components" | "gated">, promotion: readonly string[]): string {
  const lines: string[] = [
    PROMOTION_MARKER,
    "// Each step names its root, and its gate, in the environments it applies in; chant picks the entry of the environment it compiles or deploys.",
    "// Run terragucci init again after adding or moving a root, or changing promotion or an environment's gate.",
    ...(plan.gated.length > 0 ? [`// chant-disable COMP004 -- each gate waits for a person: ${releaseApproveLine("<env>")}`] : []),
    'import type { Component } from "@intentius/chant/components";',
    "",
    `const NO_ROLLBACK = ${JSON.stringify(PROMOTION_NO_ROLLBACK)};`,
  ];
  for (const c of plan.components) {
    const envs = promotion.filter((env) => c.byEnv[env]);
    const dependsOn = [...new Set(envs.flatMap((env) => c.byEnv[env]!.dependsOn))].sort();
    const gatedEnvs = envs.filter((env) => plan.gated.includes(env));
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

// ── terragucci promote and rollback ─────────────────────────────────────────

/** The terraform lexicon terragucci builds with, which a promote's `terraform-apply` step loads. */
export const TERRAFORM_LEXICON = `@intentius/chant-lexicon-terraform@${devDependencies["@intentius/chant-lexicon-terraform"]}`;

/** The usage lines, as the CLI and its reference print them. */
export const PROMOTE_USAGE = "terragucci promote --to <env> [--release <label>] [--from <env>] [--allow-skip] [--dry-run] [--json]";
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
 * promote --to <env>` with `--release`, `--from`, `--allow-skip` and
 * `--dry-run` as given, or `components rollback <env> --release <label>`.
 */
export function releaseArgv(verb: "promote" | "rollback", line: ReleaseLine): string[] {
  const usage = verb === "promote" ? PROMOTE_USAGE : ROLLBACK_USAGE;
  const allowed = verb === "promote" ? ["to", "release", "from", "allow-skip", "dry-run", "json"] : ["release", "dry-run", "json"];
  const extra = Object.keys(line.flags).filter((k) => line.flags[k] !== undefined && !allowed.includes(k));
  if (extra.length) throw new ConfigError(`${verb} does not take ${extra.map((k) => `--${k}`).join(", ")}: ${usage}`);
  const release = flagValue(line.flags, "release", usage);
  const switches = [...(line.flags["dry-run"] === true ? ["--dry-run"] : []), ...(line.flags.json === true ? ["--json"] : [])];
  if (verb === "promote") {
    if (line.args.length) throw new ConfigError(`promote names its environment with --to, not ${line.args.join(" ")}: ${usage}`);
    const to = flagValue(line.flags, "to", usage);
    if (!to) throw new ConfigError(`promote needs --to <env>, the environment the release goes to: ${usage}`);
    const from = flagValue(line.flags, "from", usage);
    return ["components", "promote", "--to", to, ...(release ? ["--release", release] : []), ...(from ? ["--from", from] : []), ...(line.flags["allow-skip"] === true ? ["--allow-skip"] : []), ...switches];
  }
  if (line.args.length !== 1) throw new ConfigError(`rollback takes one environment: ${usage}`);
  if (!release) throw new ConfigError(`rollback needs --release <label>, the earlier release ${line.args[0]} goes back to: ${usage}`);
  return ["components", "rollback", line.args[0]!, "--release", release, ...switches];
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

/** terragucci's words for a promote or rollback: its approve line names the environment's release gate. */
export function releaseWords<W extends { approve: string }>(words: W): W {
  return { ...words, approve: "terragucci approve release {target} {sign}" };
}
