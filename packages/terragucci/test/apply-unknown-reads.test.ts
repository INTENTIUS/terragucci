/**
 * A wave that read an upstream output unknown at review (#1012) is judged by
 * the plan that changed the upstream, not by a later plan that changes
 * nothing: a comment's apply (`/terragucci apply`) plans wave 1 again after it
 * applied, and that plan has every output known. A plan that changes nothing
 * on the commit's first run still settles the read: a direct push that
 * changes only the reader applies it.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyWave, parseApplied, parseLedger } from "../src/apply";
import { unknownReads } from "../src/unknown-reads";
import { git, write } from "./helpers";
import { T, approve, setup } from "./apply-helpers";

const state = (key: string) => `terraform {\n  backend "s3" {\n    bucket = "s"\n    key    = "${key}"\n  }\n}\n`;
const reads = `data "terraform_remote_state" "up" {\n  backend = "s3"\n  config = {\n    bucket = "s"\n    key    = "a.tfstate"\n  }\n}\n\nresource "terraform_data" "y" {\n  input = data.terraform_remote_state.up.outputs.id\n}\n`;

/** a's plan: creating x leaves its output id unknown; once applied, nothing changes and id is known. */
const created = { resource_changes: [{ address: "terraform_data.x", mode: "managed", type: "terraform_data", name: "x", change: { actions: ["create"], before: null, after: { input: "1" }, after_unknown: { output: true } } }], output_changes: { id: { actions: ["create"], before: null, after: null, after_unknown: true } } };
const settled = { resource_changes: [{ address: "terraform_data.x", mode: "managed", type: "terraform_data", name: "x", change: { actions: ["no-op"], before: { input: "1" }, after: { input: "1" }, after_unknown: {} } }], output_changes: { id: { actions: ["no-op"], before: "x-1", after: "x-1", after_unknown: false } } };
const bPlan = { resource_changes: [{ address: "terraform_data.y", mode: "managed", type: "terraform_data", name: "y", change: { actions: ["create"], before: null, after: { input: "x-1" }, after_unknown: {} } }] };

/** An in-memory bucket behind the S3 calls the reports make. */
function bucket(): Map<string, string> {
  const objects = new Map<string, string>();
  vi.stubGlobal("fetch", async (url: string, init: { method: string; body?: string | Uint8Array }) => {
    const key = url.split("?")[0]!;
    if (init.method === "PUT") {
      objects.set(key, typeof init.body === "string" ? init.body : new TextDecoder().decode(init.body ?? new Uint8Array()));
      return new Response("", { status: 200 });
    }
    if (init.method === "GET" || init.method === "HEAD") {
      const body = objects.get(key);
      return body === undefined ? new Response(null, { status: 404 }) : new Response(init.method === "GET" ? body : null, { status: 200 });
    }
    return new Response("", { status: 200 });
  });
  return objects;
}

describe("a wave that read an output unknown at review, applied again by a comment", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("still waits when its upstream's plan in the comment's run changes nothing, and applies once its plans are approved", async () => {
    const { work, origin, bin, log } = setup({
      "terragucci.yml": "reports:\n  bucket: s3://reports\n  endpoint: http://s3.test\n",
      "a/main.tf": state("a.tfstate"),
      "b/main.tf": state("b.tfstate") + reads,
    });
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    bucket();
    const plans = join(work, "..", "plans");
    writeFileSync(join(plans, "a.json"), JSON.stringify(created));
    writeFileSync(join(plans, "b.json"), JSON.stringify(bPlan));
    const opts = { layers: [["a"], ["b"]], binary: bin, gate: "on-destructive" as const, env: { AWS_ACCESS_KEY_ID: "AK", AWS_SECRET_ACCESS_KEY: "SK" } };
    const said = () => out.mock.calls.flat().join("\n");

    // The merge: wave 1 creates a, whose id is unknown until it applies; wave 2 plans b on the id a applied and waits.
    expect(await applyWave(work, { ...opts, wave: 1, now: T(1) })).toBe(0);
    expect(await applyWave(work, { ...opts, wave: 2, now: T(1) })).toBe(3);
    expect(said()).toContain("b read id of a, unknown in wave 1's plan of a in this push");

    // The comment's apply: wave 1 plans again, changes nothing, and its report is the newest of this commit's wave 1.
    writeFileSync(join(plans, "a.json"), JSON.stringify(settled));
    expect(await applyWave(work, { ...opts, wave: 1, now: T(2) })).toBe(0);
    out.mockClear();
    writeFileSync(log, "");
    expect(await applyWave(work, { ...opts, wave: 2, now: T(2) })).toBe(3);
    // changes.json still holds the merge's rows for a at this commit, so the comment's plan is not the first of this commit.
    expect(said()).toMatch(/wave 1's plan of a in this push \([^)]*\) changes nothing, and [^\n]*tf-apply-wave-1 applied a at this commit before this run \(terraform_data\.x\), so it says nothing of what was unknown when the change was reviewed/);
    // The comment's run wrote its wave 1 report where the merge's was (one report path per commit and wave), so the plan that
    // changed a is gone from the bucket; the pull request's report is next, and with no forge here the wave holds and says why.
    expect(said()).toContain("b reads the state of a, which wave 1 applied, and nothing says whether the outputs it reads were known when the change was reviewed: this push has no plan that changes a the wave can read");
    expect(said()).toContain("nobody reviewed the plan it made on those outputs, so it waits for an approval of it although gate is on-destructive");
    expect(readLog(log)).not.toContain("applied b");

    // Approved, the comment's apply applies wave 2, and the approval is spent.
    const fact = parseLedger(git(origin, "show", "chant/lifecycle:_gates/tf-apply.jsonl")).pending.filter((p) => p.gate === "wave-2").at(-1)!;
    approve(origin, { version: 1, kind: "resolution", op: "tf-apply", gate: "wave-2", resolvedBy: "alice", timestamp: T(3), planDigest: fact.planDigest });
    expect(await applyWave(work, { ...opts, wave: 1, now: T(4) })).toBe(0);
    expect(await applyWave(work, { ...opts, wave: 2, now: T(4) })).toBe(0);
    expect(readLog(log)).toContain("applied b");
    expect(parseApplied(git(origin, "show", "chant/lifecycle:_gates/tf-apply/applied.jsonl"))).toEqual([expect.objectContaining({ gate: "wave-2", planDigest: fact.planDigest, approvedAt: T(3) })]);
  });

  it("a direct push whose upstream changes nothing applies the reader with no hold under on-destructive", async () => {
    const { work, bin, log } = setup({
      "terragucci.yml": "reports:\n  bucket: s3://reports\n  endpoint: http://s3.test\n",
      "a/main.tf": state("a.tfstate"),
      "b/main.tf": state("b.tfstate") + reads,
    });
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    bucket();
    const plans = join(work, "..", "plans");
    writeFileSync(join(plans, "a.json"), JSON.stringify(settled));
    writeFileSync(join(plans, "b.json"), JSON.stringify(bPlan));
    const opts = { layers: [["a"], ["b"]], binary: bin, gate: "on-destructive" as const, env: { AWS_ACCESS_KEY_ID: "AK", AWS_SECRET_ACCESS_KEY: "SK" } };
    const said = () => out.mock.calls.flat().join("\n");

    // The push's first run: wave 1 plans a and changes nothing, and no earlier run of this commit applied a; wave 2 changes b.
    expect(await applyWave(work, { ...opts, wave: 1, now: T(1) })).toBe(0);
    expect(await applyWave(work, { ...opts, wave: 2, now: T(1) })).toBe(0);
    expect(said()).toMatch(/wave 1's plan of a in this push \([^)]*\) changes nothing, and no earlier run of this commit applied a, so its outputs were known when the change was reviewed/);
    expect(said()).not.toContain("waits for an approval");
    expect(readLog(log)).toContain("applied b");
  });
});

function readLog(log: string): string {
  try {
    return readFileSync(log, "utf-8");
  } catch {
    return "";
  }
}

describe("unknownReads", () => {
  const read = { root: "b", upstream: "a", wave: 1, outputs: new Set(["id"]) };
  const noPull = async () => ({ missing: "no pull request" });

  it("skips the upstream's plans that change nothing and judges by the one that changed it", async () => {
    const v = await unknownReads([read], {
      upstreamPlans: async () => [{ plan: settled, from: "the comment's plan" }, { plan: created, from: "the merge's plan" }],
      pullReport: noPull,
    });
    expect(v.unknown).toEqual([expect.objectContaining({ root: "b", outputs: ["id"], carrier: "upstream-plan", from: "the merge's plan" })]);
    expect(v.lines).toEqual(["the comment's plan changes nothing, and nothing here reads whether an earlier run of this commit applied it, so it says nothing of what was unknown when the change was reviewed"]);
  });

  it("takes a plan that changes nothing as known when no earlier run of this commit applied the upstream", async () => {
    const v = await unknownReads([read], { upstreamPlans: async () => [{ plan: settled, from: "the push's plan" }], pullReport: noPull, appliedBefore: async () => undefined });
    expect(v.unknown).toEqual([]);
    expect(v.lines).toEqual(["the push's plan changes nothing, and no earlier run of this commit applied a, so its outputs were known when the change was reviewed", "b reads no output of a that the push's plan left unknown"]);
  });

  it("skips a plan that changes nothing when an earlier run of this commit applied the upstream, or that cannot be read", async () => {
    const applied = await unknownReads([read], { upstreamPlans: async () => [{ plan: settled, from: "the resume's plan" }], pullReport: noPull, appliedBefore: async () => "the merge's run applied a" });
    expect(applied.unknown).toEqual([expect.objectContaining({ carrier: "none" })]);
    const unread = await unknownReads([read], {
      upstreamPlans: async () => [{ plan: settled, from: "the resume's plan" }],
      pullReport: noPull,
      appliedBefore: async () => {
        throw new Error("403");
      },
    });
    expect(unread.unknown).toEqual([expect.objectContaining({ carrier: "none" })]);
    expect(unread.lines[0]).toContain("could not be read (403)");
  });

  it("with only plans that change nothing, asks the pull request's report, and holds with no carrier when there is none", async () => {
    const v = await unknownReads([read], { upstreamPlans: async () => [{ plan: settled, from: "the comment's plan" }], pullReport: noPull });
    expect(v.unknown).toEqual([expect.objectContaining({ carrier: "none" })]);
    expect(v.unknown[0]!.why).toContain("no plan that changes a");
  });

  it("a plan that changed the upstream with the read output known lets the wave through", async () => {
    const known = { ...created, output_changes: { id: { actions: ["create"], before: null, after: "x-1", after_unknown: false } } };
    const v = await unknownReads([read], { upstreamPlans: async () => [{ plan: settled, from: "later" }, { plan: known, from: "the merge's plan" }], pullReport: noPull });
    expect(v.unknown).toEqual([]);
  });

  it("any plan that changed the upstream and left the output unknown holds the wave", async () => {
    const known = { ...created, output_changes: { id: { actions: ["update"], before: "x-0", after: "x-1", after_unknown: false } } };
    const v = await unknownReads([read], { upstreamPlans: async () => [{ plan: known, from: "a re-run" }, { plan: created, from: "the merge's plan" }], pullReport: noPull });
    expect(v.unknown).toEqual([expect.objectContaining({ carrier: "upstream-plan", from: "the merge's plan" })]);
  });
});
