/**
 * The values a plan left unknown, read back from the state after the apply.
 *
 * A plan marks an attribute `unknown` when its value exists only once the
 * resource is created. After an apply, `show -json` of the state holds it.
 * {@link resolveUnknowns} turns each such attribute of an apply report's
 * change into `{ path, after }` with no `unknown`, so the report states the
 * value once. A sensitive value is never written: it stays `{ path,
 * sensitive: true }`, as a plan records it. Pure.
 */
import type { ChangeSetAttribute } from "@intentius/chant/change-set";

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => v !== null && typeof v === "object" && !Array.isArray(v);

/** Whether a sensitivity map marks anything under it `true`. */
function marks(v: unknown): boolean {
  if (v === true) return true;
  if (Array.isArray(v)) return v.some(marks);
  if (isObject(v)) return Object.values(v).some(marks);
  return false;
}

interface StateResource {
  values: Json;
  sensitive: Json;
}

/** Every resource of a state's `show -json`, by address. A resource without an address, and a deposed object, are left out. */
function resourcesOf(state: unknown): Map<string, StateResource> {
  const out = new Map<string, StateResource>();
  const walk = (mod: unknown): void => {
    if (!isObject(mod)) return;
    for (const r of Array.isArray(mod.resources) ? mod.resources : []) {
      if (!isObject(r) || typeof r.address !== "string" || r.deposed_key !== undefined) continue;
      out.set(r.address, { values: isObject(r.values) ? r.values : {}, sensitive: isObject(r.sensitive_values) ? r.sensitive_values : {} });
    }
    for (const c of Array.isArray(mod.child_modules) ? mod.child_modules : []) walk(c);
  };
  const values = isObject(state) && isObject(state.values) ? state.values : {};
  walk(values.root_module);
  return out;
}

/**
 * `attributes` of the change at `address`, each unknown one given the value
 * the state holds. One the state does not hold (the resource, or the
 * attribute) stays unknown. `state` is `show -json` of the root's state.
 */
export function resolveUnknowns(attributes: ChangeSetAttribute[], address: string, state: unknown): ChangeSetAttribute[] {
  if (!attributes.some((a) => a.unknown)) return attributes;
  const res = resourcesOf(state).get(address);
  if (!res) return attributes;
  return attributes.map((a) => {
    if (!a.unknown) return a;
    const { unknown: _u, before: _b, after: _a, ...rest } = a;
    if (a.sensitive || marks(res.sensitive[a.path])) return { ...rest, sensitive: true as const };
    const value = res.values[a.path];
    if (value === undefined) return a;
    return { ...rest, ...(a.before !== undefined ? { before: a.before } : {}), after: value };
  });
}

/** The string leaves a state marks sensitive, longest first: what a report must not carry wherever a value repeats one. */
export function stateSecrets(state: unknown): string[] {
  const out = new Set<string>();
  const leaves = (v: unknown): void => {
    if (typeof v === "string") {
      if (v !== "") out.add(v);
    } else if (Array.isArray(v)) v.forEach(leaves);
    else if (isObject(v)) Object.values(v).forEach(leaves);
  };
  const walk = (value: unknown, mark: unknown): void => {
    if (mark === true) leaves(value);
    else if (Array.isArray(mark) && Array.isArray(value)) value.forEach((v, i) => walk(v, mark[i]));
    else if (isObject(mark) && isObject(value)) for (const k of Object.keys(mark)) walk(value[k], mark[k]);
  };
  const values = isObject(state) && isObject(state.values) ? state.values : {};
  const mods = (mod: unknown): void => {
    if (!isObject(mod)) return;
    for (const r of Array.isArray(mod.resources) ? mod.resources : []) if (isObject(r)) walk(r.values, r.sensitive_values);
    for (const c of Array.isArray(mod.child_modules) ? mod.child_modules : []) mods(c);
  };
  mods(values.root_module);
  if (isObject(values.outputs)) for (const o of Object.values(values.outputs)) if (isObject(o) && o.sensitive === true) leaves(o.value);
  return [...out].sort((a, b) => b.length - a.length);
}
