// The control repo on chant core (chant#4568). The entries are lines of `_control/entries.jsonl` on the control
// repo's chant/lifecycle, and the member's dispatch is chant's script. A case stands a fake in for chant's control
// module with vi.mock, or runs on the real one.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChantCiControl, ChantControlEntry, ChantControlLedgerPort } from "../src/chant-next";
import { importControlConfigAt, LEDGER_PATH, putEntryAt, readEntriesAt, retireEntryAt, validateSettings } from "../src/control-records";
import { dispatchScript, resolveControl } from "../src/control-repo";
import { git, tmp } from "./helpers";

/** The fake chant's control module calls go to, when a case sets one. */
const stand = vi.hoisted((): { in?: ChantCiControl } => ({}));
vi.mock("@intentius/chant/ci-control", async (real: () => Promise<Record<string, unknown>>) => {
  const FAKED = ["gitControlLedger", "readControlEntries", "putControlEntry", "retireControlEntry", "importControlConfig", "estateClaims", "resolveControlTarget", "controlDispatchScript", "controlStatusContext"];
  const m = await real();
  const out: Record<string, unknown> = { ...m };
  for (const name of FAKED) out[name] = (...args: unknown[]) => ((stand.in as unknown as Record<string, (...a: unknown[]) => unknown> | undefined)?.[name] ?? (m[name] as (...a: unknown[]) => unknown))(...args);
  return out;
});

afterEach(() => {
  delete stand.in;
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

const control = { repo: "github.com/acme/control", op: "deploy" };

describe("control entries on the ledger", () => {
  it("reads an empty ledger as no entries, and writes the first one there", async () => {
    const { chant, calls } = fakeControl();
    stand.in = chant;
    const dir = tmp();
    expect(await readEntriesAt(dir)).toEqual([]);
    expect((await putEntryAt(dir, { entry: "project", project: "github.com/acme/web", settings: {} })).path).toBe(LEDGER_PATH);
    expect(calls).toEqual(["read validate=yes", "put github.com/acme/web product=terragucci dryRun=false"]);
  });

  it("reads, writes and retires on the ledger once it has entries", async () => {
    const { chant, calls } = fakeControl([entryLine("github.com/acme/app")]);
    stand.in = chant;
    const dir = tmp();
    const entries = await readEntriesAt(dir);
    expect(entries).toEqual([{ id: "ctl-001", path: LEDGER_PATH, digest: "d1", entry: "project", project: "github.com/acme/app", settings: {}, estates: ["net"] }]);
    expect((await putEntryAt(dir, { entry: "project", project: "github.com/acme/web", settings: {} }, true)).path).toBe(LEDGER_PATH);
    expect((await retireEntryAt(dir, "github.com/acme/app")).status).toBe("updated");
    expect(calls).toEqual(["read validate=yes", "put github.com/acme/web product=terragucci dryRun=true", "retire github.com/acme/app"]);
  });

  it("imports a terragucci.yml-shaped config onto the ledger", async () => {
    const { chant, calls } = fakeControl();
    stand.in = chant;
    const dir = tmp();
    const out = await importControlConfigAt(dir, { defaults: { gate: "always" }, projects: { "github.com/acme/web": {} } });
    expect(out.map((o) => [o.entry, o.status, o.path])).toEqual([["github.com/acme/web", "created", LEDGER_PATH]]);
    expect(calls).toEqual(["import github.com/acme/web estates={}"]);
    await expect(importControlConfigAt(dir, {})).rejects.toThrow(/lists projects/);
  });

  it("checks an entry's settings with terragucci's config", () => {
    expect(validateSettings("project", "github.com/acme/app", {})).toEqual([]);
    expect(validateSettings("project", "not a key", {}).length).toBeGreaterThan(0);
  });

  it("writes, amends and retires on a real control repo's chant/lifecycle and reads them back", async () => {
    const dir = tmp();
    git(dir, "init", "-q", "-b", "main");
    git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "init");
    expect(await readEntriesAt(dir)).toEqual([]);
    expect((await putEntryAt(dir, { entry: "project", project: "github.com/acme/app", settings: { binary: "tofu" }, estates: ["net"] })).status).toBe("created");
    expect((await putEntryAt(dir, { entry: "project", project: "github.com/acme/app", settings: { binary: "terraform" } })).status).toBe("updated");
    await putEntryAt(dir, { entry: "project", project: "github.com/acme/web", settings: {} });
    await retireEntryAt(dir, "github.com/acme/web");
    expect(git(dir, "show", "chant/lifecycle:_control/entries.jsonl")).toContain("github.com/acme/app");
    const entries = await readEntriesAt(dir);
    expect(entries.map((e) => [e.project, e.settings, e.estates, e.path])).toEqual([["github.com/acme/app", { binary: "terraform" }, ["net"], LEDGER_PATH]]);
  });
});

describe("the member's dispatch", () => {
  it("is chant's, with terragucci's secrets and mark", async () => {
    const { chant, calls } = fakeControl();
    stand.in = chant;
    const c = resolveControl({ ...control, token_env: "MY_DISPATCH", read_token_env: "MY_READ" }, "app");
    const script = dispatchScript(c, "github");
    expect(script.split("\n").slice(0, 3)).toEqual(['export CHANT_CONTROL_TOKEN="${TG_CONTROL_TOKEN:-}"', 'export CHANT_CONTROL_SHA="${TG_SHA:-}"', "export TG_FORGE=github"]);
    expect(script).toContain("chant-dispatch sent=terragucci post sent terragucci/control");
    expect(calls).toEqual(["target token=MY_DISPATCH read=MY_READ"]);
    expect(dispatchScript(c, "gitlab")).toContain("chant-dispatch sent= mark=");
    stand.in = undefined;
  });
});
