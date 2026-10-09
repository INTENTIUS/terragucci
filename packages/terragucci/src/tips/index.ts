/**
 * Tips: advice on how a repo is set up. A tip is advisory. It is never part of
 * a plan, a digest or a gate, and nothing an approval covers reads it.
 *
 * Code tips come from chant's terraform lint. This file runs those checks over
 * each root's parsed files and wraps what they report; it holds no copy of
 * their logic, so `chant lint` and a report never disagree and a check left
 * out of `rules` leaves its tip out.
 *
 * Rollout tips are terragucci's own and read the repo's shape: how many roots
 * share a local module, whether there is a canary wave, whether a gate is off
 * where plans destroy.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import type { PostSynthCheck, PostSynthContext } from "@intentius/chant/lint/post-synth";
import type { Hcl2Json } from "@intentius/chant/terraform/parse";
import { exactVersion, readModulePin } from "@intentius/chant-lexicon-terraform/pin";
import { parseTerraformRootDir } from "@intentius/chant-lexicon-terraform/hcl/parse";
import { tf002 } from "@intentius/chant-lexicon-terraform/lint/post-synth/tf002";
import { tf003 } from "@intentius/chant-lexicon-terraform/lint/post-synth/tf003";
import { tf004 } from "@intentius/chant-lexicon-terraform/lint/post-synth/tf004";
import { tf005 } from "@intentius/chant-lexicon-terraform/lint/post-synth/tf005";
import { tf038 } from "@intentius/chant-lexicon-terraform/lint/post-synth/tf038";
import { tf039 } from "@intentius/chant-lexicon-terraform/lint/post-synth/tf039";
import { tf040 } from "@intentius/chant-lexicon-terraform/lint/post-synth/tf040";
import { tf041 } from "@intentius/chant-lexicon-terraform/lint/post-synth/tf041";
import { tf042 } from "@intentius/chant-lexicon-terraform/lint/post-synth/tf042";
import { tf043 } from "@intentius/chant-lexicon-terraform/lint/post-synth/tf043";
import { tf044 } from "@intentius/chant-lexicon-terraform/lint/post-synth/tf044";
import type { ResolvedSettings } from "../config";
import type { ReportTip } from "../report/schema";
import type { Rename } from "./moved";

/** Chant's checks that become tips, by rule id. */
export const CODE_RULES: Readonly<Record<string, PostSynthCheck>> = {
  TF002: tf002, TF003: tf003, TF004: tf004, TF005: tf005, TF038: tf038, TF039: tf039, TF040: tf040,
  // Terragrunt: mocks that can reach apply, a dependency that always reads its mocks, unpinned
  // unit sources, local state.
  TF041: tf041, TF042: tf042, TF043: tf043, TF044: tf044,
};

/** Where chant documents its terraform rules. */
export const CHANT_RULES_URL = "https://intentius.io/chant/lexicons/terraform/lint-rules/";
/** Where terragucci documents its own tips; each rule is a heading. */
export const TIPS_URL = "https://intentius.io/terragucci/reference/tips/";

/** A local module is shared widely at this many roots. */
export const SHARED_MODULE_ROOTS = 10;
/** A project has more than a few roots above this many. */
export const FEW_ROOTS = 5;
/** Planning this many roots on every change is worth a tip. */
export const HUNDREDS_OF_ROOTS = 100;

export interface TipOptions {
  settings: Pick<ResolvedSettings, "gate" | "tips"> & { waves?: { canary?: string[] } };
  /** The HCL parser. Without it the code tips and the shared-module tip are left out. */
  parser?: Hcl2Json;
  /** The chant rule ids to run. Default: all of `CODE_RULES`. */
  rules?: readonly string[];
  /** Roots whose plans destroy or replace something. Known only after a plan. */
  destroying?: readonly string[];
  /** How many roots every change plans. Default: the roots given. */
  planned?: number;
  /** More directories for the code tips only, such as a Terragrunt repo's top with its root.hcl. */
  configDirs?: readonly string[];
  /** The renames the plans show (./moved.ts). Known only after a plan. */
  renames?: readonly Rename[];
}

const codeTip = (rule: string, root: string, message: string): ReportTip => ({ rule, root, message, url: `${CHANT_RULES_URL}#${rule.toLowerCase()}` });
const ownTip = (rule: string, message: string, root?: string): ReportTip => ({ rule, ...(root !== undefined ? { root } : {}), message, url: `${TIPS_URL}#${rule}` });

interface Call { source: string; version?: string }

/** The module calls in one directory's `.tf` files. */
async function callsIn(repo: string, dir: string, parser: Hcl2Json): Promise<Call[]> {
  const out: Call[] = [];
  if (!existsSync(join(repo, dir))) return out;
  for (const f of readdirSync(join(repo, dir)).filter((n) => n.endsWith(".tf")).sort()) {
    const tree = (await parser.parse(f, readFileSync(join(repo, dir, f), "utf-8"))) as { module?: Record<string, Record<string, unknown>[]> };
    for (const bodies of Object.values(tree.module ?? {})) {
      for (const body of bodies) {
        if (typeof body.source === "string") out.push({ source: body.source, ...(typeof body.version === "string" ? { version: body.version } : {}) });
      }
    }
  }
  return out;
}

/** The providers a root constrains to a range, as `name` and `version`. */
async function providerRanges(repo: string, dir: string, parser: Hcl2Json): Promise<Array<{ name: string; version: string }>> {
  const out: Array<{ name: string; version: string }> = [];
  if (!existsSync(join(repo, dir))) return out;
  for (const f of readdirSync(join(repo, dir)).filter((n) => n.endsWith(".tf")).sort()) {
    const tree = (await parser.parse(f, readFileSync(join(repo, dir, f), "utf-8"))) as { terraform?: Array<{ required_providers?: Array<Record<string, unknown>> }> };
    for (const block of tree.terraform ?? []) {
      for (const entries of block.required_providers ?? []) {
        for (const [name, entry] of Object.entries(entries)) {
          const version = (entry as { version?: unknown } | null)?.version;
          if (typeof version === "string" && exactVersion(version) === null) out.push({ name, version });
        }
      }
    }
  }
  return out;
}

/** Every local module a directory reaches, directly or through another local module. */
async function localModules(repo: string, dir: string, parser: Hcl2Json, seen = new Set<string>()): Promise<Set<string>> {
  const out = new Set<string>();
  if (seen.has(dir)) return out;
  seen.add(dir);
  for (const { source } of await callsIn(repo, dir, parser)) {
    if (!/^\.\.?\//.test(source)) continue;
    const target = posix.normalize(posix.join(dir === "." ? "" : dir, source)) || ".";
    out.add(target);
    for (const inner of await localModules(repo, target, parser, seen)) out.add(inner);
  }
  return out;
}

/** The tips for a set of roots. Empty when `settings.tips` is off. */
export async function repoTips(repo: string, roots: readonly string[], options: TipOptions): Promise<ReportTip[]> {
  if (options.settings.tips === false) return [];
  const tips: ReportTip[] = [];
  const { parser } = options;

  if (parser) {
    const checks = (options.rules ?? Object.keys(CODE_RULES)).map((id) => CODE_RULES[id]).filter((c): c is PostSynthCheck => c !== undefined);
    const floating = new Set<string>();
    const users = new Map<string, Set<string>>();
    for (const dir of options.configDirs ?? []) {
      const entities = await parseTerraformRootDir(join(repo, dir), dir, parser);
      const ctx = { outputs: new Map(), entities } as unknown as PostSynthContext;
      for (const check of checks) for (const d of await check.check(ctx)) tips.push(codeTip(check.id, dir, d.message));
    }
    for (const root of roots) {
      const entities = await parseTerraformRootDir(join(repo, root), root, parser);
      const ctx = { outputs: new Map(), entities } as unknown as PostSynthContext;
      for (const check of checks) {
        for (const d of await check.check(ctx)) {
          tips.push(codeTip(check.id, root, d.message));
          if (check.id === "TF038" || check.id === "TF039") floating.add(root);
        }
      }
      for (const m of await localModules(repo, root, parser)) users.set(m, (users.get(m) ?? new Set()).add(root));
      // Chant's own range tips name the call already; this one says what the range costs a rollout.
      for (const { name, version } of await providerRanges(repo, root, parser)) {
        tips.push(ownTip(
          "terragucci-floating-range",
          `Provider ${name} is constrained to the range "${version}". tf-rollout --provider moves the lock file, and a version outside the range fails init, so a rollout cannot cross it. Pin the exact version, or widen the range on purpose.`,
          root,
        ));
      }
      if (!floating.has(root)) {
        for (const { source, version } of await callsIn(repo, root, parser)) {
          if (!readModulePin(source, version).unpinned?.includes("is a constraint")) continue;
          tips.push(ownTip(
            "terragucci-floating-range",
            `${source} is pinned to the range "${version}". A range cannot be bumped by a pin, so tf-rollout cannot move it in waves. Pin one version.`,
            root,
          ));
        }
      }
    }
    for (const [module, by] of [...users].sort(([a], [b]) => (a < b ? -1 : 1))) {
      if (by.size < SHARED_MODULE_ROOTS) continue;
      tips.push(ownTip(
        "terragucci-shared-module",
        `${module} is included by ${by.size} roots, so every change under it plans every one of them. Publish it with tf-publish and pin it in each root, and only the roots whose pin moves are planned.`,
        module,
      ));
    }
  }

  if (roots.length > FEW_ROOTS && (options.settings.waves?.canary ?? []).length === 0) {
    tips.push(ownTip(
      "terragucci-no-canary",
      `The project has ${roots.length} roots and no waves.canary, so the first wave is chosen by apply order. Name one or two low-risk roots there, since the first wave is the riskiest.`,
    ));
  }

  const destroying = options.destroying ?? [];
  if (options.settings.gate === "never" && destroying.length > 0) {
    for (const root of [...destroying].sort()) {
      tips.push(ownTip(
        "terragucci-ungated-destroy",
        `${root} plans a destroy or replacement and gate is never, so nothing stops it but the forge's own reviewers. Use gate: on-destroy.`,
        root,
      ));
    }
  }

  for (const r of options.renames ?? []) {
    tips.push(ownTip(
      "terragucci-moved",
      `${r.from} is destroyed and ${r.to} created with the same configuration, so the block was renamed. A moved block (from = ${r.from}, to = ${r.to}) makes the plan move it instead; terragucci respond tips --report opens a pull request that adds it.`,
      r.root,
    ));
  }

  const planned = options.planned ?? roots.length;
  if (planned >= HUNDREDS_OF_ROOTS) {
    tips.push(ownTip(
      "terragucci-many-roots",
      `${planned} roots are planned on every change. Publishing shared modules and pinning them in each root shrinks the set a change reaches.`,
    ));
  }

  return tips;
}

/** One line per tip, for a terminal. */
export function describeTips(tips: readonly ReportTip[]): string[] {
  return tips.map((t) => `tip (${t.rule}): ${t.root ? `${t.root}: ` : ""}${t.message}`);
}
