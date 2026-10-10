/**
 * terragucci.yml's `generate` key: its shape, its checks, and how one level
 * of it stacks over another. generate.ts writes the files; this file stays
 * free of the repo readers so the config's own module can import it.
 */

/** One level of settings: the repo's, a directory glob's or a root's. */
export interface GenerateLevel {
  /** One backend type, mapped to its arguments; `null` drops the backend an earlier level set. */
  backend?: Record<string, Record<string, unknown>> | null;
  /** Provider local name (`aws`, or `aws.<alias>` for an aliased configuration) to `source`, `version` and the provider's arguments; `null` drops it. */
  providers?: Record<string, Record<string, unknown> | null>;
  /** The roots' `required_version` constraint; `null` drops it. */
  required_version?: string | null;
  /**
   * Terragrunt units only: `disable_init` in the `remote_state` block
   * terragucci.hcl writes. Default `true`: Terragrunt neither creates nor
   * changes the bucket. `false` lets an apply job bootstrap it. `null` drops
   * a value an earlier level set.
   */
  disable_init?: boolean | null;
}

/** terragucci.yml's `generate` key. */
export interface GenerateSettings extends GenerateLevel {
  /** Root path glob to the settings for the roots it matches, applied in order. */
  dirs?: Record<string, GenerateLevel>;
  /** A root's exact path to its own settings, applied last. */
  roots?: Record<string, GenerateLevel>;
}

export const LEVEL_KEYS = ["backend", "providers", "required_version", "disable_init"] as const;
export const TOP_KEYS = [...LEVEL_KEYS, "dirs", "roots"] as const;
export const IDENT = /^[A-Za-z_][A-Za-z0-9_-]*$/;
export const PROVIDER_KEY = /^[a-z][a-z0-9_-]*(\.[A-Za-z_][A-Za-z0-9_-]*)?$/;

// ── validation ───────────────────────────────────────────────────────────────

export const isMap = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** A value HCL can hold: a string, number, bool, list or map of them. */
function checkValue(v: unknown, where: string, problems: string[]): void {
  if (typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v))) return;
  if (Array.isArray(v)) return v.forEach((x, i) => checkValue(x, `${where}[${i}]`, problems));
  if (isMap(v)) return Object.entries(v).forEach(([k, x]) => checkValue(x, `${where}.${k}`, problems));
  problems.push(`${where} must be a string, number, boolean, list or map`);
}

/** Arguments of a backend or provider: identifiers, each a value; null drops one an earlier level set. */
function checkArguments(args: Record<string, unknown>, where: string, problems: string[]): void {
  for (const [k, v] of Object.entries(args)) {
    if (!IDENT.test(k)) problems.push(`${where}.${k} is not an argument name`);
    else if (v !== null) checkValue(v, `${where}.${k}`, problems);
  }
}

function checkLevel(level: unknown, where: string, problems: string[], top: boolean): void {
  if (!isMap(level)) {
    problems.push(`${where} must be a map (settings: ${(top ? TOP_KEYS : LEVEL_KEYS).join(", ")})`);
    return;
  }
  for (const k of Object.keys(level)) {
    if (!(top ? (TOP_KEYS as readonly string[]) : LEVEL_KEYS).includes(k)) {
      problems.push(`${where}.${k} is not a setting (settings: ${(top ? TOP_KEYS : LEVEL_KEYS).join(", ")})`);
    }
  }
  const b = level.backend;
  if (b !== undefined && b !== null) {
    const types = isMap(b) ? Object.keys(b) : [];
    if (types.length !== 1 || !IDENT.test(types[0]) || !isMap((b as Record<string, unknown>)[types[0]])) {
      problems.push(`${where}.backend must name one backend type and its arguments, such as backend: { s3: { bucket: acme-state } }, or be null`);
    } else checkArguments((b as Record<string, Record<string, unknown>>)[types[0]], `${where}.backend.${types[0]}`, problems);
  }
  const p = level.providers;
  if (p !== undefined) {
    if (!isMap(p)) problems.push(`${where}.providers must map a provider's local name to its settings`);
    else {
      for (const [name, s] of Object.entries(p)) {
        if (!PROVIDER_KEY.test(name)) problems.push(`${where}.providers.${name} is not a provider name; use its local name, such as aws, or aws.<alias> for an aliased configuration`);
        else if (s !== null && !isMap(s)) problems.push(`${where}.providers.${name} must be a map of source, version and the provider's arguments, or null`);
        else if (isMap(s)) {
          if ("alias" in s) problems.push(`${where}.providers.${name}.alias: name an aliased configuration ${name.split(".")[0]}.${String(s.alias)} instead`);
          for (const k of ["source", "version"]) if (s[k] !== undefined && s[k] !== null && typeof s[k] !== "string") problems.push(`${where}.providers.${name}.${k} must be a string`);
          checkArguments(Object.fromEntries(Object.entries(s).filter(([k]) => k !== "source" && k !== "version" && k !== "alias")), `${where}.providers.${name}`, problems);
        }
      }
    }
  }
  const r = level.required_version;
  if (r !== undefined && r !== null && (typeof r !== "string" || r.trim() === "")) problems.push(`${where}.required_version must be a version constraint, such as ">= 1.6", or null`);
  const d = level.disable_init;
  if (d !== undefined && d !== null && typeof d !== "boolean") problems.push(`${where}.disable_init must be true, false or null`);
  if (!top) return;
  for (const k of ["dirs", "roots"] as const) {
    const m = level[k];
    if (m === undefined) continue;
    if (!isMap(m)) {
      problems.push(`${where}.${k} must map ${k === "dirs" ? "a root path glob" : "a root's path"} to settings`);
      continue;
    }
    for (const [key, sub] of Object.entries(m)) checkLevel(sub ?? {}, `${where}.${k}["${key}"]`, problems, false);
  }
}

/** Check a `generate` key. */
export function checkGenerate(v: unknown, where: string, problems: string[]): void {
  if (v === undefined) return;
  checkLevel(v, where, problems, true);
}

// ── merging ──────────────────────────────────────────────────────────────────

/** `over` on `base`, map by map; a null in `over` stays, so a later merge still drops the key. */
export function overlay(base: unknown, over: unknown): unknown {
  if (!isMap(base) || !isMap(over)) return over === undefined ? base : over;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = k in out ? overlay(out[k], v) : v;
  return out;
}

/** One level's settings over another's: the backend's arguments and each provider's merge, a backend of another type replaces. */
export function overlayLevel(base: GenerateLevel, over: GenerateLevel): GenerateLevel {
  const out: GenerateLevel = { ...base };
  if (over.backend !== undefined) {
    const same = base.backend && over.backend && Object.keys(base.backend)[0] === Object.keys(over.backend)[0];
    out.backend = same ? (overlay(base.backend, over.backend) as GenerateLevel["backend"]) : over.backend;
  }
  if (over.providers !== undefined) out.providers = overlay(base.providers ?? {}, over.providers) as GenerateLevel["providers"];
  if (over.required_version !== undefined) out.required_version = over.required_version;
  if (over.disable_init !== undefined) out.disable_init = over.disable_init;
  return out;
}

/** A control repo's `defaults.generate` and a project's own: one `generate` that stacks the same way. */
export function combineGenerate(base: GenerateSettings | undefined, over: GenerateSettings | undefined): GenerateSettings | undefined {
  if (!base || !over) return over ?? base;
  const level = (s: GenerateSettings): GenerateLevel => Object.fromEntries(LEVEL_KEYS.filter((k) => s[k] !== undefined).map((k) => [k, s[k]]));
  const out: GenerateSettings = overlayLevel(level(base), level(over));
  for (const k of ["dirs", "roots"] as const) {
    if (!base[k] && !over[k]) continue;
    const m: Record<string, GenerateLevel> = { ...base[k] };
    for (const [key, s] of Object.entries(over[k] ?? {})) m[key] = m[key] ? overlayLevel(m[key], s ?? {}) : (s ?? {});
    out[k] = m;
  }
  return out;
}
