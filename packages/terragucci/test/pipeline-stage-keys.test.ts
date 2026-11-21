// terragucci#1493's remaining keys on chant's pipeline: stage hooks (chant#5421), the risk record in the after-plan
// hook for the policy and the plan note (chant#5422), one holds map, one soak config, the verify-failed agent
// (chant#5339), promote --urgent (chant#5355), control.release (chant#5356) and the promote path's rollback (chant#5328).
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import { foldPipelineSource, pipelineSource, PIPELINE_FILE, verifyRollbackProblems } from "@intentius/chant/pipeline";
import type { ChangeRisk } from "@intentius/chant/change-risk";
import { agentTriggerInput } from "../src/agent-comment";
import { waveCallArgv, WAVES_SPEC, wavesSpecText, wavesStepSpec } from "../src/chant-waves";
import { ConfigError, rolloutsSoak, validateConfig, type ProjectSettings } from "../src/config";
import { resolveControl } from "../src/control-repo";
import { costHold, costHoldEnv } from "../src/cost";
import { pipelineCommand, pipelineDeclaration } from "../src/pipeline";
import { promoteAgentFactsEnv, promotionComponentsText, releaseArgv } from "../src/promotion";
import { chantFactsFiles, chantFactsPath, waveAgentFacts } from "../src/render-chant-agent-triggers";
import { MARKER, renderPipeline } from "../src/render";
import { checkPlans, policyInput, type PolicyExec } from "../src/report/policy";
import { noteRiskOf } from "../src/report/views";
import { chantSoakOf } from "../src/rollout/wave-soak";
import { specHolds, wavesSpecAt } from "../src/waves-spec";
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

function commit(dir: string, files: Record<string, string>): void {
  write(dir, files);
  git(dir, "add", "-A");
  git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "change");
}

function repo(files: Record<string, string>): string {
  const dir = tmp("tg-stage-keys-");
  git(dir, "init", "-q", "-b", "main");
  commit(dir, files);
  return dir;
}

const problems = (raw: Record<string, unknown>): string[] => {
  try {
    validateConfig(raw, "config");
    return [];
  } catch (e) {
    if (e instanceof ConfigError) return e.problems ?? [e.message];
    throw e;
  }
};

/** terragucci.yml at base with promotion: config check asks each name it lists to be an environment with roots. */
const PROMOTED = 'promotion: [dev, prod]\nenvironments:\n  dev:\n    roots: ["envs/dev/**"]\n  prod:\n    roots: ["envs/prod/**"]\n';

/** A risk record as chant's after-plan hook hands it (chant#5422). */
const risk = (score: number, over: boolean): ChangeRisk => ({
  version: 1,
  score,
  level: score >= 0.7 ? "high" : score >= 0.4 ? "medium" : "low",
  reasons: [{ id: "destroys", weight: 0.5, count: 1, value: score, contribution: score / 2, detail: "1 destroy" }],
  approveAbove: 0.5,
  over,
  overBy: over ? [`score ${score} is above 0.5`] : [],
}) as ChangeRisk;

describe("environments.<name>.hooks.<when>", () => {
  const hooks = { "before-plan": [{ name: "lint", command: ["make", "lint"] }], "after-apply": [{ command: ["./smoke.sh"], on_failure: "fail", per_run: true, targets: ["envs/dev/app"] }] };

  it("reaches chant's pipelineFromConfig as written and lands on the stage's hooks", () => {
    const d = pipelineDeclaration({ ...base, environments: { ...base.environments, dev: { roots: ["envs/dev/**"], gate: "never", hooks } as never } }, LAYERS)!;
    expect(d.stages[0]!.hooks).toEqual({
      before: { plan: [{ name: "lint", command: ["make", "lint"] }] },
      after: { apply: [{ command: ["./smoke.sh"], onFailure: "fail", perRun: true, targets: ["envs/dev/app"] }] },
    });
    expect(d.stages[1]!.hooks).toBeUndefined();
    expect("spec" in foldPipelineSource(pipelineSource(d, { product: "terragucci", config: "terragucci.yml", command: "terragucci ci" }), PIPELINE_FILE)).toBe(true);
  });

  it("is checked by config check: a <when> outside chant's moments is refused", () => {
    const bad = problems({ ...base, environments: { ...base.environments, dev: { roots: ["envs/dev/**"], hooks: { "during-apply": [{ command: ["x"] }] } } } });
    expect(bad.join("\n")).toMatch(/hooks/);
    expect(problems({ ...base, environments: { ...base.environments, dev: { roots: ["envs/dev/**"], hooks } } })).toEqual([]);
  });

  it("runs the first stage's hooks in the merge path's waves after terragucci's own report hook", async () => {
    const settings = { promotion: ["dev", "prod"], environments: { dev: { roots: ["envs/dev/**"], hooks: { "after-gate": [{ name: "page", command: ["./page.sh"] }] } }, prod: { roots: ["envs/prod/**"] } } } as ProjectSettings;
    const dir = repo({ [WAVES_SPEC]: shape([["envs/dev/net", "envs/prod/net"]]) });
    pipelineCommand(dir, settings, { log: () => {} });
    commit(dir, { "terragucci.yml": PROMOTED });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const spec = (await wavesSpecAt(dir, { at: "HEAD", env: {} }))!;
    expect(spec.hooks?.after?.gate?.map((h) => h.name)).toEqual(["report", "page"]);
  });
});

// chant#5324's settled decision: the merge applies the first stage and cuts a release, and each later stage promotes it.
describe("the release cut on the merge path", () => {
  const layers = [["envs/dev/net", "envs/prod/net"], ["envs/dev/app", "envs/prod/app"]];
  const settings = (release?: ProjectSettings["release"]): ProjectSettings => ({ promotion: ["dev", "prod"], environments: { dev: { roots: ["envs/dev/**"], gate: "never" }, prod: { roots: ["envs/prod/**"] } }, ...(release ? { release } : {}) });
  const specOf = async (s: ProjectSettings | undefined, config: string) => {
    const dir = repo({ [WAVES_SPEC]: shape(layers) });
    if (s) pipelineCommand(dir, s, { log: () => {} });
    commit(dir, { "terragucci.yml": config });
    vi.spyOn(console, "error").mockImplementation(() => {});
    return (await wavesSpecAt(dir, { at: "HEAD", env: {} }))!;
  };

  it("runs as terragucci in .chant/pipeline.ts, with the label as written", () => {
    expect(pipelineDeclaration(settings(), LAYERS.map((l) => l.filter((r) => !r.includes("staging"))))!.release).toEqual({ bin: ["terragucci"] });
    expect(pipelineDeclaration(settings({ label: "auto" }), LAYERS)?.release).toEqual({ label: "auto", bin: ["terragucci"] });
  });

  it("cuts a release after the last wave's apply when promotion is set, and wave 1 keeps its migration hooks", async () => {
    const spec = await specOf(settings(), PROMOTED);
    const last = spec.waves.at(-1)!;
    expect(last.hooks?.after?.apply).toEqual([{ name: "release-cut", command: ["terragucci", "release", "cut", "auto", "--yes"] }]);
    expect(spec.waves[0]!.hooks?.before?.plan?.map((h) => h.name)).toEqual(["migrations", "migration gate"]);
    expect(spec.waves[0]!.hooks?.after?.apply).toBeUndefined();
  });

  it("cuts nothing with release.cut: false", async () => {
    const spec = await specOf(settings({ cut: false }), `${PROMOTED}release:\n  cut: false\n`);
    expect(spec.waves.some((w) => w.hooks?.after?.apply?.length)).toBe(false);
  });

  it("cuts on the default branch's merge alone: a push to a branch apply.branches names cuts nothing", async () => {
    const config = `${PROMOTED}apply:\n  branches:\n    hotfix: ["envs/prod/**"]\n`;
    const at = async (branch: string) => {
      const dir = repo({ [WAVES_SPEC]: shape(layers) });
      pipelineCommand(dir, settings(), { log: () => {} });
      commit(dir, { "terragucci.yml": config });
      vi.spyOn(console, "error").mockImplementation(() => {});
      return (await wavesSpecAt(dir, { at: "HEAD", env: { GITHUB_REF_NAME: branch } }))!;
    };
    expect((await at("main")).waves.at(-1)!.hooks?.after?.apply?.map((h) => h.name)).toEqual(["release-cut"]);
    const hotfix = await at("hotfix");
    expect(hotfix.waves.some((w) => w.hooks?.after?.apply?.length)).toBe(false);
    expect(hotfix.waves.flatMap((w) => w.runs.map((r) => r.target))).toEqual(["envs/prod/net", "envs/prod/app"]);
  });

  it("cuts nothing without promotion, as before", async () => {
    const spec = await specOf(undefined, "gate: never\n");
    expect(spec.waves.some((w) => w.hooks?.after?.apply?.length)).toBe(false);
  });
});

describe("one holds map", () => {
  const cost = costHold(true, 100);

  it("keeps the shape's policy hold, the stage's risk hold and the cost hold side by side", () => {
    expect(specHolds({ policy: true }, { risk: { approveAbove: 0.4 } }, cost)).toEqual({ policy: true, risk: { approveAbove: 0.4 }, cost });
    expect(specHolds(undefined, undefined, undefined)).toBeUndefined();
  });

  it("writes cost.approve_above and risk.approve_above into one map in the merge path's spec", async () => {
    const dir = repo({ [WAVES_SPEC]: shape([["envs/dev/net"]]), "terragucci.yml": "cost:\n  approve_above: 100\nrisk:\n  approve_above: 0.5\n" });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const spec = (await wavesSpecAt(dir, { at: "HEAD", env: {} }))!;
    expect(Object.keys(spec.holds ?? {}).sort()).toEqual(["cost", "risk"]);
    expect(spec.holds?.risk).toEqual({ approveAbove: 0.5 });
    expect(spec.holds?.cost).toMatchObject({ approveAbove: 100, format: "infracost" });
  });

  it("names the environment sets' secrets in the cost hold's redactEnv, beside secrets:, and terragucci's tokens in dropEnv", () => {
    const env = costHoldEnv({
      secrets: [{ roots: ["envs/dev/**"], from: "aws", values: { TF_VAR_api_key: "dev/api" } }],
      environments: { dev: { roots: ["envs/dev/**"], secrets: { DB_PASSWORD: "DEV_DB_PASSWORD" } }, prod: { roots: ["envs/prod/**"] } },
      config_sets: { common: { secrets: { SENTRY_DSN: { forge_secret: "SENTRY_DSN" } } } },
    });
    expect(env).toEqual({ redactEnv: ["DB_PASSWORD", "SENTRY_DSN", "TF_VAR_api_key"], dropEnv: ["TG_TOKEN", "TG_MERGE_TOKEN"] });
    expect(costHold(true, 100, env)).toMatchObject({ redactEnv: ["DB_PASSWORD", "SENTRY_DSN", "TF_VAR_api_key"], dropEnv: ["TG_TOKEN", "TG_MERGE_TOKEN"] });
  });

  it("carries the risk hold on the step path beside policy and cost", () => {
    const spec = wavesStepSpec({ waves: [["a"]], gate: "always", approval: "ledger", call: waveCallArgv, migrations: false, policy: true, cost, risk: { approveAbove: 0.3 } });
    expect(spec.holds).toEqual({ policy: true, risk: { approveAbove: 0.3 }, cost });
  });
});

describe("the risk record from the after-plan hook", () => {
  it("is input.risk beside the plan's keys, and under input: hcp", () => {
    const r = risk(0.8, true);
    expect(JSON.parse(policyInput({}, '{"format_version":"1.2"}', { root: "a", risk: r }))).toMatchObject({ format_version: "1.2", risk: { score: 0.8, over: true } });
    expect(JSON.parse(policyInput({ input: "hcp" }, '{"format_version":"1.2"}', { root: "a", risk: r })).risk).toMatchObject({ score: 0.8 });
    expect(policyInput({}, "{}", { root: "a" })).toBe("{}");
  });

  // Risk only adds approvals (chant#5325): a policy may deny or hold on input.risk, and allow_unattended is read without it.
  it("never feeds allow_unattended: the allow is read from an input without input.risk", async () => {
    const dir = write(tmp(), { "policy/main.rego": "package main\n\ndeny contains \"x\" if { false }\n" });
    const inputs: Record<string, unknown>[] = [];
    // An opa that allows unattended whenever input.risk says the score is low, and holds whenever it is over.
    const exec: PolicyExec = async (_f, args) => {
      if (args[0] === "version" || args[0] === "--version") return { status: 0, stdout: "", stderr: "" };
      const input = JSON.parse(readFileSync(args[args.indexOf("--input") + 1]!, "utf-8")) as { risk?: ChangeRisk };
      inputs.push(input);
      const value = { deny: [], ...(input.risk && input.risk.score < 0.5 ? { allow_unattended: true } : {}), ...(input.risk?.over ? { hold: ["risk over"] } : {}) };
      return { status: 0, stdout: JSON.stringify({ result: [{ expressions: [{ value }] }] }), stderr: "" };
    };
    const policy = { engine: "opa" as const, path: "policy", outcomes: ["deny", "hold", "allow_unattended"] as never };
    const low = await checkPlans(dir, policy, [{ path: "a", plan: {} }], undefined, {}, { exec }, () => {}, { stage: "tf-apply", risk: risk(0.1, false) });
    expect(inputs.some((i) => "risk" in i)).toBe(true);
    expect(low.roots.get("a")?.allowed_by).toBeUndefined();
    const high = await checkPlans(dir, policy, [{ path: "a", plan: {} }], undefined, {}, { exec }, () => {}, { stage: "tf-apply", risk: risk(0.9, true) });
    expect(high.roots.get("a")?.held_by).toEqual(["main.hold"]);
  });

  it("goes on the plan note as the record of the wave that scored highest", () => {
    expect(noteRiskOf({ waves: [{ risk: risk(0.2, false) }, { risk: risk(0.8, true) }, {}] as never })?.score).toBe(0.8);
    expect(noteRiskOf({ waves: [{}] as never })).toBeUndefined();
  });
});

describe("rollouts.soak in the stage soak's words", () => {
  const rollouts = (soak: unknown) => ({ rollouts: { schedule: "*/15 * * * *", soak } });

  it("takes duration and checks with on_fail, as environments.<name>.soak does", () => {
    expect(problems(rollouts({ duration: "24h", checks: [{ kind: "drift", on_fail: "hold" }, { kind: "apply" }], overrides: [{ module: "acme/*", duration: "2h" }] }))).toEqual([]);
    const soak = rolloutsSoak(rollouts({ duration: "24h", checks: [{ kind: "drift", on_fail: "hold" }, { kind: "apply" }] }).rollouts as never)!;
    expect(soak).toMatchObject({ after: "24h", conditions: ["drift", "apply"] });
    expect(chantSoakOf(soak, "module")).toEqual({ duration: "24h", checks: [{ kind: "drift", onFail: "hold" }, { kind: "apply" }] });
  });

  it("still reads after and conditions, each condition a check that holds", () => {
    const soak = rolloutsSoak(rollouts({ after: "6h", conditions: ["policy"] }).rollouts as never)!;
    expect(chantSoakOf(soak, "module")).toEqual({ duration: "6h", checks: [{ kind: "policy", onFail: "hold" }] });
  });

  it("refuses both spellings in one map, and a kind a rollout does not read", () => {
    expect(problems(rollouts({ duration: "1h", after: "1h" })).join("\n")).toMatch(/after is the earlier spelling of duration/);
    expect(problems(rollouts({ duration: "1h", checks: [{ kind: "drift" }], conditions: ["drift"] })).join("\n")).toMatch(/conditions is the earlier spelling of checks/);
    expect(problems(rollouts({ duration: "1h", checks: [{ kind: "http" }] })).join("\n")).toMatch(/environments.<name>.soak takes the other kinds/);
  });
});

describe("agent.verify-failed", () => {
  const agent = (extra: Record<string, unknown>) => ({ agent: { via: "forge", token_env: "AGENT_FORGE_TOKEN", ...extra } });
  const input = { binary: "tofu" as const, version: "1.13.1", image: "img:1", layers: [["a"]], env: {} };

  it("is off by default and takes the facts agents' keys", () => {
    expect(agentTriggerInput(validateConfig(agent({}), "t"), "verify-failed")).toBeUndefined();
    const s = validateConfig(agent({ "verify-failed": { max_cost_usd: 5, max_turns: 8, window: 30, relay_key_secret: "OPS_RELAY" } }), "t");
    expect(agentTriggerInput(s, "verify-failed")).toMatchObject({ maxCostUsd: 5, maxTurns: 8, window: 30, relayKeySecret: "OPS_RELAY" });
  });

  it("asks for one relay key with agent.apply-failed", () => {
    expect(problems(agent({ "apply-failed": { relay_key_secret: "A_KEY" }, "verify-failed": { relay_key_secret: "B_KEY" } })).join("\n")).toMatch(/verify-failed.relay_key_secret must be agent.apply-failed's/);
    expect(problems(agent({ "apply-failed": true, "verify-failed": true }))).toEqual([]);
  });

  it("writes chant's failed-verify agent workflow and adds verify-failed to the wave jobs' facts", () => {
    const vf = agentTriggerInput(validateConfig(agent({ "verify-failed": true }), "t"), "verify-failed")!;
    const files = chantFactsFiles("verify-failed", "github", "img:1", vf, MARKER)!;
    expect(JSON.parse(files.files[0]!.content).ops[0].agent).toMatchObject({ on: "verify-failed" });
    expect(waveAgentFacts(undefined, vf)).toEqual({ relayKeyEnv: "CHANT_RELAY_KEY", triggers: ["verify-failed"] });
    const on = renderPipeline({ ...input, forge: "github", agentVerifyFailed: vf });
    expect(on.extra!.map((f) => f.path)).toContain(chantFactsPath("verify-failed", "github"));
    expect(on.content).toContain("CHANT_AGENT_FACTS: verify-failed");
    const both = renderPipeline({ ...input, forge: "github", agentApplyFailed: vf, agentVerifyFailed: vf });
    expect(both.content).toContain("CHANT_AGENT_FACTS: apply-failed,verify-failed");
    expect(() => renderPipeline({ ...input, forge: "gitlab", agentVerifyFailed: vf })).toThrow("agent.verify-failed runs on GitHub and Forgejo");
  });

  it("has terragucci promote record a failed verify or soak, with the relay key from relay_key_secret", () => {
    const s = validateConfig(agent({ "verify-failed": { relay_key_secret: "OPS_RELAY" } }), "t");
    expect(promoteAgentFactsEnv(s, { CHANT_AGENT_FACTS: "apply-failed", OPS_RELAY: "k" })).toEqual({ CHANT_AGENT_FACTS: "apply-failed,verify-failed", CHANT_RELAY_KEY: "k" });
    expect(promoteAgentFactsEnv(s, { CHANT_RELAY_KEY: "set" })).toEqual({ CHANT_AGENT_FACTS: "verify-failed" });
    expect(promoteAgentFactsEnv(validateConfig(agent({}), "t"), {})).toEqual({});
  });
});

describe("terragucci promote --urgent", () => {
  it("maps onto chant's components promote --urgent --reason with the release", () => {
    expect(releaseArgv("promote", { args: [], flags: { to: "prod", release: "v1.4.0", urgent: true, reason: "sev1 fix" } })).toEqual(["components", "promote", "--to", "prod", "--release", "v1.4.0", "--urgent", "--reason", "sev1 fix"]);
  });

  it("needs a release and a reason, and a reason goes with --urgent alone", () => {
    expect(() => releaseArgv("promote", { args: [], flags: { to: "prod", urgent: true, reason: "x" } })).toThrow(/--urgent promotes one release/);
    expect(() => releaseArgv("promote", { args: [], flags: { to: "prod", release: "v1", urgent: true } })).toThrow(/--urgent needs --reason/);
    expect(() => releaseArgv("promote", { args: [], flags: { to: "prod", release: "v1", reason: "x" } })).toThrow(/--reason goes with --urgent/);
    expect(() => releaseArgv("rollback", { args: ["prod"], flags: { release: "v1", urgent: true } })).toThrow(/does not take --urgent/);
  });
});

describe("control.release", () => {
  it("is off by default and maps onto chant's control release", () => {
    expect(resolveControl({ repo: "github.com/acme/control", op: "deploy" }, "infra").release).toBeUndefined();
    expect(resolveControl({ repo: "github.com/acme/control", op: "deploy", release: true }, "infra").release).toBe(true);
    expect(problems({ control: { repo: "github.com/acme/control", op: "deploy", release: "yes" } }).join("\n")).toMatch(/control.release must be true or false/);
  });

  it("puts release on the waves' control dispatch", () => {
    // chant's control job reads the release the applied commit was cut into and puts it in the dispatch's payload,
    // which reaches the control repo's run as CHANT_CONTROL_RELEASE.
    const render = (release: boolean) => {
      const control = resolveControl({ repo: "github.com/acme/control", op: "deploy", release }, "infra");
      return JSON.stringify(parseYAML(renderPipeline({ binary: "tofu", version: "1.13.1", image: "img:1", layers: [["a"]], env: {}, forge: "github", control }).content));
    };
    expect(render(true)).toContain("chant pipeline release-of");
    expect(render(false)).not.toContain("release-of");
  });
});

describe("on_verify_fail: rollback on the promote path", () => {
  it("is accepted for terragucci.component.ts: its terraform-apply steps answer releaseInputs, and its gates are skipped", async () => {
    const text = promotionComponentsText({ components: [{ name: "envs-net", byEnv: { dev: { root: "envs/dev/net", dependsOn: [] }, prod: { root: "envs/prod/net", dependsOn: [] } } }], gated: ["prod"] }, ["dev", "prod"]);
    expect(text).toContain('kind: "terraform-apply"');
    const { terraformApplyCapability } = await import("@intentius/chant-lexicon-terraform");
    const steps = [{ where: 'component "envs-net" step Apply/terraform-apply', kind: "terraform-apply" }];
    const spec = { stages: [{ name: "dev", waves: [] }, { name: "prod", waves: [], onVerifyFail: "rollback" }] } as never;
    const found = verifyRollbackProblems({ spec, steps, capability: () => ({ releaseInputs: typeof (terraformApplyCapability as { releaseInputs?: unknown }).releaseInputs === "function", rollbackPolicy: "needs-opt-out" }) });
    expect(found).toEqual([]);
  });
});
