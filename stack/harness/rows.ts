/**
 * smoke.sh's verdicts as the harness's claim protocol (chant#4587,
 * terragucci#1295): each claim's plain run and BREAK run become the two arms
 * of one claim run, and the pair one e2e-claim-row/v1 row. The row itself is
 * made and recorded by chant (claimRow, recordClaimRow) in ./harness.ts; this
 * file is the mapping alone, so it compiles and tests on a chant without the
 * harness.
 *
 * A smoke line is `SMOKE claim=<name> verdict=pass|caught|fail|pending
 * [detail]`. The plain run passes on `pass`. The BREAK run is caught on
 * `caught`, missed on `fail ... break=not-caught` (the claim held with its
 * property broken), and stalled on anything else: a stall, no verdict, or a
 * BREAK that was never made (`break=setup-failed`), none of which proves
 * either way.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export type PlainVerdict = "pass" | "fail";
export type BreakVerdict = "caught" | "missed" | "stalled";

/** The harness's ArmRun, the fields a claim run record reads. */
export interface ArmRunLike {
  scenario: string;
  arm: "plain" | "break";
  outcome: "held" | "broke" | "stalled";
  reason?: string;
  started: string;
  ended: string;
  steps: Array<{ id: string; do: "out-of-band"; stopped?: { outcome: "broke" | "stalled"; reason: string } }>;
}

export interface ClaimRunLike {
  plain: ArmRunLike;
  break: ArmRunLike;
  verdicts: { plain: PlainVerdict; break: BreakVerdict };
}

export interface SmokeLine {
  claim: string;
  verdict: string;
  detail: string;
}

/** One SMOKE line, or null when the text holds none. */
export function parseSmokeLine(text: string): SmokeLine | null {
  const lines = text.split("\n").filter((l) => l.startsWith("SMOKE claim="));
  const last = lines.at(-1);
  if (!last) return null;
  const m = /^SMOKE claim=(\S+) verdict=([a-z]+)\s*(.*)$/.exec(last);
  return m ? { claim: m[1]!, verdict: m[2]!, detail: m[3]! } : null;
}

export const plainVerdict = (l: SmokeLine | null): PlainVerdict => (l?.verdict === "pass" ? "pass" : "fail");

export function breakVerdict(l: SmokeLine | null): BreakVerdict {
  if (l?.verdict === "caught") return "caught";
  if (l?.verdict === "fail" && /\bbreak=not-caught\b/.test(l.detail)) return "missed";
  return "stalled";
}

/**
 * The scenario id a smoke row is recorded under: `smoke` for OpenTofu on
 * Forgejo, `smoke-<binary>` for another binary and `smoke-gitlab` on the
 * GitLab lab, so a claim's rows on each column stay apart in e2e-claims/v1.
 */
export function smokeScenario(o: { binary?: string; forge?: string }): string {
  const parts = ["smoke"];
  if (o.forge && o.forge !== "forgejo") parts.push(o.forge);
  if (o.binary && o.binary !== "tofu") parts.push(o.binary);
  return parts.join("-");
}

/** The engines a smoke claim can run on, the binaries SMOKE_BINARY takes. */
export const ENGINES = ["tofu", "terraform", "choudoufu"] as const;
export type Engine = (typeof ENGINES)[number];

/** A version as a release names it: `v0.31.0` and `0.31.0` are both 0.31.0. */
export const bareVersion = (v: string): string => v.trim().replace(/^v(?=\d)/, "");

/**
 * smoke.sh's claim table (CLAIMS, `<name>|<says>|<needs>` a line) as claim
 * name to what its row says.
 */
export function parseClaimsTable(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split("\n")) {
    const bar = line.indexOf("|");
    if (bar <= 0) continue;
    const says = line.slice(bar + 1);
    const end = says.lastIndexOf("|");
    out.set(line.slice(0, bar), end >= 0 ? says.slice(0, end) : says);
  }
  return out;
}

/** The binary a claim's text names (`with binary: choudoufu ...`), when it names one. */
export function saysBinary(says: string | undefined): Engine | undefined {
  const m = /\bwith binary: ([a-z]+)/.exec(says ?? "");
  return m && (ENGINES as readonly string[]).includes(m[1]!) ? (m[1] as Engine) : undefined;
}

/**
 * The engine a smoke row ran on. A run under SMOKE_BINARY=terraform or
 * choudoufu runs every claim on that binary. The default run is OpenTofu's,
 * but a claim whose text says `with binary: <b>` runs its jobs in b's CI
 * image, so its row carries b at the version that image is built with
 * (`pins`, packages/terragucci/src/images.ts's TOOL_VERSIONS). Every other
 * claim carries the run's binary at the version its image reported.
 */
export function rowEngine(o: { says?: string; binary: string; version: string; pins: Readonly<Record<string, string>> }): { binary: string; version: string } {
  const named = o.binary === "tofu" ? saysBinary(o.says) : undefined;
  if (!named || named === o.binary) return { binary: o.binary, version: bareVersion(o.version) };
  const pinned = o.pins[named];
  if (!pinned) throw new Error(`no pinned version for ${named}, which a claim says it runs on`);
  return { binary: named, version: bareVersion(pinned) };
}

/** When a log was written: its birth and its last change, as the file system has them. */
export function timesOf(file: string): { started: string; ended: string } {
  const iso = (ms: number) => new Date(ms).toISOString();
  if (!existsSync(file)) {
    const now = iso(Date.now());
    return { started: now, ended: now };
  }
  const s = statSync(file);
  return { started: iso(s.birthtimeMs || s.ctimeMs), ended: iso(s.mtimeMs) };
}

export interface SmokeRow {
  claim: string;
  run: ClaimRunLike;
  engine: { binary: string; version: string };
}

/**
 * smoke.sh --record's log directory as rows: one per claim whose plain run
 * has a verdict and whose BREAK run has a verdict file, in name order, each
 * with the engine its claim ran on (rowEngine). `claims` is the claim table
 * the run read; a claim missing from it carries the run's binary.
 */
export function smokeRows(
  logs: string,
  o: { scenario: string; binary: string; version: string; claims?: Map<string, string>; pins: Readonly<Record<string, string>> },
): SmokeRow[] {
  const rows: SmokeRow[] = [];
  for (const f of readdirSync(logs).filter((n) => n.endsWith(".plain.verdict")).sort()) {
    const base = f.slice(0, -".plain.verdict".length);
    const plain = parseSmokeLine(readFileSync(join(logs, f), "utf8"));
    if (!plain || plain.verdict === "pending") continue;
    const brkFile = join(logs, `${base}.break.verdict`);
    if (!existsSync(brkFile)) continue;
    const brk = parseSmokeLine(readFileSync(brkFile, "utf8"));
    const run = smokeClaimRun({
      scenario: o.scenario,
      claim: plain.claim,
      plain,
      break: brk,
      times: { plain: timesOf(join(logs, `${base}.plain.log`)), break: timesOf(join(logs, `${base}.break.log`)) },
    });
    rows.push({ claim: plain.claim, run, engine: rowEngine({ says: o.claims?.get(plain.claim), binary: o.binary, version: o.version, pins: o.pins }) });
  }
  return rows;
}

/** The two arms of one smoke claim as a claim run, from its two SMOKE lines and when each log was written. */
export function smokeClaimRun(o: {
  scenario: string;
  claim: string;
  plain: SmokeLine | null;
  break: SmokeLine | null;
  times: { plain: { started: string; ended: string }; break: { started: string; ended: string } };
}): ClaimRunLike {
  const pv = plainVerdict(o.plain);
  const bv = breakVerdict(o.break);
  const step = (arm: "plain" | "break", outcome: ArmRunLike["outcome"], reason: string) => ({
    id: arm === "plain" ? "claim" : "claim-break",
    do: "out-of-band" as const,
    ...(outcome === "held" ? {} : { stopped: { outcome, reason } }),
  });
  const plainOutcome: ArmRunLike["outcome"] = pv === "pass" ? "held" : /stalled/.test(o.plain?.detail ?? "") ? "stalled" : "broke";
  const breakOutcome: ArmRunLike["outcome"] = bv === "caught" ? "broke" : bv === "missed" ? "held" : "stalled";
  const reasonOf = (l: SmokeLine | null) => (l ? `verdict=${l.verdict}${l.detail ? ` ${l.detail}` : ""}` : "no SMOKE line");
  return {
    plain: {
      scenario: o.scenario,
      arm: "plain",
      outcome: plainOutcome,
      ...(plainOutcome === "held" ? {} : { reason: reasonOf(o.plain) }),
      ...o.times.plain,
      steps: [step("plain", plainOutcome, reasonOf(o.plain))],
    },
    break: {
      scenario: o.scenario,
      arm: "break",
      outcome: breakOutcome,
      ...(breakOutcome === "held" ? {} : { reason: reasonOf(o.break) }),
      ...o.times.break,
      steps: [step("break", breakOutcome, reasonOf(o.break))],
    },
    verdicts: { plain: pv, break: bv },
  };
}
