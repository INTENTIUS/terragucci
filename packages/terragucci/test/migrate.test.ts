import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { appendLifecycle, applyWave, parseLedger } from "../src/apply";
import {
  addressMatches,
  applyMigration,
  derivedLineage,
  doneMigrations,
  lockKey,
  lockInfo,
  MIGRATE_DONE,
  MIGRATE_LEDGER,
  migrateApproveCommand,
  moveResources,
  OVERRIDE_FILE,
  parseMigration,
  planMigration,
  refusal,
  resourceChanges,
  runMigrations,
  type BinaryExec,
  type StateFile,
  type StateResource,
} from "../src/migrate";
import { ledgerEntries, MIGRATE_DONE_FILE, MIGRATE_LEDGER_FILE } from "../src/report/audit";
import { S3Client, type S3Fetch } from "../src/report/s3";
import { tmp, write } from "./helpers";
import type { TerragruntExec } from "@intentius/chant-lexicon-terraform/terragrunt/run";

const T = (m: number): string => new Date(Date.UTC(2026, 9, 9, 12, m)).toISOString();
const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf-8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });

const res = (type: string, name: string, module?: string, mode = "managed"): StateResource => ({ ...(module ? { module } : {}), mode, type, name, provider: 'provider["terraform.io/builtin/terraform"]', instances: [{ attributes: { id: `${name}-id`, input: `secret-${name}` } }] });
const state = (lineage: string, serial: number, resources: StateResource[]): StateFile => ({ version: 4, terraform_version: "1.13.1", serial, lineage, outputs: {}, resources, check_results: null });

describe("a migration file", () => {
  it("names its moves: from a root, to a root, with the resource and module addresses", () => {
    const m = parseMigration("migrations/split-queues.yml", "moves:\n  - from: envs/dev/platform/\n    to: ./envs/dev/queues\n    addresses: [aws_sqs_queue.jobs, module.search]\n");
    expect(m).toMatchObject({ name: "split-queues", file: "migrations/split-queues.yml", moves: [{ from: "envs/dev/platform", to: "envs/dev/queues", addresses: ["aws_sqs_queue.jobs", "module.search"] }] });
    expect(m.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("refuses what it cannot move, naming every problem", () => {
    const bad = `moves:
  - from: a
    to: a
    addresses: ["aws_s3_bucket.x[0]", data.aws_caller_identity.me]
  - from: ../b
    addresses: []
    rename: yes
`;
    let msg = "";
    try {
      parseMigration("migrations/Bad Name.yml", bad);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain("is not a gate name");
    expect(msg).toContain("a move inside one root is a moved block");
    expect(msg).toContain('"aws_s3_bucket.x[0]" is not a resource or module address without an instance key');
    expect(msg).toContain("data.aws_caller_identity.me is a data source");
    expect(msg).toContain("moves[1].to must name a root directory");
    expect(msg).toContain("moves[1].from must be a directory in the repo");
    expect(msg).toContain("moves[1].addresses must list");
    expect(msg).toContain("moves[1].rename is not a key of a move");
    expect(() => parseMigration("migrations/x.yml", "{}")).toThrow("moves is missing or empty");
  });
});

describe("moving resources between states", () => {
  it("matches a resource by its address and a module call with every module and instance under it", () => {
    expect(addressMatches("aws_sqs_queue.jobs", res("aws_sqs_queue", "jobs"))).toBe(true);
    expect(addressMatches("aws_sqs_queue.jobs", res("aws_sqs_queue", "jobs", "module.a"))).toBe(false);
    expect(addressMatches("module.a.aws_sqs_queue.jobs", res("aws_sqs_queue", "jobs", 'module.a["x"]'))).toBe(true);
    expect(addressMatches("module.a", res("aws_sqs_queue", "jobs", 'module.a["x"].module.b'))).toBe(true);
    expect(addressMatches("module.a", res("aws_caller_identity", "me", "module.a", "data"))).toBe(true);
    expect(addressMatches("module.a", res("aws_sqs_queue", "jobs", "module.ab"))).toBe(false);
    expect(addressMatches("aws_caller_identity.me", res("aws_caller_identity", "me", undefined, "data"))).toBe(false);
  });

  it("takes the resources out of one state and into the other: a changed state keeps its lineage and gets the next serial", () => {
    const before = new Map<string, StateFile | null>([
      ["one", state("L1", 7, [res("terraform_data", "a"), res("terraform_data", "b")])],
      ["two", state("L2", 3, [res("terraform_data", "c")])],
    ]);
    const after = moveResources("m", [{ from: "one", to: "two", addresses: ["terraform_data.b"] }], before);
    expect(after.get("one")).toMatchObject({ lineage: "L1", serial: 8 });
    expect(after.get("one")!.resources.map((r) => r.name)).toEqual(["a"]);
    expect(after.get("two")).toMatchObject({ lineage: "L2", serial: 4 });
    expect(after.get("two")!.resources.map((r) => r.name)).toEqual(["c", "b"]);
    // The states read are left as they were.
    expect(before.get("one")!.resources).toHaveLength(2);
  });

  it("gives a root with no state a new one, its lineage the same each time it is planned", () => {
    const before = new Map<string, StateFile | null>([["one", state("L1", 1, [res("terraform_data", "a")])], ["new", null]]);
    const a = moveResources("m", [{ from: "one", to: "new", addresses: ["terraform_data.a"] }], before).get("new")!;
    const b = moveResources("m", [{ from: "one", to: "new", addresses: ["terraform_data.a"] }], before).get("new")!;
    expect(a).toMatchObject({ version: 4, serial: 1, terraform_version: "1.13.1", lineage: derivedLineage("m", "new") });
    expect(a.lineage).toBe(b.lineage);
    expect(a.lineage).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("refuses an address that is in no state, or already in the root it moves to", () => {
    const before = new Map<string, StateFile | null>([["one", state("L1", 1, [res("terraform_data", "a")])], ["two", state("L2", 1, [res("terraform_data", "a")])]]);
    expect(() => moveResources("m", [{ from: "one", to: "two", addresses: ["terraform_data.a", "terraform_data.z"] }], before)).toThrow(/terraform_data\.a is already in the state of two[\s\S]*terraform_data\.z is not in the state of one/);
    expect(() => moveResources("m", [{ from: "none", to: "two", addresses: ["terraform_data.a"] }], new Map([["none", null]]))).toThrow("none has no state to move");
  });

  it("counts only resource changes: no-ops and reads are not", () => {
    expect(resourceChanges({ resource_changes: [{ address: "a.x", change: { actions: ["no-op"] } }, { address: "data.b.y", change: { actions: ["read"] } }, { address: "c.z", change: { actions: ["delete", "create"] } }] })).toEqual(["c.z: delete+create"]);
    expect(resourceChanges({})).toEqual([]);
  });
});

describe("which roots a migration refuses", () => {
  it("takes a Terragrunt unit, and refuses a root with a cloud block and a directory that is not a root", () => {
    const repo = write(tmp(), {
      "unit/terragrunt.hcl": "",
      "hcp/main.tf": 'terraform {\n  cloud {\n    organization = "acme"\n  }\n}\n',
      "empty/README.md": "",
      "ok/main.tf": 'resource "terraform_data" "a" {}\n',
    });
    // A unit holds no .tf files of its own: Terragrunt prepares its code, so it is not refused for that.
    expect(refusal(repo, "unit")).toBeUndefined();
    expect(refusal(repo, "hcp")).toContain("cloud block");
    expect(refusal(repo, "empty")).toContain("holds no .tf or .tf.json files");
    expect(refusal(repo, "gone")).toContain("not a directory");
    expect(refusal(repo, "ok")).toBeUndefined();
  });

  it("takes a CDK Terrain stack, whose code is cdk.tf.json, and refuses one with a cloud block or JSON it cannot read", () => {
    const stack = (terraform: unknown) => JSON.stringify({ "//": { metadata: { backend: "s3", stackName: "dev" } }, terraform, resource: { terraform_data: { keep: { input: "x" } } } });
    const repo = write(tmp(), {
      "cdktf.out/stacks/dev/cdk.tf.json": stack({ backend: { s3: { bucket: "b", key: "dev.tfstate", use_lockfile: true } } }),
      "cdktf.out/stacks/hcp/cdk.tf.json": stack({ cloud: { organization: "acme", workspaces: { name: "hcp" } } }),
      "cdktf.out/stacks/listed/cdk.tf.json": stack([{ required_version: ">= 1.10" }, { cloud: { organization: "acme" } }]),
      "cdktf.out/stacks/broken/cdk.tf.json": "{ not json",
    });
    expect(refusal(repo, "cdktf.out/stacks/dev")).toBeUndefined();
    expect(refusal(repo, "cdktf.out/stacks/hcp")).toContain("cloud block");
    expect(refusal(repo, "cdktf.out/stacks/listed")).toContain("cloud block");
    expect(refusal(repo, "cdktf.out/stacks/broken")).toBe("cdktf.out/stacks/broken: cdk.tf.json is not JSON");
  });
});

// ── a simulated binary over local state files ────────────────────────────
// Each root holds terraform.tfstate (its local backend) and want.json, the
// addresses its code declares. A plan compares the two: an address wanted and
// not in the state is a create, one in the state and not wanted a delete.
// With the migration's override file present, the backend is the file it names.

function statePath(dir: string, env: NodeJS.ProcessEnv): string {
  const override = join(dir, OVERRIDE_FILE);
  if (env.TF_DATA_DIR && existsSync(override)) return JSON.parse(/path = (".*")/.exec(readFileSync(override, "utf-8"))![1]);
  return join(dir, "terraform.tfstate");
}

const fake: BinaryExec = async (_binary, args, dir, env) => {
  const ok = (stdout = "", out = stdout) => ({ code: 0, stdout, out });
  if (args[0] === "init") return ok("", "initialised");
  if (args[0] === "state" && args[1] === "pull") {
    const p = statePath(dir, env);
    // As OpenTofu's s3 backend does, a root with no state object prints an empty state with no lineage.
    return ok(existsSync(p) ? readFileSync(p, "utf-8") : JSON.stringify({ version: 4, terraform_version: "1.13.1", serial: 0, lineage: "", outputs: {}, resources: [], check_results: null }));
  }
  if (args[0] === "state" && args[1] === "push") {
    copyFileSync(args[args.length - 1], join(dir, "terraform.tfstate"));
    return ok();
  }
  if (args[0] === "plan") {
    const p = statePath(dir, env);
    const held = existsSync(p) ? (JSON.parse(readFileSync(p, "utf-8")) as StateFile).resources.filter((r) => r.mode === "managed").map((r) => `${r.module ? `${r.module}.` : ""}${r.type}.${r.name}`) : [];
    const want = JSON.parse(readFileSync(join(dir, "want.json"), "utf-8")) as string[];
    const changes = [...want.filter((a) => !held.includes(a)).map((a) => ({ address: a, change: { actions: ["create"] } })), ...held.filter((a) => !want.includes(a)).map((a) => ({ address: a, change: { actions: ["delete"] } }))];
    writeFileSync(args.find((a) => a.startsWith("-out="))!.slice(5), JSON.stringify({ resource_changes: changes }));
    return ok(changes.length === 0 ? "No changes. Your infrastructure matches the configuration." : `Plan: ${changes.length} to change.`);
  }
  if (args[0] === "show") return ok(readFileSync(args[2], "utf-8"));
  return { code: 1, stdout: "", out: `the fake binary does not know ${args.join(" ")}` };
};

/** A repo whose root one holds a and b, root two holds c, and whose code now has b in two; with origin, where chant/lifecycle goes. */
function repo(opts: { wantInTwo?: string[] } = {}) {
  const dir = tmp("tg-migrate-");
  const origin = join(dir, "origin.git");
  git(dir, "init", "-q", "--bare", origin);
  const work = join(dir, "work");
  mkdirSync(work);
  write(work, {
    "one/main.tf": 'resource "terraform_data" "a" {}\n',
    "one/want.json": JSON.stringify(["terraform_data.a"]),
    "one/terraform.tfstate": JSON.stringify(state("L1", 5, [res("terraform_data", "a"), res("terraform_data", "b")])),
    "two/main.tf": 'resource "terraform_data" "c" {}\nresource "terraform_data" "b" {}\n',
    "two/want.json": JSON.stringify(opts.wantInTwo ?? ["terraform_data.c", "terraform_data.b"]),
    "two/terraform.tfstate": JSON.stringify(state("L2", 2, [res("terraform_data", "c")])),
  });
  git(work, "init", "-q", "-b", "main");
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", "base");
  write(work, { "migrations/split-b.yml": "moves:\n  - from: one\n    to: two\n    addresses: [terraform_data.b]\n" });
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", "move b");
  git(work, "remote", "add", "origin", origin);
  git(work, "push", "-q", "origin", "main");
  return { work, origin };
}

const names = (work: string, root: string): string[] => (JSON.parse(readFileSync(join(work, root, "terraform.tfstate"), "utf-8")) as StateFile).resources.map((r) => r.name);
const ledger = (origin: string) => parseLedger(git(origin, "show", `chant/lifecycle:${MIGRATE_LEDGER}`));
function approve(work: string, gate: string, digest: string, at: string, by = "alice"): void {
  appendLifecycle(work, MIGRATE_LEDGER, [JSON.stringify({ version: 1, kind: "resolution", op: "tf-migrate", gate, resolvedBy: by, timestamp: at, planDigest: digest })], {}, "approve");
}

describe("running a migration from wave 1", () => {
  it("waits for an approval of its digest, applies under it, records the versions before and after, and never runs again", async () => {
    const { work, origin } = repo();
    const lines: string[] = [];
    const log = (l: string) => void lines.push(l);
    const first = await runMigrations(work, { binary: "tofu", exec: fake, env: {}, now: T(1), log });
    expect(first.code).toBe(3);
    const digest = first.records[0].digest;
    expect(first.command).toBe(migrateApproveCommand("split-b", digest));
    expect(lines).toContain(`  chant approve tf-migrate split-b --plan ${digest}`);
    expect(names(work, "one")).toEqual(["a", "b"]);
    const pending = ledger(origin).pending;
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ op: "tf-migrate", gate: "split-b", planDigest: digest, neverOverMcp: true });
    expect(pending[0].members?.map((m) => m.member)).toEqual(["one", "two"]);
    // The plan record kept beside the ledger holds digests, never a state's contents.
    const kept = git(origin, "show", `chant/lifecycle:_gates/tf-migrate/split-b/${digest.replace(":", "_")}.json`);
    expect(kept).not.toContain("secret-");
    // A pull request's plan job proves the same digest, read only.
    const planned = await runMigrations(work, { binary: "tofu", exec: fake, env: {}, planOnly: true, log });
    expect(planned.code).toBe(0);
    expect(planned.records[0]).toMatchObject({ status: "planned", digest });

    approve(work, "split-b", digest, T(2));
    const second = await runMigrations(work, { binary: "tofu", exec: fake, env: {}, now: T(3), log });
    expect(second.code).toBe(0);
    expect(second.records[0]).toMatchObject({ status: "applied", approved_by: "alice" });
    expect(names(work, "one")).toEqual(["a"]);
    expect(names(work, "two")).toEqual(["c", "b"]);
    expect(second.records[0].roots.map((r) => r.verify?.changes)).toEqual([[], []]);
    const done = doneMigrations(git(origin, "show", `chant/lifecycle:${MIGRATE_DONE}`));
    expect(done.get("split-b")?.status).toBe("applied");
    const line = git(origin, "show", `chant/lifecycle:${MIGRATE_DONE}`);
    expect(line).not.toContain("secret-");
    expect(JSON.parse(line).roots.map((r: { root: string; before_digest: string; after_digest: string }) => [r.root, r.before_digest !== r.after_digest])).toEqual([["one", true], ["two", true]]);
    const record = JSON.parse(readFileSync(join(work, "terragucci-report", "migrations", "split-b.json"), "utf-8"));
    expect(record.status).toBe("applied");
    expect(JSON.stringify(record)).not.toContain("secret-");

    const third = await runMigrations(work, { binary: "tofu", exec: fake, env: {}, now: T(4), log });
    expect(third).toEqual({ code: 0, records: [] });
    // A file changed after it applied is refused: a migration runs once.
    writeFileSync(join(work, "migrations", "split-b.yml"), "moves:\n  - from: one\n    to: two\n    addresses: [terraform_data.a]\n");
    expect((await runMigrations(work, { binary: "tofu", exec: fake, env: {}, now: T(5), log })).code).toBe(1);
    expect(lines.join("\n")).toContain("changed after it applied");
  });

  it("refuses when a state moved after the approval, naming the root, and writes nothing", async () => {
    const { work } = repo();
    const lines: string[] = [];
    const first = await runMigrations(work, { binary: "tofu", exec: fake, env: {}, now: T(1), log: (l) => void lines.push(l) });
    approve(work, "split-b", first.records[0].digest, T(2));
    // Someone wrote one's state since: the same resources, a new serial.
    writeFileSync(join(work, "one", "terraform.tfstate"), JSON.stringify(state("L1", 6, [res("terraform_data", "a"), res("terraform_data", "b")])));
    const again = await runMigrations(work, { binary: "tofu", exec: fake, env: {}, now: T(3), log: (l) => void lines.push(l) });
    expect(again.code).toBe(4);
    expect(again.records[0]).toMatchObject({ status: "refused", moved: ["one"] });
    expect(names(work, "two")).toEqual(["c"]);
    expect(lines.join("\n")).toContain("the states moved since: one");
  });

  it("writes nothing and records nothing to approve when a root would change against its new state", async () => {
    const { work, origin } = repo({ wantInTwo: ["terraform_data.c"] });
    const lines: string[] = [];
    const run = await runMigrations(work, { binary: "tofu", exec: fake, env: {}, now: T(1), log: (l) => void lines.push(l) });
    expect(run.code).toBe(1);
    expect(run.records[0].status).toBe("proof-failed");
    expect(run.records[0].roots.find((r) => r.root === "two")?.proof.changes).toEqual(["terraform_data.b: delete"]);
    expect(lines.join("\n")).toContain("two would change; nothing was written");
    expect(() => git(origin, "show", `chant/lifecycle:${MIGRATE_LEDGER}`)).toThrow();
    expect(existsSync(join(work, "two", OVERRIDE_FILE))).toBe(false);
  });

  it("refuses under the lock a state that moved between the plan and the write", async () => {
    const { work } = repo();
    const plan = await planMigration(work, parseMigration("migrations/split-b.yml", readFileSync(join(work, "migrations", "split-b.yml"), "utf-8")), { binary: "tofu", exec: fake, env: {}, work: tmp() });
    writeFileSync(join(work, "two", "terraform.tfstate"), JSON.stringify(state("L2", 3, [res("terraform_data", "c")])));
    const out = await applyMigration(work, plan, { binary: "tofu", exec: fake, env: {}, work: tmp(), now: T(1) });
    expect(out).toMatchObject({ status: "refused", moved: ["two"] });
    expect(names(work, "one")).toEqual(["a", "b"]);
  });

  it("moves a resource into a root with no state yet, which gets a lineage of its own", async () => {
    const { work } = repo();
    write(work, { "three/main.tf": 'resource "terraform_data" "b" {}\n', "three/want.json": JSON.stringify(["terraform_data.b"]), "migrations/split-b.yml": "moves:\n  - from: one\n    to: three\n    addresses: [terraform_data.b]\n" });
    const plan = await planMigration(work, parseMigration("migrations/split-b.yml", readFileSync(join(work, "migrations", "split-b.yml"), "utf-8")), { binary: "tofu", exec: fake, env: {}, work: tmp() });
    expect(plan.record.status).toBe("planned");
    expect(plan.record.roots.find((r) => r.root === "three")?.before).toEqual({ digest: null });
    expect(plan.files.get("three")?.state).toMatchObject({ serial: 1, lineage: derivedLineage("split-b", "three") });
  });

  it("does nothing in a repo with no migrations", async () => {
    const out = vi.fn();
    expect(await runMigrations(tmp(), { binary: "tofu", exec: fake, log: out })).toEqual({ code: 0, records: [] });
    expect(out).not.toHaveBeenCalled();
  });
});

describe("wave 1 and the migrations", () => {
  it("runs a Terragrunt repo's migration before any unit plans, preparing each unit through Terragrunt", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((l: string) => void lines.push(l));
    const dir = tmp();
    const origin = join(dir, "origin.git");
    git(dir, "init", "-q", "--bare", origin);
    const tg = write(join(dir, "work"), { "migrations/m.yml": "moves:\n  - from: a\n    to: b\n    addresses: [x.y]\n", "a/terragrunt.hcl": "", "b/terragrunt.hcl": "" });
    git(tg, "init", "-q", "-b", "main");
    git(tg, "add", "-A");
    git(tg, "commit", "-q", "-m", "base");
    git(tg, "remote", "add", "origin", origin);
    git(tg, "push", "-q", "origin", "main");
    const calls: string[][] = [];
    // Terragrunt fails to prepare the unit: the migration fails, naming it, and the wave applies nothing.
    const exec: TerragruntExec = async (_f, args) => {
      calls.push([...args]);
      return { code: 1, stdout: "", stderr: "Error: no backend" };
    };
    expect(await applyWave(tg, { wave: 1, layers: [["a", "b"]], binary: "tofu", gate: "never", terragrunt: true, terragruntExec: exec, terragruntPath: "tg", env: {} })).toBe(1);
    expect(calls[0]).toEqual(["run", "--non-interactive", "--no-color", "--working-dir", "a", "--", "init", "-input=false", "-no-color"]);
    expect(lines.join("\n")).toContain("terragrunt could not prepare a (init failed): Error: no backend");
    expect(lines.join("\n")).toContain("did not apply, so no wave plans until it does");
    vi.restoreAllMocks();
  });
});

describe("a migration in the audit trail", () => {
  it("is an entry with its approver, digest and each root's version before and after, read from done.jsonl", () => {
    expect(MIGRATE_DONE_FILE).toBe(MIGRATE_DONE);
    expect(MIGRATE_LEDGER_FILE).toBe(MIGRATE_LEDGER);
    const line = JSON.stringify({ version: 1, kind: "migration", op: "tf-migrate", gate: "split-b", timestamp: T(3), planDigest: "jcs1-sha256:" + "a".repeat(64), file_digest: "sha256:f", result: "applied", approvedBy: "alice", roots: [{ root: "one", location: "s3://b/one.tfstate", before: "v1", after: "v2" }] });
    const [e] = ledgerEntries("p", MIGRATE_DONE_FILE, [{ line, added: true, commit: "c1", author: "terragucci", date: T(3) }]);
    expect(e).toMatchObject({ kind: "migration", what: "split-b", who: "alice", result: "applied", at: T(3), evidence: { source: "ledger", path: MIGRATE_DONE_FILE, commit: "c1" } });
    expect(e.detail?.roots).toEqual([{ root: "one", location: "s3://b/one.tfstate", before: "v1", after: "v2" }]);
    // The gate's own lines read as any gate's: a request and an approval of the migration's digest.
    const pending = JSON.stringify({ version: 1, kind: "pending", op: "tf-migrate", gate: "split-b", timestamp: T(1), expiresAt: T(9), planDigest: "d", members: [{ member: "one", planDigest: "x" }] });
    expect(ledgerEntries("p", MIGRATE_LEDGER_FILE, [{ line: pending, added: true, commit: "c0", author: "t", date: T(1) }])[0]).toMatchObject({ kind: "approval-requested", what: "split-b", detail: { roots: ["one"] } });
  });
});

describe("the S3 lock a migration holds", () => {
  it("is the state's lock file, taken only when absent and never without the condition", async () => {
    expect(lockKey("envs/dev/platform.tfstate")).toBe("envs/dev/platform.tfstate.tflock");
    expect(JSON.parse(lockInfo("b/k", T(1), "me"))).toMatchObject({ Operation: "terragucci migrate", Who: "me", Created: T(1), Path: "b/k" });
    const answer = (status: number): S3Fetch => async (_u, init) => {
      expect(init.headers["if-none-match"]).toBe("*");
      return { ok: status < 300, status, text: async () => "" };
    };
    const client = (f: S3Fetch) => new S3Client({ bucket: "b", endpoint: "http://minio:9000", region: "us-east-1", accessKeyId: "AK", secretAccessKey: "SK" }, f);
    expect(await client(answer(200)).putIfAbsent("k.tflock", "{}", "application/json")).toBe(true);
    expect(await client(answer(412)).putIfAbsent("k.tflock", "{}", "application/json")).toBe(false);
    await expect(client(answer(501)).putIfAbsent("k.tflock", "{}", "application/json")).rejects.toThrow("does not take a conditional write");
    const seen: string[] = [];
    await client(async (u, init) => {
      seen.push(`${init.method} ${u}`);
      return { ok: false, status: 404, text: async () => "" };
    }).remove("k.tflock");
    expect(seen).toEqual(["DELETE http://minio:9000/b/k.tflock"]);
  });
});

// ── Terragrunt units ─────────────────────────────────────────────────────
// Each unit's code runs in a working directory of Terragrunt's cache. The
// Terragrunt stand-in runs TG_TF_PATH there, with the unit's input as a
// TF_VAR_, as Terragrunt does; the simulated binary then works in that
// directory, and must see the variable.

describe("a migration between two Terragrunt units", () => {
  function tgRepo() {
    const dir = tmp("tg-units-");
    const origin = join(dir, "origin.git");
    git(dir, "init", "-q", "--bare", origin);
    const work = join(dir, "work");
    mkdirSync(work);
    write(work, {
      "root.hcl": "",
      "live/one/terragrunt.hcl": 'include "root" {\n  path = find_in_parent_folders("root.hcl")\n}\n',
      "live/two/terragrunt.hcl": 'include "root" {\n  path = find_in_parent_folders("root.hcl")\n}\n',
      "migrations/split-b.yml": "moves:\n  - from: live/one\n    to: live/two\n    addresses: [terraform_data.b]\n",
      ".gitignore": ".cache/\n",
    });
    const cache = join(dir, "cache");
    write(cache, {
      "one/want.json": JSON.stringify(["terraform_data.a"]),
      "one/terraform.tfstate": JSON.stringify(state("L1", 5, [res("terraform_data", "a"), res("terraform_data", "b")])),
      "two/want.json": JSON.stringify(["terraform_data.c", "terraform_data.b"]),
      "two/terraform.tfstate": JSON.stringify(state("L2", 2, [res("terraform_data", "c")])),
    });
    git(work, "init", "-q", "-b", "main");
    git(work, "add", "-A");
    git(work, "commit", "-q", "-m", "base");
    git(work, "remote", "add", "origin", origin);
    git(work, "push", "-q", "origin", "main");
    const prepared: string[] = [];
    const terragrunt: TerragruntExec = async (_file, args, opts) => {
      const unit = args[args.indexOf("--working-dir") + 1]!;
      prepared.push(unit);
      const name = unit.split("/").pop()!;
      // Terragrunt runs the binary in the unit's working directory, with its inputs as TF_VAR_ variables.
      execFileSync(opts.env.TG_TF_PATH!, args.slice(args.indexOf("--") + 1), { cwd: join(cache, name), env: { ...process.env, ...opts.env, TF_VAR_unit: name } });
      return { code: 0, stdout: "", stderr: "" };
    };
    // The binary must run where Terragrunt ran it, with the unit's inputs.
    const seen: string[] = [];
    const exec: BinaryExec = (binary, args, dir, env) => {
      seen.push(`${env.TF_VAR_unit}@${dir.split("/").pop()}`);
      return fake(binary, args, dir, env);
    };
    return { work, cache, terragrunt, exec, prepared, seen };
  }

  it("moves the resource from one unit's state to the other's, in the directories Terragrunt prepared, behind the digest's approval", async () => {
    const { work, cache, terragrunt, exec, prepared, seen } = tgRepo();
    const lines: string[] = [];
    const log = (l: string) => void lines.push(l);
    const opts = { binary: "true", exec, env: {}, log, terragrunt: { path: "terragrunt", exec: terragrunt } };
    const first = await runMigrations(work, { ...opts, now: T(1) });
    expect(first.code).toBe(3);
    expect(prepared).toEqual(["live/one", "live/two"]);
    expect(new Set(seen)).toEqual(new Set(["one@one", "two@two"]));
    const digest = first.records[0].digest;
    approve(work, "split-b", digest, T(2));
    const second = await runMigrations(work, { ...opts, now: T(3) });
    expect(second.code).toBe(0);
    expect(second.records[0]).toMatchObject({ status: "applied", digest });
    const held = (u: string) => (JSON.parse(readFileSync(join(cache, u, "terraform.tfstate"), "utf-8")) as StateFile).resources.map((r) => r.name);
    expect(held("one")).toEqual(["a"]);
    expect(held("two")).toEqual(["c", "b"]);
    expect(second.records[0].roots.map((r) => r.root)).toEqual(["live/one", "live/two"]);
    // The units' own directories were never written: the override file went into the working directories, and is gone.
    expect(existsSync(join(work, "live/one", OVERRIDE_FILE))).toBe(false);
    expect(existsSync(join(cache, "one", OVERRIDE_FILE))).toBe(false);
  });
});
