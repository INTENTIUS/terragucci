/**
 * Day-2 actions: `terragucci action <root> <address>` runs one Terraform
 * `action` block of a root (rotate a key, flush a cache) under a gated
 * request, approved by someone other than the person who asked.
 *
 * The run is the terraform lexicon's `invokeAction` (chant#4653, op
 * `tf-action`): it plans `-invoke=<address>` in refresh-only mode, asks under
 * the subject `<root>:<address>` with a digest that binds the plan's action
 * invocations, and once an approval counts it spends it on
 * `_gates/tf-action/applied.jsonl`, applies the saved plan and writes a
 * finished line with `detail.result` `ok` or `failed`. A plan whose action
 * input moved after the approval asks anew. terragucci inits the root first,
 * with the root's own binary and environment, and runs the binary's commands
 * through its own exec.
 *
 * Where it is asked from:
 *
 *   a pull request comment   `/terragucci action <root> <address>`, read by
 *                            the action workflow (./render.ts
 *                            actionWorkflow) on the default branch's code;
 *                            the reply carries the digest and the approve line
 *   a dispatch               the action workflow's `root` and `address` inputs
 *   a shell                  `terragucci action <root> <address> [--json]`:
 *                            exit 3 while it waits, 0 once it ran, 1 on a
 *                            refusal or a failed run
 *
 * `terragucci approve action <root> --plan <digest>` approves it, and the
 * resume job (`terragucci action --resume`) runs each request an approval
 * now stands for, as the person who asked, so an approval from chat or a
 * ledger line runs it too. The requester's own approval never counts.
 *
 * Only Terraform 1.14 or newer invokes an action. A root on OpenTofu or
 * choudoufu is refused here by its engine's name, with the version terragucci
 * runs it at, before any binary runs and whichever chant is installed. A
 * chant without `invokeAction` gets a refusal naming the chant it needs.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { samePlanDigest } from "@intentius/chant/lifecycle/plan-digest";
import { readLedger, type PendingRecord } from "./apply";
import { approvalRule, checkoutApproval } from "./approval";
import { binaryEnv } from "./binary-env";
import { chantInvokeAction, type ChantGatedRequestRead, type ChantInvokeActionResult, type ChantRootRun } from "./chant-next";
import { ACTION_ADDRESS } from "./comment";
import { ConfigError, findConfig, loadConfig, resolveRepo, type Approval, type Binary } from "./config";
import { requestRules, syncLocalLedger } from "./gated-request";
import { TOOL_VERSIONS } from "./images";
import { detectShape } from "./shape";

export const ACTION_OP = "tf-action";
export const ACTION_LEDGER = `_gates/${ACTION_OP}.jsonl`;
/** chant's applied and finished lines of each action run (chant#4551 gated requests). */
export const ACTION_APPLIED = `_gates/${ACTION_OP}/applied.jsonl`;

/** Exit codes, as the waves give them. */
export const ACTION_EXIT = { done: 0, refused: 1, waiting: 3 } as const;

/** The line that approves an action's request. */
export const actionApproveCommand = (root: string, digest: string, sealed = false): string => `terragucci approve action ${root} --plan ${digest}${sealed ? " --sign" : ""}`;

/** The subject chant asks an action's request under: `<root>:<address>`. */
export const actionSubject = (root: string, address: string): string => `${root}:${address}`;

/** The refusal when the installed chant has no `invokeAction`. */
export const ACTION_NEEDS_CHANT = "terragucci action runs the terraform lexicon's invokeAction (chant#4653), which the installed chant does not carry; it needs a chant release that does";

/** The oldest Terraform that invokes an action. */
const MIN_TERRAFORM = "1.14";

/**
 * The refusal of a root whose binary has no action invocation (OpenTofu,
 * choudoufu), named with the version terragucci runs it at. Undefined for
 * Terraform, whose version chant reads before it plans.
 */
export function engineRefusal(root: string, binary: string): string | undefined {
  if (binary === "terraform") return undefined;
  const engine = binary === "tofu" ? "OpenTofu" : binary === "choudoufu" ? "choudoufu" : binary;
  const version = (TOOL_VERSIONS as Record<string, string>)[binary];
  return `${root}: an action runs on Terraform ${MIN_TERRAFORM} or newer, and this root runs ${engine} (${binary}${version ? ` ${version}` : ""}), which has no action invocation`;
}

/**
 * The reply to `/terragucci action` from a pipeline written with no action
 * workflow: one whose binary has no action invocation, named with its version.
 */
export function noActionReply(binary: string | undefined): string {
  const b = binary ? binaryName(binary) : undefined;
  if (b && b !== "terraform") {
    const engine = b === "tofu" ? "OpenTofu" : b;
    const version = (TOOL_VERSIONS as Record<string, string>)[b];
    return `an action runs on Terraform ${MIN_TERRAFORM} or newer, and this repository's roots run ${engine} (${b}${version ? ` ${version}` : ""}), which has no action invocation`;
  }
  return "this pipeline has no action workflow; run `terragucci init` again to write it";
}

/** What `terragucci action --json` prints. */
export interface ActionJson {
  status: "gated" | "ok" | "failed" | "refused" | "spent";
  root: string;
  address: string;
  digest?: string;
  /** The line that approves it, while it waits. */
  approve?: string;
  approvedBy?: string;
  reason?: string;
  /** The last lines of the apply's output, once it ran. */
  tail?: string;
}

export interface ActionResult {
  code: number;
  json: ActionJson;
}

export interface ActionOptions {
  root: string;
  address: string;
  /** Who asks. Default the CI actor, else the git user, else the login. */
  actor?: string;
  binary?: string;
  config?: string;
  /** Ask anew even when the same action ran already under an earlier request (a fresh ask from a person). Default true. */
  anew?: boolean;
  env?: NodeJS.ProcessEnv;
  /** Runs the binary in the root, for tests. */
  exec?: (binary: string, args: string[], dir: string, env: NodeJS.ProcessEnv) => { status: number; stdout: string; out: string };
  now?: string;
  log?: (line: string) => void;
}

const runBinary = (binary: string, args: string[], dir: string, env: NodeJS.ProcessEnv): { status: number; stdout: string; out: string } => {
  const p = spawnSync(binary, [`-chdir=${dir}`, ...args], { encoding: "utf-8", env: binaryEnv(env), maxBuffer: 1 << 26 });
  return { status: p.status ?? 1, stdout: p.stdout ?? "", out: `${p.stdout ?? ""}${p.stderr ?? ""}${p.error ? p.error.message : ""}` };
};

const tail = (s: string): string => s.trim().split("\n").slice(-10).join("\n");

function gitOut(repo: string, args: string[]): string {
  const p = spawnSync("git", args, { cwd: repo, encoding: "utf-8" });
  return p.status === 0 ? p.stdout.trim() : "";
}

/** Who asks: the CI actor, else the git user, else the login. */
export function requesterOf(repo: string, env: NodeJS.ProcessEnv, actor?: string): string {
  return actor || env.GITHUB_ACTOR || env.GITLAB_USER_LOGIN || gitOut(repo, ["config", "user.name"]) || env.USER || env.USERNAME || "unknown";
}

/** The root's directory, checked to be a directory of this repository. */
function rootDir(repo: string, root: string): { rel: string; dir: string } {
  const rel = root.replace(/\/+$/, "");
  const dir = resolve(repo, rel);
  if (!rel || rel.split("/").includes("..") || !existsSync(dir) || !statSync(dir).isDirectory()) throw new ConfigError(`${root} is not a root of this repository`);
  return { rel, dir };
}

function asJson(root: string, address: string, r: ChantInvokeActionResult, sealed: boolean): ActionJson {
  switch (r.outcome) {
    case "gated":
      return { status: "gated", root, address, digest: r.digest, approve: actionApproveCommand(root, r.digest, sealed), ...(r.reason ? { reason: r.reason } : {}) };
    case "spent":
      return { status: "spent", root, address, digest: r.digest, reason: `the request ${r.digest} ran already, and a request runs once; ask again to run the action again` };
    case "ok":
      return { status: "ok", root, address, digest: r.digest, approvedBy: r.approvedBy, tail: r.tail };
    case "failed":
      return { status: "failed", root, address, digest: r.digest, approvedBy: r.approvedBy, reason: r.error, tail: r.tail };
    case "refused":
      return { status: "refused", root, address, reason: r.reason };
  }
}

/** A line or two that says how an action call ended, for a log or a pull request reply. */
export function describeAction(j: ActionJson): string {
  switch (j.status) {
    case "gated":
      return `${j.address} on ${j.root} waits for an approval of ${j.digest} by someone other than the person who asked${j.reason ? ` (${j.reason})` : ""}. Approve it with:\n\n    ${j.approve}\n\nThe resume job runs it once the approval stands, or ask again after it.`;
    case "ok":
      return `ran ${j.address} on ${j.root}, approved by ${j.approvedBy} (${j.digest})`;
    case "failed":
      return `${j.address} on ${j.root} failed under the approval of ${j.approvedBy} (${j.digest}): ${j.reason}`;
    case "spent":
    case "refused":
      return j.reason ?? `${j.address} on ${j.root} did not run`;
  }
}

/**
 * Ask for an action, and run it once an approval counts. Never throws for a
 * refusal: the result says it, with exit 1. A missing root or an unreadable
 * config throws ConfigError.
 */
export async function runAction(repo: string, o: ActionOptions): Promise<ActionResult> {
  const env = o.env ?? process.env;
  const exec = o.exec ?? runBinary;
  const address = o.address;
  const refuse = (root: string, reason: string): ActionResult => ({ code: ACTION_EXIT.refused, json: { status: "refused", root, address, reason } });
  const { rel, dir } = rootDir(repo, o.root);
  if (!ACTION_ADDRESS.test(address)) return refuse(rel, `${rel}: "${address}" is not an action address; give action.<type>.<label>, after module.<name>. for an action in a module`);
  const configPath = o.config ?? findConfig(repo);
  const config = configPath ? await loadConfig(resolve(configPath)) : {};
  if (config.projects) throw new ConfigError("action runs in a project's own checkout, not a control repo");
  const settings = resolveRepo(config);
  const shape = detectShape(repo, settings);
  const binary: Binary | string = o.binary ?? settings.binary ?? shape.binary([rel]).value;
  // Ruling E: OpenTofu and choudoufu have no action invocation; refused by name, before any binary runs, on any chant.
  const engine = engineRefusal(rel, binaryName(binary));
  if (engine) return refuse(rel, engine);
  const chant = await chantInvokeAction();
  if (!chant) return refuse(rel, ACTION_NEEDS_CHANT);

  const init = exec(binary, ["init", "-input=false", "-no-color"], dir, shape.rootInit(rel, env)?.init ?? env);
  if (init.status !== 0) return refuse(rel, `${rel}: ${binary} init failed:\n${tail(init.out)}`);
  const rule = await approvalRule(repo, { at: "HEAD", ...(configPath ? { config: configPath } : {}) });
  const sealed = rule.mode === "sealed";
  syncLocalLedger(repo);
  // The saved plan holds the action's input, so it lives outside the checkout and goes once the call returns.
  const scratch = mkdtempSync(join(tmpdir(), "terragucci-action-"));
  try {
    const result = await chant.invokeAction({
      root: rel,
      dir,
      binary,
      address,
      requester: requesterOf(repo, env, o.actor),
      rules: requestRules(rule),
      cwd: repo,
      env: shape.rootEnv(rel, env),
      exec: asyncExec(exec),
      planFile: join(scratch, "action.tfplan"),
      ...(o.now ? { now: o.now } : {}),
      ...(env.GITHUB_RUN_ID ? { runId: env.GITHUB_RUN_ID } : env.CI_PIPELINE_ID ? { runId: env.CI_PIPELINE_ID } : {}),
      ...(o.anew === false ? {} : { anew: true }),
    });
    return { code: result.exit, json: asJson(rel, address, result, sealed) };
  } catch (e) {
    return refuse(rel, (e as Error).message);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** The binary's name as the engine check reads it: a path's last part. */
const binaryName = (binary: string): string => binary.split(/[\\/]/).pop()!.replace(/\.exe$/, "");

function asyncExec(exec: NonNullable<ActionOptions["exec"]>): NonNullable<ChantRootRun["exec"]> {
  return async (binary, args, dir, env) => {
    const r = exec(binary, args, dir, env);
    return { code: r.status, stdout: r.stdout, out: r.out };
  };
}

/** A request the resume job runs: approved by someone other than the requester, not spent, not expired. */
export interface ResumableAction {
  root: string;
  address: string;
  digest: string;
  requester: string;
  approvedBy: string;
}

/** The requests an approval now stands for, oldest first. */
export function resumableActions(requests: readonly ChantGatedRequestRead[], now: string): ResumableAction[] {
  const out: ResumableAction[] = [];
  for (const g of requests) {
    if (g.op !== ACTION_OP || g.applied || g.request.kind !== "action") continue;
    if (g.pending.expiresAt && g.pending.expiresAt <= now) continue;
    const approval = g.approvals.filter((a) => a.resolvedBy !== g.request.by).at(-1);
    const address = g.request.fields.address;
    const root = g.request.subject.endsWith(`:${address}`) ? g.request.subject.slice(0, -(address?.length ?? 0) - 1) : undefined;
    if (!approval || !address || !root) continue;
    out.push({ root, address, digest: g.digest, requester: g.request.by, approvedBy: approval.resolvedBy });
  }
  return out;
}

/**
 * The resume job's run: every action request an approval now stands for,
 * asked again as the person who asked it, which plans the action as it is
 * now. A plan that moved since the approval asks anew and runs nothing.
 * With `dryRun`, only the list. Returns the exit code: 1 when one failed.
 */
export async function resumeActions(repo: string, o: { dryRun?: boolean; env?: NodeJS.ProcessEnv; exec?: ActionOptions["exec"]; now?: string; log?: (line: string) => void } = {}): Promise<{ code: number; actions: ResumableAction[]; results: ActionResult[] }> {
  const log = o.log ?? ((l: string) => console.log(l));
  const chant = await chantInvokeAction();
  if (!chant) {
    log(`no action is resumed: ${ACTION_NEEDS_CHANT}`);
    return { code: 0, actions: [], results: [] };
  }
  syncLocalLedger(repo);
  const now = o.now ?? new Date().toISOString();
  const actions = resumableActions(await chant.readGatedRequests(ACTION_OP, { cwd: repo }).catch(() => []), now);
  if (actions.length === 0) log("no action waits with an approval that stands");
  const results: ActionResult[] = [];
  for (const a of actions) {
    log(`${a.address} on ${a.root}, asked by ${a.requester}, was approved by ${a.approvedBy} for ${a.digest}`);
    if (o.dryRun) continue;
    const r = await runAction(repo, { root: a.root, address: a.address, actor: a.requester, anew: false, ...(o.env ? { env: o.env } : {}), ...(o.exec ? { exec: o.exec } : {}), now });
    log(describeAction(r.json));
    results.push(r);
  }
  return { code: results.some((r) => r.code === ACTION_EXIT.refused) ? 1 : 0, actions, results };
}

/** Two names for one person, as chant's gate compares a requester and an approver: case aside, and a forge prefix aside. */
const samePerson = (a: string, b: string): boolean => a.replace(/^[a-z]+:/i, "").toLowerCase() === b.replace(/^[a-z]+:/i, "").toLowerCase();

export interface ApproveActionOptions {
  root: string;
  plan?: string;
  sign?: string | true;
  actor?: string;
  dryRun?: boolean;
  env?: NodeJS.ProcessEnv;
  now?: string;
  log?: (line: string) => void;
}

/**
 * `terragucci approve action <root> --plan <digest>`: find the action request
 * of that root waiting for that digest, refuse an approval by the person who
 * asked, and return chant's approve arguments. `--dry-run` prints the ledger
 * line chant would write and runs nothing.
 */
export async function approveActionArgs(repo: string, o: ApproveActionOptions): Promise<{ code: number; args?: string[]; gate?: string; next?: string }> {
  const log = o.log ?? ((l: string) => console.log(l));
  const env = o.env ?? process.env;
  const usage = "terragucci approve action <root> --plan <digest>";
  const plan = o.plan?.trim();
  if (!plan || !/^\S+$/.test(plan)) throw new ConfigError(`approve action needs --plan <digest>, the digest its request printed: ${usage}`);
  const root = o.root.replace(/\/+$/, "");
  const ledger = readLedger(repo, ACTION_LEDGER);
  const at = (iso: string): number => new Date(iso).getTime();
  const requests = ledger.pending.filter((p) => p.gate.startsWith(`${root}:`) && p.planDigest).sort((a, b) => at(b.timestamp) - at(a.timestamp));
  const asked = requests.find((p) => samePlanDigest(p.planDigest, plan));
  if (!asked) {
    log(requests.length === 0
      ? `not approved: no action of ${root} waits for an approval on chant/lifecycle`
      : `not approved: no action of ${root} waits for ${plan}; ${requests.map((p) => `${p.gate.slice(root.length + 1)} waits for ${p.planDigest}`).join("; ")}. What it asks moved since that digest; read the new request, then approve its digest`);
    return { code: 1 };
  }
  const request = (asked as PendingRecord & { request?: { by?: unknown } }).request;
  const requester = typeof request?.by === "string" ? request.by : undefined;
  const approver = o.actor || gitOut(repo, ["config", "user.name"]) || env.USER || env.USERNAME || "";
  if (requester && approver && samePerson(requester, approver)) {
    log(`not approved: ${approver} asked for ${asked.gate.slice(root.length + 1)} on ${root}, and the rule of a gated request is that the requester's own approval never counts; someone else approves it`);
    return { code: 1 };
  }
  const configPath = findConfig(repo);
  const mode: Approval = checkoutApproval(repo, configPath ? await loadConfig(configPath) : {})?.mode ?? "ledger";
  const sign = o.sign ?? (mode === "sealed" ? true : undefined);
  log(`${asked.gate.slice(root.length + 1)} on ${root} waits for an approval of ${asked.planDigest}${asked.description ? ` (${asked.description})` : ""}, since ${asked.timestamp}`);
  if (at(asked.expiresAt) < Date.now()) log(`  its pending fact expired at ${asked.expiresAt}`);
  const args = ["approve", ACTION_OP, asked.gate, "--plan", asked.planDigest!, ...(o.actor ? ["--actor", o.actor] : []), ...(sign === undefined ? [] : sign === true ? ["--sign"] : ["--sign", sign])];
  if (o.dryRun) {
    const line = { version: 1, kind: "resolution", op: ACTION_OP, gate: asked.gate, resolvedBy: approver || "<you>", timestamp: o.now ?? new Date().toISOString(), planDigest: asked.planDigest, ...(sign !== undefined ? { seal: "<signed>" } : {}) };
    log(`would write to ${ACTION_LEDGER} on chant/lifecycle: ${JSON.stringify(line)}`);
  }
  return { code: 0, args, gate: asked.gate, next: `the resume job runs it once the approval stands, or ${requester ?? "the person who asked"} asks again with terragucci action ${asked.gate.replace(":", " ")}` };
}

/** Read a decision file the action job's first step wrote (./comment.ts `decideComment` with `action: "run"`). */
export function readActionDecision(file: string): { go: boolean; reason: string; root?: string; address?: string; pr?: number; user?: string } {
  const d = JSON.parse(readFileSync(file, "utf-8")) as { go?: unknown; reason?: unknown; root?: unknown; address?: unknown; pr?: unknown; user?: unknown };
  return {
    go: d.go === true,
    reason: typeof d.reason === "string" ? d.reason : "",
    ...(typeof d.root === "string" ? { root: d.root } : {}),
    ...(typeof d.address === "string" ? { address: d.address } : {}),
    ...(typeof d.pr === "number" ? { pr: d.pr } : {}),
    ...(typeof d.user === "string" ? { user: d.user } : {}),
  };
}
