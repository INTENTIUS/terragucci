import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { describeImport, importConfig, type ImportNote } from "../src/import";
import { ttlOf } from "../src/import/env0";
import { backend, tmp, write } from "./helpers";

const note = (notes: ImportNote[], key: string): ImportNote | undefined => notes.find((n) => n.key === key);

// The admin code: two templates, three environments (one with a TTL), variables, a project policy and drift.
const ADMIN = `
resource "env0_project" "web" {
  name = "web"
}

resource "env0_project_policy" "web" {
  project_id              = env0_project.web.id
  default_ttl             = "3-d"
  max_ttl                 = "1-w"
  include_cost_estimation = true
}

resource "env0_template" "network" {
  name              = "network"
  repository        = "https://github.com/acme/infra"
  type              = "opentofu"
  path              = "network"
  opentofu_version  = "1.8.5"
}

resource "env0_template" "app" {
  name             = "app"
  repository       = "https://github.com/acme/infra"
  type             = "opentofu"
  path             = "app"
  opentofu_version = "1.8.5"
}

resource "env0_environment" "network" {
  name                       = "network-prod"
  project_id                 = env0_project.ops.id
  template_id                = env0_template.network.id
  approve_plan_automatically = false
  is_remote_backend          = true
  workspace                  = "prod"

  configuration {
    name         = "db_password"
    value        = var.db_password
    type         = "terraform"
    is_sensitive = true
  }

  configuration {
    name  = "cidr"
    value = "10.0.0.0/16"
    type  = "terraform"
  }
}

resource "env0_environment" "preview" {
  name                       = "app-preview"
  project_id                 = env0_project.web.id
  template_id                = env0_template.app.id
  approve_plan_automatically = false
}

resource "env0_configuration_variable" "region" {
  name  = "AWS_REGION"
  value = "us-east-1"
}

resource "env0_configuration_variable" "token" {
  name         = "API_TOKEN"
  value        = var.token
  is_sensitive = true
}

resource "env0_environment_drift_detection" "network" {
  environment_id = env0_environment.network.id
  cron           = "0 4 * * *"
}

resource "env0_aws_credentials" "prod" {
  name = "prod"
  arn  = "arn:aws:iam::1:role/env0"
}
`;

const DISCOVERY = `environments:
  search:
    name: search-prod
    projectName: production
    templateName: Search
    requiresApproval: true
    continuousDeployment: true
    pullRequestPlanDeployments: true
    vcsCommandsAlias: search
    variableFiles:
      - path: search/terraform.tfvars
      - path: vars/common.tfvars
`;

const FLOW = `version: 2
deploy:
  steps:
    setupVariables:
      after:
        - echo "TF_LOG=INFO" >> $ENV0_ENV
    terraformPlan:
      before:
        - tflint
        - name: check
          run: ./scripts/check.sh
    terraformApply:
      after:
        - ./scripts/smoke.sh
  onFailure:
    - ./scripts/page.sh
destroy:
  steps:
    terraformDestroy:
      before:
        - echo bye
`;

const repo = (): string =>
  write(tmp(), {
    "network/main.tf": backend("network.tfstate"),
    "app/main.tf": backend("app.tfstate"),
    "search/main.tf": backend("search.tfstate"),
    "search/terraform.tfvars": "x = 1\n",
    "network/env0.yml": FLOW,
    "admin/main.tf": `provider "env0" {}\n${ADMIN}`,
    "env0-discovery.yml": DISCOVERY,
  });

describe("env zero TTLs", () => {
  it("reads <n>-h, -d, -w and -M as terragucci's, and nothing else", () => {
    expect(ttlOf("12-h")).toBe("12h");
    expect(ttlOf("3-d")).toBe("3d");
    expect(ttlOf("1-w")).toBe("7d");
    expect(ttlOf("1-M")).toBe("30d");
    expect(ttlOf("Infinite")).toBeUndefined();
    expect(ttlOf("inherit")).toBeUndefined();
  });
});

describe("terragucci import env0, on a repo", () => {
  it("writes the environments' roots, binary, version, steps, ephemeral, env, secrets and drift", async () => {
    const dir = repo();
    const r = importConfig(dir, "env0", { forge: "github" });
    expect(r.from).toBe("env0-discovery.yml, network/env0.yml, admin/main.tf");
    const cfg = await loadConfig(join(dir, "terragucci.yml"));
    expect(cfg.roots).toEqual(["app", "network", "search"]);
    expect(cfg.binary).toBe("tofu");
    expect(cfg.version).toBe("1.8.5");
    expect(cfg.gate).toBe("always");
    expect(cfg.ephemeral).toEqual({ roots: ["app"], ttl: "3d" });
    expect(cfg.cost).toBe(true);
    expect(cfg.drift).toBe("0 4 * * *");
    expect(cfg.env).toEqual({ AWS_REGION: "us-east-1" });
    expect(cfg.pass).toEqual({ secrets: ["API_TOKEN", "TF_VAR_db_password"] });
    expect(cfg.steps).toHaveLength(2);
    expect(r.settings.steps).toEqual([
      { name: "network/env0.yml: deploy.steps.terraformPlan.before", run: "set -e\ntflint\n./scripts/check.sh", before: "plan", roots: ["network"] },
      { name: "network/env0.yml: deploy.steps.terraformApply.after", run: "./scripts/smoke.sh", after: "apply", roots: ["network"] },
    ]);
    const n = r.notes;
    expect(note(n, "environments.search.variableFiles")).toMatchObject({ kind: "mapped", row: "Root" });
    expect(note(n, "environments.search.variableFiles[0]")?.kind).toBe("default");
    expect(note(n, "environments.search.variableFiles[1]")?.detail).toMatch(/copy vars\/common\.tfvars to search\/terraform\.tfvars/);
    expect(note(n, "environments.search.vcsCommandsAlias")?.kind).toBe("unmapped");
    expect(note(n, "env0_environment.network.is_remote_backend")).toMatchObject({ kind: "unmapped", row: "Managed state" });
    expect(note(n, "env0_environment.network.workspace")?.row).toBe("Workspace");
    expect(note(n, "env0_environment.network.configuration: cidr")?.detail).toMatch(/set cidr in network\/terraform\.tfvars/);
    expect(note(n, "network/env0.yml: deploy.steps.setupVariables.after[0]")).toMatchObject({ kind: "unmapped", row: "Variables" });
    expect(note(n, "network/env0.yml: deploy.onFailure")?.kind).toBe("unmapped");
    expect(note(n, "network/env0.yml: destroy")?.kind).toBe("unmapped");
    expect(note(n, "env0_aws_credentials.prod")?.row).toBe("Cloud credentials");
    expect(describeImport(r)).toContain("env0_project_policy.web.default_ttl (TTL): ephemeral.ttl: 3d");
  });

  it("runs a custom flow at the repo's root from there, for every root, and takes its fixed env", async () => {
    const dir = write(tmp(), {
      "a/main.tf": backend("a.tfstate"),
      "env0.yml": `version: 2\nshell: bash\ndeploy:\n  steps:\n    setupVariables:\n      after:\n        - echo "TF_LOG=INFO" >> $ENV0_ENV\n    terraformInit:\n      before:\n        - echo "it's"\n`,
    });
    const r = importConfig(dir, "env0");
    const cfg = await loadConfig(join(dir, "terragucci.yml"));
    expect(cfg.env).toEqual({ TF_LOG: "INFO" });
    expect(cfg.steps).toEqual([{ name: "env0.yml: deploy.steps.terraformInit.before", run: `cd "$TG_REPO" && bash -c 'echo "it'\\''s"'`, before: "init" }]);
    expect(r.settings.roots).toBeUndefined();
  });

  it("names an environment whose directory it cannot tell, and writes no roots", () => {
    const dir = write(tmp(), {
      "a/main.tf": backend("a.tfstate"),
      "env0-discovery.yml": "environments:\n  a:\n    name: a\n    templateName: A\n    workspaceName: one\n",
    });
    const r = importConfig(dir, "env0", { dryRun: true });
    expect(r.settings.roots).toBeUndefined();
    expect(note(r.notes, "environments.a")).toMatchObject({ kind: "unmapped", row: "Root" });
    expect(note(r.notes, "environments.a.workspaceName")?.row).toBe("Workspace");
  });

  it("says what it looked for when there is nothing to read", () => {
    expect(() => importConfig(tmp(), "env0")).toThrow(/env0-discovery\.yml, env0\.yml custom flows or env0_\* resources/);
  });
});
