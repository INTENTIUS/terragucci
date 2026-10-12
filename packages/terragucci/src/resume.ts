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
 * point, now answers, from the run locator chant recorded on its pending
 * fact, and GitLab runs the waves after it. On GitHub and Forgejo it reads
 * the ledger and finds each wave whose newest pending digest an approval now
 * names, which no apply has used yet, and writes the commit to apply (the
 * default branch's, where the job runs) for the job's wave loop, which
 * applies from wave 1 as a comment's apply does: a wave already applied plans
 * no change, and each gated wave counts only an approval of the plans it
 * makes now. That job runs with a read-only token and applies in itself,
 * where chant run resume would re-run the waiting run.
 *
 * `terragucci approve`, after `chant approve` pushed the approval, with the
 * approver's own token (`resumeAfterApproval`): on GitHub and GitLab it runs
 * `chant run resume --op <op>`, which starts the job that waited again from
 * the run locator chant recorded on its pending fact: GitHub re-runs the
 * failed jobs of that run, GitLab retries the job, and a run still going,
 * that succeeded or that was resumed already is left alone. chant names no
 * single gate to resume (chant#3854), so it starts any other job of the op
 * whose approval arrived too, which approves nothing. On Forgejo, whose API has no re-run, it comments
 * `/terragucci apply` on the pull request that made the commit. Without a
 * token it says so, and the resume job, or a re-run by hand, picks it up.
 *
 * The resume job also resumes a wave whose apply under an approval was
 * killed before it finished, once the run that applied is gone: the wave
 * plans again and applies the rest under that approval (./remainder.ts).
 * That apply left no pending fact, so this is terragucci's on every forge.
 * Only a wave of roots that apply per resource (choudoufu) records what it
 * needs for that; a failed apply is left to a re-run.
 *
 * A state migration (./migrate.ts) waits inside wave 1, on a gate of its own
 * in `_gates/tf-migrate.jsonl`. An approved migration resumes as wave 1 does:
 * wave 1 runs the migration before it plans.
 *
 * A wave whose gate asks a decision point (`apply.point`, ./point-gate.ts)
 * waits on a question, and its gate's resolution is written only when the
 * wave runs again. So the resume job also resumes a wave whose newest pending
 * fact cites a question that now has an answer the gate passes on, as
 * chant's `pointGateResumable` decides, with the questions `chant workspace
 * points` lists (./point-gate.ts, pointQuestions); `chant run resume` makes
 * the same check on GitLab.
 *
 * Neither approves anything: the wave's own gate decides again when it runs.
 */
import { spawn, spawnSync } from "node:child_process";
import { delimiter, join } from "node:path";
import type { GateRunLocator } from "@intentius/chant/op/gate-resume";
import { chantCommand } from "./chant-bin";
import { MIGRATE_OP } from "./migrate";
import { samePlanDigest } from "@intentius/chant/lifecycle/plan-digest";
import { pointGateResumable, type PendingGateRecord, type PointQuestionState } from "@intentius/chant/point-decision";
import { decideGate, runOf, type AppliedRecord, type GateLedger, type PendingRecord } from "./apply";
import { forgeLiveness, type Liveness } from "./apply-rows";
import { finishOf } from "./remainder";
import { forgeCalls, gitlabCalls, pullOf } from "./review";
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
 * Each wave whose newest pending digest an approval names, made after that
 * pending fact, and that no apply has used yet. Lowest wave first.
 */
export function resumable(ledger: GateLedger, now: string, migrations?: GateLedger, questions?: ReadonlyMap<string, PointQuestionState>): Resumable[] {
  const out: Resumable[] = approvedGates(ledger, now, (gate) => /^wave-\d+$/.test(gate), questions).map(({ gate, ...r }) => ({ wave: Number(gate.slice(5)), ...r }));
  // A migration waits inside wave 1, so an approved one resumes wave 1, which runs it before it plans.
  if (migrations) out.push(...approvedGates(migrations, now, () => true).map(({ gate, ...r }) => ({ wave: 1, migration: gate, ...r })));
  for (const s of stoppedGates(ledger)) if (!out.some((w) => w.wave === s.wave && !w.migration)) out.push(s);
  return out.sort((a, b) => a.wave - b.wave || Number(Boolean(b.migration)) - Number(Boolean(a.migration)));
}

/** Each gate (that `take` keeps) whose newest pending digest an approval names, made after it, that no apply has used. */
function approvedGates(ledger: GateLedger, now: string, take: (gate: string) => boolean, questions?: ReadonlyMap<string, PointQuestionState>): (Omit<Resumable, "wave" | "migration"> & { gate: string })[] {
  const newest = new Map<string, PendingRecord>();
  for (const p of ledger.pending) {
    const before = newest.get(p.gate);
    if (take(p.gate) && p.planDigest && (!before || at(p.timestamp) >= at(before.timestamp))) newest.set(p.gate, p);
  }
  const out: (Omit<Resumable, "wave" | "migration"> & { gate: string })[] = [];
  for (const [gate, p] of newest) {
    const d = decideGate(ledger, gate, p.planDigest!, now);
    if (d.status !== "approved") {
      // A gate that asks a decision point: its question answered with an answer the gate passes on (chant's rule). The wave writes the resolution when it runs.
      const point = p.answer && questions ? pointGateResumable(p as unknown as PendingGateRecord, questions.get(p.answer.id)) : undefined;
      if (point?.resumable) out.push({ gate, digest: p.planDigest!, by: point.answeredBy, ...(runOf(p) ? { runId: runOf(p) } : {}), ...(p.commit ? { commit: p.commit } : {}) });
      continue;
    }
    // An approval an apply already used: that apply ran, so there is nothing to resume.
    const used = (ledger.applied ?? []).some((a) => a.gate === gate && samePlanDigest(a.planDigest, p.planDigest) && at(a.approvedAt) >= at(d.at));
    if (used) continue;
    out.push({ gate, digest: p.planDigest!, by: d.by, ...(runOf(p) ? { runId: runOf(p) } : {}), ...(p.commit ? { commit: p.commit } : {}) });
  }
  return out;
}

/**
 * Each wave whose newest apply under an approval recorded its changes and
 * then never recorded how it ended, with no plan of the wave asking for an
 * approval since: an apply that was killed, or is still running.
 */
function stoppedGates(ledger: GateLedger): Resumable[] {
  const newest = new Map<string, AppliedRecord>();
  for (const a of ledger.applied ?? []) {
    const before = newest.get(a.gate);
    if (/^wave-\d+$/.test(a.gate) && (!before || at(a.timestamp) >= at(before.timestamp))) newest.set(a.gate, a);
  }
  const out: Resumable[] = [];
  for (const [gate, a] of newest) {
    if (!a.changes || finishOf(ledger, a)) continue;
    if (ledger.pending.some((p) => p.gate === gate && at(p.timestamp) > at(a.timestamp))) continue;
    out.push({ wave: Number(gate.slice(5)), digest: a.planDigest, by: a.approvedBy, ...(a.runId ? { runId: a.runId } : {}), ...(a.commit ? { commit: a.commit } : {}), stopped: { holder: a.holder ?? a.runId ?? "", at: a.timestamp } });
  }
  return out;
}

export type ForgeKind = "github" | "forgejo" | "gitlab";

/** What the resume job does next. */
export type ResumeStep =
  /** Nothing to resume. */
  | { kind: "none"; why: string }
  /** GitHub, Forgejo: apply the waves at `sha`, replying on `pr` when one made it. */
  | { kind: "apply"; sha: string; pr?: number; waves: Resumable[] }
  /** GitLab: the job retried. */
  | { kind: "retried"; job: string; pipeline: number; url?: string; waves: Resumable[] };

/** The resume job's decision, from the ledger and, on GitLab, the default branch's newest push pipeline. Never throws for a forge it cannot read: it says why. */
export async function resumeStep(o: { ledger: GateLedger; migrations?: GateLedger; forge: ForgeKind; sha: string; env: NodeJS.ProcessEnv; now?: string; fetch?: Fetch; liveness?: Liveness; questions?: ReadonlyMap<string, PointQuestionState> }): Promise<ResumeStep> {
  const alive = o.liveness ?? forgeLiveness(o.env);
  const waves: Resumable[] = [];
  // A stopped apply whose run still runs is applying: it is resumed once that run is gone.
  for (const w of resumable(o.ledger, o.now ?? new Date().toISOString(), o.migrations, o.questions)) {
    if (!w.stopped || (w.stopped.holder && (await alive({ run: w.stopped.holder, at: w.stopped.at })) === "dead")) waves.push(w);
  }
  if (o.forge === "gitlab") {
    // chant run resume starts the jobs that wait at a gate (resumeWithChant); a stopped apply left no pending fact, so it is terragucci's.
    const stopped = waves.filter((w) => w.stopped);
    waves.length = 0;
    waves.push(...stopped);
  }
  if (waves.length === 0) return { kind: "none", why: o.forge === "gitlab" ? "no approved apply stopped before it finished" : "no wave waits with an approval that stands, and no approved apply stopped before it finished" };
  if (o.forge !== "gitlab") {
    let pr: number | undefined;
    try {
      pr = (await pullOf(forgeCalls(o.env, o.fetch), { ...o.env, TG_PR: "" }, o.sha))?.number;
    } catch {
      // A reply needs the pull request; the apply does not.
    }
    return { kind: "apply", sha: o.sha, ...(pr !== undefined ? { pr } : {}), waves };
  }
  try {
    const f = gitlabCalls(o.env, o.fetch);
    const base = o.env.CI_DEFAULT_BRANCH || "main";
    const list = await f.get(`${f.repo}/pipelines?ref=${encodeURIComponent(base)}&source=push&order_by=id&sort=desc&per_page=1`);
    const pipeline = Array.isArray(list) ? list[0] : undefined;
    if (!pipeline) return { kind: "none", why: `no push pipeline ran on ${base}` };
    const jobs = await f.get(`${f.repo}/pipelines/${pipeline.id}/jobs?per_page=100`);
    const next = (Array.isArray(jobs) ? jobs : [])
      .map((j: any) => ({ j, n: Number(/^apply-wave-([1-9][0-9]*)$/.exec(String(j?.name))?.[1]) }))
      .filter((w) => Number.isInteger(w.n))
      .sort((a, b) => a.n - b.n)
      .find((w) => w.j.status !== "success");
    if (!next) return { kind: "none", why: `every wave of pipeline ${pipeline.id} applied` };
    if (!waves.some((w) => w.wave === next.n)) return { kind: "none", why: `apply-wave-${next.n} of pipeline ${pipeline.id} has no stopped apply to finish` };
    if (next.j.status !== "failed" && next.j.status !== "canceled") return { kind: "none", why: `apply-wave-${next.n} of pipeline ${pipeline.id} is ${String(next.j.status)}, and GitLab retries only a failed or canceled job` };
    const retried = await f.post(`${f.repo}/jobs/${next.j.id}/retry`, {});
    return { kind: "retried", job: `apply-wave-${next.n}`, pipeline: Number(pipeline.id), ...(typeof retried?.web_url === "string" ? { url: retried.web_url } : {}), waves };
  } catch (e) {
    return { kind: "none", why: `GitLab could not be read (${(e as Error).message})` };
  }
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
export async function resumeAfterApproval(o: { origin: Origin; wave: { wave: number; runId?: string; commit?: string; resume?: GateRunLocator }; env?: NodeJS.ProcessEnv; fetch?: Fetch; repo?: string; op?: string; gate?: string; chant?: string }): Promise<string> {
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
      const op = o.op ?? "tf-apply";
      const gate = o.gate ?? `wave-${o.wave.wave}`;
      const repo = o.repo ?? process.cwd();
      const r = await runChant(repo, ["run", "resume", "--op", op, "--json"], { ...env, CHANT_FORGE_TOKEN: token }, o.chant, "pipe");
      if (r.error) return `not resumed from here: chant run resume did not start (${r.error.message}); ${later}`;
      let reports: { gate: string; status: string; message: string }[] = [];
      try {
        reports = (JSON.parse(r.stdout) as { reports?: typeof reports }).reports ?? [];
      } catch {
        return `not resumed from here: chant run resume exited ${r.status}: ${(r.stderr || r.stdout).trim().split("\n").pop() ?? ""}; ${later}`;
      }
      const mine = reports.find((x) => x.gate === gate);
      if (!mine) return `not resumed from here: chant found no job waiting at ${op} / ${gate}; ${later}`;
      if (mine.status !== "resumed") return `not resumed from here: ${mine.message}; ${later}`;
      return `resumed: ${mine.message}, so wave ${o.wave.wave} runs again and its gate decides`;
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
 * The GitLab resume job's part that is chant's: `chant run resume --op <op>`
 * for the waves' gates and the migrations', with the project token the job
 * carries (`TG_TOKEN`) as chant's `CHANT_FORGE_TOKEN`. chant retries each job
 * waiting at a gate that an approval, or a passing answer to its decision
 * point, now answers, and leaves one still running or already retried alone.
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
