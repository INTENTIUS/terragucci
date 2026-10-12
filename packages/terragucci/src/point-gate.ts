/**
 * A wave gate that asks a workspace decision point (`apply.point` at base).
 *
 * chant's op waves ask it (chant#3836): the spec terragucci renders names the
 * point on every wave (./chant-waves.ts), read at base, and chant asks it with
 * the gate's facts: `gate.component` is `tf-apply`, `gate.name` is
 * `wave-<k>` and `gate.planDigest` is the wave's set digest. A point that does
 * not declare `gate.planDigest` is refused, so each plan is its own question
 * and an answer for one plan never passes another. The question is held on
 * `chant/lifecycle`, so it outlives the job that asked it, and the chat relay
 * (./relay.ts) or a person at a shell answers it there. The point's deciders
 * and quorum decide; an answer given over MCP or ACP counts nobody toward a
 * quorum, and chant refuses one for a gate whose pending fact says
 * `neverOverMcp`, as every wave's does.
 *
 *   open      chant records a pending fact that cites the question, and the
 *             wave waits (exit 3) with the `points answer` line;
 *   yes       chant records a resolution that cites the answer record, once
 *             per answer and plan, and the wave applies as under any approval;
 *   any other the wave applies nothing and names the record (exit 4).
 *
 * `terragucci approve` and `chant approve` do not pass such a gate.
 */
import { spawnSync } from "node:child_process";
import { chantPointQuestions, type PointQuestionState } from "@intentius/chant/point-decision";
import type { GateLedger, PendingRecord } from "./apply";
import { chantCommand } from "./chant-bin";

/** The line a person runs to answer the question a wave waits on. */
export const answerLine = (id: string): string => `chant workspace points answer ${id} --answer true --by <name>`;

/** The line that takes a refusing answer back, so the point is asked again. */
export const retractLine = (id: string): string => `chant workspace points retract ${id} --by <name>`;

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
