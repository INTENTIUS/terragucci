// Drift in a Terragrunt repo's units: the pull request that brings a drifted
// unit's code in line (its terragrunt.hcl inputs), attribution in the drift
// stage, and the drift job the pipeline writes for it. Terragrunt is stubbed.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import type { TerragruntExec } from "@intentius/chant-lexicon-terraform/terragrunt/run";
import { init } from "../src/init";
import { respond } from "../src/respond";
import type { AuditLog } from "../src/respond/attribute";
import { codifyUnit, localModule } from "../src/respond/drift-units";
import { runStage } from "../src/report/stage";
import { git, tmp, write } from "./helpers";

const MODULE = `variable "timeout" {
  type = number
}

variable "name" {
  type = string
}

resource "aws_sqs_queue" "jobs" {
  name                       = var.name
  visibility_timeout_seconds = var.timeout
  message_retention_seconds  = 345600
  delay_seconds              = var.timeout + 0
}
`;

const unitHcl = (name: string, timeout = "30") => `include "root" {
  path = find_in_parent_folders("root.hcl")
}

terraform {
  source = "../../modules/queue"
}

inputs = {
  name    = "${name}"
  timeout = ${timeout} # seconds
}
`;

/** The queue's drift: its timeout went from 30 to 45 outside Terraform, and its retention too. */
const drifted = (attrs: Record<string, [unknown, unknown]> = { visibility_timeout_seconds: [30, 45], message_retention_seconds: [345600, 86400] }) => [
  { address: "aws_sqs_queue.jobs", action: "update", type: "aws_sqs_queue", name: "jobs", ref: "orders-jobs", attributes: Object.entries(attrs).map(([path, [before, live]]) => ({ path, before, live })) },
];

function repo(): string {
  const r = write(tmp(), {
    "root.hcl": "",
    "modules/queue/main.tf": MODULE,
    "live/orders/terragrunt.hcl": unitHcl("orders"),
    "live/billing/terragrunt.hcl": unitHcl("billing"),
    "live/local/terragrunt.hcl": 'include "root" {\n  path = find_in_parent_folders("root.hcl")\n}\n',
    "live/local/main.tf": 'resource "aws_sqs_queue" "jobs" {\n  name                       = "local"\n  visibility_timeout_seconds = 30\n}\n',
  });
  return r;
}

describe("codifying a unit's drift", () => {
  it("writes the live value into the unit's own inputs where the module reads var.<name>, and leaves the module's literal with why", () => {
    const r = repo();
    const out = codifyUnit(r, "live/orders", "modules/queue", drifted());
    expect(out.codified).toEqual([{ root: "live/orders", address: "aws_sqs_queue.jobs", path: "visibility_timeout_seconds", file: "live/orders/terragrunt.hcl", from: "30", to: "45" }]);
    expect(out.files.get("live/orders/terragrunt.hcl")).toContain("  timeout = 45 # seconds\n");
    // Only the unit's own file: the module, which billing shares, is untouched.
    expect([...out.files.keys()]).toEqual(["live/orders/terragrunt.hcl"]);
    expect(out.left).toEqual([{ root: "live/orders", address: "aws_sqs_queue.jobs", path: "message_retention_seconds", reason: expect.stringMatching(/^set as a literal in modules\/queue, which every unit calling it shares/) }]);
  });

  it("leaves an input set from an expression, one not set, one that moved, an expression in the module, and a delete", () => {
    const r = repo();
    writeFileSync(join(r, "live/orders/terragrunt.hcl"), unitHcl("orders", "local.timeout"));
    const expr = codifyUnit(r, "live/orders", "modules/queue", drifted({ visibility_timeout_seconds: [30, 45], delay_seconds: [30, 0] }));
    expect(expr.codified).toEqual([]);
    expect(expr.left.map((l) => l.reason)).toEqual(["the input timeout is set from an expression (local.timeout)", "set from an expression in modules/queue (var.timeout + 0)"]);
    writeFileSync(join(r, "live/orders/terragrunt.hcl"), unitHcl("orders", "60"));
    expect(codifyUnit(r, "live/orders", "modules/queue", drifted({ visibility_timeout_seconds: [30, 45] })).left[0].reason).toBe("the input timeout is not the value last applied, so the code moved too");
    writeFileSync(join(r, "live/orders/terragrunt.hcl"), 'terraform {\n  source = "../../modules/queue"\n}\n');
    expect(codifyUnit(r, "live/orders", "modules/queue", drifted({ visibility_timeout_seconds: [30, 45] })).left[0].reason).toMatch(/reads var.timeout, which live\/orders\/terragrunt.hcl's inputs do not set/);
    expect(codifyUnit(r, "live/orders", "modules/queue", [{ ...drifted()[0], action: "delete" }]).left[0].reason).toMatch(/^deleted outside Terraform/);
  });

  it("finds a local module from the unit's source, and none for a source outside the repo", () => {
    const r = repo();
    expect(localModule(r, "live/orders", "../../modules/queue")).toBe("modules/queue");
    expect(localModule(r, "live/orders", "../..//modules/queue")).toBe("modules/queue");
    expect(localModule(r, "live/orders", join(r, "modules/queue"))).toBe("modules/queue");
    expect(localModule(r, "live/orders", "git::https://example.com/m.git//queue?ref=v1")).toBeUndefined();
    expect(localModule(r, "live/orders", "tfr:///acme/queue/aws?version=1.0.0")).toBeUndefined();
    expect(localModule(r, "live/orders", "../../../elsewhere")).toBeUndefined();
  });
});

/** A Terragrunt stand-in for the drift response: refresh plans, show -json and render, per unit. */
function terragrunt(r: string, drift: Record<string, Record<string, [unknown, unknown]>>, calls: string[][] = []): TerragruntExec {
  return async (_f, args) => {
    calls.push([...args]);
    const unit = args[args.indexOf("--working-dir") + 1]!;
    if (args[0] === "--version") return { code: 0, stdout: "terragrunt version v1.1.6\n", stderr: "" };
    if (args[0] === "render") return { code: 0, stdout: JSON.stringify(unit === "live/local" ? {} : { terraform: { source: join(r, unit, "../../modules/queue") } }), stderr: "" };
    const tf = args.slice(args.indexOf("--") + 1);
    if (tf[0] === "plan") {
      const out = tf.find((a) => a.startsWith("-out="))!.slice(5);
      mkdirSync(dirname(out), { recursive: true });
      const attrs = drift[unit] ?? {};
      const before = Object.fromEntries(Object.entries(attrs).map(([k, [b]]) => [k, b]));
      const after = Object.fromEntries(Object.entries(attrs).map(([k, [, l]]) => [k, l]));
      writeFileSync(out, JSON.stringify({ resource_drift: Object.keys(attrs).length ? [{ address: "aws_sqs_queue.jobs", mode: "managed", type: "aws_sqs_queue", name: "jobs", change: { actions: ["update"], before: { name: unit, ...before }, after: { name: unit, ...after } } }] : [] }));
      return { code: 0, stdout: "", stderr: "" };
    }
    if (tf[0] === "show") return { code: 0, stdout: readFileSync(tf[2]!, "utf-8"), stderr: "" };
    return { code: 1, stdout: "", stderr: `unexpected ${args.join(" ")}` };
  };
}

describe("respond drift in a Terragrunt repo", () => {
  it("plans again only the units the drift report names, and proposes the change to the drifted unit's terragrunt.hcl inputs", async () => {
    const r = repo();
    write(r, {
      "terragucci.yml": "forge: github\n",
      "terragucci-report/report.json": JSON.stringify({ run: { stage: "tf-drift" }, roots: [{ path: "live/orders", changes: [{}] }, { path: "live/billing", changes: [] }, { path: "live/local", changes: [{}] }] }),
    });
    const calls: string[][] = [];
    const out = await respond("drift", r, { binary: "tofu", terragruntExec: terragrunt(r, { "live/orders": { visibility_timeout_seconds: [30, 45] }, "live/local": { visibility_timeout_seconds: [30, 60] } }, calls) });
    const planned = calls.filter((c) => c.includes("plan")).map((c) => c[c.indexOf("--working-dir") + 1]);
    expect(planned).toEqual(["live/local", "live/orders"]);
    const data = out.data as { codified: { file: string; to: string }[] };
    expect(data.codified.map((c) => [c.file, c.to])).toEqual([["live/local/main.tf", "60"], ["live/orders/terragrunt.hcl", "45"]]);
    expect(out.text).toContain("`live/orders/terragrunt.hcl`: `aws_sqs_queue.jobs` `visibility_timeout_seconds` 30 -> 45");
    expect(out.proposals?.[0]).toMatchObject({ branch: "terragucci/drift" });
  });

  it("refuses --import for a unit with a config error, rather than skip it", async () => {
    const r = repo();
    await expect(respond("drift", r, { binary: "tofu", imports: [{ address: "aws_sqs_queue.x", id: "q" }], terragruntExec: terragrunt(r, {}) })).rejects.toThrow(/--import writes import blocks into a root's own files/);
  });
});

describe("tf-drift attribution in a Terragrunt repo", () => {
  it("names who changed what for a drifted unit, in the issue and attributions.json, from the same audit log as a plain root", async () => {
    const r = write(tmp(), {
      "terragucci.yml": "respond:\n  drift: attribute\n",
      "root.hcl": "",
      "live/a/terragrunt.hcl": "",
    });
    git(r, "init", "-q");
    const asked: string[] = [];
    const audit: AuditLog = { lookup: async (q) => (asked.push(q.ref ?? ""), { status: "found", actor: "human", who: "alice", event: "SetQueueAttributes", at: "2026-10-01T09:00:00Z" }) };
    const exec: TerragruntExec = async (_f, args) => {
      if (args[0] === "--version") return { code: 0, stdout: "terragrunt version v1.1.6\n", stderr: "" };
      if (args[0] === "render") return { code: 0, stdout: "{}", stderr: "" };
      const flag = (n: string) => args[args.indexOf(n) + 1]!;
      for (const [dir, f, body] of [
        [flag("--out-dir"), "tfplan.tfplan", "plan"],
        [flag("--json-out-dir"), "tfplan.json", JSON.stringify({ format_version: "1.2", resource_changes: [], resource_drift: [{ address: "aws_sqs_queue.jobs", mode: "managed", type: "aws_sqs_queue", name: "jobs", change: { actions: ["update"], before: { name: "orders-jobs", visibility_timeout_seconds: 30 }, after: { name: "orders-jobs", visibility_timeout_seconds: 45 } } }] })],
      ]) {
        mkdirSync(join(dir, "live/a"), { recursive: true });
        writeFileSync(join(dir, "live/a", f), body);
      }
      const report = flag("--report-file");
      mkdirSync(dirname(report), { recursive: true });
      writeFileSync(report, JSON.stringify([{ Name: "live/a", Result: "succeeded" }]));
      return { code: 0, stdout: "", stderr: "" };
    };
    const out = join(r, "out");
    await runStage("tf-drift", r, { out, binary: "tofu", terragrunt: true, layers: [["live/a"]], terragruntExec: exec, audit, env: {} }, () => {});
    expect(asked).toEqual(["orders-jobs"]);
    const at = JSON.parse(readFileSync(join(out, "attributions.json"), "utf-8"));
    expect(at["live/a"].attributions[0]).toMatchObject({ address: "aws_sqs_queue.jobs", path: "visibility_timeout_seconds", actor: "human" });
    const issue = readFileSync(join(out, "issue.md"), "utf-8");
    expect(issue).toContain("- Who changed it:");
    expect(issue).toContain("SetQueueAttributes by alice");
  });
});

const body = (text: string): Record<string, any> => parseYAML(text.split("\n").filter((l) => !l.startsWith("#")).join("\n")) as Record<string, any>;

describe("the drift job a Terragrunt repo's pipeline writes", () => {
  const live = (config: string) => {
    const r = write(tmp(), { "terragucci.yml": `drift: "0 6 * * *"\n${config}`, "root.hcl": "", "live/a/terragrunt.hcl": "" });
    git(r, "init", "-q");
    git(r, "remote", "add", "origin", "https://github.com/acme/live.git");
    return r;
  };

  it("with respond.drift at its default, opens the drift pull request after the stage, with the job's token and write access", async () => {
    const doc = body((await init(live(""), { binary: "tofu", forge: "github", terragrunt: "/nonexistent/terragrunt" })).files[0].content);
    const script = doc.jobs.drift.steps.map((s: any) => s.run).filter(Boolean).join("\n");
    expect(script).toContain("terragucci stage tf-drift");
    expect(script).toContain("terragucci respond drift --mode apply --binary tofu");
    expect(doc.jobs.drift.permissions).toMatchObject({ contents: "write", "pull-requests": "write" });
  });

  it("with respond.drift: attribute, installs the aws CLI and hands the job the decision service's key", async () => {
    const doc = body((await init(live("respond:\n  drift: attribute\ndecide:\n  backend: laya\n  url: http://decide:8790\n  token_env: DECIDE_KEY\n"), { binary: "tofu", forge: "github", terragrunt: "/nonexistent/terragrunt" })).files[0].content);
    const steps = doc.jobs.drift.steps;
    expect(steps.map((s: any) => s.run ?? "").join("\n")).toMatch(/awscli|aws --version|awscliv2/);
    expect(JSON.stringify(doc.jobs.drift)).toContain("DECIDE_KEY");
  });

  it("with respond.drift: off, writes neither", async () => {
    const doc = body((await init(live("respond:\n  drift: off\n"), { binary: "tofu", forge: "github", terragrunt: "/nonexistent/terragrunt" })).files[0].content);
    expect(doc.jobs.drift.steps.map((s: any) => s.run ?? "").join("\n")).not.toContain("terragucci respond drift");
    expect(doc.jobs.drift.permissions.contents).toBe("read");
  });
});
