import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ACTION_APPLIED, ACTION_LEDGER, ACTION_NEEDS_CHANT, actionApproveCommand, engineRefusal, noActionReply, resumableActions, resumeActions, runAction, type ActionOptions } from "../src/action";
import { appendLifecycle } from "../src/apply";
import { approveGate, isGateKeyword } from "../src/approve";
import { chantInvokeAction, overrideChantNext, type ChantGatedRequestRead, type ChantInvokeActionInput } from "../src/chant-next";
import { main } from "../src/cli";
import { decideComment, parseComment, readActionDispatch } from "../src/comment";
import { ACTION_PATHS, renderPipeline, type PipelineInput } from "../src/render";
import { ACTION_APPLIED_FILE, ACTION_LEDGER_FILE, AUDIT_KINDS, joinActionRequesters, ledgerEntries } from "../src/report/audit";
import { gateLedgerLinesFromLog } from "@intentius/chant/lifecycle/gate-audit";
import { git, tmp, validate, write, type Json } from "./helpers";
import { appliedLines } from "./gated-helpers";

const LAYERS = [["apps/orders", "apps/web"]];
const ADDRESS = "action.aws_lambda_invoke.rotate";
const D = "sha256:" + "a".repeat(64);
const T = (m: number): string => new Date(Date.UTC(2026, 9, 28, 12, m)).toISOString();

/** The installed chant has the terraform lexicon's invokeAction (chant#4653). */
const hasAction = !!(await chantInvokeAction());

describe("the action comment", () => {
  it("reads /terragucci action <root> <address>, a module's action included", () => {
    expect(parseComment(`/terragucci action apps/orders ${ADDRESS}`)).toEqual({ kind: "action", root: "apps/orders", address: ADDRESS });
    expect(parseComment(`/terragucci action apps/orders module.app.${ADDRESS}`, { layers: LAYERS })).toEqual({ kind: "action", root: "apps/orders", address: `module.app.${ADDRESS}` });
    expect(parseComment(`/terragucci action apps/orders module.app["blue"].action.t.l[0]`)).toEqual({ kind: "action", root: "apps/orders", address: 'module.app["blue"].action.t.l[0]' });
  });

  it("refuses shell words, a missing or extra word, a non-action address and a root the pipeline was not written with, each with a reason", () => {
    for (const body of [
      "/terragucci action apps/orders ; rm",
      "/terragucci action apps/orders",
      "/terragucci action",
      `/terragucci action apps/orders ${ADDRESS} extra`,
      `/terragucci action ../etc ${ADDRESS}`,
      "/terragucci action apps/orders $(id)",
      `/terragucci action apps/orders ${ADDRESS}\nrm -rf /`,
      "/terragucci action apps/orders aws_lambda_function.x",
      "/terragucci action apps/orders -target=x",
    ]) {
      const p = parseComment(body, { layers: LAYERS });
      expect(p?.kind, body).toBe("refused");
      expect((p as { reason: string }).reason.length, body).toBeGreaterThan(10);
    }
    expect(parseComment(`/terragucci action apps/billing ${ADDRESS}`, { layers: LAYERS })).toEqual({ kind: "refused", reason: "apps/billing is not a root of this repository. The roots are `apps/orders`, `apps/web`." });
  });

  it("reads a dispatch's root and address as the same comment", () => {
    expect(readActionDispatch({ root: "apps/orders", address: ADDRESS }, LAYERS)).toEqual({ parsed: { kind: "action", root: "apps/orders", address: ADDRESS } });
    expect(readActionDispatch({ root: "apps/orders", address: "x; rm" }, LAYERS)).toMatchObject({ parsed: { kind: "refused" } });
    expect(readActionDispatch({ root: "apps/orders" }, LAYERS)).toMatchObject({ error: expect.stringContaining("root and address") });
  });

  it("the action job takes a Forgejo dispatch, and leaves every other comment to the pipeline's jobs", async () => {
    const dir = tmp("tg-action-event-");
    const env = (event: unknown, name: string) => {
      const path = join(dir, `${name}.json`);
      writeFileSync(path, JSON.stringify(event));
      return { GITHUB_EVENT_PATH: path, GITHUB_EVENT_NAME: name, GITHUB_REPOSITORY: "o/r", GITHUB_SERVER_URL: "http://forge.test", TG_TOKEN: "t" };
    };
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const dispatch = await decideComment({ layers: LAYERS, forge: "forgejo", action: "run", env: env({ inputs: { root: "apps/orders", address: ADDRESS }, sender: { login: "alice" }, repository: { full_name: "o/r" } }, "workflow_dispatch") });
      expect(dispatch).toEqual({ go: true, reason: `run ${ADDRESS} on apps/orders for alice`, root: "apps/orders", address: ADDRESS, user: "alice" });
      const plan = await decideComment({ layers: LAYERS, forge: "forgejo", action: "run", env: env({ action: "created", comment: { body: "/terragucci plan", user: { login: "alice" } }, issue: { number: 3, pull_request: {} }, sender: { login: "alice" }, repository: { full_name: "o/r", permissions: { push: true } } }, "issue_comment") });
      expect(plan).toEqual({ go: false, reason: "another job reads this comment" });
    } finally {
      log.mockRestore();
    }
  });

  it("where the pipeline has no action workflow, the reply names the engine and its version", () => {
    expect(noActionReply("tofu")).toBe("an action runs on Terraform 1.14 or newer, and this repository's roots run OpenTofu (tofu 1.13.1), which has no action invocation");
    expect(noActionReply("terraform")).toMatch(/no action workflow/);
  });
});

/** Run the CLI in `dir` and return its exit code and stdout. */
async function cli(dir: string, ...argv: string[]): Promise<{ code: number; out: string }> {
  const cwd = process.cwd();
  const lines: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void lines.push(a.join(" ")));
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  process.chdir(dir);
  try {
    return { code: await main(argv), out: lines.join("\n") };
  } finally {
    process.chdir(cwd);
    log.mockRestore();
    err.mockRestore();
  }
}

/** A checkout with one Terraform root and a bare origin for chant/lifecycle, and a binary that inits and nothing else. */
function repo(binary = "terraform"): { work: string; origin: string; bin: string } {
  const dir = tmp("tg-action-");
  const origin = join(dir, "origin.git");
  git(dir, "init", "-q", "--bare", origin);
  const work = join(dir, "work");
  mkdirSync(work);
  write(work, { "apps/orders/main.tf": 'action "aws_lambda_invoke" "rotate" {}\n', "terragucci.yml": `binary: ${binary}\nforge: forgejo\nurl: http://forge.test/o/r\n` });
  git(work, "init", "-q", "-b", "main");
  git(work, "add", "-A");
  git(work, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "base");
  git(work, "remote", "add", "origin", origin);
  git(work, "push", "-q", "origin", "main");
  const bin = join(dir, "bin", "terraform");
  write(join(dir, "bin"), { terraform: "#!/bin/sh\nexit 0\n" });
  chmodSync(bin, 0o755);
  return { work, origin, bin };
}

describe("terragucci action", () => {
  let restore: (() => void) | undefined;
  afterEach(() => {
    restore?.();
    restore = undefined;
  });

  it("with a fake chant, waits with exit 3 and prints the digest and the approve line as JSON", async () => {
    const r = repo();
    const asked: ChantInvokeActionInput[] = [];
    const ops = (await import("../src/chant-next")).chantStateOps;
    const base = (await ops()) ?? {};
    restore = overrideChantNext("stateOps", {
      ...base,
      readGatedRequests: async () => [],
      invokeAction: async (input: ChantInvokeActionInput) => {
        asked.push(input);
        return { outcome: "gated", digest: D, subject: `${input.root}:${input.address}`, command: "chant approve", exit: 3 };
      },
    });
    const done = await cli(r.work, "action", "apps/orders", ADDRESS, "--json", "--binary", r.bin, "--actor", "alice");
    expect(done.code).toBe(3);
    expect(JSON.parse(done.out)).toEqual({ status: "gated", root: "apps/orders", address: ADDRESS, digest: D, approve: `terragucci approve action apps/orders --plan ${D}` });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ root: "apps/orders", address: ADDRESS, requester: "alice", binary: r.bin, cwd: realpathSync(r.work), anew: true, rules: { mode: "ledger" } });
    // The saved plan is outside the checkout.
    expect(asked[0]!.planFile!.startsWith(realpathSync(r.work))).toBe(false);
  });

  it("refuses a root on OpenTofu by its engine and version, before any binary runs, on any chant", async () => {
    const r = repo("tofu");
    const done = await cli(r.work, "action", "apps/orders", ADDRESS, "--json");
    expect(done.code).toBe(1);
    expect(JSON.parse(done.out)).toEqual({ status: "refused", root: "apps/orders", address: ADDRESS, reason: "apps/orders: an action runs on Terraform 1.14 or newer, and this root runs OpenTofu (tofu 1.13.1), which has no action invocation" });
    expect(engineRefusal("x", "choudoufu")).toContain("choudoufu (choudoufu 0.31.0)");
    expect(engineRefusal("x", "terraform")).toBeUndefined();
    const text = await cli(r.work, "action", "apps/orders", ADDRESS);
    expect(text.out).toContain("tofu 1.13.1");
  });

  it("on a chant without invokeAction, refuses naming the chant it needs", async () => {
    const r = repo();
    restore = overrideChantNext("stateOps", { readGatedRequests: async () => [] });
    const done = await cli(r.work, "action", "apps/orders", ADDRESS, "--json", "--binary", r.bin);
    expect(done.code).toBe(1);
    expect(JSON.parse(done.out).reason).toBe(ACTION_NEEDS_CHANT);
  });

  it("refuses an address that is no action address, and a path that is no root", async () => {
    const r = repo();
    expect((await cli(r.work, "action", "apps/orders", "aws_lambda_function.x", "--json", "--binary", r.bin)).code).toBe(1);
    expect((await cli(r.work, "action", "apps/nowhere", ADDRESS, "--binary", r.bin)).code).toBe(1);
  });

  it.runIf(hasAction)("on chant's gated request: waits, runs once someone else approved, and records how it ended", async () => {
    const r = repo();
    const calls: string[][] = [];
    const plan = { format_version: "1.2", action_invocations: [{ address: ADDRESS, type: "aws_lambda_invoke", name: "rotate", config_values: { function_name: "rotate-keys" } }] };
    const exec: NonNullable<ActionOptions["exec"]> = (_bin, args) => {
      calls.push(args);
      if (args[0] === "version") return { status: 0, stdout: JSON.stringify({ terraform_version: "1.14.9" }), out: "" };
      if (args[0] === "show") return { status: 0, stdout: JSON.stringify(plan), out: "" };
      if (args[0] === "apply") return { status: 0, stdout: "Action invoked.", out: "Action invoked." };
      return { status: 0, stdout: "", out: "" };
    };
    const ask = (actor: string, m: number) => runAction(r.work, { root: "apps/orders", address: ADDRESS, actor, binary: r.bin, exec, now: T(m) });
    const first = await ask("alice", 1);
    expect(first.code).toBe(3);
    expect(first.json.status).toBe("gated");
    expect(first.json.approve).toBe(actionApproveCommand("apps/orders", first.json.digest!));
    expect(calls.some((c) => c[0] === "apply")).toBe(false);
    expect(calls.find((c) => c[0] === "plan")).toContain(`-invoke=${ADDRESS}`);

    // The requester's own approval does not count; approve action says so before chant runs.
    const said: string[] = [];
    expect((await approveGate(r.work, { kind: "action", target: "apps/orders", plan: first.json.digest!, actor: "alice", dryRun: true, log: (l) => void said.push(l) })).code).toBe(1);
    expect(said.join("\n")).toContain("the requester's own approval never counts");

    appendLifecycle(r.work, ACTION_LEDGER, [JSON.stringify({ version: 1, kind: "resolution", op: "tf-action", gate: `apps/orders:${ADDRESS}`, resolvedBy: "bob", timestamp: T(2), planDigest: first.json.digest })], {}, "approve");
    // The resume job sees it, and runs it as alice.
    const listed = await resumeActions(r.work, { dryRun: true, now: T(3), log: () => {} });
    expect(listed.actions).toEqual([{ root: "apps/orders", address: ADDRESS, digest: first.json.digest, requester: "alice", approvedBy: "bob" }]);
    const resumed = await resumeActions(r.work, { exec, now: T(3), log: () => {} });
    expect(resumed.code).toBe(0);
    expect(resumed.results[0]!.json).toMatchObject({ status: "ok", approvedBy: "bob", digest: first.json.digest });
    expect(calls.filter((c) => c[0] === "apply")).toHaveLength(1);
    const show = execFileSync("git", ["--git-dir", r.origin, "show", `chant/lifecycle:${ACTION_APPLIED}`], { encoding: "utf-8" });
    const { finished } = appliedLines(show);
    expect(finished.at(-1)).toMatchObject({ gate: `apps/orders:${ADDRESS}`, result: "applied", detail: { result: "ok", address: ADDRESS } });
    // Spent: nothing is left for the resume job.
    expect((await resumeActions(r.work, { dryRun: true, now: T(4), log: () => {} })).actions).toEqual([]);
  });
});

describe("terragucci approve action", () => {
  function checkout(lines: unknown[]): string {
    const dir = tmp("tg-approve-action-");
    const origin = join(dir, "origin.git");
    execFileSync("git", ["init", "-q", "--bare", origin]);
    const life = join(dir, "life");
    git(dir, "init", "-q", "-b", "chant/lifecycle", life);
    write(life, { [ACTION_LEDGER]: lines.map((l) => JSON.stringify(l)).join("\n") + "\n" });
    git(life, "add", "-A");
    git(life, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "ledger");
    git(life, "push", "-q", origin, "chant/lifecycle");
    const work = join(dir, "work");
    git(dir, "init", "-q", "-b", "main", work);
    git(work, "remote", "add", "origin", origin);
    return work;
  }
  const pending = { version: 1, kind: "pending", op: "tf-action", gate: `apps/orders:${ADDRESS}`, timestamp: T(1), expiresAt: "2999-01-01T00:00:00.000Z", planDigest: D, description: `action ${ADDRESS} on apps/orders, requested by alice`, request: { kind: "action", subject: `apps/orders:${ADDRESS}`, by: "alice", at: T(1), fields: { address: ADDRESS, invocations: D } } };

  it("is a keyword with a root after it", () => {
    expect(isGateKeyword(["action", "apps/orders"])).toBe(true);
    expect(isGateKeyword(["action"])).toBe(false);
  });

  it("--dry-run prints the ledger line it would write and exits 0", async () => {
    const work = checkout([pending]);
    const said: string[] = [];
    const r = await approveGate(work, { kind: "action", target: "apps/orders", plan: D, actor: "bob", dryRun: true, log: (l) => void said.push(l) });
    expect(r).toEqual({ code: 0, command: `chant approve tf-action apps/orders:${ADDRESS} --plan ${D} --actor bob` });
    const line = said.find((l) => l.startsWith(`would write to ${ACTION_LEDGER} on chant/lifecycle: `))!;
    expect(JSON.parse(line.slice(line.indexOf("{")))).toMatchObject({ version: 1, kind: "resolution", op: "tf-action", gate: `apps/orders:${ADDRESS}`, resolvedBy: "bob", planDigest: D });
    expect(said.at(-1)).toBe(`would run: ${r.command}`);
  });

  it("by the requester's identity exits 1 naming the rule, and a digest nothing waits for exits 1", async () => {
    const work = checkout([pending]);
    const said: string[] = [];
    expect(await approveGate(work, { kind: "action", target: "apps/orders", plan: D, actor: "alice", dryRun: true, log: (l) => void said.push(l) })).toEqual({ code: 1, command: "" });
    expect(said[0]).toBe(`not approved: alice asked for ${ADDRESS} on apps/orders, and the rule of a gated request is that the requester's own approval never counts; someone else approves it`);
    const stale: string[] = [];
    expect((await approveGate(work, { kind: "action", target: "apps/orders", plan: "sha256:" + "0".repeat(64), actor: "bob", dryRun: true, log: (l) => void stale.push(l) })).code).toBe(1);
    expect(stale[0]).toContain(`${ADDRESS} waits for ${D}`);
    await expect(approveGate(work, { kind: "action", target: "apps/orders", actor: "bob", dryRun: true, log: () => {} })).rejects.toThrow(/needs --plan <digest>/);
  });

  it("through the CLI too", async () => {
    const work = checkout([pending]);
    expect((await cli(work, "approve", "action", "apps/orders", "--plan", D, "--dry-run", "--actor", "bob")).code).toBe(0);
    expect((await cli(work, "approve", "action", "apps/orders", "--plan", D, "--dry-run", "--actor", "alice")).code).toBe(1);
  });
});

describe("the resume job's list", () => {
  const read = (over: Partial<ChantGatedRequestRead> = {}): ChantGatedRequestRead => ({
    op: "tf-action",
    gate: `apps/orders:${ADDRESS}`,
    digest: D,
    request: { kind: "action", subject: `apps/orders:${ADDRESS}`, by: "alice", at: T(1), fields: { address: ADDRESS } },
    pending: { timestamp: T(1), expiresAt: T(100) },
    approvals: [{ resolvedBy: "bob", timestamp: T(2) }],
    ...over,
  });
  it("is each request approved by someone else, not spent and not expired", () => {
    expect(resumableActions([read()], T(3))).toEqual([{ root: "apps/orders", address: ADDRESS, digest: D, requester: "alice", approvedBy: "bob" }]);
    expect(resumableActions([read({ approvals: [{ resolvedBy: "alice", timestamp: T(2) }] })], T(3))).toEqual([]);
    expect(resumableActions([read({ applied: { timestamp: T(4) } })], T(5))).toEqual([]);
    expect(resumableActions([read()], T(101))).toEqual([]);
    expect(resumableActions([read({ approvals: [] })], T(3))).toEqual([]);
  });
});

describe("the action audit kinds", () => {
  const AUDIT = JSON.parse(readFileSync(join(import.meta.dirname, "../src/report/audit.schema.json"), "utf-8")) as Json;
  const line = (text: string, commit: string) => ({ text, commit, author: "t", at: T(0), removed: false });
  const lines = (...texts: string[]) => texts.map((t, i) => line(t, `c${i}`)) as never;

  it("AUDIT_KINDS and the schema carry action-requested and action, and a fixture of each validates", () => {
    expect(AUDIT_KINDS).toContain("action-requested");
    expect(AUDIT_KINDS).toContain("action");
    expect((AUDIT.properties as { kind: { enum: string[] } }).kind.enum).toEqual([...AUDIT_KINDS]);
    const gate = `apps/orders:${ADDRESS}`;
    const requested = ledgerEntries("h/o/r", ACTION_LEDGER_FILE, lines(
      JSON.stringify({ version: 1, kind: "pending", op: "tf-action", gate, timestamp: T(1), expiresAt: T(49), planDigest: D, description: "action", request: { kind: "action", subject: gate, by: "alice", at: T(1), fields: { address: ADDRESS, invocations: D } } }),
      JSON.stringify({ version: 1, kind: "resolution", op: "tf-action", gate, resolvedBy: "bob", timestamp: T(2), planDigest: D }),
    ));
    const ran = ledgerEntries("h/o/r", ACTION_APPLIED_FILE, lines(
      JSON.stringify({ version: 1, kind: "applied", op: "tf-action", gate, planDigest: D, approvedAt: T(2), approvedBy: "bob", timestamp: T(3) }),
      JSON.stringify({ version: 1, kind: "finished", op: "tf-action", gate, planDigest: D, applied: T(3), result: "applied", timestamp: T(4), detail: { result: "ok", exit: 0, tail: "Action invoked.", address: ADDRESS } }),
    ));
    const all = joinActionRequesters([...requested, ...ran]);
    const ask = all.find((e) => e.kind === "action-requested")!;
    expect(ask).toMatchObject({ who: "alice", what: gate, digest: D, result: "waiting", detail: { root: "apps/orders", address: ADDRESS, requester: "alice" } });
    expect(all.find((e) => e.kind === "approval")).toMatchObject({ who: "bob", what: gate, detail: { root: "apps/orders", address: ADDRESS } });
    const run = all.find((e) => e.kind === "action")!;
    expect(run).toMatchObject({ who: "bob", digest: D, result: "ok", detail: { root: "apps/orders", address: ADDRESS, approved_by: "bob", requester: "alice", exit: 0 } });
    for (const e of [ask, run]) expect(validate(AUDIT, e)).toEqual([]);
    // gateLedgerLinesFromLog reads the same lines from git history in the audit command.
    expect(typeof gateLedgerLinesFromLog).toBe("function");
  });
});

describe("the action workflow", () => {
  const input = (forge: "github" | "forgejo", over: Partial<PipelineInput> = {}): PipelineInput => ({ forge, binary: "terraform", version: "1.14.9", image: "img:1", layers: LAYERS, env: {}, ...over }) as PipelineInput;
  const golden = (name: string, text: string): void => {
    const path = join(import.meta.dirname, "golden", name);
    if (process.env.UPDATE_GOLDEN || !existsSync(path)) writeFileSync(path, text);
    expect(text).toBe(readFileSync(path, "utf-8"));
  };

  it.each(["github", "forgejo"] as const)("%s: terragucci-action.yml takes root and address on a dispatch (golden)", (forge) => {
    const r = renderPipeline(input(forge));
    const file = r.extra?.find((f) => f.path === ACTION_PATHS[forge]);
    expect(file?.path).toBe(forge === "github" ? ".github/workflows/terragucci-action.yml" : ".forgejo/workflows/terragucci-action.yml");
    expect(file!.content).toMatch(/workflow_dispatch:\n\s+inputs:\n\s+root:[\s\S]*address:/);
    golden(`action-${forge}.yml`, file!.content);
    // The re-plan job leaves action comments to it.
    expect(r.content).toContain("!startsWith(github.event.comment.body, '/terragucci action ')");
  });

  it.each(["github", "forgejo"] as const)("%s: the resume workflow runs approved actions in a job of its own", (forge) => {
    const r = renderPipeline(input(forge, { resume: 15 }));
    const resume = r.extra?.find((f) => f.path.endsWith("terragucci-resume.yml"))!.content;
    expect(resume).toContain("terragucci action --resume --dry-run --out terragucci-actions.txt");
  });

  it("is not written for OpenTofu, choudoufu or GitLab, whose pipelines run no action", () => {
    for (const binary of ["tofu", "choudoufu"] as const) expect(renderPipeline(input("github", { binary })).extra?.some((f) => f.path === ACTION_PATHS.github) ?? false).toBe(false);
    expect(renderPipeline({ ...input("github"), forge: "gitlab" } as PipelineInput).content).not.toContain("terragucci action");
  });
});
