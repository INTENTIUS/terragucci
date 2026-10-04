/**
 * `show -json` prints sensitive values in plain text. Before a plan is
 * stored beside a report, every value the plan marks sensitive is replaced
 * with {@link REDACTED}. Plan digests are computed on the plan as the binary
 * wrote it, before this runs, so an approval still binds the real plan.
 */
import { REDACTED } from "./schema";

type Json = Record<string, unknown>;
export const isObject = (v: unknown): v is Json => v !== null && typeof v === "object" && !Array.isArray(v);

export interface Redacted {
  plan: unknown;
  /** How many values were replaced. */
  values: number;
}

/** Replace what `mark` marks `true` in `value`. `mark` mirrors the value's shape, as `*_sensitive` does. */
function cover(value: unknown, mark: unknown, count: { n: number }): unknown {
  if (value === undefined) return value;
  if (mark === true) {
    if (value === null) return null;
    count.n++;
    return REDACTED;
  }
  if (Array.isArray(mark) && Array.isArray(value)) return value.map((v, i) => cover(v, mark[i], count));
  if (isObject(mark) && isObject(value)) {
    const out: Json = { ...value };
    for (const k of Object.keys(mark)) if (k in out) out[k] = cover(out[k], mark[k], count);
    return out;
  }
  return value;
}

function coverChange(change: unknown, count: { n: number }): unknown {
  if (!isObject(change)) return change;
  return {
    ...change,
    ...("before" in change ? { before: cover(change.before, change.before_sensitive, count) } : {}),
    ...("after" in change ? { after: cover(change.after, change.after_sensitive, count) } : {}),
  };
}

function coverModule(mod: unknown, count: { n: number }): unknown {
  if (!isObject(mod)) return mod;
  const out: Json = { ...mod };
  if (Array.isArray(mod.resources)) {
    out.resources = mod.resources.map((r) => (isObject(r) ? { ...r, values: cover(r.values, r.sensitive_values, count) } : r));
  }
  if (Array.isArray(mod.child_modules)) out.child_modules = mod.child_modules.map((m) => coverModule(m, count));
  return out;
}

function coverValues(values: unknown, count: { n: number }): unknown {
  if (!isObject(values)) return values;
  const out: Json = { ...values };
  if (isObject(values.outputs)) {
    out.outputs = Object.fromEntries(
      Object.entries(values.outputs).map(([k, o]) => [k, isObject(o) && o.sensitive === true ? { ...o, value: cover(o.value, true, count) } : o]),
    );
  }
  if ("root_module" in values) out.root_module = coverModule(values.root_module, count);
  return out;
}

/** The plan with every sensitive value replaced, and how many there were. The input is not changed. */
export function redactPlan(plan: unknown): Redacted {
  if (!isObject(plan)) return { plan, values: 0 };
  const count = { n: 0 };
  const out: Json = { ...plan };
  for (const key of ["resource_changes", "resource_drift"]) {
    const list = plan[key];
    if (Array.isArray(list)) out[key] = list.map((r) => (isObject(r) ? { ...r, change: coverChange(r.change, count) } : r));
  }
  if (isObject(plan.output_changes)) {
    out.output_changes = Object.fromEntries(Object.entries(plan.output_changes).map(([k, c]) => [k, coverChange(c, count)]));
  }
  for (const key of ["planned_values", "prior_state"]) {
    if (key in plan) out[key] = key === "prior_state" && isObject(plan.prior_state) ? { ...plan.prior_state, values: coverValues(plan.prior_state.values, count) } : coverValues(plan[key], count);
  }
  const config = isObject(plan.configuration) && isObject(plan.configuration.root_module) ? plan.configuration.root_module : {};
  const declared = isObject(config.variables) ? config.variables : {};
  if (isObject(plan.variables)) {
    out.variables = Object.fromEntries(
      Object.entries(plan.variables).map(([k, v]) => {
        const d = declared[k];
        return [k, isObject(d) && d.sensitive === true && isObject(v) ? { ...v, value: cover(v.value, true, count) } : v];
      }),
    );
  }
  if (isObject(plan.configuration)) out.configuration = { ...plan.configuration, root_module: coverDefaults(plan.configuration.root_module, count) };
  return { plan: out, values: count.n };
}

/** A sensitive variable's default, in the root and every module call. */
function coverDefaults(mod: unknown, count: { n: number }): unknown {
  if (!isObject(mod)) return mod;
  const out: Json = { ...mod };
  if (isObject(mod.variables)) {
    out.variables = Object.fromEntries(
      Object.entries(mod.variables).map(([k, v]) => [k, isObject(v) && v.sensitive === true && "default" in v ? { ...v, default: cover(v.default, true, count) } : v]),
    );
  }
  if (isObject(mod.module_calls)) {
    out.module_calls = Object.fromEntries(
      Object.entries(mod.module_calls).map(([k, c]) => [k, isObject(c) ? { ...c, module: coverDefaults(c.module, count) } : c]),
    );
  }
  return out;
}
