import { describe, expect, it } from "vitest";
import { localsText, remoteStateReads } from "../src/detect";
import { blastRootsOf, changedResources, nodeOf, resourceBlast, type BlastRoot } from "../src/report/resource-blast";
import { blastLines } from "../src/report/views";
import type { Report } from "../src/report/schema";
import { tmp, write } from "./helpers";

const refs = (...r: string[]): { references: string[] } => ({ references: r });
const change = (address: string, actions: string[]): { address: string; mode: string; change: { actions: string[] } } => ({ address, mode: "managed", change: { actions } });

// queue: a queue that changes, a policy on it, a dead-letter queue that does not, and their ARNs as outputs.
const queuePlan = {
  resource_changes: [change("aws_sqs_queue.jobs", ["update"]), change("aws_sqs_queue_policy.jobs", ["no-op"]), change("aws_sqs_queue.dead", ["no-op"])],
  configuration: {
    root_module: {
      resources: [
        { address: "aws_sqs_queue.jobs", mode: "managed", expressions: { visibility_timeout_seconds: { constant_value: 60 } } },
        { address: "aws_sqs_queue.dead", mode: "managed", expressions: { name: { constant_value: "dead" } } },
        { address: "aws_sqs_queue_policy.jobs", mode: "managed", expressions: { queue_url: refs("aws_sqs_queue.jobs.url", "aws_sqs_queue.jobs") } },
      ],
      outputs: {
        jobs_arn: { expression: refs("local.jobs_arn") },
        dead_arn: { expression: refs("aws_sqs_queue.dead.arn", "aws_sqs_queue.dead") },
      },
    },
  },
};

// worker: a function that reads jobs_arn in a nested block, a mapping on the function, and a log group that reads only dead_arn.
const workerPlan = {
  resource_changes: [change("aws_lambda_function.worker", ["no-op"])],
  configuration: {
    root_module: {
      resources: [
        { address: "data.terraform_remote_state.queue", mode: "data", expressions: { backend: { constant_value: "s3" } } },
        {
          address: "aws_lambda_function.worker",
          mode: "managed",
          expressions: { environment: [{ variables: refs("data.terraform_remote_state.queue.outputs.jobs_arn", "data.terraform_remote_state.queue.outputs", "data.terraform_remote_state.queue") }] },
        },
        { address: "aws_lambda_event_source_mapping.jobs", mode: "managed", expressions: { function_name: refs("aws_lambda_function.worker.arn", "aws_lambda_function.worker") } },
        { address: "aws_cloudwatch_log_group.dead", mode: "managed", expressions: { name: refs('data.terraform_remote_state.queue.outputs["dead_arn"]', "data.terraform_remote_state.queue.outputs", "data.terraform_remote_state.queue") } },
      ],
      outputs: { worker_arn: { expression: refs("aws_lambda_function.worker.arn", "aws_lambda_function.worker") } },
    },
  },
};

// alerts: reads the worker's output through a module, two roots from the queue.
const alertsPlan = {
  resource_changes: [],
  configuration: {
    root_module: {
      module_calls: {
        alarm: {
          source: "./alarm",
          expressions: { target: refs("data.terraform_remote_state.worker.outputs.worker_arn", "data.terraform_remote_state.worker.outputs", "data.terraform_remote_state.worker") },
          module: { resources: [{ address: "aws_cloudwatch_metric_alarm.this", mode: "managed", expressions: { alarm_actions: refs("var.target") } }] },
        },
      },
      resources: [{ address: "terraform_data.unrelated", mode: "managed", expressions: { input: { constant_value: 1 } } }],
    },
  },
};

const roots: BlastRoot[] = [
  { root: "queue", plan: queuePlan, reads: [], locals: (s) => new Map(s === "" ? [["jobs_arn", "aws_sqs_queue.jobs.arn"]] : []) },
  { root: "worker", plan: workerPlan, reads: [{ data: "terraform_remote_state.queue", upstream: "queue" }] },
  { root: "alerts", plan: alertsPlan, reads: [{ data: "terraform_remote_state.worker", upstream: "worker" }] },
];

describe("the blast radius by resource", () => {
  it("lists the changed queue's dependents in its root and the function that reads its ARN in another root, followed through", () => {
    expect(resourceBlast(roots, ["queue"])).toEqual([
      {
        root: "queue",
        address: "aws_sqs_queue.jobs",
        actions: ["update"],
        reaches: [
          { root: "queue", address: "aws_sqs_queue_policy.jobs" },
          { root: "worker", address: "aws_lambda_event_source_mapping.jobs", through: { root: "queue", output: "jobs_arn" } },
          { root: "worker", address: "aws_lambda_function.worker", through: { root: "queue", output: "jobs_arn" } },
          { root: "alerts", address: "module.alarm.aws_cloudwatch_metric_alarm.this", through: { root: "worker", output: "worker_arn" } },
        ],
      },
    ]);
  });

  it("leaves out a resource of a reader that reads only an output the change does not reach", () => {
    const all = resourceBlast(roots, ["queue"]).flatMap((r) => r.reaches.map((x) => x.address));
    expect(all).not.toContain("aws_cloudwatch_log_group.dead");
    expect(all).not.toContain("terraform_data.unrelated");
  });

  it("reaches every resource that reads a reader's whole outputs", () => {
    const whole = { root: "all", plan: { configuration: { root_module: { resources: [{ address: "terraform_data.all", mode: "managed", expressions: { input: refs("data.terraform_remote_state.q.outputs", "data.terraform_remote_state.q") } }] } } }, reads: [{ data: "terraform_remote_state.q", upstream: "queue" }] };
    expect(resourceBlast([roots[0]!, whole], ["queue"])[0]!.reaches).toContainEqual({ root: "all", address: "terraform_data.all", through: { root: "queue", output: "jobs_arn" } });
  });

  it("follows estate outputs as it follows remote state", () => {
    const reader = { root: "fn", plan: { configuration: { root_module: { resources: [{ address: "terraform_data.fn", mode: "managed", expressions: { input: refs("data.terraform_estate_outputs.q.values.jobs_arn", "data.terraform_estate_outputs.q.values", "data.terraform_estate_outputs.q") } }] } } }, reads: [{ data: "terraform_estate_outputs.q", upstream: "queue" }] };
    expect(resourceBlast([roots[0]!, reader], ["queue"])[0]!.reaches.map((x) => x.address)).toEqual(["aws_sqs_queue_policy.jobs", "terraform_data.fn"]);
  });

  it("stops at a reference to a local it cannot read", () => {
    const blind = { ...roots[0]!, locals: undefined };
    expect(resourceBlast([blind, roots[1]!], ["queue"])[0]!.reaches).toEqual([{ root: "queue", address: "aws_sqs_queue_policy.jobs" }]);
  });

  it("names nodes without instance keys, and a module's outputs and reads", () => {
    expect(nodeOf("aws_sqs_queue.jobs[0].arn", "")).toBe("aws_sqs_queue.jobs");
    expect(nodeOf('module.svc["a"].queue', "")).toBe("module.svc.output.queue");
    expect(nodeOf("module.svc", "")).toBe("module.svc.output.*");
    expect(nodeOf("var.x", "module.a.")).toBe("module.a.var.x");
    expect(nodeOf("count.index", "")).toBeUndefined();
    expect(nodeOf("data.terraform_remote_state.q.outputs.arn", "")).toBe("read.terraform_remote_state.q.arn");
    expect(nodeOf("data.terraform_remote_state.q", "")).toBe("read.terraform_remote_state.q.*");
  });

  it("takes only changed managed resources", () => {
    expect(changedResources({ resource_changes: [change("a.b", ["no-op"]), change("c.d[0]", ["delete", "create"]), { address: "data.x.y", mode: "data", change: { actions: ["read"] } }] })).toEqual([{ address: "c.d[0]", actions: ["delete", "create"] }]);
  });
});

describe("the roots as the plan stage reads them", () => {
  it("reads remote state and estate outputs as edges, and locals from the code", () => {
    const repo = write(tmp(), {
      "queue/main.tf": `terraform {\n  backend "s3" {\n    bucket = "b"\n    key    = "queue.tfstate"\n  }\n}\nlocals {\n  jobs_arn = aws_sqs_queue.jobs.arn\n  tags = {\n    a = "x"\n  }\n  n = 1\n}\n`,
      "worker/main.tf": `data "terraform_remote_state" "queue" {\n  backend = "s3"\n  config = {\n    bucket = "b"\n    key    = "queue.tfstate"\n  }\n}\n`,
      "fn/main.tf": `terraform {\n  live {\n    estate = "fn"\n  }\n}\ndata "terraform_estate_outputs" "q" {\n  estate = "queue-estate"\n  names  = ["jobs_arn"]\n}\n`,
      "queue/estate.chdf.hcl": `estate = "queue-estate"\n`,
    });
    const all = ["fn", "queue", "worker"];
    const got = blastRootsOf(repo, all, all.map((path) => ({ path, plan: {} })), remoteStateReads(repo, all));
    expect(got.map((r) => [r.root, r.reads])).toEqual([
      ["fn", [{ data: "terraform_estate_outputs.q", upstream: "queue" }]],
      ["queue", []],
      ["worker", [{ data: "terraform_remote_state.queue", upstream: "queue" }]],
    ]);
    expect([...got[1]!.locals!("").keys()]).toEqual(["jobs_arn", "tags", "n"]);
    expect(localsText(`${repo}/queue`).get("jobs_arn")?.trim()).toBe("aws_sqs_queue.jobs.arn");
  });
});

describe("the note's blast radius by resource", () => {
  it("lists each changed resource and what it reaches, in its root and through another root's output", () => {
    const report = {
      roots: [{ path: "queue" }, { path: "worker" }],
      blast: { roots: ["queue"], downstream: [{ root: "worker", reads: ["queue"], depth: 1, wave: 2, planned: true }], resources: resourceBlast(roots.slice(0, 2), ["queue"]) },
    } as unknown as Report;
    const t = blastLines(report)!;
    expect(t).toContain("**By resource:**\n\n- `aws_sqs_queue.jobs` in `queue` (update) reaches:\n  - `aws_sqs_queue_policy.jobs`\n");
    expect(t).toContain("  - `aws_lambda_function.worker` in `worker`, through output `jobs_arn` of `queue`\n");
  });
});
