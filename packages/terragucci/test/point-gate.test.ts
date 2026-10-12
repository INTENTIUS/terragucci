/**
 * A wave gate that asks a decision point (./src/point-gate.ts), answered from
 * chat through the relay (./src/relay.ts), against the chant bin terragucci
 * installs: the question is held on chant/lifecycle, a chat approval answers
 * it, the answer shows in `chant workspace records`, and the wave passes on
 * it. An agent's approval does not meet a human quorum.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EXIT, readLedger, type WaveRun } from "../src/apply";
import { chantCommand } from "../src/approve";
import { pointGate, type PointGateInput } from "../src/point-gate";
import { decideClick, workspace, workspaceDeps, type Click } from "../src/relay";
import type { WaveFacts } from "../src/report/wave-telemetry";
import { git, tmp, write } from "./helpers";

const KEY = "AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";
const SIGNERS = `alice@acme.com,slack:T1/U1 ssh-ed25519 ${KEY}\nbot@acme.com,slack:T1/B1 ssh-ed25519 ${KEY}\n`;
const D = "jcs1-sha256:" + "c".repeat(64);
const SCHEMA = join(import.meta.dirname, "../../../node_modules/@intentius/chant/src/workspace/point-answer.schema.json");

const POINTS = {
  points: {
    "prod-apply": {
      title: "Apply this wave's plans",
      question: { type: "noul", instructions: "Should these plans be applied?", criteria: { true: "Apply them.", false: "Do not apply them." } },
      inputs: { "gate.component": "the op", "gate.name": "the wave's gate", "gate.planDigest": "the plans the gate binds" },
      deciders: [{ kind: "quorum", count: 1 }],
    },
  },
};

const KIND = `export const recordKind = {
  name: "answer",
  location: { dir: ".", match: "^[a-z][a-z0-9-]*-[0-9a-f]{12}\\\\.md$" },
  format: "markdown-front-matter",
  schema: { id: "urn:intentius:chant:point-answer:1", path: "answer.schema.json" },
  idField: "id",
  stateField: "state",
  states: ["escalated", "proposed", "answered"],
  closedStates: ["answered"],
  constrains: { field: "constrains" },
  source: { field: "source" },
  answers: { points: "../decisions/points.json" },
};
`;

const ID = ["-c", "user.name=t", "-c", "user.email=t@t"];

/** A repo whose workspace declares the point, pushed to a bare origin, and a checkout of it as the wave's job has. */
function repo(): { dir: string; origin: string; job: string } {
  const dir = tmp("tg-point-");
  const origin = join(dir, "origin.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  const job = join(dir, "job");
  git(dir, "init", "-q", "-b", "main", job);
  write(job, {
    "terragucci.yml": "binary: tofu\ngate: always\napply:\n  point: prod-apply\n",
    "chant.workspace.json": JSON.stringify({ name: "infra", schema: 1, members: [{ name: "envs", dir: "envs", kind: "other", because: "the Terraform roots" }], records: [{ kind: "answers/answer.kind.mjs" }] }, null, 2),
    "envs/prod/main.tf": "terraform {}\n",
    "decisions/points.json": JSON.stringify(POINTS, null, 2),
    "answers/answer.kind.mjs": KIND,
    "answers/answer.schema.json": readFileSync(SCHEMA, "utf-8"),
    ".chant/allowed_signers": SIGNERS,
    ".chant/trust.json": JSON.stringify({ schema: 1, roles: { agent: ["bot@acme.com"] } }),
  });
  git(job, "add", "-A");
  git(job, ...ID, "commit", "-q", "-m", "main");
  git(job, "remote", "add", "origin", origin);
  git(job, "push", "-q", "origin", "main");
  return { dir, origin, job };
}

const wave = (job: string): PointGateInput => ({
  point: "prod-apply",
  mode: "ledger",
  label: "wave 1",
  wave: 1,
  digest: D,
  members: [{ member: "envs/prod", planDigest: D }],
  roots: ["envs/prod"],
  planned: [],
  binary: "tofu",
  now: new Date().toISOString(),
  env: { ...process.env, CI: "true", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  w: {} as WaveRun,
  facts: {} as WaveFacts,
  outcome: () => {},
});

const click = (user: string): Click => ({ app: "slack", chatUser: user, display: user, action: "approve", wave: 1, plan: D });

const chantJson = (cwd: string, ...args: string[]): any => {
  let out: string;
  try {
    out = execFileSync(chantCommand(cwd), args, { cwd, encoding: "utf-8", env: { ...process.env, NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    out = String((e as { stdout?: string }).stdout ?? "");
  }
  return JSON.parse(out);
};

describe("a wave gate that asks a decision point, answered from chat", () => {
  it("waits on a question held on chant/lifecycle, takes a chat approval as the answer, and passes on it; an agent's approval does not count", async () => {
    const { dir, origin, job } = repo();
    const env = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
    Object.assign(process.env, env);

    // The wave asks, and waits on the open question it records on the ledger.
    const first = wave(job);
    expect(await pointGate(job, first)).toBe(EXIT.waiting);
    const ledger = readLedger(job);
    expect(ledger.pending).toHaveLength(1);
    const pending = ledger.pending[0]!;
    expect(pending).toMatchObject({ gate: "wave-1", planDigest: D, neverOverMcp: true, members: [{ member: "envs/prod", planDigest: D }], answer: { point: "prod-apply" } });
    const id = pending.answer!.id;
    expect(first.w.command).toBe(`chant workspace points answer ${id} --answer true --by <name>`);
    // The question is on chant/lifecycle, not in the job's tree.
    expect(git(dir, "--git-dir", origin, "ls-tree", "-r", "--name-only", "chant/lifecycle")).toContain(`${id}.md`);
    expect(git(job, "status", "--porcelain")).toBe("");

    // The relay, in its own workspace: an agent's click does not answer the question.
    const relay = workspace(origin);
    const deps = workspaceDeps(relay, "main", "terragucci-relay");
    const bot = await decideClick(click("slack:T1/B1"), deps);
    expect(bot.ok).toBe(false);
    expect(bot.text).toContain("quorum-not-met");
    expect(bot.text).toContain("holds the agent role");

    // A person's click answers it, relayed by the relay.
    const alice = await decideClick(click("slack:T1/U1"), deps);
    expect(alice).toMatchObject({ ok: true });
    expect(alice.text).toContain(`decision point question ${id} answered yes by alice@acme.com, relayed by terragucci-relay`);

    // The answer record, read from another clone. `chant workspace records` lists a ledger-held answer once chant#3833 lands; `points` does now.
    const reader = join(dir, "reader");
    git(dir, "clone", "-q", origin, reader);
    git(reader, "fetch", "-q", "origin", "chant/lifecycle:chant/lifecycle");
    const points = chantJson(reader, "workspace", "points", "--json");
    expect(points.questions.find((q: { id: string }) => q.id === id)).toMatchObject({ state: "answered", answer: true, answeredBy: ["alice@acme.com"], relayedBy: "terragucci-relay", subject: "gate:tf-apply/wave-1" });

    // The wave's next run passes on the answer, and records the resolution that cites it once.
    const again = wave(job);
    expect(await pointGate(job, again)).toEqual({ status: "approved", by: "alice@acme.com", at: expect.any(String) });
    const after = readLedger(job);
    expect(after.resolutions).toMatchObject([{ gate: "wave-1", resolvedBy: "alice@acme.com", planDigest: D, answer: { id, answer: true, answeredBy: ["alice@acme.com"] } }]);
    expect(await pointGate(job, wave(job))).toMatchObject({ status: "approved" });
    expect(readLedger(job).resolutions).toHaveLength(1);
  }, 180_000);
});
