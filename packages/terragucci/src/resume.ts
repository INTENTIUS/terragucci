/**
 * Resuming a wave once its approval is on `chant/lifecycle`.
 *
 * A wave that waits ends its job (exit 3). An approval is a line pushed to
 * `chant/lifecycle`, and a push there starts nothing: the forges run a push's
 * workflows from the pushed branch, and that branch holds only the ledger. So
 * two things resume a wave instead.
 *
 * `terragucci resume`, run by the pipeline's resume job on a schedule
 * (`apply.resume`): it reads the ledger and finds each wave whose newest
 * pending digest an approval now names, which no apply has used yet. On
 * GitHub and Forgejo it writes the commit to apply (the default branch's,
 * where the job runs) for the job's wave loop, which applies from wave 1 as a
 * comment's apply does: a wave already applied plans no change, and each
 * gated wave counts only an approval of the plans it makes now. On GitLab it
 * retries the first apply job of the default branch's newest push pipeline
 * that did not succeed, when its wave is one of those, and GitLab runs the
 * waves after it.
 *
 * `terragucci approve`, after `chant approve` pushed the approval, with the
 * approver's own token (`resumeAfterApproval`): on GitHub it re-runs the
 * failed jobs of the run that waited, on GitLab it retries that pipeline's
 * job of the wave, and on Forgejo, whose API has no re-run, it comments
 * `/terragucci apply` on the pull request that made the commit. Without a
 * token it says so, and the resume job, or a re-run by hand, picks it up.
 *
 * The resume job also resumes a wave whose apply under an approval was
 * killed before it finished, once the run that applied is gone: the wave
 * plans again and applies the rest under that approval (./remainder.ts).
 * Only a wave of roots that apply per resource (choudoufu) records what it
 * needs for that; a failed apply is left to a re-run.
 *
 * A state migration (./migrate.ts) waits inside wave 1, on a gate of its own
 * in `_gates/tf-migrate.jsonl`. An approved migration resumes as wave 1 does:
 * wave 1 runs the migration before it plans.
 *
 * Neither approves anything: the wave's own gate decides again when it runs.
 */
import { spawnSync } from "node:child_process";
import { samePlanDigest } from "@intentius/chant/lifecycle/plan-digest";
import { decideGate, type AppliedRecord, type GateLedger, type PendingRecord } from "./apply";
import { forgeLiveness, type Liveness } from "./apply-rows";
import { finishOf } from "./remainder";
import { forgeCalls, gitlabCalls, pullOf } from "./review";
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
export function resumable(ledger: GateLedger, now: string, migrations?: GateLedger): Resumable[] {
  const out: Resumable[] = approvedGates(ledger, now, (gate) => /^wave-\d+$/.test(gate)).map(({ gate, ...r }) => ({ wave: Number(gate.slice(5)), ...r }));
  // A migration waits inside wave 1, so an approved one resumes wave 1, which runs it before it plans.
  if (migrations) out.push(...approvedGates(migrations, now, () => true).map(({ gate, ...r }) => ({ wave: 1, migration: gate, ...r })));
  for (const s of stoppedGates(ledger)) if (!out.some((w) => w.wave === s.wave && !w.migration)) out.push(s);
  return out.sort((a, b) => a.wave - b.wave || Number(Boolean(b.migration)) - Number(Boolean(a.migration)));
}

/** Each gate (that `take` keeps) whose newest pending digest an approval names, made after it, that no apply has used. */
function approvedGates(ledger: GateLedger, now: string, take: (gate: string) => boolean): (Omit<Resumable, "wave" | "migration"> & { gate: string })[] {
  const newest = new Map<string, PendingRecord>();
  for (const p of ledger.pending) {
    const before = newest.get(p.gate);
    if (take(p.gate) && p.planDigest && (!before || at(p.timestamp) >= at(before.timestamp))) newest.set(p.gate, p);
  }
  const out: (Omit<Resumable, "wave" | "migration"> & { gate: string })[] = [];
  for (const [gate, p] of newest) {
    const d = decideGate(ledger, gate, p.planDigest!, now);
    if (d.status !== "approved") continue;
    // An approval an apply already used: that apply ran, so there is nothing to resume.
    const used = (ledger.applied ?? []).some((a) => a.gate === gate && samePlanDigest(a.planDigest, p.planDigest) && at(a.approvedAt) >= at(d.at));
    if (used) continue;
    out.push({ gate, digest: p.planDigest!, by: d.by, ...(p.runId ? { runId: p.runId } : {}), ...(p.commit ? { commit: p.commit } : {}) });
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
export async function resumeStep(o: { ledger: GateLedger; migrations?: GateLedger; forge: ForgeKind; sha: string; env: NodeJS.ProcessEnv; now?: string; fetch?: Fetch; liveness?: Liveness }): Promise<ResumeStep> {
  const alive = o.liveness ?? forgeLiveness(o.env);
  const waves: Resumable[] = [];
  // A stopped apply whose run still runs is applying: it is resumed once that run is gone.
  for (const w of resumable(o.ledger, o.now ?? new Date().toISOString(), o.migrations)) {
    if (!w.stopped || (w.stopped.holder && (await alive({ run: w.stopped.holder, at: w.stopped.at })) === "dead")) waves.push(w);
  }
  if (waves.length === 0) return { kind: "none", why: "no wave waits with an approval that stands, and no approved apply stopped before it finished" };
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
    if (!waves.some((w) => w.wave === next.n)) return { kind: "none", why: `apply-wave-${next.n} of pipeline ${pipeline.id} has no approval that stands` };
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
export async function resumeAfterApproval(o: { origin: Origin; wave: { wave: number; runId?: string; commit?: string }; env?: NodeJS.ProcessEnv; fetch?: Fetch }): Promise<string> {
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
    if (forge === "github") {
      if (!o.wave.runId) return `not resumed from here: the pending fact names no run; ${later}`;
      const api = env.GITHUB_API_URL || (host === "github.com" ? "https://api.github.com" : `https://${host}/api/v3`);
      await call("POST", `${api}/repos/${path}/actions/runs/${o.wave.runId}/rerun-failed-jobs`, { authorization: `Bearer ${token}` });
      return `resumed: re-ran the failed jobs of run ${o.wave.runId}, so wave ${o.wave.wave} runs again and its gate decides`;
    }
    if (forge === "gitlab") {
      if (!o.wave.runId) return `not resumed from here: the pending fact names no pipeline; ${later}`;
      const api = `${env.CI_API_V4_URL || `${web}/api/v4`}/projects/${encodeURIComponent(path)}`;
      const auth = { "private-token": token };
      const jobs = await call("GET", `${api}/pipelines/${o.wave.runId}/jobs?per_page=100`, auth);
      const job = (Array.isArray(jobs) ? jobs : []).find((j: any) => j?.name === `apply-wave-${o.wave.wave}`);
      if (!job) return `not resumed from here: pipeline ${o.wave.runId} has no apply-wave-${o.wave.wave}; ${later}`;
      if (job.status !== "failed" && job.status !== "canceled") return `not resumed from here: apply-wave-${o.wave.wave} of pipeline ${o.wave.runId} is ${String(job.status)}; ${later}`;
      await call("POST", `${api}/jobs/${job.id}/retry`, auth);
      return `resumed: retried apply-wave-${o.wave.wave} of pipeline ${o.wave.runId}, and the waves after it follow`;
    }
    // Forgejo's API has no re-run: the merged pull request's /terragucci apply, as the approver, runs the waves again.
    if (!o.wave.commit) return `not resumed from here: the pending fact names no commit; ${later}`;
    const api = `${web}/api/v1/repos/${path}`;
    const auth = { authorization: `token ${token}` };
    const pr = await call("GET", `${api}/commits/${o.wave.commit}/pull`, auth).catch(() => null);
    if (!Number.isInteger(pr?.number)) return `not resumed from here: no merged pull request made ${o.wave.commit.slice(0, 8)}; ${later}`;
    await call("POST", `${api}/issues/${pr.number}/comments`, auth, { body: "/terragucci apply" });
    return `resumed: commented /terragucci apply on pull request ${pr.number}, so its waves run again and each gate decides`;
  } catch (e) {
    return `not resumed from here (${(e as Error).message}); ${later}`;
  }
}
