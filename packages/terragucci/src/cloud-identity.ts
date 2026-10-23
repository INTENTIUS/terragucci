/**
 * Cloud identities by root, and one apply job per identity, as chant's
 * `ci.identity.cloud` rules (@intentius/chant/ci-identity).
 *
 * terragucci's config keys stay: `oidc.plan_role`/`apply_role`, `oidc.roles`,
 * `oidc.gcp` (its service accounts and `roles`), `oidc.azure` (its clients
 * and `roles`) and each environment's `oidc` pair. cloudDeclaration turns
 * them into a chant declaration, a rule list per cloud with first match
 * winning:
 *
 *   oidc.roles, gcp.roles, azure.roles   a rule per glob: `targets` the glob,
 *                                        `name` its apply group's name
 *   environments with a pair             a rule per environment: `targets`
 *                                        its root globs, `name` its name
 *   plan_role/apply_role and kin         the rule with no `targets`, last:
 *                                        every other root
 *
 * Every lookup is chant's: resolveTargetCloudIdentity gives a root its
 * identities, cloudIdentityGroups splits roots into apply groups, and a
 * re-plan's traded credentials reach each root through targetCloudEnv.
 *
 * What is terragucci's own here is the pipeline around them: the variables a
 * job carries its stage's identities by root glob in (ROOT_ROLES_ENV, read
 * back by rootIdentities), the copy of the job's GCP credentials file that
 * impersonates a root's service account (gcpCredentials), and each apply
 * group's environment: its runner, forge environment and audience.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  CLOUD_TARGETS_ENV,
  cloudIdentityGroups,
  DEFAULT_IDENTITY_GROUP,
  IDENTITY_KEY,
  readTargetsFile,
  resolveTargetCloudIdentity,
  ruleFor,
  targetCloudEnv,
  targetGlobMatch,
  type Cloud,
  type CloudIdentityDeclaration,
  type CloudIdentityRule,
} from "@intentius/chant/ci-identity";
import { environmentOf, withEnvironmentRoles } from "./environments";
import { DEFAULT_GROUP, reservedGroupName, type EnvironmentSettings, type OidcSettings, type ProjectSettings, type RolePair, type RunnerSpec } from "./config";
import { StoreError } from "./report/object-store";

export { DEFAULT_GROUP, reservedGroupName };

/** chant's environment argument. terragucci's rules name no `environments`, so any name gives the same answer. */
const PIPELINE = "terragucci";

// ── the declaration ─────────────────────────────────────────────────────────

/** A job-name-safe group name from a glob: `envs/prod/**` is `envs-prod`; a reserved name gets `-roots`. */
function globGroupName(glob: string): string {
  const base = glob.toLowerCase().replace(/\*+/g, "").replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "group";
  return reservedGroupName(base) ? `${base}-roots` : base;
}

/** One cloud's rules: its globs, then each environment's pair over the environment's globs no earlier rule names, then the pair every other root takes. */
function cloudRules(byGlob: Record<string, RolePair> | undefined, environments: [string, EnvironmentSettings][], pairOf: (e: EnvironmentSettings) => RolePair | undefined, own: RolePair | undefined): CloudIdentityRule[] {
  const out: CloudIdentityRule[] = Object.entries(byGlob ?? {}).map(([g, p]) => ({ targets: [g], name: globGroupName(g), plan: p.plan, apply: p.apply }));
  const named = new Set(Object.keys(byGlob ?? {}));
  for (const [name, e] of environments) {
    const p = pairOf(e);
    if (!p) continue;
    const targets = (e.roots ?? []).filter((g) => !named.has(g));
    for (const g of targets) named.add(g);
    if (targets.length > 0) out.push({ targets, name, plan: p.plan, apply: p.apply });
  }
  if (own) out.push({ plan: own.plan, apply: own.apply });
  return out;
}

/**
 * The chant declaration of a project's `oidc` and `environments`, or
 * undefined without `oidc`. A cloud with no rule is left out.
 */
export function cloudDeclaration(settings: Pick<ProjectSettings, "oidc" | "environments">): CloudIdentityDeclaration | undefined {
  const oidc = settings.oidc;
  if (!oidc) return undefined;
  const envs = Object.entries(settings.environments ?? {});
  const out: CloudIdentityDeclaration = {};
  const aws = cloudRules(oidc.roles, envs, (e) => (e.oidc?.plan_role && e.oidc.apply_role ? { plan: e.oidc.plan_role, apply: e.oidc.apply_role } : undefined), oidc.plan_role && oidc.apply_role ? { plan: oidc.plan_role, apply: oidc.apply_role } : undefined);
  if (aws.length > 0) out.aws = { rules: aws };
  if (oidc.gcp) {
    const g = oidc.gcp;
    out.gcp = {
      provider: g.workload_identity_provider,
      rules: cloudRules(g.roles, envs, (e) => (e.oidc?.gcp ? { plan: e.oidc.gcp.plan_service_account, apply: e.oidc.gcp.apply_service_account } : undefined), { plan: g.plan_service_account, apply: g.apply_service_account }),
    };
  }
  if (oidc.azure) {
    const z = oidc.azure;
    out.azure = {
      tenantId: z.tenant_id,
      subscriptionId: z.subscription_id,
      ...(z.audience ? { audience: z.audience } : {}),
      rules: cloudRules(z.roles, envs, (e) => (e.oidc?.azure ? { plan: e.oidc.azure.plan_client_id, apply: e.oidc.azure.apply_client_id } : undefined), { plan: z.plan_client_id, apply: z.apply_client_id }),
    };
  }
  return out;
}

/** The identity `root` takes in each cloud for `stage`, by the declaration's first rule that covers it. */
export function rootIdentity(decl: CloudIdentityDeclaration | undefined, root: string, stage: "plan" | "apply"): Partial<Record<Cloud, string>> {
  const spec = resolveTargetCloudIdentity(decl, PIPELINE, undefined, root)?.[stage];
  const out: Partial<Record<Cloud, string>> = {};
  for (const c of ["aws", "gcp", "azure"] as const) {
    const id = (spec?.[c] as Record<string, unknown> | undefined)?.[IDENTITY_KEY[c]];
    if (typeof id === "string") out[c] = id;
  }
  return out;
}

// ── a job's identities by root ─────────────────────────────────────────────

/** The job's variable that holds one stage's roles by root glob, as JSON `[[glob, role], ...]`. */
export const ROOT_ROLES_ENV = "TERRAGUCCI_ROOT_ROLES";
/** One stage's GCP service accounts by root glob, as ROOT_ROLES_ENV holds roles. */
export const ROOT_GCP_ENV = "TERRAGUCCI_ROOT_GCP_SERVICE_ACCOUNTS";
/** One stage's Azure client ids by root glob, as ROOT_ROLES_ENV holds roles. */
export const ROOT_AZURE_ENV = "TERRAGUCCI_ROOT_AZURE_CLIENTS";

const ROOT_VARS: Record<Cloud, string> = { aws: ROOT_ROLES_ENV, gcp: ROOT_GCP_ENV, azure: ROOT_AZURE_ENV };

/** One stage's roles by root glob, in the order the config lists them, as the pipeline exports them. */
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

/**
 * The declaration a job's variables make: per cloud, a rule per glob the
 * stage's variable lists, plan and apply both its identity, with no rule for
 * the job's own. A root no glob matches then takes nothing from it.
 */
function jobDeclaration(env: NodeJS.ProcessEnv): CloudIdentityDeclaration {
  const rules = (c: Cloud): CloudIdentityRule[] => rolesFromEnv(env, ROOT_VARS[c]).map(([g, id]) => ({ targets: [g], plan: id, apply: id }));
  return { aws: { rules: rules("aws") }, gcp: { provider: "", rules: rules("gcp") }, azure: { tenantId: "", rules: rules("azure") } };
}

/** The identities `root` takes from the job's variables, per cloud: none for a cloud where it matches no glob, which keeps the job's own. */
export function rootIdentities(env: NodeJS.ProcessEnv, root: string): Partial<Record<Cloud, string>> {
  return rootIdentity(jobDeclaration(env), root, "plan");
}

/**
 * `env` for one root's binary. A re-plan, which holds no OIDC token, hands
 * each root the credentials its trade step left (chant's targetCloudEnv over
 * the CLOUD_TARGETS_ENV file). Otherwise, for each cloud whose variable
 * names a glob the root matches, that identity: AWS `AWS_ROLE_ARN`, assumed
 * with the job's token file (static keys in the job's environment would win
 * over the role in the AWS SDKs, so they are dropped for that root); GCP
 * GOOGLE_APPLICATION_CREDENTIALS, gcpCredentials' copy of the job's file.
 * Azure, which a re-plan does not trade: `ARM_CLIENT_ID`, the client the
 * job's token is traded for.
 */
export function rootRoleEnv(env: NodeJS.ProcessEnv, root: string): NodeJS.ProcessEnv {
  const ids = rootIdentities(env, root);
  let out: NodeJS.ProcessEnv = env;
  if (env[CLOUD_TARGETS_ENV]) {
    out = targetCloudEnv(env, root) as NodeJS.ProcessEnv;
    // A root with a token of its own reads it, never the job's credentials file, which the trade deleted.
    if (out.GOOGLE_OAUTH_ACCESS_TOKEN !== env.GOOGLE_OAUTH_ACCESS_TOKEN) delete out.GOOGLE_APPLICATION_CREDENTIALS;
  } else {
    if (ids.aws) {
      const { AWS_ACCESS_KEY_ID: _a, AWS_SECRET_ACCESS_KEY: _s, AWS_SESSION_TOKEN: _t, ...rest } = out;
      out = { ...rest, AWS_ROLE_ARN: ids.aws };
    }
    if (ids.gcp) out = { ...out, GOOGLE_APPLICATION_CREDENTIALS: gcpCredentials(env, ids.gcp) };
  }
  if (ids.azure) out = { ...out, ARM_CLIENT_ID: ids.azure, ...(env.AZURE_CLIENT_ID ? { AZURE_CLIENT_ID: ids.azure } : {}) };
  return out;
}

/**
 * One identity's credentials, as a re-plan's trade step left them in the
 * CLOUD_TARGETS_ENV file: undefined when the job traded nothing (no file),
 * refused when the file has none for `id`.
 */
export function tradedVars(env: NodeJS.ProcessEnv, cloud: Cloud, id: string): Record<string, string> | undefined {
  const path = env[CLOUD_TARGETS_ENV];
  if (!path) return undefined;
  let vars: Record<string, string> | undefined;
  try {
    vars = readTargetsFile(path).clouds[cloud]?.vars[id];
  } catch (e) {
    throw new StoreError((e as Error).message);
  }
  if (!vars) throw new StoreError(`the re-plan traded no credentials for ${id}`);
  return vars;
}

/** Every identity of `cloud` a re-plan's trade step left credentials for, with them; empty when the job traded nothing. */
export function tradedIdentities(env: NodeJS.ProcessEnv, cloud: Cloud): Record<string, Record<string, string>> {
  const path = env[CLOUD_TARGETS_ENV];
  if (!path) return {};
  try {
    return readTargetsFile(path).clouds[cloud]?.vars ?? {};
  } catch (e) {
    throw new StoreError((e as Error).message);
  }
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

// ── apply groups ───────────────────────────────────────────────────────────

/**
 * One apply job per identity: a wave's roots grouped by the cloud identities
 * they apply with (chant's cloudIdentityGroups), so roots under different
 * identities never share a job's token. The groups are fixed when `init`
 * renders the pipeline, from the config's globs and the roots it found:
 *
 *   environments   each environment with roots is a group, its root globs the
 *                  group's selector, split into a group per identity when its
 *                  roots take more than one; the roots in no environment are
 *                  grouped by identity too, with `default` for those no glob
 *                  gives one
 *   roles by glob  the roots that take the same identities are a group, its
 *                  roots its selector, and the roots no glob matches form
 *                  `default`. One group alone splits nothing, so there are no
 *                  groups then
 *   neither        no groups: every wave applies in one job
 *
 * Each wave then renders a deciding job (plans every root with the plan
 * identities, decides the gate) and one job per group with roots in the wave,
 * each with only its group's identities, runner, forge environment and token
 * audience. The stage hands chant the groups as the wave's job groups
 * (`OpWave.jobs`), each with the wave's roots it holds.
 */
export interface ApplyGroup {
  name: string;
  /**
   * What the stage matches a root against to find its group (`--groups`): an
   * environment's root globs, or a group's roots. Empty for `default`, which
   * holds every root no other group's selector matches.
   */
  selectors: string[];
  /** The repo's roots in the group, sorted. */
  roots: string[];
  /** The environment the group is in, when it is in one. */
  environment?: string;
  /** The identities its apply jobs take: the roles by glob its roots take, and the job's own identity only when a root of the group takes it. */
  oidc?: OidcSettings;
  /** Its apply jobs' runner: the environment's `runner` (its `apply`), when it sets one. */
  runner?: RunnerSpec;
  /** The forge environment its apply jobs run in: the environment's `forge_environment`, else its name. */
  forgeEnvironment?: string;
  /** Its apply jobs' AWS token audience: the environment's `oidc.audience`. */
  audience?: string;
}

/** The environment runner's apply runner: a plain runner, or its `apply`. */
export function environmentApplyRunner(runner: NonNullable<ProjectSettings["environments"]>[string]["runner"]): RunnerSpec | undefined {
  if (runner === undefined) return undefined;
  if (typeof runner === "string" || Array.isArray(runner) || "group" in runner) return runner as RunnerSpec;
  return (runner as { apply?: RunnerSpec }).apply;
}

/**
 * The identities a group's apply jobs take, as `oidc` (the pipeline's, with
 * each environment's pair folded into the roles by glob) names them: per
 * cloud, the globs that are the first match of one of its roots in the
 * declaration's rule that root takes, and the job's own identity only when
 * one of its roots takes the rule with no `targets`. A GCP or Azure group
 * whose every root has its own identity takes the first of them as the
 * job's, since the credential file and the client need one.
 */
export function groupOidc(oidc: OidcSettings | undefined, decl: CloudIdentityDeclaration | undefined, roots: readonly string[]): OidcSettings | undefined {
  if (!oidc) return undefined;
  const taken = (cloud: Cloud, roles: Record<string, RolePair> | undefined): { roles?: Record<string, RolePair>; every: boolean } => {
    const rules = decl?.[cloud]?.rules ?? [];
    const used = new Set<string>();
    let every = rules.length > 0;
    for (const r of roots) {
      const rule = ruleFor(rules, PIPELINE, undefined, r);
      const glob = rule?.targets?.find((g) => targetGlobMatch(g, r));
      if (glob === undefined) every = false;
      else used.add(glob);
    }
    const picked = Object.fromEntries(Object.entries(roles ?? {}).filter(([g]) => used.has(g)));
    return { ...(Object.keys(picked).length > 0 ? { roles: picked } : {}), every };
  };
  const out: OidcSettings = { ...oidc };
  const aws = taken("aws", oidc.roles);
  if (aws.roles) out.roles = aws.roles;
  else delete out.roles;
  if (aws.every) {
    delete out.plan_role;
    delete out.apply_role;
  }
  if (oidc.gcp) {
    const t = taken("gcp", oidc.gcp.roles);
    const { roles: _r, ...gcp } = oidc.gcp;
    out.gcp = { ...gcp, ...(t.roles ? { roles: t.roles } : {}) };
    if (t.roles && t.every) {
      const first = Object.values(t.roles)[0]!;
      out.gcp = { ...out.gcp, plan_service_account: first.plan, apply_service_account: first.apply };
    }
  }
  if (oidc.azure) {
    const t = taken("azure", oidc.azure.roles);
    const { roles: _r, ...azure } = oidc.azure;
    out.azure = { ...azure, ...(t.roles ? { roles: t.roles } : {}) };
    if (t.roles && t.every) {
      const first = Object.values(t.roles)[0]!;
      out.azure = { ...out.azure, plan_client_id: first.plan, apply_client_id: first.apply };
    }
  }
  return out;
}

/**
 * The apply groups of a repo of `roots` under `settings`, or undefined when
 * every wave applies in one job: no root in an environment, and fewer than
 * two identity groups. Groups with no root are left out.
 */
export function applyGroups(settings: Pick<ProjectSettings, "environments" | "oidc">, roots: readonly string[]): ApplyGroup[] | undefined {
  const decl = cloudDeclaration(settings);
  const oidc = withEnvironmentRoles(settings.oidc, settings.environments);
  const sorted = [...roots].sort();
  const groups: ApplyGroup[] = [];
  const identityOf = (mine: string[]): Pick<ApplyGroup, "oidc"> => (oidc ? { oidc: groupOidc(oidc, decl, mine) } : {});
  for (const [name, e] of Object.entries(settings.environments ?? {})) {
    const mine = sorted.filter((r) => environmentOf(r, settings) === name);
    if (mine.length === 0) continue;
    const parts = cloudIdentityGroups(decl, PIPELINE, undefined, mine);
    const runner = environmentApplyRunner(e.runner);
    for (const p of parts) {
      const own = parts.length === 1 || p.name === DEFAULT_IDENTITY_GROUP || p.name === name;
      groups.push({
        name: own ? name : `${name}-${p.name}`,
        selectors: parts.length === 1 ? [...(e.roots ?? [])] : [...p.targets],
        roots: [...p.targets],
        environment: name,
        ...identityOf(p.targets),
        ...(runner !== undefined ? { runner } : {}),
        forgeEnvironment: e.forge_environment ?? name,
        ...(e.oidc?.audience !== undefined ? { audience: e.oidc.audience } : {}),
      });
    }
  }
  const rest = sorted.filter((r) => environmentOf(r, settings) === undefined);
  for (const p of rest.length > 0 ? cloudIdentityGroups(decl, PIPELINE, undefined, rest) : []) {
    const name = p.name === DEFAULT_IDENTITY_GROUP ? DEFAULT_GROUP : p.name;
    groups.push({ name, selectors: name === DEFAULT_GROUP ? [] : [...p.targets], roots: [...p.targets], ...identityOf(p.targets) });
  }
  // Nothing to keep apart: no root in an environment, and the rest take one set of identities.
  if (!groups.some((g) => g.environment !== undefined) && groups.length < 2) return undefined;
  const taken = new Set<string>();
  for (const g of groups) {
    const base = g.name;
    for (let n = 2; taken.has(g.name); n++) g.name = `${base}-${n}`;
    taken.add(g.name);
  }
  return groups;
}

/** The group `root` is in: the first group whose selector it matches, else `default`. */
export function groupOf(root: string, selectors: Record<string, string[]>): string {
  return Object.entries(selectors).find(([, globs]) => globs.some((g) => g === root || targetGlobMatch(g, root)))?.[0] ?? DEFAULT_GROUP;
}

/** `roots` by group, in the order of `selectors` and then `default`, leaving out the groups that hold none. */
export function rootsByGroup(roots: readonly string[], selectors: Record<string, string[]>): { name: string; roots: string[] }[] {
  const out = new Map<string, string[]>([...Object.keys(selectors).map((n): [string, string[]] => [n, []]), [DEFAULT_GROUP, []]]);
  for (const r of roots) out.get(groupOf(r, selectors))!.push(r);
  return [...out].filter(([, rs]) => rs.length > 0).map(([name, rs]) => ({ name, roots: [...rs].sort() }));
}

/** The `--groups` argument: `<group>=<selector>,<selector>;...`, the groups other than `default`. */
export const groupsArg = (groups: readonly ApplyGroup[]): string =>
  groups.filter((g) => g.name !== DEFAULT_GROUP).map((g) => `${g.name}=${g.selectors.join(",")}`).join(";");
