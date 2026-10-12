/**
 * What a pull request's change reaches from outside every root's directory
 * (`affectedRoots` in ./report/stage.ts reads these):
 *
 *   var files      the `-var-file` arguments in TF_CLI_ARGS and
 *                  TF_CLI_ARGS_plan, from terragucci.yml's `env` or the job's
 *                  own environment. The binary runs in the root's directory,
 *                  so each path is relative to the root, as chant's
 *                  `changedRoots` reads a root's `varFiles`.
 *   symlinks       a symlink under a root (a shared `.terraform.lock.hcl`,
 *                  provider file or `.auto.tfvars`) watches the file or
 *                  directory it points at, passed to `changedRoots` the same way.
 *   settings       terragucci.yml's keys that change what a root plans:
 *                  `version`, `generate`, `pass`, `env` and `oidc` (its roles
 *                  by glob resolved for the root). A root whose resolved
 *                  settings differ between the base and the head plans.
 *
 * `policy`, `approval`, `gate` and `steps` are read from the config at the
 * base whatever the head says, so a change to them plans nothing.
 */
import { readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import type { ResolvedSettings, RolePair } from "./config";
import { globMatch } from "./detect";
import { rootSettings, versionPin } from "./generate";

/** The variables whose `-var-file` arguments a root's plan reads. */
export const VAR_FILE_ENV = ["TF_CLI_ARGS", "TF_CLI_ARGS_plan"] as const;

/** The terragucci.yml keys whose change selects the roots it changes. */
export const PLAN_KEYS = ["version", "generate", "pass", "env", "oidc"] as const;
export type PlanKey = (typeof PLAN_KEYS)[number];

/** Directories under a root that hold no file of the root's own. */
const SKIP_DIRS = new Set([".terraform", ".git", "node_modules", "terragucci-report"]);

/** A TF_CLI_ARGS value split into words, as a shell would: quotes group, backslash escapes. */
export function argWords(value: string): string[] {
  const words: string[] = [];
  let cur: string | undefined;
  let quote: string | undefined;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (quote) {
      if (c === quote) quote = undefined;
      else if (c === "\\" && quote === '"' && i + 1 < value.length) cur = (cur ?? "") + value[++i];
      else cur = (cur ?? "") + c;
    } else if (c === "'" || c === '"') {
      quote = c;
      cur ??= "";
    } else if (c === "\\" && i + 1 < value.length) {
      cur = (cur ?? "") + value[++i];
    } else if (/\s/.test(c)) {
      if (cur !== undefined) words.push(cur);
      cur = undefined;
    } else cur = (cur ?? "") + c;
  }
  if (cur !== undefined) words.push(cur);
  return words;
}

/**
 * The var files a root's plan reads from the environment: each `-var-file`
 * in TF_CLI_ARGS and TF_CLI_ARGS_plan, relative to the root. An absolute
 * path, or one with a variable in it, names no file in the repo and is left out.
 */
export function envVarFiles(env: Record<string, string | undefined>): string[] {
  const out: string[] = [];
  for (const name of VAR_FILE_ENV) {
    const words = argWords(env[name] ?? "");
    for (let i = 0; i < words.length; i++) {
      const m = /^--?var-file(?:=(.*))?$/.exec(words[i]);
      if (!m) continue;
      const file = m[1] ?? words[++i];
      if (file && !isAbsolute(file) && !file.includes("$")) out.push(file);
    }
  }
  return [...new Set(out)];
}

const posixPath = (p: string): string => p.split(sep).join("/");

/**
 * What the symlinks under `root` point at, outside the root's directory and
 * inside the repo, as paths relative to the root. A link to a directory
 * watches that directory; the walk does not follow it.
 */
export function symlinkTargets(repo: string, root: string): string[] {
  if (root === "." || root === "") return [];
  let top: string;
  let dir: string;
  try {
    top = realpathSync(repo);
    dir = realpathSync(join(repo, root));
  } catch {
    return [];
  }
  const out = new Set<string>();
  const walk = (at: string): void => {
    let entries;
    try {
      entries = readdirSync(at, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const path = join(at, e.name);
      if (e.isSymbolicLink()) {
        let target: string;
        try {
          target = realpathSync(path);
        } catch {
          continue;
        }
        const inRepo = relative(top, target);
        if (inRepo.startsWith("..") || isAbsolute(inRepo)) continue;
        const fromRoot = relative(dir, target);
        if (fromRoot.startsWith("..")) out.add(posixPath(fromRoot));
      } else if (e.isDirectory() && !SKIP_DIRS.has(e.name)) {
        walk(path);
      }
    }
  };
  walk(dir);
  return [...out].sort();
}

/** The pair of the first glob `root` matches, else the pair the stage-wide keys give. */
function pairOf(roles: Record<string, RolePair> | undefined, plan: string | undefined, apply: string | undefined, root: string): Partial<RolePair> {
  const glob = roles ? Object.keys(roles).find((g) => globMatch(g, root)) : undefined;
  return glob !== undefined ? roles![glob] : { ...(plan !== undefined ? { plan } : {}), ...(apply !== undefined ? { apply } : {}) };
}

/** The settings that shape one root's plan, each key as the root sees it. */
export function planSettings(s: Partial<ResolvedSettings>, root: string): Record<PlanKey, unknown> {
  let generate: unknown;
  try {
    // No generate key and one that sets nothing for this root read the same.
    generate = rootSettings(s.generate ?? {}, root);
  } catch (e) {
    generate = { error: (e as Error).message };
  }
  const o = s.oidc;
  let oidc: unknown;
  if (o) {
    const { roles: _aws, gcp, azure, plan_role, apply_role, ...rest } = o;
    oidc = {
      ...rest,
      aws: pairOf(o.roles, plan_role, apply_role, root),
      ...(gcp ? { gcp: (({ roles: _g, plan_service_account, apply_service_account, ...g }) => ({ ...g, pair: pairOf(gcp.roles, plan_service_account, apply_service_account, root) }))(gcp) } : {}),
      ...(azure ? { azure: (({ roles: _z, plan_client_id, apply_client_id, ...z }) => ({ ...z, pair: pairOf(azure.roles, plan_client_id, apply_client_id, root) }))(azure) } : {}),
    };
  }
  return { version: versionPin(s.version, root)?.version, generate, pass: s.pass, env: s.env && Object.keys(s.env).length ? s.env : undefined, oidc };
}

/** JSON with its keys sorted, so two equal values read the same. */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v !== null && typeof v === "object") {
    return `{${Object.keys(v as object)
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

/** For each of `roots` whose plan settings differ between `base` and `head`, the keys that differ. */
export function settingsChanged(base: Partial<ResolvedSettings>, head: Partial<ResolvedSettings>, roots: readonly string[]): Map<string, PlanKey[]> {
  const out = new Map<string, PlanKey[]>();
  for (const root of roots) {
    const a = planSettings(base, root);
    const b = planSettings(head, root);
    const keys = PLAN_KEYS.filter((k) => stable(a[k]) !== stable(b[k]));
    if (keys.length) out.set(root, keys);
  }
  return out;
}

/** What `affectedRoots` reads beside the diff: each root's watched files outside its directory, and the roots whose settings changed. */
export interface OutsideRoots {
  /** Root to the paths, relative to it, it reads outside its directory: var files and symlink targets. */
  watch?: Record<string, string[]>;
  /** Root to the terragucci.yml keys whose change reaches it. */
  settings?: Map<string, PlanKey[]>;
}

/** Each root's var files and symlink targets; a root with none is left out. */
export function outsideWatch(repo: string, roots: readonly string[], env: Record<string, string | undefined>): Record<string, string[]> {
  const vars = envVarFiles(env);
  const out: Record<string, string[]> = {};
  for (const root of roots) {
    const paths = [...new Set([...vars, ...symlinkTargets(repo, root)])];
    if (paths.length) out[root] = paths;
  }
  return out;
}
