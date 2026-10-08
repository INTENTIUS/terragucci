// `terragucci stage tf-plan` against real roots planned by tofu, with local
// state. Skipped where tofu is not on the path.
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/cli";
import { readInlineReport } from "../src/report/html";
import { affectedRoots, eachLimited, emptyStateText, rootsParallelism, runStage } from "../src/report/stage";
import { tmp, write } from "./helpers";
import { plan as planJson, rc } from "./report-fixtures";

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

/**
 * A stand-in binary whose plan sleeps for the time in the root's `delay`
 * file, so roots finish out of order, and fails when the root has a `fail`
 * file. It records when each plan starts and ends.
 */
function slowTofu(dir: string): string {
  const path = join(dir, "tofu");
  writeFileSync(path, `#!/bin/sh
chdir="\${1#-chdir=}"; shift
case "$1" in
  init) echo "$TF_PLUGIN_CACHE_DIR" >> "${dir}/inits.log"; exit 0 ;;
  plan)
    echo "start $chdir" >> "${dir}/plans.log"
    sleep "$(cat "$chdir/delay")"
    echo "end $chdir" >> "${dir}/plans.log"
    if [ -f "$chdir/fail" ]; then echo "Error: no" >&2; exit 1; fi
    for a in "$@"; do case "$a" in -out=*) : > "\${a#-out=}" ;; esac; done
    echo "Plan: 1 to add, 0 to change, 0 to destroy."; exit 0 ;;
  show) if [ "$2" = "-json" ]; then cat "$chdir/plan.json"; else echo "plan text for $chdir"; fi ;;
esac
`);
  chmodSync(path, 0o755);
  return path;
}

/** Every file under `dir`, by relative path. */
function filesUnder(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(dir, p)] = readFileSync(p, "utf-8");
    }
  };
  walk(dir);
  return out;
}

describe("roots of a layer plan at once", () => {
  // 15 roots in two layers. Later roots sleep less, so they finish first.
  const names = Array.from({ length: 15 }, (_, i) => `envs/r${String(i).padStart(2, "0")}`);
  const layers = [names.slice(0, 8), names.slice(8)];
  const estate = () => {
    const files: Record<string, string> = { "terragucci.yml": 'roots: ["envs/*"]\n' };
    names.forEach((n, i) => {
      files[`${n}/main.tf`] = 'terraform {\n  backend "s3" {}\n}\n';
      files[`${n}/delay`] = String(((15 - i) * 0.08).toFixed(2));
      const changes = [rc(`terraform_data.r${i}`, ["create"], null, { input: i })];
      if (i % 5 === 0) changes.push(rc("aws_s3_bucket.logs", ["delete"], { bucket: `logs-${i}` }, null));
      files[`${n}/plan.json`] = JSON.stringify(planJson(changes));
    });
    files[`${names[11]}/fail`] = "";
    return write(tmp(), files);
  };
  const normal = (raw: string) => {
    const r = JSON.parse(raw);
    r.run.started = r.run.finished = "t";
    // Wall times differ between any two runs.
    delete r.timings;
    for (const root of r.roots) delete root.timings;
    // Each run gets its own stand-in binary, in its own temp dir.
    r.run.binary = "tofu";
    return r;
  };

  it("writes the same report, note, plan files and log as a run that plans one root at a time", { timeout: 60_000 }, async () => {
    const repo = estate();
    const run = async (parallelism: number) => {
      const bin = tmp();
      const logs: string[] = [];
      const out = join(tmp(), "report");
      const result = await runStage("tf-plan", repo, { binary: slowTofu(bin), layers, parallelism, out, env: { PATH: process.env.PATH } }, (l) => logs.push(l));
      const inits = readFileSync(join(bin, "inits.log"), "utf-8").trim().split("\n");
      return { result, logs, files: filesUnder(out), plans: readFileSync(join(bin, "plans.log"), "utf-8").trim().split("\n"), inits };
    };
    const serial = await run(1);
    const together = await run(8);

    // Planned one at a time, every plan ends before the next starts; together, they overlap.
    serial.plans.forEach((l, i) => expect(l.startsWith(i % 2 === 0 ? "start" : "end")).toBe(true));
    expect(together.plans.slice(0, 8).every((l) => l.startsWith("start"))).toBe(true);
    // A later layer waits for the one before it.
    const lastEndOfFirst = Math.max(...layers[0].map((r) => together.plans.indexOf(`end ${join(repo, r)}`)));
    const firstStartOfSecond = together.plans.findIndex((l) => layers[1].some((r) => l === `start ${join(repo, r)}`));
    expect(lastEndOfFirst).toBeLessThan(firstStartOfSecond);

    expect(together.result.failed).toBe(true);
    expect(together.result.report.roots.map((r) => r.path)).toEqual([...names].sort());
    expect(normal(together.files["report.json"])).toEqual(normal(serial.files["report.json"]));
    expect(Object.keys(together.files).sort()).toEqual(Object.keys(serial.files).sort());
    for (const f of Object.keys(serial.files).filter((f) => f !== "report.json" && f !== "report.html")) {
      expect(together.files[f], f).toBe(serial.files[f]);
    }
    // The log names roots in order, however they finished.
    const rootLines = (logs: string[]) => logs.filter((l) => l.startsWith("envs/"));
    expect(rootLines(together.logs)).toEqual(rootLines(serial.logs));
    expect(rootLines(together.logs).map((l) => l.split(":")[0])).toEqual(names);
    expect(together.logs).toContain("planning up to 8 roots at once (--parallelism)");
    expect(serial.logs).toContain("planning one root at a time (--parallelism)");
    // With no cache of the job's, the roots share one of the stage's own, so a provider downloads once.
    expect(together.inits).toHaveLength(names.length);
    expect(new Set(together.inits).size).toBe(1);
    expect(together.inits[0]).not.toBe("");
  });

  it("takes the default from the roots' state backend, as Terragrunt mode does", () => {
    const repo = write(tmp(), {
      "a/main.tf": 'terraform {\n  backend "s3" {\n    key = "a"\n  }\n}\n',
      "g/main.tf": 'terraform {\n  backend "http" {\n    address = "https://gitlab.com/api/v4/projects/7/terraform/state/g"\n  }\n}\n',
      "h/main.tf": 'terraform {\n  backend "http" {}\n}\n',
    });
    expect(rootsParallelism(repo, ["a"], {})).toEqual({ value: 4, reason: "the s3 backend" });
    expect(rootsParallelism(repo, ["a", "g"], {})).toEqual({ value: 3, reason: "GitLab-managed state rate-limits concurrent inits" });
    expect(rootsParallelism(repo, ["h"], {})).toEqual({ value: 4, reason: "the http backend" });
    expect(rootsParallelism(repo, ["h"], {}, { TF_HTTP_ADDRESS: "https://gitlab.example.com/api/v4/projects/9/terraform/state/h" }).value).toBe(3);
    expect(rootsParallelism(repo, ["a", "g"], { parallelism: 5 })).toEqual({ value: 5, reason: "terragucci.yml" });
    expect(rootsParallelism(repo, [], {})).toEqual({ value: 4, reason: "the default" });
  });

  it("runs at most the limit at once and stops starting work after a throw", async () => {
    let running = 0;
    let most = 0;
    const seen: number[] = [];
    await eachLimited([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      running++;
      most = Math.max(most, running);
      await new Promise((r) => setTimeout(r, 10 * (8 - n)));
      seen.push(n);
      running--;
    });
    expect(most).toBe(3);
    expect([...seen].sort()).toEqual([1, 2, 3, 4, 5, 6, 7]);

    const started: number[] = [];
    await expect(eachLimited([1, 2, 3, 4], 1, async (n) => {
      started.push(n);
      if (n === 2) throw new Error("boom");
    })).rejects.toThrow("boom");
    expect(started).toEqual([1, 2]);
  });

  it("refuses a --parallelism that is not a whole number of 1 or more", async () => {
    const err = console.error;
    console.error = () => {};
    try {
      expect(await main(["stage", "tf-plan", "--parallelism", "0"])).toBe(2);
    } finally {
      console.error = err;
    }
  });
});
