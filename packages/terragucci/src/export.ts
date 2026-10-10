/**
 * `terragucci state export <root> [--version <id>]`: one version of a root's
 * state, downloaded to the machine of the person who runs it, once someone
 * else approved it, and recorded on `chant/lifecycle` with who exported what.
 *
 * The export goes only to the person running it, never to a job artifact or
 * the reports bucket. A state holds every secret its resources hold. A job's
 * artifact is readable by everyone with read access to the repo (everyone at
 * all on a public one) for the artifact's retention, which would hand the
 * state to far more people than can read the bucket. Run locally, the state
 * reaches only the person whose own cloud identity the bucket already lets
 * read it; what terragucci adds is the approval and the record.
 *
 * The first run asks: it reads the version's metadata (a HEAD, never the
 * body), writes a pending request to `_gates/tf-state-export.jsonl` (gate:
 * the root, digest: the request's own, over the root, the state's location,
 * the version, the requester and when), prints the `chant approve` command,
 * and exits 3. Once someone other than the requester approved that digest
 * (under `approval: sealed`, with a seal a listed signer made), the next run
 * downloads the version, appends the record to
 * `_gates/tf-state-export/done.jsonl`, and only then writes the file, mode
 * 0600, outside the repo. A request exports once; another export asks again.
 * `terragucci audit` lists each record as a `state-export` entry.
 *
 * The record holds the version id and the digest of what was written, never
 * a state's contents. It reads states in backends that keep versions: s3
 * (bucket versioning), gcs (object versioning, a version is a generation),
 * azurerm (blob versioning, or the snapshots an apply's version record
 * takes when the backend sets `snapshot = true`), and GitLab-managed states
 * (./gitlab-state.ts), whose version id is the serial. A GitLab request with
 * `--version` checks it with a HEAD; one without reads the current state for
 * its serial, which GitLab answers no other way, and keeps nothing else of
 * it. It refuses roots with a `cloud` block. A Terragrunt unit is prepared the way a
 * migration prepares one (unitPlace): Terragrunt inits it, and the backend is
 * the one that init recorded in the directory Terragrunt ran the binary in.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { samePlanDigest } from "@intentius/chant/lifecycle/plan-digest";
import { appendLifecycle, appendPending, readLedger, type PendingRecord, type ResolutionRecord } from "./apply";
import { approvalRule } from "./approval";
import { isStored, READS_VERSIONS, stateObject, stateStore, type StateObject } from "./backend";
import { ConfigError, findConfig, loadConfig, resolveRepo } from "./config";
import { detectShape } from "./shape";
import { refusal, runBinary, unitPlace, type BinaryExec, type MigrateOptions } from "./migrate";
import { currentSerial, hasVersion, readVersion } from "./gitlab-state";
import type { StoreFetch } from "./report/object-store";
import { sealRefusal } from "./seal";

export const EXPORT_OP = "tf-state-export";
export const EXPORT_LEDGER = `_gates/${EXPORT_OP}.jsonl`;
/** Beside the ledger: one line per export that was written. */
export const EXPORT_DONE = `_gates/${EXPORT_OP}/done.jsonl`;
/** How long a request waits for its approval. */
const REQUEST_HOURS = 48;

/** The command that approves an export request. */
export const exportApproveCommand = (root: string, digest: string, sealed = false): string => `chant approve ${EXPORT_OP} ${root} --plan ${digest}${sealed ? " --sign" : ""}`;

/** What a request names: the pending line carries it, and its digest covers it. */
export interface ExportRequest {
  root: string;
  location: string;
  version_id: string;
  by: string;
  at: string;
}

type ExportPending = PendingRecord & { request?: ExportRequest };

/** The line done.jsonl gets for each export. */
export interface ExportRecord {
  version: 1;
  kind: "state-export";
  op: typeof EXPORT_OP;
  gate: string;
  planDigest: string;
  root: string;
  location: string;
  version_id: string;
  exportedBy: string;
  approvedBy: string;
  approvedAt: string;
  timestamp: string;
  /** sha256 of the bytes written: which copy is out there, never what it holds. */
  content_digest: string;
}

export interface ExportOptions {
  root: string;
  /** The version to export. Default: the one the bucket holds now. */
  version?: string;
  /** Where the file goes; outside the repo. Default: a new private directory in the system's temp dir. */
  out?: string;
  /** Who asks. Default: git's user.name, else user.email. */
  actor?: string;
  binary?: string;
  config?: string;
  env?: NodeJS.ProcessEnv;
  exec?: BinaryExec;
  /** How a Terragrunt unit is prepared (MigrateOptions.terragrunt). */
  terragrunt?: MigrateOptions["terragrunt"];
  fetch?: StoreFetch;
  now?: string;
  log?: (line: string) => void;
}

export interface ExportResult {
  /** 0 written, 3 waiting for an approval, 1 failed. */
  code: number;
  digest?: string;
  command?: string;
  file?: string;
}

const sha = (text: string | Buffer): string => `sha256:${createHash("sha256").update(text).digest("hex")}`;
const at = (iso: string): number => Date.parse(iso) || 0;

/** The digest an approval names: over everything the request says. */
export function requestDigest(r: ExportRequest): string {
  return sha(JSON.stringify({ op: EXPORT_OP, root: r.root, location: r.location, version_id: r.version_id, by: r.by, at: r.at }));
}

function git(repo: string, args: string[], env: NodeJS.ProcessEnv): string {
  const r = spawnSync("git", args, { cwd: repo, encoding: "utf-8", env });
  return r.status === 0 ? r.stdout.trim() : "";
}

/** The exports done.jsonl records, by request digest. */
export function doneExports(text: string): Map<string, ExportRecord> {
  const out = new Map<string, ExportRecord>();
  for (const line of text.split("\n").map((l) => l.trim()).filter(Boolean)) {
    try {
      const r = JSON.parse(line) as ExportRecord;
      if (r.version === 1 && r.kind === "state-export" && typeof r.planDigest === "string") out.set(r.planDigest, r);
    } catch {
      // A line that is not a record is skipped.
    }
  }
  return out;
}

/** Where the file may go: never inside the repo, where it could be committed, and never over a file. */
function outPath(repo: string, out: string | undefined, root: string, version: string): string {
  const name = `${root.replace(/[^\w.-]+/g, "_")}.${version.replace(/[^\w.-]+/g, "_")}.tfstate`;
  if (!out) return join(mkdtempSync(join(tmpdir(), "terragucci-export-")), name);
  const abs = resolve(out);
  if (!existsSync(dirname(abs))) throw new ConfigError(`--out ${out}: ${dirname(abs)} is not a directory`);
  if (existsSync(abs)) throw new ConfigError(`--out ${out} is there already; name a new file`);
  const rel = relative(realpathSync(repo), join(realpathSync(dirname(abs)), basename(abs)));
  if (!rel.startsWith("..") && !isAbsolute(rel)) throw new ConfigError(`--out ${out} is inside the repo, where a state could be committed; write it outside the repo`);
  return abs;
}

/**
 * Ask for, or with an approval write, one version of a root's state. Throws
 * ConfigError for a root, backend or version it cannot export.
 */
export async function exportState(repo: string, options: ExportOptions): Promise<ExportResult> {
  const log = options.log ?? ((l: string) => console.log(l));
  const env = options.env ?? process.env;
  const exec = options.exec ?? runBinary;
  const now = options.now ?? new Date().toISOString();
  const root = options.root.replace(/\/+$/, "");
  if (!root) throw new ConfigError("state export takes the root whose state to export: terragucci state export <root> [--version <id>]");
  const configPath = options.config ?? findConfig(repo);
  const settings = configPath ? resolveRepo(await loadConfig(configPath)) : undefined;
  const shape = detectShape(repo, settings ?? resolveRepo({}));
  // A unit an explicit stack generates is generated first, as a wave generates it.
  await shape.prepareRoots({ roots: [root], ...(options.terragrunt?.path ? { terragrunt: options.terragrunt.path } : {}), ...(options.terragrunt?.exec ? { exec: options.terragrunt.exec } : {}) });
  const why = refusal(repo, root);
  if (why) throw new ConfigError(`state export: ${why}`);
  const unit = existsSync(join(repo, root, "terragrunt.hcl"));
  const by = options.actor || git(repo, ["config", "user.name"], env) || git(repo, ["config", "user.email"], env);
  if (!by) throw new ConfigError("state export names who asks: set git's user.name, or pass --actor <name>");
  const binary = options.binary ?? settings?.binary ?? shape.binary([root]).value;

  // The backend, read by an init in a data dir of the export's own: the checkout's .terraform is left alone.
  // A Terragrunt unit's backend is what Terragrunt makes of its remote_state: Terragrunt inits it where it runs the binary, as a migration prepares it.
  const data = mkdtempSync(join(tmpdir(), "terragucci-export-data-"));
  let object: StateObject;
  try {
    if (unit) {
      const place = await unitPlace(repo, root, binary, env, data, options.terragrunt);
      object = stateObject(place.dir, place.env);
    } else {
      // A root that names its workspace (an Atmos instance) inits in default; its state is its own workspace's.
      const benv = { ...env, TF_DATA_DIR: data };
      const init = await exec(binary, ["init", "-input=false", "-no-color"], join(repo, root), shape.rootInit(root, benv)?.init ?? benv);
      if (init.code !== 0) throw new ConfigError(`init in ${root} failed: ${init.out.trim().split("\n").slice(-4).join(" ").slice(0, 400)}`);
      object = stateObject(join(repo, root), shape.rootEnv(root, benv));
    }
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
  if ("unsupported" in object) throw new ConfigError(`state export: ${root}: ${object.unsupported.replace(READS_VERSIONS, "exports state from s3, gcs and azurerm backends and GitLab-managed state")}`);
  let location: string;
  let version = options.version;
  let download: (v: string) => Promise<string | undefined>;
  if ("gitlab" in object) {
    // GitLab keeps each version by serial: the version id is the serial.
    const gl = object.gitlab;
    const fetchFn = options.fetch ?? (globalThis.fetch as unknown as StoreFetch);
    location = object.location;
    const gitlab = async <T>(call: () => Promise<T>): Promise<T> => {
      try {
        return await call();
      } catch (e) {
        throw new ConfigError(`state export: ${(e as Error).message}`);
      }
    };
    if (!version) {
      const now = await gitlab(() => currentSerial(gl, fetchFn));
      if (!now) throw new ConfigError(`state export: ${location} holds no state`);
      version = String(now.serial);
    } else if (!/^\d+$/.test(version)) {
      throw new ConfigError(`state export: ${root}'s state is GitLab-managed, whose versions are serials; --version ${version} is not one`);
    } else if (!(await gitlab(() => hasVersion(gl, version!, fetchFn)))) {
      throw new ConfigError(`state export: ${location} has no version ${version}; GitLab keeps no version with that serial`);
    }
    download = (v) => gitlab(() => readVersion(gl, v, fetchFn));
  } else {
    if (!isStored(object)) throw new ConfigError(`state export: ${root}'s state is a local file, ${(object as { path: string }).path}, which keeps no versions; export reads a version of an s3, gcs or azurerm state by its id`);
    const store = await stateStore(object, options.fetch);
    location = store.location;
    if (!version) {
      // The version there now; an azurerm backend that keeps snapshots and no versions gets one, which names it.
      const now = await store.version(true);
      if (!now.exists) throw new ConfigError(`state export: ${location} holds no state`);
      if (!now.versionId) throw new ConfigError(`state export: ${location} keeps no versions, so there is no version id to export: ${now.off ?? "the store gave none"}`);
      version = now.versionId;
    } else if (!(await store.hasVersion(version))) {
      throw new ConfigError(`state export: ${location} has no version ${version}; a lifecycle rule may have expired it`);
    }
    download = (v) => store.readVersion(v);
  }

  const ledger = readLedger(repo, EXPORT_LEDGER);
  const doneText = spawnSync("git", ["show", `refs/remotes/origin/chant/lifecycle:${EXPORT_DONE}`], { cwd: repo, encoding: "utf-8" });
  const done = doneExports(doneText.status === 0 ? doneText.stdout : "");
  // This person's open request for this version: unexpired and not exported yet.
  const pending = (ledger.pending as ExportPending[])
    .filter((p) => p.op === EXPORT_OP && p.gate === root && p.request && p.request.by === by && p.request.version_id === version && p.request.location === location)
    .filter((p) => at(p.expiresAt) > at(now) && p.planDigest !== undefined && !done.has(p.planDigest))
    .sort((a, b) => at(b.timestamp) - at(a.timestamp))[0];

  const rule = await approvalRule(repo, { at: "HEAD", ...(configPath ? { config: configPath } : {}) });
  const sealed = rule.mode === "sealed";
  if (!pending) {
    const request: ExportRequest = { root, location, version_id: version, by, at: now };
    const digest = requestDigest(request);
    const record: ExportPending = {
      version: 1,
      kind: "pending",
      op: EXPORT_OP,
      gate: root,
      timestamp: now,
      expiresAt: new Date(at(now) + REQUEST_HOURS * 3600 * 1000).toISOString(),
      planDigest: digest,
      description: `state export: ${root} version ${version}, for ${by}`,
      request,
      neverOverMcp: true,
    };
    appendPending(repo, record, {}, EXPORT_LEDGER);
    const command = exportApproveCommand(root, digest, sealed);
    log(`state export: ${by} asks for ${root}'s state, ${location} version ${version}; request ${digest}`);
    log("someone other than you approves it with:");
    log(`  ${command}`);
    log("then run this command again to download it.");
    return { code: 3, digest, command };
  }

  const digest = pending.planDigest!;
  const command = exportApproveCommand(root, digest, sealed);
  const approvals = (ledger.resolutions as ResolutionRecord[]).filter((r) => r.gate === root && samePlanDigest(r.planDigest, digest) && at(r.timestamp) >= at(pending.timestamp));
  const counted = approvals.filter((r) => {
    if (r.resolvedBy === by) {
      log(`state export: an approval by ${by} does not count: the person who asks for an export does not approve it`);
      return false;
    }
    const refused = sealed ? sealRefusal(rule.signers, rule.signersPath, r) : null;
    if (refused) log(`state export: an approval does not count: ${refused}`);
    return refused === null;
  });
  const approval = counted.sort((a, b) => at(b.timestamp) - at(a.timestamp))[0];
  if (!approval) {
    log(`state export: request ${digest} for ${root} version ${version} waits for an approval by someone other than ${by}:`);
    log(`  ${command}`);
    return { code: 3, digest, command };
  }

  const file = outPath(repo, options.out, root, version);
  const body = await download(version);
  if (body === undefined) throw new ConfigError(`state export: ${location} has no version ${version}; it was deleted since the request`);
  const line: ExportRecord = {
    version: 1,
    kind: "state-export",
    op: EXPORT_OP,
    gate: root,
    planDigest: digest,
    root,
    location,
    version_id: version,
    exportedBy: by,
    approvedBy: approval.resolvedBy,
    approvedAt: approval.timestamp,
    timestamp: new Date().toISOString(),
    content_digest: sha(body),
  };
  // The record goes first: an export that could not be recorded is never written.
  appendLifecycle(repo, EXPORT_DONE, [JSON.stringify(line)], {}, `State exported: ${root} version ${version} for ${by}`);
  writeFileSync(file, body, { mode: 0o600, flag: "wx" });
  log(`state export: wrote ${file}: ${root}'s state, ${location} version ${version}, approved by ${approval.resolvedBy}`);
  log(`state export: recorded on chant/lifecycle in ${EXPORT_DONE}; delete the file when you are done with it`);
  return { code: 0, digest, file };
}
