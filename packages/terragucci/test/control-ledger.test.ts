// The control repo on chant core (chant#4568, terragucci#1282 part d). With `@intentius/chant/ci-control` the
// entries are lines of `_control/entries.jsonl` on the control repo's chant/lifecycle, the member's dispatch is
// chant's script, and `control records migrate` moves the record files onto the ledger. Without it, terragucci's
// record files and scripts. Each case stands a module in for chant's, makes it missing, or runs only when the
// installed chant has it.
import { afterEach, describe, expect, it } from "vitest";
import { chantCiControl, overrideChantNext, type ChantCiControl, type ChantControlEntry, type ChantControlLedgerPort } from "../src/chant-next";
import { ConfigError } from "../src/config";
import { initRecords, LEDGER_PATH, migrateRecords, putEntryAt, readEntriesAt, retireEntryAt, validateSettings, type ChantRunner } from "../src/control-records";
import { controlCloneScript, controlLifecycleStep, dispatchScript, resolveControl } from "../src/control-repo";
import { git, tmp } from "./helpers";

const real = await chantCiControl();

let restore: (() => void)[] = [];
afterEach(() => {
  for (const r of restore) r();
  restore = [];
});

/** A chant control module over an in-memory ledger, recording the calls terragucci makes. */
function fakeControl(lines: string[] = []): { chant: ChantCiControl; calls: string[] } {
  const calls: string[] = [];
  const port: ChantControlLedgerPort = {
    read: async () => (lines.length ? `${lines.join("\n")}\n` : null),
    append: async (line) => {
      lines.push(line);
      return "c0ffee";
    },
  };
  const entries = (): ChantControlEntry[] => lines.map((l) => JSON.parse(l) as ChantControlEntry);
  const chant = {
    gitControlLedger: () => port,
    readControlEntries: async (_p: ChantControlLedgerPort, o?: { validate?: (e: "project" | "defaults", p: string | undefined, s: Record<string, unknown>) => string[] }) => {
      calls.push(`read validate=${o?.validate ? "yes" : "no"}`);
      return entries();
    },
    putControlEntry: async (_p: ChantControlLedgerPort, want: { entry: "project" | "defaults"; project?: string; settings: Record<string, unknown> }, o: { product: string; dryRun?: boolean }) => {
      calls.push(`put ${want.project ?? "defaults"} product=${o.product} dryRun=${o.dryRun === true}`);
      return { id: "ctl-002", status: "created" as const };
    },
    retireControlEntry: async (_p: ChantControlLedgerPort, project: string) => {
      calls.push(`retire ${project}`);
      return { id: "ctl-001", status: "retired" as const };
    },
    importControlConfig: async (_p: ChantControlLedgerPort, config: { projects: Record<string, unknown>; estates?: Record<string, string[]> }) => {
      calls.push(`import ${Object.keys(config.projects).join(",")} estates=${JSON.stringify(config.estates ?? {})}`);
      return Object.keys(config.projects).map((entry, i) => ({ entry, id: `ctl-00${i + 1}`, status: "created" as const }));
    },
    estateClaims: () => new Map(),
    resolveControlTarget: (input: { repo: string; op: string; member?: string; tokenSecret?: string; readTokenSecret?: string; ref?: string }) => {
      calls.push(`target token=${input.tokenSecret} read=${input.readTokenSecret}`);
      return { repo: input.repo, host: "github.com", path: "acme/control", forge: "github" as const, apiBase: "https://api.github.com", op: input.op, member: input.member ?? "m", ref: input.ref ?? "main", tokenSecret: input.tokenSecret ?? "", readTokenSecret: input.readTokenSecret ?? "" };
    },
    controlDispatchScript: (_t: unknown, o?: { sentCheck?: string; markSent?: string }) => `chant-dispatch sent=${o?.sentCheck ?? ""} mark=${o?.markSent ?? ""}`,
    controlStatusContext: () => "terragucci/control",
  } as unknown as ChantCiControl;
  return { chant, calls };
}

const entryLine = (project: string): string =>
  JSON.stringify({ id: "ctl-001", entry: "project", project, settings: {}, estates: ["net"], digest: "d1", at: "2026-10-27T00:00:00Z" });

/** File records as chant's `workspace records` answers for them. */
const fileRun = (): ChantRunner => () => ({
  status: 0,
  stdout: JSON.stringify({ records: [{ id: "ctl-001", state: "active", valid: true, digest: "f1", path: "terragucci/records/ctl-001.md", data: { entry: "project", project: "github.com/acme/app", settings: {}, estates: ["net"] } }] }),
  stderr: "",
});

const control = { repo: "github.com/acme/control", op: "deploy" };

describe("control entries on the ledger", () => {
  it("reads and writes the record files on a chant without the control repo", async () => {
    restore.push(overrideChantNext("ciControl", null));
    const dir = tmp();
    initRecords(dir);
    const entries = await readEntriesAt(dir, fileRun());
    expect(entries.map((e) => [e.project, e.path])).toEqual([["github.com/acme/app", "terragucci/records/ctl-001.md"]]);
    await expect(migrateRecords(dir, fileRun())).rejects.toThrow(ConfigError);
  });

  it("keeps the record files while the ledger has no entries", async () => {
    const { chant, calls } = fakeControl();
    restore.push(overrideChantNext("ciControl", chant));
    const dir = tmp();
    initRecords(dir);
    const entries = await readEntriesAt(dir, fileRun());
    expect(entries[0]!.path).toBe("terragucci/records/ctl-001.md");
    expect(calls).toEqual([]);
  });

  it("reads, writes and retires on the ledger once it has entries", async () => {
    const { chant, calls } = fakeControl([entryLine("github.com/acme/app")]);
    restore.push(overrideChantNext("ciControl", chant));
    const dir = tmp();
    const entries = await readEntriesAt(dir);
    expect(entries).toEqual([{ id: "ctl-001", path: LEDGER_PATH, digest: "d1", entry: "project", project: "github.com/acme/app", settings: {}, estates: ["net"] }]);
    expect((await putEntryAt(dir, { entry: "project", project: "github.com/acme/web", settings: {} }, undefined, true)).path).toBe(LEDGER_PATH);
    expect((await retireEntryAt(dir, "github.com/acme/app")).status).toBe("updated");
    expect(calls).toEqual(["read validate=yes", "put github.com/acme/web product=terragucci dryRun=true", "retire github.com/acme/app"]);
  });

  it("moves the record files onto the ledger with their estates", async () => {
    const { chant, calls } = fakeControl();
    restore.push(overrideChantNext("ciControl", chant));
    const dir = tmp();
    initRecords(dir);
    const r = await migrateRecords(dir, fileRun());
    expect(r.results.map((x) => [x.entry, x.status])).toEqual([["github.com/acme/app", "created"]]);
    expect(r.files).toEqual(["terragucci/records/ctl-001.md"]);
    expect(calls).toEqual([`import github.com/acme/app estates={"github.com/acme/app":["net"]}`]);
  });

  it("checks an entry's settings with terragucci's config", () => {
    expect(validateSettings("project", "github.com/acme/app", {})).toEqual([]);
    expect(validateSettings("project", "not a key", {}).length).toBeGreaterThan(0);
  });

  it.runIf(real)("moves records onto a real control repo's chant/lifecycle and reads them back", async () => {
    const dir = tmp();
    git(dir, "init", "-q", "-b", "main");
    git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "init");
    initRecords(dir);
    await migrateRecords(dir, fileRun());
    expect(git(dir, "show", "chant/lifecycle:_control/entries.jsonl")).toContain("github.com/acme/app");
    const entries = await readEntriesAt(dir);
    expect(entries.map((e) => [e.project, e.estates, e.path])).toEqual([["github.com/acme/app", ["net"], LEDGER_PATH]]);
  });
});

describe("the member's dispatch and the read checkout", () => {
  it("are terragucci's own on a chant without the control repo", async () => {
    restore.push(overrideChantNext("ciControl", null));
    await chantCiControl();
    const c = resolveControl(control, "app");
    expect(dispatchScript(c, "github")).toContain("TG_CONTROL_TOKEN");
    expect(controlLifecycleStep(c)).toBeUndefined();
    expect(controlCloneScript(c)).not.toContain("chant/lifecycle");
  });

  it("are chant's with terragucci's secrets and mark on a chant with it", async () => {
    const { chant, calls } = fakeControl();
    restore.push(overrideChantNext("ciControl", chant));
    const c = resolveControl({ ...control, token_env: "MY_DISPATCH", read_token_env: "MY_READ" }, "app");
    const script = dispatchScript(c, "github");
    expect(script.split("\n").slice(0, 3)).toEqual(['export CHANT_CONTROL_TOKEN="${TG_CONTROL_TOKEN:-}"', 'export CHANT_CONTROL_SHA="${TG_SHA:-}"', "export TG_FORGE=github"]);
    expect(script).toContain("chant-dispatch sent=terragucci post sent terragucci/control");
    expect(calls).toEqual(["target token=MY_DISPATCH read=MY_READ"]);
    expect(dispatchScript(c, "gitlab")).toContain("chant-dispatch sent= mark=");
    expect(controlLifecycleStep(c)).toBeDefined();
    expect(controlCloneScript(c)).toContain("refs/heads/chant/lifecycle");
  });
});
