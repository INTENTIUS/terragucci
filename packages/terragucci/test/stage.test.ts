// `terragucci stage tf-plan` against real roots planned by tofu, with local
// state. Skipped where tofu is not on the path.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/cli";
import { readInlineReport } from "../src/report/html";
import { affectedRoots, emptyStateText, runStage } from "../src/report/stage";
import { tmp, write } from "./helpers";

const TOFU = spawnSync("tofu", ["version"]).status === 0;

const root = (name: string) => `variable "pw" {
  type      = string
  sensitive = true
  default   = "hunter2-${name}"
}

resource "terraform_data" "keep" {
  input = { size = 1 }
  triggers_replace = [var.pw]
}

resource "terraform_data" "gone" {
  input = "x"
}
`;

describe.skipIf(!TOFU)("terragucci stage tf-plan", () => {
  it("plans every root, keeps each full plan redacted, and writes the report", { timeout: 120_000 }, async () => {
    const repo = write(tmp(), {
      "terragucci.yml": 'binary: tofu\nroots: ["envs/*"]\nwaves:\n  canary: ["envs/a"]\n',
      "envs/a/main.tf": root("a"),
      "envs/b/main.tf": root("b"),
      "envs/c/main.tf": root("c"),
      "envs/broken/main.tf": 'resource "terraform_data" "x" {\n  input = var.missing\n}\n',
    });
    for (const r of ["a", "b", "c"]) execFileSync("tofu", [`-chdir=${join(repo, "envs", r)}`, "apply", "-auto-approve", "-input=false", "-no-color"], { stdio: "ignore", env: { ...process.env, TF_IN_AUTOMATION: "1" } });
    for (const r of ["a", "b", "c"]) write(repo, { [`envs/${r}/main.tf`]: root(r).replace("size = 1", "size = 2") });
    write(repo, { "envs/c/main.tf": root("c").replace("size = 1", "size = 2").replace(/resource "terraform_data" "gone"[\s\S]*/, "") });

    const logs: string[] = [];
    const result = await runStage("tf-plan", repo, {}, (l) => logs.push(l));
    const { report, dir } = result;
    expect(result.failed).toBe(true);
    expect(report.roots.map((r) => [r.path, r.status])).toEqual([["envs/a", "planned"], ["envs/b", "planned"], ["envs/broken", "failed"], ["envs/c", "planned"]]);
    expect(report.named.map((n) => [n.action, n.root, n.address])).toEqual([["refused", "envs/broken", undefined], ["delete", "envs/c", "terraform_data.gone"]]);
    expect(report.waves.map((w) => w.roots)).toEqual([["envs/a"], ["envs/b", "envs/broken", "envs/c"]]);

    for (const r of report.roots.filter((x) => x.status === "planned")) {
      expect(readFileSync(join(dir, r.plan.text!), "utf-8")).toContain("terraform_data.keep");
      const json = readFileSync(join(dir, r.plan.json!), "utf-8");
      expect(json).not.toContain("hunter2");
      expect(json).toContain("(sensitive, redacted by terragucci)");
    }
    expect(report.redaction.values).toBeGreaterThan(0);
    expect(readInlineReport(readFileSync(join(dir, "report.html"), "utf-8"))).toEqual(JSON.parse(readFileSync(join(dir, "report.json"), "utf-8")));
    for (const f of ["note.md", "summary.txt", "gitlab-terraform.json"]) expect(existsSync(join(dir, f)), f).toBe(true);
  });

  it("numbers the report's waves as the apply cuts them: canary layers first, one dependency layer each", { timeout: 120_000 }, async () => {
    const tf = 'resource "terraform_data" "x" {\n  input = 1\n}\n';
    const repo = write(tmp(), { "terragucci.yml": 'binary: tofu\nroots: ["*/*"]\nwaves:\n  canary: ["dev/*"]\n', "dev/net/main.tf": tf, "dev/app/main.tf": tf, "prod/net/main.tf": tf, "prod/app/main.tf": tf });
    const { report } = await runStage("tf-plan", repo, { layers: [["dev/net", "prod/net"], ["dev/app", "prod/app"]] }, () => {});
    expect(report.waves.map((w) => [w.number, w.roots])).toEqual([[1, ["dev/net"]], [2, ["dev/app"]], [3, ["prod/net"]], [4, ["prod/app"]]]);
  });

  it("--json prints one envelope, and an unknown stage is a usage error", async () => {
    const repo = write(tmp(), { "terragucci.yml": 'binary: tofu\nroots: ["a"]\n', "a/main.tf": 'resource "terraform_data" "x" {\n  input = 1\n}\n' });
    const cwd = process.cwd();
    const out: string[] = [];
    const log = console.log;
    console.log = (s: string) => out.push(s);
    try {
      process.chdir(repo);
      expect(await main(["stage", "tf-plan", "--json", "--out", "r"])).toBe(0);
      expect(await main(["stage", "tf-nope", "--json"])).toBe(2);
    } finally {
      console.log = log;
      process.chdir(cwd);
    }
    const ok = JSON.parse(out[0]);
    expect(ok).toMatchObject({ schema: 1, command: "stage", exit: 0, status: "ok", results: { stage: "tf-plan", uploaded: null } });
    expect(existsSync(ok.results.files.html)).toBe(true);
    expect(JSON.parse(out[1])).toMatchObject({ command: "stage", exit: 2, status: "usage" });
  });
});

describe("affected roots", () => {
  const state = (key: string) => `terraform {\n  backend "s3" {\n    bucket = "s"\n    key    = "${key}"\n  }\n}\n`;
  const reads = (key: string) => `data "terraform_remote_state" "up" {\n  backend = "s3"\n  config = {\n    bucket = "s"\n    key    = "${key}"\n  }\n}\n`;
  const repo = (): string => {
    const dir = write(tmp(), {
      "platform/main.tf": state("platform.tfstate"),
      "app/main.tf": state("app.tfstate") + reads("platform.tfstate"),
      "web/main.tf": state("web.tfstate") + reads("app.tfstate"),
      "other/main.tf": state("other.tfstate") + 'module "m" {\n  source = "../modules/m"\n}\n',
      "modules/m/main.tf": "",
    });
    const git = (...a: string[]) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a], { stdio: "ignore" });
    git("init", "-q", "-b", "main");
    git("add", "-A");
    git("commit", "-qm", "base");
    return dir;
  };
  const roots = ["platform", "app", "web", "other"];
  const commit = (dir: string, files: Record<string, string>): void => {
    write(dir, files);
    execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-qam", "change"], { stdio: "ignore" });
  };

  it("a changed root plans with the roots that read its state, followed through, and no other", () => {
    const dir = repo();
    commit(dir, { "platform/main.tf": state("platform.tfstate") + "# moved\n" });
    expect([...affectedRoots(dir, "HEAD~1", roots, roots, () => {})!].sort()).toEqual(["app", "platform", "web"]);
  });

  it("a change to a local module plans the root that calls it", () => {
    const dir = repo();
    commit(dir, { "modules/m/main.tf": "# moved\n" });
    expect([...affectedRoots(dir, "HEAD~1", roots, roots, () => {})!]).toEqual(["other"]);
  });

  it("a change outside every root plans nothing, and a range git cannot diff plans every root", () => {
    const dir = repo();
    write(dir, { "README.md": "x\n" });
    execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "add", "-A"], { stdio: "ignore" });
    execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-qm", "docs"], { stdio: "ignore" });
    expect([...affectedRoots(dir, "HEAD~1", roots, roots, () => {})!]).toEqual([]);
    expect(affectedRoots(dir, "origin/nowhere", roots, roots, () => {})).toBeUndefined();
  });
});

describe("a fresh estate", () => {
  it("reads a state with no resources and no outputs as empty", () => {
    expect(emptyStateText("")).toBe(true);
    expect(emptyStateText('{"version":4,"resources":[],"outputs":{}}')).toBe(true);
    expect(emptyStateText('{"version":4,"resources":[{"type":"x"}],"outputs":{}}')).toBe(false);
    expect(emptyStateText('{"version":4,"resources":[],"outputs":{"a":{"value":1}}}')).toBe(false);
    expect(emptyStateText("not json")).toBeUndefined();
  });

  it("holds back a root that reads a root with no state, names it in the report, and does not fail", async () => {
    const state = (key: string) => `terraform {\n  backend "s3" {\n    bucket = "s"\n    key    = "${key}"\n  }\n}\n`;
    const reads = `data "terraform_remote_state" "up" {\n  backend = "s3"\n  config = {\n    bucket = "s"\n    key    = "network.tfstate"\n  }\n}\n`;
    const dir = tmp();
    // A stand-in binary: init succeeds, state pull prints nothing, plan fails (it must not be reached for app).
    const fake = write(dir, {
      "fake-tf": '#!/bin/sh\ncase "$*" in\n  *"state pull"*) exit 0;;\n  *init*) exit 0;;\n  *) echo "plan reached" >&2; exit 1;;\nesac\n',
      "network/main.tf": state("network.tfstate"),
      "app/main.tf": state("app.tfstate") + reads,
    });
    execFileSync("chmod", ["+x", join(fake, "fake-tf")]);
    const result = await runStage("tf-plan", fake, { binary: join(fake, "fake-tf"), layers: [["network"], ["app"]], root: "app", out: "r" }, () => {});
    expect(result.report.deferred).toEqual([expect.objectContaining({ unit: "app", after: ["network"], previewed: false })]);
    expect(result.report.roots.map((r) => r.path)).not.toContain("app");
    expect(result.report.waves.flatMap((w) => w.roots)).not.toContain("app");
  });
});
