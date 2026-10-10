/**
 * Cloud identities by root: `oidc.roles` (AWS roles), `oidc.gcp.roles`
 * (service accounts) and `oidc.azure.roles` (Entra clients) map root globs to
 * a plan identity and an apply identity, so each environment's roots plan
 * and apply with identities that reach that environment's state alone. The
 * pipeline carries one stage's identities in ROOT_ROLES_ENV, ROOT_GCP_ENV and
 * ROOT_AZURE_ENV; the stage gives each root's binary (and the steps, and the
 * state version read after an apply) the identity of the first glob the root
 * matches:
 *
 *   AWS    `AWS_ROLE_ARN`, assumed with the job's OIDC token
 *   GCP    GOOGLE_APPLICATION_CREDENTIALS, a copy of the job's
 *          external_account file that impersonates the root's service account
 *   Azure  `ARM_CLIENT_ID`, the client the job's token is traded for
 *
 * A root no glob matches keeps the job's own identity.
 *
 * stateAccess is what `config check` reads from the repo: which roots and
 * which state keys each identity reaches, from the backend and
 * `terraform_remote_state` blocks in the roots' code, and a warning for each
 * identity that reaches another environment's state.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { globMatch, rootDependencies, stateOf, type StateRef } from "./detect";
import type { OidcSettings, RolePair } from "./config";

/** The job's variable that holds one stage's roles by root glob, as JSON `[[glob, role], ...]`. */
export const ROOT_ROLES_ENV = "TERRAGUCCI_ROOT_ROLES";
/** One stage's GCP service accounts by root glob, as ROOT_ROLES_ENV holds roles. */
export const ROOT_GCP_ENV = "TERRAGUCCI_ROOT_GCP_SERVICE_ACCOUNTS";
/** One stage's Azure client ids by root glob, as ROOT_ROLES_ENV holds roles. */
export const ROOT_AZURE_ENV = "TERRAGUCCI_ROOT_AZURE_CLIENTS";

/** One stage's roles by root glob, in the order the config lists them. */
export function rootRoles(roles: Record<string, RolePair>, stage: "plan" | "apply"): [string, string][] {
  return Object.entries(roles).map(([glob, pair]) => [glob, pair[stage]]);
}

/** The identities a variable (ROOT_ROLES_ENV by default) carries; none when it is unset. */
export function rolesFromEnv(env: NodeJS.ProcessEnv, name = ROOT_ROLES_ENV): [string, string][] {
  const text = env[name];
  if (!text) return [];
  try {
    const v = JSON.parse(text) as unknown;
    if (Array.isArray(v) && v.every((x) => Array.isArray(x) && x.length === 2 && typeof x[0] === "string" && typeof x[1] === "string")) return v as [string, string][];
  } catch {
    // Not JSON: refused below.
  }
  throw new Error(`${name} is not a list of [root glob, ${name === ROOT_ROLES_ENV ? "role" : "identity"}] pairs`);
}

/** The role a root takes: the first glob it matches, or undefined for the job's own. */
export function roleOf(root: string, roles: [string, string][]): string | undefined {
  return roles.find(([glob]) => globMatch(glob, root))?.[1];
}

/**
 * `env` for one root's binary: for each cloud whose variable names a glob
 * the root matches, that identity. AWS: `AWS_ROLE_ARN` is the role, assumed
 * with the job's token file; static keys in the job's environment would win
 * over the role in the AWS SDKs, so they are dropped for that root. GCP:
 * GOOGLE_APPLICATION_CREDENTIALS is gcpCredentials' copy of the job's file.
 * Azure: ARM_CLIENT_ID is the client.
 */
export function rootRoleEnv(env: NodeJS.ProcessEnv, root: string): NodeJS.ProcessEnv {
  let out = env;
  const role = roleOf(root, rolesFromEnv(env));
  if (role) {
    const { AWS_ACCESS_KEY_ID: _a, AWS_SECRET_ACCESS_KEY: _s, AWS_SESSION_TOKEN: _t, ...rest } = out;
    out = { ...rest, AWS_ROLE_ARN: role };
  }
  const sa = roleOf(root, rolesFromEnv(env, ROOT_GCP_ENV));
  if (sa) out = { ...out, GOOGLE_APPLICATION_CREDENTIALS: gcpCredentials(env, sa) };
  const client = roleOf(root, rolesFromEnv(env, ROOT_AZURE_ENV));
  if (client) out = { ...out, ARM_CLIENT_ID: client, ...(env.AZURE_CLIENT_ID ? { AZURE_CLIENT_ID: client } : {}) };
  return out;
}

/** The service account in an impersonation URL: `.../serviceAccounts/<email>:generateAccessToken`. */
const IMPERSONATED = /\/serviceAccounts\/([^/:]+):generateAccessToken$/;

/**
 * The credentials file that impersonates `sa`: the job's external_account
 * file (what `oidc.gcp` writes) with its impersonation URL naming `sa`,
 * written once beside it, mode 0600. The job's file when it names `sa`
 * already.
 */
export function gcpCredentials(env: NodeJS.ProcessEnv, sa: string): string {
  const file = env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!file) throw new Error(`${ROOT_GCP_ENV} gives this root ${sa}, and GOOGLE_APPLICATION_CREDENTIALS is not set: the job needs oidc.gcp`);
  let c: Record<string, unknown>;
  try {
    c = JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
  } catch (e) {
    throw new Error(`${ROOT_GCP_ENV} gives this root ${sa}, and ${file} cannot be read: ${(e as Error).message}`);
  }
  const url = c.service_account_impersonation_url;
  if (c.type !== "external_account" || typeof url !== "string" || !IMPERSONATED.test(url)) {
    throw new Error(`${ROOT_GCP_ENV} gives this root ${sa}, and ${file} is not an external_account file that impersonates a service account, as oidc.gcp writes`);
  }
  if (decodeURIComponent(IMPERSONATED.exec(url)![1]) === sa) return file;
  const out = `${file}.${createHash("sha256").update(sa).digest("hex").slice(0, 12)}.json`;
  if (!existsSync(out)) writeFileSync(out, JSON.stringify({ ...c, service_account_impersonation_url: url.replace(IMPERSONATED, `/serviceAccounts/${sa}:generateAccessToken`) }) + "\n", { mode: 0o600 });
  return out;
}

// ── config check ─────────────────────────────────────────────────────────

/** One identity and what it reaches: the roots that take it, their states, and the other roots' states they read. */
export interface RoleReach {
  role: string;
  stage: "plan" | "apply";
  /** The glob, or the pair every other root takes (`plan_role/apply_role`, `plan_service_account/apply_service_account`, `plan_client_id/apply_client_id`). */
  environment: string;
  /** The cloud, for a GCP service account or an Azure client; absent for an AWS role. */
  cloud?: "gcp" | "azure";
  roots: string[];
  /** The states its roots' backends name: `s3://<bucket>/<key>` (`gs://` for GCP), or the key when the bucket is not written in the code. */
  states: string[];
  /** States of other environments its roots read through `terraform_remote_state`. */
  reads: string[];
}

export interface StateAccess {
  roles: RoleReach[];
  warnings: string[];
}

/** Roots whose states and reads are known without reading their code: an Atmos repo's instances, from its stacks. */
export interface KnownStates {
  states: Map<string, StateRef | undefined>;
  reads: Map<string, Set<string>>;
  /** How a root reads another's state, for the warning. */
  via: string;
}

/** One cloud's identities by glob, and the pair the other roots take. */
interface CloudRoles {
  cloud?: "gcp" | "azure";
  /** The key, for the warnings. */
  key: string;
  roles: Record<string, RolePair>;
  /** The pair every other root takes, and what the config calls it. */
  fallback?: { name: string; pair: RolePair };
  scheme: string;
}

/** The identities of `cloud` in `oidc`, or undefined when it names none by glob. */
function cloudRoles(oidc: OidcSettings, cloud: "aws" | "gcp" | "azure"): CloudRoles | undefined {
  if (cloud === "gcp") {
    const g = oidc.gcp;
    return g?.roles ? { cloud, key: "oidc.gcp", roles: g.roles, fallback: { name: "plan_service_account/apply_service_account", pair: { plan: g.plan_service_account, apply: g.apply_service_account } }, scheme: "gs://" } : undefined;
  }
  if (cloud === "azure") {
    const a = oidc.azure;
    return a?.roles ? { cloud, key: "oidc.azure", roles: a.roles, fallback: { name: "plan_client_id/apply_client_id", pair: { plan: a.plan_client_id, apply: a.apply_client_id } }, scheme: "" } : undefined;
  }
  return { key: "oidc", roles: oidc.roles ?? {}, ...(oidc.plan_role && oidc.apply_role ? { fallback: { name: "plan_role/apply_role", pair: { plan: oidc.plan_role, apply: oidc.apply_role } } } : {}), scheme: "s3://" };
}

/**
 * Which state each identity reaches, from the roots' code. Each glob of the
 * cloud's roles is an environment, and the roots no glob matches are one
 * more, with the cloud's pair for every root. A warning names each identity
 * two environments share, each root that reads another environment's state,
 * and each root left with no AWS role. `cloud` is aws (`oidc.roles`, the
 * default), gcp (`oidc.gcp.roles`) or azure (`oidc.azure.roles`).
 */
export function stateAccess(repo: string, roots: string[], oidc: OidcSettings, known?: KnownStates, cloud: "aws" | "gcp" | "azure" = "aws"): StateAccess {
  const spec = cloudRoles(oidc, cloud);
  if (!spec) return { roles: [], warnings: [] };
  const roles = spec.roles;
  const globs = Object.keys(roles);
  const fallback = spec.fallback?.name;
  const where = (s: StateRef): string => (s.bucket && spec.scheme ? `${spec.scheme}${s.bucket}/${s.key}` : s.key);
  const envOf = new Map<string, string | undefined>();
  const warnings: string[] = [];
  for (const root of roots) {
    const glob = globs.find((g) => globMatch(g, root));
    const env = glob ?? fallback;
    envOf.set(root, env);
    if (!env) warnings.push(`oidc: ${root} matches no oidc.roles glob, and oidc names no plan_role and apply_role, so it plans and applies with no AWS role`);
  }
  const pairOf = (env: string): RolePair => (env === fallback ? spec.fallback!.pair : roles[env]!);
  const states = new Map(roots.map((r) => [r, known ? { own: known.states.get(r) } : stateOf(repo, r)]));
  // State files only: a choudoufu estate's outputs are records, not a state the role reaches.
  const deps = known?.reads ?? rootDependencies(repo, roots, { estates: false });
  const via = known?.via ?? "terraform_remote_state";
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
        warnings.push(`${spec.key}: ${r} (${env}) reads the state of ${up} (${upEnv ?? "no role"}) through ${via}, so ${pair.plan} and ${pair.apply} reach ${loc}, another environment's state`);
      }
    }
    for (const stage of ["plan", "apply"] as const) out.push({ role: pairOf(env)[stage], stage, environment: env, ...(spec.cloud ? { cloud: spec.cloud } : {}), roots: members, states: [...new Set(own)].sort(), reads: reads.sort() });
  }
  // One identity in two environments reaches the state of both.
  const byRole = new Map<string, RoleReach[]>();
  for (const r of out) byRole.set(r.role, [...(byRole.get(r.role) ?? []), r]);
  for (const [role, uses] of byRole) {
    const envNames = [...new Set(uses.map((u) => u.environment))];
    if (envNames.length < 2) continue;
    const reached = [...new Set(uses.flatMap((u) => u.states))].sort();
    const what = spec.cloud === "gcp" ? "service account" : spec.cloud === "azure" ? "client" : "role";
    warnings.push(`${spec.key}: ${role} is the ${what} of ${envNames.join(" and ")}, so it reaches the state of each${reached.length ? `: ${reached.join(", ")}` : ""}; give each environment ${what === "role" ? "roles" : `${what}s`} of its own`);
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
