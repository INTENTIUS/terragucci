import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendLifecycle } from "../src/apply";
import { MIGRATE_DONE, MIGRATE_LEDGER, parseMigration, pendingEstateMigrations, planMigration, revertMigration, runMigrations, type BinaryExec } from "../src/migrate";
import { isChoudoufu, parseRatification, stampFailures } from "../src/migrate-estate";
import { runStage } from "../src/report/stage";
import { renderNote } from "../src/report/views";
import { tmp, validate, write } from "./helpers";
import { plan as planJson, rc } from "./report-fixtures";

const T = (m: number): string => new Date(Date.UTC(2026, 9, 9, 12, m)).toISOString();
const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf-8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });

// ── a simulated choudoufu over a simulated live system ──────────────────
// live.json at the top of the repo is the account: each resource's id and
// its two markers. A root's want.json lists the addresses its code declares,
// and its live block names its estate. A plan creates what the root declares
// and its estate does not own, and destroys what it owns and does not
// declare. live-mv rewrites the markers of the resource the source estate
// holds under the address; live-import verifies each resource of a state by
// its id and, with -approve, stamps it. With `refuseUnmarked`, plan refuses
// while a live object carries no marker, and with `refuseForeign` while a
// resource the root declares is live under another estate's marker, as
// choudoufu does when such an object sits at a resource's identity.

interface Live {
  id: string;
  estate?: string;
  address?: string;
}
type Calls = string[];

const liveOf = (repo: string): Live[] => JSON.parse(readFileSync(join(repo, "live.json"), "utf-8")) as Live[];
const setLive = (repo: string, l: Live[]) => writeFileSync(join(repo, "live.json"), JSON.stringify(l));

function choudoufu(repo: string, calls: Calls = [], opts: { refuseUnmarked?: boolean; refuseForeign?: boolean } = {}): BinaryExec {
  return async (_binary, args, dir) => {
    calls.push(`${dir.slice(repo.length + 1)}: ${args.join(" ")}`);
    const ok = (stdout = "", out = stdout) => ({ code: 0, stdout, out });
    const estate = /estate\s*=\s*"([^"]+)"/.exec(readFileSync(join(dir, "main.tf"), "utf-8"))?.[1];
    const want = (): string[] => JSON.parse(readFileSync(join(dir, "want.json"), "utf-8")) as string[];
    if (args[0] === "init") return args.includes("-reconfigure") ? { code: 1, stdout: "", out: "Backend migration is not available under live resource markers" } : ok();
    if (args[0] === "plan") {
      const unmarked = liveOf(repo).find((l) => l.estate === undefined);
      if (opts.refuseUnmarked && unmarked) return { code: 1, stdout: "", out: `Error: a live aws_sqs_queue exists at ${unmarked.id} and does not carry estate "${estate}"'s ownership marker` };
      const foreign = liveOf(repo).find((l) => l.estate !== undefined && l.estate !== estate && want().includes(l.address!));
      if (opts.refuseForeign && foreign) return { code: 1, stdout: "", out: `Error: a live aws_sqs_queue exists at ${foreign.id} and does not carry estate "${estate}"'s ownership marker` };
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
const retagRepo = (teamWants = ["aws_sqs_queue.jobs"], monoWants = ["aws_sqs_queue.keep"]) =>
  repo({
    "live.json": JSON.stringify([
      { id: "q-jobs", estate: "mono", address: "aws_sqs_queue.jobs" },
      { id: "q-keep", estate: "mono", address: "aws_sqs_queue.keep" },
    ]),
    "mono/main.tf": `${liveBlock("mono")}resource "aws_sqs_queue" "keep" {}\n`,
    "mono/want.json": JSON.stringify(monoWants),
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
    expect(lines.join("\n")).toContain("live-mv -dry-run finds each resource that moves, and every change a root it leaves plans is one the retag removes; digest");
    // team, which the queue joins, is not planned before the retag; mono, which it leaves, is.
    expect(calls.filter((c) => c.startsWith("team: plan"))).toEqual([]);
    expect(calls.filter((c) => c.startsWith("mono: plan"))).toHaveLength(1);
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

  it("fails its proof when the root resources leave plans a change the retag does not remove", async () => {
    const { work } = retagRepo(undefined, ["aws_sqs_queue.keep", "aws_sqs_queue.extra"]);
    const lines: string[] = [];
    const run = await runMigrations(work, { binary: "choudoufu", exec: choudoufu(work), env: {}, now: T(1), log: (l) => void lines.push(l) });
    expect(run.code).toBe(1);
    expect(run.records[0]!.status).toBe("proof-failed");
    expect(run.records[0]!.roots.find((r) => r.root === "mono")?.proof.changes).toEqual(["aws_sqs_queue.extra: create"]);
    expect(lines.join("\n")).toContain("mono would still change; nothing was written");
  });

  it("is proved by the dry runs when choudoufu refuses to plan the joining root before the retag, and plans it once retagged", async () => {
    const { work } = retagRepo();
    const calls: Calls = [];
    const exec = choudoufu(work, calls, { refuseForeign: true });
    const lines: string[] = [];
    expect([...pendingEstateMigrations(work)]).toEqual([["team", { name: "carve-jobs", file_digest: expect.stringMatching(/^sha256:/), change: "retag" }]]);
    const first = await runMigrations(work, { binary: "choudoufu", exec, env: {}, now: T(1), log: (l) => void lines.push(l) });
    expect(first.code).toBe(3);
    const rec = first.records[0]!;
    expect(rec).toMatchObject({ change: "retag", status: "waiting", retags: [{ address: "aws_sqs_queue.jobs", live_id: "q-jobs" }] });
    expect(rec.roots.find((r) => r.root === "team")!.proof).toEqual({ changes: [], summary: "live-mv -dry-run: 1 resource found in the estate it leaves" });
    expect(calls.filter((c) => c.startsWith("team: plan"))).toEqual([]);
    expect(lines.join("\n")).toContain("team: not planned before the retag; live-mv -dry-run found the resource that joins it");

    approve(work, "carve-jobs", rec.digest, T(2));
    calls.length = 0;
    const second = await runMigrations(work, { binary: "choudoufu", exec, env: {}, now: T(3), log: (l) => void lines.push(l) });
    expect(second.code).toBe(0);
    expect(second.records[0]).toMatchObject({ status: "applied" });
    expect(second.records[0]!.roots.map((r) => [r.root, r.verify?.changes])).toEqual([["mono", []], ["team", []]]);
    // The write comes first, then team's first plan.
    const write = calls.findIndex((c) => c.startsWith("team: live-mv") && !c.includes("-dry-run"));
    expect(write).toBeGreaterThanOrEqual(0);
    expect(calls.findIndex((c) => c.startsWith("team: plan"))).toBeGreaterThan(write);
    expect(pendingEstateMigrations(work).size).toBe(0);
  });

  it("is stopped by a refused dry run, and retags nothing", async () => {
    const { work } = retagRepo();
    const calls: Calls = [];
    const base = choudoufu(work, calls, { refuseForeign: true });
    // choudoufu's preview refuses the retag, as it does for a resource whose markers it cannot read.
    const exec: BinaryExec = async (b, args, dir, env) =>
      args[0] === "live-mv" && args.includes("-dry-run")
        ? { code: 1, stdout: JSON.stringify({ dry_run: true, written: false, refusal: { code: "markers", summary: "the tofu-address marker of aws_sqs_queue.jobs cannot be read" } }), out: "refused" }
        : base(b, args, dir, env);
    const lines: string[] = [];
    const run = await runMigrations(work, { binary: "choudoufu", exec, env: {}, now: T(1), log: (l) => void lines.push(l) });
    expect(run.code).toBe(1);
    expect(run.records[0]).toMatchObject({ status: "failed" });
    expect(run.records[0]!.error).toContain("live-mv -dry-run refuses aws_sqs_queue.jobs: the tofu-address marker of aws_sqs_queue.jobs cannot be read");
    expect(lines.join("\n")).toContain("nothing was written");
    expect(calls.some((c) => c.includes("live-mv") && !c.includes("-dry-run"))).toBe(false);
    expect(liveOf(work).find((l) => l.id === "q-jobs")?.estate).toBe("mono");
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
    expect(run.records[0]!.roots[0]!.proof.changes).toEqual(["aws_sqs_queue.b: missing"]);
  });

  it("is proved by the ratification alone when choudoufu refuses to plan the root before the stamp, and plans it once stamped", async () => {
    const { work } = adoptRepo();
    const calls: Calls = [];
    const exec = choudoufu(work, calls, { refuseUnmarked: true });
    const lines: string[] = [];
    expect([...pendingEstateMigrations(work)]).toEqual([["app", { name: "adopt-app", file_digest: expect.stringMatching(/^sha256:/), change: "adopt" }]]);
    const first = await runMigrations(work, { binary: "choudoufu", exec, env: {}, now: T(1), log: (l) => void lines.push(l) });
    expect(first.code).toBe(3);
    const rec = first.records[0]!;
    expect(rec).toMatchObject({ change: "adopt", status: "waiting" });
    expect(rec.roots[0]!.proof).toEqual({ changes: [], summary: "live-import: 2 of 2 resource instances verified" });
    // No plan before the write: the only calls are init and live-import's preview.
    expect(calls.filter((c) => c.startsWith("app: plan"))).toEqual([]);
    expect(calls.filter((c) => c.startsWith("app: live-import")).map((c) => c.includes("-approve"))).toEqual([false]);
    expect(lines.join("\n")).toContain("app: 2 of 2 resource instances in old.tfstate verify against the live system, so the stamp adopts each one");

    approve(work, "adopt-app", rec.digest, T(2));
    calls.length = 0;
    const second = await runMigrations(work, { binary: "choudoufu", exec, env: {}, now: T(3), log: (l) => void lines.push(l) });
    expect(second.code).toBe(0);
    expect(second.records[0]).toMatchObject({ status: "applied" });
    expect(second.records[0]!.roots[0]!.verify?.changes).toEqual([]);
    // The stamp comes first, then the root's first plan.
    const stamp = calls.findIndex((c) => c.startsWith("app: live-import") && c.includes("-approve"));
    const plan = calls.findIndex((c) => c.startsWith("app: plan"));
    expect(stamp).toBeGreaterThanOrEqual(0);
    expect(plan).toBeGreaterThan(stamp);
    // Applied, the root is no longer one a pending migration adopts.
    expect(pendingEstateMigrations(work).size).toBe(0);
  });

  it("still fails its proof on an instance that does not verify when choudoufu refuses to plan the root, and stamps nothing", async () => {
    const { work } = adoptRepo(["q-a", "q-gone"]);
    const calls: Calls = [];
    const lines: string[] = [];
    const run = await runMigrations(work, { binary: "choudoufu", exec: choudoufu(work, calls, { refuseUnmarked: true }), env: {}, now: T(1), log: (l) => void lines.push(l) });
    expect(run.code).toBe(1);
    expect(run.records[0]).toMatchObject({ status: "proof-failed" });
    expect(run.records[0]!.roots[0]!.proof.changes).toEqual(["aws_sqs_queue.b: missing"]);
    expect(lines.join("\n")).toContain("in app some do not; nothing was written");
    expect(calls.some((c) => c.includes("-approve"))).toBe(false);
    expect(liveOf(work).every((l) => l.estate === undefined)).toBe(true);
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

/**
 * A stand-in choudoufu for a pull request's plan: init passes, and plan
 * fails in a root holding an `unmarked` file, as choudoufu refuses while a
 * live object without the estate's marker sits at a resource's identity;
 * otherwise it copies the root's plan.json to the plan file.
 */
function planStandIn(dir: string): string {
  const path = join(dir, "choudoufu");
  writeFileSync(path, `#!/bin/sh
chdir="\${1#-chdir=}"; shift
case "$1" in
  init) exit 0 ;;
  state) echo '{"version":4,"resources":[],"outputs":{"a":{"value":1}}}'; exit 0 ;;
  plan)
    if [ -f "$chdir/unmarked" ]; then echo "Error: a live aws_sqs_queue exists and does not carry the estate's ownership marker" >&2; exit 1; fi
    for a in "$@"; do case "$a" in -out=*) cp "$chdir/plan.json" "\${a#-out=}" ;; esac; done
    echo "Plan: 1 to add, 0 to change, 0 to destroy."; exit 0 ;;
  show) if [ "$2" = "-json" ]; then cat "$3"; else echo "plan text for $chdir"; fi ;;
esac
`);
  chmodSync(path, 0o755);
  return path;
}

describe("a pull request's plan of a root a backends migration adopts", () => {
  const REPORT_SCHEMA = JSON.parse(readFileSync(join(import.meta.dirname, "../src/report/report.schema.json"), "utf-8"));
  const live = (e: string): string => `terraform {\n  live {\n    estate = "${e}"\n  }\n}\n`;
  const webPlan = planJson([rc("aws_sqs_queue.w", ["create"], null, { name: "w" })]);
  const adopting = (unmarked = true) =>
    write(tmp(), {
      "terragucci.yml": "binary: choudoufu\n",
      "app/main.tf": live("app") + 'resource "aws_sqs_queue" "a" {}\n',
      ...(unmarked ? { "app/unmarked": "" } : {}),
      "app/plan.json": JSON.stringify(planJson([])),
      "web/main.tf": live("web") + 'resource "aws_sqs_queue" "w" {}\n',
      "web/plan.json": JSON.stringify(webPlan),
      "migrations/adopt-app.yml": "backends:\n  - root: app\n    from:\n      backend: local\n      config:\n        path: old.tfstate\n",
    });
  const layers = [["app", "web"]];

  it("does not plan it on its own: the root is planned by the migration, not failed, and the other roots plan", async () => {
    const repo = adopting();
    const logs: string[] = [];
    const { report } = await runStage("tf-plan", repo, { binary: planStandIn(tmp()), layers, out: join(tmp(), "r"), env: { PATH: process.env.PATH } }, (l) => logs.push(l));
    expect(logs).toContain("app: planned by migration adopt-app");
    expect(logs.some((l) => l.startsWith("app: plan failed"))).toBe(false);
    expect(report.roots.map((r) => [r.path, r.status])).toEqual([["web", "planned"]]);
    expect(report.deferred).toEqual([{ unit: "app", after: [], why: expect.stringContaining("planned by migration adopt-app"), previewed: false }]);
    expect(validate(REPORT_SCHEMA, report)).toEqual([]);
    expect(renderNote(report)).toContain("- `app`: planned by migration adopt-app");
  });

  it("plans it as any other root once chant/lifecycle records the migration applied", async () => {
    // Stamped: the live objects carry the estate's markers, so choudoufu plans the root.
    const repo = adopting(false);
    git(repo, "init", "-q", "-b", "main");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "base");
    const lifecycle = write(tmp(), { [MIGRATE_DONE]: JSON.stringify({ version: 1, kind: "migration", op: "tf-migrate", gate: "adopt-app", timestamp: T(1), result: "applied" }) + "\n" });
    git(lifecycle, "init", "-q", "-b", "chant/lifecycle");
    git(lifecycle, "add", "-A");
    git(lifecycle, "commit", "-q", "-m", "done");
    git(repo, "fetch", "-q", lifecycle, "chant/lifecycle:refs/remotes/origin/chant/lifecycle");
    expect(pendingEstateMigrations(repo).size).toBe(0);
    const logs: string[] = [];
    const { report } = await runStage("tf-plan", repo, { binary: planStandIn(tmp()), layers, out: join(tmp(), "r"), env: { PATH: process.env.PATH } }, (l) => logs.push(l));
    expect(logs.some((l) => l.includes("planned by migration"))).toBe(false);
    expect(report.roots.map((r) => r.path)).toEqual(["app", "web"]);
    expect(report.deferred).toBeUndefined();
  });
});

describe("a pull request's plan of a root a moves migration retags resources into", () => {
  const live = (e: string): string => `terraform {\n  live {\n    estate = "${e}"\n  }\n}\n`;
  const monoPlan = planJson([rc("aws_sqs_queue.jobs", ["delete"], { name: "jobs" }, null)]);

  it("does not plan the joining root on its own: it is planned by the migration, and the root resources leave plans", async () => {
    const repo = write(tmp(), {
      "terragucci.yml": "binary: choudoufu\n",
      "mono/main.tf": live("mono") + 'resource "aws_sqs_queue" "keep" {}\n',
      "mono/plan.json": JSON.stringify(monoPlan),
      "team/main.tf": live("team") + 'resource "aws_sqs_queue" "jobs" {}\n',
      // The queue still carries mono's markers, so choudoufu refuses team's plan.
      "team/unmarked": "",
      "team/plan.json": JSON.stringify(planJson([])),
      "migrations/carve-jobs.yml": "moves:\n  - from: mono\n    to: team\n    addresses: [aws_sqs_queue.jobs]\n",
    });
    const logs: string[] = [];
    const { report } = await runStage("tf-plan", repo, { binary: planStandIn(tmp()), layers: [["mono", "team"]], out: join(tmp(), "r"), env: { PATH: process.env.PATH } }, (l) => logs.push(l));
    expect(logs).toContain("team: planned by migration carve-jobs");
    expect(logs.some((l) => l.startsWith("team: plan failed"))).toBe(false);
    expect(report.roots.map((r) => [r.path, r.status])).toEqual([["mono", "planned"]]);
    expect(report.deferred).toEqual([{ unit: "team", after: [], why: expect.stringContaining("live-mv -dry-run of each one is the proof"), previewed: false }]);
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
