import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendLifecycle } from "../src/apply";
import { stateObject, stateVersion } from "../src/backend";
import { copyBackend, unitBackend } from "../src/ephemeral";
import { doneExports, EXPORT_DONE, EXPORT_LEDGER, exportState } from "../src/export";
import type { Fetch } from "../src/forge";
import { currentSerial, gitlabState, hasVersion, isGitLabAddress, probeLock, readVersion, releaseLock, shownUrl, suffixedGitLabAddress, type GitLabFetch } from "../src/gitlab-state";
import type { BinaryExec } from "../src/migrate";
import type { S3Fetch } from "../src/report/s3";
import { stateAddress } from "../src/state-address";
import { lockDigest, parseUnlocks, UNLOCK_DONE, UNLOCK_LEDGER, unlockState, type UnlockOptions } from "../src/unlock";
import { tmp, write } from "./helpers";

const T = (m: number): string => new Date(Date.UTC(2026, 9, 9, 12, m)).toISOString();
const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf-8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
const API = "https://gitlab.test/api/v4/projects/42/terraform/state";
const ADDRESS = `${API}/app`;
const CONFIG = { address: ADDRESS, lock_address: `${ADDRESS}/lock`, unlock_address: `${ADDRESS}/lock`, lock_method: "POST", unlock_method: "DELETE", username: "gitlab-ci-token" };
const V = (serial: number, input: string) => JSON.stringify({ version: 4, lineage: "L", serial, resources: [{ type: "terraform_data", name: "app", instances: [{ attributes: { input } }] }] });

/** GitLab's state API for one project: states by name, each with its versions by serial and its lock; each request recorded. */
function gitlab() {
  const states = new Map<string, Map<number, string>>([["app", new Map([[1, V(1, "secret-1")], [2, V(2, "secret-2")]])]]);
  const locks = new Map<string, string>();
  const seen: { method: string; url: string; auth?: string }[] = [];
  const fetch: GitLabFetch & S3Fetch = async (url, init) => {
    seen.push({ method: init.method, url, ...(init.headers.authorization ? { auth: init.headers.authorization } : {}) });
    const ok = (status: number, body = "") => ({ ok: status < 300, status, text: async () => body, headers: { get: () => null } });
    if (init.headers.authorization !== `Basic ${Buffer.from("gitlab-ci-token:job-token").toString("base64")}`) return ok(401, '{"message":"401 Unauthorized"}');
    const m = new URL(url).pathname.match(/^\/api\/v4\/projects\/42\/terraform\/state\/([^/]+)(?:\/(lock|versions\/(\d+)))?$/);
    if (!m) return ok(404);
    const [, name, sub, serial] = m;
    const versions = states.get(name!);
    if (sub === "lock") {
      const body = JSON.parse(String(init.body ?? "{}")) as { ID?: string };
      const held = locks.get(name!);
      if (init.method === "POST") {
        // As GitLab answers: the holder's ID, user and time, and the ask's own fields for the rest.
        if (held) return ok(409, JSON.stringify({ ...body, ID: JSON.parse(held).ID, Who: JSON.parse(held).Who, Created: JSON.parse(held).Created }));
        locks.set(name!, JSON.stringify({ ...body, Who: "root", Created: T(10) }));
        return ok(200);
      }
      if (held && body.ID && JSON.parse(held).ID !== body.ID) return ok(409);
      locks.delete(name!);
      return ok(200);
    }
    if (!versions) return ok(404);
    if (serial) {
      const v = versions.get(Number(serial));
      return v === undefined ? ok(404) : ok(200, init.method === "HEAD" ? "" : v);
    }
    return ok(200, versions.get(Math.max(...versions.keys()))!);
  };
  return { states, locks, seen, fetch };
}

const ENV = { TF_HTTP_PASSWORD: "job-token" };

/** A root initialised with an http backend, as `init` leaves `.terraform/terraform.tfstate`. */
const initialised = (config: Record<string, unknown>): string => write(tmp(), { ".terraform/terraform.tfstate": JSON.stringify({ version: 3, backend: { type: "http", config, hash: 1 } }) });

describe("GitLab-managed state", () => {
  it("is an http backend whose address is a project's state API, read from the block, else the TF_HTTP_ variables", () => {
    expect(isGitLabAddress(ADDRESS)).toBe(true);
    expect(isGitLabAddress("https://gitlab.test/group/gitlab/api/v4/projects/group%2Fapp/terraform/state/net/")).toBe(true);
    expect(isGitLabAddress("https://state.example.com/net")).toBe(false);
    expect(isGitLabAddress(`${ADDRESS}/lock`)).toBe(false);
    expect(isGitLabAddress("not a url")).toBe(false);
    const s = gitlabState(CONFIG, ENV)!;
    expect(s).toMatchObject({ address: ADDRESS, name: "app", lockAddress: `${ADDRESS}/lock`, unlockAddress: `${ADDRESS}/lock`, lockMethod: "POST", unlockMethod: "DELETE" });
    expect(s.auth).toBe(`Basic ${Buffer.from("gitlab-ci-token:job-token").toString("base64")}`);
    // An empty block: everything from the job's variables, as the binary reads them.
    const fromEnv = gitlabState({}, { TF_HTTP_ADDRESS: `${API}/my%20state`, TF_HTTP_LOCK_ADDRESS: `${API}/my%20state/lock`, TF_HTTP_USERNAME: "u", TF_HTTP_PASSWORD: "p" })!;
    expect(fromEnv).toMatchObject({ name: "my state", lockAddress: `${API}/my%20state/lock`, lockMethod: "LOCK" });
    expect(fromEnv.unlockAddress).toBeUndefined();
    expect(gitlabState({ address: "https://state.example.com/net" }, {})).toBeUndefined();
    expect(shownUrl("https://u:secret@gitlab.test/api/v4/projects/42/terraform/state/app?x=1")).toBe(ADDRESS);
  });

  it("suffixes the state name of an address and of its lock", () => {
    expect(suffixedGitLabAddress(ADDRESS, "pr-7")).toBe(`${API}/app-pr-7`);
    expect(suffixedGitLabAddress(`${ADDRESS}/lock`, "pr-7")).toBe(`${API}/app-pr-7/lock`);
    expect(suffixedGitLabAddress(`${ADDRESS}/`, "pr-7")).toBe(`${API}/app-pr-7`);
    expect(suffixedGitLabAddress("https://state.example.com/net", "pr-7")).toBeUndefined();
  });

  it("reads the serial, checks and reads a version by serial, with the backend's credentials", async () => {
    const g = gitlab();
    const s = gitlabState(CONFIG, ENV)!;
    expect(await currentSerial(s, g.fetch)).toEqual({ serial: 2, lineage: "L" });
    expect(await hasVersion(s, "1", g.fetch)).toBe(true);
    expect(await hasVersion(s, "9", g.fetch)).toBe(false);
    expect(g.seen.at(-1)).toMatchObject({ method: "HEAD", url: `${ADDRESS}/versions/9` });
    expect(await readVersion(s, "1", g.fetch)).toBe(V(1, "secret-1"));
    expect(await readVersion(s, "9", g.fetch)).toBeUndefined();
    expect(await currentSerial(gitlabState({ ...CONFIG, address: `${API}/none` }, ENV)!, g.fetch)).toBeUndefined();
    await expect(currentSerial(gitlabState(CONFIG, { TF_HTTP_PASSWORD: "wrong" })!, g.fetch)).rejects.toThrow(/answered 401 .* TF_HTTP_PASSWORD/);
  });

  it("reads who holds the lock by asking for it, and gives back one it took", async () => {
    const g = gitlab();
    const s = gitlabState(CONFIG, ENV)!;
    expect(await probeLock(s, g.fetch)).toBeUndefined();
    expect(g.locks.size).toBe(0);
    expect(g.seen.map((x) => x.method)).toEqual(["POST", "DELETE"]);
    g.locks.set("app", JSON.stringify({ ID: "held-1", Who: "root", Created: T(5) }));
    expect(JSON.parse((await probeLock(s, g.fetch))!)).toEqual({ ID: "held-1", Who: "root", Created: T(5) });
    await expect(releaseLock(s, "other", g.fetch)).rejects.toThrow(/another lock holds the state/);
    expect(g.locks.has("app")).toBe(true);
    await releaseLock(s, "held-1", g.fetch);
    expect(g.locks.has("app")).toBe(false);
    await expect(probeLock(gitlabState({ address: ADDRESS }, ENV)!, g.fetch)).rejects.toThrow(/names no lock_address/);
  });

  it("is where a root's state is, and its version is the serial GitLab holds", async () => {
    const g = gitlab();
    const dir = initialised(CONFIG);
    expect(stateObject(dir, ENV)).toMatchObject({ backend: "http", location: ADDRESS });
    expect(await stateVersion(dir, ENV, g.fetch)).toEqual({ backend: "http", location: ADDRESS, version_id: "2", versioning: "on" });
    // The address from TF_HTTP_ADDRESS, which init does not record.
    expect(await stateVersion(initialised({}), { ...ENV, TF_HTTP_ADDRESS: ADDRESS, TF_HTTP_USERNAME: "gitlab-ci-token" }, g.fetch)).toMatchObject({ version_id: "2", versioning: "on" });
    expect(await stateVersion(initialised({ ...CONFIG, address: `${API}/none` }), ENV, g.fetch)).toMatchObject({ versioning: "unknown", note: "GitLab holds no state at this address" });
    expect(await stateVersion(dir, { TF_HTTP_PASSWORD: "wrong" }, g.fetch)).toMatchObject({ versioning: "unknown", note: expect.stringContaining("401") });
    // An http backend that is not GitLab's keeps no versions, from the block or the variable.
    expect(await stateVersion(initialised({}), { TF_HTTP_ADDRESS: "https://state.example.com/net" })).toMatchObject({ versioning: "off" });
  });

  it("lines up a read with the state it names by address", () => {
    const at = (attrs: Record<string, string>) => stateAddress("http", (n) => attrs[n], "");
    expect(at({ address: ADDRESS })).toEqual(at({ address: `${ADDRESS}/`, username: "x" }));
    expect(at({ address: ADDRESS })).not.toEqual(at({ address: `${API}/net` }));
  });
});

describe("ephemeral copies of GitLab-managed state", () => {
  const root = (attrs: string): string => write(tmp(), { "main.tf": `terraform {\n  backend "http" {\n${attrs}  }\n}\n` });
  it("names the copy's state and its lock with the suffix, from the block or the variables", () => {
    const block = root(`    address        = "${ADDRESS}"\n    lock_address   = "${ADDRESS}/lock"\n    unlock_address = "${ADDRESS}/lock"\n`);
    expect(copyBackend(block, "app", "pr-3")).toEqual({ type: "http", attribute: "address", key: `${API}/app-pr-3`, location: `${API}/app-pr-3`, extra: { lock_address: `${API}/app-pr-3/lock`, unlock_address: `${API}/app-pr-3/lock` } });
    const empty = root("");
    expect(copyBackend(empty, "app", "pr-3", { TF_HTTP_ADDRESS: ADDRESS, TF_HTTP_LOCK_ADDRESS: `${ADDRESS}/lock` })).toEqual({ type: "http", attribute: "address", key: `${API}/app-pr-3`, location: `${API}/app-pr-3`, extra: { lock_address: `${API}/app-pr-3/lock` } });
    expect(copyBackend(root(`    address = "${ADDRESS}"\n`), "app", "pr-3")).not.toHaveProperty("extra");
  });

  it("refuses an http backend that is not GitLab's, one with no address, and a lock of another state", () => {
    expect(() => copyBackend(root('    address = "https://state.example.com/net"\n'), "app", "pr-3")).toThrow(/not a GitLab project's state API/);
    expect(() => copyBackend(root(""), "app", "pr-3")).toThrow(/names no address, in the block or TF_HTTP_ADDRESS/);
    expect(() => copyBackend(root(`    address      = "${ADDRESS}"\n    lock_address = "${API}/net/lock"\n`), "app", "pr-3")).toThrow(/lock_address .* is not the lock of its state/);
  });

  it("checks a unit's copy locks its own state", () => {
    const unit = (config: Record<string, string>) => write(tmp(), { ".terraform/terraform.tfstate": JSON.stringify({ backend: { type: "http", config } }) });
    expect(unitBackend(unit({ address: `${API}/app-pr-3`, lock_address: `${API}/app-pr-3/lock` }))).toEqual({ type: "http", attribute: "address", key: `${API}/app-pr-3`, location: `${API}/app-pr-3`, locks: [`${API}/app-pr-3/lock`] });
  });
});

/** A clone with one root, app, on GitLab-managed state, a bare origin for chant/lifecycle, and a binary whose init records the backend. */
function repo(files: Record<string, string> = {}) {
  const dir = tmp("tg-glstate-");
  const origin = join(dir, "origin.git");
  git(dir, "init", "-q", "--bare", origin);
  const work = join(dir, "work");
  mkdirSync(work);
  write(work, { "app/main.tf": 'terraform {\n  backend "http" {}\n}\n', "terragucci.yml": "binary: tofu\nforge: gitlab\nurl: https://gitlab.test/acme/infra\n", ...files });
  git(work, "init", "-q", "-b", "main");
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", "base");
  git(work, "remote", "add", "origin", origin);
  git(work, "push", "-q", "origin", "main");
  const record = (dir: string) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "terraform.tfstate"), JSON.stringify({ version: 3, backend: { type: "http", config: CONFIG } }));
  };
  const exec: BinaryExec = async (_b, args, d, env) => {
    if (args[0] !== "init") return { code: 1, stdout: "", out: "only init" };
    record(isAbsolute(env.TF_DATA_DIR!) ? env.TF_DATA_DIR! : join(d, env.TF_DATA_DIR!));
    return { code: 0, stdout: "", out: "" };
  };
  const calls: string[][] = [];
  const unlockExec: NonNullable<UnlockOptions["exec"]> = (_b, args, d) => {
    calls.push(args);
    if (args[0] !== "init") return { status: 1, out: `unknown ${args.join(" ")}` };
    record(join(d, ".terraform"));
    return { status: 0, out: "" };
  };
  return { work, origin, out: join(dir, "exports"), exec, unlockExec, calls };
}

const show = (work: string, path: string): string => {
  git(work, "fetch", "-q", "origin", "+refs/heads/chant/lifecycle:refs/remotes/origin/chant/lifecycle");
  return git(work, "show", `refs/remotes/origin/chant/lifecycle:${path}`);
};

describe("state export of GitLab-managed state", () => {
  it("asks for a version by serial with a HEAD, and once someone else approved it writes that version", async () => {
    const r = repo();
    const g = gitlab();
    const first = await exportState(r.work, { root: "app", version: "1", actor: "alice", env: ENV, exec: r.exec, fetch: g.fetch, now: T(0), log: () => {} });
    expect(first.code).toBe(3);
    expect(g.seen.map((s) => s.method)).toEqual(["HEAD"]);
    expect(JSON.parse(show(r.work, EXPORT_LEDGER).trim()).request).toMatchObject({ location: ADDRESS, version_id: "1" });
    appendLifecycle(r.work, EXPORT_LEDGER, [JSON.stringify({ version: 1, kind: "resolution", op: "tf-state-export", gate: "app", resolvedBy: "bob", timestamp: T(1), planDigest: first.digest })], {}, "approve");
    mkdirSync(r.out);
    const file = join(r.out, "app.tfstate");
    const done = await exportState(r.work, { root: "app", version: "1", actor: "alice", out: file, env: ENV, exec: r.exec, fetch: g.fetch, now: T(2), log: () => {} });
    expect(done).toMatchObject({ code: 0, file });
    expect(readFileSync(file, "utf-8")).toBe(V(1, "secret-1"));
    expect([...doneExports(show(r.work, EXPORT_DONE)).values()]).toEqual([expect.objectContaining({ root: "app", location: ADDRESS, version_id: "1", approvedBy: "bob" })]);
  });

  it("takes the current serial when no version is named, and refuses a serial GitLab does not keep", async () => {
    const r = repo();
    const g = gitlab();
    await exportState(r.work, { root: "app", actor: "alice", env: ENV, exec: r.exec, fetch: g.fetch, now: T(0), log: () => {} });
    expect(JSON.parse(show(r.work, EXPORT_LEDGER).trim()).request.version_id).toBe("2");
    await expect(exportState(r.work, { root: "app", version: "9", actor: "alice", env: ENV, exec: r.exec, fetch: g.fetch, log: () => {} })).rejects.toThrow(/has no version 9/);
    await expect(exportState(r.work, { root: "app", version: "v1", actor: "alice", env: ENV, exec: r.exec, fetch: g.fetch, log: () => {} })).rejects.toThrow(/versions are serials/);
    await expect(exportState(r.work, { root: "app", actor: "alice", env: { TF_HTTP_PASSWORD: "wrong" }, exec: r.exec, fetch: g.fetch, log: () => {} })).rejects.toThrow(/state export: GitLab answered 401/);
  });
});

describe("unlock-state of GitLab-managed state", () => {
  const noRuns: Fetch = async () => ({ ok: true, status: 200, json: async () => [], text: async () => "[]" });
  const run = (r: ReturnType<typeof repo>, g: ReturnType<typeof gitlab>, now: string) => {
    const lines: string[] = [];
    return unlockState(r.work, "app", { env: { ...ENV, GITLAB_TOKEN: "t" }, exec: r.unlockExec, s3Fetch: g.fetch, fetch: noRuns, log: (l) => lines.push(l), actor: "dana", now }).then((x) => ({ ...x, lines }));
  };

  it("says there is nothing to release when nobody holds the lock, and leaves it free", async () => {
    const r = repo();
    const g = gitlab();
    const x = await run(r, g, T(30));
    expect(x.code).toBe(0);
    expect(x.lines.join("\n")).toContain(`no lock is held on ${ADDRESS}/lock`);
    expect(g.locks.size).toBe(0);
  });

  it("waits for an approval of the lock's ID, then releases that lock on GitLab's lock endpoint and records it", async () => {
    const r = repo();
    const g = gitlab();
    g.locks.set("app", JSON.stringify({ ID: "lock-1", Operation: "OperationTypeApply", Who: "root", Created: T(10) }));
    const first = await run(r, g, T(30));
    expect(first.code).toBe(3);
    const digest = lockDigest("app", `${ADDRESS}/lock`, "lock-1");
    expect(first.digest).toBe(digest);
    expect(g.locks.has("app")).toBe(true);
    appendLifecycle(r.work, UNLOCK_LEDGER, [JSON.stringify({ version: 1, kind: "resolution", op: "tf-unlock", gate: "app", resolvedBy: "lee", timestamp: T(32), planDigest: digest })], {}, "approve");
    const second = await run(r, g, T(33));
    expect(second.code).toBe(0);
    expect(g.locks.has("app")).toBe(false);
    expect(r.calls.some((c) => c[0] === "force-unlock")).toBe(false);
    expect(parseUnlocks(show(r.work, UNLOCK_DONE))).toEqual([expect.objectContaining({ root: "app", location: `${ADDRESS}/lock`, lock: expect.objectContaining({ ID: "lock-1" }), approvedBy: "lee", releasedBy: "dana" })]);
  });

  it("refuses a backend that takes no lock, or cannot release one", async () => {
    const r = repo();
    r.unlockExec = (_b, args, d) => {
      mkdirSync(join(d, ".terraform"), { recursive: true });
      writeFileSync(join(d, ".terraform", "terraform.tfstate"), JSON.stringify({ version: 3, backend: { type: "http", config: { address: ADDRESS } } }));
      return { status: args[0] === "init" ? 0 : 1, out: "" };
    };
    await expect(run(r, gitlab(), T(30))).rejects.toThrow(/names no lock_address/);
  });
});
