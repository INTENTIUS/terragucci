// sources for Terragrunt: the check job's check before its validate, and each
// unit's check after its init and before its plan (../src/sources-terragrunt.ts).
import { execFile, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TerragruntExec } from "@intentius/chant-lexicon-terraform/terragrunt/run";
import { applyWave } from "../src/apply";
import { chantExitCodes } from "../src/chant-next";
import { main } from "../src/cli";
import { init } from "../src/init";
import { runStage } from "../src/report/stage";
import { terragruntCheckScript } from "../src/render-terragrunt";
import { SOURCES_NEXT_ENV, sourcesWrapper } from "../src/sources-terragrunt";
import { git, tmp, write } from "./helpers";

// A usage error exits 1 under chant's exit-code table (chant#4553), 2 before it.
const USAGE = (await chantExitCodes()) ? 1 : 2;
const GIT_HOST = "git::https://git.example.com/platform";
const OTHER_HOST = "git::https://git.unlisted.example/acme";

/** A unit's working directory as Terragrunt's init leaves it: its source (a listed module) calls an unlisted one, and null came in for a resource. */
const UNIT_INITED: Record<string, string> = {
  "main.tf": `module "inner" {\n  source = "${OTHER_HOST}/inner.git?ref=v2"\n}\nresource "null_resource" "n" {}\n`,
  ".terraform/modules/modules.json": JSON.stringify({
    Modules: [
      { Key: "", Source: "", Dir: "." },
      { Key: "inner", Source: `${OTHER_HOST}/inner.git?ref=v2`, Dir: ".terraform/modules/inner" },
    ],
  }),
  ".terraform/modules/inner/main.tf": 'resource "terraform_data" "x" {}\n',
  ".terraform.lock.hcl": 'provider "registry.opentofu.org/hashicorp/null" {\n  version = "3.2.0"\n}\n',
};
/** A unit whose init fetched nothing remote. */
const UNIT_PLAIN: Record<string, string> = { "main.tf": 'resource "terraform_data" "x" {}\n' };
const UNIT_HCL = `terraform {\n  source = "${GIT_HOST}/outer.git?ref=v1"\n}\n`;
const UNIT_INNER = `refused: live/a: module.inner (live/a/.terragrunt-cache/w/main.tf) uses module source ${OTHER_HOST}/inner.git?ref=v2, which no entry of sources.modules matches (sources.modules: ${GIT_HOST}/**)`;
const UNIT_NULL =
  'refused: live/a: provider.null (live/a/.terragrunt-cache/w/main.tf) uses provider registry.opentofu.org/hashicorp/null (implied by resource "null_resource" "n", with no required_providers entry), which no entry of sources.providers matches (sources.providers: hashicorp/aws)';

/** A tofu that logs each call with the directory it ran in. */
function loggingTofu(dir: string): string {
  const path = join(dir, "tofu");
  writeFileSync(path, `#!/bin/sh\necho "$(pwd -P) $1" >> "${dir}/calls.log"\nexit 0\n`);
  chmodSync(path, 0o755);
  return path;
}
const calls = (bin: string): string => (existsSync(join(bin, "calls.log")) ? readFileSync(join(bin, "calls.log"), "utf-8") : "");

/**
 * Terragrunt as a wave sees it: each unit inits in its working directory under
 * the unit's .terragrunt-cache, then runs `TG_TF_PATH plan -out=...` there. A
 * plan call that exits non-zero fails the unit, which writes no plan. `envs`
 * keeps the environment of each run --all. A unit in `bypass` plans with the
 * binary the wrapper would have run, never calling TG_TF_PATH, as a
 * Terragrunt whose plan call the wrapper did not recognise would.
 */
function initingTerragrunt(repo: string, units: Record<string, Record<string, string>>, bypass: string[] = []): { exec: TerragruntExec; envs: Record<string, string>[] } {
  const envs: Record<string, string>[] = [];
  const flag = (args: readonly string[], name: string): string => args[args.indexOf(name) + 1]!;
  const exec: TerragruntExec = async (file, args, options) => {
    if (file === "git") return { code: 0, stdout: "", stderr: "" };
    if (args[0] === "--version") return { code: 0, stdout: "terragrunt version v1.1.6\n", stderr: "" };
    if (args[0] === "find") return { code: 0, stdout: JSON.stringify(Object.keys(units).map((path) => ({ type: "unit", path, dependencies: [] }))), stderr: "" };
    if (args[0] === "render") return { code: 0, stdout: "{}", stderr: "" };
    if (args[0] !== "run") return { code: 1, stdout: "", stderr: `unexpected ${args.join(" ")}` };
    envs.push({ ...options.env });
    const command = args[args.indexOf("--") + 1];
    const filtered = args.flatMap((a, i) => (args[i - 1] === "--filter" && a.startsWith("{./") ? [a.slice(3, -1)] : []));
    const out = flag(args, "--out-dir");
    const rows: { Name: string; Result: string; Reason?: string; Cause?: string }[] = [];
    for (const u of filtered) {
      if (command !== "plan") {
        rows.push({ Name: u, Result: "succeeded" });
        continue;
      }
      const wd = write(join(repo, u, ".terragrunt-cache", "w"), units[u]!);
      const r = await new Promise<{ code: number; stderr: string }>((done) =>
        execFile(bypass.includes(u) ? (options.env[SOURCES_NEXT_ENV] ?? options.env.TG_TF_PATH!) : options.env.TG_TF_PATH!, ["plan", "-input=false", `-out=${join(out, u, "tfplan.tfplan")}`], { cwd: wd, env: { ...process.env, ...options.env } }, (err, _o, stderr) =>
          done({ code: err ? 1 : 0, stderr: String(stderr) }),
        ),
      );
      if (r.code !== 0) {
        rows.push({ Name: u, Result: "failed", Reason: "run error", Cause: r.stderr });
        continue;
      }
      const plan = { format_version: "1.2", resource_changes: [{ address: "terraform_data.x", mode: "managed", type: "terraform_data", name: "x", change: { actions: ["create"], before: null, after: { input: u }, after_unknown: {} } }] };
      for (const [dir, name, text] of [
        [out, "tfplan.tfplan", "plan"],
        [flag(args, "--json-out-dir"), "tfplan.json", JSON.stringify(plan)],
      ] as const) {
        mkdirSync(join(dir, u), { recursive: true });
        writeFileSync(join(dir, u, name), text);
      }
      rows.push({ Name: u, Result: "succeeded" });
    }
    const report = flag(args, "--report-file");
    mkdirSync(dirname(report), { recursive: true });
    writeFileSync(report, JSON.stringify(rows));
    return { code: rows.some((r) => r.Result === "failed") ? 1 : 0, stdout: "", stderr: rows.map((r) => r.Cause ?? "").join("\n") };
  };
  return { exec, envs };
}

describe("the wrapper between a unit's init and its plan", () => {
  it("asks about a plan call whose -out names a unit, and runs every other call as it is", () => {
    const w = sourcesWrapper("tofu", ["/w/plans", "/real/w/plans"], "/usr/bin/node", 4242);
    expect(w).toContain(`'/w/plans'/*/tfplan.tfplan) unit="\${out#'/w/plans'/}" ;;`);
    expect(w).toContain(`'/real/w/plans'/*/tfplan.tfplan) unit="\${out#'/real/w/plans'/}" ;;`);
    expect(w).toMatch(/'\/usr\/bin\/node' -e '.*' 4242 "\$\{unit%\/tfplan\.tfplan\}" "\$\(pwd -P\)" \|\| exit 1/);
    expect(w.trimEnd().split("\n").pop()).toBe('exec "$next" "$@"');
  });

  it("refuses a plan whose -out names no unit under the run's plan directories, and passes help, show and init through", () => {
    const dir = tmp("tg-sources-wrapper-");
    const tofu = loggingTofu(dir);
    const wrapper = join(dir, "wrapper");
    writeFileSync(wrapper, sourcesWrapper(tofu, [join(dir, "plans")], process.execPath, 1));
    chmodSync(wrapper, 0o755);
    const run = (...args: string[]): { code: number; stderr: string } => {
      const r = spawnSync(wrapper, args, { cwd: dir, encoding: "utf-8" });
      return { code: r.status ?? 1, stderr: r.stderr };
    };
    for (const out of [["-out=/elsewhere/live/a/tfplan.tfplan"], ["-out=plans/live/a/tfplan.tfplan"], []]) {
      const r = run("plan", "-input=false", ...out);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("names no unit under");
      expect(r.stderr).toContain("cannot be checked against sources; it is not run");
    }
    expect(calls(dir)).toBe("");
    for (const args of [["plan", "-help"], ["show", "-json", "x"], ["init", "-input=false"], ["version"]]) expect(run(...args).code).toBe(0);
    expect(calls(dir).trim().split("\n").map((l) => l.split(" ").pop())).toEqual(["plan", "show", "init", "version"]);
  });
});

describe("a Terragrunt unit checks what init fetched before plan", () => {
  afterEach(() => vi.restoreAllMocks());
  const tgRepo = (config: string): string => {
    const repo = write(tmp("tg-sources-units-"), { "root.hcl": "", "live/a/terragrunt.hcl": UNIT_HCL, "live/b/terragrunt.hcl": UNIT_HCL, "terragucci.yml": config });
    git(repo, "init", "-q");
    return repo;
  };

  it("tf-plan refuses a unit whose listed source calls an unlisted module, naming the unit and the module path, and never plans it", { timeout: 60_000 }, async () => {
    const repo = tgRepo(`sources:\n  modules: ['${GIT_HOST}/**']\n`);
    const bin = tmp();
    const tg = initingTerragrunt(repo, { "live/a": UNIT_INITED, "live/b": UNIT_PLAIN });
    const lines: string[] = [];
    const r = await runStage("tf-plan", repo, { out: join(bin, "out"), binary: loggingTofu(bin), terragrunt: true, terragruntExec: tg.exec, noCost: true, env: { PATH: process.env.PATH } }, (l) => lines.push(l));
    expect(r.failed).toBe(true);
    expect(r.report.roots.find((u) => u.path === "live/a")!.error).toBe(UNIT_INNER);
    expect(r.report.roots.find((u) => u.path === "live/b")!.error).toBeUndefined();
    expect(lines).toContain("live/a: refused by sources after init, so it was not planned");
    // live/b planned; live/a's plan never reached the binary.
    expect(calls(bin)).toMatch(/live\/b\/\.terragrunt-cache\/w plan/);
    expect(calls(bin)).not.toMatch(/live\/a\/\.terragrunt-cache\/w plan/);
  });

  it("tf-plan refuses a provider init locked for a unit, named by the module that uses it", { timeout: 60_000 }, async () => {
    const repo = tgRepo("sources:\n  providers: ['hashicorp/aws']\n");
    const bin = tmp();
    const tg = initingTerragrunt(repo, { "live/a": UNIT_INITED, "live/b": UNIT_PLAIN });
    const r = await runStage("tf-plan", repo, { out: join(bin, "out"), binary: loggingTofu(bin), terragrunt: true, terragruntExec: tg.exec, noCost: true, env: { PATH: process.env.PATH } }, () => {});
    expect(r.report.roots.find((u) => u.path === "live/a")!.error).toBe(UNIT_NULL);
    expect(calls(bin)).not.toMatch(/live\/a\/\.terragrunt-cache\/w plan/);
  });

  it("tf-plan holds a unit planned without the wrapper asking about it as unchecked, and uses no plan of it", { timeout: 60_000 }, async () => {
    const repo = tgRepo(`sources:\n  modules: ['${GIT_HOST}/**']\n`);
    const bin = tmp();
    const tg = initingTerragrunt(repo, { "live/a": UNIT_PLAIN, "live/b": UNIT_PLAIN }, ["live/b"]);
    const lines: string[] = [];
    const r = await runStage("tf-plan", repo, { out: join(bin, "out"), binary: loggingTofu(bin), terragrunt: true, terragruntExec: tg.exec, noCost: true, env: { PATH: process.env.PATH } }, (l) => lines.push(l));
    expect(r.failed).toBe(true);
    const unchecked = "live/b: what its init fetched and locked was not checked against sources before its plan, so it is not planned";
    expect(r.report.roots.find((u) => u.path === "live/b")!.error).toBe(unchecked);
    expect(r.report.roots.find((u) => u.path === "live/a")!.error).toBeUndefined();
    expect(lines).toContain(unchecked);
  });

  it("with no sources key runs Terragrunt as before: no wrapper of its own, and every unit plans", { timeout: 60_000 }, async () => {
    const repo = tgRepo("gate: never\n");
    const bin = tmp();
    const tg = initingTerragrunt(repo, { "live/a": UNIT_INITED, "live/b": UNIT_PLAIN });
    const lines: string[] = [];
    const r = await runStage("tf-plan", repo, { out: join(bin, "out"), binary: loggingTofu(bin), terragrunt: true, terragruntExec: tg.exec, noCost: true, env: { PATH: process.env.PATH } }, (l) => lines.push(l));
    expect(r.failed).toBe(false);
    expect(calls(bin)).toMatch(/live\/a\/\.terragrunt-cache\/w plan/);
    expect(tg.envs.length).toBeGreaterThan(0);
    for (const e of tg.envs) {
      expect(e.TERRAGUCCI_SOURCES_NEXT).toBeUndefined();
      expect(e.TG_TF_PATH).not.toMatch(/\.sources\//);
    }
    expect(lines.join("\n")).not.toMatch(/\bsources[:.]|by sources/);
  });

  it("a tf-apply wave refuses the unit after its init and before its plan, and applies nothing", async () => {
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const { work } = setupUnits(`gate: never\nsources:\n  modules: ['${GIT_HOST}/**']\n`);
    const bin = tmp();
    const tg = initingTerragrunt(work, { "live/a": UNIT_INITED, "live/b": UNIT_PLAIN });
    expect(await applyWave(work, { wave: 1, layers: [["live/a", "live/b"]], binary: loggingTofu(bin), gate: "never", env: { PATH: process.env.PATH! }, terragrunt: true, terragruntExec: tg.exec })).toBe(1);
    const logged = out.mock.calls.flat().join("\n");
    expect(logged).toContain("FAILED live/a: refused by sources after init, so it was not planned");
    expect(logged).toContain(UNIT_INNER);
    expect(calls(bin)).not.toMatch(/live\/a\/\.terragrunt-cache\/w plan/);
    expect(tg.envs.map((e) => e.TERRAGUCCI_SOURCES_NEXT !== undefined)).toEqual([true]);
  });

  it("a tf-apply wave holds a unit planned without the wrapper asking about it as unchecked, and applies nothing", async () => {
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const { work } = setupUnits(`gate: never\nsources:\n  modules: ['${GIT_HOST}/**']\n`);
    const bin = tmp();
    const tg = initingTerragrunt(work, { "live/a": UNIT_PLAIN, "live/b": UNIT_PLAIN }, ["live/b"]);
    expect(await applyWave(work, { wave: 1, layers: [["live/a", "live/b"]], binary: loggingTofu(bin), gate: "never", env: { PATH: process.env.PATH! }, terragrunt: true, terragruntExec: tg.exec })).toBe(1);
    expect(out.mock.calls.flat().join("\n")).toContain("FAILED live/b: what its init fetched and locked was not checked against sources before its plan, so it is not applied");
    expect(tg.envs).toHaveLength(1);
  });

  it("a tf-apply wave with no sources key plans and applies as before", async () => {
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const { work } = setupUnits("gate: never\n");
    const bin = tmp();
    const tg = initingTerragrunt(work, { "live/a": UNIT_INITED, "live/b": UNIT_PLAIN });
    expect(await applyWave(work, { wave: 1, layers: [["live/a", "live/b"]], binary: loggingTofu(bin), gate: "never", env: { PATH: process.env.PATH! }, terragrunt: true, terragruntExec: tg.exec })).toBe(0);
    expect(tg.envs.every((e) => e.TERRAGUCCI_SOURCES_NEXT === undefined)).toBe(true);
    expect(out.mock.calls.flat().join("\n")).not.toMatch(/\bsources[:.]|by sources/);
  });
});

/** A Terragrunt repo with an origin, its config at base, and a commit on top, as a wave job checks it out. */
function setupUnits(config: string): { work: string } {
  const dir = tmp("tg-sources-tgwave-");
  const origin = join(dir, "origin.git");
  git(dir, "init", "-q", "--bare", origin);
  const work = join(dir, "work");
  mkdirSync(work, { recursive: true });
  git(work, "init", "-q", "-b", "main");
  write(work, { "root.hcl": "", "live/a/terragrunt.hcl": UNIT_HCL, "live/b/terragrunt.hcl": UNIT_HCL, "terragucci.yml": config, ".gitignore": ".terragrunt-cache/\n" });
  git(work, "add", "-A");
  git(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "one");
  git(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "two");
  git(work, "remote", "add", "origin", origin);
  git(work, "push", "-q", "origin", "main");
  return { work };
}

/** A repo whose main holds `base` and whose branch `change` holds `head` on top of it. */
function branched(base: Record<string, string>, head: Record<string, string>): { repo: string; baseSha: string } {
  const repo = tmp("tg-sources-tg-git-");
  git(repo, "init", "-q", "-b", "main");
  write(repo, base);
  git(repo, "add", "-A");
  git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "base");
  const baseSha = git(repo, "rev-parse", "HEAD").trim();
  git(repo, "checkout", "-q", "-b", "change");
  write(repo, head);
  git(repo, "add", "-A");
  git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "change");
  return { repo, baseSha };
}

describe("the Terragrunt check job with sources", () => {
  afterEach(() => vi.restoreAllMocks());
  const TG = { version: "1.1.6", parallelism: 4, exclude: [] };
  const workflow = (r: Awaited<ReturnType<typeof init>>): string => r.files.find((f) => f.path.endsWith(".github/workflows/terragucci.yml"))!.content;

  it("runs check-sources --units before the validate fetches any source when the key is set, and renders the job as before without it", async () => {
    const lines = terragruntCheckScript({ ...TG, sources: true }, "tofu").split("\n");
    const at = lines.indexOf("terragucci check-sources --units");
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(lines.findIndex((l) => l.startsWith("terragrunt hcl validate")));
    expect(terragruntCheckScript(TG, "tofu")).toBe(terragruntCheckScript({ ...TG, sources: false }, "tofu"));
    expect(terragruntCheckScript(TG, "tofu")).not.toContain("check-sources");
    const files = { "root.hcl": "", "live/a/terragrunt.hcl": UNIT_HCL };
    const config = "binary: tofu\nforge: github\nterragrunt:\n  version: 1.1.6\n";
    const opts = { binary: "tofu" as const, forge: "github" as const, dryRun: true, terragrunt: "/nonexistent/terragrunt" };
    expect(workflow(await init(write(tmp(), { ...files, "terragucci.yml": `${config}sources:\n  modules: ['${GIT_HOST}/**']\n` }), opts))).toContain("terragucci check-sources --units");
    expect(workflow(await init(write(tmp(), { ...files, "terragucci.yml": config }), opts))).not.toContain("check-sources");
  });

  it("refuses a unit whose terraform source is outside the list at base, naming the unit, and prints nothing with no key", async () => {
    const { repo, baseSha } = branched(
      { "terragucci.yml": `sources:\n  modules: ['${GIT_HOST}/**']\n`, "root.hcl": "", "live/a/terragrunt.hcl": UNIT_HCL },
      { "terragucci.yml": `sources:\n  modules: ['${GIT_HOST}/**', '${OTHER_HOST}/**']\n`, "live/b/terragrunt.hcl": `terraform {\n  source = "${OTHER_HOST}/bad.git?ref=v1"\n}\n` },
    );
    const cwd = process.cwd();
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      process.chdir(repo);
      expect(await main(["check-sources", "--units", "--base", baseSha])).toBe(1);
      expect(await main(["check-sources", "live/a", "--units"])).toBe(USAGE);
    } finally {
      process.chdir(cwd);
    }
    const logged = out.mock.calls.flat().join("\n");
    expect(logged).toContain(`refused: live/b: terraform (live/b/terragrunt.hcl) uses module source ${OTHER_HOST}/bad.git?ref=v1, which no entry of sources.modules matches (sources.modules: ${GIT_HOST}/**)`);
    expect(logged).toContain("FAILED live/b: refused by sources, so it was not initialised");
    expect(logged).not.toContain("live/a");
    expect(readFileSync(join(repo, "terragucci-check", "report.md"), "utf-8")).toContain("refused: `live/b`: terraform");

    const plain = branched({ "terragucci.yml": "gate: never\n", "root.hcl": "", "live/a/terragrunt.hcl": UNIT_HCL }, { "live/b/terragrunt.hcl": `terraform {\n  source = "${OTHER_HOST}/bad.git"\n}\n` });
    out.mockClear();
    try {
      process.chdir(plain.repo);
      expect(await main(["check-sources", "--units", "--base", plain.baseSha])).toBe(0);
    } finally {
      process.chdir(cwd);
    }
    expect(out).not.toHaveBeenCalled();
    expect(existsSync(join(plain.repo, "terragucci-check"))).toBe(false);
  });
});
