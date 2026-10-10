/**
 * Where a state is, for each backend type, as a root's code names it: in the
 * root's own backend block (or `cloud` block), and in a
 * `terraform_remote_state` block that reads it. Two roots line up when the
 * address one's backend names is the address the other's read names.
 *
 * s3, gcs, azurerm and any type not named here keep the address they always
 * had: the bucket, when one is named, and the key (or `prefix`). The others
 * get a key of their own, prefixed with the type so that no two types share
 * one:
 *
 * - `local:<path>`: the state file, resolved against the root's directory and
 *   written relative to the repo.
 * - `pg:<host>/<database>/<schema>.<table>`: from `conn_str`, credentials left out.
 * - `http:<address>`: the URL, credentials left out.
 * - `consul:<address>/<path>`.
 * - `kubernetes:<namespace>/<secret_suffix>`.
 * - `remote:<hostname>/<organization>/<workspace>`: a `remote` backend or a `cloud` block.
 *
 * An address is unresolved when a part of it is not a plain string in the
 * code: an expression such as `var.env`, or a value the backend takes from
 * the environment or a `-backend-config` file (`PG_CONN_STR`,
 * `TF_HTTP_ADDRESS`, `CONSUL_HTTP_ADDR`, `KUBE_NAMESPACE`,
 * `TF_CLOUD_ORGANIZATION`, a workspace picked by tags or `TF_WORKSPACE`).
 * Nothing can line it up with another root, so it is named instead.
 */
import { posix, sep } from "node:path";

/** Where one state is: its bucket, when the backend names one, and its key. */
export interface StateKey {
  bucket?: string;
  key: string;
}

/** An address, or why the code does not say it. */
export type Addressed = StateKey | { unresolved: string };

/**
 * One attribute as the code writes it: the string, `null` when it is written
 * but is not a plain string (an expression, or a string with a template in
 * it), undefined when it is not written.
 */
export type Attr = (name: string) => string | null | undefined;

/** The types this module gives an address of their own. */
export const ADDRESSED_TYPES = ["local", "pg", "http", "consul", "kubernetes", "remote"] as const;

const unresolved = (why: string): Addressed => ({ unresolved: why });

/** A plain string with no template in it, else null. */
export function literal(v: unknown): string | null | undefined {
  if (v === undefined) return undefined;
  return typeof v === "string" && !/\$\{|%\{/.test(v) ? v : null;
}

/** `scheme://user:pass@Host:port/path?q` as `host:port/path`, credentials and query left out. */
function urlAddress(raw: string, keepScheme: boolean): string | undefined {
  try {
    const u = new URL(raw.includes("://") ? raw : `http://${raw}`);
    const path = u.pathname.replace(/\/+$/, "");
    return `${keepScheme ? `${u.protocol}//` : ""}${u.host.toLowerCase()}${path}`;
  } catch {
    return undefined;
  }
}

/** The host and database of a Postgres connection string, in URL or `key=value` form. */
export function pgDatabase(conn: string): string | undefined {
  if (/^postgres(ql)?:\/\//i.test(conn)) {
    try {
      const u = new URL(conn);
      const db = u.pathname.replace(/^\/+/, "") || u.searchParams.get("dbname");
      const host = u.host.toLowerCase() || u.searchParams.get("host");
      return host && db ? `${host}/${db}` : undefined;
    } catch {
      return undefined;
    }
  }
  const kv = new Map([...conn.matchAll(/(\w+)\s*=\s*('(?:[^'\\]|\\.)*'|\S+)/g)].map((m) => [m[1], m[2].replace(/^'|'$/g, "")]));
  const host = kv.get("host")?.toLowerCase();
  const db = kv.get("dbname");
  if (!host || !db) return undefined;
  return `${host}${kv.get("port") ? `:${kv.get("port")}` : ""}/${db}`;
}

/**
 * The address of a state of backend `type`, from its attributes. `dir` is the
 * directory the binary runs in for the block (the root's, relative to the
 * repo), which a local path is resolved against.
 */
export function stateAddress(type: string, get: Attr, dir: string): Addressed {
  const missing = (name: string, from?: string): Addressed =>
    unresolved(get(name) === null ? `its ${type} ${name} is an expression, not a plain string` : `its ${type} backend names no ${name} in the code (${from ? `${from} or ` : ""}a -backend-config file supplies it)`);
  switch (type) {
    case "local": {
      const path = get("path");
      if (path === null) return missing("path");
      const p = (path ?? "terraform.tfstate").split(sep).join(posix.sep);
      // Relative to the repo, `/` between parts; a path outside the repo keeps its `..`, an absolute one stays as it is.
      return { key: `local:${posix.isAbsolute(p) ? posix.normalize(p) : posix.normalize(posix.join(dir.split(sep).join(posix.sep) || ".", p))}` };
    }
    case "pg": {
      const conn = get("conn_str");
      if (!conn) return missing("conn_str", "PG_CONN_STR");
      const db = pgDatabase(conn);
      if (!db) return unresolved("its pg conn_str names no host and database");
      const schema = get("schema_name");
      const table = get("table_name");
      if (schema === null) return missing("schema_name");
      if (table === null) return missing("table_name");
      return { key: `pg:${db}/${schema ?? "terraform_remote_state"}.${table ?? "states"}` };
    }
    case "http": {
      const address = get("address");
      if (!address) return missing("address", "TF_HTTP_ADDRESS");
      const url = urlAddress(address, true);
      return url ? { key: `http:${url}` } : unresolved(`its http address is not a URL`);
    }
    case "consul": {
      const address = get("address");
      const path = get("path");
      if (!path) return missing("path");
      if (!address) return missing("address", "CONSUL_HTTP_ADDR");
      const host = urlAddress(address, false);
      return host ? { key: `consul:${host}/${path.replace(/^\/+/, "")}` } : unresolved("its consul address is not a host");
    }
    case "kubernetes": {
      const suffix = get("secret_suffix");
      const namespace = get("namespace");
      if (!suffix) return missing("secret_suffix");
      if (!namespace) return missing("namespace", "KUBE_NAMESPACE");
      return { key: `kubernetes:${namespace}/${suffix}` };
    }
    case "remote":
    case "cloud": {
      const host = get("hostname");
      const org = get("organization");
      const name = get("name");
      if (host === null) return missing("hostname");
      if (!org) return missing("organization", type === "cloud" ? "TF_CLOUD_ORGANIZATION" : undefined);
      if (name === null) return unresolved(`its ${type} workspace name is an expression, not a plain string`);
      if (name === undefined) return unresolved(`its ${type} workspaces block names no workspace by name (one picked by tags, prefix or TF_WORKSPACE cannot be read from the code)`);
      return { key: `remote:${(host ?? "app.terraform.io").toLowerCase()}/${org}/${name}` };
    }
  }
  // s3, gcs, azurerm, and the types not named above: the bucket and key, as before.
  const k = get("key");
  const p = get("prefix");
  const key = k || p;
  if (!key) return missing(k === null ? "key" : p === null ? "prefix" : type === "gcs" ? "prefix" : "key");
  const bucket = get("bucket");
  if (bucket === null) return missing("bucket");
  return { ...(bucket ? { bucket } : {}), key };
}
