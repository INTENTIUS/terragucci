/**
 * Ephemeral environments: each open pull request gets its own copy of the
 * roots `ephemeral.roots` names, under a state key of its own, and loses it
 * when it closes or its TTL passes.
 *
 * chant runs the environment (`@intentius/chant/components/pr-env-run`): the
 * gate, the records, the TTL, the ownership check and the sweep. This file
 * supplies the Terraform part as chant's adapters: the plan and apply of each
 * root's copy, and its teardown.
 *
 *   terragucci ephemeral up --pr <n> --head <sha>
 *       From the pipeline's job for an opened, reopened or updated pull
 *       request. Its settings are terragucci.yml's at base (the default
 *       branch's checkout, or `--base`), never the pull request's own, so a
 *       pull request cannot name more roots or a longer TTL. The roots are
 *       the head's code, checked out apart. Each root is initialised with its
 *       backend's state key suffixed `-pr-<n>` (suffixedKey), so the copy
 *       never shares a state with the root itself. A plan that changes
 *       something waits at gate `pr-env` of op `pr-<n>` until its set digest
 *       is approved (`terragucci approve ephemeral <n>`, which runs `chant approve
 *       pr-<n> pr-env --plan <digest>`); once it
 *       applies, `_pr-envs/records.jsonl` on chant/lifecycle records the
 *       copy, its roots and their state keys, its commit and its expiry.
 *   terragucci ephemeral down --pr <n> --reason closed|expired
 *       Destroys the live copy: each root's `plan -destroy`, then the apply of
 *       that plan, in reverse order, from the commit the copy was applied
 *       from. No gate holds it: closing the pull request, or the TTL the
 *       default branch set, is the decision.
 *   terragucci ephemeral sweep
 *       From the sweep schedule: destroys each live copy whose TTL passed, or
 *       whose pull request the forge says is closed or merged. On GitLab,
 *       which starts no pipeline when a merge request closes, this is how a
 *       closed merge request loses its copy.
 *
 * A copy's marker is `{ stack: "terragucci", env: "pr-<n>" }`. The teardown
 * reads it back from each root's recorded state key, which carries the
 * suffix, so chant's ownership check holds before anything is destroyed.
 *
 * Copies applied before the switch are in `_gates/tf-ephemeral/done.jsonl`.
 * That file is read too, before chant's records, so those copies are still
 * destroyed on close or at expiry (legacyRecords).
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
import {
  prEnvDown,
  prEnvSweep,
  prEnvUp,
  type PrEnvAdapter,
  type PrEnvPlanned,
  type PrEnvPorts,
  type PrEnvRunResult,
} from "@intentius/chant/components/pr-env-run";
import { livePrEnvironments, parsePrEnvRecords, PR_ENV_LEDGER_DIR, PR_ENV_LEDGER_FILE, type LivePrEnvironment, type PrEnvRecord, type PrEnvReportRow, type PrEnvTeardownAdapter } from "@intentius/chant/components/pr-environment";
import type { TeardownOutcome } from "@intentius/chant/lexicon";
import { plannerForBinary, terraformChangeSetPart } from "@intentius/chant-lexicon-terraform/change-set";
import { appendLifecycle, decideGate, lockTimeoutArgs, readLedger } from "./apply";
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

/** chant's records of the copies, on chant/lifecycle. */
export const EPHEMERAL_RECORDS = `${PR_ENV_LEDGER_DIR}/${PR_ENV_LEDGER_FILE}`;
/** The records terragucci kept before chant ran the copies: read, never written. */
export const LEGACY_EPHEMERAL_DONE = "_gates/tf-ephemeral/done.jsonl";
/** The stack every copy's marker names, and the template its records name. */
export const EPHEMERAL_STACK = "terragucci";
export const EPHEMERAL_TEMPLATE = "ephemeral";
/** The name chant attributes a copy's teardown outcomes to, and the lexicon it stands in for. */
export const EPHEMERAL_ADAPTER = "terragucci";
/** The live copies, beside the project's index in the reports bucket. */
export const EPHEMERAL_FILE = "ephemeral.json";
export const EPHEMERAL_SCHEMA = "terragucci.ephemeral/v1";

/** Exit codes, as chant's pr-env gives them. */
export const EPHEMERAL_EXIT = { done: 0, failed: 1, waiting: 3 } as const;

/** The suffix of a copy's state keys, which is also its environment's name. */
export const ephemeralSuffix = (pr: number): string => `pr-${pr}`;

/** The op a copy's gate is recorded under, and that op's ledger on chant/lifecycle. */
export const ephemeralOp = (pr: number): string => `pr-${pr}`;
export const ephemeralLedger = (pr: number): string => `_gates/${ephemeralOp(pr)}.jsonl`;

/** The command that approves a copy's plans; it runs `chant approve pr-<n> pr-env --plan <digest>`. */
export const ephemeralApproveCommand = (pr: number, digest: string, sealed = false): string => `terragucci approve ephemeral ${pr} --plan ${digest}${sealed ? " --sign" : ""}`;

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
  /** What the plan does, as chant's report counts it. */
  create: number;
  update: number;
  replace: number;
  delete: number;
  error?: string;
}

const NO_CHANGES = { create: 0, update: 0, replace: 0, delete: 0 } as const;

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
    return { root, binary: binaries.binary, env: rootEnv, dir: join(code, root), location: "", planFile, ...NO_CHANGES, error: (e as Error).message };
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
      return { root, binary, env: rootEnv, dir, location: "", planFile, ...NO_CHANGES, error: (e as Error).message };
    }
    ({ dir, location } = prepared);
    runEnv = prepared.env;
  } else {
    const backend = copyBackend(dir, root, suffix, rootEnv);
    location = backend.location;
    const configs = Object.entries({ [backend.attribute]: backend.key, ...backend.extra }).map(([k, v]) => `-backend-config=${k}=${v}`);
    const init = exec(binary, ["init", "-input=false", "-no-color", "-reconfigure", ...configs], dir, rootEnv);
    if (init.status !== 0) return { root, binary, env: rootEnv, dir, location, planFile, ...NO_CHANGES, error: `init failed\n${tail(init.out)}` };
  }
  const base = { root, binary, env: runEnv, dir, location, planFile, ...NO_CHANGES };
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
  const count = (action: string): number => part.entries.filter((e) => e.action === action).length;
  return { ...base, member: { member: root, planDigest: part.member.planDigest ?? "" }, create: count("create"), update: count("update"), replace: count("replace"), delete: count("delete") };
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
  /** `ephemeral.ttl` at base: `24h`, `90m`, `7d`. */
  ttl: string;
  /** `approval: sealed` at base: only a sealed approval counts at the gate. Set once the gate's port is built. */
  sealed?: boolean;
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
  return { settings, roots: e.roots, ...(terragrunt ? { terragrunt } : {}), ...(shape.prepare ? { synth: shape.prepare } : {}), ttl: ttlMs(e.ttl ?? EPHEMERAL_TTL) ? (e.ttl ?? EPHEMERAL_TTL) : EPHEMERAL_TTL, forge, binary, ...(configPath ? { configPath } : {}), env, log, exec: options.exec ?? runBinary, actor };
}

// ── the records ─────────────────────────────────────────────────────────────

/** One line of the legacy done.jsonl: a copy applied, or destroyed, before chant ran the copies. */
interface LegacyRecord {
  version: 1;
  kind: "ephemeral-apply" | "ephemeral-destroy";
  pr: number;
  roots: { root: string; location: string; result: string }[];
  planDigest?: string;
  by?: string;
  timestamp: string;
  result: string;
  commit: string;
  expiresAt?: string;
  approvedBy?: string;
  reason?: "closed" | "expired";
}

/**
 * The legacy done.jsonl text as chant's records: an apply is an `up` with
 * each root's state key as its location, a destroy that destroyed every root
 * is a `down` that ends the copy, and one that failed is an `incomplete`
 * down that leaves it live. Malformed lines are skipped.
 */
export function legacyRecords(text: string): PrEnvRecord[] {
  const out: PrEnvRecord[] = [];
  for (const line of text.split("\n").map((l) => l.trim()).filter(Boolean)) {
    let r: LegacyRecord;
    try {
      r = JSON.parse(line) as LegacyRecord;
    } catch {
      continue;
    }
    if (r?.version !== 1 || (r.kind !== "ephemeral-apply" && r.kind !== "ephemeral-destroy") || !Number.isInteger(r.pr) || !Array.isArray(r.roots) || typeof r.timestamp !== "string") continue;
    const env = ephemeralSuffix(r.pr);
    const roots = r.roots.filter((x) => typeof x?.root === "string");
    const up = r.kind === "ephemeral-apply";
    out.push({
      version: 1,
      kind: up ? "up" : "down",
      pr: r.pr,
      env,
      template: EPHEMERAL_TEMPLATE,
      marker: { stack: EPHEMERAL_STACK, env },
      commit: typeof r.commit === "string" ? r.commit : "",
      components: up ? roots.map((x) => x.root) : [EPHEMERAL_ADAPTER],
      ...(up ? { locations: Object.fromEntries(roots.filter((x) => typeof x.location === "string" && x.location).map((x) => [x.root, x.location])) } : {}),
      planDigest: typeof r.planDigest === "string" ? r.planDigest : "",
      result: up ? (r.result === "applied" ? "applied" : "failed") : r.result === "destroyed" ? "destroyed" : "incomplete",
      by: typeof r.by === "string" ? r.by : "terragucci",
      timestamp: r.timestamp,
      ...(up ? { expiresAt: r.expiresAt ?? r.timestamp } : {}),
      ...(up && r.approvedBy ? { approvedBy: [r.approvedBy] } : {}),
      ...(!up && r.reason ? { reason: r.reason } : {}),
      releaseTarget: false,
    });
  }
  return out;
}

/** A file on origin's chant/lifecycle, as fetched last. Empty when there is none. */
function lifecycleFile(repo: string, path: string): string {
  const show = git(repo, ["show", `refs/remotes/origin/chant/lifecycle:${path}`]);
  return show.status === 0 ? show.stdout : "";
}

/** Every record of this repository's copies, oldest first: the legacy ones, then chant's. */
export function readRecords(repo: string): PrEnvRecord[] {
  // readLedger fetches chant/lifecycle into the ref the files are read from.
  readLedger(repo, EPHEMERAL_RECORDS);
  return [...legacyRecords(lifecycleFile(repo, LEGACY_EPHEMERAL_DONE)), ...parsePrEnvRecords(lifecycleFile(repo, EPHEMERAL_RECORDS))];
}

/** The live copies of this repository, by pull request, as chant/lifecycle on origin records them. */
export function readLive(repo: string): Map<number, LivePrEnvironment> {
  return new Map([...livePrEnvironments(readRecords(repo)).values()].map((e) => [e.pr, e]));
}

// ── the ports ───────────────────────────────────────────────────────────────

/** Whether the forge says pull request `pr` is open. Throws when it cannot be read, so the TTL decides. */
async function pullState(fetchFn: Fetch, r: Ready, pr: number): Promise<"open" | "closed" | "merged"> {
  const t = targetFromEnv(r.forge, r.env, r.env.TG_TOKEN, true);
  if (!t) throw new Error("no forge token or repository in the job");
  if (t.forge === "gitlab") {
    const mr = (await call(fetchFn, t, "GET", `/projects/${encodeURIComponent(t.path)}/merge_requests/${pr}`)) as { state?: string };
    return mr.state === "merged" ? "merged" : mr.state === "closed" ? "closed" : "open";
  }
  const p = (await call(fetchFn, t, "GET", `/repos/${t.path}/pulls/${pr}`)) as { state?: string; merged?: boolean };
  return p.merged === true ? "merged" : p.state === "closed" ? "closed" : "open";
}

/**
 * chant's ports over chant/lifecycle in the checkout, kept with terragucci's
 * own ledger code: the records (the legacy ones read first), appended and
 * pushed, the gate decided from `_gates/pr-<n>.jsonl` (under `approval:
 * sealed`, only a sealed approval counts), and the pull request's state from
 * the forge. Nothing is posted on the pull request; the job's log says it.
 */
async function ports(repo: string, r: Ready, options: EphemeralOptions, gate = false): Promise<PrEnvPorts> {
  const fetchFn = options.fetch ?? (globalThis.fetch as unknown as Fetch);
  const rule = gate ? await approvalRule(repo, { at: options.base ?? "HEAD", ...(r.configPath ? { config: r.configPath } : {}) }) : undefined;
  r.sealed = rule?.mode === "sealed";
  return {
    readRecords: async () => readRecords(repo),
    async appendRecord(record) {
      try {
        appendLifecycle(repo, EPHEMERAL_RECORDS, [JSON.stringify(record)], {}, `Ephemeral copy of pull request ${record.pr} ${record.kind} (${record.result})`);
      } catch (e) {
        r.log(`pull request ${record.pr}: its ${record.kind} was not recorded on chant/lifecycle: ${(e as Error).message}`);
      }
    },
    async decideGate({ op, gate: name, digest }) {
      const ledger = readLedger(repo, `_gates/${op}.jsonl`);
      const resolutions = !r.sealed
        ? ledger.resolutions
        : ledger.resolutions.filter((x) => {
            if (x.gate !== name) return true;
            const why = sealRefusal(rule!.signers, x);
            if (why !== null && samePlanDigest(x.planDigest, digest)) r.log(`${op}: an approval does not count: ${why}`);
            return why === null;
          });
      const d = decideGate({ ...ledger, resolutions }, name, digest, options.now ?? new Date().toISOString());
      return d.status === "approved" ? { status: "approved", approvedBy: [d.by] } : { status: d.status === "refused" ? "changed" : "pending" };
    },
    pullRequestState: (pr) => pullState(fetchFn, r, pr),
    log: r.log,
    warn: r.log,
  };
}

/** The run's page on the forge, for the record. */
const runUrlOf = (repo: string, r: Ready): string | undefined => runFacts(repo, r.env, r.forge).job_url;

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

/** A live copy's row, with who approved its last apply (the newest up record's approvers). */
export function rowOf(e: LivePrEnvironment, records: readonly PrEnvRecord[], prUrl?: string): EphemeralRow {
  const last = [...records].reverse().find((x) => x.kind === "up" && x.env === e.env);
  return {
    pull_request: e.pr,
    ...(prUrl ? { pull_request_url: prUrl } : {}),
    suffix: e.env,
    roots: e.components.map((root) => ({ root, location: e.locations?.[root] ?? "" })),
    commit: e.commit,
    applied: e.applied,
    expires: e.expiresAt,
    ...(last?.approvedBy?.length ? { approved_by: last.approvedBy.join(", ") } : {}),
    status: e.teardownIncomplete ? "destroy-failed" : "live",
  };
}

/** The bucket's row for pull request `pr`, as the records now stand: its live copy, or none. */
async function writeLive(repo: string, r: Ready, p: PrEnvPorts, pr: number, now: string): Promise<void> {
  if (!r.settings.reports?.bucket) return;
  const records = await p.readRecords();
  const live = livePrEnvironments(records).get(ephemeralSuffix(pr));
  await writeList(repo, r, pr, live ? rowOf(live, records, runFacts(repo, { ...r.env, TG_PR: String(pr) }, r.forge).pull_request_url) : undefined, now);
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

/** A plan's row in chant's report: the root, what its plan does, and where its copy lives. */
function planRow(p: CopyPlan, status: string): PrEnvReportRow {
  return { component: p.root, status, create: p.create, update: p.update, replace: p.replace, delete: p.delete, ...(p.location ? { location: p.location } : {}) };
}

/**
 * The plan and apply of a copy as chant's adapter: `plan` inits each root of
 * the head's checkout under its suffixed key and plans it, `apply` applies
 * those plan files in order and stops at the first that fails. A config
 * error (a root no copy can be made of) is kept in `refused` for the caller
 * to raise, since chant reports a throw from `plan` as a failed plan.
 */
function copyAdapter(r: Ready, code: { dir: string; commit: string }, work: string, label: string): PrEnvAdapter & { refused?: ConfigError } {
  const suffix = (pr: number): string => ephemeralSuffix(pr);
  let plans: CopyPlan[] = [];
  const adapter: PrEnvAdapter & { refused?: ConfigError } = {
    async plan(target): Promise<PrEnvPlanned> {
      try {
        const roots = await copyRoots(code.dir, r, label);
        if (!roots) throw new Error("the synth command failed, so there are no roots to copy");
        if (roots.length === 0) {
          const message = `no ${r.terragrunt ? "unit" : "root"} at ${code.commit.slice(0, 8)} matches ephemeral.roots (${r.roots.join(", ")}), so it gets no copy`;
          r.log(`${label}: ${message}`);
          return { digest: "", empty: true, rows: [], message };
        }
        if (r.terragrunt) {
          const reads = remoteStateReadsSuffix(code.dir);
          if (!reads.ok) throw new SuffixRefused(`ephemeral: ${reads.why}; ${SUFFIX_HOW}`);
        }
        r.log(`${label}: its copy of ${roots.join(", ")} under the state keys suffixed -${suffix(target.pr)}, from ${code.commit.slice(0, 8)}`);
        const binaries = new RootBinaries(code.dir, r.binary, r.settings.version, r.env);
        plans = [];
        for (const [i, root] of roots.entries()) {
          const p = await planCopy(code.dir, root, suffix(target.pr), binaries, work, i, r.env, r.exec, false, r.terragrunt);
          plans.push(p);
          r.log(p.error ? `${root}: ${p.error}` : `${root}: ${p.create + p.update + p.replace + p.delete} to change at ${p.location}`);
        }
        const failed = plans.filter((p) => p.error);
        if (failed.length > 0) {
          const message = `${failed.map((p) => p.root).join(", ")} did not plan, so nothing of the copy applies`;
          r.log(`${label}: ${message}`);
          return { digest: "", empty: false, failed: true, rows: plans.map((p) => planRow(p, p.error ? "plan-failed" : "planned")), message };
        }
        const changes = plans.reduce((n, p) => n + p.create + p.update + p.replace + p.delete, 0);
        if (changes === 0) r.log(`${label}: its copy has nothing to change`);
        return { digest: waveSetDigest(plans.map((p) => p.member!)), empty: changes === 0, rows: plans.map((p) => planRow(p, "planned")) };
      } catch (e) {
        if (e instanceof ConfigError) adapter.refused = e;
        throw e;
      }
    },
    async apply(_target, { approvedBy }) {
      if (approvedBy?.length) r.log(`${label}: approved by ${approvedBy.join(", ")} for this digest`);
      const rows: PrEnvReportRow[] = [];
      let ok = true;
      for (const p of plans) {
        if (!ok) {
          rows.push(planRow(p, "not applied"));
          continue;
        }
        const a = r.exec(p.binary, ["apply", "-input=false", "-no-color", ...lockTimeoutArgs("apply", p.env), p.planFile], p.dir, p.env);
        ok = a.status === 0;
        rows.push(planRow(p, ok ? "applied" : "failed"));
        r.log(ok ? `applied ${p.root} at ${p.location}` : `FAILED ${p.root}\n${tail(a.out)}`);
      }
      return { status: ok ? "applied" : "failed", rows, locations: Object.fromEntries(plans.map((p) => [p.root, p.location])) };
    },
  };
  return adapter;
}

/**
 * Apply pull request `pr`'s copy of the ephemeral roots from its head, once
 * chant's gate says it may. Returns the exit code.
 */
export async function ephemeralUp(repo: string, options: UpOptions): Promise<number> {
  const r = await ready(repo, options);
  const { pr } = options;
  const label = `pull request ${pr}`;
  const p = await ports(repo, r, options, true);
  const code = checkoutPull(repo, r.forge, pr, options.head, r.log);
  const work = mkdtempSync(join(tmpdir(), "terragucci-ephemeral-plans-"));
  try {
    const adapter = copyAdapter(r, code, work, label);
    const runUrl = runUrlOf(repo, r);
    const result = await prEnvUp({
      pr,
      head: code.commit,
      template: EPHEMERAL_TEMPLATE,
      ttl: r.ttl,
      stack: EPHEMERAL_STACK,
      adapter,
      ports: p,
      actor: r.actor,
      ...(runUrl ? { runUrl } : {}),
      ...(options.now ? { now: () => new Date(options.now!) } : {}),
    });
    if (adapter.refused) throw adapter.refused;
    report(r, label, result);
    if (result.record) await writeLive(repo, r, p, pr, options.now ?? new Date().toISOString());
    return result.exit;
  } finally {
    code.done();
    rmSync(work, { recursive: true, force: true });
  }
}

/** What an up came to, in the job's log: the approve command while it waits. */
function report(r: Ready, label: string, result: PrEnvRunResult): void {
  const { report: rep } = result;
  if (rep.status === "waiting" || rep.status === "changed") {
    if (rep.status === "changed") r.log(`${label}: an approval stands for another digest, and its copy planned differently since, so nothing applied. Approve these plans with:`);
    else r.log(`${label}: its copy waits for an approval of digest ${rep.digest}. Read its plans above, then approve them with:`);
    r.log(`  ${ephemeralApproveCommand(rep.pr, rep.digest, r.sealed)}`);
    r.log("Then run the pull request's ephemeral job again, or push to it.");
    return;
  }
  if (rep.status === "applied") r.log(`${label}: its copy applied; it expires ${rep.expiresAt}, and closing the pull request destroys it before then`);
  else if (rep.status === "failed") r.log(`${label}: its copy failed part way${rep.expiresAt ? `; it expires ${rep.expiresAt}, and closing the pull request destroys what applied before then` : ""}${rep.message ? `: ${rep.message}` : ""}`);
  else if (rep.status === "plan-failed" && rep.message) r.log(`${label}: ${rep.message}`);
}

// ── down ──────────────────────────────────────────────────────────────────

export interface DownOptions extends EphemeralOptions {
  pr: number;
  reason: "closed" | "expired";
}

/**
 * A copy's teardown as chant's adapter, standing in for the terraform
 * lexicon. `owned` names each root of the live copy with the marker read
 * back from its recorded state key, which carries `-pr-<n>`; a root whose
 * key does not is a hole, so nothing at a root's own key is destroyed.
 * `teardown` checks out the commit the copy applied from, runs the synth
 * command and generates the stacks there, then plans and applies each
 * root's destroy, in reverse order.
 */
export function ephemeralTeardown(repo: string, r: Ready): PrEnvTeardownAdapter {
  return {
    name: EPHEMERAL_ADAPTER,
    lexicons: ["terraform"],
    async owned({ live, marker }) {
      const suffix = ephemeralSuffix(live.pr);
      const candidates = [];
      const holes = [];
      for (const root of live.components) {
        const location = live.locations?.[root] ?? "";
        const key = location.replace(/\/lock\/?$/, "");
        if (location && carriesSuffix(key, suffix)) candidates.push({ name: root, type: "terraform_root", physicalId: location, marker: { stack: marker.stack, env: suffix } });
        else holes.push({ name: root, type: "terraform_root", reason: "read-failed" as const, detail: location ? `its recorded state key ${location} does not carry -${suffix}, so it is not the copy's` : "its copy's state key is not recorded" });
      }
      return { candidates, holes };
    },
    async teardown({ candidates, live }) {
      const label = `pull request ${live.pr}`;
      const code = checkoutPull(repo, r.forge, live.pr, live.commit || undefined, r.log);
      const work = mkdtempSync(join(tmpdir(), "terragucci-ephemeral-plans-"));
      const outcomes: TeardownOutcome[] = [];
      try {
        const binaries = new RootBinaries(code.dir, r.binary, r.settings.version, r.env);
        let synthFailed = false;
        if (r.synth) {
          const ran = runSynth(r.synth, code.dir, r.env);
          if (!ran.ok) r.log(`${label}: the synth command failed\n${ran.out}`);
          synthFailed = !ran.ok;
        }
        if (r.terragrunt) {
          try {
            await generateStacks(code.dir, { binary: r.binary, terragrunt: r.terragrunt.terragrunt });
          } catch (e) {
            r.log(`${label}: ${(e as Error).message}`);
          }
        }
        // chant hands the candidates back sorted by name; later roots read earlier ones' state, so the copy is destroyed in reverse apply order.
        const order = [...live.components].reverse();
        const rank = (name: string): number => (order.includes(name) ? order.indexOf(name) : order.length);
        for (const [i, c] of [...candidates].sort((a, b) => rank(a.name) - rank(b.name)).entries()) {
          const root = c.name;
          const location = c.physicalId ?? "";
          const failed = (detail: string): void => {
            r.log(`FAILED ${root}: ${detail}`);
            outcomes.push({ name: root, outcome: "failed", detail });
          };
          if (synthFailed || !existsSync(join(code.dir, root))) {
            failed(`${synthFailed ? "the synth command failed" : "the directory is gone"} at ${code.commit.slice(0, 8)}, so its copy at ${location} cannot be planned`);
            continue;
          }
          let p: CopyPlan;
          try {
            p = await planCopy(code.dir, root, ephemeralSuffix(live.pr), binaries, work, i, r.env, r.exec, true, r.terragrunt);
          } catch (e) {
            failed((e as Error).message);
            continue;
          }
          if (p.error) {
            failed(p.error);
            continue;
          }
          r.log(`${root}: the destroy plan removes ${p.delete + p.replace} at ${p.location}`);
          const a = r.exec(p.binary, ["apply", "-input=false", "-no-color", ...lockTimeoutArgs("apply", p.env), p.planFile], p.dir, p.env);
          if (a.status !== 0) {
            failed(`the destroy did not apply\n${tail(a.out)}`);
            continue;
          }
          r.log(`destroyed ${root}'s copy at ${p.location}`);
          outcomes.push({ name: root, outcome: "deleted", detail: `destroyed at ${p.location}, plan ${p.member?.planDigest ?? ""}` });
        }
        return { outcomes };
      } finally {
        code.done();
        rmSync(work, { recursive: true, force: true });
      }
    },
  };
}

/** The commit the job runs at, for a teardown's record. */
const headOf = (repo: string): string => git(repo, ["rev-parse", "HEAD"]).stdout;

/** Destroy pull request `pr`'s live copy through a planned destroy, and record it. No copy: nothing to do. */
export async function ephemeralDown(repo: string, options: DownOptions): Promise<number> {
  const r = await ready(repo, options);
  const p = await ports(repo, r, options);
  const live = livePrEnvironments(await p.readRecords()).get(ephemeralSuffix(options.pr));
  const runUrl = runUrlOf(repo, r);
  const result = await prEnvDown({
    pr: options.pr,
    reason: options.reason,
    ports: p,
    adapters: [ephemeralTeardown(repo, r)],
    ...(live ? { live } : {}),
    commit: live?.commit || headOf(repo),
    actor: r.actor,
    ...(runUrl ? { runUrl } : {}),
    ...(options.now ? { now: () => new Date(options.now!) } : {}),
  });
  downReport(r, options.pr, result);
  if (result.record) await writeLive(repo, r, p, options.pr, options.now ?? new Date().toISOString());
  return result.exit;
}

function downReport(r: Ready, pr: number, result: PrEnvRunResult): void {
  const label = `pull request ${pr}`;
  const rep = result.report;
  if (rep.status === "absent") r.log(`${label} has no live ephemeral copy, so there is nothing to destroy`);
  else if (rep.status === "destroyed") r.log(`${label}: its copy is destroyed, recorded in ${EPHEMERAL_RECORDS} on chant/lifecycle`);
  else if (rep.status === "refused") r.log(`${label}: ${rep.message ?? "its teardown was refused"}`);
  else r.log(`${label}: its copy was not wholly destroyed${rep.message ? ` (${rep.message})` : ""}; it stays live, and the next sweep tries again`);
}

// ── sweep ─────────────────────────────────────────────────────────────────

/** Destroy every live copy whose TTL passed or whose pull request closed. Returns the worst exit code. */
export async function ephemeralSweep(repo: string, options: EphemeralOptions = {}): Promise<number> {
  const r = await ready(repo, options);
  const p = await ports(repo, r, options);
  const runUrl = runUrlOf(repo, r);
  const { exit, results } = await prEnvSweep({
    ports: p,
    adapters: [ephemeralTeardown(repo, r)],
    commit: headOf(repo),
    actor: r.actor,
    ...(runUrl ? { runUrl } : {}),
    ...(options.now ? { now: () => new Date(options.now!) } : {}),
  });
  const now = options.now ?? new Date().toISOString();
  for (const res of results) {
    downReport(r, res.report.pr, res);
    if (res.record) await writeLive(repo, r, p, res.report.pr, now);
  }
  return exit;
}
