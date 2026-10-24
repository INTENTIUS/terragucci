import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError } from "../src/config";
import { configFromEntries, estateClaims, hasControlRecords, importControlConfig, initRecords, KIND_FILE, putEntry, readEntries, retireEntry, type ChantRunner, type ControlEntry } from "../src/control-records";
import { checkOwnership, controlClaims, projectKeyFromEnv } from "../src/estate-ownership";
import { tmp } from "./helpers";

type Rec = { id: string; state: string; valid?: boolean; digest: string; data: Record<string, unknown> };

/** A chant that holds records in memory and answers the calls control-records makes. */
function fakeChant(records: Rec[] = []): { run: ChantRunner; calls: { args: string[]; input?: string }[] } {
  const calls: { args: string[]; input?: string }[] = [];
  const run: ChantRunner = (args, { input }) => {
    calls.push({ args, input });
    const ok = (o: unknown) => ({ status: 0, stdout: JSON.stringify(o), stderr: "" });
    const verb = args[2];
    if (verb === "new") {
      const f = JSON.parse(input!);
      const id = `ctl-${String(records.length + 1).padStart(3, "0")}`;
      records.push({ id, state: f.state, digest: `d${records.length}`, data: { ...f, id } });
      return ok({ id, path: `terragucci/records/${id}.md` });
    }
    if (verb === "amend") {
      const r = records.find((x) => x.id === args[3])!;
      if (args[args.indexOf("--expect") + 1] !== r.digest) return { status: 1, stdout: JSON.stringify({ error: { code: "record-conflict", message: "moved" } }), stderr: "" };
      const set = JSON.parse(input!);
      Object.assign(r.data, set);
      if (set.state) r.state = set.state;
      r.digest += "x";
      return ok({ id: r.id, path: `terragucci/records/${r.id}.md` });
    }
    return ok({ records: records.map((r) => ({ ...r, valid: r.valid ?? true, path: `terragucci/records/${r.id}.md`, reasons: [] })) });
  };
  return { run, calls };
}

const repo = (): string => {
  const dir = tmp();
  initRecords(dir);
  return dir;
};

describe("control records: the repo is the store", () => {
  it("init writes the kind, its schema and the declaration, and keeps what is there", () => {
    const dir = tmp();
    expect(hasControlRecords(dir)).toBe(false);
    const r = initRecords(dir);
    expect(r.written).toContain(KIND_FILE);
    expect(hasControlRecords(dir)).toBe(true);
    const ws = JSON.parse(readFileSync(join(dir, "chant.workspace.json"), "utf-8"));
    expect(ws.records).toEqual([{ kind: KIND_FILE }]);
    expect(initRecords(dir).written).toEqual([]);
    expect(readFileSync(join(dir, KIND_FILE), "utf-8")).toContain('name: "control-entry"');
  });

  it("reads active records into the config terragucci.yml held, projects sorted", () => {
    const dir = repo();
    const { run } = fakeChant();
    putEntry(dir, { entry: "defaults", settings: { gate: "always" } }, run);
    putEntry(dir, { entry: "project", project: "github.com/acme/web", settings: { binary: "tofu" } }, run);
    putEntry(dir, { entry: "project", project: "github.com/acme/api", settings: {} }, run);
    const cfg = configFromEntries(readEntries(dir, run));
    expect(cfg.defaults).toEqual({ gate: "always" });
    expect(Object.keys(cfg.projects!)).toEqual(["github.com/acme/api", "github.com/acme/web"]);
  });

  it("amends with the digest it read, and writes nothing when nothing changed", () => {
    const dir = repo();
    const { run, calls } = fakeChant();
    expect(putEntry(dir, { entry: "project", project: "github.com/acme/web", settings: {} }, run).status).toBe("created");
    expect(putEntry(dir, { entry: "project", project: "github.com/acme/web", settings: { drift: "0 4 * * *" } }, run).status).toBe("updated");
    const amend = calls.find((c) => c.args[2] === "amend")!;
    expect(amend.args).toContain("--expect");
    expect(amend.args[amend.args.indexOf("--expect") + 1]).toBe("d0");
    const n = calls.length;
    expect(putEntry(dir, { entry: "project", project: "github.com/acme/web", settings: { drift: "0 4 * * *" } }, run).status).toBe("unchanged");
    expect(calls.slice(n).every((c) => c.args[2] !== "amend" && c.args[2] !== "new")).toBe(true);
  });

  it("checks settings before chant sees them", () => {
    const dir = repo();
    const { run, calls } = fakeChant();
    expect(() => putEntry(dir, { entry: "project", project: "github.com/acme/web", settings: { nonsense: 1 } as never }, run)).toThrow(ConfigError);
    expect(() => putEntry(dir, { entry: "project", project: "not-a-key", settings: {} }, run)).toThrow(/project key/);
    expect(() => putEntry(dir, { entry: "defaults", project: "github.com/a/b", settings: {} }, run)).toThrow(/defaults/);
    expect(calls).toEqual([]);
  });

  it("retires a project: its record closes and the project is no longer read", () => {
    const dir = repo();
    const { run } = fakeChant();
    putEntry(dir, { entry: "project", project: "github.com/acme/web", settings: {} }, run);
    retireEntry(dir, "github.com/acme/web", run);
    expect(readEntries(dir, run)).toEqual([]);
    expect(() => retireEntry(dir, "github.com/acme/web", run)).toThrow(/no active record/);
  });

  it("refuses two active records for one project and an invalid record", () => {
    const dir = repo();
    const two = fakeChant([
      { id: "ctl-001", state: "active", digest: "a", data: { entry: "project", project: "github.com/acme/web", settings: {}, estates: [] } },
      { id: "ctl-002", state: "active", digest: "b", data: { entry: "project", project: "github.com/acme/web", settings: {}, estates: [] } },
    ]);
    expect(() => readEntries(dir, two.run)).toThrow(/two active records/);
    const bad = fakeChant([{ id: "ctl-001", state: "active", valid: false, digest: "a", data: {} }]);
    expect(() => readEntries(dir, bad.run)).toThrow(/ctl-001/);
  });

  it("surfaces a refused write with chant's own code", () => {
    const dir = repo();
    const run: ChantRunner = () => ({ status: 1, stdout: JSON.stringify({ error: { code: "write-lock-timeout", message: "held" } }), stderr: "" });
    expect(() => readEntries(dir, run)).toThrow(/write-lock-timeout/);
  });

  it("imports a terragucci.yml-shaped config, defaults first", () => {
    const dir = repo();
    const { run, calls } = fakeChant();
    const out = importControlConfig(dir, { defaults: { gate: "always" }, projects: { "github.com/acme/web": {} } }, run);
    expect(out.map((o) => [o.entry, o.status])).toEqual([["defaults", "created"], ["github.com/acme/web", "created"]]);
    expect(calls.filter((c) => c.args[2] === "new")).toHaveLength(2);
    expect(() => importControlConfig(dir, {}, run)).toThrow(/lists projects/);
  });

  it("a read of a repo with no kind says how to start", () => {
    expect(() => readEntries(tmp(), fakeChant().run)).toThrow(/control records init/);
  });
});

describe("estate ownership: resolved at each plan", () => {
  const entry = (project: string, estates: string[]): ControlEntry => ({ id: project, path: "", digest: "", entry: "project", project, settings: {}, estates });
  const claims = estateClaims([entry("github.com/acme/net", ["net"]), entry("github.com/acme/app", ["app"])]);

  it("names the owner of an estate a root reads from another project", () => {
    const r = checkOwnership({ self: "github.com/acme/app", local: new Map([["app", "envs/app"]]), reads: new Map([["envs/app", [{ name: "net", estate: "net" }]]]), claims });
    expect(r.refusals).toEqual([]);
    expect(r.owners.get("net")).toBe("github.com/acme/net");
    expect(r.notes[0]).toContain("owned by github.com/acme/net");
  });

  it("notes a read nobody owns, and does not stop the plan", () => {
    const r = checkOwnership({ self: "github.com/acme/app", local: new Map(), reads: new Map([["envs/app", [{ name: "x", estate: "ghost" }]]]), claims });
    expect(r.refusals).toEqual([]);
    expect(r.notes[0]).toContain("no project");
  });

  it("refuses an estate two projects claim, and one the records give to another project", () => {
    const both = estateClaims([entry("github.com/acme/net", ["net"]), entry("github.com/acme/app", ["net"])]);
    expect(checkOwnership({ local: new Map(), reads: new Map(), claims: both }).refusals[0]).toMatch(/claimed by .* and /);
    const r = checkOwnership({ self: "github.com/acme/app", local: new Map([["net", "envs/net"]]), reads: new Map(), claims });
    expect(r.refusals[0]).toContain("owns estate net");
    expect(r.refusals[0]).toContain("github.com/acme/net");
  });

  it("reads the records at the time of each call, not once", () => {
    const dir = repo();
    const recs: Rec[] = [];
    const { run } = fakeChant(recs);
    const env = { TERRAGUCCI_CONTROL_DIR: dir };
    expect(controlClaims(undefined, env, run)!.size).toBe(0);
    putEntry(dir, { entry: "project", project: "github.com/acme/net", settings: {}, estates: ["net"] }, run);
    expect(controlClaims(undefined, env, run)!.get("net")).toEqual(["github.com/acme/net"]);
  });

  it("has nothing to ask without a checkout or a read token", () => {
    expect(controlClaims({ repo: "github.com/acme/control", op: "deploy" }, {})).toBeUndefined();
  });

  it("clones the control repo with the read token, and never prints the token", () => {
    const { run } = fakeChant([{ id: "ctl-001", state: "active", digest: "a", data: { entry: "project", project: "github.com/acme/net", settings: {}, estates: ["net"] } }]);
    let url = "";
    const got = controlClaims({ repo: "github.com/acme/control", op: "deploy" }, { TERRAGUCCI_CONTROL_READ_TOKEN: "s3cret" }, run, (u, into) => {
      url = u;
      initRecords(into);
    });
    expect(got!.get("net")).toEqual(["github.com/acme/net"]);
    expect(url).toContain("s3cret");
    expect(() => controlClaims({ repo: "github.com/acme/control", op: "deploy" }, { TERRAGUCCI_CONTROL_READ_TOKEN: "s3cret" }, run, () => {
      throw new Error("fatal: bad credentials for https://oauth2:s3cret@github.com/acme/control.git");
    })).toThrow(expect.objectContaining({ message: expect.not.stringContaining("s3cret") }));
  });

  it("knows its project from the CI environment", () => {
    expect(projectKeyFromEnv({ GITHUB_REPOSITORY: "acme/app" })).toBe("github.com/acme/app");
    expect(projectKeyFromEnv({ GITHUB_REPOSITORY: "acme/app", GITHUB_SERVER_URL: "https://git.example.com" })).toBe("git.example.com/acme/app");
    expect(projectKeyFromEnv({ CI_PROJECT_PATH: "g/s/app", CI_SERVER_HOST: "gitlab.com" })).toBe("gitlab.com/g/s/app");
    expect(projectKeyFromEnv({})).toBeUndefined();
  });
});

// With TERRAGUCCI_CHANT set to a chant 0.124.47 bin, the same calls run against the real thing.
describe.skipIf(!process.env.TERRAGUCCI_CHANT)("control records against real chant", () => {
  it("writes, amends and reads back", () => {
    const dir = tmp();
    execFileSync("git", ["init", "-q"], { cwd: dir });
    initRecords(dir);
    putEntry(dir, { entry: "project", project: "github.com/acme/net", settings: { binary: "tofu" }, estates: ["net"] });
    putEntry(dir, { entry: "project", project: "github.com/acme/net", settings: { binary: "terraform" } });
    expect(existsSync(join(dir, "terragucci/records"))).toBe(true);
    const cfg = configFromEntries(readEntries(dir));
    expect(cfg.projects!["github.com/acme/net"]).toEqual({ binary: "terraform" });
    expect(estateClaims(readEntries(dir)).get("net")).toEqual(["github.com/acme/net"]);
  });
});
