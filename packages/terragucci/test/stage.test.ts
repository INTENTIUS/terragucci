// `terragucci stage tf-plan` against real roots planned by tofu, with local
// state. Skipped where tofu is not on the path.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/cli";
import { readInlineReport } from "../src/report/html";
import { runStage } from "../src/report/stage";
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
