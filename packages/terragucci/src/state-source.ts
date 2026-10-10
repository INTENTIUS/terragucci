/**
 * Where a backend move reads a state that no backend block of the root can
 * reach with an override file: a workspace of HCP Terraform or another
 * service that speaks its API (a `remote` backend or a `cloud` block), and a
 * state file exported from a platform that keeps state its own way.
 *
 * A workspace's state is read over the API the stock `remote` backend and
 * `cloud` block use: service discovery at
 * `https://<hostname>/.well-known/terraform.json` gives the `tfe.v2` base,
 * then the workspace by organization and name, its current state version
 * and that version's download URL. The token is the one Terraform and
 * OpenTofu use for the host: `TF_TOKEN_<host>`, else
 * `~/.terraform.d/credentials.tfrc.json`. A migration holds the workspace's
 * lock while it writes, as it holds an S3 state's lock file, and the
 * workspace's state is left where it was.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { ConfigError } from "./config";
import type { StoreFetch } from "./report/object-store";

/** The backends a move reads from without the binary: a TFE-API workspace, and a state file. */
export const EXTERNAL_BACKENDS = ["remote", "cloud", "file"];

/** A state as the source gives it: its JSON, and the source's version id when it keeps versions. */
export interface ReadState {
  text: string;
  version?: string;
}

/** A source of a backend move that the job reads itself. */
export interface ExternalSource {
  backend: string;
  /** Where the state is, as the record and the digest name it. */
  location: string;
  read(): Promise<ReadState | null>;
  /** Take the source's lock; returns its release. Throws ConfigError when another holds it. */
  lock?(reason: string): Promise<() => Promise<void>>;
}

const DEFAULT_HOST = "app.terraform.io";
const HOST = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d+)?$/i;

/** Problems with the config of an external source, as `<at>.from.config...` lines. */
export function externalProblems(at: string, backend: string, config: Record<string, unknown>): string[] {
  const p: string[] = [];
  if (backend === "file") {
    for (const k of Object.keys(config)) if (k !== "path") p.push(`${at}.from.config.${k} is not a key; a file source has path`);
    if (typeof config.path !== "string" || !config.path.trim()) p.push(`${at}.from.config.path must name the state file`);
    else if (!isAbsolute(config.path) && config.path.split("/").includes("..")) p.push(`${at}.from.config.path must be in the repo or an absolute path, not ${config.path}`);
    return p;
  }
  for (const k of Object.keys(config)) {
    if (k === "token") p.push(`${at}.from.config.token: a token does not belong in the repo; the job reads TF_TOKEN_<host> or credentials.tfrc.json`);
    else if (!["hostname", "organization", "workspaces"].includes(k)) p.push(`${at}.from.config.${k} is not a key; a ${backend} source has hostname, organization and workspaces`);
  }
  if (config.hostname !== undefined && (typeof config.hostname !== "string" || !HOST.test(config.hostname))) p.push(`${at}.from.config.hostname must be a host name, such as ${DEFAULT_HOST}`);
  if (typeof config.organization !== "string" || !config.organization) p.push(`${at}.from.config.organization must name the organization`);
  const ws = config.workspaces && typeof config.workspaces === "object" && !Array.isArray(config.workspaces) ? (config.workspaces as Record<string, unknown>) : undefined;
  if (!ws || typeof ws.name !== "string" || !ws.name) p.push(`${at}.from.config.workspaces.name must name the one workspace whose state moves`);
  for (const k of Object.keys(ws ?? {})) if (k !== "name") p.push(`${at}.from.config.workspaces.${k}: a move reads one workspace, named by workspaces.name`);
  return p;
}

/** The variable Terraform and OpenTofu read a host's token from: dots to `_`, dashes to `__`. */
export const tokenVariable = (host: string): string => `TF_TOKEN_${host.replace(/-/g, "__").replace(/\./g, "_")}`;

/** The token for a host: `TF_TOKEN_<host>`, else the CLI's credentials file. */
export function tokenFor(host: string, env: NodeJS.ProcessEnv): string | undefined {
  const v = env[tokenVariable(host)];
  if (v) return v;
  const file = join(env.HOME ?? homedir(), ".terraform.d", "credentials.tfrc.json");
  if (!existsSync(file)) return undefined;
  try {
    const doc = JSON.parse(readFileSync(file, "utf-8")) as { credentials?: Record<string, { token?: string }> };
    return doc.credentials?.[host]?.token || undefined;
  } catch {
    return undefined;
  }
}

/** The source a backend move reads from, when the job reads it itself; undefined for a backend read through the root. */
export function externalSource(repo: string, backend: string, config: Record<string, unknown>, env: NodeJS.ProcessEnv, fetchFn?: StoreFetch): ExternalSource | undefined {
  if (backend === "file") return fileSource(repo, String(config.path));
  if (backend !== "remote" && backend !== "cloud") return undefined;
  const ws = config.workspaces as { name: string };
  return workspaceSource(backend, typeof config.hostname === "string" ? config.hostname : DEFAULT_HOST, String(config.organization), ws.name, env, fetchFn);
}

/** A state file: in the repo, or at an absolute path the job can read. No versions, no lock; its digest is in the migration's. */
export function fileSource(repo: string, path: string): ExternalSource {
  const full = isAbsolute(path) ? path : join(repo, path);
  return {
    backend: "file",
    location: path,
    read: async () => {
      if (!existsSync(full)) return null;
      const text = readFileSync(full, "utf-8");
      let doc: { version?: unknown; lineage?: unknown; serial?: unknown; resources?: unknown };
      try {
        doc = JSON.parse(text);
      } catch {
        throw new ConfigError(`${path} is not a state file: it is not JSON`);
      }
      if (doc.version !== 4 || typeof doc.lineage !== "string" || typeof doc.serial !== "number" || !Array.isArray(doc.resources)) throw new ConfigError(`${path} is not a state file of format version 4 with a lineage, a serial and resources`);
      return { text };
    },
  };
}

interface Json {
  data?: { id?: string; attributes?: Record<string, unknown> };
}

/** A workspace's state over the TFE API, as the remote backend and the cloud block read it. */
export function workspaceSource(backend: string, host: string, org: string, name: string, env: NodeJS.ProcessEnv, fetchFn: StoreFetch = fetch as unknown as StoreFetch): ExternalSource {
  const location = `${backend}://${host}/${org}/${name}`;
  const token = tokenFor(host, env);
  const origin = `https://${host}`;
  let base: string | undefined;
  let id: string | undefined;
  const call = async (url: string, method = "GET", body?: string): Promise<{ status: number; text: string }> => {
    // The token goes to the host and the API discovery names (Spacelift's is on another host), as the binary sends it; never to a download elsewhere.
    const sameHost = [host, base ? new URL(base).host : host].includes(new URL(url).host);
    const headers: Record<string, string> = { accept: "application/vnd.api+json", ...(body ? { "content-type": "application/vnd.api+json" } : {}), ...(token && sameHost ? { authorization: `Bearer ${token}` } : {}) };
    let r: Awaited<ReturnType<StoreFetch>>;
    try {
      r = await fetchFn(url, { method, headers, ...(body ? { body } : {}) });
    } catch (e) {
      const cause = (e as Error & { cause?: { message?: string } }).cause?.message;
      throw new ConfigError(`${location}: ${method} ${new URL(url).pathname} failed: ${(e as Error).message}${cause ? ` (${cause})` : ""}`);
    }
    return { status: r.status, text: await r.text() };
  };
  const json = (what: string, r: { status: number; text: string }): Json => {
    if (r.status === 401 || r.status === 404) throw new ConfigError(`${location}: ${what} answered ${r.status}; ${token ? `the token in ${tokenVariable(host)} or credentials.tfrc.json may not read the workspace` : `the job has no token for ${host}: set ${tokenVariable(host)}`}`);
    if (r.status >= 300) throw new ConfigError(`${location}: ${what} answered ${r.status}: ${r.text.slice(0, 200)}`);
    try {
      return JSON.parse(r.text) as Json;
    } catch {
      throw new ConfigError(`${location}: ${what} answered with something that is not JSON`);
    }
  };
  const api = async (): Promise<string> => {
    if (base) return base;
    const r = await call(`${origin}/.well-known/terraform.json`);
    let doc: Record<string, unknown> = {};
    try {
      doc = r.status < 300 ? (JSON.parse(r.text) as Record<string, unknown>) : {};
    } catch {
      doc = {};
    }
    const v2 = doc["tfe.v2"];
    if (typeof v2 !== "string") throw new ConfigError(`${location}: ${host} names no tfe.v2 API in /.well-known/terraform.json, so it does not speak the remote backend's protocol`);
    base = new URL(v2, `${origin}/`).toString().replace(/\/?$/, "/");
    return base;
  };
  const workspace = async (): Promise<string> => {
    if (id) return id;
    const b = await api();
    const got = json("the workspace", await call(`${b}organizations/${encodeURIComponent(org)}/workspaces/${encodeURIComponent(name)}`));
    if (!got.data?.id) throw new ConfigError(`${location}: the workspace answered with no id`);
    id = got.data.id;
    return id;
  };
  return {
    backend,
    location,
    read: async () => {
      const b = await api();
      const ws = await workspace();
      const r = await call(`${b}workspaces/${ws}/current-state-version`);
      // The workspace answered, so no current version is no state yet.
      if (r.status === 404) return null;
      const sv = json("the current state version", r);
      const url = sv.data?.attributes?.["hosted-state-download-url"];
      if (!sv.data?.id || typeof url !== "string") throw new ConfigError(`${location}: the current state version names no download URL`);
      const got = await call(new URL(url, `${origin}/`).toString());
      if (got.status >= 300) throw new ConfigError(`${location}: the download of ${sv.data.id} answered ${got.status}`);
      return { text: got.text, version: sv.data.id };
    },
    lock: async (reason) => {
      const b = await api();
      const ws = await workspace();
      const r = await call(`${b}workspaces/${ws}/actions/lock`, "POST", JSON.stringify({ reason }));
      if (r.status === 409) throw new ConfigError(`its workspace ${location} is locked, so nothing was written`);
      json("the workspace lock", r);
      return async () => {
        const u = await call(`${b}workspaces/${ws}/actions/unlock`, "POST");
        if (u.status >= 300) throw new ConfigError(`${location}: the unlock answered ${u.status}`);
      };
    },
  };
}
