// terragucci#1305 and chant issue 4622: every scheduled drift job is a chant drift Op; with agent.drift it rides chant's agent job (chant#4616).
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import { agentDriftInput } from "../src/agent-comment";
import { type ChantAgentJob, type ChantScheduledOpSpec } from "../src/chant-next";
import { validateConfig } from "../src/config";
import { AGENT_RUN_LEDGERS } from "../src/report/audit";
import { CHANT_DRIFT_FOUND_JOB, CHANT_DRIFT_OP, CHANT_DRIFT_OP_FILE, CHANT_DRIFT_PATHS, CHANT_DRIFT_SCRIPT_FILE, CHANT_DRIFT_SPEC_FILE, chantDriftFiles, chantDriftFoundJob, chantDriftOpFile, rootDriftOpName } from "../src/render-chant-drift";
import { driftScript, MARKER, renderPipeline } from "../src/render";

const agent = agentDriftInput(validateConfig({ drift: "0 6 * * *", respond: { drift: "off" }, agent: { via: "forge", token_env: "AGENT_FORGE_TOKEN", drift: { max_cost_usd: 2 } } }, "t"))!;

function fakeAgentJob(seen: { specs?: ChantScheduledOpSpec[]; options?: unknown[] } = {}): ChantAgentJob {
  return {
    CI_AGENT_FLOOR: "0.124.55",
    productPipelineJobs: () => ({}),
    productDriftAgent: (_w, _op, o) => ({ on: "drift", ...(o ?? {}) }),
    setActiveProductWords: () => undefined,
    generate: Object.fromEntries(["github", "gitlab", "forgejo"].map((f) => [f, (ops: ChantScheduledOpSpec[], options?: unknown) => {
      (seen.specs ??= []).push(...ops);
      (seen.options ??= []).push(options);
      return { files: [{ name: `${ops[0]!.name}.yml`, yaml: `# ${f} drift op\njobs:\n  ${ops[0]!.name}:\n    runs-on: x\n` }] };
    }])) as ChantAgentJob["generate"],
  };
}


const input = { forge: "github" as const, binary: "tofu" as const, version: "1.13.1", image: "img:1", layers: [["net"], ["app/web"]], env: {}, drift: "0 6 * * *", respond: { drift: "off" as const }, agentDrift: agent };

describe("the drift job as a chant drift Op", () => {
  it("moves the drift job onto chant's Op, with chant's drift agent, when chant has the job", () => {
    const out = renderPipeline(input);
    expect(out.content).not.toContain("drift-agent-push:");
    expect(out.content).not.toMatch(/^ {2}drift:$/m);
    expect(out.content).not.toContain("cron: '0 6 * * *'");
    const paths = out.extra!.map((f) => f.path);
    expect(paths).toEqual(expect.arrayContaining([CHANT_DRIFT_SCRIPT_FILE, CHANT_DRIFT_SPEC_FILE, CHANT_DRIFT_PATHS.github, CHANT_DRIFT_OP_FILE]));
    const spec = JSON.parse(out.extra!.find((f) => f.path === CHANT_DRIFT_SPEC_FILE)!.content);
    expect(spec.ops[0]).toMatchObject({ name: CHANT_DRIFT_OP, trigger: { kind: "cron", schedule: "0 6 * * *" }, findingMode: "issue", agent: { on: "drift", maxCostUsd: 2, tokenEnv: "AGENT_FORGE_TOKEN" } });
    expect(spec.options.runCommand).toEqual(["bash", CHANT_DRIFT_SCRIPT_FILE]);
    const script = out.extra!.find((f) => f.path === CHANT_DRIFT_SCRIPT_FILE)!.content;
    expect(script).toContain("terragucci stage tf-drift");
    expect(script).toContain("rc=2");
    expect(script).toContain('echo "drift=true" >>"${GITHUB_OUTPUT:-/dev/null}"; rc=0');
  });

  it("moves the drift job on Forgejo with oidc too, whose job chant gives an OIDC token (chant issue 4753)", () => {
    const out = renderPipeline({ ...input, forge: "forgejo", oidc: { plan_role: "arn:aws:iam::123456789012:role/plan", apply_role: "arn:aws:iam::123456789012:role/apply", region: "us-east-1" } as never });
    expect(out.content).not.toContain("drift-agent-push:");
    expect(out.content).not.toMatch(/^ {2}drift:$/m);
    const workflow = out.extra!.find((f) => f.path === CHANT_DRIFT_PATHS.forgejo)!.content;
    expect(workflow).toContain("enable-openid-connect: true");
  });

  it("moves the drift job on GitLab, with the drift stage's id_tokens, a Terragrunt repo's cache and terragucci's schedule rule (chant issue 4753)", () => {
    const oidc = { plan_role: "arn:aws:iam::123456789012:role/plan", apply_role: "arn:aws:iam::123456789012:role/apply", region: "us-east-1", audience: { drift: "drift-aud" } };
    const out = renderPipeline({ ...plain, forge: "gitlab", oidc, resume: 10, terragrunt: { version: "0.99.0", parallelism: 4, exclude: [], installs: [] } } as never);
    expect(out.content).toContain(`include:\n  - local: ${CHANT_DRIFT_PATHS.gitlab}\n`);
    expect(out.content).not.toMatch(/^drift:$/m);
    const spec = specOf(out).ops[0];
    expect(spec.findingMode).toBe("report");
    expect(spec.permissions).toBeUndefined();
    expect(spec.gitlab).toEqual({
      idTokens: { CHANT_ID_TOKEN_AWS: { aud: "drift-aud" } },
      cache: [{ key: "terragucci-terragrunt", paths: [".terragrunt-cache/"] }],
      scheduleRule: '$CI_PIPELINE_SOURCE == "schedule" && $TERRAGUCCI_SCHEDULE != "comments" && $TERRAGUCCI_SCHEDULE != "resume" && $TERRAGUCCI_SCHEDULE != "rollouts" && $TERRAGUCCI_SCHEDULE != "ephemeral" && $TERRAGUCCI_SCHEDULE != "plan-notes" && $CHANT_PLAN_NOTES == null',
    });
    expect(specOf(out).options).toMatchObject({ opsStage: "drift", runCommand: ["bash", CHANT_DRIFT_SCRIPT_FILE] });
    expect(specOf(out).options.variables).toBeUndefined();
  });

  it("asks for pull request scopes with respond.drift: pull-request, and id-token with oidc", () => {
    const seen: { specs?: ChantScheduledOpSpec[] } = {};
    chantDriftFiles({ forge: "github", image: "img:1", schedule: "0 6 * * *", script: "true", workflowEnv: {}, jobEnv: {}, pullRequest: true, oidc: true, agent, artifacts: [], marker: MARKER }, fakeAgentJob(seen));
    expect(seen.specs![0]).toMatchObject({ findingMode: "pull-request", permissions: { issues: "write", "id-token": "write" } });
  });

  const plain = { forge: "github" as const, binary: "tofu" as const, version: "1.13.1", image: "img:1", layers: [["net"], ["app/web"]], env: {}, drift: "0 6 * * *", respond: { drift: "off" as const } };
  const specOf = (out: ReturnType<typeof renderPipeline>) => JSON.parse(out.extra!.find((f) => f.path === CHANT_DRIFT_SPEC_FILE)!.content);
  const scriptOf = (out: ReturnType<typeof renderPipeline>) => out.extra!.find((f) => f.path === CHANT_DRIFT_SCRIPT_FILE)!.content;

  it("moves the drift job without agent.drift too, keeping the drift report as an artifact and a green run on drift (chant issue 4622)", () => {
    const out = renderPipeline(plain);
    expect(out.content).not.toMatch(/^ {2}drift:$/m);
    expect(out.content).not.toContain("cron: '0 6 * * *'");
    expect(out.content).not.toContain("Keep the drift report");
    const spec = specOf(out);
    expect(spec.ops[0].agent).toBeUndefined();
    expect(spec.ops[0].artifacts).toEqual([{ name: "terragucci-report-drift", paths: ["terragucci-report/"] }]);
    expect(scriptOf(out)).toContain("terragucci stage tf-drift");
    expect(scriptOf(out)).not.toContain("rc=2");
  });

  it("keeps respond.drift: agent's input as a second artifact, and installs attribution's AWS CLI in the script", () => {
    const agentOut = renderPipeline({ ...plain, respond: { drift: "agent" as const } });
    expect(specOf(agentOut).ops[0].artifacts).toEqual([
      { name: "terragucci-report-drift", paths: ["terragucci-report/"] },
      { name: "terragucci-respond-drift", paths: ["terragucci-respond/"] },
    ]);
    const attribute = renderPipeline({ ...plain, respond: { drift: "attribute" as const } });
    expect(attribute.content).not.toMatch(/^ {2}drift:$/m);
    expect(scriptOf(attribute)).toMatch(/awscli/i);
  });

  it("runs a Terragrunt repo's drift on the Op with its cache as a setup step, and writes no TerraformWatchOp file for units", () => {
    const out = renderPipeline({ ...plain, terragrunt: { version: "0.99.0", parallelism: 4, exclude: [], installs: [] } });
    expect(out.content).not.toMatch(/^ {2}drift:$/m);
    const setup = specOf(out).ops[0].setup;
    expect(setup).toHaveLength(1);
    expect(setup[0].uses).toMatch(/^actions\/cache@/);
    expect(out.extra!.some((f) => f.path === CHANT_DRIFT_OP_FILE)).toBe(false);
  });

  it("names one TerraformWatchOp per root, and records the agent's runs under the drift Op", () => {
    expect(rootDriftOpName("app/web")).toBe("terragucci-drift-app-web");
    expect(chantDriftOpFile(["net", "app/web"], MARKER)).toContain('TerraformWatchOp({ name: "terragucci-drift-app-web", root: "app/web" })');
    expect(AGENT_RUN_LEDGERS["local/runs__terragucci-drift.jsonl"]).toBe("agent.drift");
    expect(driftScript("tofu", [["net"]], "github", undefined, {}, undefined, false, "chant")).toContain('exit "$rc"');
  });
});

// terragucci#1528: Forgejo's runner publishes a job's outputs only when the job succeeds, so the drift job succeeds on drift and the drift-found job keeps the run red.
describe("the drift agent's jobs read the drift job's outputs from a job that succeeded", () => {
  const plain = { ...input, agentDrift: undefined };
  const scriptOf = (out: ReturnType<typeof renderPipeline>) => out.extra!.find((f) => f.path === CHANT_DRIFT_SCRIPT_FILE)!.content;
  type Job = { needs?: string; if?: string; "runs-on"?: unknown; outputs?: Record<string, string>; steps?: { id?: string; run?: string }[] };
  const workflowOf = (forge: "github" | "forgejo", withAgent = true) => {
    const out = renderPipeline(withAgent ? { ...input, forge } : { ...plain, forge });
    return { out, wf: parseYAML(out.extra!.find((f) => f.path === CHANT_DRIFT_PATHS[forge])!.content) as { jobs: Record<string, Job> } };
  };

  it.each(["github", "forgejo"] as const)("%s: the agent job runs on the drift job's drift output, and the drift-found job after it fails the run on drift", (forge) => {
    const { out, wf } = workflowOf(forge);
    const drift = wf.jobs[CHANT_DRIFT_OP]!;
    expect(drift.outputs!.drift).toBe("${{ steps.chant-run.outputs.drift }}");
    expect(wf.jobs[`${CHANT_DRIFT_OP}-agent`]).toMatchObject({ needs: CHANT_DRIFT_OP, if: `always() && needs.${CHANT_DRIFT_OP}.outputs.drift == 'true'` });
    const found = wf.jobs[CHANT_DRIFT_FOUND_JOB]!;
    expect(found).toMatchObject({ needs: CHANT_DRIFT_OP, if: `needs.${CHANT_DRIFT_OP}.outputs.drift == 'true'`, "runs-on": drift["runs-on"] });
    expect(found.steps).toHaveLength(1);
    expect(found.steps![0]!.run).toMatch(/\nexit 2$/);
    // The drift step runs the script inside chant's run step, whose GITHUB_OUTPUT is the step's, so the script's drift=true is the job's drift output.
    expect(drift.steps!.find((s) => s.id === "chant-run")!.run).toContain(`bash ${CHANT_DRIFT_SCRIPT_FILE}`);
    expect(scriptOf(out)).toContain('echo "drift=true" >>"${GITHUB_OUTPUT:-/dev/null}"; rc=0');
  });

  it("without agent.drift the workflow has no drift-found job and the script writes no output", () => {
    const { out, wf } = workflowOf("forgejo", false);
    expect(Object.keys(wf.jobs)).toEqual([CHANT_DRIFT_OP]);
    expect(scriptOf(out)).not.toContain("GITHUB_OUTPUT");
  });

  it("the script exits 0 with drift=true on drift, and keeps any other code with no output", () => {
    const script = driftScript("tofu", [["app"]], "forgejo", undefined, {}, undefined, false, "chant");
    const lines = script.split("\n");
    const tail = lines.slice(lines.findIndex((l) => l.includes('drift=true')));
    expect(tail).toEqual(['if [ "$rc" -eq 2 ]; then echo "drift=true" >>"${GITHUB_OUTPUT:-/dev/null}"; rc=0; fi', 'exit "$rc"']);
    const run = (rc: number): { code: number; output: string } => {
      const output = join(mkdtempSync(join(tmpdir(), "tg-1528-")), "out");
      let code = 0;
      try {
        execFileSync("bash", ["-c", `rc=${rc}\n${tail.join("\n")}`], { env: { ...process.env, GITHUB_OUTPUT: output } });
      } catch (e) {
        code = (e as { status: number }).status;
      }
      let text = "";
      try { text = readFileSync(output, "utf-8"); } catch { /* no output */ }
      return { code, output: text };
    };
    expect(run(2)).toEqual({ code: 0, output: "drift=true\n" });
    expect(run(1)).toEqual({ code: 1, output: "" });
    expect(run(0)).toEqual({ code: 0, output: "" });
  });

  it("adds the drift-found job only to a workflow whose jobs key is last and whose drift job names its runner", () => {
    const yaml = `name: x\njobs:\n  ${CHANT_DRIFT_OP}:\n    runs-on:\n      - self-hosted\n      - linux\n    steps: []\n  other:\n    runs-on: y\n`;
    expect(chantDriftFoundJob(yaml)).toContain("    runs-on:\n      - self-hosted\n      - linux\n    steps:");
    expect(chantDriftFoundJob(`jobs:\n  ${CHANT_DRIFT_OP}:\n    steps: []\n`)).toBeUndefined();
    expect(chantDriftFoundJob(`jobs:\n  ${CHANT_DRIFT_OP}:\n    runs-on: x\nenv: {}\n`)).toBeUndefined();
    expect(chantDriftFoundJob(`jobs:\n  other:\n    runs-on: x\n`)).toBeUndefined();
    const fake: ChantAgentJob = { ...fakeAgentJob(), generate: Object.fromEntries(["github", "gitlab", "forgejo"].map((f) => [f, () => ({ files: [{ name: "x.yml", yaml: "jobs: {}\n" }] })])) as unknown as ChantAgentJob["generate"] };
    expect(() => chantDriftFiles({ forge: "github", image: "img:1", schedule: "0 6 * * *", script: "true", workflowEnv: {}, jobEnv: {}, pullRequest: false, oidc: false, agent, artifacts: [], marker: MARKER }, fake)).toThrow(/cannot add terragucci-drift-found/);
  });
});
