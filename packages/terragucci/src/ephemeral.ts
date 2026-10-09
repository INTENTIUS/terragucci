/**
 * Ephemeral environments: each open pull request gets its own copy of the
 * roots `ephemeral.roots` names, under a state key of its own, and loses it
 * when it closes or its TTL passes.
 *
 *   terragucci ephemeral up --pr <n> --head <sha>
 *       From the pipeline's job for an opened, reopened or updated pull
 *       request. Its settings are terragucci.yml's at base (the default
 *       branch's checkout, or `--base`), never the pull request's own, so a
 *       pull request cannot name more roots or a longer TTL. The roots are
 *       the head's code, checked out apart. Each root is initialised with its
 *       backend's state key suffixed `-pr-<n>` (suffixedKey), so the copy
 *       never shares a state with the root itself. The plans wait at the gate
 *       `tf-ephemeral pr-<n>` as `gate` says, bound to their set digest; once
 *       they apply, `_gates/tf-ephemeral/done.jsonl` on chant/lifecycle
 *       records the copy, its roots, its commit and when it expires.
 *   terragucci ephemeral down --pr <n> --reason closed|expired
 *       Destroys the live copy: each root's `plan -destroy`, then the apply of
 *       that plan, in reverse order, from the commit the copy was applied
 *       from. No gate holds it: closing the pull request, or the TTL the
 *       default branch set, is the decision. The record names the reason and
 *       the destroy plans' digest, and the audit trail lists it.
 *   terragucci ephemeral sweep
 *       From the sweep schedule: destroys each live copy whose TTL passed, or
 *       whose pull request the forge says is closed or merged. On GitLab,
 *       which starts no pipeline when a merge request closes, this is how a
 *       closed merge request loses its copy.
 *
 * Why a key suffix and not a workspace: terragucci runs no CLI workspaces
 * (a root is a directory with one state; a comment's `-w` is refused), the
 * other stages read a root's state from its backend block, and a workspace
 * would put the copy in the same object namespace as the root under a name
 * only the binary resolves. A suffixed key is a state of its own that the
 * backend block, the lock file and the bucket listing all name plainly.
 *
 * With `reports` set, `ephemeral.json` beside the project's index lists the
 * live copies and their expiry, and the estate page shows them.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { waveSetDigest, type WaveMember } from "@intentius/chant/gated-waves";
import { samePlanDigest } from "@intentius/chant/lifecycle/plan-digest";
import { plannerForBinary, terraformChangeSetPart } from "@intentius/chant-lexicon-terraform/change-set";
import { appendLifecycle, appendPending, appliedPathFor, decideGate, lockTimeoutArgs, readLedger, type AppliedRecord, type GateLedger } from "./apply";
import { approvalRule } from "./approval";
import { binaryEnv } from "./binary-env";
import {
  ConfigError,
  EPHEMERAL_NOT_SYNTH,
  EPHEMERAL_NOT_TERRAGRUNT,
  EPHEMERAL_TTL,
  findConfig,
  loadConfig,
  resolveRepo,
  ttlMs,
  type ForgeName,
  type ResolvedSettings,
  type TerragucciConfig,
} from "./config";
import { applyLayers, backendBlock, detectBinary, findRoots } from "./detect";
import { call, type Fetch } from "./forge";
import { RootBinaries } from "./pins";
import { storeFromEnv } from "./report/bucket";
import { targetFromEnv } from "./report/drift";
import { configAtBase } from "./report/policy";
import { runFacts } from "./report/stage";
import { updateJson } from "./report/store";
import { rootRoleEnv } from "./roles";
import { sealRefusal } from "./seal";
import { detectTerragrunt } from "./terragrunt";

export const EPHEMERAL_OP = "tf-ephemeral";
export const EPHEMERAL_LEDGER = `_gates/${EPHEMERAL_OP}.jsonl`;
/** Beside the ledger, out of chant's sight: one line per apply and per destroy of a copy. */
export const EPHEMERAL_DONE = `_gates/${EPHEMERAL_OP}/done.jsonl`;
/** The live copies, beside the project's index in the reports bucket. */
export const EPHEMERAL_FILE = "ephemeral.json";
export const EPHEMERAL_SCHEMA = "terragucci.ephemeral/v1";

/** Exit codes, as the waves give them. */
export const EPHEMERAL_EXIT = { done: 0, failed: 1, waiting: 3, refused: 4 } as const;

/** The gate of a pull request's copy, and the suffix of its state keys. */
export const ephemeralGate = (pr: number): string => `pr-${pr}`;
export const ephemeralSuffix = (pr: number): string => `pr-${pr}`;

/** The command that approves a copy's plans. */
export const ephemeralApproveCommand = (pr: number, digest: string, sealed = false): string => `chant approve ${EPHEMERAL_OP} ${ephemeralGate(pr)} --plan ${digest}${sealed ? " --sign" : ""}`;

/**
 * A state key with the suffix: before a closing `.tfstate`, else at the end.
 * `envs/dev/terraform.tfstate` becomes `envs/dev/terraform-pr-7.tfstate`; a
 * gcs prefix `envs/dev` becomes `envs/dev-pr-7`.
 */
export function suffixedKey(key: string, suffix: string): string {
  const k = key.replace(/\/+$/, "");
  return /\.tfstate$/.test(k) ? k.replace(/\.tfstate$/, `-${suffix}.tfstate`) : `${k}-${suffix}`;
}

/** The backends whose state key a copy can be given, and the attribute that holds it. */
export const KEY_ATTRIBUTE: Record<string, string> = { s3: "key", azurerm: "key", gcs: "prefix", local: "path" };

/** The `-backend-config` a root's copy is initialised with: its backend's key attribute, suffixed. Throws ConfigError for a root no copy can be made of. */
export function copyBackend(dir: string, root: string, suffix: string): { type: string; attribute: string; key: string; location: string } {
  const b = backendBlock(dir);
  if (b && "cloud" in b) throw new ConfigError(`${root} keeps its state in HCP Terraform (a cloud block), where a state is a workspace and not a key; ephemeral copies roots whose backend is ${Object.keys(KEY_ATTRIBUTE).join(", ")}`);
  const type = b?.type ?? "local";
  const attribute = KEY_ATTRIBUTE[type];
  if (!attribute) throw new ConfigError(`${root}'s backend is ${type}, and ephemeral gives a copy its own state key on ${Object.keys(KEY_ATTRIBUTE).join(", ")} backends only`);
  const given = b?.attrs[attribute] ?? (type === "local" ? "terraform.tfstate" : undefined);
  if (!given) throw new ConfigError(`${root}'s ${type} backend block names no ${attribute}, so there is no key to give its copy a suffix; write the ${attribute} in the block`);
  const key = suffixedKey(given, suffix);
  const location = type === "s3" && b?.attrs.bucket ? `s3://${b.attrs.bucket}/${key}` : type === "gcs" && b?.attrs.bucket ? `gs://${b.attrs.bucket}/${key}` : type === "azurerm" && b?.attrs.container_name ? `${b.attrs.storage_account_name ?? "azure"}/${b.attrs.container_name}/${key}` : key;
  return { type, attribute, key, location };
}

/** One line of done.jsonl: a copy applied, or destroyed. */
export interface EphemeralRecord {
  version: 1;
  kind: "ephemeral-apply" | "ephemeral-destroy";
  op: typeof EPHEMERAL_OP;
  gate: string;
  pr: number;
  suffix: string;
  roots: { root: string; location: string; result: "applied" | "destroyed" | "failed" }[];
  /** The set digest of the plans applied: the copy's plans, or the destroy's. */
  planDigest: string;
  /** Who: the actor the forge names for the job, or terragucci for the sweep. */
  by: string;
  timestamp: string;
  result: "applied" | "destroyed" | "failed";
  /** The head the copy was applied from; a destroy runs that code too. */
  commit: string;
  /** An apply: when the copy expires. */
  expiresAt?: string;
  /** An apply under an approval: who approved its plans. */
  approvedBy?: string;
  /** A destroy: why. */
  reason?: "closed" | "expired";
  runId?: string;
}

/** A pull request's copy, as the record says it stands. */
export interface LiveEnvironment {
  pr: number;
  suffix: string;
  roots: string[];
  locations: Record<string, string>;
  commit: string;
  applied: string;
  expiresAt: string;
  approvedBy?: string;
  /** Its last destroy failed, so it is still live and the sweep tries again. */
  destroyFailed?: boolean;
}

/** The records of a done.jsonl text. Malformed lines are skipped. */
export function parseEphemeral(text: string): EphemeralRecord[] {
  const out: EphemeralRecord[] = [];
  for (const line of text.split("\n").map((l) => l.trim()).filter(Boolean)) {
    try {
      const r = JSON.parse(line) as EphemeralRecord;
      if (r.version === 1 && (r.kind === "ephemeral-apply" || r.kind === "ephemeral-destroy") && typeof r.pr === "number" && Array.isArray(r.roots)) out.push(r);
    } catch {
      continue;
    }
  }
  return out;
}

/**
 * The copies that stand, by pull request, from the records in order: an
 * apply makes or refreshes one, a destroy that destroyed every root ends it,
 * and a destroy that failed leaves it live.
 */
export function liveEnvironments(records: readonly EphemeralRecord[]): Map<number, LiveEnvironment> {
  const live = new Map<number, LiveEnvironment>();
  for (const r of records) {
    if (r.kind === "ephemeral-apply") {
      const was = live.get(r.pr);
      const roots = [...new Set([...(was?.roots ?? []), ...r.roots.map((x) => x.root)])];
      live.set(r.pr, {
        pr: r.pr,
        suffix: r.suffix,
        roots,
        locations: { ...(was?.locations ?? {}), ...Object.fromEntries(r.roots.map((x) => [x.root, x.location])) },
        commit: r.commit,
        applied: r.timestamp,
        expiresAt: r.expiresAt ?? r.timestamp,
        ...(r.approvedBy ? { approvedBy: r.approvedBy } : {}),
      });
    } else if (r.result === "destroyed") {
      live.delete(r.pr);
    } else {
      const was = live.get(r.pr);
      if (was) live.set(r.pr, { ...was, destroyFailed: true });
    }
  }
  return live;
}

// ── running the binary ───────────────────────────────────────────────────

export type EphemeralExec = (binary: string, args: string[], dir: string, env: NodeJS.ProcessEnv) => { status: number; stdout: string; out: string };

const runBinary: EphemeralExec = (binary, args, dir, env) => {
  const p = spawnSync(binary, [`-chdir=${dir}`, ...args], { encoding: "utf-8", env: binaryEnv(env), maxBuffer: 512 * 1024 * 1024 });
  return { status: p.status ?? 1, stdout: p.stdout ?? "", out: `${p.stdout ?? ""}${p.stderr ?? ""}${p.error ? p.error.message : ""}` };
};

const tail = (s: string, n = 20): string => s.trim().split("\n").slice(-n).join("\n");

function git(repo: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const p = spawnSync("git", args, { cwd: repo, encoding: "utf-8" });
  return { status: p.status ?? 1, stdout: (p.stdout ?? "").trim(), stderr: (p.stderr ?? "").trim() };
}

/** The ref a forge keeps a pull request's head under. */
export const pullRef = (forge: ForgeName, pr: number): string => (forge === "gitlab" ? `refs/merge-requests/${pr}/head` : `refs/pull/${pr}/head`);

/**
 * A detached worktree at `commit`, the code of pull request `pr`: fetched
 * from the forge's pull request ref when the checkout lacks it. Falls back to
 * the ref's head when the commit is gone (a force push), saying so.
 */
function checkoutPull(repo: string, forge: ForgeName, pr: number, commit: string | undefined, log: (l: string) => void): { dir: string; commit: string; done: () => void } {
  const has = (c: string): boolean => git(repo, ["cat-file", "-e", `${c}^{commit}`]).status === 0;
  const local = `refs/terragucci/ephemeral/${pr}`;
  let head: string | undefined;
  if (!commit || !has(commit)) {
    const f = git(repo, ["fetch", "-q", "origin", `+${pullRef(forge, pr)}:${local}`]);
    if (f.status === 0) head = git(repo, ["rev-parse", local]).stdout;
    if (commit && !has(commit)) git(repo, ["fetch", "-q", "origin", commit]);
  }
  let at = commit;
  if (!at || !has(at)) {
    if (!head) throw new ConfigError(`the code of pull request ${pr} could not be fetched (${pullRef(forge, pr)}${commit ? ` or ${commit}` : ""})`);
    if (commit) log(`pull request ${pr}: ${commit.slice(0, 8)} is gone from origin, so its copy is destroyed from the pull request's head ${head.slice(0, 8)}`);
    at = head;
  }
  const dir = join(mkdtempSync(join(tmpdir(), "terragucci-ephemeral-")), "tree");
  const w = git(repo, ["worktree", "add", "-q", "--detach", dir, at]);
  if (w.status !== 0) throw new ConfigError(`could not check out ${at} for pull request ${pr}: ${w.stderr}`);
  return {
    dir,
    commit: at,
    done: () => {
      if (git(repo, ["worktree", "remove", "--force", dir]).status !== 0) rmSync(dir, { recursive: true, force: true });
    },
  };
}

interface CopyPlan {
  root: string;
  binary: string;
  env: NodeJS.ProcessEnv;
  location: string;
  planFile: string;
  member?: WaveMember;
  changes: number;
  destroys: number;
  error?: string;
}

/** Init a root's copy under its suffixed key and plan it (a destroy with `destroy`). */
async function planCopy(code: string, root: string, suffix: string, binaries: RootBinaries, work: string, i: number, env: NodeJS.ProcessEnv, exec: EphemeralExec, destroy: boolean): Promise<CopyPlan> {
  const dir = join(code, root);
  const rootEnv = rootRoleEnv(env, root);
  const planFile = join(work, `${i}.tfplan`);
  const backend = copyBackend(dir, root, suffix);
  const base = { root, binary: binaries.binary, env: rootEnv, location: backend.location, planFile, changes: 0, destroys: 0 };
  let binary: string;
  try {
    binary = (await binaries.resolve(root)).path;
  } catch (e) {
    return { ...base, error: (e as Error).message };
  }
  const init = exec(binary, ["init", "-input=false", "-no-color", "-reconfigure", `-backend-config=${backend.attribute}=${backend.key}`], dir, rootEnv);
  if (init.status !== 0) return { ...base, binary, error: `init failed\n${tail(init.out)}` };
  const plan = exec(binary, ["plan", "-input=false", "-no-color", ...lockTimeoutArgs("plan", rootEnv), ...(destroy ? ["-destroy"] : []), `-out=${planFile}`], dir, rootEnv);
  if (plan.status !== 0) return { ...base, binary, error: `plan failed\n${tail(plan.out)}` };
  const show = exec(binary, ["show", "-json", planFile], dir, rootEnv);
  let json: unknown;
  try {
    json = JSON.parse(show.stdout);
  } catch {
    return { ...base, binary, error: `show -json printed no plan\n${tail(show.out)}` };
  }
  const part = terraformChangeSetPart({ member: root, plan: json, planner: plannerForBinary(binary) });
  const changed = part.entries.filter((e) => e.action !== "no-op" && e.action !== "read");
  return {
    ...base,
    binary,
    member: { member: root, planDigest: part.member.planDigest ?? "" },
    changes: changed.length,
    destroys: changed.filter((e) => e.action === "delete" || e.action === "replace").length,
  };
}

// ── settings ──────────────────────────────────────────────────────────────

export interface EphemeralOptions {
  config?: string;
  /** The ref terragucci.yml is read from. Default: the checkout's own, which is the default branch's in the pipeline's jobs. */
  base?: string;
  binary?: string;
  /** Who the record names. Default: the forge's actor for the job, else terragucci. */
  actor?: string;
  env?: NodeJS.ProcessEnv;
  now?: string;
  /** The forge's HTTP calls (the sweep's pull request states), for tests. */
  fetch?: Fetch;
  exec?: EphemeralExec;
  log?: (line: string) => void;
}

interface Ready {
  settings: ResolvedSettings;
  roots: string[];
  ttl: number;
  forge: ForgeName;
  binary: string;
  configPath?: string;
  env: NodeJS.ProcessEnv;
  log: (l: string) => void;
  exec: EphemeralExec;
  actor: string;
}

/** The settings at base, refused as a config error where a copy cannot be made. */
async function ready(repo: string, options: EphemeralOptions): Promise<Ready> {
  const env = options.env ?? process.env;
  const log = options.log ?? ((l: string) => console.log(l));
  const configPath = options.config ?? findConfig(repo);
  let config: TerragucciConfig;
  if (options.base) {
    const read = await configAtBase(repo, options.base, configPath ? { config: configPath } : {});
    if ("error" in read) throw new ConfigError(`ephemeral is read from terragucci.yml at ${options.base}, and it could not be read (${read.error})`);
    config = read.config;
  } else {
    config = configPath ? await loadConfig(resolve(configPath)) : {};
  }
  if (config.projects) throw new ConfigError("ephemeral runs in a project's own checkout, not a control repo");
  const settings = resolveRepo(config);
  const e = settings.ephemeral;
  if (!e || !Array.isArray(e.roots) || e.roots.length === 0) throw new ConfigError(`terragucci.yml${options.base ? ` at ${options.base}` : ""} names no ephemeral roots; set ephemeral.roots`);
  if (settings.terragrunt !== undefined || detectTerragrunt(repo)) throw new ConfigError(`ephemeral: ${EPHEMERAL_NOT_TERRAGRUNT}`);
  if (settings.synth) throw new ConfigError(`ephemeral: ${EPHEMERAL_NOT_SYNTH}`);
  const forge: ForgeName = settings.forge ?? (env.GITLAB_CI === "true" ? "gitlab" : env.GITEA_ACTIONS === "true" || env.FORGEJO_ACTIONS === "true" ? "forgejo" : "github");
  const binary = options.binary ?? settings.binary ?? detectBinary(repo, findRoots(repo, e.roots)).value;
  const actor = options.actor || env.GITHUB_ACTOR || env.GITLAB_USER_LOGIN || "terragucci";
  return { settings, roots: e.roots, ttl: ttlMs(e.ttl ?? EPHEMERAL_TTL) ?? ttlMs(EPHEMERAL_TTL)!, forge, binary, ...(configPath ? { configPath } : {}), env, log, exec: options.exec ?? runBinary, actor };
}

function readRecords(repo: string): EphemeralRecord[] {
  // readLedger fetches chant/lifecycle; the done file is read from the ref it left.
  readLedger(repo, EPHEMERAL_LEDGER);
  const show = git(repo, ["show", `refs/remotes/origin/chant/lifecycle:${EPHEMERAL_DONE}`]);
  return show.status === 0 ? parseEphemeral(show.stdout) : [];
}

/** The live copies of this repository, as chant/lifecycle on origin records them. */
export function readLive(repo: string): Map<number, LiveEnvironment> {
  return liveEnvironments(readRecords(repo));
}

// ── the bucket's list, for the estate page ───────────────────────────────

export interface EphemeralList {
  schema: typeof EPHEMERAL_SCHEMA;
  project: string;
  updated: string;
  environments: EphemeralRow[];
}

export interface EphemeralRow {
  pull_request: number;
  pull_request_url?: string;
  suffix: string;
  roots: { root: string; location: string }[];
  commit: string;
  applied: string;
  expires: string;
  approved_by?: string;
  /** `live`, or `destroy-failed` when a destroy of it failed and the sweep tries again. */
  status: "live" | "destroy-failed";
}

/** The list with `pr`'s row replaced by `row`, or dropped when `row` is undefined. */
export function updateList(existing: string | undefined, project: string, pr: number, row: EphemeralRow | undefined, now: string): EphemeralList {
  let rows: EphemeralRow[] = [];
  try {
    const was = existing ? (JSON.parse(existing) as Partial<EphemeralList>) : undefined;
    if (was && was.schema === EPHEMERAL_SCHEMA && Array.isArray(was.environments)) rows = was.environments;
  } catch {
    rows = [];
  }
  rows = rows.filter((r) => r.pull_request !== pr);
  if (row) rows.push(row);
  rows.sort((a, b) => a.pull_request - b.pull_request);
  return { schema: EPHEMERAL_SCHEMA, project, updated: now, environments: rows };
}

/** `<prefix>/<project>/ephemeral.json`. */
export const ephemeralKey = (project: string, prefix = ""): string => [prefix, project, EPHEMERAL_FILE].map((p) => p.replace(/^\/+|\/+$/g, "")).filter(Boolean).join("/");

export function rowOf(e: LiveEnvironment, prUrl?: string): EphemeralRow {
  return {
    pull_request: e.pr,
    ...(prUrl ? { pull_request_url: prUrl } : {}),
    suffix: e.suffix,
    roots: e.roots.map((root) => ({ root, location: e.locations[root] ?? "" })),
    commit: e.commit,
    applied: e.applied,
    expires: e.expiresAt,
    ...(e.approvedBy ? { approved_by: e.approvedBy } : {}),
    status: e.destroyFailed ? "destroy-failed" : "live",
  };
}

async function writeList(repo: string, r: Ready, pr: number, row: EphemeralRow | undefined, now: string): Promise<void> {
  const reports = r.settings.reports;
  if (!reports?.bucket) return;
  const project = runFacts(repo, r.env, r.forge).project;
  const key = ephemeralKey(project, reports.prefix ?? "");
  try {
    await updateJson(storeFromEnv(reports, r.env), key, (body) => updateList(body, project, pr, row, now), "the ephemeral environments");
    r.log(`pull request ${pr}: ${key} in ${reports.bucket} ${row ? `lists its copy, expiring ${row.expires}` : "no longer lists a copy"}`);
  } catch (e) {
    r.log(`pull request ${pr}: ${key} was not written to ${reports.bucket}: ${(e as Error).message}`);
  }
}

// ── up ────────────────────────────────────────────────────────────────────

export interface UpOptions extends EphemeralOptions {
  pr: number;
  /** The pull request's head. Default: the forge's pull request ref. */
  head?: string;
}

/**
 * Apply pull request `pr`'s copy of the ephemeral roots from its head, behind
 * the gate as `gate` at base says. Returns the exit code.
 */
export async function ephemeralUp(repo: string, options: UpOptions): Promise<number> {
  const r = await ready(repo, options);
  const { pr } = options;
  const label = `pull request ${pr}`;
  const suffix = ephemeralSuffix(pr);
  const code = checkoutPull(repo, r.forge, pr, options.head, r.log);
  const work = mkdtempSync(join(tmpdir(), "terragucci-ephemeral-plans-"));
  try {
    const found = findRoots(code.dir, r.roots);
    if (found.length === 0) {
      r.log(`${label}: no root at ${code.commit.slice(0, 8)} matches ephemeral.roots (${r.roots.join(", ")}), so it gets no copy`);
      return EPHEMERAL_EXIT.done;
    }
    const roots = applyLayers(code.dir, found).flat();
    r.log(`${label}: its copy of ${roots.join(", ")} under the state keys suffixed -${suffix}, from ${code.commit.slice(0, 8)}`);
    const binaries = new RootBinaries(code.dir, r.binary, r.settings.version, r.env);
    const plans: CopyPlan[] = [];
    for (const [i, root] of roots.entries()) {
      const p = await planCopy(code.dir, root, suffix, binaries, work, i, r.env, r.exec, false);
      plans.push(p);
      r.log(p.error ? `${root}: ${p.error}` : `${root}: ${p.changes} to change at ${p.location}`);
    }
    const failed = plans.filter((p) => p.error);
    if (failed.length > 0) {
      r.log(`${label}: ${failed.map((p) => p.root).join(", ")} did not plan, so nothing of the copy applies`);
      return EPHEMERAL_EXIT.failed;
    }
    const members = plans.map((p) => p.member!);
    const digest = waveSetDigest(members);
    const changes = plans.reduce((n, p) => n + p.changes, 0);
    const destroys = plans.reduce((n, p) => n + p.destroys, 0);
    const now = options.now ?? new Date().toISOString();
    const live = readLive(repo).get(pr);
    if (changes === 0) {
      r.log(`${label}: its copy has nothing to change${live ? `; it expires ${live.expiresAt}` : ""}`);
      if (live) return EPHEMERAL_EXIT.done;
    }
    const gate = r.settings.gate;
    const gated = changes > 0 && (gate === "always" || (gate === "on-destroy" && destroys > 0));
    const name = ephemeralGate(pr);
    let approvedBy: string | undefined;
    if (gated) {
      const rule = await approvalRule(repo, { at: options.base ?? "HEAD", ...(r.configPath ? { config: r.configPath } : {}) });
      const sealed = rule.mode === "sealed";
      let ledger: GateLedger = readLedger(repo, EPHEMERAL_LEDGER);
      if (sealed) {
        ledger = {
          ...ledger,
          resolutions: ledger.resolutions.filter((x) => {
            if (x.gate !== name) return true;
            const why = sealRefusal(rule.signers, rule.signersPath, x);
            if (why !== null && samePlanDigest(x.planDigest, digest)) r.log(`${label}: an approval does not count: ${why}`);
            return why === null;
          }),
        };
      }
      const decision = decideGate(ledger, name, digest, now);
      const command = ephemeralApproveCommand(pr, digest, sealed);
      if (decision.status !== "approved") {
        if (!decision.standing) {
          appendPending(repo, {
            version: 1,
            kind: "pending",
            op: EPHEMERAL_OP,
            gate: name,
            timestamp: now,
            expiresAt: new Date(Date.parse(now) + 48 * 3600 * 1000).toISOString(),
            planDigest: digest,
            description: `${label}'s ephemeral copy: ${roots.join(", ")}`,
            commit: code.commit,
            members,
            neverOverMcp: true,
          }, {}, EPHEMERAL_LEDGER);
        }
        if (decision.status === "refused") {
          r.log(`${label}: ${decision.by} approved ${decision.approved ?? "another digest"}, and its copy planned differently since, so nothing applied. Approve these plans with:`);
          r.log(`  ${command}`);
          return EPHEMERAL_EXIT.refused;
        }
        r.log(`${label}: its copy waits for an approval of digest ${digest} (gate: ${gate}). Read its plans above, then approve them with:`);
        r.log(`  ${command}`);
        r.log("Then run the pull request's ephemeral job again, or push to it.");
        return EPHEMERAL_EXIT.waiting;
      }
      approvedBy = decision.by;
      r.log(`${label}: approved by ${decision.by} for this digest`);
      const used: AppliedRecord = { version: 1, kind: "applied", op: EPHEMERAL_OP, gate: name, planDigest: digest, approvedAt: decision.at, approvedBy: decision.by, timestamp: now, commit: code.commit };
      appendLifecycle(repo, appliedPathFor(EPHEMERAL_LEDGER), [JSON.stringify(used)], {}, `Applied under approval: ${EPHEMERAL_OP} ${name}`);
    }
    const results: EphemeralRecord["roots"] = [];
    for (const p of plans) {
      const a = r.exec(p.binary, ["apply", "-input=false", "-no-color", ...lockTimeoutArgs("apply", p.env), p.planFile], join(code.dir, p.root), p.env);
      results.push({ root: p.root, location: p.location, result: a.status === 0 ? "applied" : "failed" });
      r.log(a.status === 0 ? `applied ${p.root} at ${p.location}` : `FAILED ${p.root}\n${tail(a.out)}`);
      if (a.status !== 0) break;
    }
    const ok = results.length === plans.length && results.every((x) => x.result === "applied");
    const expiresAt = new Date(Date.parse(now) + r.ttl).toISOString();
    const runId = r.env.GITHUB_RUN_ID ?? r.env.CI_PIPELINE_ID;
    const record: EphemeralRecord = {
      version: 1,
      kind: "ephemeral-apply",
      op: EPHEMERAL_OP,
      gate: name,
      pr,
      suffix,
      roots: results,
      planDigest: digest,
      by: r.actor,
      timestamp: now,
      result: ok ? "applied" : "failed",
      commit: code.commit,
      expiresAt,
      ...(approvedBy ? { approvedBy } : {}),
      ...(runId ? { runId } : {}),
    };
    // A copy that failed part way is live too: what applied is destroyed on close or at expiry like the rest.
    appendLifecycle(repo, EPHEMERAL_DONE, [JSON.stringify(record)], {}, `Ephemeral copy of pull request ${pr} ${ok ? "applied" : "failed"}`);
    r.log(`${label}: ${ok ? "its copy applied" : "its copy failed part way"}; it expires ${expiresAt}, and closing the pull request destroys it before then`);
    const now2 = liveEnvironments([...readRecords(repo)]).get(pr);
    if (now2) await writeList(repo, r, pr, rowOf(now2, runFacts(repo, { ...r.env, TG_PR: String(pr) }, r.forge).pull_request_url), now);
    return ok ? EPHEMERAL_EXIT.done : EPHEMERAL_EXIT.failed;
  } finally {
    code.done();
    rmSync(work, { recursive: true, force: true });
  }
}

// ── down ──────────────────────────────────────────────────────────────────

export interface DownOptions extends EphemeralOptions {
  pr: number;
  reason: "closed" | "expired";
}

/** Destroy pull request `pr`'s live copy through a planned destroy, and record it. No copy: nothing to do. */
export async function ephemeralDown(repo: string, options: DownOptions): Promise<number> {
  const r = await ready(repo, options);
  return destroyCopy(repo, r, options.pr, options.reason, options.now);
}

async function destroyCopy(repo: string, r: Ready, pr: number, reason: "closed" | "expired", at?: string): Promise<number> {
  const label = `pull request ${pr}`;
  const live = readLive(repo).get(pr);
  if (!live) {
    r.log(`${label} has no live ephemeral copy, so there is nothing to destroy`);
    return EPHEMERAL_EXIT.done;
  }
  r.log(`${label}: destroying its copy of ${live.roots.join(", ")} (${reason === "closed" ? "the pull request closed" : `its TTL passed at ${live.expiresAt}`}), from ${live.commit.slice(0, 8)}`);
  const code = checkoutPull(repo, r.forge, pr, live.commit, r.log);
  const work = mkdtempSync(join(tmpdir(), "terragucci-ephemeral-plans-"));
  try {
    const binaries = new RootBinaries(code.dir, r.binary, r.settings.version, r.env);
    const results: EphemeralRecord["roots"] = [];
    const members: WaveMember[] = [];
    // Later roots read earlier ones' state, so the copy is destroyed in reverse.
    const roots = [...live.roots].reverse();
    for (const [i, root] of roots.entries()) {
      const location = live.locations[root] ?? "";
      if (!existsSync(join(code.dir, root))) {
        r.log(`FAILED ${root}: the directory is gone from ${code.commit.slice(0, 8)}, so its copy at ${location} cannot be planned`);
        results.push({ root, location, result: "failed" });
        continue;
      }
      let p: CopyPlan;
      try {
        p = await planCopy(code.dir, root, live.suffix, binaries, work, i, r.env, r.exec, true);
      } catch (e) {
        r.log(`FAILED ${root}: ${(e as Error).message}`);
        results.push({ root, location, result: "failed" });
        continue;
      }
      if (p.error) {
        r.log(`FAILED ${root}: ${p.error}`);
        results.push({ root, location: p.location, result: "failed" });
        continue;
      }
      members.push(p.member!);
      r.log(`${root}: the destroy plan removes ${p.destroys} at ${p.location}`);
      const a = r.exec(p.binary, ["apply", "-input=false", "-no-color", ...lockTimeoutArgs("apply", p.env), p.planFile], join(code.dir, root), p.env);
      results.push({ root, location: p.location, result: a.status === 0 ? "destroyed" : "failed" });
      r.log(a.status === 0 ? `destroyed ${root}'s copy at ${p.location}` : `FAILED ${root}\n${tail(a.out)}`);
    }
    const ok = results.every((x) => x.result === "destroyed");
    const now = at ?? new Date().toISOString();
    const runId = r.env.GITHUB_RUN_ID ?? r.env.CI_PIPELINE_ID;
    const record: EphemeralRecord = {
      version: 1,
      kind: "ephemeral-destroy",
      op: EPHEMERAL_OP,
      gate: ephemeralGate(pr),
      pr,
      suffix: live.suffix,
      roots: results,
      planDigest: members.length ? waveSetDigest(members) : "",
      by: r.actor,
      timestamp: now,
      result: ok ? "destroyed" : "failed",
      commit: code.commit,
      reason,
      ...(runId ? { runId } : {}),
    };
    appendLifecycle(repo, EPHEMERAL_DONE, [JSON.stringify(record)], {}, `Ephemeral copy of pull request ${pr} ${ok ? "destroyed" : "not wholly destroyed"} (${reason})`);
    r.log(ok ? `${label}: its copy is destroyed, recorded in ${EPHEMERAL_DONE} on chant/lifecycle` : `${label}: its copy was not wholly destroyed; it stays live, and the next sweep tries again`);
    await writeList(repo, r, pr, ok ? undefined : rowOf({ ...live, destroyFailed: true }), now);
    return ok ? EPHEMERAL_EXIT.done : EPHEMERAL_EXIT.failed;
  } finally {
    code.done();
    rmSync(work, { recursive: true, force: true });
  }
}

// ── sweep ─────────────────────────────────────────────────────────────────

/** Whether the forge says pull request `pr` is closed or merged. Undefined when it cannot be read. */
async function closed(fetchFn: Fetch, r: Ready, pr: number): Promise<boolean | undefined> {
  const t = targetFromEnv(r.forge, r.env, r.env.TG_TOKEN, true);
  if (!t) return undefined;
  try {
    if (t.forge === "gitlab") {
      const mr = (await call(fetchFn, t, "GET", `/projects/${encodeURIComponent(t.path)}/merge_requests/${pr}`)) as { state?: string };
      return mr.state === "closed" || mr.state === "merged";
    }
    const p = (await call(fetchFn, t, "GET", `/repos/${t.path}/pulls/${pr}`)) as { state?: string; merged?: boolean };
    return p.state === "closed" || p.merged === true;
  } catch (e) {
    r.log(`pull request ${pr}: its state could not be read (${(e as Error).message}); its TTL still holds`);
    return undefined;
  }
}

/** Destroy every live copy whose TTL passed or whose pull request closed. Returns the worst exit code. */
export async function ephemeralSweep(repo: string, options: EphemeralOptions = {}): Promise<number> {
  const r = await ready(repo, options);
  const now = options.now ?? new Date().toISOString();
  const live = [...readLive(repo).values()];
  if (live.length === 0) {
    r.log("no ephemeral copy is live");
    return EPHEMERAL_EXIT.done;
  }
  const fetchFn = options.fetch ?? (globalThis.fetch as unknown as Fetch);
  let code: number = EPHEMERAL_EXIT.done;
  for (const e of live) {
    const expired = Date.parse(e.expiresAt) <= Date.parse(now);
    const reason = expired ? "expired" : (await closed(fetchFn, r, e.pr)) ? "closed" : undefined;
    if (!reason) {
      r.log(`pull request ${e.pr}: its copy stays; it expires ${e.expiresAt}`);
      continue;
    }
    const c = await destroyCopy(repo, r, e.pr, reason, now);
    if (c !== EPHEMERAL_EXIT.done) code = EPHEMERAL_EXIT.failed;
  }
  return code;
}
