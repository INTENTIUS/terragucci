import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import { loadConfig } from "../src/config";
import { convert, describeImport, importConfig, rootOf, type ImportNote } from "../src/import";
import { APPLY_TIMING_TABLE, COMMENT_TABLE, LEFT_OUT_TABLE, SETTINGS_TABLE } from "../src/import/guide";
import { backend, tmp, write } from "./helpers";

const GUIDE = join(__dirname, "../../../docs-site/src/content/docs/guides/coming-from-atlantis-or-opentaco.mdx");

/** The table whose header line starts with `header`, as rows of cells. */
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

describe("the guide and the import share one table", () => {
  it.each([
    ["Settings", "| Setting | Atlantis |", SETTINGS_TABLE],
    ["Left out on purpose", "| Not here |", LEFT_OUT_TABLE],
    ["Apply before or after merge", "| | Atlantis | OpenTaco | terragucci |", APPLY_TIMING_TABLE],
    ["Comment commands", "| To do this | Atlantis |", COMMENT_TABLE],
  ] as const)("%s: the page's rows are guide.ts's, cell for cell", (_, header, table) => {
    expect(pageTable(header)).toEqual(table.map((r) => [...r]));
  });
});

const ATLANTIS = `version: 3
automerge: true
parallel_plan: false
abort_on_execution_order_fail: true
projects:
- name: dev-net
  dir: ./envs/dev/net/
  terraform_version: v1.6.2
  autoplan:
    when_modified: ["*.tf", "../../modules/**/*.tf"]
    enabled: false
  apply_requirements: [approved, mergeable]
  repo_locks:
    mode: on_plan
  workflow: tf
- name: dev-app
  dir: envs/dev/app
  terraform_version: 1.6.2
  apply_requirements: [approved, undiverged]
  execution_order_group: 2
  depends_on: [dev-net]
  custom_policy_check: true
- name: blue
  dir: envs/dev/app
  workspace: blue
  plan_requirements: [approved]
  import_requirements: [approved]
  branch: /main/
workflows:
  tf:
    plan:
      steps:
      - env:
          name: TF_VAR_team
          value: shop
      - env:
          name: TOKEN
          command: cat /run/token
      - init
      - plan:
          extra_args: ["-lock=false"]
      - run: tflint
    policy_check:
      steps: [policy_check]
    import:
      steps: [init, import]
    state_rm:
      steps: [state_rm]
`;

const DIGGER = `projects:
- name: dev
  dir: dev
  opentofu: true
  include_patterns: ["../modules/**"]
  aws_role_to_assume:
    state: arn:aws:iam::1:role/state
    command: arn:aws:iam::1:role/cmd
  workflow: main
- name: prod
  dir: prod
  opentofu: true
  depends_on: [dev]
generate_projects:
  include: "teams/*"
  exclude: "teams/old"
auto_merge: true
pr_locks: false
workflows:
  main:
    env_vars:
      state:
      - name: TF_VAR_region
        value: eu-west-1
      commands:
      - name: SECRET
        value_from: SECRET
    plan:
      steps:
      - init:
          extra_args: ["-upgrade"]
      - run: "echo hi"
    workflow_configuration:
      on_pull_request_pushed: ["digger plan"]
      on_pull_request_closed: ["digger unlock"]
      on_commit_to_default: ["digger apply"]
`;

const note = (notes: ImportNote[], key: string): ImportNote | undefined => notes.find((n) => n.key === key);

describe("import atlantis", () => {
  const { settings, notes } = convert("atlantis", parseYAML(ATLANTIS));

  it("writes the projects' directories as roots, one per directory, and the version they pin", () => {
    expect(settings.roots).toEqual(["envs/dev/app", "envs/dev/net"]);
    expect(settings.binary).toBe("terraform");
    expect(settings.version).toBe("1.6.2");
    expect(settings.parallelism).toBe(1);
    expect(settings.locks).toBe("plan");
  });

  it("writes depends_on as waves.after, by the projects' directories", () => {
    expect(settings.waves).toEqual({ after: { "envs/dev/app": ["envs/dev/net"] } });
    expect(note(notes, "projects[dev-app].depends_on")).toMatchObject({ kind: "mapped", row: "Order", detail: "waves.after: envs/dev/app after envs/dev/net" });
  });

  it("names a depends_on that names no project, and leaves out an order the reads already give", () => {
    const yaml = `version: 3
projects:
- name: net
  dir: net
- name: app
  dir: app
  depends_on: [net, dns]
`;
    const r = convert("atlantis", parseYAML(yaml), { repo: { roots: ["app", "net"], layers: [["net"], ["app"]], reads: new Map([["app", new Set(["net"])]]) } });
    expect(r.settings.waves).toBeUndefined();
    expect(note(r.notes, "projects[app].depends_on: dns")).toMatchObject({ kind: "unmapped", detail: '"dns" names no project' });
    expect(note(r.notes, "projects[app].depends_on")).toMatchObject({ kind: "default", detail: "the terraform_remote_state reads already order app after net" });
  });

  it("applies before merge, as Atlantis does, with the requirements every project named, mergeable as mergeable and checks", () => {
    expect(settings.apply).toEqual({ when: "pull-request", requires: ["approved", "mergeable", "undiverged", "checks"], merge: "auto" });
    expect(note(notes, "projects[dev-net].apply_requirements")).toMatchObject({ kind: "mapped", row: "Checks green", detail: "apply.requires: mergeable, checks" });
    expect(note(notes, "projects[].apply_requirements: approved")).toMatchObject({ kind: "mapped", row: "Required approval" });
    expect(note(notes, "projects[].apply_requirements")?.detail).toContain("2 of 3 projects");
  });

  it("writes env steps that set a fixed value to env, and names the rest", () => {
    expect(settings.env).toEqual({ TF_VAR_team: "shop" });
    expect(note(notes, "workflows.tf.plan.steps[1].env")).toMatchObject({ kind: "unmapped", row: "Custom steps" });
    expect(note(notes, "workflows.tf.plan.steps[4].run")).toMatchObject({ kind: "unmapped", row: "Custom steps" });
  });

  it("quotes the guide's rule for what terragucci leaves out on purpose", () => {
    const rule = LEFT_OUT_TABLE.find((r) => r[0] === "`import` or `state rm` from a comment")!;
    for (const key of ["workflows.tf.import", "workflows.tf.state_rm", "projects[blue].import_requirements"]) {
      const n = note(notes, key)!;
      expect(n.kind).toBe("left-out");
      expect(n.text).toBe(`${rule[2]}. Instead: ${rule[3]}`);
    }
    expect(note(notes, "workflows.tf.plan.steps[3].plan.extra_args")).toMatchObject({ kind: "left-out", row: "Flags at run time" });
  });

  it("names every setting it did not write, with the guide's cell", () => {
    const cell = (row: string) => SETTINGS_TABLE.find((r) => r[0] === row)![3];
    expect(note(notes, "projects[blue].workspace")).toMatchObject({ kind: "unmapped", row: "Workspace", text: cell("Workspace") });
    expect(note(notes, "projects[dev-app].execution_order_group")).toMatchObject({ kind: "unmapped", row: "Order" });
    expect(note(notes, "projects[blue].plan_requirements")).toMatchObject({ kind: "unmapped", row: "Plan requirements" });
    expect(note(notes, "projects[dev-net].autoplan.enabled")).toMatchObject({ kind: "unmapped", row: "What triggers a plan" });
    expect(note(notes, "projects[].autoplan.when_modified")).toMatchObject({ kind: "default", row: "What triggers a plan" });
    expect(note(notes, "workflows.tf.policy_check")).toMatchObject({ kind: "unmapped", row: "Policy" });
    expect(note(notes, "projects[dev-app].custom_policy_check")).toMatchObject({ kind: "unmapped", row: "Policy" });
    // A key the guide has no row for is named, not dropped.
    expect(note(notes, "projects[blue].branch")).toMatchObject({ kind: "unmapped", row: "" });
  });

  it("ties every note to a row whose source cells name the setting", () => {
    const words = (cells: string[]) => new Set(cells.flatMap((c) => [...c.matchAll(/`([^`]+)`/g)].flatMap((m) => m[1].split(/[^A-Za-z_]+/))).filter(Boolean));
    const both = [...notes, ...convert("digger", parseYAML(DIGGER)).notes];
    for (const n of both.filter((x) => x.row)) {
      const settings = SETTINGS_TABLE.find((r) => r[0] === n.row);
      const left = LEFT_OUT_TABLE.find((r) => r[0] === n.row);
      expect(settings ?? left, `${n.key}: ${n.row} is a row of the guide`).toBeDefined();
      const named = words(settings ? [settings[1], settings[2]] : [left![1]]);
      const segments = n.key.replace(/\[[^\]]*\]/g, "").replace(/:.*/, "").split(".").filter((s) => s !== "projects" && s !== "steps");
      expect(segments.some((s) => named.has(s)), `${n.key} is named in the ${n.row} row`).toBe(true);
    }
  });

  it("leaves apply.when at merge with --apply-when merge, and says branch protection does the requirements' job", () => {
    const r = convert("atlantis", parseYAML(ATLANTIS), { applyWhen: "merge" });
    expect(r.settings.apply).toBeUndefined();
    expect(note(r.notes, "projects[dev-net].apply_requirements")).toMatchObject({ kind: "unmapped", row: "Checks green" });
    expect(note(r.notes, "automerge")).toMatchObject({ kind: "unmapped", row: "Merge after apply" });
  });

  it("on GitLab applies after merge and takes no plan locks, and says why", () => {
    const r = convert("atlantis", parseYAML(ATLANTIS), { forge: "gitlab" });
    expect(r.settings.apply).toBeUndefined();
    expect(r.settings.locks).toBeUndefined();
    expect(note(r.notes, "when it applies")).toMatchObject({ kind: "unmapped" });
    expect(note(r.notes, "when it applies")?.detail).toContain("comments");
    expect(note(r.notes, "repo_locks") ?? note(r.notes, "projects[dev-net].repo_locks")).toMatchObject({ kind: "unmapped" });
  });

  it("on Forgejo writes no auto merge, which needs a merge token it cannot name", () => {
    const r = convert("atlantis", parseYAML(ATLANTIS), { forge: "forgejo" });
    expect(r.settings.apply?.merge).toBeUndefined();
    expect(note(r.notes, "automerge")?.detail).toContain("merge_token_env");
  });

  it("leaves requires unset when no project names one, so every requirement holds", () => {
    const r = convert("atlantis", parseYAML("version: 3\nprojects:\n- dir: a\n"));
    expect(r.settings).toEqual({ roots: ["a"], apply: { when: "pull-request" } });
    expect(note(r.notes, "projects[].apply_requirements")).toMatchObject({ kind: "default" });
  });

  it("names projects that pin different versions instead of picking one", () => {
    const r = convert("atlantis", parseYAML("version: 3\nprojects:\n- dir: a\n  terraform_version: 1.5.0\n- dir: b\n  terraform_version: 1.6.0\n"));
    expect(r.settings.version).toBeUndefined();
    expect(note(r.notes, "projects[].terraform_version")?.detail).toContain("1.5.0, 1.6.0");
  });
});

describe("import digger", () => {
  const { settings, notes } = convert("digger", parseYAML(DIGGER));

  it("writes depends_on as waves.after, and leaves a Terragrunt project's order to its dependency blocks", () => {
    expect(settings.waves).toEqual({ after: { prod: ["dev"] } });
    expect(note(notes, "projects[prod].depends_on")).toMatchObject({ kind: "mapped", detail: "waves.after: prod after dev" });
    const tg = convert("digger", parseYAML("projects:\n- name: a\n  dir: a\n  terragrunt: true\n- name: b\n  dir: b\n  terragrunt: true\n  depends_on: [a]\n"));
    expect(tg.settings.waves).toBeUndefined();
    expect(note(tg.notes, "projects[b].depends_on")?.detail).toBe("in a Terragrunt repo the units' dependency blocks order them");
  });

  it("writes roots from the projects and generate_projects, tofu, and applies after merge when on_commit_to_default runs digger apply", () => {
    expect(settings.roots).toEqual(["dev", "prod", "teams/*"]);
    expect(settings.binary).toBe("tofu");
    expect(settings.apply).toBeUndefined();
    expect(note(notes, "workflows.main.workflow_configuration.on_commit_to_default")).toMatchObject({ kind: "default", row: "Apply on merge" });
    expect(note(notes, "auto_merge")).toMatchObject({ kind: "unmapped", row: "Merge after apply" });
    expect(settings.env).toEqual({ TF_VAR_region: "eu-west-1" });
  });

  it("names what it did not write", () => {
    expect(note(notes, "projects[dev].aws_role_to_assume")).toMatchObject({ kind: "unmapped", row: "Cloud credentials" });
    expect(note(notes, "generate_projects.exclude")).toMatchObject({ kind: "unmapped", row: "Which directories" });
    expect(note(notes, "workflows.main.env_vars.commands[0]")).toMatchObject({ kind: "unmapped", row: "Custom steps" });
    expect(note(notes, "workflows.main.plan.steps[0].init.extra_args")).toMatchObject({ kind: "left-out", row: "Flags at run time" });
    expect(note(notes, "pr_locks")).toMatchObject({ kind: "default", row: "Lock at plan time" });
  });

  it("applies before merge when no workflow applies on the default branch", () => {
    const r = convert("digger", parseYAML("projects:\n- name: a\n  dir: a\nauto_merge: true\n"));
    expect(r.settings.apply).toEqual({ when: "pull-request", merge: "auto" });
  });
});

describe("rootOf", () => {
  it("reads a project directory as a root path, and refuses one outside the repo", () => {
    expect(rootOf("./envs/dev/")).toBe("envs/dev");
    expect(rootOf(".")).toBe(".");
    expect(rootOf("../other")).toBeUndefined();
    expect(rootOf("/abs")).toBeUndefined();
  });
});

describe("terragucci import, on a repo", () => {
  const repo = (): string =>
    write(tmp(), {
      "envs/dev/app/main.tf": backend("dev/app"),
      "envs/prod/app/main.tf": backend("prod/app"),
      ".github/workflows/x.yml": "on: push\n",
      "atlantis.yaml": "version: 3\nprojects:\n- dir: envs/dev/app\n- dir: envs/prod/app\n  workspace: blue\n- dir: envs/gone\n",
    });

  it("writes terragucci.yml that config check reads, and prints every setting it did not map", async () => {
    const dir = repo();
    const r = importConfig(dir, "atlantis");
    expect(r.wrote).toBe("terragucci.yml");
    const cfg = await loadConfig(join(dir, "terragucci.yml"));
    expect(cfg.roots).toEqual(["envs/dev/app", "envs/gone", "envs/prod/app"]);
    expect(r.missing).toEqual(["envs/gone"]);
    const text = describeImport(r);
    expect(text).toContain("projects[envs/prod/app].workspace (Workspace): workspace blue is not planned. The guide: none: each root is a directory with one state");
    expect(text).toContain("No directory with Terraform files matches envs/gone");
  });

  it("refuses to replace a terragucci.yml without --force, and writes nothing on a dry run", () => {
    const dir = repo();
    importConfig(dir, "atlantis");
    expect(() => importConfig(dir, "atlantis")).toThrow(/--force/);
    expect(importConfig(dir, "atlantis", { force: true }).wrote).toBe("terragucci.yml");
    const fresh = repo();
    const dry = importConfig(fresh, "atlantis", { dryRun: true });
    expect(dry.wrote).toBeUndefined();
    expect(existsSync(join(fresh, "terragucci.yml"))).toBe(false);
    expect(describeImport(dry)).toContain("dry run, nothing written");
  });

  it("says which file it looked for when there is none", () => {
    expect(() => importConfig(tmp(), "digger")).toThrow(/digger\.yml or digger\.yaml/);
  });
});
