/**
 * What a choudoufu root's per-resource records hold.
 *
 * choudoufu keeps one record per resource instead of a state file, and from
 * 0.24.0 writes each one when that resource's apply returns, so a failed or
 * killed apply leaves a record for every resource it finished. A plan's
 * `prior_state` (`show -json`) is those records as the plan read them.
 */

/** The addresses of the managed resource instances a plan read from its root's records. Data sources are not records. */
export function recordedAddresses(plan: unknown): Set<string> {
  const out = new Set<string>();
  const walk = (mod: unknown): void => {
    if (!mod || typeof mod !== "object") return;
    const m = mod as { resources?: unknown; child_modules?: unknown };
    for (const r of Array.isArray(m.resources) ? m.resources : []) {
      const x = r as { address?: unknown; mode?: unknown };
      if (typeof x?.address === "string" && x.mode !== "data") out.add(x.address);
    }
    for (const c of Array.isArray(m.child_modules) ? m.child_modules : []) walk(c);
  };
  walk((plan as { prior_state?: { values?: { root_module?: unknown } } } | undefined)?.prior_state?.values?.root_module);
  return out;
}
