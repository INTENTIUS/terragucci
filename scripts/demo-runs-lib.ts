// The demo's pipeline runs as the reports bucket holds them for behold's kiosk:
// <prefix>/runs/index.json (schema demo.runs/v1) and <prefix>/runs/<id>.json
// (schema demo.run/v1), each run with the repo it is of and the tool it shows. Pure functions over what Forgejo's API returns; the
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
  workflow_id?: string;
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
  /** The forge repo the run is of ("<admin>/demo"), and the tool its scenarios show; null for a run copied before they were kept. */
  repo: string | null;
  tool: string | null;
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
  /** The forge repo the run is of ("<admin>/demo"), and the tool its scenarios show; null for a run copied before they were kept. */
  repo: string | null;
  tool: string | null;
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

/** A step's name when the job's workflow can't be read and the log names none. */
export const UNNAMED = "Run";

/** A step as the workflow declares it. */
export interface WorkflowStep {
  name: string;
  uses: string | null;
}

function unquote(v: string): string {
  const t = v.trim();
  if (t.length >= 2 && ((t[0] === "'" && t.at(-1) === "'") || (t[0] === '"' && t.at(-1) === '"'))) {
    return t[0] === "'" ? t.slice(1, -1).replace(/''/g, "'") : t.slice(1, -1);
  }
  return t;
}

/**
 * Each job's steps in a workflow file as terragucci renders it (two-space
 * indents, `jobs:` at the top, each job's `steps:` a list of mappings). A
 * step's name is its `name:`, else its `uses:`, else the first line of its
 * `run:`. Not a YAML parser: a file of another shape gives no jobs, and the
 * steps then come from the log's markers alone.
 */
export function workflowSteps(yaml: string): Map<string, WorkflowStep[]> {
  const jobs = new Map<string, WorkflowStep[]>();
  const lines = yaml.split(/\r?\n/);
  let inJobs = false;
  let job: string | null = null;
  let inSteps = false;
  let item: { name?: string; uses?: string; run?: string } | null = null;
  let runBlock = false;
  const flush = () => {
    if (item && job) {
      const name = item.name ?? item.uses ?? item.run ?? UNNAMED;
      jobs.get(job)?.push({ name, uses: item.uses ?? null });
    }
    item = null;
  };
  const key = (k: string, v: string) => {
    if (!item) return;
    if (k === "name") item.name = unquote(v);
    else if (k === "uses") item.uses = unquote(v);
    else if (k === "run") {
      if (/^[|>][-+]?\s*$/.test(v.trim())) runBlock = true;
      else item.run = unquote(v);
    }
  };
  for (const line of lines) {
    if (line.trim() === "" || /^\s*#/.test(line)) continue;
    const indent = line.length - line.trimStart().length;
    if (runBlock) {
      if (indent > 8) {
        if (item && (item as { run?: string }).run === undefined) (item as { run?: string }).run = line.trim();
        continue;
      }
      runBlock = false;
    }
    if (indent === 0) {
      flush();
      inJobs = /^jobs:\s*$/.test(line);
      job = null;
      inSteps = false;
      continue;
    }
    if (!inJobs) continue;
    if (indent === 2) {
      flush();
      const m = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
      job = m ? m[1] : null;
      if (job) jobs.set(job, []);
      inSteps = false;
      continue;
    }
    if (indent === 4) {
      flush();
      inSteps = /^ {4}steps:\s*$/.test(line);
      continue;
    }
    if (!inSteps || !job) continue;
    const start = /^ {6}- ([A-Za-z_-]+):\s?(.*)$/.exec(line);
    if (start) {
      flush();
      item = {};
      key(start[1], start[2]);
      continue;
    }
    const k = /^ {8}([A-Za-z_-]+):\s?(.*)$/.exec(line);
    if (k) key(k[1], k[2]);
  }
  flush();
  return jobs;
}

type Kind = "checkout" | "upload" | "download" | "run";
function kindOf(uses: string | null): Kind {
  if (!uses) return "run";
  if (/actions\/checkout@/.test(uses)) return "checkout";
  if (/upload-artifact@/.test(uses)) return "upload";
  if (/download-artifact@/.test(uses)) return "download";
  return "run";
}

// Where an action's own output starts or ends, for steps the log does not mark.
const CHECKOUT_END = /^::remove-matcher owner=checkout-git::$/;
const UPLOAD_START = /^(With the provided path, there will be \d+ files? uploaded|No files were found with the provided path)/;
const UPLOAD_END = /^Artifact .+ has been successfully uploaded!$/;
const DOWNLOAD_END = /^Artifact download has finished successfully$/;

/**
 * A job's log split into steps. Lines before the first `⭐ Run` are "Set up
 * job", and the runner's trailer from `🏁 Job` on is "Complete job".
 *
 * The runner's markers are boundaries where the log has them: `⭐ Run
 * Main|Pre|Post <name>` starts a step, `✅`/`❌` ends one, and the runner's
 * exit line (`exitcode 'N': failure`) ends the step whose command failed. The
 * log Forgejo returns lacks most of them, so the main steps follow `steps`,
 * the job's steps as its workflow declares them, in order: output after a
 * step ended belongs to the next one; checkout's output ends at its
 * `::remove-matcher owner=checkout-git::`, download-artifact's at its
 * "finished" line, and upload-artifact's starts at its "With the provided
 * path" line. With no `steps` (the workflow could not be read), output the
 * markers do not name is a step named "Run".
 *
 * A step whose command exited 3 after the gate's `waits for an approval` is
 * waiting; Complete job is then success, since the job ended as the gate
 * meant. Each line loses its timestamp and its ANSI escapes and is cut to 500
 * characters; `drop` lines (the secret guard) are left out. A step still open
 * at the end of the log takes the job's status, or is running while the job runs.
 */
export function parseSteps(log: string, jobStatus: Status, drop: string[] = [], steps: WorkflowStep[] | null = null): Step[] {
  interface Open {
    name: string;
    kind: Kind;
    index: number; // in steps, or -1
    status: Status | null;
    started_at: string | null;
    ended_at: string | null;
    lines: string[];
  }
  const held = gateHeld(log);
  const plan = steps ?? [];
  let phase: "setup" | "main" | "post" | "trailer" = "setup";
  let cur: Open = { name: "Set up job", kind: "run", index: -1, status: null, started_at: null, ended_at: null, lines: [] };
  const all: Open[] = [cur];
  let last: string | null = null;
  let k = -1; // the last of `steps` opened

  const open = (name: string, kind: Kind, index: number, at: string | null) => {
    if (cur.status === null) {
      cur.status = "success";
      cur.ended_at = at;
    }
    cur = { name, kind, index, status: null, started_at: at, ended_at: null, lines: [] };
    all.push(cur);
    if (index >= 0) k = index;
  };
  const openStep = (j: number, at: string | null) => open(plan[j].name, kindOf(plan[j].uses), j, at);
  // The next main step: the workflow's next one, or "Run".
  const next = (at: string | null) => {
    if (k + 1 < plan.length) openStep(k + 1, at);
    else open(UNNAMED, "run", -1, at);
  };
  const end = (at: string | null, status: Status) => {
    if (cur.status !== null) return;
    cur.status = status;
    cur.ended_at = at;
  };
  const find = (name: string, from: number) => {
    for (let j = Math.max(from, 0); j < plan.length; j++) if (plan[j].name === name || plan[j].uses === name) return j;
    return -1;
  };

  for (const raw of log.split(/\r?\n/)) {
    if (raw === "") continue;
    const m = STAMP.exec(raw);
    const at: string | null = m ? normTime(m[1]) : last;
    if (m) last = at;
    const line = (m ? raw.slice(m[0].length) : raw).replace(ANSI, "");
    if (cur.started_at === null) cur.started_at = at;

    const start = START.exec(line);
    if (start && phase !== "trailer") {
      const [, stage, name] = start;
      if (stage === "Main" && phase !== "post") {
        phase = "main";
        const j = find(name, k);
        if (j >= 0 && j === k && cur.index === k && cur.status === null) continue; // already in it
        if (j >= 0) openStep(j, at);
        else open(name, kindOf(name), -1, at);
      } else {
        if (stage === "Post") phase = "post";
        else if (phase === "setup") phase = "main";
        open(`${stage} ${name}`, kindOf(name), -1, at);
      }
      continue;
    }
    const e = END.exec(line);
    if (e && phase !== "trailer") {
      end(at, e[2] === "Success" ? "success" : "failure");
      continue;
    }
    if (TRAILER.test(line)) {
      phase = "trailer";
      open("Complete job", "run", -1, at);
    } else if (phase === "main") {
      if (cur.status !== null) next(at);
      else if (UPLOAD_START.test(line) && cur.kind !== "upload") {
        const j = plan.findIndex((s, i) => i > k && kindOf(s.uses) === "upload");
        if (j >= 0) openStep(j, at);
        else if (!steps) open(UNNAMED, "upload", -1, at);
      }
    } else if (phase === "post" && cur.status !== null) {
      open(UNNAMED, "run", -1, at);
    } else if (phase === "setup" && cur.status !== null) {
      phase = "main";
      next(at);
    }
    if (drop.some((d) => d !== "" && line.includes(d))) continue;
    cur.lines.push(line.length > LINE_CHARS ? line.slice(0, LINE_CHARS) : line);
    if (phase === "trailer") continue;
    const x = EXIT.exec(line);
    if (x) end(at, x[1] === "3" && held ? "waiting" : "failure");
    else if (cur.kind === "checkout" && CHECKOUT_END.test(line)) end(at, "success");
    else if (cur.kind === "download" && DOWNLOAD_END.test(line)) end(at, "success");
    else if (cur.kind === "upload" && UPLOAD_END.test(line)) end(at, "success");
  }
  // The step open at the end of the log: running while the job runs, else the job's end.
  if (cur.status === null) {
    if (!ENDED.has(jobStatus)) cur.status = "running";
    else {
      cur.status = cur.name === "Complete job" && jobStatus === "waiting" ? "success" : jobStatus;
      cur.ended_at = last;
    }
  }
  // A log that starts on a step has no set-up lines to show.
  return all
    .filter((s) => s.lines.length > 0 || s.name !== "Set up job")
    .map((s) => ({
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
export function buildJob(job: ForgeJob, log: string | null, drop: string[] = [], steps: WorkflowStep[] | null = null): Job {
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
    steps: text ? parseSteps(text, status, drop, steps) : [],
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

/** A repo the copy reads, and the tool its scenarios show. */
export interface DemoRepo {
  repo: string;
  tool: string;
}

/**
 * The repos to copy: DEMO_RUNS_REPOS, one "<repo> <tool>" a line, or else the
 * one DEMO_RUNS_REPO, whose tool is DEMO_RUNS_TOOL (terraform when unset).
 * A repo named twice is read once, with its first tool.
 */
export function parseRepos(lines: string | undefined, repo?: string, tool?: string): DemoRepo[] {
  const out: DemoRepo[] = [];
  const add = (r: string, t: string) => {
    if (r && !out.some((x) => x.repo === r)) out.push({ repo: r, tool: t || "terraform" });
  };
  for (const line of (lines ?? "").split("\n")) {
    const [r, t] = line.trim().split(/\s+/);
    if (r) add(r, t ?? "");
  }
  if (out.length === 0 && repo) add(repo, tool ?? "");
  return out;
}

/**
 * Whether a run is settled: it has ended and so has every job of it. Forgejo
 * marks a run failed as soon as one wave fails, while later waves still start
 * and run (terragucci#1161), so a failed run can hold a job that is running.
 */
export function settled(status: Status, jobs: Pick<Job, "status">[]): boolean {
  return ENDED.has(status) && jobs.every((j) => ENDED.has(j.status));
}

/**
 * When a run ended: Forgejo's stop time, or its last job's end when a job
 * ended after it; none while a job of it runs.
 */
export function runEnded(status: Status, stopped: string | null, jobs: Pick<Job, "status" | "ended_at">[]): string | null {
  if (!settled(status, jobs)) return null;
  const times = [stopped, ...jobs.map((j) => j.ended_at)].filter((t): t is string => !!t && !Number.isNaN(Date.parse(t)));
  // Forgejo's stop time is to the second and a log's to the millisecond: a job end in the same second is the stop.
  const sec = (t: string) => Math.floor(Date.parse(t) / 1000);
  return times.reduce<string | null>((a, t) => (a === null || sec(t) > sec(a) ? t : a), null);
}

export function buildRun(run: ForgeRun, jobs: Job[], mark: Mark | undefined, where?: DemoRepo): { doc: RunDoc; entry: IndexEntry } {
  const pr = /^#(\d+)$/.exec(run.prettyref ?? "");
  const pull = mark?.pull ?? (pr ? Number(pr[1]) : null);
  const ref = mark?.ref ?? (run.prettyref && !pr ? run.prettyref : null);
  const status = runStatus(run, jobs);
  const base = {
    id: run.id,
    title: run.title,
    event: run.event,
    trigger: mark?.trigger ?? defaultTrigger(run.event),
    repo: where?.repo ?? null,
    tool: where?.tool ?? null,
    commit: run.commit_sha,
    pull,
    cycle: mark?.cycle ?? null,
    scenario: mark?.scenario ?? null,
    status,
    created_at: run.created,
    started_at: forgeTime(run.started),
    ended_at: runEnded(status, forgeTime(run.stopped), jobs),
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

/** The fewest runs Forgejo keeps when the driver prunes it: the newest 50 are the ones the copy lists. */
export const FORGE_KEEP_MIN = 50;
/** At most this many runs are deleted in one export, so a long backlog never holds up a reset. */
export const FORGE_DELETE_MAX = 50;
/** Forgejo's statuses of a run that has ended. A run waiting, blocked, running or unknown has not. */
export const FORGE_ENDED: ReadonlySet<string> = new Set(["success", "failure", "cancelled", "skipped"]);

/**
 * The Forgejo runs to delete, oldest first: those past the newest `keep`
 * (never fewer than FORGE_KEEP_MIN) that have ended, at most FORGE_DELETE_MAX.
 * A run still in progress is never one, however old.
 */
export function forgeRunsToDelete(runs: Pick<ForgeRun, "id" | "status">[], keep: number): number[] {
  const byId = new Map(runs.map((r) => [r.id, r.status]));
  const older = [...byId.keys()].sort((a, b) => b - a).slice(Math.max(keep, FORGE_KEEP_MIN));
  return older
    .filter((id) => FORGE_ENDED.has(byId.get(id) ?? ""))
    .sort((a, b) => a - b)
    .slice(0, FORGE_DELETE_MAX);
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
