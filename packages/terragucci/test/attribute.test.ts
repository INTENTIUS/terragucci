// terragucci#31: drift attribution. The order is the point: the known-writes
// table and the audit log answer first and are tested first, and the model
// is asked only about drift neither answers, on a fixture with one of each.
// The known-writes table and the CloudTrail reader are chant's (chant#4632), tested there;
// these tests read them through terragucci's attribution and its `aws` CLI wiring.
import { describe, expect, it } from "vitest";
import { validateConfig } from "../src/config";
import type { DecideFetch, DecideSettings } from "../src/decide";
import { attribute, awsAuditLog, route, shown, withoutLeft, type AuditLog, type AuditQuery } from "../src/respond/attribute";
import { driftOf } from "../src/respond/drift";

const entry = (type: string, name: string, before: Record<string, unknown>, after: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  address: `${type}.${name}`,
  mode: "managed",
  type,
  name,
  change: { actions: ["update"], before, after, ...extra },
});

// One drifted object of each kind.
const FIXTURE = driftOf({
  resource_drift: [
    // the table answers: Application Auto Scaling set the task count
    entry("aws_ecs_service", "api", { name: "api", desired_count: 2 }, { name: "api", desired_count: 6 }),
    // the table is silent, the audit log names a person
    entry("aws_sqs_queue", "jobs", { name: "jobs", visibility_timeout_seconds: 30 }, { name: "jobs", visibility_timeout_seconds: 90 }),
    // both are silent: only the model is left
    entry("aws_db_parameter_group", "main", { name: "main-pg", description: "managed" }, { name: "main-pg", description: "Managed by Terraform" }),
  ],
});

class FakeAudit implements AuditLog {
  asked: AuditQuery[] = [];
  constructor(private answers: Record<string, Awaited<ReturnType<AuditLog["lookup"]>>>) {}
  async lookup(q: AuditQuery) {
    this.asked.push(q);
    return this.answers[q.ref] ?? { status: "silent" as const };
  }
}
const human = { status: "found" as const, actor: "human" as const, who: "dana@acme.test", event: "SetQueueAttributes", at: "2026-10-04T10:00:00Z" };

const VON: DecideSettings = { backend: "von", url: "http://decide.local:9000" };
function model(choice: string, p: number) {
  const calls: { state: Record<string, unknown> }[] = [];
  const fetch: DecideFetch = async (_url, init) => {
    calls.push({ state: (JSON.parse(init.body) as { state: Record<string, unknown> }).state });
    const rest = (1 - p) / 2;
    const probabilities = Object.fromEntries(["controller", "human", "provider-default"].map((k) => [k, k === choice ? p : rest]));
    return { ok: true, status: 200, text: async () => JSON.stringify({ answers: { actor: { type: "choice", choice, probabilities } } }) };
  };
  return { fetch, calls };
}

describe("the audit log", () => {
  const lookup = (stdout: string, status = 0, stderr = "") => {
    const calls: string[][] = [];
    const log = awsAuditLog({ run: (a) => (calls.push(a), { status, stdout, stderr }), now: () => new Date("2026-10-05T00:00:00Z") });
    return { log, calls };
  };

  it("reads CloudTrail's LookupEvents through the aws CLI", async () => {
    const stdout = JSON.stringify({ Events: [{ EventName: "SetQueueAttributes", EventTime: "2026-10-04T10:00:00Z", CloudTrailEvent: JSON.stringify({ userIdentity: { type: "IAMUser", userName: "dana" }, readOnly: false }) }] });
    const { log, calls } = lookup(stdout);
    expect(await log.lookup({ type: "aws_sqs_queue", address: "aws_sqs_queue.jobs", ref: "jobs" })).toMatchObject({ status: "found", actor: "human", who: "dana", event: "SetQueueAttributes" });
    expect(calls[0]).toEqual(expect.arrayContaining(["cloudtrail", "lookup-events", "AttributeKey=ResourceName,AttributeValue=jobs", "2026-09-21T00:00:00.000Z"]));
  });

  it("says the aws CLI is not installed when the binary is missing", async () => {
    const err = Object.assign(new Error("spawnSync aws ENOENT"), { code: "ENOENT" });
    const log = awsAuditLog({ run: () => ({ status: null, stdout: "", stderr: "", error: err }) });
    expect(await log.lookup({ type: "aws_sqs_queue", address: "a", ref: "jobs" })).toEqual({ status: "unavailable", reason: "the aws CLI is not installed" });
  });

  it("reports an unreadable log, and has no reader for another cloud", async () => {
    const denied = lookup("", 254, "An error occurred (AccessDeniedException) when calling the LookupEvents operation\nmore");
    expect(await denied.log.lookup({ type: "aws_sqs_queue", address: "a", ref: "jobs" })).toEqual({ status: "unavailable", reason: "An error occurred (AccessDeniedException) when calling the LookupEvents operation" });
    expect(await lookup("not json").log.lookup({ type: "aws_sqs_queue", address: "a", ref: "jobs" })).toMatchObject({ status: "unavailable" });
    expect(await lookup("{}").log.lookup({ type: "azurerm_storage_account", address: "a", ref: "x" })).toMatchObject({ status: "unavailable", reason: expect.stringContaining("azurerm_storage_account") });
    expect(await lookup("{}").log.lookup({ type: "aws_sqs_queue", address: "a", ref: "jobs" })).toEqual({ status: "silent" });
  });
});

describe("attribute, one drifted object of each kind", () => {
  it("answers the table's and the audit log's from evidence and asks the model only about the third", async () => {
    const audit = new FakeAudit({ jobs: human });
    const m = model("provider-default", 0.9);
    const r = await attribute("envs/dev", FIXTURE, { audit, decide: VON, options: { fetch: m.fetch } });
    expect(r.attributions.map((a) => [a.address, a.path, a.source, a.actor])).toEqual([
      ["aws_ecs_service.api", "desired_count", "table", "controller"],
      ["aws_sqs_queue.jobs", "visibility_timeout_seconds", "audit", "human"],
      ["aws_db_parameter_group.main", "description", "model", "provider-default"],
    ]);
    expect(audit.asked.map((q) => q.ref)).toEqual(["jobs", "main-pg"]); // the table's attribute never reached the log
    expect(m.calls).toHaveLength(1);
    expect(m.calls[0]!.state).toEqual({ resource_type: "aws_db_parameter_group", attribute: "description", value_in_code: "(a string of 7 characters)", live_value: "(a string of 20 characters)" });
    expect(r.attributions[2]).toMatchObject({ probability: 0.9 });
  });

  it("never asks the model when the table and the audit log answer everything", async () => {
    const m = model("human", 0.99);
    const r = await attribute("r", FIXTURE.slice(0, 2), { audit: new FakeAudit({ jobs: human }), decide: VON, options: { fetch: m.fetch } });
    expect(r.attributions.map((a) => a.source)).toEqual(["table", "audit"]);
    expect(m.calls).toHaveLength(0);
  });

  it("reports an unreadable audit log once, moves on, and reaches the model", async () => {
    const unavailable: AuditLog = { lookup: async () => ({ status: "unavailable", reason: "AccessDeniedException" }) };
    const m = model("human", 0.95);
    const r = await attribute("r", FIXTURE, { audit: unavailable, decide: VON, options: { fetch: m.fetch } });
    expect(r.notes).toEqual(["audit log unavailable: AccessDeniedException"]);
    expect(r.attributions.map((a) => a.source)).toEqual(["table", "model", "model"]);
    expect(m.calls).toHaveLength(2);
  });

  it("reports unattributed below the threshold, and with no decide: configured", async () => {
    const low = await attribute("r", FIXTURE.slice(2), { decide: VON, options: { fetch: model("human", 0.5).fetch } });
    expect(low.attributions).toMatchObject([{ source: "unattributed" }]);
    expect(low.attributions[0]!.actor).toBeUndefined();
    expect(low.notes[0]).toMatch(/not used/);
    const off = model("human", 0.99);
    const none = await attribute("r", FIXTURE.slice(2), { audit: new FakeAudit({}), options: { fetch: off.fetch } });
    expect(none.attributions).toMatchObject([{ source: "unattributed" }]);
    expect(off.calls).toHaveLength(0);
  });

  it("keeps a sensitive value from the model and from the table", async () => {
    const d = driftOf({ resource_drift: [entry("aws_db_instance", "main", { name: "main", password: "a" }, { name: "main", password: "b" }, { before_sensitive: { password: true }, after_sensitive: { password: true } })] });
    const m = model("human", 0.9);
    await attribute("r", d, { decide: VON, options: { fetch: m.fetch } });
    expect(m.calls[0]!.state).toMatchObject({ value_in_code: "(sensitive)", live_value: "(sensitive)" });
    expect(shown({ a: 1, b: 2 })).toBe("(a map with keys a, b)");
    expect(shown("x".repeat(200))).toBe("(a string of 200 characters)");
    expect(shown(6)).toBe(6);
  });
});

describe("route", () => {
  it("suggests ignore_changes for a controller, keeps a human edit and an unattributed attribute in the pull request, and suggests a value for a provider default", async () => {
    const audit = new FakeAudit({ jobs: human });
    const m = model("provider-default", 0.9);
    const { attributions } = await attribute("r", FIXTURE, { audit, decide: VON, options: { fetch: m.fetch } });
    const routed = route([...attributions, { root: "r", address: "aws_x.y", path: "z", source: "unattributed", detail: "neither answered" }]);
    expect(routed.lines).toEqual([
      "- controller write: `aws_ecs_service.api` `desired_count` (known write: Application Auto Scaling sets an ECS service's task count); add `lifecycle { ignore_changes = [desired_count] }` to the resource, and leave it out of the code",
      "- human edit: `aws_sqs_queue.jobs` `visibility_timeout_seconds` (audit log: SetQueueAttributes by dana@acme.test at 2026-10-04T10:00:00Z); the pull request codifies it for the owner to accept or revert",
      expect.stringMatching(/^- provider default change: `aws_db_parameter_group.main` `description` \(model: .*\); pin the version that kept the old value, or set `description`/),
      "- unattributed: `aws_x.y` `z`: neither answered; the default response runs",
    ]);
    expect([...routed.leave.keys()]).toEqual(["aws_ecs_service.api", "aws_db_parameter_group.main"]);
    // The codify pull request keeps only the human edit.
    expect(withoutLeft(FIXTURE, routed.leave).map((d) => d.address)).toEqual(["aws_sqs_queue.jobs"]);
  });

  it("keeps a deleted object, which has no attributes", () => {
    const gone = driftOf({ resource_drift: [{ address: "aws_sqs_queue.g", mode: "managed", type: "aws_sqs_queue", name: "g", change: { actions: ["delete"], before: { name: "g" }, after: null } }] });
    expect(withoutLeft(gone, new Map([["aws_sqs_queue.g", new Set(["x"])]]))).toHaveLength(1);
  });
});

describe("audit_region", () => {
  it("is passed to the aws CLI as --region", async () => {
    const calls: string[][] = [];
    const log = awsAuditLog({ region: "eu-west-2", run: (a) => (calls.push(a), { status: 0, stdout: "{}", stderr: "" }) });
    await log.lookup({ type: "aws_sqs_queue", address: "aws_sqs_queue.jobs", ref: "jobs" });
    expect(calls[0]).toEqual(expect.arrayContaining(["--region", "eu-west-2"]));
  });

  it("is validated as a region", () => {
    expect(validateConfig({ audit_region: "eu-west-2" }, "t").audit_region).toBe("eu-west-2");
    expect(() => validateConfig({ audit_region: "europe" }, "t")).toThrow(/audit_region/);
  });
});
