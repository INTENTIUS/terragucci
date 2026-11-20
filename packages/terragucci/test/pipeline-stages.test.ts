// .chant/pipeline.ts from terragucci.yml (../src/pipeline.ts): promotion, environments and waves mapped onto chant's
// pipeline declaration, `terragucci ci` and its --check, the merge path's spec taking the folded first stage, and risk
// that only adds approvals.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { foldPipelineSource, PIPELINE_FILE } from "@intentius/chant/pipeline";
import { waveCallArgv, WAVES_SPEC, wavesSpecText, wavesStepSpec } from "../src/chant-waves";
import { validateConfig, type ProjectSettings } from "../src/config";
import { environmentSetsOf, pipelineCommand, pipelineDeclaration, pipelineNoteLines, pipelineText, stageWaves, workspaceWithSets } from "../src/pipeline";
import { wavesSpecAt } from "../src/waves-spec";
import { git, tmp, write } from "./helpers";

afterEach(() => {
  vi.restoreAllMocks();
});

const shape = (waves: string[][]): string => wavesSpecText(wavesStepSpec({ waves, gate: "on-destructive", approval: "ledger", call: waveCallArgv, migrations: false }));

const LAYERS = [["envs/dev/net", "envs/staging/net", "envs/prod/net"], ["envs/dev/app", "envs/staging/app", "envs/prod/app"]];

const base: ProjectSettings = {
  promotion: ["dev", "staging", "prod"],
  environments: {
    dev: { roots: ["envs/dev/**"], gate: "never" },
    staging: { roots: ["envs/staging/**"] },
    prod: { roots: ["envs/prod/**"], gate: "always" },
  },
};

function commit(dir: string, files: Record<string, string>): string {
  write(dir, files);
  git(dir, "add", "-A");
  git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "change");
  return git(dir, "rev-parse", "HEAD").trim();
}

function repo(files: Record<string, string>): string {
  const dir = tmp("tg-pipeline-");
  git(dir, "init", "-q", "-b", "main");
  commit(dir, files);
  return dir;
}

describe("the pipeline declaration", () => {
  it("makes one stage per environment of promotion, each with the merge path's waves cut to its roots", () => {
    const d = pipelineDeclaration(base, LAYERS)!;
    expect(d.name).toBe("tf-apply");
    expect(d.stages.map((s) => s.name)).toEqual(["dev", "staging", "prod"]);
    expect(d.stages[0]!.waves.map((w) => [w.name, w.runs.map((r) => r.target)])).toEqual([["wave-1", ["envs/dev/net"]], ["wave-2", ["envs/dev/app"]]]);
    expect(d.stages.map((s) => s.gate?.policy)).toEqual(["never", "on-destructive", "always"]);
  });

  it("is off with no promotion", () => {
    expect(pipelineDeclaration({ environments: base.environments }, LAYERS)).toBeUndefined();
  });

  it("marks a stage's first wave the canary when waves.canary names every root in it, with no canary key of its own", () => {
    const waves = stageWaves([["envs/dev/net"], ["envs/dev/app"]], "dev", { ...base, waves: { canary: ["envs/*/net"] } });
    expect(waves.map((w) => w.canary === true)).toEqual([true, false]);
    expect(stageWaves([["envs/dev/net", "envs/dev/app"]], "dev", { ...base, waves: { canary: ["envs/*/net"] } })[0]!.canary).toBeUndefined();
  });

  it("passes the stage keys to chant unchanged, in the vocabulary's words", () => {
    const settings: ProjectSettings = {
      ...base,
      environments: {
        dev: { roots: ["envs/dev/**"], gate: "never", soak: { duration: "30m", checks: [{ kind: "http", url: "https://dev.example.com/healthz", on_fail: "hold" }] }, failure_tolerance: "10%" },
        staging: { roots: ["envs/staging/**"], hold: { reason: "waiting on the load test", description: "check the load test's report" }, queue: "replace" },
        prod: {
          roots: ["envs/prod/**"],
          gate: "always",
          approval: "sealed",
          approval_rules: [{ name: "two-or-platform", any: [{ count: 2, not_author: true, proven: true }, { count: 1, roles: ["platform"], proven: true }] }],
          freeze: [{ from: "2026-12-20T00:00:00Z", until: "2027-01-04T00:00:00Z", reason: "year-end" }],
          urgent: { role: "oncall" },
          pause_after_rollback: true,
          on_verify_fail: "rollback",
          after: ["staging"],
        },
      },
    };
    const [dev, staging, prod] = pipelineDeclaration(settings, LAYERS)!.stages;
    expect(dev!.soak).toEqual({ duration: "30m", checks: [{ kind: "http", url: "https://dev.example.com/healthz", onFail: "hold" }] });
    expect(dev!.failureTolerance).toBe("10%");
    expect(staging!.hold).toEqual({ reason: "waiting on the load test", description: "check the load test's report" });
    expect(staging!.queue).toBe("replace");
    expect(prod!.gate).toMatchObject({ policy: "always", approval: "sealed", urgent: { role: "oncall" }, quorum: [{ name: "two-or-platform", any: [{ count: 2, notAuthor: true, proven: true }, { count: 1, roles: ["platform"], proven: true }] }] });
    expect(prod!.freeze).toEqual([{ from: "2026-12-20T00:00:00Z", until: "2027-01-04T00:00:00Z", reason: "year-end" }]);
    expect(prod!.pauseAfterRollback).toBe(true);
    expect(prod!.onVerifyFail).toBe("rollback");
    expect(prod!.after).toEqual(["staging"]);
  });

  it("maps risk onto holds.risk and replan_dependents onto replanDependents", () => {
    const d = pipelineDeclaration(
      {
        ...base,
        risk: { approve_above: 0.7 },
        replan_dependents: ["envs/*/net"],
        environments: { ...base.environments, staging: { roots: ["envs/staging/**"], risk: { approve_above: 0.4, approval_rules: [{ count: 1, roles: ["sre"] }] }, replan_dependents: ["envs/staging/net"] } },
      },
      LAYERS,
    )!;
    expect(d.defaults?.holds?.risk).toEqual({ approveAbove: 0.7 });
    expect(d.defaults?.replanDependents).toEqual(["envs/*/net"]);
    const staging = d.stages[1]!;
    expect(staging.gate?.holds?.risk).toEqual({ approveAbove: 0.4, quorum: [{ count: 1, roles: ["sre"] }] });
    expect(staging.replanDependents).toEqual(["envs/staging/net"]);
  });

  it("writes rule roots as chant's targets", () => {
    const d = pipelineDeclaration({ ...base, approval: "sealed", approval_rules: [{ roots: ["envs/prod/**"], count: 2, proven: true }] }, LAYERS)!;
    expect(d.stages[0]!.gate?.quorum).toEqual([{ targets: ["envs/prod/**"], count: 2, proven: true }]);
  });

  it("refuses an environment of promotion with no roots in the waves", () => {
    expect(() => pipelineDeclaration({ ...base, promotion: ["dev", "qa"], environments: { ...base.environments, qa: { roots: ["envs/qa/**"] } } }, LAYERS)).toThrow(/qa has no roots/);
  });

  it("folds as chant folds it", () => {
    const dir = repo({ [WAVES_SPEC]: shape(LAYERS) });
    const text = pipelineText(dir, base)!;
    const folded = foldPipelineSource(text, PIPELINE_FILE);
    expect("spec" in folded && folded.spec.stages.map((s) => s.name)).toEqual(["dev", "staging", "prod"]);
  });
});

describe("terragucci ci", () => {
  it("writes .chant/pipeline.ts, and --check fails once terragucci.yml changes it", () => {
    const dir = repo({ [WAVES_SPEC]: shape(LAYERS) });
    const lines: string[] = [];
    const log = (l: string) => void lines.push(l);
    expect(pipelineCommand(dir, base, { check: true, log })).toBe(1);
    expect(lines.join("\n")).toMatch(/missing; run `terragucci ci`/);
    expect(pipelineCommand(dir, base, { log })).toBe(0);
    expect(existsSync(join(dir, PIPELINE_FILE))).toBe(true);
    expect(pipelineCommand(dir, base, { check: true, log })).toBe(0);
    const changed: ProjectSettings = { ...base, environments: { ...base.environments, prod: { roots: ["envs/prod/**"], gate: "on-destructive" } } };
    lines.length = 0;
    expect(pipelineCommand(dir, changed, { check: true, log })).toBe(1);
    expect(lines.join("\n")).toMatch(/not what the config writes/);
  });

  it("writes nothing with no promotion", () => {
    const dir = repo({ [WAVES_SPEC]: shape(LAYERS) });
    expect(pipelineCommand(dir, {}, { log: () => {} })).toBe(0);
    expect(existsSync(join(dir, PIPELINE_FILE))).toBe(false);
  });

  it("writes the environments' config and secret sets into ci.environmentSets", () => {
    const sets = environmentSetsOf({
      config_sets: { common: { config: { LOG_LEVEL: "info" } } },
      environments: { staging: { roots: ["envs/staging/**"], imports: ["common"], secrets: { API_KEY: { aws_secrets_manager: "arn:aws:secretsmanager:us-east-2:111111111111:secret:staging/api", json_key: "key" } } } },
    })!;
    expect(sets.environments.staging).toEqual({ imports: ["common"], secrets: { API_KEY: { awsSecretsManager: "arn:aws:secretsmanager:us-east-2:111111111111:secret:staging/api", jsonKey: "key" } } });
    const text = workspaceWithSets(`{"version":1}\n`, sets)!;
    expect(JSON.parse(text).ci.environmentSets.configSets.common.config).toEqual({ LOG_LEVEL: "info" });
    expect(workspaceWithSets(`{"version":1}\n`, undefined)).toBe(`{"version":1}\n`);
  });
});

describe("config check of the stage keys", () => {
  it("asks chant about the stage keys' words", () => {
    expect(() => validateConfig({ ...base, environments: { ...base.environments, prod: { roots: ["envs/prod/**"], on_verify_fail: "undo" } } }, "terragucci.yml")).toThrow(/on_verify_fail/);
  });
});

describe("the merge path's spec", () => {
  const files = (config: string) => ({ [WAVES_SPEC]: shape([["envs/dev/net"], ["envs/dev/app"]]), "terragucci.yml": config });

  it("takes risk.approve_above and replan_dependents at base", async () => {
    const dir = repo(files("risk:\n  approve_above: 0.5\nreplan_dependents: [\"envs/dev/net\"]\n"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const spec = (await wavesSpecAt(dir, { at: "HEAD", env: {} }))!;
    expect(spec.holds?.risk).toEqual({ approveAbove: 0.5 });
    expect((spec as { replanDependents?: string[] }).replanDependents).toEqual(["envs/dev/net"]);
  });

  it("takes the folded first stage's risk hold and canary soak from .chant/pipeline.ts at base", async () => {
    const settings: ProjectSettings = {
      promotion: ["dev", "prod"],
      waves: { canary: ["envs/*/net"] },
      environments: { dev: { roots: ["envs/dev/**"], risk: { approve_above: 0.3 }, soak: { duration: "1h", checks: [{ kind: "drift" }] } }, prod: { roots: ["envs/prod/**"] } },
    };
    const dir = repo({ [WAVES_SPEC]: shape([["envs/dev/net", "envs/prod/net"], ["envs/dev/app", "envs/prod/app"]]) });
    pipelineCommand(dir, settings, { log: () => {} });
    commit(dir, { "terragucci.yml": "promotion: [dev, prod]\n" });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const spec = (await wavesSpecAt(dir, { at: "HEAD", env: {} }))!;
    expect(spec.holds?.risk).toEqual({ approveAbove: 0.3 });
    expect(spec.waves[0]).toMatchObject({ canary: true, soak: { duration: "1h", checks: [{ kind: "drift" }] } });
    expect(spec.waves[1]!.canary).toBeUndefined();
  });

  // Risk only adds approvals: a score below the threshold never makes a wave's gate looser, and allow_unattended is
  // read from the policy at base as it always was, whatever the risk.
  it("never lets risk feed allow_unattended: the gate is the same with and without risk", async () => {
    const policy = "policy:\n  engine: opa\n  path: policy\n";
    const rego = { "policy/p.rego": "package main\n\ndeny contains \"never\" if { false }\n" };
    vi.spyOn(console, "error").mockImplementation(() => {});
    const without = (await wavesSpecAt(repo({ ...files(`gate: always\n${policy}`), ...rego }), { at: "HEAD", env: {} }))!;
    const withRisk = (await wavesSpecAt(repo({ ...files(`gate: always\n${policy}risk:\n  approve_above: 0.99\n`), ...rego }), { at: "HEAD", env: {} }))!;
    expect(withRisk.waves.map((w) => w.gate)).toEqual(without.waves.map((w) => w.gate));
    expect(withRisk.waves.map((w) => w.gate)).toEqual(["always", "always"]);
    expect(withRisk.holds?.risk).toEqual({ approveAbove: 0.99 });
    // With allow_unattended at base the gate is never, as before, and the risk hold still stands to hold an over score.
    const unattended = (await wavesSpecAt(repo({ ...files(`gate: always\n${policy}  outcomes: [deny, allow_unattended]\nrisk:\n  approve_above: 0.2\n`), ...rego }), { at: "HEAD", env: {} }))!;
    expect(unattended.waves.map((w) => w.gate)).toEqual(["never", "never"]);
    expect(unattended.holds?.risk).toEqual({ approveAbove: 0.2 });
  });
});

describe("the plan note", () => {
  it("lists the soaks a change passes through", () => {
    const d = pipelineDeclaration({ ...base, environments: { ...base.environments, dev: { roots: ["envs/dev/**"], soak: { duration: "30m", checks: [{ kind: "drift" }] } } } }, LAYERS)!;
    const text = pipelineNoteLines({ ...d, kind: "chant.pipeline/v1" } as never).join("\n");
    expect(text).toMatch(/### Soak/);
    expect(text).toMatch(/`dev`/);
    expect(pipelineNoteLines(undefined)).toEqual([]);
  });
});
