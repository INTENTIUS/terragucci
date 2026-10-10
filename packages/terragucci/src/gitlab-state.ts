/**
 * GitLab-managed Terraform state: an http backend whose address is a GitLab
 * project's state API, `<api>/projects/<id>/terraform/state/<name>`, with
 * `<address>/lock` as its lock and unlock address.
 *
 * GitLab keeps each version of a state by its serial. `GET <address>` is the
 * current state, `GET <address>/versions/<serial>` one version, and `POST`
 * and `DELETE` on `<address>/lock` take and release the lock. A lock that is
 * held answers a `POST` with 409 and the holder's lock info.
 *
 * The backend's configuration comes from the block, a `-backend-config` file
 * or flag (which `init` records), or the job's `TF_HTTP_*` variables (which it
 * does not record): each attribute is the recorded value, else its variable
 * (`TF_HTTP_ADDRESS`, `TF_HTTP_LOCK_ADDRESS`, `TF_HTTP_UNLOCK_ADDRESS`,
 * `TF_HTTP_LOCK_METHOD`, `TF_HTTP_UNLOCK_METHOD`), as the binary reads it. Every call is made with the backend's own
 * credentials, `username` and `password` (`TF_HTTP_USERNAME`,
 * `TF_HTTP_PASSWORD`): the job token in a pipeline, a personal access token
 * at a shell.
 */
import { randomUUID } from "node:crypto";

/** The HTTP calls made here; S3Fetch and the forge's Fetch both fit. */
export type GitLabFetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/** Where a GitLab-managed state is, and how to call its API. */
export interface GitLabState {
  /** The state's address as the backend has it. */
  address: string;
  /** The state's name, the last part of its address. */
  name: string;
  lockAddress?: string;
  unlockAddress?: string;
  lockMethod: string;
  unlockMethod: string;
  /** The Authorization header the backend's credentials make, when it has any. */
  auth?: string;
}

/** The path of GitLab's state API: `.../api/v4/projects/<id>/terraform/state/<name>`. */
const STATE_API_PATH = /\/api\/v4\/projects\/[^/]+\/terraform\/state\/([^/]+)\/?$/;

const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

/** Whether an http backend's address is a GitLab project's state API. */
export function isGitLabAddress(address: string | undefined): boolean {
  if (!address) return false;
  try {
    return STATE_API_PATH.test(new URL(address).pathname);
  } catch {
    return false;
  }
}

/** A URL with its credentials and query left out, to print and record. */
export function shownUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return raw;
  }
}

/** The http backend's attribute, as the binary reads it: recorded, else its `TF_HTTP_*` variable. */
const attribute = (config: Record<string, unknown>, env: NodeJS.ProcessEnv, name: string): string | undefined => str(config[name]) ?? str(env[`TF_HTTP_${name.toUpperCase()}`]);

/** The GitLab-managed state an http backend names, or undefined when its address is not GitLab's state API. */
export function gitlabState(config: Record<string, unknown>, env: NodeJS.ProcessEnv = process.env): GitLabState | undefined {
  const address = attribute(config, env, "address");
  if (!address || !isGitLabAddress(address)) return undefined;
  const name = decodeURIComponent(new URL(address).pathname.match(STATE_API_PATH)![1]);
  const username = attribute(config, env, "username");
  const password = attribute(config, env, "password");
  const lockAddress = attribute(config, env, "lock_address");
  const unlockAddress = attribute(config, env, "unlock_address");
  return {
    address,
    name,
    ...(lockAddress ? { lockAddress } : {}),
    ...(unlockAddress ? { unlockAddress } : {}),
    lockMethod: attribute(config, env, "lock_method") ?? "LOCK",
    unlockMethod: attribute(config, env, "unlock_method") ?? "UNLOCK",
    ...(username || password ? { auth: `Basic ${Buffer.from(`${username ?? ""}:${password ?? ""}`).toString("base64")}` } : {}),
  };
}

const headers = (s: GitLabState, json = false): Record<string, string> => ({ ...(s.auth ? { authorization: s.auth } : {}), ...(json ? { "content-type": "application/json" } : {}) });

const base = (address: string): string => address.replace(/\/+$/, "");

/** An error that names the call and GitLab's answer, never the credentials. */
function answered(what: string, url: string, status: number, text: string): Error {
  const why = status === 401 ? ": the backend's username and password (TF_HTTP_USERNAME, TF_HTTP_PASSWORD) are not a token GitLab accepts" : status === 403 ? ": the token may not read this project's state (reads need Developer)" : "";
  return new Error(`GitLab answered ${status} to ${what} ${shownUrl(url)}${why}${text && !why ? `: ${text.trim().slice(0, 200)}` : ""}`);
}

/**
 * The serial and lineage of the state GitLab holds now, or undefined when it
 * holds none. GitLab has no call that answers the serial alone, so this reads
 * the state and keeps those two fields only.
 */
export async function currentSerial(s: GitLabState, fetchFn: GitLabFetch): Promise<{ serial: number; lineage?: string } | undefined> {
  const r = await fetchFn(s.address, { method: "GET", headers: headers(s) });
  if (r.status === 404 || r.status === 204) return undefined;
  const text = await r.text();
  if (!r.ok) throw answered("a read of", s.address, r.status, text);
  let doc: { serial?: unknown; lineage?: unknown };
  try {
    doc = JSON.parse(text) as typeof doc;
  } catch {
    throw new Error(`GitLab answered ${shownUrl(s.address)} with no state`);
  }
  if (typeof doc.serial !== "number") throw new Error(`the state at ${shownUrl(s.address)} has no serial`);
  return { serial: doc.serial, ...(typeof doc.lineage === "string" ? { lineage: doc.lineage } : {}) };
}

/** The URL of one version of the state. */
export const versionUrl = (s: GitLabState, serial: string): string => `${base(s.address)}/versions/${encodeURIComponent(serial)}`;

/** Whether GitLab keeps the version with this serial: a HEAD, so no state is read. */
export async function hasVersion(s: GitLabState, serial: string, fetchFn: GitLabFetch): Promise<boolean> {
  const r = await fetchFn(versionUrl(s, serial), { method: "HEAD", headers: headers(s) });
  if (r.status === 404) return false;
  if (!r.ok) throw answered("a check of", versionUrl(s, serial), r.status, "");
  return true;
}

/** One version of the state, or undefined when GitLab keeps no version with that serial. */
export async function readVersion(s: GitLabState, serial: string, fetchFn: GitLabFetch): Promise<string | undefined> {
  const r = await fetchFn(versionUrl(s, serial), { method: "GET", headers: headers(s) });
  if (r.status === 404) return undefined;
  const text = await r.text();
  if (!r.ok) throw answered("a read of", versionUrl(s, serial), r.status, text);
  return text;
}

/**
 * Who holds the state's lock: its ID, its GitLab user and when it was taken,
 * as lock info text, or undefined when nobody does. GitLab has no call that reads a lock, so this
 * asks for it: a held lock answers 409 with its holder, and a free one is
 * taken by the ask and released at once by its own ID.
 */
export async function probeLock(s: GitLabState, fetchFn: GitLabFetch): Promise<string | undefined> {
  if (!s.lockAddress || !s.unlockAddress) throw new Error(`the http backend of ${shownUrl(s.address)} names no ${s.lockAddress ? "unlock_address" : "lock_address"}`);
  const id = `terragucci-probe-${randomUUID()}`;
  const info = JSON.stringify({ ID: id, Operation: "OperationTypeInvalid", Info: "terragucci reads who holds the lock", Who: "terragucci", Version: "", Created: new Date().toISOString(), Path: "" });
  const r = await fetchFn(s.lockAddress, { method: s.lockMethod, headers: headers(s, true), body: info });
  const text = await r.text();
  if (r.status === 409 || r.status === 423) return heldBy(text);
  if (!r.ok) throw answered("a lock of", s.lockAddress, r.status, text);
  await releaseLock(s, id, fetchFn);
  return undefined;
}

/**
 * The holder in GitLab's answer to a lock that is held: its ID, its GitLab
 * user and when it was taken. GitLab answers the other fields with the ask's
 * own, so they are left out.
 */
function heldBy(text: string): string {
  try {
    const v = JSON.parse(text) as Record<string, unknown>;
    return JSON.stringify(Object.fromEntries(["ID", "Who", "Created"].filter((k) => typeof v[k] === "string").map((k) => [k, v[k]])));
  } catch {
    return text;
  }
}

/**
 * Release the lock with this ID. GitLab releases it only while that ID holds
 * it: another lock taken since answers 409, which is thrown.
 */
export async function releaseLock(s: GitLabState, id: string, fetchFn: GitLabFetch): Promise<void> {
  if (!s.unlockAddress) throw new Error(`the http backend of ${shownUrl(s.address)} names no unlock_address`);
  const r = await fetchFn(s.unlockAddress, { method: s.unlockMethod, headers: headers(s, true), body: JSON.stringify({ ID: id }) });
  const text = await r.text();
  if (r.status === 409 || r.status === 423) throw new Error(`GitLab did not release lock ${id} on ${shownUrl(s.unlockAddress)}: another lock holds the state now`);
  if (!r.ok) throw answered("a release of", s.unlockAddress, r.status, text);
}

/**
 * A GitLab state address with its state name suffixed `-<suffix>`, and a
 * lock address with the state name before `/lock` suffixed the same way.
 * Undefined when the address is not GitLab's state API (or its lock).
 */
export function suffixedGitLabAddress(address: string, suffix: string): string | undefined {
  let u: URL;
  try {
    u = new URL(address);
  } catch {
    return undefined;
  }
  const m = u.pathname.match(/^(.*\/api\/v4\/projects\/[^/]+\/terraform\/state\/)([^/]+?)(\/lock)?\/?$/);
  if (!m) return undefined;
  u.pathname = `${m[1]}${m[2]}-${suffix}${m[3] ?? ""}`;
  return u.toString();
}
