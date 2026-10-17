/**
 * An estate migration's writes as they land (./migrate-estate.ts): choudoufu's
 * `live-mv` and `live-import -approve` take `-progress-json`, and then write
 * one JSON line to stderr per resource as its marker write returns:
 *
 *   {"at": "...", "estate_from": "mono", "estate_to": "team",
 *    "address": "aws_sqs_queue.jobs", "live_id": "q-jobs",
 *    "outcome": "moved" | "stamped" | "refused" | "skipped",
 *    "reason": "...", "follows": "..."}
 *
 * `reason` and `follows` are left out when empty. The flag is passed only
 * when the binary's `live-mv -help` names it, so an older choudoufu runs the
 * migration as it did, with no lines.
 *
 * Each line goes, with the migration's name and its counts so far, to
 * `terragucci-report/migrations/<name>/progress.jsonl` as it arrives, and as
 * an event on the migration's span. The counts go into the migration's
 * record (`progress`). With a reports bucket, both files are copied to
 * `<prefix>/<project>/migrations/` every `TG_PROGRESS_SECONDS` seconds (5 by
 * default) while lines arrive, as a wave's apply progress is, and once more
 * when the writes end.
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { progressInterval } from "./apply-progress";
import type { BinaryExec } from "./migrate";

export const PROGRESS_FLAG = "-progress-json";

export const PROGRESS_OUTCOMES = ["moved", "stamped", "refused", "skipped"] as const;
export type ProgressOutcome = (typeof PROGRESS_OUTCOMES)[number];

/** One `-progress-json` line, as choudoufu writes it. */
export interface ProgressLine {
  at: string;
  estate_from: string;
  estate_to: string;
  address: string;
  live_id: string;
  outcome: ProgressOutcome;
  reason?: string;
  /** A follower's line: the address of the resource it follows. */
  follows?: string;
}

/** How many resources of a migration each outcome holds, and how many have no line yet. */
export interface MigrationCounts {
  moved: number;
  stamped: number;
  refused: number;
  skipped: number;
  left: number;
}

/** What `progress.jsonl` holds: each line as choudoufu wrote it, with the migration and its counts once that line arrived. */
export type ProgressRecord = ProgressLine & { migration: string; counts: MigrationCounts };

/** The progress file's path, from the report directory (`terragucci-report/`) or the bucket's `<prefix>/<project>/`. */
export const progressPath = (name: string): string => `migrations/${name}/progress.jsonl`;

/** A `-progress-json` line, or undefined when the text is not one. */
export function parseProgressLine(text: string): ProgressLine | undefined {
  const t = text.trim();
  if (!t.startsWith("{")) return undefined;
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(t) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (!v || typeof v !== "object" || typeof v.address !== "string" || !PROGRESS_OUTCOMES.includes(v.outcome as ProgressOutcome)) return undefined;
  const str = (k: string): string => (typeof v[k] === "string" ? (v[k] as string) : "");
  return {
    at: str("at"),
    estate_from: str("estate_from"),
    estate_to: str("estate_to"),
    address: v.address,
    live_id: str("live_id"),
    outcome: v.outcome as ProgressOutcome,
    ...(str("reason") ? { reason: str("reason") } : {}),
    ...(str("follows") ? { follows: str("follows") } : {}),
  };
}

/** The counts after `lines`, of `total` resources the migration writes. */
export function countsOf(lines: readonly Pick<ProgressLine, "outcome">[], total: number): MigrationCounts {
  const c: MigrationCounts = { moved: 0, stamped: 0, refused: 0, skipped: 0, left: 0 };
  for (const l of lines) c[l.outcome]++;
  c.left = Math.max(0, total - lines.length);
  return c;
}

/** "carve: 36 of 79 moved": the migration's counts, in one line. */
export function countsLine(name: string, c: MigrationCounts, change: "retag" | "adopt"): string {
  const total = c.moved + c.stamped + c.refused + c.skipped + c.left;
  const done = change === "retag" ? `${c.moved} of ${total} moved` : `${c.stamped} of ${total} stamped`;
  const rest = [c.refused ? `${c.refused} refused` : "", c.skipped ? `${c.skipped} skipped` : ""].filter(Boolean);
  return `${name}: ${done}${rest.length ? `, ${rest.join(", ")}` : ""}`;
}

/**
 * Whether the binary takes `-progress-json`: its `live-mv -help` names the
 * flag. Asked once per binary; a binary that cannot answer does not.
 */
const supported = new WeakMap<BinaryExec, Map<string, Promise<boolean>>>();
export function takesProgressJson(exec: BinaryExec, binary: string, dir: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  let byBinary = supported.get(exec);
  if (!byBinary) supported.set(exec, (byBinary = new Map()));
  let got = byBinary.get(binary);
  if (!got) {
    got = exec(binary, ["live-mv", "-help"], dir, env).then(
      (r) => new RegExp(`(^|\\s)${PROGRESS_FLAG}(\\s|=|$)`, "m").test(r.out),
      () => false,
    );
    byBinary.set(binary, got);
  }
  return got;
}

/** Where a migration's progress goes beyond the report directory. Each is optional, and none throws into the migration. */
export interface ProgressSinks {
  /** Copy a file of the report directory, by its path under it (`migrations/<name>/progress.jsonl`, `migrations/<name>.json`), to the reports bucket. */
  publish?: (path: string, body: string, contentType: string) => Promise<void>;
  /** Add an event to the migration's span. */
  event?: (name: string, attributes: Record<string, string | number | boolean | undefined>, at?: string) => void;
  /** The migration's writes ended, with the counts when the binary wrote lines: end its span. */
  end?: (status: string, counts?: MigrationCounts, error?: string) => void;
}

export interface MigrationProgressOptions extends ProgressSinks {
  /** The repo: the report directory is `<repo>/terragucci-report`. */
  repo: string;
  name: string;
  change: "retag" | "adopt";
  /** How many resources the migration writes: each retag and its followers, or each instance of the adopted states. */
  total: number;
  /** The record as it is now, rewritten with the counts at each copy. */
  record: () => unknown;
  env?: NodeJS.ProcessEnv;
  intervalMs?: number;
  log?: (line: string) => void;
}

/**
 * One migration's progress while it writes: `line` takes each line from the
 * binary, `stop` writes and copies a last time.
 */
export class MigrationProgress {
  readonly lines: ProgressLine[] = [];
  /** Each line of the progress file, as written. */
  private readonly rows: string[] = [];
  counts: MigrationCounts;
  private readonly file: string;
  private readonly recordFile: string;
  private readonly intervalMs: number;
  private timer?: ReturnType<typeof setTimeout>;
  private copied = -1;
  private copying: Promise<void> = Promise.resolve();
  private stopped = false;
  private warned = false;

  constructor(private readonly o: MigrationProgressOptions) {
    this.counts = countsOf([], o.total);
    this.file = join(o.repo, "terragucci-report", progressPath(o.name));
    this.recordFile = join(o.repo, "terragucci-report", "migrations", `${o.name}.json`);
    this.intervalMs = o.intervalMs ?? progressInterval(o.env ?? process.env);
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, "");
  }

  /** The text a stderr line is, taken when it is a progress line; false for any other line. */
  take = (text: string): boolean => {
    const line = parseProgressLine(text);
    if (!line) return false;
    this.line(line);
    return true;
  };

  line(line: ProgressLine): void {
    this.lines.push(line);
    this.counts = countsOf(this.lines, Math.max(this.o.total, this.lines.length));
    const row: ProgressRecord = { ...line, migration: this.o.name, counts: { ...this.counts } };
    const text = JSON.stringify(row);
    this.rows.push(text);
    try {
      appendFileSync(this.file, text + "\n");
    } catch (e) {
      this.warn(`the progress line of ${line.address} was not written: ${(e as Error).message}`);
    }
    try {
      this.o.event?.(`migration ${line.outcome}`, {
        "terragucci.migration": this.o.name,
        "terragucci.migration.address": line.address,
        "terragucci.migration.live_id": line.live_id || undefined,
        "terragucci.migration.outcome": line.outcome,
        "terragucci.migration.estate_from": line.estate_from || undefined,
        "terragucci.migration.estate_to": line.estate_to || undefined,
        "terragucci.migration.reason": line.reason,
        "terragucci.migration.follows": line.follows,
        "terragucci.migration.left": this.counts.left,
      }, line.at || undefined);
    } catch {
      // A span event is never worth a write.
    }
    this.schedule();
  }

  /** The record's counts, as the record carries them. */
  get progress(): MigrationCounts {
    return { ...this.counts };
  }

  private schedule(): void {
    if (this.stopped || this.timer || !this.o.publish) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.copying = this.copying.then(() => this.copy());
    }, this.intervalMs);
    this.timer.unref?.();
  }

  /** Write the record with the counts, and copy both files when a line arrived since the last copy. */
  private async copy(): Promise<void> {
    const n = this.rows.length;
    let record: string | undefined;
    try {
      record = JSON.stringify(this.o.record(), null, 2) + "\n";
      writeFileSync(this.recordFile, record);
    } catch (e) {
      this.warn(`the record's counts were not written: ${(e as Error).message}`);
    }
    if (!this.o.publish || n === this.copied) return;
    this.copied = n;
    try {
      const body = this.rows.slice(0, n).join("\n");
      await this.o.publish(progressPath(this.o.name), body ? `${body}\n` : "", "application/x-ndjson");
      if (record) await this.o.publish(`migrations/${this.o.name}.json`, record, "application/json");
    } catch (e) {
      this.warn(`the progress was not copied to the reports bucket: ${(e as Error).message}`);
    }
  }

  private warn(line: string): void {
    if (this.warned) return;
    this.warned = true;
    this.o.log?.(`migration ${this.o.name}: ${line}`);
  }

  /** The writes ended: write and copy what arrived since the last copy. */
  async stop(): Promise<MigrationCounts> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.copying;
    await this.copy();
    return this.progress;
  }
}
