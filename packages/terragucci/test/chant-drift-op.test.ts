// terragucci#1305 and chant issue 4622: every scheduled drift job is a chant drift Op; with agent.drift it rides chant's agent job (chant#4616).
import { afterEach, describe, expect, it } from "vitest";
import { agentDriftInput } from "../src/agent-comment";
import { overrideChantNext, type ChantAgentJob, type ChantScheduledOpSpec } from "../src/chant-next";
import { validateConfig } from "../src/config";
import { AGENT_RUN_LEDGERS } from "../src/report/audit";
import { CHANT_DRIFT_OP, CHANT_DRIFT_OP_FILE, CHANT_DRIFT_PATHS, CHANT_DRIFT_SCRIPT_FILE, CHANT_DRIFT_SPEC_FILE, chantDriftFiles, chantDriftOpFile, rootDriftOpName } from "../src/render-chant-drift";
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
      return { files: [{ name: `${ops[0]!.name}.yml`, yaml: `# ${f} drift op\n` }] };
    }])) as ChantAgentJob["generate"],
  };
}

let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
});

const input = { forge: "github" as const, binary: "tofu" as const, version: "1.13.1", image: "img:1", layers: [["net"], ["app/web"]], env: {}, drift: "0 6 * * *", respond: { drift: "off" as const }, agentDrift: agent };

describe("the drift job as a chant drift Op", () => {
  it("moves the drift job onto chant's Op, with chant's drift agent, when chant has the job", () => {
    restore = overrideChantNext("agentJob", fakeAgentJob());
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
    expect(script).not.toContain("GITHUB_OUTPUT");
  });

  it("keeps terragucci's job on Forgejo with oidc, which chant's Op cannot ask a token for", () => {
    restore = overrideChantNext("agentJob", fakeAgentJob());
    const out = renderPipeline({ ...input, forge: "forgejo", oidc: { role_arn: "arn:aws:iam::123456789012:role/plan", region: "us-east-1" } as never });
    expect(out.content).toContain("drift-agent-push:");
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
    restore = overrideChantNext("agentJob", fakeAgentJob());
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
    restore = overrideChantNext("agentJob", fakeAgentJob());
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
    restore = overrideChantNext("agentJob", fakeAgentJob());
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
