// Plans shaped like `tofu show -json`, for the report tests. Only the fields
// the report and chant's adapter read are filled in.
import type { ReportRun } from "../src/report/schema";
import type { RootInput } from "../src/report/build";
import { planFiles } from "../src/report/build";

type Json = Record<string, unknown>;

export interface ChangeOpts {
  replace_paths?: (string | number)[][];
  after_unknown?: Json;
  before_sensitive?: Json | boolean;
  after_sensitive?: Json | boolean;
  importing?: { id: string };
  mode?: string;
}

export function rc(address: string, actions: string[], before: Json | null, after: Json | null, opts: ChangeOpts = {}): Json {
  const parts = address.split(".");
  const name = parts.pop()!;
  const type = parts.pop()!;
  return {
    address,
    mode: opts.mode ?? "managed",
    type,
    name,
    provider_name: "registry.opentofu.org/hashicorp/aws",
    change: {
      actions,
      before,
      after,
      after_unknown: opts.after_unknown ?? {},
      before_sensitive: opts.before_sensitive ?? (before ? {} : false),
      after_sensitive: opts.after_sensitive ?? (after ? {} : false),
      ...(opts.replace_paths ? { replace_paths: opts.replace_paths } : {}),
      ...(opts.importing ? { importing: opts.importing } : {}),
    },
  };
}

export function plan(changes: Json[], extra: Json = {}): Json {
  return { format_version: "1.2", terraform_version: "1.13.1", resource_changes: changes, output_changes: {}, timestamp: "2026-10-04T00:00:00Z", errored: false, ...extra };
}

export const RUN: ReportRun = {
  project: "forgejo.example/acme/infra",
  commit: "4f1a9c0e2b7d8a1c3e5f7a9b0c2d4e6f8a1b3c5d",
  base: "main",
  stage: "tf-plan",
  binary: "tofu",
  runtime: "forge",
  started: "2026-10-04T10:00:00.000Z",
  finished: "2026-10-04T10:03:00.000Z",
  job_url: "https://forgejo.example/acme/infra/actions/runs/42",
  terragucci: "0.2.0",
};

const queue = (env: string, timeout: number) =>
  rc("module.service.aws_sqs_queue.jobs", ["update"], { name: `${env}-jobs`, visibility_timeout_seconds: 30 }, { name: `${env}-jobs`, visibility_timeout_seconds: timeout });

const root = (path: string, changes: Json[], extra: Partial<RootInput> = {}): RootInput => ({ path, plan: plan(changes), planner: "tofu", files: planFiles(path), ...extra });

/** Four roots: two identical, one that destroys and carries a secret, one that refused to plan. */
export function smallFixture(): RootInput[] {
  return [
    root("envs/dev/orders", [queue("dev-orders", 60)]),
    root("envs/dev/search", [queue("dev-search", 60)]),
    root("envs/prod/orders", [
      queue("prod-orders", 60),
      rc("aws_db_instance.main", ["delete"], { identifier: "prod-orders", password: "hunter2" }, null, { before_sensitive: { password: true } }),
      rc("aws_iam_role_policy.app", ["update"], { policy: '{"Action":"s3:GetObject"}', name: "app" }, { policy: '{"Action":"s3:*"}', name: "app" }),
    ]),
    { path: "envs/prod/search", planner: "tofu", error: "plan failed:\nError: No valid credential sources found" },
  ];
}

/**
 * The 200-root fixture: 180 roots take one identical change (a queue
 * timeout and a tags-only change to a security group), 15 take it plus a
 * replacement, 2 destroy a database, 1 changes an IAM policy, 1 is an
 * outlier with its own timeout, and 1 refuses to plan.
 */
export function fixture200(): RootInput[] {
  const out: RootInput[] = [];
  for (let i = 0; i < 200; i++) {
    const path = `envs/r${String(i).padStart(3, "0")}/app`;
    const env = `r${String(i).padStart(3, "0")}`;
    const sg = rc("aws_security_group.app", ["update"], { name: `${env}-app`, tags: { team: "a" }, tags_all: { team: "a" } }, { name: `${env}-app`, tags: { team: "b" }, tags_all: { team: "b" } });
    const base = [queue(env, 60), sg];
    if (i < 180) out.push(root(path, base));
    else if (i < 195) {
      out.push(root(path, [...base, rc("aws_lambda_function.worker", ["delete", "create"], { function_name: `${env}-worker`, runtime: "nodejs20.x" }, { function_name: `${env}-worker`, runtime: "nodejs22.x" }, { replace_paths: [["runtime"]], after_unknown: { arn: true } })]));
    } else if (i < 197) out.push(root(path, [...base, rc("aws_db_instance.main", ["delete"], { identifier: `${env}-db` }, null)]));
    else if (i === 197) out.push(root(path, [...base, rc("aws_iam_role_policy.app", ["update"], { name: "app", policy: "a" }, { name: "app", policy: "b" })]));
    else if (i === 198) out.push(root(path, [queue(env, 300), sg]));
    else out.push({ path, planner: "tofu", error: "init failed:\nError: Failed to get existing workspaces" });
  }
  return out;
}
