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
