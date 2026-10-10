import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import { loadConfig } from "../src/config";
import { convert, describeImport, importConfig, type ImportNote } from "../src/import";
import { TERRATEAM_TABLE } from "../src/import/guide";
import { dirGlob, queryGlobs, type RepoShape } from "../src/import/terrateam";
import { backend, remoteState, tmp, write } from "./helpers";

const GUIDE = join(__dirname, "../../../docs-site/src/content/docs/guides/coming-from-atlantis-or-opentaco.mdx");

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

const shape = (roots: string[], reads: Record<string, string[]> = {}): RepoShape => {
  const r = new Map(roots.map((x) => [x, new Set(reads[x] ?? [])]));
  const layers: string[][] = [];
  const done = new Set<string>();
  while (done.size < roots.length) {
    const layer = roots.filter((x) => !done.has(x) && [...r.get(x)!].every((u) => done.has(u)));
    layer.forEach((x) => done.add(x));
    layers.push(layer);
  }
  return { roots, layers, reads: r };
};

const run = (yaml: string, o: Parameters<typeof convert>[2] = {}) => convert("terrateam", parseYAML(yaml), o);
const note = (notes: ImportNote[], key: string): ImportNote | undefined => notes.find((n) => n.key === key);

describe("the guide's Terrateam table", () => {
  it("is guide.ts's, cell for cell", () => {
    expect(pageTable("| Setting | Terrateam |")).toEqual(TERRATEAM_TABLE.map((r) => [...r]));
  });
});

describe("tag queries and dirs keys", () => {
  it("reads dir:, relative_dir: and outputs: terms joined by or, and nothing else", () => {
    expect(queryGlobs("")).toEqual({ all: true });
    expect(queryGlobs("dir:network or dir:database")).toEqual({ globs: ["network", "database"] });
    expect(queryGlobs("relative_dir:../network", "envs/prod/database")).toEqual({ globs: ["envs/prod/network"] });
    expect(queryGlobs("vpc_id in outputs:network")).toEqual({ globs: ["network"] });
    expect(queryGlobs("prod and dir:network")).toBeUndefined();
    expect(queryGlobs("aws")).toBeUndefined();
    expect(queryGlobs("relative_dir:../../..", "a")).toBeUndefined();
  });

  it("takes a glob down to a file as its directory", () => {
    expect(dirGlob("**/terragrunt.hcl")).toBe("**");
    expect(dirGlob("prod/**/ec2/**")).toBe("prod/**/ec2/**");
    expect(dirGlob("./ec2/")).toBe("ec2");
    expect(dirGlob("../outside")).toBeUndefined();
  });
});

// Terrateam's layered-runs example: network, then database, then application.
const LAYERED = `dirs:
  network:
    when_modified:
      file_patterns: ["\${DIR}/*.tf"]
  database:
    when_modified:
      depends_on: 'dir:network'
      file_patterns: ["\${DIR}/*.tf"]
  application:
    when_modified:
      depends_on: 'dir:database'
      file_patterns: ["\${DIR}/*.tf"]
`;

describe("depends_on", () => {
  it("needs nothing where the roots' terraform_remote_state reads already give the order", () => {
    const { settings, notes } = run(LAYERED, { repo: shape(["application", "database", "network"], { database: ["network"], application: ["database"] }) });
    expect(settings.waves).toBeUndefined();
    expect(note(notes, "dirs.database.when_modified.depends_on")).toMatchObject({ kind: "default", detail: "the terraform_remote_state reads already order database after network" });
    expect(note(notes, "dirs.application.when_modified.depends_on")?.kind).toBe("default");
  });

  it("puts the roots a dependency waits on into waves.canary, with what they read", () => {
    const { settings, notes } = run(LAYERED, { repo: shape(["application", "database", "network"], { database: ["network"] }) });
    expect(settings.waves).toEqual({ canary: ["database", "network"] });
    expect(note(notes, "dirs.application.when_modified.depends_on")).toMatchObject({ kind: "mapped", row: "Order" });
  });

  it("keeps one step of order with no reads, and names the dependency that needs a second", () => {
    const { settings, notes } = run(LAYERED, { repo: shape(["application", "database", "network"]) });
    expect(settings.waves).toEqual({ canary: ["network"] });
    expect(note(notes, "dirs.database.when_modified.depends_on")?.kind).toBe("mapped");
    const late = note(notes, "dirs.application.when_modified.depends_on")!;
    expect(late.kind).toBe("unmapped");
    expect(late.detail).toMatch(/^application after database is not kept: waves.canary puts one set of roots first/);
  });

  it("reads a glob dir, a relative_dir and an outputs dependency against the repo's roots", () => {
    const yaml = `dirs:
  envs/staging/**:
    when_modified:
      depends_on: "dir:envs/dev/platform"
  envs/prod/database:
    when_modified:
      depends_on:
        tag_query: 'relative_dir:../network'
        prune_on_no_change: true
  envs/prod/app:
    when_modified:
      depends_on: 'endpoint in outputs:envs/prod/database'
`;
    const roots = ["envs/dev/platform", "envs/prod/app", "envs/prod/database", "envs/prod/network", "envs/staging/api", "envs/staging/web"];
    const { settings, notes } = run(yaml, { repo: shape(roots) });
    // prod/app after prod/database after prod/network is two steps: the first is kept.
    expect(settings.waves?.canary).toEqual(["envs/dev/platform", "envs/prod/network"]);
    expect(note(notes, "dirs.envs/staging/**.when_modified.depends_on")?.kind).toBe("mapped");
    expect(note(notes, "dirs.envs/prod/database.when_modified.depends_on")?.kind).toBe("mapped");
    expect(note(notes, "dirs.envs/prod/database.when_modified.depends_on.prune_on_no_change")?.kind).toBe("unmapped");
    expect(note(notes, "dirs.envs/prod/app.when_modified.depends_on")?.kind).toBe("unmapped");
  });

  it("names a query it cannot read and a dependency on no root", () => {
    const yaml = `dirs:
  app:
    when_modified:
      depends_on: 'network and not prod'
  web:
    when_modified:
      depends_on: 'dir:gone'
`;
    const { settings, notes } = run(yaml, { repo: shape(["app", "web"]) });
    expect(settings.waves).toBeUndefined();
    expect(note(notes, "dirs.app.when_modified.depends_on")?.detail).toContain('not "network and not prod"');
    expect(note(notes, "dirs.web.when_modified.depends_on: gone")?.detail).toBe("gone matches no root");
  });

  it("leaves a Terragrunt repo's order to its dependency blocks", () => {
    const { settings, notes } = run(`engine:\n  name: terragrunt\n  tf_cmd: tofu\n${LAYERED}`, { repo: shape(["application", "database", "network"]) });
    expect(settings.waves).toBeUndefined();
    expect(settings.binary).toBe("tofu");
    expect(note(notes, "dirs.database.when_modified.depends_on")?.detail).toBe("in a Terragrunt repo the units' dependency blocks order them");
  });
});

describe("apply requirements and timing", () => {
  it("applies before merge with the requirements the checks name, and names who must approve as not mapped", () => {
    // From Terrateam's apply requirements reference.
    const { settings, notes } = run(`apply_requirements:
  create_pending_apply_check: true
  checks:
    - tag_query: ""
      approved:
        enabled: true
        any_of: ["user:alice", "user:bob"]
        any_of_count: 1
        all_of: []
      merge_conflicts:
        enabled: true
      status_checks:
        enabled: true
        ignore_matching:
          - "ci/.*"
`);
    expect(settings.apply).toEqual({ when: "pull-request", requires: ["approved", "mergeable", "checks"] });
    expect(note(notes, "apply_requirements.checks[0].approved.any_of, all_of")?.kind).toBe("unmapped");
    expect(note(notes, "apply_requirements.checks[0].status_checks.ignore_matching")?.kind).toBe("unmapped");
    expect(note(notes, "apply_requirements.create_pending_apply_check")?.kind).toBe("unmapped");
  });

  it("keeps Terrateam's defaults for a check that leaves them out, and keeps one list when entries differ", () => {
    const { settings, notes } = run(`apply_requirements:
  checks:
    - tag_query: "dir:tf1"
      approved:
        enabled: true
        all_of: ["user:alice"]
    - tag_query: "dir:tf2"
      merge_conflicts:
        enabled: false
`);
    expect(settings.apply?.requires).toEqual(["approved", "mergeable", "checks"]);
    expect(note(notes, "apply_requirements.checks")?.detail).toContain("one list");
    expect(note(notes, "apply_requirements.checks[0].tag_query")?.kind).toBe("unmapped");
  });

  it("leaves requires unset when the config sets no checks", () => {
    const { settings, notes } = run("version: '1'\n");
    expect(settings.apply).toEqual({ when: "pull-request" });
    expect(note(notes, "apply_requirements")?.kind).toBe("default");
    expect(note(notes, "version")?.kind).toBe("default");
  });

  it("applies after merge under autoapply or apply_after_merge, where branch protection does the requirements' job", () => {
    for (const yaml of ["when_modified:\n  autoapply: true\n", "apply_requirements:\n  checks:\n    - tag_query: ''\n      apply_after_merge:\n        enabled: true\n"]) {
      const { settings, notes } = run(yaml);
      expect(settings.apply).toBeUndefined();
      expect(note(notes, "when it applies")?.kind).toBe("default");
    }
    const { notes } = run("when_modified:\n  autoapply: true\napply_requirements:\n  checks:\n    - tag_query: ''\n      approved:\n        enabled: true\n");
    expect(note(notes, "apply_requirements.checks[0] (approved)")?.detail).toMatch(/branch protection/);
  });

  it("names a directory's own autoapply, since apply.when is one setting", () => {
    const { notes } = run("dirs:\n  prod:\n    when_modified:\n      autoapply: true\n", { repo: shape(["prod", "staging"]) });
    expect(note(notes, "dirs.prod.when_modified.autoapply")?.kind).toBe("unmapped");
  });

  it("merges after apply on GitHub, and on GitLab applies after merge and says why", () => {
    const yaml = "automerge:\n  enabled: true\n  delete_branch: true\napply_requirements:\n  checks:\n    - tag_query: ''\n      approved:\n        enabled: true\n";
    expect(run(yaml, { forge: "github" }).settings.apply?.merge).toBe("auto");
    const gl = run(yaml, { forge: "gitlab" });
    expect(gl.settings.apply).toBeUndefined();
    expect(note(gl.notes, "when it applies")?.kind).toBe("unmapped");
    expect(note(gl.notes, "automerge.enabled")?.kind).toBe("unmapped");
  });
});

describe("engine, hooks and workflows", () => {
  it("writes the binary and version from engine or default_tf_version, and names engines it cannot run", () => {
    expect(run("engine:\n  name: tofu\n  version: '1.9.0'\n").settings).toMatchObject({ binary: "tofu", version: "1.9.0" });
    expect(run("default_tf_version: 1.5.7\n").settings).toMatchObject({ binary: "terraform", version: "1.5.7" });
    expect(run("engine:\n  name: terragrunt\n  version: 1.1.6\n  tf_version: '1.5.7'\n").settings).toMatchObject({ terragrunt: { version: "1.1.6" }, version: "1.5.7" });
    const old = run("engine:\n  name: terragrunt\n  version: 0.68.1\n");
    expect(old.settings.terragrunt).toBeUndefined();
    expect(note(old.notes, "engine.version")?.detail).toMatch(/1\.1 or later/);
    expect(note(run("engine:\n  name: terraform\n  version: '~> 1.5'\n").notes, "engine.version")?.kind).toBe("unmapped");
    expect(note(run("engine:\n  name: pulumi\n").notes, "engine")?.kind).toBe("unmapped");
    expect(note(run("engine:\n  name: cdktf\n").notes, "engine")?.detail).toMatch(/synth/);
    const mixed = run("engine:\n  name: tofu\nworkflows:\n  - tag_query: 'dir:legacy'\n    engine:\n      name: terraform\n");
    expect(mixed.settings.binary).toBeUndefined();
    expect(mixed.notes.some((n) => n.kind === "unmapped" && n.row === "Engine" && /one binary/.test(n.detail ?? ""))).toBe(true);
  });

  it("turns run hooks into steps from the repo's root, an echoed env hook into env, and names the rest", () => {
    // From Terrateam's hooks reference.
    const { settings, notes } = run(`hooks:
  all:
    pre:
      - type: oidc
        provider: aws
        role_arn: \${AWS_ROLE_ARN}
  plan:
    pre:
      - type: env
        name: TF_VAR_example
        cmd: ['echo', 'example_value']
      - type: env
        name: TOKEN
        cmd: ['cat', '/run/token']
        sensitive: true
  apply:
    post:
      - type: run
        cmd: ['./cleanup_script.sh']
        run_on: always
      - type: run
        cmd: ['curl', '-X', 'POST', '--data', '{"text":"done"}', '\${SLACK_WEBHOOK_URL}']
        ignore_errors: true
`);
    expect(settings.env).toEqual({ TF_VAR_example: "example_value" });
    expect(settings.steps).toEqual([
      { name: "hooks.apply.post[0]", run: 'cd "$TG_REPO" && ./cleanup_script.sh', after: "apply" },
      { name: "hooks.apply.post[1]", run: `cd "$TG_REPO" && curl -X POST --data '{"text":"done"}' \${SLACK_WEBHOOK_URL} || true`, after: "apply" },
    ]);
    expect(note(notes, "hooks.apply.post[0].run_on")?.kind).toBe("unmapped");
    expect(note(notes, "hooks.plan.pre[1]")?.detail).toMatch(/sensitive/);
    expect(note(notes, "hooks.all.pre[0]")).toMatchObject({ kind: "unmapped", row: "Cloud credentials" });
  });

  it("writes a workflow's run steps for the roots its dir: query names, at their place around init and plan", () => {
    const { settings, notes } = run(`workflows:
  - tag_query: "dir:envs/prod/payments or dir:envs/prod/orders"
    plan:
      - type: run
        cmd: ['tfenv', 'install']
      - type: init
      - type: run
        cmd: ['tflint']
        on_error:
          - type: gate
            token: lint
            any_of: ['team:sre']
      - type: plan
        extra_args: ['-lock=false']
      - type: conftest
    apply:
      - type: init
      - type: apply
      - type: run
        cmd: ['./notify.sh', 'applied']
  - tag_query: "prod"
    plan:
      - type: run
        cmd: ['echo', 'prod']
`);
    const roots = ["envs/prod/payments", "envs/prod/orders"];
    expect(settings.steps).toEqual([
      { name: "workflows[0].plan[0]", run: "tfenv install", before: "init", roots },
      { name: "workflows[0].plan[2]", run: "tflint", before: "plan", roots, on_failure: "approve" },
      { name: "workflows[0].apply[2]", run: "./notify.sh applied", after: "apply", roots },
    ]);
    expect(note(notes, "workflows[0].plan[3].extra_args")?.kind).toBe("left-out");
    expect(note(notes, "workflows[0].plan[4]")).toMatchObject({ kind: "unmapped", row: "Policy" });
    expect(note(notes, "workflows[1].plan[0]")?.detail).toMatch(/cannot tell which roots/);
  });
});

describe("the rest of the file", () => {
  // Every top-level key Terrateam's schema has, so none goes unnamed.
  const ALL = `version: "1"
enabled: true
checkout_strategy: merge
create_and_select_workspace: true
parallel_runs: 1
lock_policy: none
indexer:
  enabled: false
batch_runs:
  enabled: true
storage:
  plans:
    method: terrateam
destination_branches: [main]
default_branch_overrides: []
tags:
  branch: {}
cost_estimation:
  enabled: true
  currency: EUR
drift:
  enabled: true
  schedules:
    nightly:
      tag_query: ""
      schedule: daily
      reconcile: true
    weekly-prod:
      tag_query: "dir:prod"
      schedule: weekly
access_control:
  enabled: true
  policies:
    - tag_query: ''
      plan: ['*']
      apply: ['role:maintain']
  unlock: ['*']
integrations:
  resourcely:
    enabled: false
notifications: {}
config_builder:
  enabled: false
tree_builder:
  enabled: false
stacks: {}
dirs:
  prod:
    tags: [prod]
    workspaces:
      default: {}
      blue:
        tags: [blue]
    lock_branch_target: all
`;

  it("names every key the file carries", () => {
    const { settings, notes } = run(ALL, { repo: shape(["prod"]) });
    for (const k of Object.keys(parseYAML(ALL) as Record<string, unknown>)) {
      expect(notes.some((n) => n.key === k || n.key.startsWith(`${k}.`) || n.key.startsWith(`${k}[`)), k).toBe(true);
    }
    expect(settings).toMatchObject({ parallelism: 1, cost: true, drift: "17 4 * * *" });
    expect(note(notes, "lock_policy")?.kind).toBe("unmapped");
    expect(note(notes, "drift.schedules.weekly-prod")?.kind).toBe("unmapped");
    expect(note(notes, "drift.schedules.nightly.reconcile")?.kind).toBe("unmapped");
    expect(note(notes, "cost_estimation.currency")?.kind).toBe("unmapped");
    expect(note(notes, "dirs.prod.workspaces.blue")?.detail).toBe("workspace blue is not planned");
    expect(note(notes, "access_control.policies")?.row).toBe("Access control");
    expect(note(notes, "storage")?.text).toMatch(/the guide has no row for it/);
  });
});

describe("terragucci import terrateam, on a repo", () => {
  const repo = (): string =>
    write(tmp(), {
      "network/main.tf": backend("network.tfstate"),
      "database/main.tf": backend("database.tfstate") + remoteState("network.tfstate"),
      "application/main.tf": backend("application.tfstate"),
      "modules/vpc/main.tf": "variable \"cidr\" {}\n",
      ".github/workflows/x.yml": "on: push\n",
      ".terrateam/config.yml": `${LAYERED}  modules/**:\n    when_modified:\n      file_patterns: []\n  gone:\n    tags: [old]\n`,
    });

  it("writes terragucci.yml that config check reads, ordered by the reads and the canary, and names dirs that match no root", async () => {
    const dir = repo();
    const r = importConfig(dir, "terrateam");
    expect(r.from).toBe(".terrateam/config.yml");
    const cfg = await loadConfig(join(dir, "terragucci.yml"));
    expect(cfg.roots).toBeUndefined();
    expect(cfg.waves).toEqual({ canary: ["database", "network"] });
    expect(r.missing).toEqual(["gone"]);
    const text = describeImport(r);
    expect(text).toContain("No root matches the dirs gone; check those keys.");
    expect(text).toContain("dirs.modules/**.when_modified.file_patterns (Which directories): no root here");
    expect(text).toContain("#terrateam");
  });

  it("says which file it looked for when there is none", () => {
    expect(() => importConfig(tmp(), "terrateam")).toThrow(/\.terrateam\/config\.yml or \.terrateam\/config\.yaml/);
  });
});
