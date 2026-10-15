// The demo's pipeline runs as the reports bucket holds them for behold's kiosk:
// <prefix>/runs/index.json (schema demo.runs/v1) and <prefix>/runs/<id>.json
// (schema demo.run/v1). Pure functions over what Forgejo's API returns; the
// fetching and the uploads are in scripts/demo-runs.ts, which stack/demo.sh calls.

export const KEEP = 30;
export const STEP_LINES = 300;
export const LINE_CHARS = 500;

export type Status = "queued" | "running" | "waiting" | "success" | "failure" | "cancelled" | "skipped";
export type Trigger = "plan" | "merge" | "resume" | "reset" | "base" | "push";

/** What Forgejo returns for a run (GET /repos/{repo}/actions/runs/{id}), the fields read here. */
export interface ForgeRun {
  id: number;
  title: string;
  event: string;
  status: string;
  commit_sha: string;
  prettyref?: string;
  created: string;
  started?: string;
  stopped?: string;
}

/** What Forgejo returns for a job (GET .../runs/{id}/jobs). */
export interface ForgeJob {
  id: number;
  name: string;
  needs: string[] | null;
  status: string;
  task_id: number;
}

/** What the driver knows of a run: one line of <state>/runs/marks.jsonl. */
export interface Mark {
  id: number;
  trigger?: Trigger;
  cycle?: number | null;
  scenario?: string | null;
  pull?: number | null;
  ref?: string | null;
}

export interface Step {
  name: string;
  status: Status;
  started_at: string | null;
  ended_at: string | null;
  log: string[];
  truncated: number;
}

export interface JobSummary {
  id: number;
  name: string;
  needs: string[];
  status: Status;
  started_at: string | null;
  ended_at: string | null;
}

export interface Job extends JobSummary {
  steps: Step[];
}

export interface RunDoc {
  schema: "demo.run/v1";
  id: number;
  title: string;
  event: string;
  trigger: Trigger;
  commit: string;
  pull: number | null;
  cycle: number | null;
  scenario: string | null;
  status: Status;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
  jobs: Job[];
}

export interface IndexEntry {
  id: number;
  title: string;
  event: string;
  trigger: Trigger;
  ref: string | null;
  commit: string;
  pull: number | null;
  cycle: number | null;
  scenario: string | null;
  status: Status;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
  jobs: JobSummary[];
}

export interface IndexDoc {
  schema: "demo.runs/v1";
  updated_at: string;
  keep: number;
  runs: IndexEntry[];
}

export const ENDED: ReadonlySet<Status> = new Set<Status>(["waiting", "success", "failure", "cancelled", "skipped"]);

/**
 * Forgejo's status onto the kiosk's. Forgejo's own "waiting" (and "blocked",
 * "unknown") is a run or job no runner has picked up yet: queued here. The
 * kiosk's "waiting" is a job held at a terragucci gate, which Forgejo calls
 * failure; gateHeld says so.
 */
export function mapStatus(forge: string, gateHeld = false): Status {
  switch (forge) {
    case "success":
    case "cancelled":
    case "skipped":
    case "running":
      return forge;
    case "failure":
      return gateHeld ? "waiting" : "failure";
    default:
      return "queued";
  }
}

/** Forgejo writes an unset time as the zero time of Go or of Unix. */
export function forgeTime(t: string | undefined | null): string | null {
  if (!t || t.startsWith("0001-") || t.startsWith("1970-")) return null;
  return t;
}

const STAMP = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z) ?/;
// CSI sequences and the two-byte escapes.
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-Z\\-_]/g;

/** Second or millisecond precision, as Date prints it. */
function normTime(t: string): string {
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? t : d.toISOString();
}

/** The runner's exit line: `⚙️ [runner]: exitcode '3': failure`. */
const EXIT = /\[runner\]: exitcode '(\d+)'/;
const START = /^⭐ Run (Main|Pre|Post) (.+)$/;
const END = /^\s*(✅|❌)\s+(Success|Failure) - /;
const TRAILER = /^🏁\s+Job (\w+)/;
const GATE = "waits for an approval";

/** True when the job's log says a terragucci gate held it: it printed the gate line and exited 3. */
export function gateHeld(log: string): boolean {
  return log.includes(GATE) && /\[runner\]: exitcode '3'/.test(log);
}

/** The name of the steps between an end marker and the next start marker, which the log does not name. */
export const UNNAMED = "Steps without a marker";

/**
 * A job's log split into steps on the runner's markers. Lines before the
 * first `⭐ Run` are "Set up job", the runner's trailer from `🏁 Job` on is
 * "Complete job". `✅`/`❌` end a step, and so does the runner's exit line
 * when a step's command fails (the log has no `❌` for it then); lines
 * after an end and before the next start are a step of their own. Each line
 * loses its timestamp and its ANSI escapes, and is cut to 500 characters.
 * `drop` lines (the secret guard) are left out. `jobStatus` is the job's,
 * mapped: a step still open when the job ended takes it, and while it runs
 * the last step is running.
 */
export function parseSteps(log: string, jobStatus: Status, drop: string[] = []): Step[] {
  interface Open { name: string; status: Status | null; started_at: string | null; ended_at: string | null; lines: string[] }
  const held = gateHeld(log);
  let cur: Open = { name: "Set up job", status: null, started_at: null, ended_at: null, lines: [] };
  const all: Open[] = [cur];
  let last: string | null = null;

  // A step with no end marker ends where the next one starts.
  const begin = (name: string, at: string | null) => {
    if (cur.status === null) {
      cur.status = "success";
      cur.ended_at = at;
    }
    cur = { name, status: null, started_at: at, ended_at: null, lines: [] };
    all.push(cur);
  };
  const end = (at: string | null, status: Status) => {
    if (cur.status !== null) return;
    cur.status = status;
    cur.ended_at = at;
  };

  for (const raw of log.split(/\r?\n/)) {
    if (raw === "") continue;
    const m = STAMP.exec(raw);
    const at: string | null = m ? normTime(m[1]) : last;
    if (m) last = at;
    const line = (m ? raw.slice(m[0].length) : raw).replace(ANSI, "");
    if (cur.started_at === null) cur.started_at = at;

    const start = START.exec(line);
    if (start) {
      begin(start[1] === "Main" ? start[2] : `${start[1]} ${start[2]}`, at);
      continue;
    }
    const e = END.exec(line);
    if (e) {
      end(at, e[2] === "Success" ? "success" : "failure");
      continue;
    }
    if (TRAILER.test(line)) begin("Complete job", at);
    else if (cur.status !== null) begin(UNNAMED, at);
    if (drop.some((d) => d !== "" && line.includes(d))) continue;
    cur.lines.push(line.length > LINE_CHARS ? line.slice(0, LINE_CHARS) : line);
    const x = EXIT.exec(line);
    if (x && cur.name !== "Complete job") end(at, x[1] === "3" && held ? "waiting" : "failure");
  }
  // The step open at the end of the log: running while the job runs, else the job's end.
  if (cur.status === null) {
    if (!ENDED.has(jobStatus)) cur.status = "running";
    else {
      cur.status = jobStatus;
      cur.ended_at = last;
    }
  }
  // A log that starts on a step has no set-up lines to show.
  return all.filter((s) => s.lines.length > 0 || s.name !== "Set up job").map((s) => ({
    name: s.name,
    status: s.status ?? "success",
    started_at: s.started_at,
    ended_at: s.ended_at,
    log: s.lines.slice(-STEP_LINES),
    truncated: Math.max(0, s.lines.length - STEP_LINES),
  }));
}

/** The first and last stamp of a log. */
export function logSpan(log: string): { first: string | null; last: string | null } {
  let first: string | null = null;
  let last: string | null = null;
  for (const raw of log.split(/\r?\n/)) {
    const m = STAMP.exec(raw);
    if (!m) continue;
    const t = normTime(m[1]);
    first ??= t;
    last = t;
  }
  return { first, last };
}

/** One job: its status (waiting when a gate held it), times from its log, and its steps. */
export function buildJob(job: ForgeJob, log: string | null, drop: string[] = []): Job {
  const text = log ?? "";
  const status = mapStatus(job.status, job.status === "failure" && gateHeld(text));
  const span = logSpan(text);
  return {
    id: job.id,
    name: job.name,
    needs: job.needs ?? [],
    status,
    started_at: span.first,
    ended_at: ENDED.has(status) ? span.last : null,
    steps: text ? parseSteps(text, status, drop) : [],
  };
}

/**
 * The run's status: Forgejo's, but a failed run whose failed jobs a gate all
 * held is waiting.
 */
export function runStatus(run: ForgeRun, jobs: Job[]): Status {
  if (run.status !== "failure") return mapStatus(run.status);
  const failed = jobs.filter((j) => j.status === "failure" || j.status === "waiting");
  return failed.length > 0 && failed.every((j) => j.status === "waiting") ? "waiting" : "failure";
}

/** The trigger a run has when the driver did not mark it. */
export function defaultTrigger(event: string): Trigger {
  if (event === "pull_request") return "plan";
  if (event === "issue_comment") return "resume";
  return "push";
}

export function buildRun(run: ForgeRun, jobs: Job[], mark: Mark | undefined): { doc: RunDoc; entry: IndexEntry } {
  const pr = /^#(\d+)$/.exec(run.prettyref ?? "");
  const pull = mark?.pull ?? (pr ? Number(pr[1]) : null);
  const ref = mark?.ref ?? (run.prettyref && !pr ? run.prettyref : null);
  const status = runStatus(run, jobs);
  const base = {
    id: run.id,
    title: run.title,
    event: run.event,
    trigger: mark?.trigger ?? defaultTrigger(run.event),
    commit: run.commit_sha,
    pull,
    cycle: mark?.cycle ?? null,
    scenario: mark?.scenario ?? null,
    status,
    created_at: run.created,
    started_at: forgeTime(run.started),
    ended_at: ENDED.has(status) ? forgeTime(run.stopped) : null,
  };
  const summaries: JobSummary[] = jobs.map(({ steps: _s, ...j }) => j);
  return {
    doc: { schema: "demo.run/v1", ...base, jobs },
    entry: { ...base, ref, jobs: summaries } as IndexEntry,
  };
}

/** The index, newest first and at most `keep` runs. */
export function buildIndex(entries: IndexEntry[], now: Date, keep = KEEP): IndexDoc {
  const runs = [...entries].sort((a, b) => b.id - a.id).slice(0, keep);
  return { schema: "demo.runs/v1", updated_at: now.toISOString().replace(/\.\d+Z$/, "Z"), keep, runs };
}

/** The run ids to keep: the newest `keep`. */
export function keptIds(ids: number[], keep = KEEP): number[] {
  return [...new Set(ids)].sort((a, b) => b - a).slice(0, keep);
}

/** The run objects in the bucket to delete: every one not kept. */
export function toPrune(stored: number[], kept: number[]): number[] {
  const k = new Set(kept);
  return [...new Set(stored)].filter((id) => !k.has(id)).sort((a, b) => a - b);
}

/** The `runs/<id>.json` keys in an S3 ListObjectsV2 answer under `prefix`. */
export function runKeys(xml: string, prefix: string): number[] {
  const out: number[] = [];
  const esc = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`<Key>${esc}/runs/(\\d+)\\.json</Key>`, "g");
  for (const m of xml.matchAll(re)) out.push(Number(m[1]));
  return out;
}

/** The driver's marks, later lines over earlier ones; a line that is not JSON is skipped. */
export function readMarks(text: string): Map<number, Mark> {
  const out = new Map<number, Mark>();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const m = JSON.parse(line) as Mark;
      if (typeof m.id === "number") out.set(m.id, { ...out.get(m.id), ...m });
    } catch {
      // a torn line from a driver that stopped mid-write
    }
  }
  return out;
}
