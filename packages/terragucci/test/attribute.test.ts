// terragucci#31: drift attribution. The order is the point: the known-writes
// table and the audit log answer first and are tested first, and the model
// is asked only about drift neither answers, on a fixture with one of each.
import { describe, expect, it } from "vitest";
import { validateConfig } from "../src/config";
import type { DecideFetch, DecideSettings } from "../src/decide";
import { attribute, awsAuditLog, classifyEvent, knownWrite, newestActor, onlyServiceTags, route, shown, withoutLeft, type AuditLog, type AuditQuery } from "../src/respond/attribute";
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

describe("the known-writes table", () => {
  it("answers for a controller's write, by type and attribute", () => {
    expect(knownWrite("aws_ecs_service", "desired_count", { before: 2, live: 6 })).toMatchObject({ actor: "controller" });
    expect(knownWrite("aws_autoscaling_group", "desired_capacity", { before: 2, live: 4 })).toMatchObject({ actor: "controller" });
    expect(knownWrite("aws_eks_node_group", "scaling_config", { before: [{ desired_size: 2, min_size: 1 }], live: [{ desired_size: 5, min_size: 1 }] })).toBeDefined();
  });

  it("is silent for another attribute of the same type, or for a change the writer does not make", () => {
    expect(knownWrite("aws_ecs_service", "task_definition", { before: "a", live: "b" })).toBeUndefined();
    expect(knownWrite("aws_eks_node_group", "scaling_config", { before: [{ desired_size: 2, min_size: 1 }], live: [{ desired_size: 5, min_size: 3 }] })).toBeUndefined();
    expect(knownWrite("aws_sqs_queue", "visibility_timeout_seconds", { before: 30, live: 90 })).toBeUndefined();
  });

  it("takes tags only when every changed key is one a service writes", () => {
    expect(onlyServiceTags({ before: { team: "a" }, live: { team: "a", "aws:autoscaling:groupName": "web" } })).toBe(true);
    expect(onlyServiceTags({ before: { team: "a" }, live: { team: "b", "aws:cloudformation:stack-name": "x" } })).toBe(false);
    expect(onlyServiceTags({ before: { team: "a" }, live: { team: "a" } })).toBe(false);
    expect(knownWrite("aws_s3_bucket", "tags_all", { before: {}, live: { "aws:createdBy": "x" } })).toMatchObject({ actor: "controller" });
  });
});

describe("the audit log", () => {
  const trail = (identity: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ eventName: "UpdateService", eventTime: "2026-10-04T10:00:00Z", userIdentity: identity, ...extra });

  it("reads a service principal as a controller and a user, root or SSO session as a person", () => {
    expect(classifyEvent(trail({ type: "AWSService", invokedBy: "application-autoscaling.amazonaws.com" }))).toEqual({ actor: "controller", who: "application-autoscaling.amazonaws.com" });
    expect(classifyEvent(trail({ type: "AssumedRole", arn: "arn:aws:sts::1:assumed-role/svc/x", invokedBy: "ecs.amazonaws.com" }))).toMatchObject({ actor: "controller" });
    expect(classifyEvent(trail({ type: "IAMUser", userName: "dana" }))).toEqual({ actor: "human", who: "dana" });
    expect(classifyEvent(trail({ type: "Root" }))).toMatchObject({ actor: "human" });
    expect(classifyEvent(trail({ type: "AssumedRole", arn: "arn:aws:sts::1:assumed-role/AWSReservedSSO_Admin_abc/dana@acme.test", sessionContext: { sessionIssuer: { userName: "AWSReservedSSO_Admin_abc" } } }))).toEqual({ actor: "human", who: "dana@acme.test" });
  });

  it("says nothing for a role session with a machine name", () => {
    expect(classifyEvent(trail({ type: "AssumedRole", arn: "arn:aws:sts::1:assumed-role/ci-apply/run-1234" }))).toBeUndefined();
  });

  it("skips reads and Terraform's own writes, and the newest remaining write decides", () => {
    const events = [
      trail({ type: "IAMUser", userName: "old" }, { eventTime: "2026-10-01T00:00:00Z" }),
      trail({ type: "IAMUser", userName: "dana" }, { eventTime: "2026-10-03T00:00:00Z" }),
      trail({ type: "AssumedRole", arn: "arn:aws:sts::1:assumed-role/ci/x" }, { eventTime: "2026-10-04T00:00:00Z", userAgent: "APN/1.0 HashiCorp/1.0 Terraform/1.9.0" }),
      trail({ type: "IAMUser", userName: "reader" }, { eventTime: "2026-10-05T00:00:00Z", readOnly: true }),
    ];
    expect(newestActor(events)).toMatchObject({ status: "found", actor: "human", who: "dana" });
    expect(newestActor([trail({ type: "AssumedRole", arn: "arn:aws:sts::1:assumed-role/ci/x" })])).toEqual({ status: "silent" });
    expect(newestActor([])).toEqual({ status: "silent" });
  });

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

  it("reports an unreadable log, and has no reader for another cloud", async () => {
    const denied = lookup("", 254, "An error occurred (AccessDeniedException) when calling the LookupEvents operation\nmore");
    expect(await denied.log.lookup({ type: "aws_sqs_queue", address: "a", ref: "jobs" })).toEqual({ status: "unavailable", reason: "An error occurred (AccessDeniedException) when calling the LookupEvents operation" });
    expect(await lookup("not json").log.lookup({ type: "aws_sqs_queue", address: "a", ref: "jobs" })).toMatchObject({ status: "unavailable" });
    expect(await lookup("{}").log.lookup({ type: "azurerm_storage_account", address: "a", ref: "x" })).toMatchObject({ status: "unavailable", reason: "no audit log reader for azurerm_storage_account" });
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
