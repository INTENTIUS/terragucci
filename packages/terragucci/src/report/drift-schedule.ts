/**
 * Drift checks that stopped. A schedule can stop with no error anywhere:
 * GitHub turns a scheduled workflow off after 60 days with no activity in the
 * repo and drops scheduled runs under load, and a GitLab schedule exists only
 * once someone creates it. The drift job cannot report its own absence, so
 * the plan job, which runs on every pull request, does: with `drift:` set it
 * asks the forge when the drift job last ran from its schedule (or by hand),
 * and when the cron has come round at least twice since, or since the
 * pipeline file was added for a schedule that never ran, the job log and the
 * plan note say the drift checks are overdue and what to do about it.
 */
import { spawnSync } from "node:child_process";
import type { ForgeName } from "../config";
import { call, type Fetch, type ForgeTarget } from "../forge";
import { PIPELINE_PATHS } from "../render";

// ── cron ─────────────────────────────────────────────────────────────────────

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/** One cron field as the set of values it matches; undefined when it is not a field this reads. */
function field(text: string, min: number, max: number, names: string[] = [], nameBase = 0): Set<number> | undefined {
  const out = new Set<number>();
  const value = (s: string): number | undefined => {
    const named = names.indexOf(s.toLowerCase());
    if (named >= 0) return named + nameBase;
    return /^\d+$/.test(s) ? Number(s) : undefined;
  };
  for (const part of text.split(",")) {
    const m = /^(\*|[A-Za-z0-9]+(?:-[A-Za-z0-9]+)?)(?:\/(\d+))?$/.exec(part);
    if (!m) return undefined;
    const step = m[2] ? Number(m[2]) : 1;
    let lo = min;
    let hi = max;
    if (m[1] !== "*") {
      const [a, b] = m[1].split("-");
      const from = value(a);
      const to = b === undefined ? (m[2] ? max : from) : value(b);
      if (from === undefined || to === undefined) return undefined;
      lo = from;
      hi = to;
    }
    if (step < 1 || lo < min || hi > max || lo > hi) return undefined;
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

export interface Cron {
  minute: Set<number>;
  hour: Set<number>;
  day: Set<number>;
  month: Set<number>;
  weekday: Set<number>;
  /** Day of month and day of week are both restricted, so either one matching is enough, as cron reads them. */
  either: boolean;
}

/** A five-field cron schedule, in UTC as GitHub and Forgejo read it. Undefined when it is not one. */
export function parseCron(text: string): Cron | undefined {
  const parts = text.trim().split(/\s+/);
  if (parts.length !== 5) return undefined;
  const minute = field(parts[0], 0, 59);
  const hour = field(parts[1], 0, 23);
  const day = field(parts[2], 1, 31);
  const month = field(parts[3], 1, 12, MONTHS, 1);
  const weekday = field(parts[4], 0, 7, DAYS);
  if (!minute || !hour || !day || !month || !weekday) return undefined;
  if (weekday.delete(7)) weekday.add(0);
  return { minute, hour, day, month, weekday, either: parts[2] !== "*" && parts[4] !== "*" };
}

function dayMatches(c: Cron, d: Date): boolean {
  const day = c.day.has(d.getUTCDate());
  const weekday = c.weekday.has(d.getUTCDay());
  return c.either ? day || weekday : day && weekday;
}

/** The times the schedule fires after `from` and up to `to`, at most `max` of them. */
export function cronFires(c: Cron, from: Date, to: Date, max: number): Date[] {
  const out: Date[] = [];
  const t = new Date(Math.floor(from.getTime() / 60_000) * 60_000 + 60_000);
  while (t <= to && out.length < max) {
    if (!c.month.has(t.getUTCMonth() + 1)) {
      t.setUTCMonth(t.getUTCMonth() + 1, 1);
      t.setUTCHours(0, 0, 0, 0);
    } else if (!dayMatches(c, t)) {
      t.setUTCDate(t.getUTCDate() + 1);
      t.setUTCHours(0, 0, 0, 0);
    } else if (!c.hour.has(t.getUTCHours())) {
      t.setUTCHours(t.getUTCHours() + 1, 0, 0, 0);
    } else {
      if (c.minute.has(t.getUTCMinutes())) out.push(new Date(t));
      t.setTime(t.getTime() + 60_000);
    }
  }
  return out;
}

// ── the forge ────────────────────────────────────────────────────────────────

/** What the forge says about the drift job's runs. */
export interface DriftRuns {
  /** When the drift job last ran from its schedule or by hand (ISO 8601), if it ever did. */
  last?: string;
  /** GitHub: the workflow is off, and why (`disabled_inactivity`, `disabled_manually`). */
  disabled?: string;
  /** GitLab: the project has no active pipeline schedule. */
  noSchedule?: boolean;
}

type Json = Record<string, unknown>;

const newest = (dates: (string | undefined)[]): string | undefined =>
  dates.filter((d): d is string => typeof d === "string" && !Number.isNaN(Date.parse(d))).sort((a, b) => Date.parse(b) - Date.parse(a))[0];

/** Ask the forge when the drift job last ran. Throws a ForgeError when the forge will not say. */
export async function driftRuns(fetch: Fetch, t: ForgeTarget): Promise<DriftRuns> {
  if (t.forge === "gitlab") {
    const id = encodeURIComponent(t.path);
    const pipelines = (await call(fetch, t, "GET", `/projects/${id}/pipelines?source=schedule&per_page=1&order_by=id&sort=desc`)) as Json[];
    const schedules = (await call(fetch, t, "GET", `/projects/${id}/pipeline_schedules?scope=active&per_page=1`)) as Json[];
    const last = newest(pipelines.map((p) => p.created_at as string | undefined));
    return { ...(last ? { last } : {}), ...(schedules.length === 0 ? { noSchedule: true } : {}) };
  }
  const file = PIPELINE_PATHS[t.forge].split("/").pop()!;
  if (t.forge === "github") {
    const workflow = (await call(fetch, t, "GET", `/repos/${t.path}/actions/workflows/${file}`)) as Json;
    const runs = await Promise.all(["schedule", "workflow_dispatch"].map(async (event) => (await call(fetch, t, "GET", `/repos/${t.path}/actions/workflows/${file}/runs?event=${event}&per_page=1`)) as { workflow_runs?: Json[] }));
    const last = newest(runs.flatMap((r) => (r.workflow_runs ?? []).map((w) => w.created_at as string | undefined)));
    const state = typeof workflow.state === "string" ? workflow.state : "active";
    return { ...(last ? { last } : {}), ...(state.startsWith("disabled") ? { disabled: state } : {}) };
  }
  // Forgejo lists a repo's runs newest first; the event and workflow are read from each run, whatever the query honours.
  const listed = (await call(fetch, t, "GET", `/repos/${t.path}/actions/runs?event=schedule&limit=50`)) as Json[] | { workflow_runs?: Json[] };
  const runs = Array.isArray(listed) ? listed : (listed.workflow_runs ?? []);
  const ours = runs.filter((r) => {
    const event = (r.event ?? r.trigger_event) as string | undefined;
    const workflow = (r.workflow_id ?? r.path) as string | undefined;
    return (event === "schedule" || event === "workflow_dispatch") && (workflow === undefined || String(workflow).endsWith(file));
  });
  const last = newest(ours.map((r) => (r.created ?? r.created_at ?? r.started) as string | undefined));
  return last ? { last } : {};
}

/** When the pipeline file first appeared in the checkout's history (ISO 8601), if the history has it. */
export function pipelineAdded(repo: string, forge: ForgeName): string | undefined {
  const r = spawnSync("git", ["-C", repo, "log", "--format=%cI", "--diff-filter=A", "--", PIPELINE_PATHS[forge]], { encoding: "utf-8" });
  if (r.status !== 0) return undefined;
  return r.stdout.trim().split("\n").filter(Boolean).pop();
}

// ── the verdict ──────────────────────────────────────────────────────────────

export interface Overdue {
  /** The line for the job log and the plan note. */
  message: string;
  /** The time the count starts from: the last drift run, or the pipeline file's commit. */
  since: string;
}

const HINT: Record<ForgeName, string> = {
  github: "GitHub turns a scheduled workflow off after 60 days with no activity in the repo; turn the terragucci workflow on again under Actions, or run its drift job by hand",
  gitlab: "a GitLab project runs the drift job only from a pipeline schedule; add one under CI/CD > Schedules",
  forgejo: "check that Actions is on for the repo and a runner is up, or run the drift job by hand",
};

/**
 * Whether the drift checks are overdue: the cron has fired at least twice
 * since the last drift run (one late or dropped run is not enough), or since
 * the pipeline file was added when no drift run is on record. Undefined when
 * they are on time, or when nothing says when they should have run.
 */
export function overdue(cronText: string, forge: ForgeName, runs: DriftRuns, added: string | undefined, now: Date): Overdue | undefined {
  const cron = parseCron(cronText);
  const since = runs.last ?? added;
  if (!cron || !since) return undefined;
  const missed = cronFires(cron, new Date(since), now, 2);
  if (missed.length < 2) return undefined;
  const day = since.slice(0, 10);
  const what = runs.last ? `the last drift run was on ${day}` : `no drift run is on record since the pipeline was added on ${day}`;
  const why = runs.disabled
    ? `GitHub has turned the workflow off (${runs.disabled}); turn the terragucci workflow on again under Actions`
    : forge === "gitlab" && runs.noSchedule
      ? `the project has no active pipeline schedule; add one with the cron \`${cronText}\` under CI/CD > Schedules`
      : HINT[forge];
  return { since, message: `Drift checks are overdue: the schedule \`${cronText}\` has come round at least twice and ${what}. ${why[0].toUpperCase()}${why.slice(1)}.` };
}

/**
 * The plan job's check: ask the forge, fall back on the pipeline file's
 * history, and say whether the drift checks are overdue. A forge that will not
 * answer (no token with read access to the runs, an older forge) is a line
 * in the log and no verdict.
 */
export async function checkDriftSchedule(
  repo: string,
  cronText: string,
  target: ForgeTarget,
  fetch: Fetch,
  now: Date,
  log: (line: string) => void,
): Promise<Overdue | undefined> {
  let runs: DriftRuns;
  try {
    runs = await driftRuns(fetch, target);
  } catch (e) {
    log(`drift schedule: the forge did not say when the drift job last ran, so it is not checked: ${(e as Error).message.split("\n")[0]}`);
    return undefined;
  }
  const found = overdue(cronText, target.forge, runs, runs.last ? undefined : pipelineAdded(repo, target.forge), now);
  if (found) log(found.message);
  return found;
}
