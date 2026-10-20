/**
 * Secrets a root keeps in state, and the secrets tips.
 *
 * A plan's `planned_values` hold the state the apply leaves, and each
 * resource's `sensitive_values` mark which of its attributes are sensitive.
 * An attribute marked sensitive whose value is set is a secret in state:
 * every identity that can read the state can read it.
 *
 * Some could stay out of state. The provider schema
 * (`providers schema -json`) says which:
 *
 *   - a managed resource's attribute `<name>` whose resource has a write-only
 *     argument `<name>_wo`: a write-only argument reaches the provider and is
 *     never stored;
 *   - a data source whose type is also an ephemeral resource of the same
 *     provider: an ephemeral resource is read each run and never stored.
 *
 * Only on a binary that has them: write-only arguments from OpenTofu 1.11 and
 * Terraform 1.11, ephemeral resources from OpenTofu 1.11 and Terraform 1.10,
 * and both on every choudoufu release, which is built on OpenTofu 1.13.
 *
 * Only names are read here: an address, an attribute and a type. No value
 * leaves the plan.
 *
 * choudoufu keeps an estate in its record store, and a `live` block's
 * `strict { secrets = "refuse" }` keeps sensitive arguments out of the
 * records and refuses resource types that generate secrets. The default,
 * "store", records them as a state file would.
 */
import { join } from "node:path";
import { recordStoreOf } from "../cdf-records";
import { blockBody, estateOf, liveBody } from "../detect";
import { isObject } from "../report/redact";

/** One secret in a root's state: the resource, the attribute, and what could keep it out. */
export interface StoredSecret {
  /** The resource's address without an instance key, such as `aws_db_instance.main` or `data.aws_secretsmanager_secret_version.db`. */
  address: string;
  mode: "managed" | "data";
  type: string;
  provider: string;
  /** The top-level attribute that holds the sensitive value. */
  attribute: string;
  /** How many instances of the resource hold it. */
  instances: number;
  /** The write-only argument (`password_wo`) or the ephemeral resource type that keeps it out of state. Absent when the binary or the provider has none. */
  counterpart?: { kind: "write-only"; argument: string; version?: string } | { kind: "ephemeral"; type: string };
}

/** What keeps a value out of state on a binary. */
export interface OutOfState {
  writeOnly: boolean;
  ephemeral: boolean;
}

const atLeast = (version: string | undefined, major: number, minor: number): boolean => {
  const m = version?.match(/^v?(\d+)\.(\d+)/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a > major || (a === major && b >= minor);
};

/** Whether a binary has write-only arguments and ephemeral resources. A tofu or terraform of no known version has neither. */
export function outOfState(bin: { name: string; version?: string }): OutOfState {
  if (bin.name === "choudoufu") return { writeOnly: true, ephemeral: true };
  if (bin.name === "terraform") return { writeOnly: atLeast(bin.version, 1, 11), ephemeral: atLeast(bin.version, 1, 10) };
  if (bin.name === "tofu") return { writeOnly: atLeast(bin.version, 1, 11), ephemeral: atLeast(bin.version, 1, 11) };
  return { writeOnly: false, ephemeral: false };
}

/** Whether a value is set: not null, and not an empty string, list or map. */
const isSet = (v: unknown): boolean => {
  if (v === null || v === undefined || v === "") return false;
  if (Array.isArray(v)) return v.some(isSet);
  if (isObject(v)) return Object.values(v).some(isSet);
  return true;
};

/** Whether a sensitive mark covers a set part of the value. */
const marksSet = (value: unknown, mark: unknown): boolean => {
  if (mark === true) return isSet(value);
  if (Array.isArray(mark) && Array.isArray(value)) return mark.some((m, i) => marksSet(value[i], m));
  if (isObject(mark) && isObject(value)) return Object.keys(mark).some((k) => marksSet(value[k], mark[k]));
  return false;
};

/** The resources of a plan's module tree, child modules included. */
function walk(module: unknown, out: Record<string, unknown>[]): void {
  if (!isObject(module)) return;
  for (const r of Array.isArray(module.resources) ? module.resources : []) if (isObject(r)) out.push(r);
  for (const child of Array.isArray(module.child_modules) ? module.child_modules : []) walk(child, out);
}

const noKey = (address: string): string => address.replace(/\[[^\]]*\]$/, "");

/**
 * The secrets a plan leaves in state, without counterparts: each resource's
 * top-level attribute marked sensitive whose value is set, from the planned
 * values (the state the apply leaves) and, for a data source read at plan
 * time, the prior state. Sorted by address, then attribute.
 */
export function storedSecrets(plan: unknown): StoredSecret[] {
  if (!isObject(plan)) return [];
  const planned: Record<string, unknown>[] = [];
  walk(isObject(plan.planned_values) ? plan.planned_values.root_module : undefined, planned);
  const prior: Record<string, unknown>[] = [];
  const state = isObject(plan.prior_state) && isObject(plan.prior_state.values) ? plan.prior_state.values.root_module : undefined;
  walk(state, prior);
  const seen = new Set(planned.map((r) => r.address));
  const resources = [...planned, ...prior.filter((r) => r.mode === "data" && !seen.has(r.address))];
  const found = new Map<string, StoredSecret>();
  for (const r of resources) {
    if ((r.mode !== "managed" && r.mode !== "data") || typeof r.address !== "string" || typeof r.type !== "string") continue;
    const values = isObject(r.values) ? r.values : {};
    const marks = isObject(r.sensitive_values) ? r.sensitive_values : {};
    for (const attribute of Object.keys(marks)) {
      if (!marksSet(values[attribute], marks[attribute])) continue;
      const address = noKey(r.address);
      const key = `${address}\n${attribute}`;
      const held = found.get(key);
      if (held) held.instances++;
      else found.set(key, { address, mode: r.mode, type: r.type, provider: typeof r.provider_name === "string" ? r.provider_name : "", attribute, instances: 1 });
    }
  }
  return [...found.values()].sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : a.attribute < b.attribute ? -1 : a.attribute > b.attribute ? 1 : 0));
}

type Schemas = Record<string, unknown>;

/** A provider's schemas from `providers schema -json`, by the provider's source address. */
const providerSchemas = (doc: unknown, provider: string): Schemas | undefined => {
  const all = isObject(doc) && isObject(doc.provider_schemas) ? doc.provider_schemas : undefined;
  const p = all?.[provider];
  return isObject(p) ? p : undefined;
};

const attributesOf = (p: Schemas, type: string): Schemas => {
  const s = isObject(p.resource_schemas) ? p.resource_schemas[type] : undefined;
  const block = isObject(s) ? s.block : undefined;
  return isObject(block) && isObject(block.attributes) ? block.attributes : {};
};

/**
 * Each secret with what keeps it out of state, as the schema of the provider
 * version the root initialised says and as far as the binary allows. Without
 * a schema, none has one.
 */
export function withCounterparts(secrets: readonly StoredSecret[], schema: unknown, can: OutOfState): StoredSecret[] {
  return secrets.map((s) => {
    const p = providerSchemas(schema, s.provider);
    if (!p) return s;
    if (s.mode === "managed" && can.writeOnly) {
      const attrs = attributesOf(p, s.type);
      const argument = `${s.attribute}_wo`;
      const a = attrs[argument];
      if (isObject(a) && a.write_only === true) {
        const version = isObject(attrs[`${argument}_version`]) ? `${argument}_version` : undefined;
        return { ...s, counterpart: { kind: "write-only", argument, ...(version ? { version } : {}) } };
      }
    }
    if (s.mode === "data" && can.ephemeral && isObject(p.ephemeral_resource_schemas) && isObject(p.ephemeral_resource_schemas[s.type])) {
      return { ...s, counterpart: { kind: "ephemeral", type: s.type } };
    }
    return s;
  });
}

/** A root's secrets in state as the report counts them: attributes set and sensitive, and how many of them could stay out. */
export function secretCounts(secrets: readonly StoredSecret[]): { in_state: number; movable: number } {
  const n = (list: readonly StoredSecret[]) => list.reduce((sum, s) => sum + s.instances, 0);
  return { in_state: n(secrets), movable: n(secrets.filter((s) => s.counterpart)) };
}

/** A provider's source address as people write it: `hashicorp/aws`. */
const shortProvider = (p: string): string => p.split("/").slice(-2).join("/");

/** The secret-in-state tip's text for one secret that has a counterpart. */
export function secretInStateMessage(s: StoredSecret, binary: string): string {
  const c = s.counterpart!;
  const held = `${s.address} keeps its sensitive ${s.attribute} in state${s.instances > 1 ? ` (${s.instances} instances)` : ""}, where every identity that can read the state can read it.`;
  if (c.kind === "write-only") {
    return `${held} On ${binary}, ${shortProvider(s.provider)}'s ${s.type} has the write-only argument ${c.argument}: set it in place of ${s.attribute}${c.version ? `, with ${c.version} to say when it changed` : ""}, and the value is never stored.`;
  }
  return `${held} On ${binary}, ${shortProvider(s.provider)} has the ephemeral resource ${c.type}: read it as ephemeral "${c.type}" and pass the value to a write-only argument or a provider's configuration, and it is never stored.`;
}

/** A choudoufu root's `strict { secrets }` setting: as written, or `store` when the live block does not set it. Undefined for a root with no live block. */
export function liveSecrets(dir: string): { setting: string; written: boolean } | undefined {
  const live = liveBody(dir);
  if (live === undefined) return undefined;
  const strict = live.match(/\bstrict\s*\{/);
  const written = strict ? blockBody(live, strict.index!).match(/\bsecrets\s*=\s*"([^"]*)"/)?.[1] : undefined;
  return written !== undefined ? { setting: written, written: true } : { setting: "store", written: false };
}

/** The block the choudoufu-secrets tip shows. */
export const REFUSE_BLOCK = `terraform {\n  live {\n    strict {\n      secrets = "refuse"\n    }\n  }\n}`;

/**
 * The choudoufu-secrets tip's text for a root whose live block does not set
 * `secrets = "refuse"`, or undefined when it does or it has no live block.
 * `CHOUDOUFU_STRICT_PIN=1` in the job's environment makes choudoufu refuse
 * secrets for an estate that sets nothing, so it gives no tip.
 */
export function choudoufuSecretsMessage(repo: string, root: string, env: NodeJS.ProcessEnv = {}): string | undefined {
  const s = liveSecrets(join(repo, root));
  if (!s || s.setting === "refuse") return undefined;
  if (!s.written && env.CHOUDOUFU_STRICT_PIN === "1") return undefined;
  const now = s.written ? `sets secrets = "${s.setting}"` : `does not set strict { secrets }, whose default is "store"`;
  return `Its live block ${now}, so a sensitive argument, and the value of a resource type that generates a secret such as random_password, can reach the estate's record store. Add strict { secrets = "refuse" } to the live block, and choudoufu leaves sensitive arguments out of the records and refuses the types that generate secrets.`;
}

/** A choudoufu root's estate as the report names it: the estate, where its record store is, and its `secrets` setting. Undefined for a root with no live block. */
export function liveEstate(dir: string): { estate: string; record_store: string; secrets: string } | undefined {
  const s = liveSecrets(dir);
  const { estate } = estateOf(dir);
  if (!s || !estate) return undefined;
  const store = recordStoreOf(dir, estate);
  const where = !store ? "local" : store.kind === "s3" ? `s3://${store.bucket}/${store.prefix}` : store.kind === "local" ? "local" : store.name;
  return { estate, record_store: where, secrets: s.setting };
}

/**
 * A root's secrets in state once it planned. The provider schema is read
 * (`schema`, which runs `providers schema -json` in the initialised root)
 * only when the plan leaves a secret in state and the binary has a way to
 * keep one out. `note` says why no counterpart could be named.
 */
export async function rootSecrets(plan: unknown, bin: { name: string; version?: string }, schema: () => Promise<{ status: number | null; stdout: string }>): Promise<{ secrets: StoredSecret[]; note?: string }> {
  const stored = storedSecrets(plan);
  const can = outOfState(bin);
  if (stored.length === 0 || (!can.writeOnly && !can.ephemeral)) return { secrets: stored };
  const r = await schema();
  let doc: unknown;
  try {
    doc = r.status === 0 ? JSON.parse(r.stdout) : undefined;
  } catch {
    doc = undefined;
  }
  if (doc === undefined) return { secrets: stored, note: `providers schema -json gave no schema (exit ${r.status}), so no write-only argument or ephemeral resource is named for its secrets in state` };
  return { secrets: withCounterparts(stored, doc, can) };
}
