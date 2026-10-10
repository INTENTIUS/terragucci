import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { describeImport, importConfig, type ImportNote } from "../src/import";
import { parseHcl, resourcesOf } from "../src/import/hcl";
import { SPACELIFT_ENV0_TABLE } from "../src/import/spacelift-env0-guide";
import { slugOf } from "../src/import/spacelift";
import { backend, remoteState, tmp, write } from "./helpers";

const GUIDE = join(__dirname, "../../../docs-site/src/content/docs/guides/coming-from-spacelift-or-env-zero.mdx");

function pageTable(header: string): string[][] {
  const lines = readFileSync(GUIDE, "utf-8").split("\n");
  const at = lines.findIndex((l) => l.startsWith(header));
  expect(at, `the guide has a table starting ${header}`).toBeGreaterThan(-1);
  const rows: string[][] = [];
  for (const l of lines.slice(at + 2)) {
    if (!l.startsWith("|")) break;
    rows.push(l.trim().slice(1, -1).split("|").map((c) => c.trim()));
  }
  return rows;
}

const note = (notes: ImportNote[], key: string): ImportNote | undefined => notes.find((n) => n.key === key);

describe("the guide's concepts table", () => {
  it("is spacelift-env0-guide.ts's, cell for cell", () => {
    expect(pageTable("| Concept | Spacelift | env zero | terragucci |")).toEqual(SPACELIFT_ENV0_TABLE.map((r) => [...r]));
  });
});

describe("the resource reader", () => {
  it("reads strings, bools, lists, references, file() and blocks, past comments and heredocs", () => {
    const body = parseHcl(`
# a comment with "quotes" and { braces
resource "spacelift_stack" "app" {
  name        = "App Stack" // trailing
  autodeploy  = true
  before_init = ["echo \\"hi\\"", "make init"]
  labels      = ["feature:x", "autoattach:prod"]
  space_id    = spacelift_space.prod.id
  count       = var.on ? 1 : 0
  description = <<-EOT
    two
    lines
  EOT
  github_enterprise {
    namespace = "acme"
  }
}
resource "spacelift_policy" "plan" {
  type = "PLAN"
  body = file("\${path.module}/policies/plan.rego")
}
`);
    const [stack, policy] = body.blocks;
    expect(stack.labels).toEqual(["spacelift_stack", "app"]);
    expect(stack.body.attrs.name).toBe("App Stack");
    expect(stack.body.attrs.autodeploy).toBe(true);
    expect(stack.body.attrs.before_init).toEqual(['echo "hi"', "make init"]);
    expect(stack.body.attrs.space_id).toEqual({ ref: "spacelift_space.prod.id" });
    expect(stack.body.attrs.count).toEqual({ expr: "var.on ? 1 : 0" });
    expect(stack.body.attrs.description).toBe("two\nlines\n");
    expect(stack.body.blocks[0]).toMatchObject({ type: "github_enterprise", body: { attrs: { namespace: "acme" } } });
    expect(policy.body.attrs.body).toEqual({ file: "${path.module}/policies/plan.rego" });
  });

  it("makes stack IDs as Spacelift does", () => {
    expect(slugOf("Prod Network (eu)")).toBe("prod-network-eu");
  });
});

// The admin stack: three stacks, a dependency the reads give and one they do not, a context, variables, drift and policies.
const ADMIN = `
resource "spacelift_stack" "network" {
  name              = "network"
  repository        = "infra"
  branch            = "main"
  project_root      = "network"
  terraform_version = "1.9.8"
  autodeploy        = false
  before_init       = ["tflint"]
}

resource "spacelift_stack" "database" {
  name                    = "Database"
  repository              = "infra"
  branch                  = "main"
  project_root            = "database"
  terraform_version       = "1.9.8"
  terraform_workspace     = "prod"
  worker_pool_id          = spacelift_worker_pool.private.id
}

resource "spacelift_stack" "app" {
  name         = "app"
  slug         = "application"
  repository   = "infra"
  branch       = "main"
  project_root = "app"
  manage_state = false
  autodeploy   = true
  labels       = ["prod"]
}

resource "spacelift_stack_dependency" "db_on_network" {
  stack_id            = spacelift_stack.database.id
  depends_on_stack_id = spacelift_stack.network.id
}

resource "spacelift_stack_dependency" "app_on_db" {
  stack_id            = spacelift_stack.app.id
  depends_on_stack_id = spacelift_stack.database.id
}

resource "spacelift_stack_dependency_reference" "vpc" {
  stack_dependency_id = spacelift_stack_dependency.db_on_network.id
  output_name         = "vpc_id"
  input_name          = "TF_VAR_vpc_id"
}

resource "spacelift_context" "shared" {
  name   = "shared"
  labels = ["autoattach:*"]
  after_plan = ["infracost breakdown --path ."]
}

resource "spacelift_environment_variable" "region" {
  context_id = spacelift_context.shared.id
  name       = "AWS_REGION"
  value      = "eu-west-1"
  write_only = false
}

resource "spacelift_environment_variable" "db_password" {
  stack_id = spacelift_stack.database.id
  name     = "TF_VAR_db_password"
  value    = var.db_password
}

resource "spacelift_environment_variable" "app_only" {
  stack_id   = spacelift_stack.app.id
  name       = "TF_VAR_replicas"
  value      = "3"
  write_only = false
}

resource "spacelift_mounted_file" "kubeconfig" {
  stack_id      = spacelift_stack.app.id
  relative_path = "kubeconfig"
  content       = filebase64("kubeconfig")
}

resource "spacelift_drift_detection" "network" {
  stack_id  = spacelift_stack.network.id
  schedule  = ["0 4 * * *"]
  reconcile = true
}

resource "spacelift_policy" "plan" {
  name = "no-public-buckets"
  type = "PLAN"
  body = file("\${path.module}/policies/plan.rego")
}

resource "spacelift_policy" "login" {
  name = "sso"
  type = "LOGIN"
  body = file("\${path.module}/policies/login.rego")
}

resource "spacelift_worker_pool" "private" {
  name = "private"
}

resource "spacelift_aws_integration" "prod" {
  name     = "prod"
  role_arn = "arn:aws:iam::1:role/spacelift"
}
`;

const CONFIG = `version: "1"
stack_defaults:
  environment:
    TF_IN_AUTOMATION_HINT: "1"
  after_apply:
    - ./scripts/notify.sh
stacks:
  network: &shared
    before_plan:
      - terraform fmt -check
  database:
    <<: *shared
  application:
    runner_image: acme/runner:1
    after_apply:
      - ./scripts/smoke.sh
    environment:
      TF_VAR_tier: web
`;

const repo = (files: Record<string, string> = {}): string =>
  write(tmp(), {
    "network/main.tf": backend("network.tfstate"),
    "database/main.tf": backend("database.tfstate") + remoteState("network.tfstate"),
    "app/main.tf": backend("app.tfstate"),
    "admin/main.tf": `terraform {\n  required_providers {\n    spacelift = { source = "spacelift-io/spacelift" }\n  }\n}\nprovider "spacelift" {}\n` + ADMIN,
    ".spacelift/config.yml": CONFIG,
    ...files,
  });

describe("terragucci import spacelift, on a repo", () => {
  it("writes the stacks' roots, version, hooks as steps, dependencies as waves, env, secrets and the gate", async () => {
    const dir = repo();
    const r = importConfig(dir, "spacelift", { forge: "github" });
    expect(r.from).toBe(".spacelift/config.yml, admin/main.tf");
    const cfg = await loadConfig(join(dir, "terragucci.yml"));
    expect(cfg.roots).toEqual(["app", "database", "network"]);
    expect(cfg.version).toBe("1.9.8");
    // database after network comes from the reads; app after database does not.
    expect(cfg.waves).toEqual({ after: { app: ["database"] } });
    expect(cfg.env).toEqual({ TF_IN_AUTOMATION_HINT: "1", AWS_REGION: "eu-west-1" });
    expect(cfg.pass).toEqual({ secrets: ["TF_VAR_db_password"] });
    expect(cfg.drift).toBe("0 4 * * *");
    expect(cfg.gate).toBeUndefined();
    expect(note(r.notes, "spacelift_stack.network.autodeploy")).toMatchObject({ kind: "unmapped", row: "Approval" });
    expect(cfg.steps).toEqual(
      expect.arrayContaining([
        { name: "before_init", run: "tflint", before: "init", roots: ["network"] },
        { name: "before_plan", run: "terraform fmt -check", before: "plan", roots: ["database", "network"] },
        { name: "after_plan", run: "infracost breakdown --path .", after: "plan" },
        { name: "after_apply", run: "./scripts/notify.sh", after: "apply", roots: ["database", "network"] },
        { name: "after_apply", run: "./scripts/smoke.sh", after: "apply", roots: ["app"] },
      ]),
    );
    const n = r.notes;
    expect(note(n, "spacelift_stack_dependency.db_on_network")?.kind).toBe("default");
    expect(note(n, "spacelift_stack_dependency.app_on_db")).toMatchObject({ kind: "mapped", detail: "waves.after: app after database" });
    expect(note(n, "spacelift_stack_dependency_reference.vpc")?.kind).toBe("unmapped");
    expect(note(n, "spacelift_stack.network.manage_state")).toMatchObject({ kind: "unmapped", row: "Managed state" });
    expect(note(n, "spacelift_stack.app.manage_state")).toMatchObject({ kind: "default", row: "Own backend" });
    expect(note(n, "spacelift_stack.database.terraform_workspace")?.kind).toBe("unmapped");
    expect(note(n, "spacelift_stack.database.worker_pool_id")?.row).toBe("Workers");
    expect(note(n, "spacelift_environment_variable.app_only")?.kind).toBe("unmapped");
    expect(note(n, "spacelift_mounted_file.kubeconfig")?.detail).toMatch(/kubeconfig is secret/);
    expect(note(n, "spacelift_drift_detection.network.reconcile")?.kind).toBe("unmapped");
    expect(note(n, "spacelift_policy.plan")?.detail).toMatch(/policies\/plan\.rego into policy with input: plan/);
    expect(note(n, "spacelift_policy.login")?.row).toBe("Access");
    expect(note(n, "spacelift_aws_integration.prod")?.row).toBe("Cloud credentials");
    expect(note(n, "stacks.application.runner_image")?.row).toBe("Runner image");
    expect(note(n, "stacks.application.environment.TF_VAR_tier")?.kind).toBe("unmapped");
    const text = describeImport(r);
    expect(text).toContain("spacelift_stack_dependency.app_on_db (Order): waves.after: app after database. The guide: waves:");
    expect(text).toContain("coming-from-spacelift-or-env-zero");
  });

  it("writes gate: always when every stack waits for a confirmation, and a version per root when they differ", async () => {
    const dir = write(tmp(), {
      "a/main.tf": backend("a.tfstate"),
      "b/main.tf": backend("b.tfstate"),
      "admin/stacks.tf": `resource "spacelift_stack" "a" {\n  name = "a"\n  project_root = "a"\n  terraform_workflow_tool = "OPEN_TOFU"\n  terraform_version = "1.8.5"\n}\nresource "spacelift_stack" "b" {\n  name = "b"\n  project_root = "b"\n  terraform_workflow_tool = "OPEN_TOFU"\n  terraform_version = "1.9.1"\n}\n`,
    });
    const r = importConfig(dir, "spacelift");
    expect(r.from).toBe("admin/stacks.tf");
    const cfg = await loadConfig(join(dir, "terragucci.yml"));
    expect(cfg.gate).toBe("always");
    expect(cfg.binary).toBe("tofu");
    expect(cfg.version).toEqual({ a: "1.8.5", b: "1.9.1" });
  });

  it("names stacks that share one project root", () => {
    const dir = write(tmp(), {
      "net/main.tf": backend("net.tfstate"),
      ".spacelift/config.yml": "stacks:\n  net-dev:\n    project_root: net\n  net-prod:\n    project_root: net\n",
    });
    const r = importConfig(dir, "spacelift", { dryRun: true });
    expect(r.settings.roots).toEqual(["net"]);
    expect(note(r.notes, "stacks.net-dev, stacks.net-prod")).toMatchObject({ kind: "unmapped", row: "Shared code" });
  });

  it("says what it looked for when there is nothing to read", () => {
    expect(() => importConfig(tmp(), "spacelift")).toThrow(/\.spacelift\/config\.yml or spacelift_stack resources/);
  });
});
