/**
 * A wave gate that asks a workspace decision point (`apply.point` at base),
 * through chant's `@intentius/chant/point-decision`.
 *
 * The wave asks the point with the gate's facts: `gate.component` is
 * `tf-apply`, `gate.name` is `wave-<k>` and `gate.planDigest` is the wave's
 * set digest. chant refuses a point that does not declare `gate.planDigest`,
 * so each plan is its own question and an answer for one plan never passes
 * another. The question is held on `chant/lifecycle`, so it outlives the job
 * that asked it, and the chat relay (./relay.ts) or a person at a shell
 * answers it there. The point's deciders and quorum decide; an answer given
 * over MCP or ACP counts nobody toward a quorum, and chant refuses one for a
 * gate whose pending fact says `neverOverMcp`, as every wave's does.
 *
 * Then, by chant's rule (evaluatePointGate):
 *
 *   open      the wave records a pending fact that cites the question, keeps
 *             the report of its plans beside it, and waits (exit 3);
 *   yes       the wave records a resolution that cites the answer record, once
 *             per answer and plan, and applies as under any approval;
 *   any other the wave applies nothing and names the record (exit 4).
 *
 * `terragucci approve` and `chant approve` do not pass such a gate: chant
 * refuses a gate whose pending fact names a question, and prints the
 * `points answer` line instead.
 */
import { spawnSync } from "node:child_process";
import { plannerForBinary } from "@intentius/chant-lexicon-terraform/change-set";
import {
  chantGatePointAsker,
  chantPointQuestions,
  evaluatePointGate,
  type GatePointAsker,
  type GateResolutionRecord,
  type PendingGateRecord,
  type PointGateLedgerPort,
  type PointQuestionState,
} from "@intentius/chant/point-decision";
import type { WaveMember } from "@intentius/chant/gated-waves";
import { APPLY_OP, appendPending, appendResolution, approvedPath, EXIT, readLedger, type GateDecision, type GateLedger, type PendingRecord, type ResolutionRecord, type WaveRun } from "./apply";
import { chantCommand } from "./chant-bin";
import { ConfigError, type Approval } from "./config";
import { buildReport } from "./report/build";
import { runFacts } from "./report/stage";
import type { WaveFacts } from "./report/wave-telemetry";

/** The line a person runs to answer the question a wave waits on. */
export const answerLine = (id: string): string => `chant workspace points answer ${id} --answer true --by <name>`;

/** What the wave pushes beside a pending fact: terragucci's additions and the report of its plans. */
export interface PendingExtras {
  members: WaveMember[];
  commit?: string;
  runId?: string;
  files?: Record<string, string>;
}

/** The gate ledger as chant's point decision reads and appends it: the waves' file on `chant/lifecycle`. */
export function wavePointPort(repo: string, extras: PendingExtras): PointGateLedgerPort {
  return {
    async read() {
      const l = readLedger(repo);
      return { pending: l.pending as unknown as PendingGateRecord[], resolutions: l.resolutions as unknown as GateResolutionRecord[] };
    },
    async appendPending(input) {
      const record: PendingRecord = {
        version: 1,
        kind: "pending",
        ...(input as Omit<PendingRecord, "version" | "kind">),
        ...(extras.runId && !input.runId ? { runId: extras.runId } : {}),
        ...(extras.commit ? { commit: extras.commit } : {}),
        members: extras.members,
        neverOverMcp: true,
      };
      appendPending(repo, record, extras.files ?? {});
      return { record: record as unknown as PendingGateRecord, pushed: true };
    },
    async appendResolution(input) {
      const record: ResolutionRecord = { version: 1, kind: "resolution", ...(input as Omit<ResolutionRecord, "version" | "kind">) };
      appendResolution(repo, record);
      return { record: record as unknown as GateResolutionRecord, pushed: true };
    },
  };
}

export interface PointGateInput {
  point: string;
  mode: Approval;
  label: string;
  wave: number;
  digest: string;
  members: WaveMember[];
  roots: string[];
  planned: { root: string; plan?: unknown }[];
  binary: string;
  now: string;
  env: NodeJS.ProcessEnv;
  commit?: string;
  w: WaveRun;
  facts: WaveFacts;
  /** Write the wave's outcome line. */
  outcome: (line: string) => void;
  /** How the point is asked. Default: the chant bin terragucci installs with itself. */
  asker?: GatePointAsker;
}

/**
 * Decide a wave's gate by its decision point. Returns the approval the wave
 * applies under, or the exit code when it waits (3) or the point answered
 * otherwise (4).
 */
export async function pointGate(repo: string, i: PointGateInput): Promise<Extract<GateDecision, { status: "approved" }> | number> {
  if (i.mode !== "ledger") throw new ConfigError(`apply.point is set at base and approval is ${i.mode}; a wave gate that asks a decision point takes its quorum from the point, so set approval to ledger or drop apply.point`);
  const gate = `wave-${i.wave}`;
  const runId = i.env.GITHUB_RUN_ID ?? i.env.CI_PIPELINE_ID;
  const report = (): string =>
    JSON.stringify(buildReport({
      run: { ...runFacts(repo, i.env), stage: "tf-apply", wave: i.wave, binary: i.binary, runtime: "forge", started: i.now, finished: i.now },
      roots: i.planned.map((p) => ({ path: p.root, plan: p.plan, planner: plannerForBinary(i.binary) })),
      waves: [{ number: i.wave, roots: i.roots, setDigest: i.digest }],
    }));
  const port = wavePointPort(repo, { members: i.members, ...(i.commit ? { commit: i.commit } : {}), ...(runId ? { runId } : {}), files: { [approvedPath(i.wave, i.digest)]: report() } });
  const asker = i.asker ?? chantGatePointAsker({ command: [chantCommand(repo)], cwd: repo });
  console.log(`${i.label}: the gate asks decision point ${i.point} (apply.point at base)`);
  let check;
  try {
    check = await evaluatePointGate(port, asker, {
      op: APPLY_OP,
      gate,
      point: { name: i.point, store: "ledger" },
      planDigest: i.digest,
      now: i.now,
      timeout: "48h",
      description: `${i.label}: ${i.roots.join(", ")}`,
      ...(runId ? { runId } : {}),
    });
  } catch (e) {
    throw new ConfigError(`the gate could not ask decision point ${i.point}: ${(e as Error).message}`);
  }
  if (check.satisfied) {
    const by = check.answer.answeredBy?.join(", ") ?? check.resolution.resolvedBy;
    console.log(`${i.label}: decision point ${i.point} answered ${JSON.stringify(check.answer.answer)} for this digest (${check.answer.id}, by ${by})`);
    return { status: "approved", by: check.resolution.resolvedBy, at: check.resolution.timestamp };
  }
  if ("refused" in check) {
    console.log(`${i.label}: nothing was applied: ${check.refused}`);
    i.w.command = `chant workspace points retract ${check.answer.id} --by <name>`;
    i.outcome(`wave ${i.wave}: decision point ${i.point} answered ${JSON.stringify(check.answer.answer)}`);
    return EXIT.refused;
  }
  i.facts.waitingSince = check.pending.timestamp;
  i.w.waitingSince = check.pending.timestamp;
  i.w.gateSince = check.pending.timestamp;
  console.log(`${i.label} waits for decision point ${i.point} to answer question ${check.waiting.id} for digest ${i.digest}. Read its plans above, then answer it (a chat message's Approve button, through terragucci relay, answers it too):`);
  console.log(`  ${answerLine(check.waiting.id)}`);
  console.log("The point's quorum decides; an answer sent over MCP or ACP counts nobody toward it. Then run this job again.");
  i.w.command = answerLine(check.waiting.id);
  i.outcome(`wave ${i.wave} waits: ${i.w.command}`);
  return EXIT.waiting;
}

/**
 * The questions the resume job reads (./resume.ts): every question `chant
 * workspace points` lists, by id, when a wave's newest pending fact cites
 * one; undefined when none does, so a repo whose gates ask no point never
 * runs chant here.
 */
export async function pointQuestions(repo: string, ledger: GateLedger, o: { command?: string[] } = {}): Promise<Map<string, PointQuestionState> | undefined> {
  const newest = new Map<string, PendingRecord>();
  for (const p of ledger.pending) {
    const before = newest.get(p.gate);
    if (/^wave-\d+$/.test(p.gate) && (!before || new Date(p.timestamp).getTime() >= new Date(before.timestamp).getTime())) newest.set(p.gate, p);
  }
  if (![...newest.values()].some((p) => p.answer)) return undefined;
  // chant reads the questions from the local chant/lifecycle: bring it to origin's tip, as chant's own reads do. A local branch ahead of origin is left as it is.
  spawnSync("git", ["fetch", "-q", "origin", "chant/lifecycle:chant/lifecycle"], { cwd: repo, encoding: "utf-8" });
  return chantPointQuestions({ command: o.command ?? [chantCommand(repo)], cwd: repo });
}
