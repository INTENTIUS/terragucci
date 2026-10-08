import { describe, expect, it } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import { ConfigError, validateConfig } from "../src/config";
import { findRootsWithReasons } from "../src/detect";
import { applyScript, commentApplyScript, driftScript, planScript, renderPipeline, synthScript } from "../src/render";
import { runStage } from "../src/report/stage";
import { tmp, write } from "./helpers";

const SYNTH = "npm ci && npx cdktn synth";
const layers = [["cdktf.out/stacks/dev", "cdktf.out/stacks/prod"]];
const stack = (backend: string): string => JSON.stringify({ terraform: { backend: { [backend]: { path: "x.tfstate" } } }, resource: { terraform_data: { cfg: { input: 1 } } } });

describe("synth: roots a command writes", () => {
  it("finds a CDK Terrain stack as a root by the backend in its cdk.tf.json", () => {
    const repo = write(tmp(), {
      "cdktf.out/stacks/dev/cdk.tf.json": stack("s3"),
      "cdktf.out/stacks/prod/cdk.tf.json": stack("local"),
      "cdktf.out/manifest.json": "{}",
      "node_modules/x/cdk.tf.json": stack("s3"),
    });
    expect(findRootsWithReasons(repo)).toEqual([
      { root: "cdktf.out/stacks/dev", reason: "backend s3" },
      { root: "cdktf.out/stacks/prod", reason: "backend local" },
    ]);
  });

  it("takes synth as a command, and refuses anything else", () => {
    expect(validateConfig({ synth: SYNTH }, "t").synth).toBe(SYNTH);
    expect(() => validateConfig({ synth: true }, "t")).toThrow(/synth must be the command that writes the roots/);
    expect(() => validateConfig({ synth: " " }, "t")).toThrow(ConfigError);
  });

  it("runs the command after the checkout and before any credential, in every job that reads the roots", () => {
    const step = synthScript(SYNTH);
    const oidc = { plan_role: "arn:aws:iam::1:role/plan", apply_role: "arn:aws:iam::1:role/apply" };
    const before = (script: string, what: string): void => {
      expect(script).toContain(`( set -e; ${SYNTH} )`);
      expect(script.indexOf(`( set -e; ${SYNTH} )`)).toBeLessThan(script.indexOf(what));
    };
    before(planScript("tofu", layers, "github", oidc, { synth: SYNTH }), "export AWS_ROLE_ARN");
    before(planScript("tofu", layers, "github", oidc, { synth: SYNTH }), "terragucci stage tf-plan");
    before(planScript("tofu", layers, "github", undefined, { synth: SYNTH }, true), "terragucci stage tf-plan");
    expect(planScript("tofu", layers, "github", undefined, { synth: SYNTH }, true).indexOf('git checkout --quiet --detach "$TG_SHA"')).toBeLessThan(planScript("tofu", layers, "github", undefined, { synth: SYNTH }, true).indexOf(SYNTH));
    before(applyScript("tofu", layers, "github", oidc, { wave: 1, synth: SYNTH }), "terragucci stage tf-apply");
    before(driftScript("tofu", layers, "github", oidc, { synth: SYNTH }), "terragucci stage tf-drift");
    const comment = commentApplyScript("tofu", layers, "github", oidc, { synth: SYNTH });
    expect(comment.indexOf('git checkout --quiet --detach "$TG_SHA"')).toBeLessThan(comment.indexOf(SYNTH));
    expect(planScript("tofu", layers, "github", undefined, { synth: SYNTH })).toContain('tg status terragucci/plan failure "the synth command failed"');
    expect(step).not.toContain("tg status");
    expect(planScript("tofu", layers)).not.toContain("synth");
  });

  it.each(["github", "forgejo", "gitlab"] as const)("%s: the check, plan and apply jobs run it", (forge) => {
    const text = renderPipeline({ forge, binary: "tofu", version: "1.13.1", image: "img:1", layers, env: {}, synth: SYNTH }).content;
    const doc = parseYAML(text.split("\n").filter((l) => !l.startsWith("#")).join("\n")) as Record<string, any>;
    const jobs = forge === "gitlab" ? doc : doc.jobs;
    const script = (job: any): string => (forge === "gitlab" ? job.script.join("\n") : job.steps.map((s: { run?: string }) => s.run ?? "").join("\n"));
    for (const name of ["check", "plan", "apply-wave-1"]) expect(script(jobs[name]), name).toContain(`( set -e; ${SYNTH} )`);
  });

  it("plans every synthesized root on a pull request, and finds no roots when the command has not run", async () => {
    const repo = write(tmp(), { "terragucci.yml": `binary: tofu\nsynth: ${SYNTH}\n`, "main.js": "" });
    await expect(runStage("tf-plan", repo, { layers, out: tmp() }, () => {})).rejects.toThrow(/found no roots: none of the 2 the pipeline names is on disk; the synth command/);
  });
});
