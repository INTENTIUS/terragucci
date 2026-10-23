/**
 * Named environments (`environments:` in terragucci.yml): which environment
 * a root is in, and the settings it takes from there.
 *
 * An environment names its roots by glob; a root matches at most one, which
 * config check holds (environmentRootProblems). Each key an environment sets
 * replaces the top-level value for its roots, and a root in no environment
 * takes the top-level values.
 *
 * What reaches a root today:
 *
 *   oidc         each environment's pair joins `oidc.roles`, `oidc.gcp.roles`
 *                and `oidc.azure.roles` by its root globs (withEnvironmentRoles),
 *                so the pipeline carries it in ROOT_ROLES_ENV and its kin, as
 *                it carries any glob's pair
 *   gate         read at base by the wave's job: a wave takes the strictest
 *                gate of its roots (waveGate), where a root in no environment
 *                takes the stricter of --gate and the top-level gate at base
 *   parallelism  read by the stage: a layer plans as many roots at once as the
 *                fewest any of its roots' environments allows (../report/stage.ts)
 *   runner, forge_environment, oidc.audience
 *                each environment's roots apply in jobs of their own
 *                (./cloud-identity.ts), which init renders on the environment's apply
 *                runner, in its forge environment and with its audience
 *
 * With no `environments`, every function here gives back what it was given,
 * so the pipelines init renders are the same byte for byte.
 */
import { globMatch } from "./detect";
import { normalizeGate, type EnvironmentSettings, type Gate, type OidcSettings, type ProjectSettings, type RolePair, type RunnerSettings } from "./config";

type WithEnvironments = Pick<ProjectSettings, "environments">;

/** The environment `root` is in: the first, in the config's order, with a glob it matches. Undefined when it is in none. */
export function environmentOf(root: string, settings: WithEnvironments): string | undefined {
  for (const [name, e] of Object.entries(settings.environments ?? {})) {
    if ((e.roots ?? []).some((g) => globMatch(g, root))) return name;
  }
  return undefined;
}

/** What one root runs with: its environment's value of each key, else the top-level one. */
export interface RootSettings {
  /** The root's environment. Absent when it is in none. */
  environment?: string;
  gate: Gate;
  oidc?: OidcSettings;
  runner?: RunnerSettings | EnvironmentSettings["runner"];
  parallelism?: number;
  /** The forge environment its apply runs in: the environment's `forge_environment`, else its name. Absent for a root in no environment. */
  forge_environment?: string;
}

/** The default gate, as BUILT_IN gives it. */
const DEFAULT_GATE: Gate = "on-destructive";

/** The top-level gate `settings` set, under its current name; on-destructive when it sets none. */
export function topGate(settings: Pick<ProjectSettings, "gate">): Gate {
  return normalizeGate(settings.gate) ?? DEFAULT_GATE;
}

/** The settings `root` runs with: its environment's gate, identities, runner and parallelism over the top-level ones. */
export function settingsForRoot(root: string, settings: ProjectSettings): RootSettings {
  const name = environmentOf(root, settings);
  const top: RootSettings = {
    gate: topGate(settings),
    ...(settings.oidc ? { oidc: settings.oidc } : {}),
    ...(settings.runner !== undefined ? { runner: settings.runner } : {}),
    ...(settings.parallelism !== undefined ? { parallelism: settings.parallelism } : {}),
  };
  if (name === undefined) return top;
  const e = settings.environments![name]!;
  const oidc = environmentOidc(settings.oidc, e);
  return {
    ...top,
    environment: name,
    ...(e.gate !== undefined ? { gate: normalizeGate(e.gate) ?? top.gate } : {}),
    ...(oidc ? { oidc } : {}),
    ...(e.runner !== undefined ? { runner: e.runner } : {}),
    ...(e.parallelism !== undefined ? { parallelism: e.parallelism } : {}),
    forge_environment: e.forge_environment ?? name,
  };
}

/** The identities a root of environment `e` takes: the environment's pair of each cloud over the project's. */
function environmentOidc(top: OidcSettings | undefined, e: EnvironmentSettings): OidcSettings | undefined {
  const o = e.oidc;
  if (!o) return top;
  const out: OidcSettings = { ...(top ?? {}) };
  if (o.plan_role && o.apply_role) Object.assign(out, { plan_role: o.plan_role, apply_role: o.apply_role });
  if (o.gcp && top?.gcp) out.gcp = { ...top.gcp, ...o.gcp };
  if (o.azure && top?.azure) out.azure = { ...top.azure, ...o.azure };
  return out;
}

/**
 * Gate policies from the most permissive to the strictest. A wave whose
 * roots are in environments with different gates takes the strictest of
 * them: `never` < `on-destructive` < `always`. A wave is approved, or not,
 * as one set digest, so the one gate it has must hold for each root in it:
 * a prod root with `always` beside a dev root with `never` makes the wave
 * wait, as it would if prod's roots were the wave alone.
 */
export const GATE_ORDER: Record<Gate, number> = { never: 0, "on-destructive": 1, always: 2 };

/** The strictest of `gates`, by GATE_ORDER; `fallback` when there are none. */
export function strictestGate(gates: Iterable<Gate>, fallback: Gate = DEFAULT_GATE): Gate {
  let out: Gate | undefined;
  for (const g of gates) if (out === undefined || GATE_ORDER[g] > GATE_ORDER[out]) out = g;
  return out ?? fallback;
}

/**
 * The gate of a wave of `roots`: the strictest of each root's, where a root
 * in no environment, or in one that sets no gate, takes `fallback` (the
 * pipeline's `--gate`, which init renders from the top-level `gate`). With
 * no `environments`, `fallback`.
 */
export function waveGate(roots: readonly string[], settings: WithEnvironments, fallback: Gate): Gate {
  if (!settings.environments || roots.length === 0) return fallback;
  return strictestGate(roots.map((r) => {
    const name = environmentOf(r, settings);
    const g = name === undefined ? undefined : settings.environments![name]!.gate;
    return (g !== undefined ? normalizeGate(g) : undefined) ?? fallback;
  }), fallback);
}

/**
 * The gate of a wave whose roots are not known when its gate is set: a
 * Terragrunt repo's waves, which find their units at plan time. The
 * strictest of `fallback` and every environment's gate.
 */
export function anyRootGate(settings: WithEnvironments, fallback: Gate): Gate {
  const gates = Object.values(settings.environments ?? {}).map((e) => (e.gate !== undefined ? normalizeGate(e.gate) : undefined)).filter((g): g is Gate => g !== undefined);
  return strictestGate([fallback, ...gates], fallback);
}

/** Every environment's gate that is set, for the pipeline's ledger and push rights: a wave that may wait needs them. */
export function environmentGates(settings: WithEnvironments): Gate[] {
  return Object.values(settings.environments ?? {}).map((e) => (e.gate !== undefined ? normalizeGate(e.gate) : undefined)).filter((g): g is Gate => g !== undefined);
}

/** `roles` with `pair` for each of `globs` it does not name already: an explicit glob-keyed pair stays first, and config check refuses the same glob in both. */
function addRoles(roles: Record<string, RolePair> | undefined, globs: readonly string[], pair: RolePair): Record<string, RolePair> {
  const out: Record<string, RolePair> = { ...(roles ?? {}) };
  for (const g of globs) if (!(g in out)) out[g] = pair;
  return out;
}

/**
 * `oidc` with each environment's identities as roles by its root globs,
 * after the roles `oidc.roles`, `oidc.gcp.roles` and `oidc.azure.roles`
 * list: an environment's AWS pair under `roles`, its GCP pair under
 * `gcp.roles` and its Azure pair under `azure.roles`. The pipeline then
 * carries them as it carries any glob's pair, so a root of the environment
 * plans and applies with them. A GCP or Azure pair needs the project's
 * `oidc.gcp` or `oidc.azure`, which config check holds. `oidc` itself when no
 * environment sets one.
 */
export function withEnvironmentRoles(oidc: OidcSettings | undefined, environments: ProjectSettings["environments"]): OidcSettings | undefined {
  const named = Object.values(environments ?? {}).filter((e) => e.oidc && (e.oidc.plan_role || e.oidc.gcp || e.oidc.azure));
  if (named.length === 0) return oidc;
  const out: OidcSettings = { ...(oidc ?? {}) };
  for (const e of named) {
    const o = e.oidc!;
    const globs = e.roots ?? [];
    if (o.plan_role && o.apply_role) out.roles = addRoles(out.roles, globs, { plan: o.plan_role, apply: o.apply_role });
    if (o.gcp && out.gcp) out.gcp = { ...out.gcp, roles: addRoles(out.gcp.roles, globs, { plan: o.gcp.plan_service_account, apply: o.gcp.apply_service_account }) };
    if (o.azure && out.azure) out.azure = { ...out.azure, roles: addRoles(out.azure.roles, globs, { plan: o.azure.plan_client_id, apply: o.azure.apply_client_id }) };
  }
  return out;
}

/** `settings` with the environments' identities folded into `oidc` (withEnvironmentRoles); `settings` itself when no environment sets one. */
export function withEnvironmentOidc<S extends ProjectSettings>(settings: S): S {
  const oidc = withEnvironmentRoles(settings.oidc, settings.environments);
  return oidc === settings.oidc ? settings : { ...settings, oidc };
}

/**
 * The problems config check finds with the repo's roots: a root two
 * environments' globs match, naming both and the root, and a root whose
 * identities both its environment and a glob-keyed setting
 * (`oidc.roles`, `oidc.gcp.roles`, `oidc.azure.roles`) give, naming the root.
 */
export function environmentRootProblems(roots: readonly string[], settings: ProjectSettings, where = "config"): string[] {
  const envs = Object.entries(settings.environments ?? {});
  if (envs.length === 0) return [];
  const out: string[] = [];
  const keyed: [string, "plan_role" | "gcp" | "azure", Record<string, RolePair> | undefined][] = [
    ["oidc.roles", "plan_role", settings.oidc?.roles],
    ["oidc.gcp.roles", "gcp", settings.oidc?.gcp?.roles],
    ["oidc.azure.roles", "azure", settings.oidc?.azure?.roles],
  ];
  for (const root of roots) {
    const in_ = envs.filter(([, e]) => (e.roots ?? []).some((g) => globMatch(g, root))).map(([name]) => name);
    if (in_.length > 1) out.push(`${where}.environments: ${root} is a root of ${in_.join(" and ")}; a root belongs to one environment, so narrow their roots globs`);
    const name = in_[0];
    if (name === undefined) continue;
    const o = settings.environments![name]!.oidc;
    if (!o) continue;
    for (const [key, cloud, roles] of keyed) {
      if (o[cloud] === undefined || !roles) continue;
      const glob = Object.keys(roles).find((g) => globMatch(g, root));
      if (glob !== undefined) out.push(`${where}.environments.${name}.oidc: ${root} takes identities from both environments.${name}.oidc and ${key} (${glob}); set them in one place`);
    }
  }
  return out;
}

/** Each root's environment, for the report: only the roots in one. Undefined with no `environments`. */
export function rootEnvironments(roots: readonly string[], settings: WithEnvironments): Map<string, string> | undefined {
  if (!settings.environments) return undefined;
  const out = new Map<string, string>();
  for (const r of roots) {
    const name = environmentOf(r, settings);
    if (name !== undefined) out.set(r, name);
  }
  return out;
}
