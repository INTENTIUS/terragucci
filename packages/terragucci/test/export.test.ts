import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { appendLifecycle } from "../src/apply";
import { doneExports, EXPORT_DONE, EXPORT_LEDGER, exportState, requestDigest } from "../src/export";
import { ledgerEntries, EXPORT_DONE_FILE, EXPORT_LEDGER_FILE, parseLedgerLog } from "../src/report/audit";
import type { BinaryExec } from "../src/migrate";
import type { S3Fetch } from "../src/report/s3";
import { main } from "../src/cli";
import { tmp, write } from "./helpers";

const T = (m: number): string => new Date(Date.UTC(2026, 9, 9, 12, m)).toISOString();
const ENV = { AWS_ACCESS_KEY_ID: "AK", AWS_SECRET_ACCESS_KEY: "SK", AWS_REGION: "us-east-1", AWS_ENDPOINT_URL: "http://s3.test" };
const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf-8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
const V1 = JSON.stringify({ version: 4, lineage: "L", serial: 1, resources: [{ type: "terraform_data", name: "app", instances: [{ attributes: { input: "secret-1" } }] }] });
const V2 = V1.replace("secret-1", "secret-2").replace('"serial":1', '"serial":2');

/** A versioned bucket holding app.tfstate twice, a binary whose init records its s3 backend, and the requests each made. */
function world() {
  const versions = [{ id: "v1", body: V1 }, { id: "v2", body: V2 }];
  const seen: { method: string; url: string }[] = [];
  const fetch: S3Fetch = async (url, init) => {
    seen.push({ method: init.method, url });
    const u = new URL(url);
    const v = u.searchParams.get("versionId");
    const ok = (status: number, body = "", headers: Record<string, string> = {}) => ({ ok: status < 300, status, text: async () => body, headers: { get: (h: string) => headers[h.toLowerCase()] ?? null } });
    if (u.pathname !== "/state/app.tfstate") return ok(404);
    const found = v ? versions.find((x) => x.id === v) : versions.at(-1);
    if (!found) return ok(v ? 400 : 404);
    return ok(200, init.method === "HEAD" ? "" : found.body, { "x-amz-version-id": found.id });
  };
  const exec: BinaryExec = async (_b, args, dir, env) => {
    if (args[0] !== "init") return { code: 1, stdout: "", out: "only init" };
    const data = isAbsolute(env.TF_DATA_DIR!) ? env.TF_DATA_DIR! : join(dir, env.TF_DATA_DIR!);
    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, "terraform.tfstate"), JSON.stringify({ version: 3, backend: { type: "s3", config: { bucket: "state", key: "app.tfstate", region: "us-east-1", endpoints: { s3: "http://s3.test" } } } }));
    return { code: 0, stdout: "", out: "" };
  };
  return { fetch, exec, seen };
}

/** A clone with one root, app, and a bare origin for chant/lifecycle. */
function repo(files: Record<string, string> = {}) {
  const dir = tmp("tg-export-");
  const origin = join(dir, "origin.git");
  git(dir, "init", "-q", "--bare", origin);
  const work = join(dir, "work");
  mkdirSync(work);
  write(work, { "app/main.tf": 'terraform {\n  backend "s3" {}\n}\n', "terragucci.yml": "binary: tofu\n", ...files });
  git(work, "init", "-q", "-b", "main");
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", "base");
  git(work, "remote", "add", "origin", origin);
  git(work, "push", "-q", "origin", "main");
  return { work, origin, out: join(dir, "exports") };
}

const approve = (work: string, digest: string, by: string, at: string) =>
  appendLifecycle(work, EXPORT_LEDGER, [JSON.stringify({ version: 1, kind: "resolution", op: "tf-state-export", gate: "app", resolvedBy: by, timestamp: at, planDigest: digest })], {}, "approve");

const show = (work: string, path: string): string => {
  git(work, "fetch", "-q", "origin", "+refs/heads/chant/lifecycle:refs/remotes/origin/chant/lifecycle");
  return git(work, "show", `refs/remotes/origin/chant/lifecycle:${path}`);
};

describe("terragucci state export", () => {
  it("asks first: a pending request for the version, the approve command, exit 3, and no read of the state's body", async () => {
    const { work } = repo();
    const w = world();
    const lines: string[] = [];
    const r = await exportState(work, { root: "app", version: "v1", actor: "alice", env: ENV, exec: w.exec, fetch: w.fetch, now: T(0), log: (l) => lines.push(l) });
    expect(r.code).toBe(3);
    expect(r.digest).toBe(requestDigest({ root: "app", location: "s3://state/app.tfstate", version_id: "v1", by: "alice", at: T(0) }));
    expect(r.command).toBe(`chant approve tf-state-export app --plan ${r.digest}`);
    expect(w.seen.every((s) => s.method === "HEAD")).toBe(true);
    const pending = JSON.parse(show(work, EXPORT_LEDGER).trim());
    expect(pending).toMatchObject({ kind: "pending", op: "tf-state-export", gate: "app", planDigest: r.digest, request: { root: "app", version_id: "v1", by: "alice" } });
    expect(lines.join("\n")).toContain("someone other than you approves it");
    // Asked again before an approval: the same request waits, and no second one is written.
    const again = await exportState(work, { root: "app", version: "v1", actor: "alice", env: ENV, exec: w.exec, fetch: w.fetch, now: T(1), log: () => {} });
    expect(again).toMatchObject({ code: 3, digest: r.digest });
    expect(show(work, EXPORT_LEDGER).trim().split("\n")).toHaveLength(1);
  });

  it("once someone else approved it, records who exported what, then writes the version to a private file outside the repo", async () => {
    const { work, out } = repo();
    const w = world();
    const first = await exportState(work, { root: "app", version: "v1", actor: "alice", env: ENV, exec: w.exec, fetch: w.fetch, now: T(0), log: () => {} });
    approve(work, first.digest!, "bob", T(1));
    mkdirSync(out);
    const file = join(out, "app.tfstate");
    const r = await exportState(work, { root: "app", version: "v1", actor: "alice", out: file, env: ENV, exec: w.exec, fetch: w.fetch, now: T(2), log: () => {} });
    expect(r).toMatchObject({ code: 0, file });
    expect(readFileSync(file, "utf-8")).toBe(V1);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const done = [...doneExports(show(work, EXPORT_DONE)).values()];
    expect(done).toEqual([expect.objectContaining({ kind: "state-export", root: "app", version_id: "v1", location: "s3://state/app.tfstate", exportedBy: "alice", approvedBy: "bob", planDigest: first.digest })]);
    expect(done[0]!.content_digest).toMatch(/^sha256:/);
    expect(show(work, EXPORT_DONE)).not.toContain("secret-1");
    // The request exported once: running again asks anew.
    const next = await exportState(work, { root: "app", version: "v1", actor: "alice", env: ENV, exec: w.exec, fetch: w.fetch, now: T(3), log: () => {} });
    expect(next.code).toBe(3);
    expect(next.digest).not.toBe(first.digest);
  });

  it("an approval by the person who asked does not count", async () => {
    const { work } = repo();
    const w = world();
    const first = await exportState(work, { root: "app", version: "v1", actor: "alice", env: ENV, exec: w.exec, fetch: w.fetch, now: T(0), log: () => {} });
    approve(work, first.digest!, "alice", T(1));
    const lines: string[] = [];
    const r = await exportState(work, { root: "app", version: "v1", actor: "alice", env: ENV, exec: w.exec, fetch: w.fetch, now: T(2), log: (l) => lines.push(l) });
    expect(r.code).toBe(3);
    expect(lines.join("\n")).toContain("an approval by alice does not count");
    expect(w.seen.some((s) => s.method === "GET")).toBe(false);
  });

  it("takes the bucket's current version when none is named, and refuses a version the bucket does not hold", async () => {
    const { work } = repo();
    const w = world();
    const r = await exportState(work, { root: "app", actor: "alice", env: ENV, exec: w.exec, fetch: w.fetch, now: T(0), log: () => {} });
    expect(JSON.parse(show(work, EXPORT_LEDGER).trim()).request.version_id).toBe("v2");
    expect(r.code).toBe(3);
    await expect(exportState(work, { root: "app", version: "nope", actor: "alice", env: ENV, exec: w.exec, fetch: w.fetch, now: T(0), log: () => {} })).rejects.toThrow(/has no version nope/);
  });

  it("refuses a file inside the repo, a Terragrunt unit, and a request with nobody named", async () => {
    const { work } = repo({ "unit/terragrunt.hcl": "", "unit/main.tf": "" });
    const w = world();
    const first = await exportState(work, { root: "app", version: "v1", actor: "alice", env: ENV, exec: w.exec, fetch: w.fetch, now: T(0), log: () => {} });
    approve(work, first.digest!, "bob", T(1));
    await expect(exportState(work, { root: "app", version: "v1", actor: "alice", out: join(work, "app.tfstate"), env: ENV, exec: w.exec, fetch: w.fetch, now: T(2), log: () => {} })).rejects.toThrow(/inside the repo/);
    expect(existsSync(join(work, "app.tfstate"))).toBe(false);
    await expect(exportState(work, { root: "unit", actor: "alice", env: ENV, exec: w.exec, fetch: w.fetch })).rejects.toThrow(/Terragrunt unit/);
    git(work, "config", "user.name", "");
    await expect(exportState(work, { root: "app", env: { ...ENV, GIT_CONFIG_GLOBAL: "/dev/null" }, exec: w.exec, fetch: w.fetch })).rejects.toThrow(/names who asks/);
  });

  it("the audit trail names who exported what, and lists the request and its approval", async () => {
    const { work } = repo();
    const w = world();
    const first = await exportState(work, { root: "app", version: "v1", actor: "alice", env: ENV, exec: w.exec, fetch: w.fetch, now: T(0), log: () => {} });
    approve(work, first.digest!, "bob", T(1));
    const out = join(tmp(), "x.tfstate");
    await exportState(work, { root: "app", version: "v1", actor: "alice", out, env: ENV, exec: w.exec, fetch: w.fetch, now: T(2), log: () => {} });
    const log = (path: string) => parseLedgerLog(git(work, "log", "--reverse", "--format=%x1e%H%x1f%an%x1f%aI", "-p", "--unified=0", "refs/remotes/origin/chant/lifecycle", "--", path));
    const exported = ledgerEntries("p", EXPORT_DONE_FILE, log(EXPORT_DONE_FILE));
    expect(exported).toEqual([expect.objectContaining({ kind: "state-export", who: "alice", what: "app", digest: first.digest, result: "exported", detail: expect.objectContaining({ version_id: "v1", approved_by: "bob", location: "s3://state/app.tfstate" }) })]);
    const asked = ledgerEntries("p", EXPORT_LEDGER_FILE, log(EXPORT_LEDGER_FILE));
    expect(asked.map((e) => [e.kind, e.who, e.what])).toEqual([["approval-requested", null, "app"], ["approval", "bob", "app"]]);
  });

  it("the command takes state export <root> and exits 3 while it waits", async () => {
    const cwd = process.cwd();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await main(["state"])).toBe(2);
      expect(await main(["state", "export"])).toBe(2);
    } finally {
      process.chdir(cwd);
      log.mockRestore();
      err.mockRestore();
    }
  });
});
