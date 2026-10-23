/**
 * What `config check` reads from the repo about each cloud identity: which
 * roots and which state keys it reaches, from the backend and
 * `terraform_remote_state` blocks in the roots' code, and a warning for each
 * identity that reaches another environment's state. A root's identity is
 * its first glob's, as chant's `ci.identity.cloud` rules give it
 * (./cloud-identity.ts).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { globMatch, rootDependencies, stateOf, type StateRef } from "./detect";
import type { OidcSettings, RolePair } from "./config";

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
  /** The backend whose states the identity reaches: a GCP service account a gcs state, an Azure client an azurerm one. Absent for AWS, which lists every state. */
  backend?: string;
}

/** The backend type a root's `.tf` files name, or undefined. */
function backendType(repo: string, root: string): string | undefined {
  const dir = join(repo, root);
  if (!existsSync(dir)) return undefined;
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".tf"))) {
    const m = /\bbackend\s+"([^"]+)"/.exec(readFileSync(join(dir, f), "utf-8"));
    if (m) return m[1];
  }
  return undefined;
}

/** The identities of `cloud` in `oidc`, or undefined when it names none by glob. */
function cloudRoles(oidc: OidcSettings, cloud: "aws" | "gcp" | "azure"): CloudRoles | undefined {
  if (cloud === "gcp") {
    const g = oidc.gcp;
    return g?.roles ? { cloud, key: "oidc.gcp", roles: g.roles, fallback: { name: "plan_service_account/apply_service_account", pair: { plan: g.plan_service_account, apply: g.apply_service_account } }, scheme: "gs://", backend: "gcs" } : undefined;
  }
  if (cloud === "azure") {
    const a = oidc.azure;
    return a?.roles ? { cloud, key: "oidc.azure", roles: a.roles, fallback: { name: "plan_client_id/apply_client_id", pair: { plan: a.plan_client_id, apply: a.apply_client_id } }, scheme: "", backend: "azurerm" } : undefined;
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
  // A GCP service account reaches gcs states and an Azure client azurerm ones: a root on another backend's state is reached by another identity.
  const ours = (r: string): boolean => !spec.backend || known !== undefined || backendType(repo, r) === spec.backend;
  const states = new Map(roots.map((r) => [r, known ? { own: known.states.get(r) } : ours(r) ? stateOf(repo, r) : { own: undefined }]));
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
        if (upEnv === env || !ours(up)) continue;
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
