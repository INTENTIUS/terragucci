import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendLifecycle } from "../src/apply";
import {
  applyMigration,
  backendBlock,
  MIGRATE_DONE,
  MIGRATE_LEDGER,
  OVERRIDE_FILE,
  parseMigration,
  planMigration,
  revertMigration,
  runMigrations,
  writeRevert,
  type BinaryExec,
  type StateFile,
  type StateResource,
} from "../src/migrate";
import { sign, type S3Fetch } from "../src/report/s3";
import { tmp, write } from "./helpers";

const T = (m: number): string => new Date(Date.UTC(2026, 9, 9, 12, m)).toISOString();
const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf-8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
const ENV = { AWS_ACCESS_KEY_ID: "AK", AWS_SECRET_ACCESS_KEY: "SK", AWS_REGION: "us-east-1", AWS_ENDPOINT_URL: "http://s3.test" };
const res = (name: string): StateResource => ({ mode: "managed", type: "terraform_data", name, provider: 'provider["terraform.io/builtin/terraform"]', instances: [{ attributes: { id: name, input: `secret-${name}` } }] });
const state = (lineage: string, serial: number, names: string[]): StateFile => ({ version: 4, terraform_version: "1.13.1", serial, lineage, outputs: {}, resources: names.map(res), check_results: null });

/**
 * A versioned S3 bucket in memory, and a binary that keeps each root's state
 * in it. A root's code names its backend in backend.json (bucket and key, or
 * a local path); init records that as `.terraform/terraform.tfstate` does, in
 * the data dir. With the migration's override file, the backend is the one
 * the override names. want.json lists the addresses the root's code declares.
 */
function world() {
  const versions = new Map<string, { id: string; body: string }[]>();
  let n = 0;
  const put = (key: string, body: string): string => {
    const id = `v${++n}`;
    versions.set(key, [...(versions.get(key) ?? []), { id, body }]);
    return id;
  };
  const latest = (key: string) => versions.get(key)?.at(-1);
  const locks = new Set<string>();
  const fetch: S3Fetch = async (url, init) => {
    const u = new URL(url);
    const [, bucket, ...rest] = u.pathname.split("/");
    const key = `${bucket}/${decodeURIComponent(rest.join("/"))}`;
    const ok = (status = 200, body = "", headers: Record<string, string> = {}) => ({ ok: status < 300, status, text: async () => body, headers: { get: (h: string) => headers[h.toLowerCase()] ?? null } });
    if (key.endsWith(".tflock")) {
      if (init.method === "PUT") {
        if (locks.has(key)) return ok(412);
        locks.add(key);
        return ok();
      }
      if (init.method === "DELETE") {
        locks.delete(key);
        return ok(204);
      }
      return ok(locks.has(key) ? 200 : 404, "{}");
    }
    const v = u.searchParams.get("versionId");
    if (init.method === "GET" && v) {
      const found = versions.get(key)?.find((x) => x.id === v);
      return found ? ok(200, found.body) : ok(404);
    }
    const last = latest(key);
    if (!last) return ok(404);
    return ok(200, init.method === "HEAD" ? "" : last.body, { "x-amz-version-id": last.id });
  };
  const backendOf = (dir: string, env: NodeJS.ProcessEnv): { type: string; config: Record<string, unknown> } => {
    const override = join(dir, OVERRIDE_FILE);
    if (env.TF_DATA_DIR && existsSync(override)) {
      const text = readFileSync(override, "utf-8");
      const type = /backend "(\w+)"/.exec(text)![1]!;
      const config: Record<string, unknown> = {};
      for (const m of text.matchAll(/^\s+(\w+) = (".*"|true|false)$/gm)) config[m[1]!] = JSON.parse(m[2]!);
      return { type, config };
    }
    return JSON.parse(readFileSync(join(dir, "backend.json"), "utf-8"));
  };
  const keyOf = (dir: string, b: { type: string; config: Record<string, unknown> }): { s3?: string; path?: string } =>
    b.type === "s3" ? { s3: `${b.config.bucket}/${b.config.key}` } : { path: isAbsolute(String(b.config.path ?? "terraform.tfstate")) ? String(b.config.path) : join(dir, String(b.config.path ?? "terraform.tfstate")) };
  const read = (where: { s3?: string; path?: string }): string | undefined => (where.s3 ? latest(where.s3)?.body : existsSync(where.path!) ? readFileSync(where.path!, "utf-8") : undefined);
  const exec: BinaryExec = async (_b, args, dir, env) => {
    const done = (stdout = "", out = stdout) => ({ code: 0, stdout, out });
    const backend = backendOf(dir, env);
    const where = keyOf(dir, backend);
    if (args[0] === "init") {
      const data = env.TF_DATA_DIR ? (isAbsolute(env.TF_DATA_DIR) ? env.TF_DATA_DIR : join(dir, env.TF_DATA_DIR)) : join(dir, ".terraform");
      mkdirSync(data, { recursive: true });
      const config = backend.type === "s3" ? { ...backend.config, region: "us-east-1", use_lockfile: true, endpoints: { s3: "http://s3.test" } } : backend.config;
      writeFileSync(join(data, "terraform.tfstate"), JSON.stringify({ version: 3, backend: { type: backend.type, config } }));
      return done();
    }
    if (args[0] === "state" && args[1] === "pull") return done(read(where) ?? JSON.stringify(state("", 0, [])));
    if (args[0] === "state" && args[1] === "push") {
      const body = readFileSync(args[args.length - 1]!, "utf-8");
      if (where.s3) put(where.s3, body);
      else writeFileSync(where.path!, body);
      return done();
    }
    if (args[0] === "plan") {
      const text = read(where);
      const held = text ? (JSON.parse(text) as StateFile).resources.map((r) => `${r.type}.${r.name}`) : [];
      const want = JSON.parse(readFileSync(join(dir, "want.json"), "utf-8")) as string[];
      const changes = [...want.filter((a) => !held.includes(a)).map((a) => ({ address: a, change: { actions: ["create"] } })), ...held.filter((a) => !want.includes(a)).map((a) => ({ address: a, change: { actions: ["delete"] } }))];
      writeFileSync(args.find((a) => a.startsWith("-out="))!.slice(5), JSON.stringify({ resource_changes: changes }));
      return done(changes.length ? `Plan: ${changes.length} to change.` : "No changes. Your infrastructure matches the configuration.");
    }
    if (args[0] === "show") return done(readFileSync(args[2]!, "utf-8"));
    return { code: 1, stdout: "", out: `unknown ${args.join(" ")}` };
  };
  return { versions, put, latest, locks, fetch, exec };
}

/** A git repo with `files`, two commits so the base exists, and a bare origin for chant/lifecycle. */
function repo(files: Record<string, string>, change: Record<string, string>) {
  const dir = tmp("tg-migrate-s3-");
  const origin = join(dir, "origin.git");
  git(dir, "init", "-q", "--bare", origin);
  const work = join(dir, "work");
  mkdirSync(work);
  write(work, files);
  git(work, "init", "-q", "-b", "main");
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", "base");
  write(work, change);
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", "change");
  git(work, "remote", "add", "origin", origin);
  git(work, "push", "-q", "origin", "main");
  return { work, origin };
}

const s3 = (key: string) => JSON.stringify({ type: "s3", config: { bucket: "state", key } });
const approve = (work: string, gate: string, digest: string, at: string) =>
  appendLifecycle(work, MIGRATE_LEDGER, [JSON.stringify({ version: 1, kind: "resolution", op: "tf-migrate", gate, resolvedBy: "alice", timestamp: at, planDigest: digest })], {}, "approve");

describe("S3 signing of a request with a query", () => {
  it("signs the canonical query, as AWS's GET Bucket example with max-keys and prefix gives", () => {
    const h = sign({ region: "us-east-1", accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" }, "GET", "https://examplebucket.s3.amazonaws.com/?max-keys=2&prefix=J", {}, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", new Date("2013-05-24T00:00:00Z"));
    expect(h.authorization).toContain("Signature=34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7");
  });
});

describe("a backend move", () => {
  const file = "backends:\n  - root: app\n    from:\n      backend: s3\n      config:\n        bucket: state\n        key: old/app.tfstate\n        use_lockfile: true\n";

  it("parses the root and the backend it moves from, and refuses one with no bucket or of another type", () => {
    expect(parseMigration("migrations/move-app.yml", file)).toMatchObject({ kind: "backends", backends: [{ root: "app", from: { backend: "s3", config: { bucket: "state", key: "old/app.tfstate" } } }] });
    expect(() => parseMigration("migrations/x.yml", "backends:\n  - root: app\n    from:\n      backend: pg\n      config: {}\n")).toThrow(/from.backend must be s3, gcs, azurerm or local/);
    expect(() => parseMigration("migrations/x.yml", "backends:\n  - root: app\n    from:\n      backend: gcs\n      config: {}\n")).toThrow(/must name the bucket of the state/);
    expect(() => parseMigration("migrations/x.yml", "backends:\n  - root: app\n    from:\n      backend: azurerm\n      config: { storage_account_name: a }\n")).toThrow(/must name the storage_account_name, container_name and key of the state/);
    expect(() => parseMigration("migrations/x.yml", "backends:\n  - root: app\n    from:\n      backend: s3\n      config: { bucket: b }\n")).toThrow(/must name the bucket and key/);
    expect(() => parseMigration("migrations/x.yml", "moves: []\nbackends: []\n")).toThrow(/one kind of change/);
    expect(backendBlock("s3", { bucket: "b", key: "k", use_lockfile: true, endpoints: { s3: "http://x" }, nothing: null })).toBe('terraform {\n  backend "s3" {\n    bucket = "b"\n    key = "k"\n    use_lockfile = true\n    endpoints = { s3 = "http://x" }\n  }\n}\n');
  });

  it("copies the state to the backend the code names under both locks, leaves the old one where it was, and records both versions", async () => {
    const w = world();
    const old = w.put("state/old/app.tfstate", JSON.stringify(state("L", 3, ["a"])));
    const { work, origin } = repo(
      { "app/main.tf": "", "app/want.json": JSON.stringify(["terraform_data.a"]), "app/backend.json": s3("old/app.tfstate") },
      { "app/backend.json": s3("new/app.tfstate"), "migrations/move-app.yml": file },
    );
    const lines: string[] = [];
    const opts = { binary: "tofu", exec: w.exec, fetch: w.fetch, env: ENV, log: (l: string) => void lines.push(l) };
    const first = await runMigrations(work, { ...opts, now: T(1) });
    expect(first.code).toBe(3);
    expect(first.records[0]!.roots[0]).toMatchObject({ root: "app", location: "s3://state/new/app.tfstate", before: { digest: null }, source: { location: "s3://state/old/app.tfstate", version_id: old } });
    expect(lines[0]).toContain("moving the state of app from its s3 backend s3://state/old/app.tfstate to the backend its code names");
    approve(work, "move-app", first.records[0]!.digest, T(2));
    const second = await runMigrations(work, { ...opts, now: T(3) });
    expect(second.code).toBe(0);
    expect(JSON.parse(w.latest("state/new/app.tfstate")!.body).resources.map((r: StateResource) => r.name)).toEqual(["a"]);
    expect(w.latest("state/old/app.tfstate")!.id).toBe(old);
    expect(w.locks.size).toBe(0);
    expect(second.records[0]!.roots[0]!.after.version_id).toBe(w.latest("state/new/app.tfstate")!.id);
    const done = git(origin, "show", `chant/lifecycle:${MIGRATE_DONE}`);
    expect(JSON.parse(done)).toMatchObject({ change: "backends", roots: [{ root: "app", source: "s3://state/old/app.tfstate", source_version: old }] });
    expect(done).not.toContain("secret-");
  });

  it("refuses when the state it moves from moved after the approval, and when the new backend holds a state already", async () => {
    const w = world();
    w.put("state/old/app.tfstate", JSON.stringify(state("L", 3, ["a"])));
    const { work } = repo(
      { "app/main.tf": "", "app/want.json": JSON.stringify(["terraform_data.a"]), "app/backend.json": s3("old/app.tfstate") },
      { "app/backend.json": s3("new/app.tfstate"), "migrations/move-app.yml": file },
    );
    const opts = { binary: "tofu", exec: w.exec, fetch: w.fetch, env: ENV, log: () => {} };
    const first = await runMigrations(work, { ...opts, now: T(1) });
    approve(work, "move-app", first.records[0]!.digest, T(2));
    w.put("state/old/app.tfstate", JSON.stringify(state("L", 3, ["a"])));
    const again = await runMigrations(work, { ...opts, now: T(3) });
    expect(again.code).toBe(4);
    expect(again.records[0]!.moved).toEqual(["app"]);
    expect(w.latest("state/new/app.tfstate")).toBeUndefined();
    w.put("state/new/app.tfstate", JSON.stringify(state("M", 1, ["a"])));
    const taken = await runMigrations(work, { ...opts, now: T(4) });
    expect(taken.code).toBe(1);
    expect(taken.records[0]!.error).toContain("already holds a state");
  });
});

describe("a revert", () => {
  const done = (roots: unknown[], extra: Record<string, unknown> = {}) => JSON.stringify({ version: 1, kind: "migration", gate: "split-b", timestamp: T(1), result: "applied", change: "moves", roots, ...extra });

  it("is written from the migration's record: each root back to its version before, checked against its version after", () => {
    const r = revertMigration("split-b", done([{ root: "one", location: "s3://state/one.tfstate", before: "v1", after: "v5", before_digest: "sha256:a" }, { root: "two", location: "s3://state/two.tfstate", before: null, after: "v6", before_digest: null }]));
    expect(r.name).toBe("split-b-revert");
    expect(parseMigration("migrations/split-b-revert.yml", r.text)).toMatchObject({ kind: "revert", revert: "split-b", restores: [{ root: "one", version_id: "v1", from_version_id: "v5" }, { root: "two", version_id: null, from_version_id: "v6" }] });
  });

  it("refuses a migration that never applied, a backend move, and a root whose bucket kept no version", () => {
    expect(() => revertMigration("split-b", "")).toThrow(/no applied migration split-b/);
    expect(() => revertMigration("split-b", done([], { change: "backends" }))).toThrow(/backend move the other way/);
    expect(() => revertMigration("split-b", done([{ root: "one", location: "s3://state/one.tfstate", before: null, after: "v5", before_digest: "sha256:a" }]))).toThrow(/kept no version before/);
    expect(() => revertMigration("split-b", done([{ root: "one", location: "app/terraform.tfstate", before: null, after: null, before_digest: "sha256:a" }]))).toThrow(/keeps no versions/);
  });

  it("puts each state back to its version before, through a migration of its own, after a split applied", async () => {
    const w = world();
    const { work, origin } = repo(
      {
        "one/main.tf": "", "one/want.json": JSON.stringify(["terraform_data.a", "terraform_data.b"]), "one/backend.json": s3("one.tfstate"),
        "two/main.tf": "", "two/want.json": JSON.stringify([]), "two/backend.json": s3("two.tfstate"),
      },
      { "one/want.json": JSON.stringify(["terraform_data.a"]), "two/want.json": JSON.stringify(["terraform_data.b"]), "migrations/split-b.yml": "moves:\n  - from: one\n    to: two\n    addresses: [terraform_data.b]\n" },
    );
    const before = w.put("state/one.tfstate", JSON.stringify(state("L1", 4, ["a", "b"])));
    const opts = { binary: "tofu", exec: w.exec, fetch: w.fetch, env: ENV, log: () => {} };
    const split = await runMigrations(work, { ...opts, now: T(1) });
    approve(work, "split-b", split.records[0]!.digest, T(2));
    expect((await runMigrations(work, { ...opts, now: T(3) })).code).toBe(0);
    // The revert: the file from the record, and the code as it was.
    expect(writeRevert(work, "split-b")).toBe("migrations/split-b-revert.yml");
    write(work, { "one/want.json": JSON.stringify(["terraform_data.a", "terraform_data.b"]), "two/want.json": JSON.stringify([]) });
    git(work, "rm", "-q", "migrations/split-b.yml");
    git(work, "add", "-A");
    git(work, "commit", "-q", "-m", "revert split-b");
    const waits = await runMigrations(work, { ...opts, now: T(4) });
    expect(waits.code).toBe(3);
    expect(waits.records[0]).toMatchObject({ name: "split-b-revert", change: "revert", revert: "split-b" });
    expect(waits.records[0]!.roots.map((r) => [r.root, r.restore?.version_id])).toEqual([["one", before], ["two", null]]);
    approve(work, "split-b-revert", waits.records[0]!.digest, T(5));
    expect((await runMigrations(work, { ...opts, now: T(6) })).code).toBe(0);
    const one = JSON.parse(w.latest("state/one.tfstate")!.body) as StateFile;
    expect(one.resources.map((r) => r.name)).toEqual(["a", "b"]);
    expect(one.lineage).toBe("L1");
    expect(JSON.parse(w.latest("state/two.tfstate")!.body).resources).toEqual([]);
    expect(JSON.parse(git(origin, "show", `chant/lifecycle:${MIGRATE_DONE}`).trim().split("\n").at(-1)!)).toMatchObject({ gate: "split-b-revert", change: "revert", revert: "split-b", result: "applied" });
  });

  it("refuses when a state moved past the version the reverted migration left", async () => {
    const w = world();
    const was = w.put("state/one.tfstate", JSON.stringify(state("L1", 4, ["a", "b"])));
    const left = w.put("state/one.tfstate", JSON.stringify(state("L1", 5, ["a"])));
    w.put("state/one.tfstate", JSON.stringify(state("L1", 6, ["a"])));
    const text = `revert: split-b\nrestores:\n  - root: one\n    location: s3://state/one.tfstate\n    version_id: ${was}\n    from_version_id: ${left}\n`;
    const { work } = repo({ "one/main.tf": "", "one/want.json": JSON.stringify(["terraform_data.a", "terraform_data.b"]), "one/backend.json": s3("one.tfstate") }, { "migrations/split-b-revert.yml": text });
    const out = await planMigration(work, parseMigration("migrations/split-b-revert.yml", text), { binary: "tofu", exec: w.exec, fetch: w.fetch, env: ENV, work: tmp() }).catch((e: Error) => e.message);
    expect(out).toContain(`one's state is at version v3, and split-b left ${left}; it moved since`);
  });

  it("refuses under the lock a state that moved between the plan and the write", async () => {
    const w = world();
    const was = w.put("state/one.tfstate", JSON.stringify(state("L1", 4, ["a", "b"])));
    const left = w.put("state/one.tfstate", JSON.stringify(state("L1", 5, ["a"])));
    const text = `revert: split-b\nrestores:\n  - root: one\n    location: s3://state/one.tfstate\n    version_id: ${was}\n    from_version_id: ${left}\n`;
    const { work } = repo({ "one/main.tf": "", "one/want.json": JSON.stringify(["terraform_data.a", "terraform_data.b"]), "one/backend.json": s3("one.tfstate") }, { "migrations/split-b-revert.yml": text });
    const opts = { binary: "tofu", exec: w.exec, fetch: w.fetch, env: ENV, work: tmp() };
    const plan = await planMigration(work, parseMigration("migrations/split-b-revert.yml", text), opts);
    expect(plan.record.status).toBe("planned");
    w.put("state/one.tfstate", JSON.stringify(state("L1", 5, ["a"])));
    expect(await applyMigration(work, plan, { ...opts, now: T(1) })).toMatchObject({ status: "refused", moved: ["one"] });
    expect(w.locks.size).toBe(0);
  });
});
