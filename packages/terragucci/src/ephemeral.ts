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
 * A Terragrunt unit's key comes from its `remote_state` block, which
 * terragucci does not rewrite: the block's key reads
 * `get_env("TERRAGUCCI_EPHEMERAL_SUFFIX", "")`, which is empty everywhere but
 * here, where it is `-pr-<n>` (the terragucci.hcl that `generate` writes does
 * this for every unit). Each unit is prepared by Terragrunt (`terragrunt run
 * -- init`) with the suffix set, so a `dependency` block reads the copy of its
 * upstream too, and before anything plans the backend the binary was
 * initialised with must carry the suffix: a key that does not is refused, so
 * a copy never plans, applies or destroys at a unit's own key.
 *
 * With `synth` the roots are not in git: the synth command runs in the head's
 * checkout, as every other job runs it, before the roots are found, and again
 * in the applied commit's checkout before a destroy.
 *
 * With `reports` set, `ephemeral.json` beside the project's index lists the
 * live copies and their expiry, and the estate page shows them.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
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
  EPHEMERAL_TTL,
  findConfig,
  loadConfig,
  resolveRepo,
  ttlMs,
  type Binary,
  type ForgeName,
  type ResolvedSettings,
  type TerragucciConfig,
} from "./config";
import { applyLayers, backendBlock, findRoots, globMatch } from "./detect";
import { detectShape, type Shape } from "./shape";
import { call, type Fetch } from "./forge";
import { isGitLabAddress, shownUrl, suffixedGitLabAddress } from "./gitlab-state";
import { unitPlace } from "./migrate";
import { RootBinaries } from "./pins";
import { storeFromEnv } from "./report/bucket";
import { targetFromEnv } from "./report/drift";
import { configAtBase } from "./report/policy";
import { runFacts } from "./report/stage";
import { updateJson } from "./report/store";
import { rootRoleEnv } from "./roles";
import { sealRefusal } from "./seal";
import { discoverUnits, generateStacks, unitWaves } from "./terragrunt";

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

/**
 * The backends whose state key a copy can be given, and the attribute that
 * holds it. An http backend's is its address, when that is a GitLab
 * project's state API: the copy is the state named `<name>-pr-<n>`, which
 * GitLab creates on its first write, and its lock and unlock addresses
 * (HTTP_LOCK_ATTRIBUTES) take the same name.
 */
export const KEY_ATTRIBUTE: Record<string, string> = { s3: "key", azurerm: "key", gcs: "prefix", local: "path", http: "address" };

/** The http backend's attributes that name the state too: its lock's, `<address>/lock` on GitLab. */
export const HTTP_LOCK_ATTRIBUTES = ["lock_address", "unlock_address"] as const;

/**
 * A GitLab-managed state's attributes for its copy: the address and each
 * lock address with the state name suffixed. Each is the given one, else
 * its `TF_HTTP_*` variable, as the binary reads it; `-backend-config` then
 * names the copy's, over the variable. Throws ConfigError for an address
 * that is not GitLab's state API.
 */
export function gitlabCopy(root: string, attrs: Record<string, string>, env: NodeJS.ProcessEnv, suffix: string): { key: string; extra: Record<string, string> } {
  const given = (name: string): string | undefined => attrs[name] || env[`TF_HTTP_${name.toUpperCase()}`] || undefined;
  const address = given("address");
  if (!address) throw new ConfigError(`${root}'s http backend names no address, in the block or TF_HTTP_ADDRESS, so there is no state name to give its copy a suffix`);
  const key = suffixedGitLabAddress(address, suffix);
  if (!key) throw new ConfigError(`${root}'s http backend address ${shownUrl(address)} is not a GitLab project's state API (.../projects/<id>/terraform/state/<name>), and ephemeral gives an http backend's copy its own state on GitLab-managed state only`);
  const extra: Record<string, string> = {};
  for (const name of HTTP_LOCK_ATTRIBUTES) {
    const v = given(name);
    if (!v) continue;
    const suffixed = suffixedGitLabAddress(v, suffix);
    if (!suffixed || suffixedGitLabAddress(v.replace(/\/lock\/?$/, ""), suffix) !== key) throw new ConfigError(`${root}'s http backend ${name} ${shownUrl(v)} is not the lock of its state, ${shownUrl(address)}/lock, so its copy's lock could not be named`);
    extra[name] = suffixed;
  }
  return { key, extra };
}

/**
 * The variable a Terragrunt unit's `remote_state` key reads for the copy's
 * suffix: `-pr-<n>` while a copy plans, applies or is destroyed, and unset
 * (so empty) in every other job.
 */
export const EPHEMERAL_SUFFIX_ENV = "TERRAGUCCI_EPHEMERAL_SUFFIX";

/** What a unit's remote_state key adds to read the suffix: `get_env("TERRAGUCCI_EPHEMERAL_SUFFIX", "")`. */
export const SUFFIX_READ = `get_env("${EPHEMERAL_SUFFIX_ENV}", "")`;

/** How to make a Terragrunt repo's keys take the suffix, for an error that says they do not. */
export const SUFFIX_HOW = `make the remote_state block's key read the suffix, as in key = "\${path_relative_to_include()}/terraform\${${SUFFIX_READ}}.tfstate", or let terragucci generate write the backend into terragucci.hcl, which does`;

/**
 * Whether the remote_state blocks of a Terragrunt repo read the suffix: some
 * `.hcl` file holds a remote_state block, and every one that does names
 * TERRAGUCCI_EPHEMERAL_SUFFIX. The prepared backend is checked again per unit
 * (unitBackend), so this is the early, plain refusal.
 */
export function remoteStateReadsSuffix(repo: string): { ok: true } | { ok: false; why: string } {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (name.startsWith(".") || name === "node_modules") continue;
      const abs = join(dir, name);
      if (statSync(abs).isDirectory()) walk(abs);
      else if (name.endsWith(".hcl")) files.push(abs);
    }
  };
  walk(repo);
  const blocks = files.filter((f) => /^\s*remote_state\s*\{/m.test(readFileSync(f, "utf-8").replace(/(^|[^:"$])(#|\/\/).*$/gm, "$1")));
  if (blocks.length === 0) return { ok: false, why: "no .hcl file in the repo holds a remote_state block, so no unit's key can take the suffix" };
  const missing = blocks.filter((f) => !readFileSync(f, "utf-8").includes(EPHEMERAL_SUFFIX_ENV)).map((f) => f.slice(repo.length + 1));
  return missing.length ? { ok: false, why: `the remote_state block in ${missing.join(", ")} does not read ${EPHEMERAL_SUFFIX_ENV}, so a copy would plan at the unit's own key` } : { ok: true };
}

/**
 * The backend the binary was initialised with in a prepared unit's working
 * directory, from `.terraform/terraform.tfstate`: its type, the attribute
 * that holds the key, the key, and where that is. Undefined when there is none.
 */
export function unitBackend(dir: string, env: NodeJS.ProcessEnv = {}): { type: string; attribute: string; key: string; location: string; locks?: string[] } | undefined {
  const file = join(dir, env.TF_DATA_DIR ?? ".terraform", "terraform.tfstate");
  let doc: { backend?: { type?: unknown; config?: Record<string, unknown> } };
  try {
    doc = JSON.parse(readFileSync(file, "utf-8")) as typeof doc;
  } catch {
    return undefined;
  }
  const type = typeof doc.backend?.type === "string" ? doc.backend.type : undefined;
  const attribute = type ? KEY_ATTRIBUTE[type] : undefined;
  const config = doc.backend?.config ?? {};
  const key = attribute && typeof config[attribute] === "string" ? (config[attribute] as string) : undefined;
  if (!type || !attribute || key === undefined) return type ? { type, attribute: attribute ?? "", key: "", location: "" } : undefined;
  const str = (k: string): string | undefined => (typeof config[k] === "string" ? (config[k] as string) : undefined);
  if (type === "http") return { type, attribute, key, location: shownUrl(key), locks: HTTP_LOCK_ATTRIBUTES.map((a) => str(a)).filter((v): v is string => v !== undefined) };
  const location = type === "s3" && str("bucket") ? `s3://${str("bucket")}/${key}` : type === "gcs" && str("bucket") ? `gs://${str("bucket")}/${key}` : type === "azurerm" && str("container_name") ? `${str("storage_account_name") ?? "azure"}/${str("container_name")}/${key}` : key;
  return { type, attribute, key, location };
}

/** Whether a key carries a copy's suffix as suffixedKey puts it. */
export const carriesSuffix = (key: string, suffix: string): boolean => new RegExp(`-${suffix}(\\.tfstate)?/*$`).test(key);

/**
 * The `-backend-config` a root's copy is initialised with: its backend's key
 * attribute, suffixed, and on GitLab-managed state its lock addresses
 * (`extra`). Throws ConfigError for a root no copy can be made of.
 */
export function copyBackend(dir: string, root: string, suffix: string, env: NodeJS.ProcessEnv = {}): { type: string; attribute: string; key: string; location: string; extra?: Record<string, string> } {
  const b = backendBlock(dir);
  if (b && "cloud" in b) throw new ConfigError(`${root} keeps its state in HCP Terraform (a cloud block), where a state is a workspace and not a key; ephemeral copies roots whose backend is ${Object.keys(KEY_ATTRIBUTE).join(", ")}`);
  const type = b?.type ?? "local";
  const attribute = KEY_ATTRIBUTE[type];
  if (!attribute) throw new ConfigError(`${root}'s backend is ${type}, and ephemeral gives a copy its own state key on ${Object.keys(KEY_ATTRIBUTE).join(", ")} backends only`);
  if (type === "http") {
    const copy = gitlabCopy(root, b?.attrs ?? {}, env, suffix);
    return { type, attribute, key: copy.key, location: shownUrl(copy.key), ...(Object.keys(copy.extra).length ? { extra: copy.extra } : {}) };
  }
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
  /** Where the binary runs: the root, or the unit's working directory as Terragrunt prepared it. */
  dir: string;
  location: string;
  planFile: string;
  member?: WaveMember;
  changes: number;
  destroys: number;
  error?: string;
}

/** A unit whose prepared backend does not carry the suffix: refused, as a config error. */
export class SuffixRefused extends ConfigError {}

/** A Terragrunt repo's copy: the units are prepared by Terragrunt with the suffix set. */
interface UnitCopy {
  terragrunt: string;
}

/**
 * Prepare a unit's copy: `terragrunt run -- init` with the suffix in
 * TERRAGUCCI_EPHEMERAL_SUFFIX, then the backend the binary was initialised
 * with, which must carry the suffix. Throws ConfigError when it does not.
 */
async function prepareUnit(code: string, unit: string, suffix: string, binary: string, env: NodeJS.ProcessEnv, work: string, tg: UnitCopy): Promise<{ dir: string; env: NodeJS.ProcessEnv; location: string }> {
  const unitEnv: NodeJS.ProcessEnv = {
    ...env,
    [EPHEMERAL_SUFFIX_ENV]: `-${suffix}`,
    // The auth provider resolves a unit's path from the checkout it runs in, which is the head's, not the job's.
    TERRAGUCCI_REPO: code,
    TG_DOWNLOAD_DIR: mkdtempSync(join(work, "tg-")),
  };
  const place = await unitPlace(code, unit, binary, unitEnv, work, { path: tg.terragrunt });
  const b = unitBackend(place.dir, place.env);
  if (!b) throw new SuffixRefused(`${unit}: Terragrunt prepared it with no backend the binary recorded, so its copy has no key of its own; ${SUFFIX_HOW}`);
  if (!b.attribute) throw new SuffixRefused(`${unit}'s backend is ${b.type}, and ephemeral gives a copy its own state key on ${Object.keys(KEY_ATTRIBUTE).join(", ")} backends only`);
  if (b.type === "http" && !isGitLabAddress(b.key)) throw new SuffixRefused(`${unit}'s http backend ${b.key ? `address ${shownUrl(b.key)} is not a GitLab project's state API` : "names no address"}, and ephemeral gives an http backend's copy its own state on GitLab-managed state only`);
  if (!carriesSuffix(b.key, suffix)) throw new SuffixRefused(`${unit}: its ${b.type} backend's ${b.attribute} is ${b.key ? (b.type === "http" ? shownUrl(b.key) : b.key) : "empty"} with ${EPHEMERAL_SUFFIX_ENV} set, which is the unit's own state, so its copy is refused; ${SUFFIX_HOW}`);
  // A GitLab copy locks its own state: a lock address left at the unit's would lock the unit's state while the copy writes.
  const own = (b.locks ?? []).find((l) => !carriesSuffix(l.replace(/\/lock\/?$/, ""), suffix));
  if (own) throw new SuffixRefused(`${unit}: its http backend's lock address is ${shownUrl(own)} with ${EPHEMERAL_SUFFIX_ENV} set, the lock of the unit's own state, so its copy is refused; make lock_address and unlock_address read the suffix as the address does`);
  return { dir: place.dir, env: place.env, location: b.location };
}

/** Init a root's copy under its suffixed key and plan it (a destroy with `destroy`). A unit is prepared by Terragrunt instead (`tg`). */
async function planCopy(code: string, root: string, suffix: string, binaries: RootBinaries, work: string, i: number, env: NodeJS.ProcessEnv, exec: EphemeralExec, destroy: boolean, tg?: UnitCopy): Promise<CopyPlan> {
  const rootEnv = rootRoleEnv(env, root);
  const planFile = join(work, `${i}.tfplan`);
  let binary: string;
  try {
    binary = (await binaries.resolve(root)).path;
  } catch (e) {
    return { root, binary: binaries.binary, env: rootEnv, dir: join(code, root), location: "", planFile, changes: 0, destroys: 0, error: (e as Error).message };
  }
  let dir = join(code, root);
  let runEnv = rootEnv;
  let location: string;
  if (tg) {
    let prepared: Awaited<ReturnType<typeof prepareUnit>>;
    try {
      prepared = await prepareUnit(code, root, suffix, binary, rootEnv, work, tg);
    } catch (e) {
      if (e instanceof SuffixRefused) throw e;
      return { root, binary, env: rootEnv, dir, location: "", planFile, changes: 0, destroys: 0, error: (e as Error).message };
    }
    ({ dir, location } = prepared);
    runEnv = prepared.env;
  } else {
    const backend = copyBackend(dir, root, suffix, rootEnv);
    location = backend.location;
    const configs = Object.entries({ [backend.attribute]: backend.key, ...backend.extra }).map(([k, v]) => `-backend-config=${k}=${v}`);
    const init = exec(binary, ["init", "-input=false", "-no-color", "-reconfigure", ...configs], dir, rootEnv);
    if (init.status !== 0) return { root, binary, env: rootEnv, dir, location, planFile, changes: 0, destroys: 0, error: `init failed\n${tail(init.out)}` };
  }
  const base = { root, binary, env: runEnv, dir, location, planFile, changes: 0, destroys: 0 };
  const plan = exec(binary, ["plan", "-input=false", "-no-color", ...lockTimeoutArgs("plan", runEnv), ...(destroy ? ["-destroy"] : []), `-out=${planFile}`], dir, runEnv);
  if (plan.status !== 0) return { ...base, error: `plan failed\n${tail(plan.out)}` };
  const show = exec(binary, ["show", "-json", planFile], dir, runEnv);
  let json: unknown;
  try {
    json = JSON.parse(show.stdout);
  } catch {
    return { ...base, error: `show -json printed no plan\n${tail(show.out)}` };
  }
  const part = terraformChangeSetPart({ member: root, plan: json, planner: plannerForBinary(binary) });
  const changed = part.entries.filter((e) => e.action !== "no-op" && e.action !== "read");
  return {
    ...base,
    member: { member: root, planDigest: part.member.planDigest ?? "" },
    changes: changed.length,
    destroys: changed.filter((e) => e.action === "delete" || e.action === "replace").length,
  };
}

/**
 * Run the synth command in a checkout, so its roots are there to copy: from
 * the checkout's root, with the job's environment less the forge's tokens.
 * Returns the output's tail when it fails.
 */
export function runSynth(command: string, dir: string, env: NodeJS.ProcessEnv): { ok: true } | { ok: false; out: string } {
  const p = spawnSync("sh", ["-c", command], { cwd: dir, encoding: "utf-8", env: binaryEnv(env), maxBuffer: 256 * 1024 * 1024 });
  return p.status === 0 ? { ok: true } : { ok: false, out: tail(`${p.stdout ?? ""}${p.stderr ?? ""}${p.error ? p.error.message : ""}`) };
}

// ── settings ──────────────────────────────────────────────────────────────

export interface EphemeralOptions {
  config?: string;
  /** The ref terragucci.yml is read from. Default: the checkout's own, which is the default branch's in the pipeline's jobs. */
  base?: string;
  binary?: string;
  /** The terragrunt executable, in a Terragrunt repo. Default: TERRAGUCCI_TERRAGRUNT, then terragrunt on the path. */
  terragrunt?: string;
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
  /** A Terragrunt repo: its units are copied through Terragrunt, with the suffix in TERRAGUCCI_EPHEMERAL_SUFFIX. */
  terragrunt?: UnitCopy;
  /** The command that writes the roots, run in each checkout before its roots are read. */
  synth?: string;
  ttl: number;
  forge: ForgeName;
  binary: string;
  configPath?: string;
  env: NodeJS.ProcessEnv;
  log: (l: string) => void;
  exec: EphemeralExec;
  actor: string;
}

/**
 * The binary a copy runs when the job passes none: terragucci.yml's, else the
 * one init detects for the repo's shape, as every other job runs (a Terragrunt
 * repo's from its version files and the path, never a fixed tofu).
 */
export function copyBinary(repo: string, settings: ResolvedSettings, shape: Shape = detectShape(repo, settings)): Binary {
  return settings.binary ?? shape.binary(shape.engine === "terragrunt" ? [] : findRoots(repo, settings.ephemeral?.roots)).value;
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
  const shape = detectShape(repo, settings);
  const refused = shape.refuses("ephemeral");
  if (refused) throw new ConfigError(`ephemeral: ${refused}`);
  const terragrunt: UnitCopy | undefined = shape.engine === "terragrunt" ? { terragrunt: options.terragrunt ?? env.TERRAGUCCI_TERRAGRUNT ?? "terragrunt" } : undefined;
  const forge: ForgeName = settings.forge ?? (env.GITLAB_CI === "true" ? "gitlab" : env.GITEA_ACTIONS === "true" || env.FORGEJO_ACTIONS === "true" ? "forgejo" : "github");
  const binary = options.binary ?? copyBinary(repo, settings, shape);
  const actor = options.actor || env.GITHUB_ACTOR || env.GITLAB_USER_LOGIN || "terragucci";
  return { settings, roots: e.roots, ...(terragrunt ? { terragrunt } : {}), ...(shape.prepare ? { synth: shape.prepare } : {}), ttl: ttlMs(e.ttl ?? EPHEMERAL_TTL) ?? ttlMs(EPHEMERAL_TTL)!, forge, binary, ...(configPath ? { configPath } : {}), env, log, exec: options.exec ?? runBinary, actor };
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

/**
 * The roots of a checkout that `ephemeral.roots` names, in the order they
 * apply: plain roots by their terraform_remote_state reads, Terragrunt units
 * by their dependency blocks (as discovery finds them, explicit stacks
 * generated first). With synth, the command runs first, since git holds no
 * root. Undefined, with why, when the synth command fails.
 */
async function copyRoots(dir: string, r: Ready, label: string): Promise<string[] | undefined> {
  if (r.synth) {
    r.log(`${label}: synth: ${r.synth}`);
    const ran = runSynth(r.synth, dir, r.env);
    if (!ran.ok) {
      r.log(`${label}: the synth command failed, so there are no roots to copy\n${ran.out}`);
      return undefined;
    }
  }
  if (r.terragrunt) {
    const found = await discoverUnits(dir, { exclude: r.settings.terragrunt?.exclude ?? [], binary: r.binary, terragrunt: r.terragrunt.terragrunt });
    const picked = new Set(found.units.filter((u) => r.roots.some((g) => globMatch(g, u.path))).map((u) => u.path));
    const units = found.units.filter((u) => picked.has(u.path)).map((u) => ({ path: u.path, dependencies: u.dependencies.filter((d) => picked.has(d)) }));
    return unitWaves(units).flat();
  }
  const found = findRoots(dir, r.roots);
  return found.length ? applyLayers(dir, found).flat() : [];
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
    const roots = await copyRoots(code.dir, r, label);
    if (!roots) return EPHEMERAL_EXIT.failed;
    if (roots.length === 0) {
      r.log(`${label}: no ${r.terragrunt ? "unit" : "root"} at ${code.commit.slice(0, 8)} matches ephemeral.roots (${r.roots.join(", ")}), so it gets no copy`);
      return EPHEMERAL_EXIT.done;
    }
    if (r.terragrunt) {
      const reads = remoteStateReadsSuffix(code.dir);
      if (!reads.ok) throw new SuffixRefused(`ephemeral: ${reads.why}; ${SUFFIX_HOW}`);
    }
    r.log(`${label}: its copy of ${roots.join(", ")} under the state keys suffixed -${suffix}, from ${code.commit.slice(0, 8)}`);
    const binaries = new RootBinaries(code.dir, r.binary, r.settings.version, r.env);
    const plans: CopyPlan[] = [];
    for (const [i, root] of roots.entries()) {
      const p = await planCopy(code.dir, root, suffix, binaries, work, i, r.env, r.exec, false, r.terragrunt);
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
      const a = r.exec(p.binary, ["apply", "-input=false", "-no-color", ...lockTimeoutArgs("apply", p.env), p.planFile], p.dir, p.env);
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
    // With synth, the roots the copy was applied from are written again from its commit; an explicit stack's units are generated.
    let synthFailed = false;
    if (r.synth) {
      const ran = runSynth(r.synth, code.dir, r.env);
      if (!ran.ok) r.log(`${label}: the synth command failed\n${ran.out}`);
      synthFailed = !ran.ok;
    }
    if (r.terragrunt) {
      try {
        // shape: the copy's checkout, whose stacks are generated from its own commit.
        await generateStacks(code.dir, { binary: r.binary, terragrunt: r.terragrunt.terragrunt });
      } catch (e) {
        r.log(`${label}: ${(e as Error).message}`);
      }
    }
    // Later roots read earlier ones' state, so the copy is destroyed in reverse.
    const roots = [...live.roots].reverse();
    for (const [i, root] of roots.entries()) {
      const location = live.locations[root] ?? "";
      if (synthFailed || !existsSync(join(code.dir, root))) {
        r.log(`FAILED ${root}: ${synthFailed ? "the synth command failed" : "the directory is gone"} at ${code.commit.slice(0, 8)}, so its copy at ${location} cannot be planned`);
        results.push({ root, location, result: "failed" });
        continue;
      }
      let p: CopyPlan;
      try {
        p = await planCopy(code.dir, root, live.suffix, binaries, work, i, r.env, r.exec, true, r.terragrunt);
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
      const a = r.exec(p.binary, ["apply", "-input=false", "-no-color", ...lockTimeoutArgs("apply", p.env), p.planFile], p.dir, p.env);
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
