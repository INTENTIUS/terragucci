import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendLifecycle } from "../src/apply";
import { backendRefusal, isPulled, MIGRATE_DONE, MIGRATE_LEDGER, OVERRIDE_FILE, parseMigration, revertMigration, runMigrations, type BinaryExec, type StateFile, type StateResource } from "../src/migrate";
import { stateObject } from "../src/backend";
import { tmp, write } from "./helpers";

const T = (m: number): string => new Date(Date.UTC(2026, 9, 10, 12, m)).toISOString();
const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf-8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
const res = (name: string): StateResource => ({ mode: "managed", type: "terraform_data", name, provider: 'provider["terraform.io/builtin/terraform"]', instances: [{ attributes: { id: `${name}-id`, input: `secret-${name}` } }] });
const state = (lineage: string, serial: number, names: string[]): StateFile => ({ version: 4, terraform_version: "1.10.6", serial, lineage, outputs: {}, resources: names.map(res), check_results: null });

// ── a simulated binary over backends it keeps in memory ──────────────────
// A root's code names its backend in main.tf (`backend "<type>" { k = "v" }`);
// the migration's override file names another. init records the backend in
// the data dir, as the binary does, and the store keeps one state per backend
// configuration. push refuses another lineage or an older serial, as the
// binary's own check does, and counts the pushes that took the lock.

interface Store {
  states: Map<string, StateFile>;
  pushes: { where: string; args: string[] }[];
}

function blockOf(text: string): { type: string; config: Record<string, string> } | undefined {
  const m = /backend\s+"(\w+)"\s*\{([\s\S]*?)\n\s*\}/.exec(text);
  if (!m) return undefined;
  const config = Object.fromEntries([...m[2].matchAll(/(\w+)\s*=\s*"([^"]*)"/g)].map((x) => [x[1], x[2]]));
  return { type: m[1], config };
}

const dataDir = (dir: string, env: NodeJS.ProcessEnv): string => (env.TF_DATA_DIR ? (isAbsolute(env.TF_DATA_DIR) ? env.TF_DATA_DIR : join(dir, env.TF_DATA_DIR)) : join(dir, ".terraform"));

function backendOf(dir: string, env: NodeJS.ProcessEnv): { type: string; config: Record<string, string> } {
  const file = join(dataDir(dir, env), "terraform.tfstate");
  return JSON.parse(readFileSync(file, "utf-8")).backend;
}

const whereOf = (b: { type: string; config: Record<string, string> }): string => `${b.type} ${JSON.stringify(b.config)}`;

function binary(store: Store): BinaryExec {
  return async (_binary, args, dir, env) => {
    const ok = (stdout = "", out = stdout) => ({ code: 0, stdout, out });
    if (args[0] === "init") {
      const override = join(dir, OVERRIDE_FILE);
      const b = (env.TF_DATA_DIR && existsSync(override) ? blockOf(readFileSync(override, "utf-8")) : undefined) ?? blockOf(readFileSync(join(dir, "main.tf"), "utf-8"))!;
      mkdirSync(dataDir(dir, env), { recursive: true });
      writeFileSync(join(dataDir(dir, env), "terraform.tfstate"), JSON.stringify({ version: 3, backend: b }));
      return ok("", "initialised");
    }
    const b = backendOf(dir, env);
    const read = (): StateFile | undefined => (b.type === "local" ? (existsSync(b.config.path) ? JSON.parse(readFileSync(b.config.path, "utf-8")) : undefined) : store.states.get(whereOf(b)));
    if (args[0] === "state" && args[1] === "pull") {
      const s = read();
      return ok(s ? JSON.stringify(s) : "");
    }
    if (args[0] === "state" && args[1] === "push") {
      const next = JSON.parse(readFileSync(args[args.length - 1], "utf-8")) as StateFile;
      const now = read();
      const force = args.includes("-force");
      if (now && !force && now.lineage !== next.lineage) return { code: 1, stdout: "", out: "Failed to write state: cannot import state with lineage over unrelated state with lineage" };
      if (now && !force && next.serial < now.serial) return { code: 1, stdout: "", out: "Failed to write state: cannot import state with serial over newer state" };
      store.pushes.push({ where: whereOf(b), args });
      store.states.set(whereOf(b), next);
      return ok();
    }
    if (args[0] === "plan") {
      const held = (read()?.resources ?? []).map((r) => `${r.type}.${r.name}`);
      const want = JSON.parse(readFileSync(join(dir, "want.json"), "utf-8")) as string[];
      const changes = [...want.filter((a) => !held.includes(a)).map((a) => ({ address: a, change: { actions: ["create"] } })), ...held.filter((a) => !want.includes(a)).map((a) => ({ address: a, change: { actions: ["delete"] } }))];
      writeFileSync(args.find((a) => a.startsWith("-out="))!.slice(5), JSON.stringify({ resource_changes: changes }));
      return ok(changes.length === 0 ? "No changes." : `Plan: ${changes.length} to change.`);
    }
    if (args[0] === "show") return ok(readFileSync(args[2], "utf-8"));
    return { code: 1, stdout: "", out: `the fake binary does not know ${args.join(" ")}` };
  };
}

const pg = (schema: string): string => `terraform {\n  backend "pg" {\n    conn_str = "postgres://db:5432/app?sslmode=disable"\n    schema_name = "${schema}"\n  }\n}\n`;
const k8s = (suffix: string): string => `terraform {\n  backend "kubernetes" {\n    namespace = "tf"\n    secret_suffix = "${suffix}"\n  }\n}\n`;
const resources = (names: string[]): string => names.map((n) => `resource "terraform_data" "${n}" {}\n`).join("");

/** A repo whose roots are given by their files, committed and pushed to origin, with a migration file. */
function repo(files: Record<string, string>, migration: string) {
  const dir = tmp("tg-migrate-pulled-");
  const origin = join(dir, "origin.git");
  git(dir, "init", "-q", "--bare", origin);
  const work = join(dir, "work");
  mkdirSync(work);
  write(work, files);
  git(work, "init", "-q", "-b", "main");
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", "base");
  write(work, { "migrations/move-app.yml": migration });
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", "move");
  git(work, "remote", "add", "origin", origin);
  git(work, "push", "-q", "origin", "main");
  return { work, origin };
}

function approve(work: string, digest: string, at: string): void {
  appendLifecycle(work, MIGRATE_LEDGER, [JSON.stringify({ version: 1, kind: "resolution", op: "tf-migrate", gate: "move-app", resolvedBy: "alice", timestamp: at, planDigest: digest })], {}, "approve");
}

const pgFrom = "backends:\n  - root: app\n    from:\n      backend: pg\n      config:\n        conn_str: postgres://db:5432/app?sslmode=disable\n        schema_name: old\n";
const oldPg = `pg ${JSON.stringify({ conn_str: "postgres://db:5432/app?sslmode=disable", schema_name: "old" })}`;
const newPg = `pg ${JSON.stringify({ conn_str: "postgres://db:5432/app?sslmode=disable", schema_name: "new" })}`;

describe("a backend move between backends that keep no versions", () => {
  it("reads the pg state with state pull, waits for the digest, and writes it with state push under the backend's own lock", async () => {
    const store: Store = { states: new Map([[oldPg, state("L1", 4, ["keep", "moved"])]]), pushes: [] };
    const { work, origin } = repo({ "app/main.tf": pg("new") + resources(["keep", "moved"]), "app/want.json": JSON.stringify(["terraform_data.keep", "terraform_data.moved"]) }, pgFrom);
    const lines: string[] = [];
    const log = (l: string) => void lines.push(l);
    const first = await runMigrations(work, { binary: "tofu", exec: binary(store), env: {}, now: T(1), log });
    expect(first.code).toBe(3);
    expect(lines[0]).toBe("migration move-app: moving the state of app from its pg backend pg:db:5432/app/old.states to the backend its code names");
    const planned = first.records[0];
    expect(planned.roots[0]).toMatchObject({ root: "app", backend: "pg", location: "pg:db:5432/app/new.states", before: { digest: null }, source: { backend: "pg", location: "pg:db:5432/app/old.states" } });
    expect(planned.roots[0].source?.version_id).toBeUndefined();
    expect(store.pushes).toEqual([]);

    approve(work, planned.digest, T(2));
    const second = await runMigrations(work, { binary: "tofu", exec: binary(store), env: {}, now: T(3), log });
    expect(second.code).toBe(0);
    expect(second.records[0]).toMatchObject({ status: "applied", approved_by: "alice" });
    // The binary took the backend's lock for the push: no -lock=false.
    expect(store.pushes.map((p) => [p.where, p.args.includes("-lock=false")])).toEqual([[newPg, false]]);
    expect(store.states.get(newPg)?.resources.map((r) => r.name)).toEqual(["keep", "moved"]);
    expect(store.states.get(oldPg)?.serial).toBe(4);
    const line = JSON.parse(git(origin, "show", `chant/lifecycle:${MIGRATE_DONE}`));
    expect(line.roots[0]).toMatchObject({ root: "app", location: "pg:db:5432/app/new.states", before: null, after: null, before_digest: null, source: "pg:db:5432/app/old.states", source_version: null });
    expect(JSON.stringify(line)).not.toContain("secret-");
    // A pg backend keeps no versions, so the move cannot be put back by version: a backend move the other way does it.
    expect(() => revertMigration("move-app", git(origin, "show", `chant/lifecycle:${MIGRATE_DONE}`))).toThrow("backend move the other way");
  });

  it("refuses a source written again after the approval: the digest binds its contents, with no version id to bind", async () => {
    const store: Store = { states: new Map([[oldPg, state("L1", 4, ["keep", "moved"])]]), pushes: [] };
    const { work } = repo({ "app/main.tf": pg("new") + resources(["keep", "moved"]), "app/want.json": JSON.stringify(["terraform_data.keep", "terraform_data.moved"]) }, pgFrom);
    const lines: string[] = [];
    const first = await runMigrations(work, { binary: "tofu", exec: binary(store), env: {}, now: T(1), log: (l) => void lines.push(l) });
    approve(work, first.records[0].digest, T(2));
    store.states.set(oldPg, state("L1", 5, ["keep", "moved"]));
    const again = await runMigrations(work, { binary: "tofu", exec: binary(store), env: {}, now: T(3), log: (l) => void lines.push(l) });
    expect(again.code).toBe(4);
    expect(again.records[0]).toMatchObject({ status: "refused", moved: ["app"] });
    expect(lines.join("\n")).toContain("the states moved since: app");
    expect(store.pushes).toEqual([]);
  });

  it("moves a resource from a pg root to a kubernetes root, each written by the binary under its lock", async () => {
    const store: Store = { states: new Map([[`pg ${JSON.stringify({ conn_str: "postgres://db:5432/app?sslmode=disable", schema_name: "one" })}`, state("L1", 3, ["a", "b"])]]), pushes: [] };
    const { work } = repo(
      { "one/main.tf": pg("one") + resources(["a"]), "one/want.json": JSON.stringify(["terraform_data.a"]), "two/main.tf": k8s("two") + resources(["b"]), "two/want.json": JSON.stringify(["terraform_data.b"]) },
      "moves:\n  - from: one\n    to: two\n    addresses: [terraform_data.b]\n",
    );
    const first = await runMigrations(work, { binary: "tofu", exec: binary(store), env: {}, now: T(1), log: () => {} });
    expect(first.code).toBe(3);
    expect(first.records[0].roots.map((r) => [r.root, r.location])).toEqual([["one", "pg:db:5432/app/one.states"], ["two", "kubernetes:tf/two"]]);
    approve(work, first.records[0].digest, T(2));
    const second = await runMigrations(work, { binary: "tofu", exec: binary(store), env: {}, now: T(3), log: () => {} });
    expect(second.code).toBe(0);
    // The root that gains is written first, and neither push skips the lock.
    expect(store.pushes.map((p) => [p.where.split(" ")[0], p.args.includes("-lock=false")])).toEqual([["kubernetes", false], ["pg", false]]);
  });
});

describe("a backend move to a kubernetes backend", () => {
  const oldK = `kubernetes ${JSON.stringify({ namespace: "tf", secret_suffix: "old" })}`;
  const newK = `kubernetes ${JSON.stringify({ namespace: "tf", secret_suffix: "new" })}`;
  const kFrom = "backends:\n  - root: app\n    from:\n      backend: kubernetes\n      config:\n        namespace: tf\n        secret_suffix: old\n";
  const files = { "app/main.tf": k8s("new") + resources(["keep"]), "app/want.json": JSON.stringify(["terraform_data.keep"]) };

  it("replaces the empty state the backend wrote at init, of another lineage, with a forced push the digest binds", async () => {
    const store: Store = { states: new Map([[oldK, state("L1", 2, ["keep"])], [newK, state("K0", 0, [])]]), pushes: [] };
    const { work } = repo(files, kFrom);
    const first = await runMigrations(work, { binary: "tofu", exec: binary(store), env: {}, now: T(1), log: () => {} });
    expect(first.code).toBe(3);
    expect(first.records[0].roots[0].before.digest).not.toBeNull();
    approve(work, first.records[0].digest, T(2));
    const second = await runMigrations(work, { binary: "tofu", exec: binary(store), env: {}, now: T(3), log: () => {} });
    expect(second.code).toBe(0);
    expect(store.pushes.map((p) => [p.where, p.args.includes("-force"), p.args.includes("-lock=false")])).toEqual([[newK, true, false]]);
    expect(store.states.get(newK)).toMatchObject({ lineage: "L1", serial: 2 });
  });

  it("refuses a backend that already holds resources", async () => {
    const store: Store = { states: new Map([[oldK, state("L1", 2, ["keep"])], [newK, state("K0", 1, ["other"])]]), pushes: [] };
    const { work } = repo(files, kFrom);
    const lines: string[] = [];
    const run = await runMigrations(work, { binary: "tofu", exec: binary(store), env: {}, now: T(1), log: (l) => void lines.push(l) });
    expect(run.code).toBe(1);
    expect(lines.join("\n")).toContain("kubernetes:tf/new, already holds a state");
  });
});

describe("which backends the general path takes", () => {
  it("takes the backends that keep no versions, and still refuses one whose versions terragucci does not read", () => {
    const dir = tmp();
    const pgObject = stateObject(dir, {}, { type: "pg", config: { conn_str: "postgres://db/app" } });
    expect(isPulled(pgObject)).toBe(true);
    expect(backendRefusal("app", pgObject, true)).toBeUndefined();
    // Elsewhere (an estate's adoption) the general path is not taken.
    expect(backendRefusal("app", pgObject)).toContain("migrates state in s3, gcs, azurerm and local backends");
    expect(isPulled(stateObject(dir, {}, { type: "kubernetes", config: { secret_suffix: "app" } }))).toBe(true);
    const oss = stateObject(dir, {}, { type: "oss", config: { bucket: "b" } });
    expect(isPulled(oss)).toBe(false);
    expect(backendRefusal("app", oss, true)).toContain("through the binary in pg, kubernetes, consul and http backends");
  });

  it("reads pg and kubernetes as sources, and refuses a credential in the file", () => {
    expect(parseMigration("migrations/m.yml", pgFrom).backends[0].from).toEqual({ backend: "pg", config: { conn_str: "postgres://db:5432/app?sslmode=disable", schema_name: "old" } });
    expect(parseMigration("migrations/m.yml", "backends:\n  - root: app\n    from:\n      backend: kubernetes\n      config:\n        namespace: tf\n        secret_suffix: app\n").backends[0].from.backend).toBe("kubernetes");
    const bad = (config: string) => () => parseMigration("migrations/m.yml", `backends:\n  - root: app\n    from:\n${config}`);
    expect(bad("      backend: kubernetes\n      config:\n        namespace: tf\n")).toThrow("must name the secret_suffix of the state");
    expect(bad("      backend: kubernetes\n      config:\n        secret_suffix: app\n        token: abc\n")).toThrow("from.config.token: a credential does not belong in the repo");
    expect(bad("      backend: pg\n      config:\n        conn_str: postgres://u:hunter2@db/app\n")).toThrow("conn_str holds a password");
    expect(bad("      backend: pg\n      config:\n        conn_str: host=db dbname=app password=hunter2\n")).toThrow("PGPASSWORD");
  });
});
