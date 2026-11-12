// oidc.audience as a map gives each stage's jobs their own AWS token audience: plan for the jobs that plan a
// change, apply for the jobs that apply (confirm among them), drift for drift. On GitLab each job's id_tokens
// declares its stage's audience alone. On GitHub and Forgejo a step that takes credentials logs in first with
// chant's login and restarts without the token-request variables, so nothing it runs can ask for another audience.
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LOGIN_RESTART_MARKER, LOGIN_SPEC_ENV } from "@intentius/chant/ci-login";
import { parseYAML } from "@intentius/chant/yaml";
import { ConfigError, validateConfig } from "../src/config";
import { configSchemaProblems } from "../src/config-schema";
import { cloudLoginLines, OIDC_REQUEST_VARS, renderPipeline, stageAudience, type PipelineInput } from "../src/render";

const PLAN = "arn:aws:iam::111111111111:role/plan-ro";
const APPLY = "arn:aws:iam::111111111111:role/apply-rw";
const AUD = { plan: "terragucci-plan", apply: "terragucci-apply", drift: "terragucci-drift" };
const MAP = { plan_role: PLAN, apply_role: APPLY, audience: AUD };
const layers = [["network"], ["app", "cache"]];

const body = (text: string): Record<string, any> => parseYAML(text.split("\n").filter((l) => !l.startsWith("#")).join("\n")) as Record<string, any>;
const input = (forge: PipelineInput["forge"], oidc: PipelineInput["oidc"], extra: Partial<PipelineInput> = {}): PipelineInput =>
  ({ forge, binary: "tofu", version: "1.13.1", image: "img:1", layers, env: {}, oidc, drift: "0 6 * * *", ...extra }) as PipelineInput;
/** The pipeline and its extra files as one text. */
const render = (forge: PipelineInput["forge"], oidc: PipelineInput["oidc"], extra: Partial<PipelineInput> = {}): string => {
  const r = renderPipeline(input(forge, oidc, extra));
  return [r.content, ...(r.extra ?? []).map((e) => e.content)].join("\n");
};
/** The pipeline and its extra files, each parsed on its own, with their jobs (GitHub, Forgejo) or entries (GitLab) in one document. */
const rendered = (forge: PipelineInput["forge"], oidc: PipelineInput["oidc"], extra: Partial<PipelineInput> = {}): Record<string, any> => {
  const r = renderPipeline(input(forge, oidc, extra));
  // The workflow files only: the drift Op's script (.chant/ops/terragucci-drift.sh) and spec are not YAML jobs.
  const docs = [r.content, ...(r.extra ?? []).filter((e) => /\.ya?ml$/.test(e.path)).map((e) => e.content)].map(body);
  if (forge === "gitlab") return Object.assign({}, ...docs);
  return { ...docs[0], jobs: Object.assign({}, ...docs.map((d) => d.jobs ?? {})) };
};

/** The AWS audiences and roles chant's login specs in `text` name. */
function logins(text: string): { audience?: string; role?: string }[] {
  return [...text.matchAll(new RegExp(`export ${LOGIN_SPEC_ENV}='([^']*)'`, "g"))].map((m) => (JSON.parse(m[1]!) as { aws?: { audience?: string; role?: string } }).aws ?? {});
}

/** Every problem config.ts finds in `oidc`, or none. */
function problems(oidc: unknown): string[] {
  try {
    validateConfig({ oidc }, "terragucci.yml");
    return [];
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    return e.problems ?? [e.message];
  }
}

describe("oidc.audience as a map: config", () => {
  it("takes plan, apply and drift, any of them, and the schema agrees", () => {
    for (const audience of [AUD, { apply: "a" }, { plan: "p", drift: "d" }, "sts.amazonaws.com"]) {
      const oidc = { plan_role: PLAN, apply_role: APPLY, audience };
      expect(problems(oidc), JSON.stringify(audience)).toEqual([]);
      expect(configSchemaProblems({ oidc } as never), JSON.stringify(audience)).toEqual([]);
    }
  });

  it("refuses an unknown key and an empty audience, naming the key", () => {
    expect(problems({ plan_role: PLAN, apply_role: APPLY, audience: { plan: "p", deploy: "d" } })).toEqual([expect.stringContaining("oidc.audience.deploy is not a stage")]);
    expect(problems({ plan_role: PLAN, apply_role: APPLY, audience: { apply: "" } })).toEqual([expect.stringContaining("oidc.audience.apply must be a non-empty audience")]);
    expect(problems({ plan_role: PLAN, apply_role: APPLY, audience: { drift: 7 } })).toEqual([expect.stringContaining("oidc.audience.drift must be a non-empty audience")]);
    expect(problems({ plan_role: PLAN, apply_role: APPLY, audience: ["a"] })).toEqual([expect.stringContaining("oidc.audience must be a string")]);
    expect(configSchemaProblems({ oidc: { plan_role: PLAN, apply_role: APPLY, audience: { deploy: "d" } } } as never)).not.toEqual([]);
    expect(configSchemaProblems({ oidc: { plan_role: PLAN, apply_role: APPLY, audience: { apply: "" } } } as never)).not.toEqual([]);
  });

  it("a stage the map leaves out keeps sts.amazonaws.com", () => {
    const oidc = { plan_role: PLAN, apply_role: APPLY, audience: { apply: "a" } };
    expect(stageAudience(oidc, "apply")).toBe("a");
    expect(stageAudience(oidc, "plan")).toBe("sts.amazonaws.com");
    expect(stageAudience(oidc, "drift")).toBe("sts.amazonaws.com");
    expect(stageAudience({ ...oidc, audience: "one" }, "drift")).toBe("one");
    expect(stageAudience(undefined, "plan")).toBe("sts.amazonaws.com");
  });
});

describe("oidc.audience as a map: GitLab", () => {
  it("each job's id_tokens declares its stage's audience alone", () => {
    const doc = rendered("gitlab", MAP, { ephemeral: { roots: ["app"] } as never });
    const aud = (job: string): unknown => doc[job].id_tokens;
    expect(aud("plan")).toEqual({ CHANT_ID_TOKEN_AWS: { aud: AUD.plan } });
    for (const j of ["apply-wave-1", "apply-wave-2", "ephemeral", "ephemeral-sweep"]) expect(aud(j), j).toEqual({ CHANT_ID_TOKEN_AWS: { aud: AUD.apply } });
    // The drift job is chant's Op (terragucci#1305), with the drift stage's id_token (chant issue 4753).
    expect(aud("terragucci-drift")).toEqual({ CHANT_ID_TOKEN_AWS: { aud: AUD.drift } });
    expect(doc.check.id_tokens).toBeUndefined();
    // GitLab's jobs read their token from id_tokens; none asks the forge for one or restarts.
    expect(JSON.stringify(doc)).not.toContain(LOGIN_RESTART_MARKER);
  });

  it("confirm and the waves before merge, chant's plan and applying jobs, declare the apply audience", () => {
    const doc = rendered("gitlab", MAP, { applyWhen: "pull-request", applyMerge: "manual", comments: "*/5 * * * *", applyMergeTokenEnv: "MERGE_TOKEN" } as never);
    for (const j of ["confirm", "apply-wave-1-plan", "apply-wave-1", "apply-wave-2-plan", "apply-wave-2"]) expect(doc[j].id_tokens, j).toEqual({ CHANT_ID_TOKEN_AWS: { aud: AUD.apply } });
    expect(doc.plan.id_tokens).toEqual({ CHANT_ID_TOKEN_AWS: { aud: AUD.plan } });
  });
});

describe.each(["github", "forgejo"] as const)("oidc.audience as a map: %s", (forge) => {
  type Step = { name?: string; run?: string; uses?: string };
  const runs = (doc: Record<string, any>, job: string): string[] => (doc.jobs[job].steps as Step[]).map((s) => s.run ?? "").filter((r) => r.includes(LOGIN_SPEC_ENV));

  it("each job's step logs in for its stage's audience, and restarts without the token-request variables", () => {
    const doc = rendered(forge, MAP, { ephemeral: { roots: ["app"] } as never });
    // The plan and re-plan jobs are chant's product plan, which trades the plan audience's token before the checkout (terragucci issue 1411).
    for (const job of ["plan", "replan"]) {
      const trade = (doc.jobs[job].steps as (Step & { env?: Record<string, string> })[]).find((s) => s.name === "Trade the job's OIDC token for the plan identities")!;
      expect(JSON.parse(trade.env!.CHANT_CLOUD_TRADE!).aws.audience, job).toBe(AUD.plan);
      expect(runs(doc, job), job).toEqual([]);
    }
    // chant's wave jobs trade the apply audience's token for the apply role before the checkout, and the apply drops the
    // token-request variables. The comment job applies nothing and takes no token.
    for (const job of ["apply-wave-1", "apply-wave-2"]) {
      const steps = doc.jobs[job].steps as (Step & { env?: Record<string, string> })[];
      const trade = steps.find((s) => s.name === "Trade the job's OIDC token for its cloud identities")!;
      expect(JSON.parse(trade.env!.CHANT_CLOUD_TRADE!).aws, job).toMatchObject({ audience: AUD.apply, role: APPLY });
      expect(steps.map((s) => s.run ?? "").join("\n"), job).toContain("unset ACTIONS_ID_TOKEN_REQUEST_TOKEN ACTIONS_ID_TOKEN_REQUEST_URL");
      expect(runs(doc, job), job).toEqual([]);
    }
    expect(doc.jobs["apply-comment"].permissions?.["id-token"]).toBeUndefined();
    expect(doc.jobs["apply-comment"]["enable-openid-connect"]).toBeUndefined();
    const want: Record<string, string> = { ephemeral: AUD.apply, drift: AUD.drift };
    // The drift job is chant's Op (terragucci#1305): its login is in the script the Op's step runs.
    const driftScript = renderPipeline(input(forge, MAP, { ephemeral: { roots: ["app"] } as never })).extra!.find((e) => e.path === ".chant/ops/terragucci-drift.sh")!.content;
    for (const [job, aud] of Object.entries(want)) {
      const steps = job === "drift" ? [driftScript] : runs(doc, job);
      expect(steps.length, job).toBeGreaterThan(0);
      for (const run of steps) {
        expect(logins(run).map((l) => l.audience), job).toEqual([aud]);
        const restart = run.split("\n").findIndex((l) => l.includes("exec env") && l.includes(`${LOGIN_RESTART_MARKER}=1`));
        expect(restart, job).toBeGreaterThan(0);
        for (const v of OIDC_REQUEST_VARS) expect(run.split("\n")[restart], job).toContain(`-u ${v}`);
        // Past the restart, nothing logs in again.
        expect(run.split("\n").slice(restart + 1).join("\n"), job).not.toContain(LOGIN_SPEC_ENV);
      }
    }
    // The plan job assumes the plan role, as before.
    expect(JSON.stringify(doc.jobs.plan)).not.toContain(APPLY);
  });

  it("confirm, the resume and the sweep take the apply audience", () => {
    const pr = rendered(forge, MAP, { applyWhen: "pull-request", applyMerge: "manual" } as never);
    expect(logins(runs(pr, "confirm").join("\n")).map((l) => [l.audience, l.role])).toEqual([[AUD.apply, PLAN]]);
    const r = renderPipeline(input(forge, MAP, { resume: 15, ephemeral: { roots: ["app"] } as never }));
    // The resume and the sweep workflows; the drift Op's files, which take the drift audience, are tested above.
    const extra = (r.extra ?? []).filter((e) => !e.path.includes("terragucci-drift")).map((e) => e.content).join("\n");
    expect(logins(extra).length).toBeGreaterThan(0);
    expect(logins(extra).every((l) => l.audience === AUD.apply)).toBe(true);
    expect(extra).toContain(`${LOGIN_RESTART_MARKER}=1`);
  });

  it("the re-plan's plan step, which reads traded credentials, logs in nowhere", () => {
    const doc = rendered(forge, MAP);
    const plan = (doc.jobs.replan.steps as Step[]).find((s) => s.run?.includes("terragucci stage tf-plan"))!.run!;
    expect(plan).not.toContain(LOGIN_SPEC_ENV);
  });

  it("the restarted step holds the stage's token and no token-request variable", async () => {
    const api = await tokenApi();
    try {
      const dir = mkdtempSync(join(tmpdir(), "terragucci-aud-"));
      const file = join(dir, "step.sh");
      writeFileSync(file, [
        ...cloudLoginLines(forge, MAP, "apply", "terragucci-apply"),
        "echo began",
        'echo "token=$(cat "$AWS_WEB_IDENTITY_TOKEN_FILE")"',
        'echo "role=$AWS_ROLE_ARN"',
        "env | grep '^ACTIONS_ID_TOKEN_REQUEST' || echo 'no request variables'",
        "bash -c \"env | grep '^ACTIONS_ID_TOKEN_REQUEST' || echo 'none in a child'\"",
      ].join("\n"));
      const r = await step(file, { ACTIONS_ID_TOKEN_REQUEST_URL: `${api.url}/token?api-version=2.0`, ACTIONS_ID_TOKEN_REQUEST_TOKEN: "req", RUNNER_TEMP: dir });
      expect(r.status, r.out).toBe(0);
      expect(r.out.match(/^began$/gm)).toHaveLength(1);
      expect(r.out).toContain(`token=jwt-for-${AUD.apply}`);
      expect(r.out).toContain(`role=${APPLY}`);
      expect(r.out).toContain("no request variables");
      expect(r.out).toContain("none in a child");
      expect(api.audiences).toEqual([AUD.apply]);
    } finally {
      api.close();
    }
  });

  it("a runner that serves no token stops the step before anything else runs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "terragucci-aud-"));
    const file = join(dir, "step.sh");
    writeFileSync(file, [...cloudLoginLines(forge, MAP, "plan", "terragucci-plan"), "echo planned"].join("\n"));
    const r = await step(file, { ACTIONS_ID_TOKEN_REQUEST_URL: "", RUNNER_TEMP: dir });
    expect(r.status).not.toBe(0);
    expect(r.out).not.toContain("planned");
  });
});

describe.each(["github", "gitlab", "forgejo"] as const)("one audience: %s", (forge) => {
  it("a string or no audience logs in with one audience everywhere", () => {
    for (const oidc of [{ plan_role: PLAN, apply_role: APPLY }, { plan_role: PLAN, apply_role: APPLY, audience: "custom.example" }]) {
      const text = render(forge, oidc);
      const aud = oidc.audience ?? "sts.amazonaws.com";
      if (forge === "gitlab") expect([...text.matchAll(/^\s+aud: (.*)$/gm)].map((m) => m[1]).every((a) => a === aud)).toBe(true);
      const asked = logins(text).map((l) => l.audience);
      expect(asked.length).toBeGreaterThan(0);
      expect(asked.every((a) => a === aud)).toBe(true);
      // GitHub and Forgejo restart past the login whatever the audience; GitLab's script is no file to restart.
      if (forge === "gitlab") expect(text).not.toContain(LOGIN_RESTART_MARKER);
      else expect(text).toContain(`${LOGIN_RESTART_MARKER}=1`);
    }
  });
});

/** A stand-in token endpoint: answers each request with a token naming its audience, and records the audiences. */
async function tokenApi(): Promise<{ url: string; audiences: string[]; close: () => void }> {
  const audiences: string[] = [];
  const server = createServer((req, res) => {
    const aud = new URL(req.url!, "http://x").searchParams.get("audience") ?? "";
    audiences.push(aud);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ value: `jwt-for-${aud}` }));
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, audiences, close: () => server.close() };
}

/** Runs a step's script file as a `shell: bash` step does: `bash --noprofile --norc -e -o pipefail <file>`. */
function step(file: string, env: Record<string, string>): Promise<{ status: number | null; out: string }> {
  return new Promise((ok) => {
    const p = spawn("bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", file], { env: { ...process.env, ...env } });
    let out = "";
    p.stdout.on("data", (c) => (out += c));
    p.stderr.on("data", (c) => (out += c));
    p.on("close", (status) => ok({ status, out }));
  });
}
