/**
 * A wave gate that asks a decision point (`apply.point`, which chant's op
 * waves ask: ./src/point-gate.ts), answered from chat through the relay
 * (./src/relay.ts), against the chant bin terragucci installs: the question
 * is held on chant/lifecycle, a chat approval answers it, the answer shows in
 * `chant workspace records`, and the wave passes on it. An agent's approval
 * does not meet a human quorum.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { applyWave, EXIT, readLedger } from "../src/apply";
import { chantCommand } from "../src/chant-bin";
import { pointQuestions } from "../src/point-gate";
import { resumable } from "../src/resume";
import { decideClick, workspace, workspaceDeps, type Click } from "../src/relay";
import { git, tmp, write } from "./helpers";

/** A fake tofu: plans one resource to create in the root, and logs each apply to $LOG. */
const TOFU = `#!/usr/bin/env bash
case "$2" in
  init) exit 0 ;;
  plan) for a in "$@"; do case "$a" in -out=*) echo x > "\${a#-out=}" ;; esac; done; echo "Plan: 1 to add" ;;
  show) echo '{"resource_changes":[{"address":"terraform_data.x","mode":"managed","type":"terraform_data","name":"x","change":{"actions":["create"],"before":null,"after":{"input":"1"},"after_unknown":{}}}]}' ;;
  apply) echo applied >> "$LOG"; echo "Apply complete! Resources: 1 added, 0 changed, 0 destroyed." ;;
esac
exit 0
`;

const KEY = "AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";
const SIGNERS = `alice@acme.com,slack:T1/U1 ssh-ed25519 ${KEY}\nbot@acme.com,slack:T1/B1 ssh-ed25519 ${KEY}\n`;
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

/** Wave 1 of the repo's one root, as the pipeline's job runs it, with its outcome written to `outcome`. */
const wave = (job: string, bin: string, outcome: string) =>
  applyWave(job, { wave: 1, layers: [["envs/prod"]], binary: bin, gate: "always", env: { ...process.env, CI: "true", TG_OUTCOME_JSON: outcome, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });

const click = (user: string, plan: string): Click => ({ app: "slack", chatUser: user, display: user, action: "approve", wave: 1, plan });

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
    const bin = join(dir, "tofu");
    writeFileSync(bin, TOFU);
    chmodSync(bin, 0o755);
    const log = join(dir, "apply.log");
    vi.stubEnv("LOG", log);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const outcome = join(dir, "outcome.json");

    // The wave asks, and waits on the open question chant records on the ledger.
    expect(await wave(job, bin, outcome)).toBe(EXIT.waiting);
    const ledger = readLedger(job);
    expect(ledger.pending).toHaveLength(1);
    const pending = ledger.pending[0]!;
    const D = pending.planDigest!;
    // chant's point gate does not yet carry the plans file's members and commit, nor neverOverMcp, onto the fact (chant#3863).
    expect(pending).toMatchObject({ op: "tf-apply", gate: "wave-1", answer: { point: "prod-apply" } });
    const id = pending.answer!.id;
    expect(JSON.parse(readFileSync(outcome, "utf-8"))).toMatchObject({ status: "waiting", exit: 3, approve_command: `chant workspace points answer ${id} --answer true --by <name>` });
    expect(existsSync(log)).toBe(false);
    // The question is on chant/lifecycle, not in the job's tree.
    expect(git(dir, "--git-dir", origin, "ls-tree", "-r", "--name-only", "chant/lifecycle")).toContain(`${id}.md`);

    // The relay, in its own workspace: an agent's click does not answer the question.
    const relay = workspace(origin);
    const deps = workspaceDeps(relay, "main", "terragucci-relay");
    const bot = await decideClick(click("slack:T1/B1", D), deps);
    expect(bot.ok).toBe(false);
    expect(bot.text).toContain("quorum-not-met");
    expect(bot.text).toContain("holds the agent role");

    // A person's click answers it, relayed by the relay.
    const alice = await decideClick(click("slack:T1/U1", D), deps);
    expect(alice).toMatchObject({ ok: true });
    expect(alice.text).toContain(`decision point question ${id} answered yes by alice@acme.com, relayed by terragucci-relay`);

    // The answer record shows in chant workspace records, read from a fresh clone, which fetches chant/lifecycle itself.
    const reader = join(dir, "reader");
    git(dir, "clone", "-q", origin, reader);
    const records = chantJson(reader, "workspace", "records", "--json");
    const listed = records.kinds.flatMap((k: { records: { id: string }[] }) => k.records).find((r: { id: string }) => r.id === id);
    expect(listed).toMatchObject({ id, state: "answered", ledger: expect.stringMatching(/^chant\/lifecycle:/) });
    const points = chantJson(reader, "workspace", "points", "--json");
    expect(points.questions.find((q: { id: string }) => q.id === id)).toMatchObject({ state: "answered", answer: true, answeredBy: ["alice@acme.com"], relayedBy: "terragucci-relay", subject: "gate:tf-apply/wave-1" });

    // The resume job, in the job's checkout, sees the answer pass the gate and resumes wave 1.
    const ledgerNow = readLedger(job);
    const questions = await pointQuestions(job, ledgerNow);
    expect(questions?.get(id)).toMatchObject({ state: "answered", answer: true });
    expect(resumable(ledgerNow, new Date().toISOString(), undefined, questions)).toMatchObject([{ wave: 1, digest: D, by: "alice@acme.com" }]);

    // The wave's next run passes on the answer, records the resolution that cites it once, and applies.
    expect(await wave(job, bin, outcome)).toBe(EXIT.applied);
    expect(readFileSync(log, "utf-8")).toContain("applied");
    const after = readLedger(job);
    expect(after.resolutions).toMatchObject([{ gate: "wave-1", resolvedBy: "alice@acme.com", planDigest: D, answer: { id, answer: true, answeredBy: ["alice@acme.com"] } }]);
    expect(await wave(job, bin, outcome)).toBe(EXIT.applied);
    expect(readLedger(job).resolutions).toHaveLength(1);
  }, 180_000);
});
