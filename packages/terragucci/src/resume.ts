/**
 * Resuming a wave once its approval is on `chant/lifecycle`.
 *
 * A wave that waits ends its job (exit 3). An approval is a line pushed to
 * `chant/lifecycle`, and a push there starts nothing: the forges run a push's
 * workflows from the pushed branch, and that branch holds only the ledger. So
 * two things resume a wave instead.
 *
 * `terragucci resume`, run by the pipeline's resume job on a schedule
 * (`apply.resume`). On GitLab it runs `chant run resume` for the waves'
 * gates (`tf-apply`) and the migrations' (`tf-migrate`): chant retries each
 * job that waits at a gate an approval, or a passing answer to its decision
 * point, now answers, and each job whose apply under an approval stopped
 * before it said how it ended, once its run is gone, from the run locator
 * chant recorded on the pending fact or terragucci on the apply's `changes`
 * line; GitLab runs the waves after it. On GitHub and Forgejo the job applies
 * in itself, with a read-only token, where chant run resume would re-run the
 * waiting run: it asks chant's `planGateResumes` which gates would resume
 * (approved and not yet spent by an apply, answered, or stopped), and for a
 * stopped apply whether the run that applied is gone, then writes the commit
 * to apply (the default branch's, where the job runs) for the job's wave
 * loop, which applies from wave 1 as a comment's apply does: a wave already
 * applied plans no change, and each gated wave counts only an approval of
 * the plans it makes now.
 *
 * `terragucci approve`, after `chant approve` pushed the approval, with the
 * approver's own token (`resumeAfterApproval`): on GitHub and GitLab chant's
 * `resumeGateRun` starts the one job that waited at that gate again, from the
 * run locator on its pending fact: GitHub re-runs the failed jobs of that
 * run, GitLab retries the job, and a run still going, that succeeded or that
 * was resumed already is left alone. On Forgejo, whose API has no re-run, it
 * comments `/terragucci apply` on the pull request that made the commit.
 * Without a token it says so, and the resume job, or a re-run by hand, picks
 * it up.
 *
 * A wave whose apply under an approval was killed before it finished plans
 * again and applies the rest under that approval (./remainder.ts). Only a
 * wave of roots that apply per resource (choudoufu) records what it needs for
 * that; a failed apply is left to a re-run.
 *
 * A state migration (./migrate.ts) waits inside wave 1, on a gate of its own
 * in `_gates/tf-migrate.jsonl`. An approved migration resumes as wave 1 does:
 * wave 1 runs the migration before it plans.
 *
 * A wave whose gate asks a decision point (`apply.point`, ./point-gate.ts)
 * waits on a question, and its gate's resolution is written only when the
 * wave runs again. So a wave whose standing pending fact cites a question
 * that now has an answer the gate passes on resumes too, with the questions
 * `chant workspace points` lists (./point-gate.ts, pointQuestions).
 *
 * Neither approves anything: the wave's own gate decides again when it runs.
 */
import { spawn, spawnSync } from "node:child_process";
import { delimiter, join } from "node:path";
import { resumeGateRun, type GateRunLocator } from "@intentius/chant/gate-resume-run";
import { planGateResumes, type GateResumeCandidate } from "@intentius/chant/op/gate-resume-plan";
import type { PendingGateRecord, PointQuestionState } from "@intentius/chant/point-decision";
import { chantCommand } from "./chant-bin";
import { MIGRATE_OP } from "./migrate";
import { APPLY_OP, runOf, type GateLedger, type PendingRecord } from "./apply";
import { forgeLiveness, type Liveness } from "./apply-rows";
import { forgeCalls, pullOf } from "./review";
import { forgejoForge } from "@intentius/chant/pr-forge";
import type { Fetch } from "./forge";

/** A wave the ledger says can apply now. */
export interface Resumable {
  wave: number;
  /** A state migration's name, when it is the migration wave 1 waits on that was approved (./migrate.ts). */
  migration?: string;
  digest: string;
  /** Who approved it. */
  by: string;
  /** The run (GitHub, Forgejo) or pipeline (GitLab) that waited, when the pending fact names it. */
  runId?: string;
  /** The commit the waiting wave planned, when the pending fact names it. */
  commit?: string;
  /** Set when the wave's apply under this approval was killed before it finished: the run that applied, and when it began. */
  stopped?: { holder: string; at: string };
}

const at = (iso: string): number => new Date(iso).getTime();

/**
 * Each wave the ledgers say a resume would apply now, as chant's
 * `planGateResumes` decides it: a wave whose standing pending fact an
 * approval answers that no apply has spent yet, or whose decision point has
 * an answer its gate passes on; an approved migration, which wave 1 runs; and
 * a wave whose apply under an approval stopped before it said how it ended
 * (the caller checks that its run is gone). Lowest wave first.
 */
export function resumable(ledger: GateLedger, now: string, migrations?: GateLedger, questions?: ReadonlyMap<string, PointQuestionState>): Resumable[] {
  const plan = (op: string, l: GateLedger) =>
    planGateResumes({
      op,
      pending: l.pending as unknown as PendingGateRecord[],
      resolutions: l.resolutions as never,
      applied: (l.applied ?? []) as never,
      finished: (l.finished ?? []) as never,
      now,
      ...(questions ? { questions } : {}),
    }).filter((c) => c.resumable);
  const out: Resumable[] = plan(APPLY_OP, ledger).filter((c) => /^wave-\d+$/.test(c.gate)).map((c) => ({ wave: Number(c.gate.slice(5)), ...fromCandidate(c) }));
  // A migration waits inside wave 1, so an approved one resumes wave 1, which runs it before it plans.
  if (migrations) out.push(...plan(MIGRATE_OP, migrations).filter((c) => c.source === "pending").map((c) => ({ wave: 1, migration: c.gate, ...fromCandidate(c) })));
  return out.sort((a, b) => a.wave - b.wave || Number(Boolean(b.migration)) - Number(Boolean(a.migration)));
}

/** A candidate chant would resume, as the resume job names it. */
function fromCandidate(c: GateResumeCandidate): Omit<Resumable, "wave" | "migration"> {
  const p = c.pending as unknown as PendingRecord | undefined;
  const runId = p ? runOf(p) : c.run?.run;
  return {
    digest: c.planDigest ?? "",
    by: c.approvedBy ?? "",
    ...(runId ? { runId } : {}),
    ...(p?.commit ? { commit: p.commit } : {}),
    ...(c.source === "stopped" && c.stopped ? { stopped: { holder: c.run?.run ?? "", at: c.stopped.appliedAt } } : {}),
  };
}

export type ForgeKind = "github" | "forgejo" | "gitlab";

/** What the resume job does next. */
export type ResumeStep =
  /** Nothing to resume. */
  | { kind: "none"; why: string }
  /** GitHub, Forgejo: apply the waves at `sha`, replying on `pr` when one made it. */
  | { kind: "apply"; sha: string; pr?: number; waves: Resumable[] };

/** The resume job's decision on GitHub and Forgejo, from the ledgers; on GitLab chant run resume decides and starts the jobs (resumeWithChant). Never throws for a forge it cannot read: it says why. */
export async function resumeStep(o: { ledger: GateLedger; migrations?: GateLedger; forge: ForgeKind; sha: string; env: NodeJS.ProcessEnv; now?: string; fetch?: Fetch; liveness?: Liveness; questions?: ReadonlyMap<string, PointQuestionState> }): Promise<ResumeStep> {
  if (o.forge === "gitlab") return { kind: "none", why: "on GitLab chant run resume starts each job that waits, or whose apply stopped" };
  const alive = o.liveness ?? forgeLiveness(o.env);
  const waves: Resumable[] = [];
  // A stopped apply whose run still runs is applying: it is resumed once that run is gone.
  for (const w of resumable(o.ledger, o.now ?? new Date().toISOString(), o.migrations, o.questions)) {
    if (!w.stopped || (w.stopped.holder && (await alive({ run: w.stopped.holder, at: w.stopped.at })) === "dead")) waves.push(w);
  }
  if (waves.length === 0) return { kind: "none", why: "no wave waits with an approval that stands, and no approved apply stopped before it finished" };
  let pr: number | undefined;
  try {
    pr = (await pullOf(forgeCalls(o.env, o.fetch), { ...o.env, TG_PR: "" }, o.sha))?.number;
  } catch {
    // A reply needs the pull request; the apply does not.
  }
  return { kind: "apply", sha: o.sha, ...(pr !== undefined ? { pr } : {}), waves };
}

/** The forge's API, read from the checkout's origin and the approver's environment. */
interface Origin {
  forge: ForgeKind;
  host: string;
  /** Scheme, host and port of the forge's web address: the origin's own for http(s), https and the host for ssh. */
  web: string;
  /** owner/name, or GitLab's project path. */
  path: string;
}

/** The checkout's origin: its host and path, and the forge it is (github.com and gitlab.com by name; `forge` from the config for any other host). */
export function originOf(url: string, configured?: string): Origin | undefined {
  const m = /^(?:([a-z+]+):\/\/)?(?:[^@/]+@)?([^/:]+)(:\d+)?[/:](.+?)(?:\.git)?\/?$/.exec(url.trim());
  if (!m) return undefined;
  const scheme = m[1];
  const host = m[2]!;
  const web = scheme === "http" || scheme === "https" ? `${scheme}://${host}${m[3] ?? ""}` : `https://${host}`;
  const forge: ForgeKind | undefined = host === "github.com" ? "github" : host === "gitlab.com" ? "gitlab" : configured === "github" || configured === "gitlab" || configured === "forgejo" ? configured : undefined;
  return forge ? { forge, host, web, path: m[4]! } : undefined;
}

/** The approver's token for the forge, from the environment, else from `gh auth token` on GitHub. */
function tokenFor(forge: ForgeKind, env: NodeJS.ProcessEnv): string | undefined {
  if (forge === "gitlab") return env.GITLAB_TOKEN || undefined;
  if (forge === "forgejo") return env.FORGEJO_TOKEN || undefined;
  if (env.GH_TOKEN || env.GITHUB_TOKEN) return env.GH_TOKEN || env.GITHUB_TOKEN;
  const r = spawnSync("gh", ["auth", "token"], { encoding: "utf-8" });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : undefined;
}

const TOKEN_ENV: Record<ForgeKind, string> = { github: "GH_TOKEN (or gh auth login)", forgejo: "FORGEJO_TOKEN", gitlab: "GITLAB_TOKEN" };

/**
 * After an approval of `wave`, start its apply again with the approver's
 * token. Returns the line to print; never throws, since the approval stands
 * either way.
 */
export async function resumeAfterApproval(o: { origin: Origin; wave: { wave: number; runId?: string; commit?: string; resume?: GateRunLocator }; env?: NodeJS.ProcessEnv; fetch?: Fetch }): Promise<string> {
  const env = o.env ?? process.env;
  const doFetch: Fetch = o.fetch ?? fetch;
  const { forge, host, web, path } = o.origin;
  const later = "the pipeline's resume job applies it on its next run when apply.resume is set; otherwise run its job again, or comment /terragucci apply";
  const token = tokenFor(forge, env);
  if (!token) return `not resumed from here: no token in ${TOKEN_ENV[forge]}; ${later}`;
  const call = async (method: string, api: string, auth: Record<string, string>, body?: unknown): Promise<any> => {
    const r = await doFetch(api, { method, headers: { "content-type": "application/json", ...auth }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!r.ok) throw new Error(`${method} ${api.replace(/^https?:\/\/[^/]+/, "")} answered ${r.status}`);
    if (r.status === 204) return null;
    return r.json().catch(() => null);
  };
  try {
    if (forge === "github" || forge === "gitlab") {
      // chant starts the job that waited again, from the run locator it recorded on the pending fact, and leaves alone a run still going, that succeeded or that was resumed already.
      if (!o.wave.resume) return `not resumed from here: the pending fact names no CI job; ${later}`;
      const out = await resumeGateRun(o.wave.resume, { token, ...(o.fetch ? { fetch: o.fetch as never } : {}) });
      if (out.status !== "resumed") return `not resumed from here: ${"reason" in out ? out.reason : out.how}; ${later}`;
      return `resumed: ${out.how}, so wave ${o.wave.wave} runs again and its gate decides`;
    }
    // Forgejo's API has no re-run: the merged pull request's /terragucci apply, as the approver, runs the waves again.
    if (!o.wave.commit) return `not resumed from here: the pending fact names no commit; ${later}`;
    const api = `${web}/api/v1/repos/${path}`;
    const auth = { authorization: `token ${token}` };
    const pr = await call("GET", `${api}/commits/${o.wave.commit}/pull`, auth).catch(() => null);
    if (!Number.isInteger(pr?.number)) return `not resumed from here: no merged pull request made ${o.wave.commit.slice(0, 8)}; ${later}`;
    await forgejoForge({ apiBase: `${web}/api/v1`, repo: path, token, host, fetch: doFetch }).addComment(pr.number, "/terragucci apply");
    return `resumed: commented /terragucci apply on pull request ${pr.number}, so its waves run again and each gate decides`;
  } catch (e) {
    return `not resumed from here (${(e as Error).message}); ${later}`;
  }
}

/** The ops whose waiting jobs `chant run resume` starts again: the waves' gates, and the migrations' that wave 1 waits on. */
export const RESUMED_OPS = ["tf-apply", MIGRATE_OP] as const;

/**
 * The GitLab resume job: `chant run resume --op <op>` for the waves' gates
 * and the migrations', with the project token the job carries (`TG_TOKEN`)
 * as chant's `CHANT_FORGE_TOKEN`. chant retries each job waiting at a gate
 * that an approval, or a passing answer to its decision point, now answers,
 * and each job whose apply stopped once its run is gone, and leaves one
 * still running or already retried alone.
 * Returns chant's exit code: 1 when a forge call failed or no token was set.
 */
export async function resumeWithChant(repo: string, env: NodeJS.ProcessEnv, o: { chant?: string; log?: (line: string) => void } = {}): Promise<number> {
  const log = o.log ?? ((l: string) => console.log(l));
  const token = env.CHANT_FORGE_TOKEN || env.TG_TOKEN || env.GITLAB_TOKEN;
  let code = 0;
  for (const op of RESUMED_OPS) {
    log(`terragucci resume: chant run resume --op ${op}`);
    const r = await runChant(repo, ["run", "resume", "--op", op], { ...env, ...(token ? { CHANT_FORGE_TOKEN: token } : {}) }, o.chant, "inherit");
    if (r.error) {
      log(`terragucci resume: chant run resume did not start (${r.error.message}); install terragucci again, which installs chant with it`);
      code = 1;
    } else if (r.status !== 0) code = r.status ?? 1;
  }
  return code;
}

/** Run the chant bin terragucci installs, without blocking: its output piped back, or inherited by the job's log. */
function runChant(repo: string, args: string[], env: NodeJS.ProcessEnv, chant: string | undefined, stdio: "pipe" | "inherit"): Promise<{ status: number | null; stdout: string; stderr: string; error?: Error }> {
  return new Promise((done) => {
    const child = spawn(chantCommand(repo, chant ? { chant } : {}), args, { cwd: repo, stdio: ["ignore", stdio, stdio], env: { ...env, PATH: [join(repo, "node_modules", ".bin"), env.PATH ?? ""].join(delimiter) } });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => (stdout += d));
    child.stderr?.on("data", (d) => (stderr += d));
    child.on("error", (error) => done({ status: null, stdout, stderr, error }));
    child.on("close", (status) => done({ status, stdout, stderr }));
  });
}
