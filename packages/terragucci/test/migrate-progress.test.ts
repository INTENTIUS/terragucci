import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendLifecycle } from "../src/apply";
import { MIGRATE_LEDGER, runBinary, runMigrations } from "../src/migrate";
import { countsLine, countsOf, MigrationProgress, parseProgressLine, progressPath, type ProgressRecord } from "../src/migrate-progress";
import { Trace, tracesBody } from "../src/telemetry";
import { tmp, write } from "./helpers";

const T = (m: number): string => new Date(Date.UTC(2026, 9, 9, 12, m)).toISOString();
const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf-8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });

// ── a stub choudoufu: an executable the job runs as it runs the real one ──
// $STUB_REPO/live.json is the account: each resource's id and its markers. A
// root's want.json lists what its code declares; its live block names its
// estate. `live-mv` rewrites the markers and, with -progress-json, writes one
// line to stderr per resource. A live.json entry with `follows` is a follower:
// it moves with each leader it names, and each leader's write prints a line
// for it, as choudoufu's does. Its `-help` names the flag only with
// STUB_PROGRESS=1, as an older choudoufu's does not. Every call is appended
// to $STUB_REPO/calls.txt.
const STUB = String.raw`#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const argv = process.argv.slice(2);
const dir = argv[0].startsWith("-chdir=") ? argv.shift().slice(7) : process.cwd();
const repo = process.env.STUB_REPO;
fs.appendFileSync(path.join(repo, "calls.txt"), path.relative(repo, dir) + ": " + argv.join(" ") + "\n");
const liveFile = path.join(repo, "live.json");
const live = () => JSON.parse(fs.readFileSync(liveFile, "utf-8"));
const estate = (/estate\s*=\s*"([^"]+)"/.exec(fs.readFileSync(path.join(dir, "main.tf"), "utf-8")) || [])[1];
const want = () => JSON.parse(fs.readFileSync(path.join(dir, "want.json"), "utf-8"));
const out = (s) => process.stdout.write(s);
const [cmd] = argv;
if (cmd === "init") process.exit(0);
if (cmd === "plan") {
  const owned = live().filter((l) => l.estate === estate).map((l) => l.address);
  const changes = [
    ...want().filter((a) => !owned.includes(a)).map((a) => ({ address: a, change: { actions: ["create"] } })),
    ...owned.filter((a) => !want().includes(a)).map((a) => ({ address: a, change: { actions: ["delete"] } })),
  ];
  fs.writeFileSync(argv.find((a) => a.startsWith("-out=")).slice(5), JSON.stringify({ resource_changes: changes }));
  out(changes.length ? "Plan: some changes.\n" : "No changes. Your infrastructure matches the configuration.\n");
  process.exit(0);
}
if (cmd === "show") { out(fs.readFileSync(argv[2], "utf-8")); process.exit(0); }
if (cmd === "live-mv" && argv.includes("-help")) {
  process.stderr.write("Usage: choudoufu live-mv [options] SOURCE DESTINATION\n\n  -dry-run\n  -json\n" + (process.env.STUB_PROGRESS === "1" ? "  -progress-json          Write one JSON line to stderr per resource as its marker write returns.\n" : ""));
  process.exit(127);
}
if (cmd === "live-mv") {
  if (argv.includes("-progress-json") && process.env.STUB_PROGRESS !== "1") { process.stderr.write("flag provided but not defined: -progress-json\n"); process.exit(1); }
  const from = argv.find((a) => a.startsWith("-from-estate=")).slice(13);
  const address = argv[argv.length - 1];
  const all = live();
  const r = all.find((l) => l.estate === from && l.address === address);
  const followers = all.filter((l) => (l.follows || []).includes(address));
  const doc = (written) => JSON.stringify({ resource: r ? { live_id: r.id } : undefined, from: { estate: from, address }, to: { estate, address }, followers: followers.map((f) => ({ address: f.address })), dry_run: argv.includes("-dry-run"), written, refusal: r ? null : { code: "not_found", summary: "nothing carries " + address } });
  if (!r) { out(doc(false)); process.exit(1); }
  if (argv.includes("-dry-run")) { out(doc(false)); process.exit(0); }
  r.estate = estate;
  for (const f of followers) f.estate = estate;
  fs.writeFileSync(liveFile, JSON.stringify(all));
  process.stderr.write("Moving " + address + "...\n");
  if (argv.includes("-progress-json")) {
    process.stderr.write(JSON.stringify({ at: new Date().toISOString(), estate_from: from, estate_to: estate, address, live_id: r.id, outcome: "moved" }) + "\n");
    for (const f of followers) process.stderr.write(JSON.stringify({ at: new Date().toISOString(), estate_from: from, estate_to: estate, address: f.address, live_id: "", outcome: "moved", follows: address }) + "\n");
  }
  out(doc(true));
  process.exit(0);
}
process.stderr.write("the stub choudoufu does not know " + argv.join(" ") + "\n");
process.exit(1);
`;

const liveBlock = (estate: string): string => `terraform {\n  live {\n    estate = "${estate}"\n    record_store "s3" {\n      bucket = "records"\n    }\n  }\n}\n`;

/** Estate mono owns the queues jobs, dlq and keep; the code now declares jobs and dlq in team. A stub choudoufu sits in bin/. */
function carveRepo() {
  return stubRepo(
    {
      "mono/main.tf": `${liveBlock("mono")}resource "aws_sqs_queue" "keep" {}\n`,
      "mono/want.json": JSON.stringify(["aws_sqs_queue.keep"]),
      "team/main.tf": `${liveBlock("team")}resource "aws_sqs_queue" "jobs" {}\nresource "aws_sqs_queue" "dlq" {}\n`,
      "team/want.json": JSON.stringify(["aws_sqs_queue.dlq", "aws_sqs_queue.jobs"]),
      "migrations/carve.yml": "moves:\n  - from: mono\n    to: team\n    addresses: [aws_sqs_queue.jobs, aws_sqs_queue.dlq]\n",
    },
    [
      { id: "q-jobs", estate: "mono", address: "aws_sqs_queue.jobs" },
      { id: "q-dlq", estate: "mono", address: "aws_sqs_queue.dlq" },
      { id: "q-keep", estate: "mono", address: "aws_sqs_queue.keep" },
    ],
  );
}

/** Estate mono owns a role and a policy, and the attachment that follows both; the code now declares all three in team. */
function attachRepo() {
  const attach = "aws_iam_role_policy_attachment.attach";
  return stubRepo(
    {
      "mono/main.tf": `${liveBlock("mono")}`,
      "mono/want.json": JSON.stringify([]),
      "team/main.tf": `${liveBlock("team")}resource "aws_iam_role" "role" {}\nresource "aws_iam_policy" "policy" {}\nresource "aws_iam_role_policy_attachment" "attach" {}\n`,
      "team/want.json": JSON.stringify(["aws_iam_policy.policy", "aws_iam_role.role", attach]),
      "migrations/carve.yml": "moves:\n  - from: mono\n    to: team\n    addresses: [aws_iam_role.role, aws_iam_policy.policy]\n",
    },
    [
      { id: "role", estate: "mono", address: "aws_iam_role.role" },
      { id: "arn:policy", estate: "mono", address: "aws_iam_policy.policy" },
      { id: "role/arn:policy", estate: "mono", address: attach, follows: ["aws_iam_role.role", "aws_iam_policy.policy"] },
    ],
  );
}

function stubRepo(files: Record<string, string>, live: { id: string; estate: string; address: string; follows?: string[] }[]) {
  const dir = tmp("tg-progress-");
  const origin = join(dir, "origin.git");
  git(dir, "init", "-q", "--bare", origin);
  const work = join(dir, "work");
  mkdirSync(work);
  write(work, { ".gitignore": "live.json\ncalls.txt\nterragucci-report/\n", ...files });
  git(work, "init", "-q", "-b", "main");
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", "base");
  git(work, "remote", "add", "origin", origin);
  git(work, "push", "-q", "origin", "main");
  writeFileSync(join(work, "live.json"), JSON.stringify(live));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const binary = join(bin, "choudoufu");
  writeFileSync(binary, STUB);
  chmodSync(binary, 0o755);
  return { work, binary };
}

function approve(work: string, gate: string, digest: string, at: string): void {
  appendLifecycle(work, MIGRATE_LEDGER, [JSON.stringify({ version: 1, kind: "resolution", op: "tf-migrate", gate, resolvedBy: "alice", timestamp: at, planDigest: digest })], {}, "approve");
}

const readLines = (file: string): ProgressRecord[] => readFileSync(file, "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as ProgressRecord);

describe("a moves migration's progress, against a stub choudoufu that prints -progress-json lines", () => {
  it("appends each line to migrations/<name>/progress.jsonl with the counts, adds a span event per line, copies both files, and ends the record with the counts", async () => {
    const { work, binary } = carveRepo();
    const env = { PATH: process.env.PATH, STUB_REPO: work, STUB_PROGRESS: "1", TG_PROGRESS_SECONDS: "1" };
    const first = await runMigrations(work, { binary, env, now: T(1), log: () => {} });
    expect(first.code).toBe(3);
    expect(first.records[0]).toMatchObject({ change: "retag", status: "waiting" });
    expect(first.records[0]!.progress).toBeUndefined();
    approve(work, "carve", first.records[0]!.digest, T(2));

    const published = new Map<string, string>();
    const events: { name: string; attributes: Record<string, unknown> }[] = [];
    const ended: unknown[] = [];
    const second = await runMigrations(work, {
      binary,
      env,
      now: T(3),
      log: () => {},
      progress: () => ({
        publish: async (path, body) => void published.set(path, body),
        event: (name, attributes) => void events.push({ name, attributes }),
        end: (status, counts) => void ended.push({ status, counts }),
      }),
    });
    expect(second.code).toBe(0);
    const calls = readFileSync(join(work, "calls.txt"), "utf-8");
    expect(calls).toContain("live-mv -no-color -json -progress-json -from-estate=mono aws_sqs_queue.dlq aws_sqs_queue.dlq");
    // The dry runs of the plan take no flag: they write nothing.
    expect(calls).not.toMatch(/-dry-run -progress-json/);

    const file = join(work, "terragucci-report", progressPath("carve"));
    const lines = readLines(file);
    // In the order the file names the addresses: each line as its write landed.
    expect(lines.map((l) => [l.address, l.live_id, l.outcome, l.estate_from, l.estate_to, l.migration])).toEqual([
      ["aws_sqs_queue.jobs", "q-jobs", "moved", "mono", "team", "carve"],
      ["aws_sqs_queue.dlq", "q-dlq", "moved", "mono", "team", "carve"],
    ]);
    expect(lines.map((l) => l.counts)).toEqual([
      { moved: 1, stamped: 0, refused: 0, skipped: 0, left: 1 },
      { moved: 2, stamped: 0, refused: 0, skipped: 0, left: 0 },
    ]);
    expect(lines.every((l) => !Number.isNaN(Date.parse(l.at)))).toBe(true);

    const counts = { moved: 2, stamped: 0, refused: 0, skipped: 0, left: 0 };
    expect(second.records[0]).toMatchObject({ status: "applied", progress: counts });
    const record = JSON.parse(readFileSync(join(work, "terragucci-report", "migrations", "carve.json"), "utf-8"));
    expect(record.progress).toEqual(counts);

    expect(published.get("migrations/carve/progress.jsonl")).toBe(readFileSync(file, "utf-8"));
    expect(JSON.parse(published.get("migrations/carve.json")!).progress).toEqual(counts);
    expect(events.map((e) => [e.name, e.attributes["terragucci.migration.address"], e.attributes["terragucci.migration.left"]])).toEqual([
      ["migration moved", "aws_sqs_queue.jobs", 1],
      ["migration moved", "aws_sqs_queue.dlq", 0],
    ]);
    expect(ended).toEqual([{ status: "applied", counts }]);
  });

  it("runs as before with a choudoufu whose live-mv takes no -progress-json: no flag, no progress file, no counts", async () => {
    const { work, binary } = carveRepo();
    const env = { PATH: process.env.PATH, STUB_REPO: work };
    const first = await runMigrations(work, { binary, env, now: T(1), log: () => {} });
    approve(work, "carve", first.records[0]!.digest, T(2));
    const second = await runMigrations(work, { binary, env, now: T(3), log: () => {}, progress: () => ({}) });
    expect(second.code).toBe(0);
    expect(second.records[0]!.status).toBe("applied");
    expect(second.records[0]!.progress).toBeUndefined();
    expect(readFileSync(join(work, "calls.txt"), "utf-8")).not.toContain("-progress-json -from-estate");
    expect(existsSync(join(work, "terragucci-report", progressPath("carve")))).toBe(false);
  });

  it("writes a follower of two leaders once, and counts it once", async () => {
    const { work, binary } = attachRepo();
    const env = { PATH: process.env.PATH, STUB_REPO: work, STUB_PROGRESS: "1" };
    const first = await runMigrations(work, { binary, env, now: T(1), log: () => {} });
    expect(first.code).toBe(3);
    approve(work, "carve", first.records[0]!.digest, T(2));
    const events: string[] = [];
    const second = await runMigrations(work, { binary, env, now: T(3), log: () => {}, progress: () => ({ event: (_, a) => void events.push(String(a["terragucci.migration.address"])) }) });
    expect(second.code).toBe(0);
    const attach = "aws_iam_role_policy_attachment.attach";
    const lines = readLines(join(work, "terragucci-report", progressPath("carve")));
    expect(lines.map((l) => [l.address, l.follows])).toEqual([
      ["aws_iam_role.role", undefined],
      [attach, "aws_iam_role.role"],
      ["aws_iam_policy.policy", undefined],
    ]);
    expect(events).toEqual(["aws_iam_role.role", attach, "aws_iam_policy.policy"]);
    expect(lines.map((l) => l.counts.left)).toEqual([2, 1, 0]);
    expect(second.records[0]).toMatchObject({ status: "applied", progress: { moved: 3, stamped: 0, refused: 0, skipped: 0, left: 0 } });
  });
});

describe("the progress lines", () => {
  it("parses choudoufu's line and refuses any other", () => {
    expect(parseProgressLine('{"at":"2026-10-17T04:39:52.1Z","estate_from":"mono","estate_to":"team","address":"aws_sqs_queue_policy.jobs","live_id":"","outcome":"moved","follows":"aws_sqs_queue.jobs"}')).toEqual({
      at: "2026-10-17T04:39:52.1Z",
      estate_from: "mono",
      estate_to: "team",
      address: "aws_sqs_queue_policy.jobs",
      live_id: "",
      outcome: "moved",
      follows: "aws_sqs_queue.jobs",
    });
    expect(parseProgressLine("Moving aws_sqs_queue.jobs...")).toBeUndefined();
    expect(parseProgressLine('{"address":"a","outcome":"exploded"}')).toBeUndefined();
    expect(parseProgressLine("{not json")).toBeUndefined();
  });

  it("counts each outcome and what is left, and says it in one line", () => {
    const c = countsOf([{ address: "a", outcome: "moved" }, { address: "b", outcome: "refused" }, { address: "c", outcome: "moved" }, { address: "d", outcome: "skipped" }], 79);
    expect(c).toEqual({ moved: 2, stamped: 0, refused: 1, skipped: 1, left: 75 });
    // An address counts once, as its last line says.
    expect(countsOf([{ address: "a", outcome: "moved" }, { address: "a", outcome: "refused" }, { address: "a", outcome: "refused" }], 2)).toEqual({ moved: 0, stamped: 0, refused: 1, skipped: 0, left: 1 });
    expect(countsLine("carve", { ...c, moved: 36, left: 41 }, "retag")).toBe("carve: 36 of 79 moved, 1 refused, 1 skipped");
    expect(countsLine("adopt", { moved: 0, stamped: 3, refused: 0, skipped: 0, left: 1 }, "adopt")).toBe("adopt: 3 of 4 stamped");
  });

  it("takes progress lines out of the run's output as they arrive, and leaves every other line in it", async () => {
    const dir = tmp("tg-progress-io-");
    const bin = join(dir, "stub");
    writeFileSync(bin, '#!/bin/sh\necho "starting" >&2\necho \'{"at":"t","estate_from":"a","estate_to":"b","address":"x.y","live_id":"i","outcome":"moved"}\' >&2\necho "{\\"done\\":true}"\nprintf "last" >&2\n');
    chmodSync(bin, 0o755);
    const seen: string[] = [];
    const ran = await runBinary(bin, [], dir, { PATH: process.env.PATH }, { stderr: (l) => (seen.push(l), parseProgressLine(l) !== undefined) });
    expect(ran.code).toBe(0);
    expect(seen).toEqual(["starting", '{"at":"t","estate_from":"a","estate_to":"b","address":"x.y","live_id":"i","outcome":"moved"}', "last"]);
    expect(ran.stdout).toBe('{"done":true}\n');
    expect(ran.out).not.toContain("x.y");
    expect(ran.out).toContain("starting");
  });

  it("drops a follower's second line when it says what the first did, and keeps one that says otherwise", async () => {
    const repo = tmp("tg-progress-follow-");
    const p = new MigrationProgress({ repo, name: "split", change: "retag", total: 3, record: () => ({ name: "split" }) });
    const at = { at: T(1), estate_from: "mono", estate_to: "team" };
    const attach = "aws_iam_role_policy_attachment.attach";
    p.line({ ...at, address: "aws_iam_role.role", live_id: "role", outcome: "moved" });
    p.line({ ...at, address: attach, live_id: "", outcome: "moved", follows: "aws_iam_role.role" });
    p.line({ ...at, address: "aws_iam_policy.policy", live_id: "arn:policy", outcome: "moved" });
    p.line({ ...at, address: attach, live_id: "", outcome: "moved", follows: "aws_iam_policy.policy" });
    expect(p.progress).toEqual({ moved: 3, stamped: 0, refused: 0, skipped: 0, left: 0 });
    expect(readLines(join(repo, "terragucci-report", progressPath("split"))).map((l) => l.address)).toEqual(["aws_iam_role.role", attach, "aws_iam_policy.policy"]);
    p.line({ ...at, address: attach, live_id: "", outcome: "refused", reason: "r", follows: "aws_iam_policy.policy" });
    expect(await p.stop()).toEqual({ moved: 2, stamped: 0, refused: 1, skipped: 0, left: 0 });
    expect(p.lines).toHaveLength(4);
  });

  it("copies at most once per interval while lines arrive, and once more at the end", async () => {
    const repo = tmp("tg-progress-copy-");
    const copies: string[] = [];
    const p = new MigrationProgress({ repo, name: "carve", change: "retag", total: 3, record: () => ({ name: "carve" }), intervalMs: 60_000, publish: async (path) => void copies.push(path) });
    for (const a of ["a.b", "c.d"]) p.line({ at: T(1), estate_from: "m", estate_to: "t", address: a, live_id: a, outcome: "moved" });
    expect(copies).toEqual([]);
    expect(await p.stop()).toEqual({ moved: 2, stamped: 0, refused: 0, skipped: 0, left: 1 });
    expect(copies).toEqual(["migrations/carve/progress.jsonl", "migrations/carve.json"]);
  });
});

describe("span events", () => {
  it("go into the span's OTLP body at the line's time", () => {
    const trace = new Trace();
    const span = trace.start("migration carve");
    trace.event(span, "migration moved", { "terragucci.migration.address": "aws_sqs_queue.jobs" }, "2026-10-17T04:39:52.000Z");
    trace.end(span);
    const body = tracesBody(trace.spans, {}, "0") as { resourceSpans: { scopeSpans: { spans: { events?: { timeUnixNano: string; name: string; attributes: unknown[] }[] }[] }[] }[] };
    expect(body.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.events).toEqual([
      { timeUnixNano: String(BigInt(Date.parse("2026-10-17T04:39:52.000Z")) * 1_000_000n), name: "migration moved", attributes: [{ key: "terragucci.migration.address", value: { stringValue: "aws_sqs_queue.jobs" } }] },
    ]);
  });
});
