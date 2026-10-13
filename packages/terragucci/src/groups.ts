/**
 * One apply job per identity: a wave's roots grouped by the cloud identities
 * they apply with, so roots under different roles never share a job's token.
 *
 * The groups are fixed when `init` renders the pipeline, from the config's
 * globs and the roots it found:
 *
 *   environments   each environment with roots is a group, its root globs the
 *                  group's selector; the roots in no environment form the
 *                  group `default`
 *   roles by glob  without environments, with `oidc.roles`, `oidc.gcp.roles`
 *                  or `oidc.azure.roles`: the roots that take the same
 *                  identities (the first glob each cloud's list matches) are
 *                  a group, its roots its selector, and the roots no glob
 *                  matches form `default`. One group alone splits nothing,
 *                  so there are no groups then
 *   neither        no groups: every wave applies in one job, as it always has
 *
 * Each wave then renders a deciding job (plans every root with the plan
 * identities, decides the gate) and one job per group with roots in the wave,
 * each with only its group's identities, runner, forge environment and token
 * audience. The stage hands chant the groups as the wave's job groups
 * (`OpWave.jobs`), each with the wave's roots it holds.
 */
import { globMatch } from "./detect";
import { SHARED_SUBJECT_TIP } from "./tips";
import { environmentOf, withEnvironmentRoles } from "./environments";
import { DEFAULT_GROUP, reservedGroupName, type ForgeName, type OidcSettings, type ProjectSettings, type RolePair, type RunnerSpec } from "./config";

export { DEFAULT_GROUP, reservedGroupName };

export interface ApplyGroup {
  name: string;
  /**
   * What the stage matches a root against to find its group (`--groups`): an
   * environment's root globs, or an identity group's roots. Empty for
   * `default`, which holds every root no other group's selector matches.
   */
  selectors: string[];
  /** The repo's roots in the group, sorted. */
  roots: string[];
  /** The environment the group is, when it is one. */
  environment?: string;
  /** The identities its apply jobs take: the roles by glob its roots match, and the job's own identity only when a root of the group takes it. */
  oidc?: OidcSettings;
  /** Its apply jobs' runner: the environment's `runner` (its `apply`), when it sets one. */
  runner?: RunnerSpec;
  /** The forge environment its apply jobs run in: the environment's `forge_environment`, else its name. */
  forgeEnvironment?: string;
  /** Its apply jobs' AWS token audience: the environment's `oidc.audience`. */
  audience?: string;
}

/** The first glob of `roles` that `root` matches. */
const firstGlob = (roles: Record<string, RolePair> | undefined, root: string): string | undefined => (roles ? Object.keys(roles).find((g) => globMatch(g, root)) : undefined);

/** The environment runner's apply runner: a plain runner, or its `apply`. */
export function environmentApplyRunner(runner: NonNullable<ProjectSettings["environments"]>[string]["runner"]): RunnerSpec | undefined {
  if (runner === undefined) return undefined;
  if (typeof runner === "string" || Array.isArray(runner) || "group" in runner) return runner as RunnerSpec;
  return (runner as { apply?: RunnerSpec }).apply;
}

/**
 * The identities a group's apply jobs take, from the pipeline's (`oidc`,
 * with each environment's pair folded into the roles by glob): the roles by
 * glob that are the first match of one of its roots, and the job's own
 * identity only when one of its roots matches no glob of that cloud. A GCP
 * or Azure group whose every root has its own identity takes the first of
 * them as the job's, since the credential file and the client need one.
 */
export function groupOidc(oidc: OidcSettings | undefined, roots: readonly string[]): OidcSettings | undefined {
  if (!oidc) return undefined;
  const pick = (roles: Record<string, RolePair> | undefined): Record<string, RolePair> | undefined => {
    if (!roles) return undefined;
    const used = new Set(roots.map((r) => firstGlob(roles, r)).filter((g): g is string => g !== undefined));
    const out = Object.fromEntries(Object.entries(roles).filter(([g]) => used.has(g)));
    return Object.keys(out).length > 0 ? out : undefined;
  };
  const every = (roles: Record<string, RolePair> | undefined): boolean => roles !== undefined && roots.every((r) => firstGlob(roles, r) !== undefined);
  const out: OidcSettings = { ...oidc };
  const roles = pick(oidc.roles);
  if (roles) out.roles = roles;
  else delete out.roles;
  if (every(oidc.roles)) {
    delete out.plan_role;
    delete out.apply_role;
  }
  if (oidc.gcp) {
    const r = pick(oidc.gcp.roles);
    const { roles: _r, ...gcp } = oidc.gcp;
    out.gcp = { ...gcp, ...(r ? { roles: r } : {}) };
    if (r && every(oidc.gcp.roles)) {
      const first = Object.values(r)[0]!;
      out.gcp = { ...out.gcp, plan_service_account: first.plan, apply_service_account: first.apply };
    }
  }
  if (oidc.azure) {
    const r = pick(oidc.azure.roles);
    const { roles: _r, ...azure } = oidc.azure;
    out.azure = { ...azure, ...(r ? { roles: r } : {}) };
    if (r && every(oidc.azure.roles)) {
      const first = Object.values(r)[0]!;
      out.azure = { ...out.azure, plan_client_id: first.plan, apply_client_id: first.apply };
    }
  }
  return out;
}

/** A job-name-safe group name from a glob: `envs/prod/**` is `envs-prod`. */
function nameFrom(glob: string): string {
  return glob.toLowerCase().replace(/\*+/g, "").replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
}

/**
 * The apply groups of a repo of `roots` under `settings`, or undefined when
 * every wave applies in one job (no environments, and fewer than two
 * identity sets by glob). Groups with no root are left out.
 */
export function applyGroups(settings: Pick<ProjectSettings, "environments" | "oidc">, roots: readonly string[]): ApplyGroup[] | undefined {
  const oidc = withEnvironmentRoles(settings.oidc, settings.environments);
  const sorted = [...roots].sort();
  const groups: ApplyGroup[] = [];
  const rest = (left: string[]): void => {
    if (left.length > 0) groups.push({ name: DEFAULT_GROUP, selectors: [], roots: left, ...(oidc ? { oidc: groupOidc(oidc, left) } : {}) });
  };
  if (settings.environments && Object.keys(settings.environments).length > 0) {
    for (const [name, e] of Object.entries(settings.environments)) {
      const mine = sorted.filter((r) => environmentOf(r, settings) === name);
      if (mine.length === 0) continue;
      const runner = environmentApplyRunner(e.runner);
      groups.push({
        name,
        selectors: [...(e.roots ?? [])],
        roots: mine,
        environment: name,
        ...(oidc ? { oidc: groupOidc(oidc, mine) } : {}),
        ...(runner !== undefined ? { runner } : {}),
        forgeEnvironment: e.forge_environment ?? name,
        ...(e.oidc?.audience !== undefined ? { audience: e.oidc.audience } : {}),
      });
    }
    rest(sorted.filter((r) => environmentOf(r, settings) === undefined));
    // No root in any environment: nothing to keep apart.
    return groups.some((g) => g.environment !== undefined) ? groups : undefined;
  }
  if (!oidc || !(oidc.roles || oidc.gcp?.roles || oidc.azure?.roles)) return undefined;
  // Each root's identities: the first glob of each cloud's list it matches.
  const byKey = new Map<string, { globs: (string | undefined)[]; roots: string[] }>();
  const left: string[] = [];
  for (const r of sorted) {
    const globs = [firstGlob(oidc.roles, r), firstGlob(oidc.gcp?.roles, r), firstGlob(oidc.azure?.roles, r)];
    if (globs.every((g) => g === undefined)) {
      left.push(r);
      continue;
    }
    const key = JSON.stringify(globs);
    const at = byKey.get(key) ?? { globs, roots: [] };
    at.roots.push(r);
    byKey.set(key, at);
  }
  if (byKey.size + (left.length > 0 ? 1 : 0) < 2) return undefined;
  const taken = new Set<string>();
  for (const { globs, roots: mine } of byKey.values()) {
    let base = nameFrom(globs.find((g) => g !== undefined)!) || "group";
    if (reservedGroupName(base)) base = `${base}-roots`;
    let name = base;
    for (let n = 2; taken.has(name); n++) name = `${base}-${n}`;
    taken.add(name);
    groups.push({ name, selectors: mine, roots: mine, oidc: groupOidc(oidc, mine) });
  }
  rest(left);
  return groups;
}

export { SHARED_SUBJECT_TIP };

/** `a`, `a and b`, `a, b and c`. */
const listed = (names: readonly string[]): string => (names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`);

/**
 * config check's tip when the groups' apply jobs carry the same OIDC token
 * subject, so a role's trust cannot tell one group's jobs from another's:
 * identity groups from roles by glob, which run in no forge environment;
 * environments on Forgejo, which has none, so every apply job of one ref
 * carries one subject; and on GitHub and GitLab, environments that name the
 * same forge_environment. Undefined otherwise, and with fewer than two groups.
 */
export function sharedSubjectTip(groups: readonly ApplyGroup[] | undefined, forge: ForgeName | undefined): string | undefined {
  if (!groups || groups.length < 2) return undefined;
  const environments = groups.some((g) => g.environment !== undefined);
  if (environments && forge !== "forgejo") {
    // Environments that name one forge environment: one subject on GitHub, one environment claim on GitLab.
    const byForgeEnvironment = new Map<string, string[]>();
    for (const g of groups) if (g.environment !== undefined && g.forgeEnvironment !== undefined) byForgeEnvironment.set(g.forgeEnvironment, [...(byForgeEnvironment.get(g.forgeEnvironment) ?? []), g.name]);
    const shared = [...byForgeEnvironment].filter(([, names]) => names.length > 1);
    if (shared.length === 0) return undefined;
    return shared
      .map(([fe, names]) => `the apply jobs of the environments ${listed(names)} run in the same forge environment ${fe}, so their tokens carry the same environment and a role's trust cannot tell one environment's jobs from another's; give each environment a forge_environment of its own`)
      .join("; ");
  }
  const which = `the apply jobs of the groups ${listed(groups.map((g) => g.name))} carry the same OIDC token subject, so a role's trust cannot tell one group's jobs from another's`;
  if (forge === "forgejo") return `${which}; they apply from the same ref, and Forgejo has no deployment environments, so its token names the ref alone: keep the groups' roles apart with a repo or a protected branch each`;
  return `${which}; on GitHub or GitLab, name each group's roots in environments, each with a forge_environment, and have each apply role trust its environment alone`;
}

/** The group `root` is in: the first group whose selector it matches, else `default`. */
export function groupOf(root: string, selectors: Record<string, string[]>): string {
  return Object.entries(selectors).find(([, globs]) => globs.some((g) => g === root || globMatch(g, root)))?.[0] ?? DEFAULT_GROUP;
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

