// oidc.audience as a map gives each stage's jobs their own AWS token audience: plan for the jobs that plan a
// change, apply for the jobs that apply (confirm among them), drift for drift. On GitLab each job's id_tokens
// declares its stage's audience alone. On GitHub and Forgejo a step that takes credentials asks for its tokens
// first and restarts without the token-request variables, so nothing it runs can ask for another audience.
// A string, or no audience, renders what it always did.
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import { ConfigError, validateConfig } from "../src/config";
import { configSchemaProblems } from "../src/config-schema";
import { cloudScripts, OIDC_REQUEST_VARS, renderPipeline, stageAudience, stageTokens, type PipelineInput } from "../src/render";

const PLAN = "arn:aws:iam::111111111111:role/plan-ro";
const APPLY = "arn:aws:iam::111111111111:role/apply-rw";
const AUD = { plan: "terragucci-plan", apply: "terragucci-apply", drift: "terragucci-drift" };
const MAP = { plan_role: PLAN, apply_role: APPLY, audience: AUD };
const layers = [["network"], ["app", "cache"]];

const body = (text: string): Record<string, any> => parseYAML(text.split("\n").filter((l) => !l.startsWith("#")).join("\n")) as Record<string, any>;
const input = (forge: PipelineInput["forge"], oidc: PipelineInput["oidc"], extra: Partial<PipelineInput> = {}): PipelineInput =>
  ({ forge, binary: "tofu", version: "1.13.1", image: "img:1", layers, env: {}, oidc, drift: "0 6 * * *", ...extra }) as PipelineInput;
const render = (forge: PipelineInput["forge"], oidc: PipelineInput["oidc"], extra: Partial<PipelineInput> = {}): string => {
  const r = renderPipeline(input(forge, oidc, extra));
  return [r.content, ...(r.extra ?? []).map((e) => e.content)].join("\n");
};

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
    const doc = body(render("gitlab", MAP, { ephemeral: { roots: ["app"] } as never }));
    const aud = (job: string): unknown => doc[job].id_tokens;
    expect(aud("plan")).toEqual({ TERRAGUCCI_OIDC: { aud: AUD.plan } });
    for (const j of ["apply-wave-1", "apply-wave-2", "ephemeral", "ephemeral-sweep"]) expect(aud(j), j).toEqual({ TERRAGUCCI_OIDC: { aud: AUD.apply } });
    expect(aud("drift")).toEqual({ TERRAGUCCI_OIDC: { aud: AUD.drift } });
    expect(doc.check.id_tokens).toBeUndefined();
    // GitLab's jobs read their token from id_tokens; none asks the forge for one or restarts.
    expect(JSON.stringify(doc)).not.toMatch(/tg oidc|TG_NO_OIDC_REQUEST/);
  });

  it("confirm and mr-apply, apply jobs, declare the apply audience", () => {
    const doc = body(render("gitlab", MAP, { applyWhen: "pull-request", applyMerge: "manual", comments: "*/5 * * * *", applyMergeTokenEnv: "MERGE_TOKEN" } as never));
    for (const j of ["confirm", "mr-apply"]) expect(doc[j].id_tokens, j).toEqual({ TERRAGUCCI_OIDC: { aud: AUD.apply } });
    expect(doc.plan.id_tokens).toEqual({ TERRAGUCCI_OIDC: { aud: AUD.plan } });
  });
});

describe.each(["github", "forgejo"] as const)("oidc.audience as a map: %s", (forge) => {
  type Step = { name?: string; run?: string; uses?: string };
  const runs = (doc: Record<string, any>, job: string): string[] => (doc.jobs[job].steps as Step[]).map((s) => s.run ?? "").filter((r) => r.includes("TG_NO_OIDC_REQUEST"));

  it("each job's step asks for its stage's audience, first, and restarts without the token-request variables", () => {
    const doc = body(render(forge, MAP, { ephemeral: { roots: ["app"] } as never }));
    const want: Record<string, string> = { plan: AUD.plan, replan: AUD.plan, "apply-wave-1": AUD.apply, "apply-wave-2": AUD.apply, "apply-comment": AUD.apply, ephemeral: AUD.apply, drift: AUD.drift };
    for (const [job, aud] of Object.entries(want)) {
      const steps = runs(doc, job);
      expect(steps.length, job).toBeGreaterThan(0);
      for (const run of steps) {
        const asks = [...run.matchAll(/tg oidc "\$TERRAGUCCI_OIDC_FILE" '([^']*)'/g)].map((m) => m[1]);
        expect(asks, job).toEqual([aud]);
        const restart = run.split("\n").findIndex((l) => l.includes("exec env") && l.includes("TG_NO_OIDC_REQUEST=1"));
        expect(restart, job).toBeGreaterThan(0);
        for (const v of OIDC_REQUEST_VARS) expect(run.split("\n")[restart], job).toContain(`-u ${v}`);
        // Past the restart, nothing asks for a token or reads the request variables.
        const rest = run.split("\n").slice(restart + 1).join("\n");
        expect(rest, job).not.toMatch(/tg oidc |ACTIONS_ID_TOKEN_REQUEST_URL:-/);
        expect(rest, job).toContain('mv -f "$TERRAGUCCI_OIDC_FILE" "$AWS_WEB_IDENTITY_TOKEN_FILE"');
      }
    }
    // The plan job assumes the plan role, the apply jobs the apply role, as before.
    expect(runs(doc, "plan").join("\n")).not.toContain(APPLY);
    expect(runs(doc, "apply-wave-1").join("\n")).toContain(APPLY);
  });

  it("confirm, the resume and the sweep take the apply audience", () => {
    const pr = body(render(forge, MAP, { applyWhen: "pull-request", applyMerge: "manual" } as never));
    expect(runs(pr, "confirm").join("\n")).toContain(`tg oidc "$TERRAGUCCI_OIDC_FILE" '${AUD.apply}'`);
    expect(runs(pr, "confirm").join("\n")).toContain(PLAN);
    const r = renderPipeline(input(forge, MAP, { resume: 15, ephemeral: { roots: ["app"] } as never }));
    const extra = (r.extra ?? []).map((e) => e.content).join("\n");
    expect(extra.match(/tg oidc "\$TERRAGUCCI_OIDC_FILE" '([^']*)'/g)?.every((l) => l.includes(AUD.apply))).toBe(true);
    expect(extra).toContain("TG_NO_OIDC_REQUEST=1");
  });

  it("the re-plan's plan step, which reads traded credentials, asks for no token", () => {
    const doc = body(render(forge, MAP));
    const plan = (doc.jobs.replan.steps as Step[]).find((s) => s.run?.includes("terragucci stage tf-plan"))!.run!;
    expect(plan).not.toMatch(/tg oidc|TERRAGUCCI_OIDC_FILE/);
  });

  it("the restarted step holds the stage's token and no token-request variable, and a copy of the token nowhere else", async () => {
    const api = await tokenApi();
    try {
      const dir = mkdtempSync(join(tmpdir(), "terragucci-aud-"));
      const file = join(dir, "step.sh");
      writeFileSync(file, [
        ...stageTokens(forge, MAP, "apply"),
        "echo began",
        ...cloudScripts(forge, MAP, "apply", "terragucci-apply"),
        'echo "token=$(cat "$AWS_WEB_IDENTITY_TOKEN_FILE")"',
        'echo "role=$AWS_ROLE_ARN"',
        "env | grep '^ACTIONS_ID_TOKEN_REQUEST' || echo 'no request variables'",
        "bash -c \"env | grep '^ACTIONS_ID_TOKEN_REQUEST' || echo 'none in a child'\"",
        '[ -e "$TERRAGUCCI_OIDC_FILE" ] && echo "fetched file kept" || echo "fetched file moved"',
      ].join("\n"));
      const r = await step(file, { ACTIONS_ID_TOKEN_REQUEST_URL: `${api.url}/token?api-version=2.0`, ACTIONS_ID_TOKEN_REQUEST_TOKEN: "req" });
      expect(r.status, r.out).toBe(0);
      expect(r.out.match(/^began$/gm)).toHaveLength(1);
      expect(r.out).toContain(`token=jwt-for-${AUD.apply}`);
      expect(r.out).toContain(`role=${APPLY}`);
      expect(r.out).toContain("no request variables");
      expect(r.out).toContain("none in a child");
      expect(r.out).toContain("fetched file moved");
      expect(api.audiences).toEqual([AUD.apply]);
    } finally {
      api.close();
    }
  });

  it("a runner that serves no token stops the step before anything else runs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "terragucci-aud-"));
    const file = join(dir, "step.sh");
    writeFileSync(file, [...stageTokens(forge, MAP, "plan"), "echo planned"].join("\n"));
    const r = await step(file, { ACTIONS_ID_TOKEN_REQUEST_URL: "" });
    expect(r.status).toBe(1);
    expect(r.out).not.toContain("planned");
  });
});

describe("opt in", () => {
  it.each(["github", "forgejo", "gitlab"] as const)("%s: a string or no audience renders no stage tokens and one audience everywhere", (forge) => {
    for (const oidc of [{ plan_role: PLAN, apply_role: APPLY }, { plan_role: PLAN, apply_role: APPLY, audience: "custom.example" }]) {
      const text = render(forge, oidc);
      expect(text).not.toMatch(/TG_NO_OIDC_REQUEST|TERRAGUCCI_OIDC_FILE/);
      expect(stageTokens(forge, oidc, "apply")).toEqual([]);
      const aud = oidc.audience ?? "sts.amazonaws.com";
      if (forge === "gitlab") expect([...text.matchAll(/aud: (.*)/g)].map((m) => m[1]).every((a) => a === aud)).toBe(true);
      else expect([...text.matchAll(/tg oidc "\$AWS_WEB_IDENTITY_TOKEN_FILE" '([^']*)'/g)].map((m) => m[1]).every((a) => a === aud)).toBe(true);
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
