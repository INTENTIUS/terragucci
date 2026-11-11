/**
 * Ephemeral environments: each open pull request gets its own copy of the
 * roots `ephemeral.roots` names, under a state key of its own, and loses it
 * when it closes or its TTL passes.
 *
 * chant runs the environment (`@intentius/chant/components/pr-env-run`): the
 * gate, the records, the TTL, the ownership check and the sweep. The
 * terraform lexicon's `terraformPrEnvAdapter` and `terraformPrEnvTeardown`
 * (`pr-env`, chant#4805) plan, apply and destroy each root's copy under its
 * suffixed key. This file supplies terragucci's part: the verbs, the
 * settings at base, the roots of the head's checkout with their binaries
 * and the Terragrunt preparation, the synth run, and the records and page.
 *
 *   terragucci ephemeral up --pr <n> --head <sha>
 *       From the pipeline's job for an opened, reopened or updated pull
 *       request. Its settings are terragucci.yml's at base (the default
 *       branch's checkout, or `--base`), never the pull request's own, so a
 *       pull request cannot name more roots or a longer TTL. The roots are
 *       the head's code, checked out apart. Each root is initialised with its
 *       backend's state key suffixed `-pr-<n>`, so the copy
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
import { appendPrEnvRecord } from "@intentius/chant/components/pr-env-ledger";
import { pushLifecycleReport } from "@intentius/chant/lifecycle/git";
import { livePrEnvironments, parsePrEnvRecords, PR_ENV_LEDGER_DIR, PR_ENV_LEDGER_FILE, type LivePrEnvironment, type PrEnvRecord, type PrEnvReportRow, type PrEnvTeardownAdapter } from "@intentius/chant/components/pr-environment";
import type { TeardownOutcome } from "@intentius/chant/lexicon";
import { plannerForBinary, terraformChangeSetPart } from "@intentius/chant-lexicon-terraform/change-set";
import { decideGate, LEDGER_READ_REF, lockTimeoutArgs, readLedger } from "./apply";
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
import { jobForgeTarget } from "@intentius/chant/forge-flags";
import { forgeClient } from "@intentius/chant/pr-forge";
import { actorOf } from "@intentius/chant/actor";
import type { Fetch } from "./forge";
import { isGitLabAddress, shownUrl, suffixedGitLabAddress } from "@intentius/chant-lexicon-terraform/state/gitlab";
import { unitPlace } from "./migrate";
import { RootBinaries } from "./pins";
import { storeFromEnv } from "./report/bucket";
import { configAtBase } from "./report/policy";
import { runFacts } from "./report/stage";
import { updateJson } from "./report/store";
import { rootRoleEnv } from "./cloud-identity";
import { sealRefusal } from "./seal";
import { discoverUnits, generateStacks, unitWaves } from "./terragrunt";
import { asyncExec } from "./gated-request";
import { CopyRefusedError, terraformPrEnvAdapter, terraformPrEnvTeardown, type CopyRoot } from "@intentius/chant-lexicon-terraform/pr-env";

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

/** A Terragrunt repo's copy: the units are prepared by Terragrunt with the suffix set. */
interface UnitCopy {
  terragrunt: string;
}

/**
 * The roots of a copy as chant's Terraform half takes them (CopyRoot): each
 * root's binary and role env, and for a Terragrunt unit its preparation:
 * `terragrunt run -- init` with the suffix in TERRAGUCCI_EPHEMERAL_SUFFIX,
 * after which chant checks that the backend the binary recorded carries it.
 */
async function copyRootsOf(code: string, roots: readonly string[], r: Ready, work: string): Promise<CopyRoot[]> {
  const binaries = new RootBinaries(code, r.binary, r.settings.version, r.env);
  const out: CopyRoot[] = [];
  for (const root of roots) {
    const env = rootRoleEnv(r.env, root);
    const binary = (await binaries.resolve(root)).path;
    const tg = r.terragrunt;
    out.push({
      root,
      dir: join(code, root),
      binary,
      env,
      ...(tg
        ? {
            prepare: async (suffix: string) => {
              const unitEnv: NodeJS.ProcessEnv = {
                ...env,
                [EPHEMERAL_SUFFIX_ENV]: `-${suffix}`,
                // The auth provider resolves a unit's path from the checkout it runs in, which is the head's, not the job's.
                TERRAGUCCI_REPO: code,
                TG_DOWNLOAD_DIR: mkdtempSync(join(work, "tg-")),
              };
              const place = await unitPlace(code, root, binary, unitEnv, work, { path: tg.terragrunt });
              return { dir: place.dir, env: place.env };
            },
          }
        : {}),
    });
  }
  return out;
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
  const actor = options.actor || actorOf({ env, login: false, fallback: "terragucci" });
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
  const show = git(repo, ["show", `${LEDGER_READ_REF}:${path}`]);
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
  const t = jobForgeTarget({ forge: r.forge, tokenEnv: "TG_TOKEN" }, r.env, { tokenOptional: true });
  if (!t) throw new Error("no forge token or repository in the job");
  const forge = forgeClient(t, fetchFn);
  if (!forge.pullRequestState) throw new Error(`chant's ${t.kind} client reads no pull request's state`);
  return forge.pullRequestState(pr);
}

/**
 * A pull request environment's record through chant's writer
 * (`appendPrEnvRecord`, chant#4551), pushed. A push that did not land is
 * logged; the local commit stays and the next push carries it.
 */
async function chantAppendPrEnv(repo: string, record: PrEnvRecord, log: (line: string) => void): Promise<void> {
  await appendPrEnvRecord(record, { cwd: repo });
  const pushed = await pushLifecycleReport({ cwd: repo });
  if (!pushed.pushed) log(`pull request ${record.pr}: its ${record.kind} record was not pushed (${pushed.pushWarning ?? "no remote"})`);
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
        // chant's writer (chant#4551) appends under the member prefix and checks the record.
        await chantAppendPrEnv(repo, record, r.log);
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

/**
 * The plan and apply of a copy as chant's adapter (the terraform lexicon's
 * `terraformPrEnvAdapter`): the roots of the head's checkout, in apply order,
 * each planned under its key suffixed `-pr-<n>` and applied in order,
 * stopping at the first that fails. A root no copy can be made of is kept in
 * `refused`, which the caller raises.
 */
function copyAdapter(r: Ready, code: { dir: string; commit: string }, work: string, label: string): PrEnvAdapter & { refused?: Error } {
  return terraformPrEnvAdapter({
    async roots(target) {
      const roots = await copyRoots(code.dir, r, label);
      // copyRoots said why; a failed synth is the job's failure, not a config error.
      if (!roots) throw new Error("the synth command failed, so there are no roots to copy");
      if (roots.length > 0 && r.terragrunt) {
        const reads = remoteStateReadsSuffix(code.dir);
        if (!reads.ok) throw new ConfigError(`ephemeral: ${reads.why}; ${SUFFIX_HOW}`);
      }
      if (roots.length > 0) r.log(`${label}: its copy of ${roots.join(", ")} under the state keys suffixed -${target.env}, from ${code.commit.slice(0, 8)}`);
      return copyRootsOf(code.dir, roots, r, work);
    },
    work,
    exec: asyncExec(r.exec),
    hint: SUFFIX_HOW,
    nothing: `no ${r.terragrunt ? "unit" : "root"} at ${code.commit.slice(0, 8)} matches ephemeral.roots (${r.roots.join(", ")}), so it gets no copy`,
    log: (line) => r.log(`${label}: ${line}`),
  });
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
    if (adapter.refused instanceof ConfigError || adapter.refused instanceof CopyRefusedError) throw adapter.refused instanceof ConfigError ? adapter.refused : new ConfigError(adapter.refused.message);
    if (adapter.refused) return EPHEMERAL_EXIT.failed;
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
 * A copy's teardown as chant's adapter (the terraform lexicon's
 * `terraformPrEnvTeardown`): a root whose recorded state key carries
 * `-pr-<n>` is destroyed through a planned destroy of its copy, in reverse
 * apply order; any other is a hole, so nothing at a root's own key is
 * destroyed. The roots are read from the commit the copy applied from, with
 * the synth command run and the stacks generated there first.
 */
export function ephemeralTeardown(repo: string, r: Ready, work: string): PrEnvTeardownAdapter {
  return terraformPrEnvTeardown({
    name: EPHEMERAL_ADAPTER,
    async checkout(live) {
      const label = `pull request ${live.pr}`;
      const code = checkoutPull(repo, r.forge, live.pr, live.commit || undefined, r.log);
      const done = (): void => code.done();
      try {
        if (r.synth) {
          const ran = runSynth(r.synth, code.dir, r.env);
          if (!ran.ok) {
            r.log(`${label}: the synth command failed\n${ran.out}`);
            return { roots: [], done };
          }
        }
        if (r.terragrunt) {
          try {
            await generateStacks(code.dir, { binary: r.binary, terragrunt: r.terragrunt.terragrunt });
          } catch (e) {
            r.log(`${label}: ${(e as Error).message}`);
          }
        }
        const present = live.components.filter((root) => existsSync(join(code.dir, root)));
        return { roots: await copyRootsOf(code.dir, present, r, work), done };
      } catch (e) {
        done();
        throw e;
      }
    },
    work,
    exec: asyncExec(r.exec),
    hint: SUFFIX_HOW,
    log: r.log,
  });
}

/** The commit the job runs at, for a teardown's record. */
const headOf = (repo: string): string => git(repo, ["rev-parse", "HEAD"]).stdout;

/** Destroy pull request `pr`'s live copy through a planned destroy, and record it. No copy: nothing to do. */
export async function ephemeralDown(repo: string, options: DownOptions): Promise<number> {
  const r = await ready(repo, options);
  const p = await ports(repo, r, options);
  const live = livePrEnvironments(await p.readRecords()).get(ephemeralSuffix(options.pr));
  const runUrl = runUrlOf(repo, r);
  const work = mkdtempSync(join(tmpdir(), "terragucci-ephemeral-plans-"));
  const result = await prEnvDown({
    pr: options.pr,
    reason: options.reason,
    ports: p,
    adapters: [ephemeralTeardown(repo, r, work)],
    ...(live ? { live } : {}),
    commit: live?.commit || headOf(repo),
    actor: r.actor,
    ...(runUrl ? { runUrl } : {}),
    ...(options.now ? { now: () => new Date(options.now!) } : {}),
  }).finally(() => rmSync(work, { recursive: true, force: true }));
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
  const work = mkdtempSync(join(tmpdir(), "terragucci-ephemeral-plans-"));
  const { exit, results } = await prEnvSweep({
    ports: p,
    adapters: [ephemeralTeardown(repo, r, work)],
    commit: headOf(repo),
    actor: r.actor,
    ...(runUrl ? { runUrl } : {}),
    ...(options.now ? { now: () => new Date(options.now!) } : {}),
  }).finally(() => rmSync(work, { recursive: true, force: true }));
  const now = options.now ?? new Date().toISOString();
  for (const res of results) {
    downReport(r, res.report.pr, res);
    if (res.record) await writeLive(repo, r, p, res.report.pr, now);
  }
  return exit;
}
