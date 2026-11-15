import { describe, expect, it } from "vitest";
import { importConfig, type ImportNote } from "../src/import";
import { backend, tmp, write } from "./helpers";

/** Two roots with state, one of which calls modules/svc, a module with no state of its own. */
function repo(config: string, file = ".atlantis.yaml"): string {
  return write(tmp(), {
    "app/main.tf": `${backend("app.tfstate")}\nmodule "svc" {\n  source = "../modules/svc"\n}\n`,
    "network/main.tf": backend("network.tfstate"),
    "modules/svc/main.tf": `resource "null_resource" "x" {}\n`,
    [file]: config,
  });
}

const note = (notes: ImportNote[], key: string): ImportNote | undefined => notes.find((n) => n.key === key);

const PROJECTS = `version: 3
projects:
- name: app
  dir: app
- name: net
  dir: network
- dir: modules/svc
`;

describe("import atlantis against a repo", () => {
  it.each([".atlantis.yaml", ".atlantis.yml", "atlantis.yaml", "atlantis.yml"])("finds %s with no file named", (file) => {
    const r = importConfig(repo(PROJECTS, file), "atlantis", { dryRun: true });
    expect(r.from).toBe(file);
  });

  it("leaves out a project directory that is a module, with a note, and keeps the rest", () => {
    const r = importConfig(repo(PROJECTS), "atlantis", { dryRun: true });
    expect(r.settings.roots).toEqual(["app", "network"]);
    expect(note(r.notes, "projects[modules/svc].dir")).toMatchObject({ kind: "unmapped", text: expect.stringContaining("is a module some directory calls") });
    expect(r.missing).toEqual([]);
  });

  it("keeps a module that holds a backend of its own", () => {
    const dir = repo(PROJECTS);
    write(dir, { "modules/svc/state.tf": backend("svc.tfstate") });
    expect(importConfig(dir, "atlantis", { dryRun: true }).settings.roots).toEqual(["app", "modules/svc", "network"]);
  });

  it("writes no roots when autodiscover is on, and says how many roots detection finds", () => {
    const r = importConfig(repo(`autodiscover:\n  mode: auto\n${PROJECTS}`), "atlantis", { dryRun: true });
    expect(r.settings.roots).toBeUndefined();
    expect(r.yaml).not.toContain("roots");
    expect(note(r.notes, "autodiscover")).toMatchObject({ kind: "default", detail: expect.stringContaining("(2 here)") });
    expect(r.notes.some((n) => n.key === "projects[].dir")).toBe(false);
  });

  it("writes roots when autodiscover is disabled", () => {
    const r = importConfig(repo(`autodiscover:\n  mode: disabled\n${PROJECTS}`), "atlantis", { dryRun: true });
    expect(r.settings.roots).toEqual(["app", "network"]);
    expect(note(r.notes, "autodiscover")?.detail).toContain("disabled");
  });

  it("names a project directory that detection does not count when autodiscover leaves roots out", () => {
    const dir = repo(`autodiscover:\n  mode: enabled\n${PROJECTS}- dir: plain\n`);
    write(dir, { "plain/main.tf": `resource "null_resource" "x" {}\n` });
    const r = importConfig(dir, "atlantis", { dryRun: true });
    expect(note(r.notes, "projects[plain].dir")).toMatchObject({ kind: "unmapped", text: expect.stringContaining("not a root by detection") });
  });

  it("reports a project's workflow the file does not define, and one it does", () => {
    const r = importConfig(
      repo(`version: 3
projects:
- name: app
  dir: app
  workflow: aws
- name: net
  dir: network
  workflow: aws
workflows:
  other:
    plan:
      steps: [init, plan]
`),
      "atlantis",
      { dryRun: true },
    );
    const n = note(r.notes, "projects[].workflow: aws");
    expect(n).toMatchObject({ kind: "unmapped", row: "Custom steps" });
    expect(n?.detail).toContain("2 projects (app, net)");
    expect(n?.detail).toContain("server's repos.yaml");
    expect(r.settings.backend_config).toBeUndefined();

    const defined = importConfig(repo(`version: 3\nprojects:\n- name: app\n  dir: app\n  workflow: other\nworkflows:\n  other:\n    plan:\n      steps: [init, plan]\n`), "atlantis", { dryRun: true });
    expect(note(defined.notes, "projects[].workflow: other")?.detail).toContain("defined under workflows in this file");
  });
});
