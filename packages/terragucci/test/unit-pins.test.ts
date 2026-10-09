// A Terragrunt unit's own releases: the binary its .opentofu-version or the
// version map pins, and the Terragrunt its terragrunt_version_constraint pins.
// Each is installed once in the job, and a wave runs as one run --all per pair
// of releases, plan and apply alike. Terragrunt is stubbed; the stub records
// which terragrunt and which TG_TF_PATH ran each unit.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TerragruntExec } from "@intentius/chant-lexicon-terraform/terragrunt/run";
import { applyWave } from "../src/apply";
import { init } from "../src/init";
import type { Installer } from "../src/pins";
import { runStage } from "../src/report/stage";
import { groupUnits, unitTerragruntPin } from "../src/unit-pins";
import { git, tmp, write } from "./helpers";

/** A script that says it is `name` at `version`, as `tofu version -json` and `terragrunt --version` do. */
function tool(dir: string, name: "tofu" | "terragrunt", version: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, name === "tofu" ? `#!/bin/sh\necho '{"terraform_version":"${version}"}'\n` : `#!/bin/sh\necho 'terragrunt version v${version}'\n`);
  chmodSync(path, 0o755);
  return path;
}

/** An installer that writes a script saying the version asked for, and records what it was asked. */
function installer(root: string, asked: string[], lie?: string): Installer {
  return async (t, version) => {
    asked.push(`${t} ${version}`);
    const dir = join(root, `${t}-${version}`);
    tool(dir, t as "tofu" | "terragrunt", lie ?? version);
    return dir;
  };
}

interface Ran {
  terragrunt: string;
  tfPath: string;
  command: string;
  units: string[];
}

function fakeTerragrunt(): { exec: TerragruntExec; runs: Ran[] } {
  const runs: Ran[] = [];
  const flag = (args: readonly string[], name: string): string => args[args.indexOf(name) + 1];
  const exec: TerragruntExec = async (file, args, options) => {
    if (args[0] === "--version") return { code: 0, stdout: "terragrunt version v1.1.6\n", stderr: "" };
    if (args[0] === "render") return { code: 0, stdout: "{}", stderr: "" };
    if (args[0] === "find") return { code: 0, stdout: JSON.stringify(["live/a", "live/b", "live/c"].map((path) => ({ type: "unit", path, dependencies: [] }))), stderr: "" };
    if (args[0] !== "run") return { code: 1, stdout: "", stderr: `unexpected ${args.join(" ")}` };
    const units = args.flatMap((a, i) => (args[i - 1] === "--filter" ? [/^\{\.\/(.+)\}$/.exec(a)![1]] : []));
    const command = args[args.indexOf("--") + 1];
    // The stage's span wrapper stands in TG_TF_PATH and runs the binary it names: record that binary.
    const tf = options.env.TG_TF_PATH ?? "";
    const wrapped = tf.includes(".bin/") && existsSync(tf) ? /exec '([^']+)'/.exec(readFileSync(tf, "utf-8"))?.[1] : undefined;
    runs.push({ terragrunt: file, tfPath: wrapped ?? tf, command, units });
    const out = flag(args, "--out-dir");
    for (const u of units) {
      if (command === "plan") {
        const plan = { format_version: "1.2", terraform_version: options.env.TG_TF_PATH, resource_changes: [{ address: "terraform_data.x", mode: "managed", type: "terraform_data", name: "x", change: { actions: ["create"], before: null, after: { input: u }, after_unknown: {} } }] };
        for (const [dir, name, text] of [[out, "tfplan.tfplan", "plan"], [flag(args, "--json-out-dir"), "tfplan.json", JSON.stringify(plan)]]) {
          mkdirSync(join(dir, u), { recursive: true });
          writeFileSync(join(dir, u, name), text);
        }
      } else if (!existsSync(join(out, u, "tfplan.tfplan"))) {
        return { code: 1, stdout: "", stderr: `no saved plan for ${u} under ${out}` };
      }
    }
    const report = flag(args, "--report-file");
    mkdirSync(dirname(report), { recursive: true });
    writeFileSync(report, JSON.stringify(units.map((u) => ({ Name: u, Result: "succeeded" }))));
    return { code: command === "plan" ? 2 : 0, stdout: "", stderr: "" };
  };
  return { exec, runs };
}

const UNIT = 'include "root" {\n  path = find_in_parent_folders("root.hcl")\n}\n';

function repo(): { work: string; bin: string; tg: string } {
  const dir = tmp("tg-pins-");
  const origin = join(dir, "origin.git");
  git(dir, "init", "-q", "--bare", origin);
  const work = join(dir, "work");
  write(work, {
    "root.hcl": "",
    // live/a pins its tofu, live/b its Terragrunt, live/c nothing.
    "live/a/terragrunt.hcl": UNIT,
    "live/a/.opentofu-version": "1.10.6\n",
    "live/b/terragrunt.hcl": `${UNIT}\nterragrunt_version_constraint = "= 1.1.5"\n`,
    "live/c/terragrunt.hcl": UNIT,
  });
  git(work, "init", "-q", "-b", "main");
  git(work, "add", "-A");
  git(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "one");
  git(work, "remote", "add", "origin", origin);
  git(work, "push", "-q", "origin", "main");
  const tools = join(dir, "job");
  return { work, bin: tool(tools, "tofu", "1.13.1"), tg: tool(tools, "terragrunt", "1.1.6") };
}

describe("a unit's pins", () => {
  it("reads an exact terragrunt_version_constraint from the unit's own terragrunt.hcl, and nothing else", () => {
    const r = write(tmp(), {
      "a/terragrunt.hcl": 'terragrunt_version_constraint = "= 1.1.5"\n',
      "b/terragrunt.hcl": 'terragrunt_version_constraint = "1.2.0"\n',
      "c/terragrunt.hcl": 'terragrunt_version_constraint = ">= 1.1"\n',
      "d/terragrunt.hcl": '# terragrunt_version_constraint = "= 1.0.0"\n',
    });
    expect(["a", "b", "c", "d", "e"].map((u) => unitTerragruntPin(r, u))).toEqual(["1.1.5", "1.2.0", undefined, undefined, undefined]);
  });

  it("groups a wave by the releases its units run, the job's own first and in the wave's directory", () => {
    const job = { terragrunt: "tg", binary: "tofu" };
    expect(groupUnits(["a", "b"], "/w/plan", job)).toEqual([{ ...job, units: ["a", "b"], workDir: "/w/plan" }]);
    const tools = new Map([
      ["a", { terragrunt: "tg", binary: "/i/tofu-1.10.6/tofu", report: { name: "tofu" } }],
      ["b", { ...job, report: { name: "tofu" } }],
    ]);
    expect(groupUnits(["a", "b", "c"], "/w/plan", job, tools)).toEqual([
      { ...job, units: ["b", "c"], workDir: "/w/plan" },
      { terragrunt: "tg", binary: "/i/tofu-1.10.6/tofu", units: ["a"], workDir: "/w/plan-pinned-1" },
    ]);
  });

  it("init lists each unit's pins, a version map included, where it used to refuse the map", async () => {
    const r = write(tmp(), {
      "terragucci.yml": 'forge: github\nversion:\n  "live/c": "1.9.1"\n',
      "root.hcl": "",
      "live/a/terragrunt.hcl": UNIT,
      "live/a/.opentofu-version": "1.10.6\n",
      "live/b/terragrunt.hcl": `${UNIT}\nterragrunt_version_constraint = "= 1.1.5"\n`,
      "live/c/terragrunt.hcl": UNIT,
    });
    const out = await init(r, { binary: "tofu", dryRun: true, terragrunt: "/nonexistent/terragrunt" });
    expect(out.pins).toEqual([
      { root: "live/a", version: "1.10.6", source: ".opentofu-version" },
      { root: "live/b", tool: "terragrunt", version: "1.1.5", source: "terragrunt_version_constraint" },
      { root: "live/c", version: "1.9.1", source: "terragucci.yml version live/c" },
    ]);
  });
});

describe("tf-plan with pinned units", () => {
  it("installs each pin once, plans a wave as one run --all per pair of releases, and names each unit's releases in the report", async () => {
    const { work, bin, tg } = repo();
    const fake = fakeTerragrunt();
    const asked: string[] = [];
    const lines: string[] = [];
    const r = await runStage("tf-plan", work, {
      out: join(work, "out"), binary: bin, terragrunt: true, terragruntPath: tg, terragruntExec: fake.exec,
      layers: [["live/a", "live/b", "live/c"]], installer: installer(join(work, "..", "installs"), asked), env: { PATH: process.env.PATH },
    }, (l) => void lines.push(l));
    expect(asked.sort()).toEqual(["terragrunt 1.1.5", "tofu 1.10.6"]);
    const plans = fake.runs.filter((x) => x.command === "plan").map((x) => [x.units.join(","), x.terragrunt.split("/").slice(-2).join("/"), x.tfPath.split("/").slice(-2).join("/")]);
    expect(plans).toEqual([
      ["live/c", "job/terragrunt", "job/tofu"],
      ["live/a", "job/terragrunt", "tofu-1.10.6/tofu"],
      ["live/b", "terragrunt-1.1.5/terragrunt", "job/tofu"],
    ]);
    const unit = (p: string) => r.report.roots.find((u) => u.path === p)!;
    expect(r.report.roots.map((u) => [u.path, u.status])).toEqual([["live/a", "planned"], ["live/b", "planned"], ["live/c", "planned"]]);
    expect(unit("live/a").binary).toEqual({ name: "tofu", version: "1.10.6", pin: ".opentofu-version", terragrunt: { version: "1.1.6" } });
    expect(unit("live/b").binary).toEqual({ name: "tofu", version: "1.13.1", terragrunt: { version: "1.1.5", pin: "terragrunt_version_constraint" } });
    expect(unit("live/c").binary).toEqual({ name: "tofu", version: "1.13.1", terragrunt: { version: "1.1.6" } });
    expect(lines).toContain("live/b: tofu 1.13.1 under Terragrunt 1.1.5 (terragrunt_version_constraint)");
    // One wave, whatever ran it.
    expect(r.report.waves.map((w) => w.roots)).toEqual([["live/a", "live/b", "live/c"]]);
  });

  it("fails the unit whose pin was not installed, naming the pin, and plans the rest", async () => {
    const { work, bin, tg } = repo();
    const fake = fakeTerragrunt();
    const asked: string[] = [];
    // The install of Terragrunt 1.1.5 says it is 1.1.4: the check refuses it.
    const lying: Installer = async (t, v) => (t === "terragrunt" ? installer(join(work, "..", "bad"), asked, "1.1.4")(t, v) : installer(join(work, "..", "ok"), asked)(t, v));
    const r = await runStage("tf-plan", work, {
      out: join(work, "out"), binary: bin, terragrunt: true, terragruntPath: tg, terragruntExec: fake.exec,
      layers: [["live/a", "live/b", "live/c"]], installer: lying, env: { PATH: process.env.PATH },
    }, () => {});
    const b = r.report.roots.find((u) => u.path === "live/b")!;
    expect(b.status).toBe("failed");
    expect(b.error).toContain("live/b pins Terragrunt 1.1.5 (terragrunt_version_constraint), which was not installed: the Terragrunt installed as 1.1.5 says it is 1.1.4");
    expect(fake.runs.flatMap((x) => x.units).sort()).toEqual(["live/a", "live/c"]);
  });
});

describe("tf-apply with pinned units", () => {
  afterEach(() => vi.restoreAllMocks());

  it("applies each unit with the releases it planned with, from its own group's saved plans", async () => {
    const { work, bin, tg } = repo();
    vi.spyOn(console, "log").mockImplementation(() => {});
    const fake = fakeTerragrunt();
    const asked: string[] = [];
    const code = await applyWave(work, {
      layers: [["live/a", "live/b", "live/c"]], binary: bin, gate: "never", wave: 1, terragrunt: true, terragruntPath: tg, terragruntExec: fake.exec,
      installer: installer(join(work, "..", "installs"), asked), env: { PATH: process.env.PATH }, now: new Date(Date.UTC(2026, 0, 1)).toISOString(),
    });
    expect(code).toBe(0);
    const by = (command: string) => fake.runs.filter((x) => x.command === command).map((x) => `${x.units.join(",")} ${x.terragrunt.split("/").slice(-2)[0]} ${x.tfPath.split("/").slice(-2)[0]}`);
    expect(by("plan")).toEqual(["live/c job job", "live/a job tofu-1.10.6", "live/b terragrunt-1.1.5 job"]);
    expect(by("apply")).toEqual(by("plan"));
    const report = JSON.parse(readFileSync(join(work, "terragucci-report", "report.json"), "utf-8"));
    expect(report.roots.find((u: { path: string }) => u.path === "live/b").binary.terragrunt).toEqual({ version: "1.1.5", pin: "terragrunt_version_constraint" });
  });
});
