/**
 * AWS roles by root: `oidc.roles` maps root globs to a plan role and an apply
 * role, so each environment's roots plan and apply with roles that reach that
 * environment's state alone. The pipeline carries one stage's roles in
 * ROOT_ROLES_ENV; the stage gives each root's binary (and the steps, and the
 * state version read after an apply) the role of the first glob the root
 * matches, as `AWS_ROLE_ARN` with the job's OIDC token. A root no glob
 * matches keeps the job's own role.
 *
 * stateAccess is what `config check` reads from the repo: which roots and
 * which state keys each role reaches, from the backend and
 * `terraform_remote_state` blocks in the roots' code, and a warning for each
 * role that reaches another environment's state.
 */
import { globMatch, rootDependencies, stateOf, type StateRef } from "./detect";
import type { OidcSettings, RolePair } from "./config";

/** The job's variable that holds one stage's roles by root glob, as JSON `[[glob, role], ...]`. */
export const ROOT_ROLES_ENV = "TERRAGUCCI_ROOT_ROLES";

/** One stage's roles by root glob, in the order the config lists them. */
export function rootRoles(roles: Record<string, RolePair>, stage: "plan" | "apply"): [string, string][] {
  return Object.entries(roles).map(([glob, pair]) => [glob, pair[stage]]);
}

/** The roles ROOT_ROLES_ENV carries; none when it is unset. */
export function rolesFromEnv(env: NodeJS.ProcessEnv): [string, string][] {
  const text = env[ROOT_ROLES_ENV];
  if (!text) return [];
  try {
    const v = JSON.parse(text) as unknown;
    if (Array.isArray(v) && v.every((x) => Array.isArray(x) && x.length === 2 && typeof x[0] === "string" && typeof x[1] === "string")) return v as [string, string][];
  } catch {
    // Not JSON: refused below.
  }
  throw new Error(`${ROOT_ROLES_ENV} is not a list of [root glob, role] pairs`);
}

/** The role a root takes: the first glob it matches, or undefined for the job's own. */
export function roleOf(root: string, roles: [string, string][]): string | undefined {
  return roles.find(([glob]) => globMatch(glob, root))?.[1];
}

/**
 * `env` for one root's binary: with ROOT_ROLES_ENV set and a glob the root
 * matches, `AWS_ROLE_ARN` is that role, assumed with the job's token file.
 * Static keys in the job's environment would win over the role in the AWS
 * SDKs, so they are dropped for that root.
 */
export function rootRoleEnv(env: NodeJS.ProcessEnv, root: string): NodeJS.ProcessEnv {
  const role = roleOf(root, rolesFromEnv(env));
  if (!role) return env;
  const { AWS_ACCESS_KEY_ID: _a, AWS_SECRET_ACCESS_KEY: _s, AWS_SESSION_TOKEN: _t, ...rest } = env;
  return { ...rest, AWS_ROLE_ARN: role };
}

// ── config check ─────────────────────────────────────────────────────────

/** One role and what it reaches: the roots that take it, their states, and the other roots' states they read. */
export interface RoleReach {
  role: string;
  stage: "plan" | "apply";
  /** The `oidc.roles` glob, or `plan_role`/`apply_role` for the pair every other root takes. */
  environment: string;
  roots: string[];
  /** The states its roots' backends name: `s3://<bucket>/<key>`, or the key when the bucket is not written in the code. */
  states: string[];
  /** States of other environments its roots read through `terraform_remote_state`. */
  reads: string[];
}

export interface StateAccess {
  roles: RoleReach[];
  warnings: string[];
}

const where = (s: StateRef): string => (s.bucket ? `s3://${s.bucket}/${s.key}` : s.key);
const DEFAULT_ENV = "plan_role/apply_role";

/**
 * Which state each role reaches, from the roots' code. Each `oidc.roles` glob
 * is an environment, and the roots no glob matches are one more, with
 * `plan_role` and `apply_role`. A warning names each role two environments
 * share, each root that reads another environment's state, and each root
 * left with no role.
 */
export function stateAccess(repo: string, roots: string[], oidc: OidcSettings): StateAccess {
  const roles = oidc.roles ?? {};
  const globs = Object.keys(roles);
  const envOf = new Map<string, string | undefined>();
  const warnings: string[] = [];
  for (const root of roots) {
    const glob = globs.find((g) => globMatch(g, root));
    const env = glob ?? (oidc.plan_role && oidc.apply_role ? DEFAULT_ENV : undefined);
    envOf.set(root, env);
    if (!env) warnings.push(`oidc: ${root} matches no oidc.roles glob, and oidc names no plan_role and apply_role, so it plans and applies with no AWS role`);
  }
  const pairOf = (env: string): RolePair => (env === DEFAULT_ENV ? { plan: oidc.plan_role!, apply: oidc.apply_role! } : roles[env]!);
  const states = new Map(roots.map((r) => [r, stateOf(repo, r)]));
  const deps = rootDependencies(repo, roots);
  const envs = [...new Set([...envOf.values()].filter((e): e is string => e !== undefined))];
  // Every environment configured, also one no root is in yet.
  for (const g of globs) if (!envs.includes(g)) envs.push(g);
  const out: RoleReach[] = [];
  for (const env of envs) {
    const members = roots.filter((r) => envOf.get(r) === env);
    const own = members.map((r) => states.get(r)?.own).filter((s): s is StateRef => s !== undefined).map(where);
    const reads: string[] = [];
    for (const r of members) {
      for (const up of deps.get(r) ?? []) {
        const upEnv = envOf.get(up);
        if (upEnv === env) continue;
        const at = states.get(up)?.own;
        const loc = at ? where(at) : up;
        if (!reads.includes(loc)) reads.push(loc);
        const pair = pairOf(env);
        warnings.push(`oidc: ${r} (${env}) reads the state of ${up} (${upEnv ?? "no role"}) through terraform_remote_state, so ${pair.plan} and ${pair.apply} reach ${loc}, another environment's state`);
      }
    }
    for (const stage of ["plan", "apply"] as const) out.push({ role: pairOf(env)[stage], stage, environment: env, roots: members, states: [...new Set(own)].sort(), reads: reads.sort() });
  }
  // One role in two environments reaches the state of both.
  const byRole = new Map<string, RoleReach[]>();
  for (const r of out) byRole.set(r.role, [...(byRole.get(r.role) ?? []), r]);
  for (const [role, uses] of byRole) {
    const envNames = [...new Set(uses.map((u) => u.environment))];
    if (envNames.length < 2) continue;
    const reached = [...new Set(uses.flatMap((u) => u.states))].sort();
    warnings.push(`oidc: ${role} is the role of ${envNames.join(" and ")}, so it reaches the state of each${reached.length ? `: ${reached.join(", ")}` : ""}; give each environment roles of its own`);
  }
  return { roles: out, warnings };
}

/** `terragrunt.credentials`: a warning for each role two unit globs share, as stateAccess gives for `oidc.roles`. */
export function credentialWarnings(credentials: Record<string, RolePair>): string[] {
  const out: string[] = [];
  for (const stage of ["plan", "apply"] as const) {
    const byRole = new Map<string, string[]>();
    for (const [glob, pair] of Object.entries(credentials)) byRole.set(pair[stage], [...(byRole.get(pair[stage]) ?? []), glob]);
    for (const [role, globs] of byRole) if (globs.length > 1) out.push(`terragrunt.credentials: ${role} is the ${stage} role of ${globs.join(" and ")}, so it reaches the state of each; give each environment roles of its own`);
  }
  return out;
}
