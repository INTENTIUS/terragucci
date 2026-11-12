import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import { ConfigError, pipelineEvidence, validateConfig } from "../src/config";
import { configSchemaProblems } from "../src/config-schema";
import { init } from "../src/init";
import { renderPipeline, type PipelineInput } from "../src/render";
import { signingWorkflow, TRUST_FILE } from "../src/trust";
import { git, twoRootRepo, write } from "./helpers";

const PLAN = "arn:aws:iam::111111111111:role/plan-ro";
const APPLY = "arn:aws:iam::111111111111:role/apply-rw";
const OIDC = { plan_role: PLAN, apply_role: APPLY };
const layers = [["network"], ["app"]];

const body = (text: string): Record<string, any> => parseYAML(text.split("\n").filter((l) => !l.startsWith("#")).join("\n")) as Record<string, any>;
const input = (forge: PipelineInput["forge"], extra: Partial<PipelineInput> = {}): PipelineInput =>
  ({ forge, binary: "tofu", version: "1.13.1", image: "img:1", layers, env: {}, ...extra }) as PipelineInput;
/** The pipeline's jobs (GitHub, Forgejo) or entries (GitLab). */
const jobsOf = (forge: PipelineInput["forge"], extra: Partial<PipelineInput> = {}): Record<string, any> => {
  const doc = body(renderPipeline(input(forge, extra)).content);
  return forge === "gitlab" ? doc : doc.jobs;
};

const problems = (raw: unknown): string[] => {
  try {
    validateConfig(raw, "terragucci.yml");
    return [];
  } catch (e) {
    return (e as ConfigError).problems ?? [(e as Error).message];
  }
};

describe("evidence: config", () => {
  it("takes identity oidc with an audience, or a runner key's secret, and the schema agrees", () => {
    for (const evidence of [{ identity: "oidc" }, { identity: "oidc", audience: "sigstore", local: true }, { runner_key_secret: "RUNNER_KEY" }]) {
      expect(problems({ evidence }), JSON.stringify(evidence)).toEqual([]);
      expect(configSchemaProblems({ evidence } as never), JSON.stringify(evidence)).toEqual([]);
    }
    expect(pipelineEvidence({ identity: "oidc", audience: "a" })).toEqual({ identity: "oidc", audience: "a" });
    expect(pipelineEvidence({ runner_key_secret: "K" })).toEqual({ runnerKeySecret: "K" });
    expect(pipelineEvidence(undefined)).toBeUndefined();
  });

  it("refuses both identities, neither, an unknown key and a bad secret name", () => {
    expect(problems({ evidence: { identity: "oidc", runner_key_secret: "K" } })).toEqual([expect.stringContaining("sets identity and runner_key_secret")]);
    expect(problems({ evidence: { local: true } })).toEqual([expect.stringContaining("sets neither identity nor runner_key_secret")]);
    expect(problems({ evidence: { identity: "oidc", key: 1 } })).toEqual([expect.stringContaining("evidence.key is not a setting")]);
    expect(problems({ evidence: { runner_key_secret: "1KEY" } })).toEqual([expect.stringContaining("evidence.runner_key_secret must be a secret name")]);
    expect(problems({ evidence: { runner_key_secret: "K", audience: "a" } })).toEqual([expect.stringContaining("evidence.audience goes with identity: oidc")]);
    expect(problems({ evidence: { identity: "keyless" } })).toEqual([expect.stringContaining("evidence.identity must be oidc")]);
    expect(configSchemaProblems({ evidence: { identity: "keyless" } } as never)).not.toEqual([]);
  });
});

describe("evidence: the plan note job signs plan and policy", () => {
  for (const forge of ["github", "forgejo"] as const) {
    it(`${forge}: keyless, with the job's OIDC token and contents: write`, () => {
      const jobs = jobsOf(forge, { oidc: OIDC, evidence: { identity: "oidc" } });
      const note = jobs["plan-note"];
      const sign = note.steps.find((s: any) => s.name === "Sign the plan and policy evidence");
      expect(sign.run).toContain("terragucci ci evidence sign --from-report terragucci-report");
      expect(sign.env.CHANT_RUNNER_IDENTITY).toBe("oidc");
      // Forgejo's dialect keeps only the token request: its job token can push the notes.
      if (forge === "github") expect(note.permissions).toMatchObject({ contents: "write", "id-token": "write" });
      else expect(note["enable-openid-connect"]).toBe(true);
      // The plan job, which runs the change's code, holds no signing identity.
      expect(JSON.stringify(jobs.plan)).not.toContain("CHANT_RUNNER");
    });
  }

  it("github: a runner key from its secret, in the signing step alone", () => {
    const jobs = jobsOf("github", { evidence: { runnerKeySecret: "TG_RUNNER_KEY" } });
    const sign = jobs["plan-note"].steps.find((s: any) => s.name === "Sign the plan and policy evidence");
    expect(sign.env.CHANT_RUNNER_KEY).toBe("${{ secrets.TG_RUNNER_KEY }}");
    expect(JSON.stringify(jobs.plan)).not.toContain("TG_RUNNER_KEY");
  });

  it("gitlab: plan-evidence signs in the plan notes pipeline, and the note waits for it", () => {
    const doc = jobsOf("gitlab", { oidc: OIDC, evidence: { identity: "oidc" } });
    const ev = doc["plan-evidence"];
    expect(ev.stage).toBe("plan");
    expect(ev.script.join("\n")).toContain("terragucci ci evidence sign --open --job plan");
    expect(ev.id_tokens.CHANT_ID_TOKEN_SIGSTORE.aud).toBe("sigstore");
    expect(ev.environment.name).toBe("chant-evidence");
    expect(doc["plan-note"].needs).toEqual([{ job: "plan-evidence", artifacts: true }]);
    expect(doc["plan-note"].script.join("\n")).toContain("--evidence-dir");
  });

  it("without evidence nothing signs", () => {
    for (const forge of ["github", "forgejo", "gitlab"] as const) {
      const text = renderPipeline(input(forge, { oidc: OIDC })).content;
      expect(text, forge).not.toContain("evidence sign");
      expect(text, forge).not.toContain("CHANT_RUNNER");
    }
  });
});

describe("evidence: the waves sign plan:<wave> and policy:<wave>", () => {
  for (const forge of ["github", "forgejo", "gitlab"] as const) {
    it(`${forge}: a wave that trades cloud credentials signs keyless in its evidence job`, () => {
      const jobs = jobsOf(forge, { oidc: OIDC, evidence: { identity: "oidc" } });
      const ev = jobs["apply-wave-1-evidence"];
      expect(ev, Object.keys(jobs).join(", ")).toBeDefined();
      expect(JSON.stringify(ev)).toContain("ci evidence sign --from-job");
      expect(JSON.stringify(ev)).toContain("plan:wave-1");
      // The wave job holds no signing identity after its trade.
      expect(JSON.stringify(jobs["apply-wave-1"])).not.toContain("CHANT_RUNNER_IDENTITY");
    });
  }

  it("github: a runner key signs in the wave's own step", () => {
    const jobs = jobsOf("github", { evidence: { runnerKeySecret: "TG_RUNNER_KEY" } });
    expect(JSON.stringify(jobs["apply-wave-1"])).toContain("secrets.TG_RUNNER_KEY");
  });
});

describe("evidence: init writes .chant/trust.json", () => {
  const repo = (forge: "github" | "gitlab", evidence: Record<string, unknown>, extra: Record<string, string> = {}): string => {
    const dir = twoRootRepo();
    write(dir, { "terragucci.yml": `forge: ${forge}\nevidence:\n${Object.entries(evidence).map(([k, v]) => `  ${k}: ${v}`).join("\n")}\n`, ...extra });
    git(dir, "init", "-q", "-b", "main");
    git(dir, "remote", "add", "origin", forge === "github" ? "https://github.com/acme/infra.git" : "https://gitlab.com/acme/infra.git");
    return dir;
  };

  it("github, keyless: the refs rule for the default branch, the workflow's identity and the pre-push hook", async () => {
    const dir = repo("github", { identity: "oidc" });
    const r = await init(dir, { binary: "tofu" });
    const trust = JSON.parse(readFileSync(join(dir, TRUST_FILE), "utf-8"));
    const branch = git(dir, "symbolic-ref", "--short", "HEAD").trim();
    expect(trust.refs).toEqual([{ ref: `refs/heads/${branch}`, checks: [{ check: "plan", command: "/terragucci plan on the pull request" }, { check: "policy", command: "/terragucci plan on the pull request" }] }]);
    expect(trust.keyless.identities).toEqual([expect.objectContaining({ principal: "ci", class: "runner", issuer: "https://token.actions.githubusercontent.com", subject: `https://github.com/acme/infra/${signingWorkflow("github")}@refs/heads/${branch}` })]);
    expect(trust.roles.runner).toEqual(["ci"]);
    expect(trust.local).toBeUndefined();
    const hook = join(dir, ".git", "hooks", "pre-push");
    expect(readFileSync(hook, "utf-8")).toContain("exec terragucci workspace ref-gate pre-push");
    expect(statSync(hook).mode & 0o111).not.toBe(0);
    expect(r.notes.join("\n")).toContain("trusted_root.json");
    // A second init changes nothing.
    const again = await init(dir, { binary: "tofu" });
    expect(again.files.find((f) => f.path.endsWith(TRUST_FILE))?.status).toBe("unchanged");
  });

  it("gitlab, a runner key, local: the hooks under local.checks, and the key hint", async () => {
    const dir = repo("gitlab", { runner_key_secret: "TG_RUNNER_KEY", local: true }, { ".pre-commit-config.yaml": "repos: []\n" });
    write(dir, { "terragucci.yml": "forge: gitlab\ncheck:\n  pre_commit: true\nevidence:\n  runner_key_secret: TG_RUNNER_KEY\n  local: true\n" });
    const r = await init(dir, { binary: "tofu" });
    const trust = JSON.parse(readFileSync(join(dir, TRUST_FILE), "utf-8"));
    expect(trust.keyless).toBeUndefined();
    expect(trust.local.checks).toEqual([{ check: "terragucci-pre-commit" }]);
    const said = r.notes.join("\n");
    expect(said).toContain("TG_RUNNER_KEY");
    expect(said).toContain("local.keys");
  });

  it("without evidence no trust file is written", async () => {
    const dir = twoRootRepo();
    await init(dir, { binary: "tofu", forge: "github" });
    expect(existsSync(join(dir, TRUST_FILE))).toBe(false);
  });
});
