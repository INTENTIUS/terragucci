/**
 * Reading a choudoufu estate's record store: which resource instances hold a
 * record, and at which version, read from the store a root's `live` block
 * names. Nothing here reads a record's body, so no value is ever read.
 *
 * choudoufu keeps one record per resource instance at
 * `<key_prefix>/<type>/<base64url of the address>` (the encoding split into
 * segments when it is long), under `tofu-records/<estate>/` unless the
 * `record_store` block sets `key_prefix`. From 0.24.0 an instance's record is
 * written the moment its apply returns, so the keys and versions read while
 * an apply runs say which resources it finished.
 *
 * Two stores are read: `s3`, with the job's AWS identity and endpoint, and
 * `local`, a directory beside the root (`.tofu-records` by default). A
 * `kubernetes` store, or one that cannot be read, gives no records.
 */
import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { liveBody } from "./detect";
import { encodeStrict, xmlText, type StoreFetch } from "./report/object-store";
import { assumeRoleWithWebIdentity, s3FromEnv, sign, type S3Credentials } from "./report/s3";

/** Where an estate's records are: an S3 bucket, a directory, or a store this module does not read. */
export type RecordStore =
  | { kind: "s3"; bucket: string; prefix: string; region?: string }
  | { kind: "local"; dir: string; prefix: string }
  | { kind: "unread"; name: string };

/** Each recorded instance's address and its record's version (an ETag, or a file's time and size). */
export type Records = Map<string, string>;

/** A key namespace with exactly one trailing slash, as choudoufu's NamespacePrefix makes it. */
const namespace = (prefix: string): string => `${prefix.replace(/\/+$/, "")}/`;

function block(text: string, open: number): string {
  let depth = 0;
  for (let i = text.indexOf("{", open); i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return text.slice(open, i + 1);
  }
  return text.slice(open);
}

const attr = (body: string, name: string): string | undefined => body.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`))?.[1];

/** The record store of the estate a root's `live` block owns, or undefined when the root has no live block. */
export function recordStoreOf(dir: string, estate: string): RecordStore | undefined {
  const live = liveBody(dir);
  if (live === undefined) return undefined;
  const m = /\brecord_store\s+"([^"]+)"\s*\{/.exec(live);
  const body = m ? block(live, m.index) : "";
  const keyPrefix = attr(body, "key_prefix");
  const prefix = namespace(keyPrefix ?? `tofu-records/${estate}`);
  const kind = m?.[1] ?? "local";
  if (kind === "s3") {
    const bucket = attr(body, "bucket");
    if (!bucket) return { kind: "unread", name: "s3" };
    const region = attr(body, "region");
    return { kind: "s3", bucket, prefix, ...(region ? { region } : {}) };
  }
  if (kind === "local") return { kind: "local", dir: join(dir, attr(body, "path") ?? ".tofu-records"), prefix };
  return { kind: "unread", name: kind };
}

/** The address a record key names, or undefined for a key choudoufu did not write under `prefix`. */
export function recordAddress(prefix: string, key: string): string | undefined {
  const under = namespace(prefix);
  if (!key.startsWith(under)) return undefined;
  const rest = key.slice(under.length);
  const slash = rest.indexOf("/");
  if (slash <= 0) return undefined;
  const encoded = rest.slice(slash + 1).replace(/\//g, "");
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return undefined;
  const address = Buffer.from(encoded, "base64url").toString("utf-8");
  // A key whose segment is not an address (a sidecar, a stray object) is not a record.
  return /^(module\..+\.)?[a-z0-9_]+\.[A-Za-z_][\w-]*(\[.+\])?$/.test(address) && !/[\x00-\x1f]/.test(address) ? address : undefined;
}

function walk(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.flatMap((n) => {
    const p = join(dir, n);
    try {
      return statSync(p).isDirectory() ? walk(p) : /\.(lock|tmp-\d+)$/.test(n) ? [] : [p];
    } catch {
      return [];
    }
  });
}

function localRecords(store: Extract<RecordStore, { kind: "local" }>): Records {
  const out: Records = new Map();
  for (const file of walk(join(store.dir, store.prefix))) {
    const key = relative(store.dir, file).split(sep).join("/");
    const address = recordAddress(store.prefix, key);
    if (!address) continue;
    try {
      const s = statSync(file);
      out.set(address, `${s.mtimeMs}:${s.size}`);
    } catch {
      // Removed between the listing and the stat: no record.
    }
  }
  return out;
}

async function s3Records(store: Extract<RecordStore, { kind: "s3" }>, env: NodeJS.ProcessEnv, fetchFn: StoreFetch): Promise<Records> {
  const target = s3FromEnv({ bucket: store.bucket }, store.region ? { ...env, AWS_REGION: store.region } : env);
  const creds: S3Credentials = "webIdentity" in target ? await assumeRoleWithWebIdentity(target.webIdentity, fetchFn) : target;
  const base = target.endpoint ? `${target.endpoint}/${encodeStrict(store.bucket)}` : `https://${store.bucket}.s3.${target.region}.amazonaws.com/`;
  const out: Records = new Map();
  let token: string | undefined;
  for (let page = 0; page < 1000; page++) {
    const query = [["list-type", "2"], ["prefix", store.prefix], ...(token ? [["continuation-token", token]] : [])].map(([k, v]) => `${encodeStrict(k)}=${encodeStrict(v)}`).join("&");
    const url = `${base}?${query}`;
    const res = await fetchFn(url, { method: "GET", headers: sign({ region: target.region, ...creds }, "GET", url, {}, EMPTY_SHA256, new Date()) });
    const text = await res.text();
    if (!res.ok) throw new Error(`listing s3://${store.bucket}/${store.prefix}: ${res.status} ${text.slice(0, 200)}`);
    for (const m of text.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const key = xmlText(m[1], "Key");
      const address = key ? recordAddress(store.prefix, key) : undefined;
      if (address) out.set(address, xmlText(m[1], "ETag") ?? xmlText(m[1], "LastModified") ?? "");
    }
    token = xmlText(text, "IsTruncated") === "true" ? xmlText(text, "NextContinuationToken") : undefined;
    if (!token) break;
  }
  return out;
}

const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/** The records the store holds now. Throws when the store cannot be read; a store this module does not read throws too. */
export async function readRecords(store: RecordStore, env: NodeJS.ProcessEnv = process.env, fetchFn: StoreFetch = fetch as unknown as StoreFetch): Promise<Records> {
  if (store.kind === "local") return localRecords(store);
  if (store.kind === "s3") return s3Records(store, env, fetchFn);
  throw new Error(`a ${store.name} record store is not read for progress`);
}
