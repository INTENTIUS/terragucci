import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendLifecycle } from "../src/apply";
import { ConfigError } from "../src/config";
import type { Fetch } from "../src/forge";
import { ledgerEntries, parseLedgerLog, UNLOCK_DONE_FILE } from "../src/report/audit";
import type { S3Fetch } from "../src/report/s3";
import { liveRuns, lockDigest, parseLockInfo, parseUnlocks, possibleHolders, UNLOCK_DONE, UNLOCK_LEDGER, unlockState, type UnlockOptions } from "../src/unlock";
import { tmp, write } from "./helpers";

const T = (m: number): string => new Date(Date.UTC(2026, 9, 9, 12, m)).toISOString();
const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf-8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
const ENV = { AWS_ACCESS_KEY_ID: "AK", AWS_SECRET_ACCESS_KEY: "SK", AWS_REGION: "us-east-1", AWS_ENDPOINT_URL: "http://s3.test", FORGEJO_TOKEN: "tok", USER: "someone" };
const KEY = "state/app.tfstate.tflock";
const LOCATION = "s3://state/app.tfstate.tflock";
const lockText = (id: string, created: string) => JSON.stringify({ ID: id, Operation: "OperationTypeApply", Info: "", Who: "runner@job-1", Version: "1.13.1", Created: created, Path: "state/app.tfstate" });

describe("parseLockInfo", () => {
  it("reads the lock the binary writes, and nothing without an ID", () => {
    expect(parseLockInfo(lockText("abc", T(1)))).toMatchObject({ ID: "abc", Operation: "OperationTypeApply", Who: "runner@job-1", Created: T(1) });
    expect(parseLockInfo("{}")).toBeUndefined();
    expect(parseLockInfo('{"ID": ""}')).toBeUndefined();
    expect(parseLockInfo("not json")).toBeUndefined();
  });

  it("binds the digest to the root, the lock's location and its ID", () => {
    const d = lockDigest("app", LOCATION, "abc");
    expect(d).toMatch(/^jcs1-sha256:[0-9a-f]{64}$/);
    expect(lockDigest("app", LOCATION, "abc")).toBe(d);
    expect(lockDigest("app", LOCATION, "abd")).not.toBe(d);
    expect(lockDigest("web", LOCATION, "abc")).not.toBe(d);
  });
});

describe("possibleHolders", () => {
  const runs = [
    { id: "1", status: "running", started: T(0) },
    { id: "2", status: "running", started: T(10) },
    { id: "3", status: "waiting" },
  ];
  it("keeps the runs that began before the lock, give or take the skew, and any with no start", () => {
    expect(possibleHolders(runs, T(5)).map((r) => r.id)).toEqual(["1", "3"]);
    expect(possibleHolders(runs, T(9)).map((r) => r.id)).toEqual(["1", "2", "3"]);
    expect(possibleHolders(runs, T(9), 0).map((r) => r.id)).toEqual(["1", "3"]);
  });
  it("keeps every run when the lock says not when it was taken", () => {
    expect(possibleHolders(runs, undefined)).toHaveLength(3);
    expect(possibleHolders(runs, "yesterday")).toHaveLength(3);
  });
});

/** A forge answering its run listings from `runs` by status, recording each URL asked. */
function forge(runs: Array<Record<string, unknown>>, failing = false) {
  const asked: string[] = [];
  const fetch: Fetch = async (url) => {
    asked.push(url);
    if (failing) return { ok: false, status: 502, json: async () => ({}), text: async () => "bad gateway" };
    const status = new URL(url).searchParams.get("status");
    const rows = runs.filter((r) => r.status === status);
    const body = url.includes("/pipelines") ? rows : { workflow_runs: rows, total_count: rows.length };
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  };
  return { fetch, asked };
}

describe("liveRuns", () => {
  it("lists Forgejo's running, waiting and blocked runs, with when each began", async () => {
    const f = forge([
      { id: 7, status: "running", started: T(2), created: T(1), html_url: "http://forge/o/r/actions/runs/7" },
      { id: 8, status: "waiting", started: "1970-01-01T00:00:00Z", created: T(3) },
      { id: 9, status: "success", started: T(0) },
    ]);
    const runs = await liveRuns(f.fetch, { forge: "forgejo", origin: "http://forge", path: "o/r", token: "t" });
    expect(runs).toEqual([
      { id: "7", status: "running", started: T(2), url: "http://forge/o/r/actions/runs/7" },
      { id: "8", status: "waiting", started: T(3), url: undefined },
    ]);
    expect(f.asked.every((u) => u.startsWith("http://forge/api/v1/repos/o/r/actions/runs?status="))).toBe(true);
  });

  it("lists GitHub's runs in progress or queued, and GitLab's running and pending pipelines", async () => {
    const gh = forge([{ id: 1, status: "in_progress", run_started_at: T(1) }, { id: 2, status: "completed" }]);
    expect(await liveRuns(gh.fetch, { forge: "github", origin: "https://github.com", path: "o/r", token: "t" })).toEqual([{ id: "1", status: "in_progress", started: T(1), url: undefined }]);
    expect(gh.asked[0]).toBe("https://api.github.com/repos/o/r/actions/runs?status=in_progress&per_page=100");
    const gl = forge([{ id: 5, status: "pending", created_at: T(4), web_url: "https://gl/p/-/pipelines/5" }]);
    expect(await liveRuns(gl.fetch, { forge: "gitlab", origin: "https://gl", path: "g/p", token: "t" })).toEqual([{ id: "5", status: "pending", started: T(4), url: "https://gl/p/-/pipelines/5" }]);
    expect(gl.asked[0]).toBe("https://gl/api/v4/projects/g%2Fp/pipelines?status=running&per_page=100");
  });
});

/** The bucket's lock files in memory. */
function bucket() {
  const objects = new Map<string, string>();
  const fetch: S3Fetch = async (url, init) => {
    const u = new URL(url);
    const key = decodeURIComponent(u.pathname.slice(1));
    const ok = (status = 200, body = "") => ({ ok: status < 300, status, text: async () => body, headers: { get: () => null } });
    if (init.method === "DELETE") {
      objects.delete(key);
      return ok(204);
    }
    const body = objects.get(key);
    if (body === undefined) return ok(404);
    return ok(200, init.method === "HEAD" ? "" : body);
  };
  return { objects, fetch };
}

/** A repo with one root on an s3 backend, a bare origin for chant/lifecycle, and a binary whose init records the backend and whose force-unlock removes the lock of that ID. */
function world(backend: Record<string, unknown> = { bucket: "state", key: "app.tfstate", region: "us-east-1", use_lockfile: true, endpoints: { s3: "http://s3.test" } }) {
  const dir = tmp("tg-unlock-");
  const origin = join(dir, "origin.git");
  git(dir, "init", "-q", "--bare", origin);
  const work = join(dir, "work");
  mkdirSync(work);
  write(work, { "app/main.tf": 'resource "terraform_data" "x" {}\n', "terragucci.yml": "binary: tofu\nforge: forgejo\nurl: http://forge.test/o/r\n" });
  git(work, "init", "-q", "-b", "main");
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", "base");
  git(work, "remote", "add", "origin", origin);
  git(work, "push", "-q", "origin", "main");
  const b = bucket();
  const calls: string[][] = [];
  const exec: NonNullable<UnlockOptions["exec"]> = (_bin, args, d) => {
    calls.push(args);
    if (args[0] === "init") {
      mkdirSync(join(d, ".terraform"), { recursive: true });
      writeFileSync(join(d, ".terraform", "terraform.tfstate"), JSON.stringify({ version: 3, backend: { type: backend.type ?? "s3", config: backend } }));
      return { status: 0, out: "" };
    }
    if (args[0] === "force-unlock") {
      const id = args[args.length - 1]!;
      const held = parseLockInfo(b.objects.get(KEY) ?? "");
      if (held?.ID !== id) return { status: 1, out: `lock ID ${id} does not match` };
      b.objects.delete(KEY);
      return { status: 0, out: "OpenTofu state has been successfully unlocked!" };
    }
    return { status: 1, out: `unknown ${args.join(" ")}` };
  };
  return { work, origin, bucket: b, exec, calls };
}

const run = (w: ReturnType<typeof world>, f: ReturnType<typeof forge>, extra: Partial<UnlockOptions> = {}) => {
  const lines: string[] = [];
  return unlockState(w.work, "app", { env: ENV, exec: w.exec, s3Fetch: w.bucket.fetch, fetch: f.fetch, log: (l) => lines.push(l), actor: "dana", ...extra }).then((r) => ({ ...r, lines }));
};

const approve = (work: string, digest: string, at: string, by = "lee") =>
  appendLifecycle(work, UNLOCK_LEDGER, [JSON.stringify({ version: 1, kind: "resolution", op: "tf-unlock", gate: "app", resolvedBy: by, timestamp: at, planDigest: digest })], {}, "approve");

const lifecycle = (origin: string, path: string): string => {
  try {
    return execFileSync("git", ["--git-dir", origin, "show", `chant/lifecycle:${path}`], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return "";
  }
};

describe("unlockState", () => {
  it("says there is nothing to release when no lock is held", async () => {
    const w = world();
    const r = await run(w, forge([]));
    expect(r.code).toBe(0);
    expect(r.lines.join("\n")).toContain("no lock is held on s3://state/app.tfstate.tflock");
    expect(lifecycle(w.origin, UNLOCK_LEDGER)).toBe("");
  });

  it("refuses while a run that began before the lock is alive, and records nothing", async () => {
    const w = world();
    w.bucket.objects.set(KEY, lockText("lock-1", T(10)));
    const r = await run(w, forge([{ id: 41, status: "running", started: T(5), html_url: "http://forge.test/o/r/actions/runs/41" }]));
    expect(r.code).toBe(1);
    expect(r.alive?.map((a) => a.id)).toEqual(["41"]);
    expect(r.lines.join("\n")).toContain("run 41 (running, began");
    expect(w.bucket.objects.has(KEY)).toBe(true);
    expect(w.calls.some((c) => c[0] === "force-unlock")).toBe(false);
    expect(lifecycle(w.origin, UNLOCK_LEDGER)).toBe("");
  });

  it("waits for an approval of the lock's ID, then releases it and records who released what", async () => {
    const w = world();
    w.bucket.objects.set(KEY, lockText("lock-1", T(10)));
    // A run that began after the lock is waiting on it, not holding it.
    const f = forge([{ id: 42, status: "running", started: T(20) }]);
    const first = await run(w, f, { now: T(30) });
    expect(first.code).toBe(3);
    const digest = lockDigest("app", LOCATION, "lock-1");
    expect(first.command).toBe(`chant approve tf-unlock app --plan ${digest}`);
    expect(w.bucket.objects.has(KEY)).toBe(true);
    const pending = JSON.parse(lifecycle(w.origin, UNLOCK_LEDGER).trim());
    expect(pending).toMatchObject({ kind: "pending", op: "tf-unlock", gate: "app", planDigest: digest, neverOverMcp: true });
    expect(pending.description).toContain("lock-1");

    // Run again with no approval: still waiting, and the pending fact is not written twice.
    expect((await run(w, f, { now: T(31) })).code).toBe(3);
    expect(lifecycle(w.origin, UNLOCK_LEDGER).trim().split("\n")).toHaveLength(1);

    approve(w.work, digest, T(32));
    const done = await run(w, f, { now: T(33) });
    expect(done.code).toBe(0);
    expect(w.bucket.objects.has(KEY)).toBe(false);
    expect(w.calls.find((c) => c[0] === "force-unlock")).toEqual(["force-unlock", "-force", "-no-color", "lock-1"]);
    const [record] = parseUnlocks(lifecycle(w.origin, UNLOCK_DONE));
    expect(record).toMatchObject({ kind: "unlock", gate: "app", root: "app", location: LOCATION, planDigest: digest, approvedBy: "lee", releasedBy: "dana", liveRuns: 1, lock: { ID: "lock-1", Who: "runner@job-1", Created: T(10) } });

    // The audit trail reads the release from the ledger's history.
    const log = execFileSync("git", ["--git-dir", w.origin, "log", "--reverse", "--format=%x1e%H%x1f%an%x1f%aI", "-p", "--unified=0", "chant/lifecycle", "--", UNLOCK_DONE_FILE], { encoding: "utf-8" });
    const [entry] = ledgerEntries("forge.test/o/r", UNLOCK_DONE_FILE, parseLedgerLog(log));
    expect(entry).toMatchObject({ kind: "unlock", what: "app", who: "dana", digest, result: "released", detail: { lock_id: "lock-1", locked_by: "runner@job-1", approved_by: "lee", location: LOCATION } });
  });

  it("checks the runs again after the approval", async () => {
    const w = world();
    w.bucket.objects.set(KEY, lockText("lock-1", T(10)));
    const digest = lockDigest("app", LOCATION, "lock-1");
    expect((await run(w, forge([]), { now: T(30) })).code).toBe(3);
    approve(w.work, digest, T(32));
    // The forge now lists a run that began before the lock: one a runner picked up again.
    const r = await run(w, forge([{ id: 43, status: "running", started: T(9) }]), { now: T(33) });
    expect(r.code).toBe(1);
    expect(w.bucket.objects.has(KEY)).toBe(true);
    expect(lifecycle(w.origin, UNLOCK_DONE)).toBe("");
  });

  it("refuses an approval of another lock", async () => {
    const w = world();
    w.bucket.objects.set(KEY, lockText("lock-1", T(10)));
    expect((await run(w, forge([]), { now: T(30) })).code).toBe(3);
    approve(w.work, lockDigest("app", LOCATION, "lock-1"), T(32));
    // The lock was released by other means and a new one taken since.
    w.bucket.objects.set(KEY, lockText("lock-2", T(40)));
    const r = await run(w, forge([]), { now: T(41) });
    expect(r.code).toBe(4);
    expect(r.lines.join("\n")).toContain("the release of another lock");
    expect(w.bucket.objects.get(KEY)).toContain("lock-2");
  });

  it("fails closed without a forge token, or when the forge cannot be read", async () => {
    const w = world();
    w.bucket.objects.set(KEY, lockText("lock-1", T(10)));
    await expect(run(w, forge([]), { env: { ...ENV, FORGEJO_TOKEN: "" } })).rejects.toThrow(/FORGEJO_TOKEN is not set/);
    await expect(run(w, forge([], true))).rejects.toThrow(/runs could not be read/);
    expect(w.bucket.objects.has(KEY)).toBe(true);
  });

  it("refuses a backend whose lock file it cannot read", async () => {
    await expect(run(world({ type: "local", path: "terraform.tfstate" }), forge([]))).rejects.toThrow(/local file/);
    await expect(run(world({ bucket: "state", key: "app.tfstate", dynamodb_table: "locks", endpoints: { s3: "http://s3.test" } }), forge([]))).rejects.toThrow(/takes no lock file/);
    await expect(run(world({ type: "gcs", bucket: "b" }), forge([]))).rejects.toThrow(ConfigError);
  });

  it("refuses a path that is not a root", async () => {
    const w = world();
    await expect(unlockState(w.work, "../elsewhere", { env: ENV, exec: w.exec })).rejects.toThrow(/not a root/);
    await expect(unlockState(w.work, "missing", { env: ENV, exec: w.exec })).rejects.toThrow(/not a root/);
  });
});
