import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendLifecycle } from "../src/apply";
import { MIGRATE_DONE, MIGRATE_LEDGER, parseMigration, planMigration, revertMigration, runMigrations, type BinaryExec } from "../src/migrate";
import { isChoudoufu, parseRatification, stampFailures } from "../src/migrate-estate";
import { tmp, write } from "./helpers";

const T = (m: number): string => new Date(Date.UTC(2026, 9, 9, 12, m)).toISOString();
const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf-8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });

// ── a simulated choudoufu over a simulated live system ──────────────────
// live.json at the top of the repo is the account: each resource's id and
// its two markers. A root's want.json lists the addresses its code declares,
// and its live block names its estate. A plan creates what the root declares
// and its estate does not own, and destroys what it owns and does not
// declare. live-mv rewrites the markers of the resource the source estate
// holds under the address; live-import verifies each resource of a state by
// its id and, with -approve, stamps it.

interface Live {
  id: string;
  estate?: string;
  address?: string;
}
type Calls = string[];

const liveOf = (repo: string): Live[] => JSON.parse(readFileSync(join(repo, "live.json"), "utf-8")) as Live[];
const setLive = (repo: string, l: Live[]) => writeFileSync(join(repo, "live.json"), JSON.stringify(l));

function choudoufu(repo: string, calls: Calls = []): BinaryExec {
  return async (_binary, args, dir) => {
    calls.push(`${dir.slice(repo.length + 1)}: ${args.join(" ")}`);
    const ok = (stdout = "", out = stdout) => ({ code: 0, stdout, out });
    const estate = /estate\s*=\s*"([^"]+)"/.exec(readFileSync(join(dir, "main.tf"), "utf-8"))?.[1];
    const want = (): string[] => JSON.parse(readFileSync(join(dir, "want.json"), "utf-8")) as string[];
    if (args[0] === "init") return args.includes("-reconfigure") ? { code: 1, stdout: "", out: "Backend migration is not available under live resource markers" } : ok();
    if (args[0] === "plan") {
      const owned = liveOf(repo).filter((l) => l.estate === estate).map((l) => l.address!);
      const changes = [...want().filter((a) => !owned.includes(a)).map((a) => ({ address: a, change: { actions: ["create"] } })), ...owned.filter((a) => !want().includes(a)).map((a) => ({ address: a, change: { actions: ["delete"] } })), ...owned.filter((a) => want().includes(a)).map((a) => ({ address: a, change: { actions: ["no-op"] } }))];
      writeFileSync(args.find((a) => a.startsWith("-out="))!.slice(5), JSON.stringify({ resource_changes: changes }));
      return ok(changes.some((c) => c.change.actions[0] !== "no-op") ? "Plan: some changes." : "No changes. Your infrastructure matches the configuration.");
    }
    if (args[0] === "show") return ok(readFileSync(args[2]!, "utf-8"));
    if (args[0] === "live-mv") {
      const from = args.find((a) => a.startsWith("-from-estate="))!.slice(13);
      const address = args[args.length - 1]!;
      const live = liveOf(repo);
      const r = live.find((l) => l.estate === from && l.address === address);
      const doc = (refusal: unknown, written = false) => JSON.stringify({ resource: r ? { live_id: r.id } : undefined, from: { estate: from, address }, to: { estate, address }, followers: [], dry_run: args.includes("-dry-run"), written, refusal });
      if (!r) return { code: 1, stdout: doc({ code: "not_found", summary: `nothing in estate ${from} carries ${address}` }), out: "not found" };
      if (args.includes("-dry-run")) return ok(doc(null));
      r.estate = estate;
      setLive(repo, live);
      return ok(doc(null, true));
    }
    if (args[0] === "live-import") {
      const state = JSON.parse(readFileSync(args.find((a) => a.startsWith("-state="))!.slice(7), "utf-8")) as { resources: { type: string; name: string; instances: { attributes: { id: string } }[] }[] };
      const named = args.find((a) => a.startsWith("-estate="))!.slice(8);
      const live = liveOf(repo);
      const rows = state.resources.map((r) => ({ address: `${r.type}.${r.name}`, type: r.type, id: r.instances[0]!.attributes.id, found: live.find((l) => l.id === r.instances[0]!.attributes.id) }));
      const group = (status: string, list: typeof rows) => (list.length ? [`${status} (${list.length}) - headline:`, ...list.flatMap((x) => [`  ${x.address.padEnd(42)} ${x.type.padEnd(24)} live id: ${x.found ? x.id : "-"}`, "    detail"]), ""] : []);
      const verified = rows.filter((x) => x.found);
      let text = ["", `Ratifying the state for estate "${named}".`, "", ...group("VERIFIED", verified), ...group("MISSING", rows.filter((x) => !x.found)), `${verified.length} of ${rows.length} resource instance(s) are eligible for stamping (VERIFIED or DRIFTED).`].join("\n");
      if (args.includes("-approve")) {
        for (const x of verified) Object.assign(x.found!, { estate: named, address: x.address });
        setLive(repo, live);
        text += `\n\nSTAMPED (${verified.length}) - stamped:\n\n${verified.length} resource(s) newly stamped, 0 already stamped, 0 newly recorded, 0 re-recorded for sensitivity only, 0 already recorded, 0 failed, 0 skipped.\n`;
      }
      return ok(text);
    }
    return { code: 1, stdout: "", out: `the fake choudoufu does not know ${args.join(" ")}` };
  };
}

const liveBlock = (estate: string): string => `terraform {\n  live {\n    estate = "${estate}"\n    record_store "s3" {\n      bucket = "records"\n    }\n  }\n}\n`;

/** A repo with origin, committed, holding `files`. */
function repo(files: Record<string, string>) {
  const dir = tmp("tg-estate-");
  const origin = join(dir, "origin.git");
  git(dir, "init", "-q", "--bare", origin);
  const work = join(dir, "work");
  mkdirSync(work);
  write(work, files);
  git(work, "init", "-q", "-b", "main");
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", "base");
  git(work, "remote", "add", "origin", origin);
  git(work, "push", "-q", "origin", "main");
  return { work, origin };
}

function approve(work: string, gate: string, digest: string, at: string): void {
  appendLifecycle(work, MIGRATE_LEDGER, [JSON.stringify({ version: 1, kind: "resolution", op: "tf-migrate", gate, resolvedBy: "alice", timestamp: at, planDigest: digest })], {}, "approve");
}

/** Estate mono owns the queues jobs and keep; the code now declares jobs in team. */
const retagRepo = (teamWants = ["aws_sqs_queue.jobs"]) =>
  repo({
    "live.json": JSON.stringify([
      { id: "q-jobs", estate: "mono", address: "aws_sqs_queue.jobs" },
      { id: "q-keep", estate: "mono", address: "aws_sqs_queue.keep" },
    ]),
    "mono/main.tf": `${liveBlock("mono")}resource "aws_sqs_queue" "keep" {}\n`,
    "mono/want.json": JSON.stringify(["aws_sqs_queue.keep"]),
    "team/main.tf": `${liveBlock("team")}resource "aws_sqs_queue" "jobs" {}\n`,
    "team/want.json": JSON.stringify(teamWants),
    "migrations/carve-jobs.yml": "moves:\n  - from: mono\n    to: team\n    addresses: [aws_sqs_queue.jobs]\n",
  });

describe("a move between two estates", () => {
  it("is a retag: proved by each plan and the dry run, approved by digest, written by live-mv, with no change after and the move on chant/lifecycle", async () => {
    const { work, origin } = retagRepo();
    const calls: Calls = [];
    const lines: string[] = [];
    const exec = choudoufu(work, calls);
    const first = await runMigrations(work, { binary: "choudoufu", exec, env: {}, now: T(1), log: (l) => void lines.push(l) });
    expect(first.code).toBe(3);
    const rec = first.records[0]!;
    expect(rec).toMatchObject({ change: "retag", status: "waiting", retags: [{ address: "aws_sqs_queue.jobs", from: "mono", to: "team", from_estate: "mono", to_estate: "team", live_id: "q-jobs" }] });
    expect(rec.roots.map((r) => [r.root, r.proof.changes])).toEqual([["mono", []], ["team", []]]);
    expect(lines.join("\n")).toContain("every change each root plans is one the retag removes; digest");
    // Nothing was written: init never asked choudoufu to reconfigure, and the only live-mv was a dry run.
    expect(calls.filter((c) => c.includes("live-mv"))).toEqual(["team: live-mv -no-color -json -dry-run -from-estate=mono aws_sqs_queue.jobs aws_sqs_queue.jobs"]);
    expect(liveOf(work).find((l) => l.id === "q-jobs")?.estate).toBe("mono");

    approve(work, "carve-jobs", rec.digest, T(2));
    const second = await runMigrations(work, { binary: "choudoufu", exec, env: {}, now: T(3), log: (l) => void lines.push(l) });
    expect(second.code).toBe(0);
    expect(second.records[0]).toMatchObject({ status: "applied", approved_by: "alice" });
    expect(second.records[0]!.roots.map((r) => r.verify?.changes)).toEqual([[], []]);
    expect(liveOf(work).find((l) => l.id === "q-jobs")?.estate).toBe("team");
    const done = JSON.parse(git(origin, "show", `chant/lifecycle:${MIGRATE_DONE}`).trim());
    expect(done).toMatchObject({ gate: "carve-jobs", result: "applied", change: "retag", retags: [{ address: "aws_sqs_queue.jobs", from_estate: "mono", to_estate: "team", live_id: "q-jobs" }] });
    expect(() => revertMigration("carve-jobs", JSON.stringify(done))).toThrow(/moves migration the other way/);
  });

  it("is refused after the approval when the resource the markers are on changed, and retags nothing", async () => {
    const { work } = retagRepo();
    const exec = choudoufu(work);
    const lines: string[] = [];
    const first = await runMigrations(work, { binary: "choudoufu", exec, env: {}, now: T(1), log: (l) => void lines.push(l) });
    approve(work, "carve-jobs", first.records[0]!.digest, T(2));
    // Another queue now carries the markers: the digest names q-jobs.
    setLive(work, [{ id: "q-other", estate: "mono", address: "aws_sqs_queue.jobs" }, { id: "q-keep", estate: "mono", address: "aws_sqs_queue.keep" }]);
    const again = await runMigrations(work, { binary: "choudoufu", exec, env: {}, now: T(3), log: (l) => void lines.push(l) });
    expect(again.code).toBe(4);
    expect(liveOf(work).find((l) => l.id === "q-other")?.estate).toBe("mono");
  });

  it("fails its proof when a root plans a change the retag does not remove", async () => {
    const { work } = retagRepo(["aws_sqs_queue.jobs", "aws_sqs_queue.extra"]);
    const lines: string[] = [];
    const run = await runMigrations(work, { binary: "choudoufu", exec: choudoufu(work), env: {}, now: T(1), log: (l) => void lines.push(l) });
    expect(run.code).toBe(1);
    expect(run.records[0]!.status).toBe("proof-failed");
    expect(run.records[0]!.roots.find((r) => r.root === "team")?.proof.changes).toEqual(["aws_sqs_queue.extra: create"]);
    expect(lines.join("\n")).toContain("team would still change; nothing was written");
  });

  it("is refused when the estate it leaves holds no such resource, or the binary is not choudoufu, or one root keeps a state", async () => {
    const { work } = retagRepo();
    const m = (text: string) => parseMigration("migrations/x.yml", text);
    await expect(planMigration(work, m("moves:\n  - from: mono\n    to: team\n    addresses: [aws_sqs_queue.nope]\n"), { binary: "choudoufu", exec: choudoufu(work), env: {}, work: tmp() })).rejects.toThrow(/does not destroy it/);
    await expect(planMigration(work, m("moves:\n  - from: mono\n    to: team\n    addresses: [aws_sqs_queue.jobs]\n"), { binary: "tofu", exec: choudoufu(work), env: {}, work: tmp() })).rejects.toThrow(/only choudoufu reads/);
    write(work, { "stock/main.tf": 'terraform {\n  backend "local" {}\n}\n' });
    await expect(planMigration(work, m("moves:\n  - from: stock\n    to: team\n    addresses: [aws_sqs_queue.jobs]\n"), { binary: "choudoufu", exec: choudoufu(work), env: {}, work: tmp() })).rejects.toThrow(/adopt the state into an estate/);
  });
});

/** Root app's code names estate app; its old state is old.tfstate, a local file, holding two queues the account has, unmarked. */
const adoptRepo = (ids = ["q-a", "q-b"]) =>
  repo({
    "live.json": JSON.stringify([{ id: "q-a" }, { id: "q-b" }]),
    "app/main.tf": `${liveBlock("app")}resource "aws_sqs_queue" "a" {}\nresource "aws_sqs_queue" "b" {}\n`,
    "app/want.json": JSON.stringify(["aws_sqs_queue.a", "aws_sqs_queue.b"]),
    "app/old.tfstate": JSON.stringify({ version: 4, serial: 3, lineage: "L", resources: ids.map((id, i) => ({ mode: "managed", type: "aws_sqs_queue", name: "ab"[i], instances: [{ attributes: { id } }] })) }),
    "migrations/adopt-app.yml": "backends:\n  - root: app\n    from:\n      backend: local\n      config:\n        path: old.tfstate\n",
  });

describe("adopting a state into an estate", () => {
  it("verifies every resource, waits for the digest, stamps the markers, plans no change after, and leaves the old state as it was", async () => {
    const { work } = adoptRepo();
    const exec = choudoufu(work);
    const lines: string[] = [];
    const was = readFileSync(join(work, "app", "old.tfstate"), "utf-8");
    const first = await runMigrations(work, { binary: "choudoufu", exec, env: {}, now: T(1), log: (l) => void lines.push(l) });
    expect(first.code).toBe(3);
    const rec = first.records[0]!;
    expect(rec).toMatchObject({ change: "adopt", status: "waiting", backends: [{ root: "app", from: "old.tfstate" }] });
    expect(rec.stamps?.map((s) => [s.address, s.status, s.live_id])).toEqual([["aws_sqs_queue.a", "VERIFIED", "q-a"], ["aws_sqs_queue.b", "VERIFIED", "q-b"]]);
    expect(rec.roots[0]!.source).toMatchObject({ backend: "local", location: "old.tfstate" });
    expect(liveOf(work).every((l) => l.estate === undefined)).toBe(true);
    expect(lines.join("\n")).toContain("adopting the state of app from its local backend into the estate its code names");

    approve(work, "adopt-app", rec.digest, T(2));
    const second = await runMigrations(work, { binary: "choudoufu", exec, env: {}, now: T(3), log: (l) => void lines.push(l) });
    expect(second.code).toBe(0);
    expect(second.records[0]!.roots[0]!.verify?.changes).toEqual([]);
    expect(liveOf(work)).toEqual([{ id: "q-a", estate: "app", address: "aws_sqs_queue.a" }, { id: "q-b", estate: "app", address: "aws_sqs_queue.b" }]);
    expect(readFileSync(join(work, "app", "old.tfstate"), "utf-8")).toBe(was);
  });

  it("fails its proof when a resource of the state is missing from the live system", async () => {
    const { work } = adoptRepo(["q-a", "q-gone"]);
    const run = await runMigrations(work, { binary: "choudoufu", exec: choudoufu(work), env: {}, now: T(1), log: () => {} });
    expect(run.code).toBe(1);
    expect(run.records[0]!.roots[0]!.proof.changes).toEqual(["aws_sqs_queue.b: missing", "aws_sqs_queue.b: create"]);
  });

  it("is refused when the old state moved after the approval, and stamps nothing", async () => {
    const { work } = adoptRepo();
    const exec = choudoufu(work);
    const first = await runMigrations(work, { binary: "choudoufu", exec, env: {}, now: T(1), log: () => {} });
    approve(work, "adopt-app", first.records[0]!.digest, T(2));
    const path = join(work, "app", "old.tfstate");
    writeFileSync(path, readFileSync(path, "utf-8").replace('"serial":3', '"serial":4'));
    const again = await runMigrations(work, { binary: "choudoufu", exec, env: {}, now: T(3), log: () => {} });
    expect(again.code).toBe(4);
    expect(liveOf(work).every((l) => l.estate === undefined)).toBe(true);
  });

  it("fails after the write when the stamp left the plan changing, and says so", async () => {
    const { work } = adoptRepo();
    const base = choudoufu(work);
    // A live-import that verifies but writes nothing, as when -approve never reaches it.
    const exec: BinaryExec = (b, args, dir, env) => base(b, args.filter((a) => a !== "-approve"), dir, env);
    const first = await runMigrations(work, { binary: "choudoufu", exec, env: {}, now: T(1), log: () => {} });
    approve(work, "adopt-app", first.records[0]!.digest, T(2));
    const again = await runMigrations(work, { binary: "choudoufu", exec, env: {}, now: T(3), log: () => {} });
    expect(again.code).toBe(1);
    expect(again.records[0]!.error).toMatch(/printed no stamp report/);
  });
});

describe("what choudoufu prints", () => {
  it("reads live-import's ratification by status, and the failures of its stamp", () => {
    const text = [
      "",
      'Ratifying old.tfstate for estate "e1" against the live system. This was read-only: nothing was written.',
      "",
      "VERIFIED (1) - verified against the live system:",
      "  aws_sqs_queue.k                            aws_sqs_queue            live id: https://sqs.us-east-1.amazonaws.com/000000000000/q-keep",
      "    The live object matches the state's recorded attributes.",
      "",
      "UNTAGGABLE (1) - outside the taggable subset:",
      "  aws_iam_role_policy.inline                 aws_iam_role_policy      live id: -",
      "    Composes its identity from the role.",
      "",
      "1 of 2 resource instance(s) are eligible for stamping (VERIFIED or DRIFTED).",
    ].join("\n");
    expect(parseRatification(text)).toEqual([
      { address: "aws_sqs_queue.k", type: "aws_sqs_queue", status: "VERIFIED", live_id: "https://sqs.us-east-1.amazonaws.com/000000000000/q-keep" },
      { address: "aws_iam_role_policy.inline", type: "aws_iam_role_policy", status: "UNTAGGABLE" },
    ]);
    expect(stampFailures("2 resource(s) newly stamped, 0 already stamped, 0 newly recorded, 0 re-recorded for sensitivity only, 0 already recorded, 1 failed, 0 skipped.")).toBe(1);
    expect(stampFailures("nothing")).toBeUndefined();
    expect([isChoudoufu("choudoufu"), isChoudoufu("/usr/local/bin/choudoufu"), isChoudoufu("tofu")]).toEqual([true, true, false]);
  });
});
