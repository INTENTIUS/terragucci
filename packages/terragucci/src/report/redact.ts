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

/**
 * Every top-level key `show -json` prints, from OpenTofu, Terraform and choudoufu, and what
 * redaction does with it. `values` keys carry values and are walked; `plain` keys carry only
 * paths, flags, versions or addresses. A key a binary emits that is in neither list is a new
 * key: test/report.test.ts holds a fixture with every key here, so adding one means adding a
 * fixture line and a row.
 */
export const PLAN_KEYS = {
  values: ["variables", "planned_values", "resource_changes", "resource_drift", "deferred_changes", "action_invocations", "output_changes", "prior_state", "configuration"],
  plain: ["format_version", "terraform_version", "relevant_attributes", "checks", "applyable", "complete", "errored", "timestamp"],
} as const;

/**
 * The plan with every sensitive value replaced, and how many there were. The input is not changed.
 * A value the plan marks is replaced where it is marked, and then wherever else it appears: the
 * binary does not mark every copy, such as terraform_data's `output`, which repeats its sensitive
 * `input` unmarked in the state and in a change's `before`.
 */
export function redactPlan(plan: unknown): Redacted {
  const marked = redactMarked(plan);
  const secrets = coveredStrings(plan, marked.plan);
  if (secrets.length === 0) return marked;
  const count = { n: marked.values };
  return { plan: scrub(marked.plan, secrets, count), values: count.n };
}

/** The strings a plan marks sensitive anywhere, longest first: what {@link redactPlan} replaces wherever it appears. */
export function sensitiveStrings(plan: unknown): string[] {
  return coveredStrings(plan, redactMarked(plan).plan);
}

/** `value` with every string that is one of `secrets` replaced, and every secret of eight characters and more cut out of the strings that hold it. */
export function scrubSecrets<T>(value: T, secrets: readonly string[]): T {
  return secrets.length === 0 ? value : (scrub(value, secrets, { n: 0 }) as T);
}

/** The string leaves of `raw` at each place `safe` holds REDACTED, longest first. */
function coveredStrings(raw: unknown, safe: unknown): string[] {
  const out = new Set<string>();
  const leaves = (v: unknown): void => {
    if (typeof v === "string") {
      if (v !== "" && v !== REDACTED) out.add(v);
    } else if (Array.isArray(v)) v.forEach(leaves);
    else if (isObject(v)) Object.values(v).forEach(leaves);
  };
  const walk = (r: unknown, s: unknown): void => {
    if (s === REDACTED && r !== REDACTED) leaves(r);
    else if (Array.isArray(r) && Array.isArray(s)) r.forEach((v, i) => walk(v, s[i]));
    else if (isObject(r) && isObject(s)) for (const k of Object.keys(r)) walk(r[k], s[k]);
  };
  walk(raw, safe);
  return [...out].sort((a, b) => b.length - a.length);
}

function scrub(value: unknown, secrets: readonly string[], count: { n: number }): unknown {
  if (typeof value === "string") {
    if (value === REDACTED) return value;
    if (secrets.includes(value)) {
      count.n++;
      return REDACTED;
    }
    let out = value;
    for (const s of secrets) {
      if (s.length >= 8 && out.includes(s)) {
        count.n++;
        out = out.split(s).join(REDACTED);
      }
    }
    return out;
  }
  if (Array.isArray(value)) return value.map((v) => scrub(v, secrets, count));
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v, secrets, count)]));
  return value;
}

/** The plan with every value it marks sensitive replaced where it is marked. */
function redactMarked(plan: unknown): Redacted {
  if (!isObject(plan)) return { plan, values: 0 };
  const count = { n: 0 };
  const out: Json = { ...plan };
  for (const key of ["resource_changes", "resource_drift"]) {
    const list = plan[key];
    if (Array.isArray(list)) out[key] = list.map((r) => (isObject(r) ? { ...r, change: coverChange(r.change, count) } : r));
  }
  // Terraform's deferred changes hold a resource change each, with the reason it was deferred.
  if (Array.isArray(plan.deferred_changes)) {
    out.deferred_changes = plan.deferred_changes.map((d) =>
      isObject(d) && isObject(d.resource_change) ? { ...d, resource_change: { ...d.resource_change, change: coverChange(d.resource_change.change, count) } } : d,
    );
  }
  // Terraform 1.14's action invocations carry the action's configuration, with its own sensitive mask.
  if (Array.isArray(plan.action_invocations)) {
    out.action_invocations = plan.action_invocations.map((a) =>
      isObject(a) && "config_values" in a ? { ...a, config_values: cover(a.config_values, a.config_sensitive, count) } : a,
    );
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
