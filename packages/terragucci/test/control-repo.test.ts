import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import { validateConfig, type ControlSettings } from "../src/config";
import { chantControlPipelineFile, resolveControl } from "../src/control-repo";
import { renderPipeline } from "../src/render";
import { tmp } from "./helpers";

const layers = [["a"]];
const input = { binary: "tofu" as const, version: "1.13.1", image: "img:1", layers, env: {} };
const control: ControlSettings = { repo: "github.com/acme/control", op: "deploy" };
const doc = (text: string): any => parseYAML(text);

/** Runs a script with a fake curl that records its arguments, and a fake terragucci whose `post sent` prints `sent`. */
function run(script: string, env: Record<string, string>, sent = "0"): { status: number; out: string; log: string } {
  const dir = tmp();
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const log = join(dir, "calls.log");
  for (const [name, body] of Object.entries({
    curl: `#!/usr/bin/env bash\nprintf 'curl %s\\n' "$*" >> ${log}\nprev=""; for a in "$@"; do [ "$prev" = "-o" ] && echo '{}' > "$a"; prev="$a"; done\nprintf 200`,
    terragucci: `#!/usr/bin/env bash\nprintf 'terragucci %s\\n' "$*" >> ${log}\n[ "$2" = sent ] && echo ${sent}\nexit 0`,
  })) {
    writeFileSync(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  }
  const r = spawnSync("bash", ["-c", script], { env: { PATH: `${bin}:${process.env.PATH}`, ...env }, encoding: "utf-8" });
  let calls = "";
  try {
    calls = readFileSync(log, "utf-8");
  } catch {}
  return { status: r.status ?? -1, out: r.stdout + r.stderr, log: calls };
}

describe("control: the member's settings", () => {
  const check = (c: unknown) => () => validateConfig({ control: c }, "config");
  it("takes a repo and an Op, and refuses a bad name or key", () => {
    expect(check(control)).not.toThrow();
    expect(check({ repo: "github.com/acme/control" })).toThrow(/control\.op/);
    expect(check({ ...control, op: "x; rm -rf /" })).toThrow(/control\.op/);
    expect(check({ ...control, extra: 1 })).toThrow(/not a setting/);
    expect(check({ repo: "ci.example.com/acme/control", op: "deploy" })).toThrow(/control\.forge is needed/);
    expect(check({ repo: "ci.example.com/acme/control", op: "deploy", forge: "forgejo" })).not.toThrow();
    expect(check({ ...control, token_env: "bad name" })).toThrow(/token_env/);
  });
  it("names the member after the repo unless control.member says otherwise", () => {
    expect(resolveControl(control, "infra").member).toBe("infra");
    expect(resolveControl({ ...control, member: "net" }, "infra")).toMatchObject({ member: "net", tokenEnv: "TERRAGUCCI_CONTROL_TOKEN", ref: "main", forge: "github" });
  });
});

// The member's dispatch is chant's control job beside the waves (./render-waves.ts), in terragucci's words.
const host = { github: "github.com", gitlab: "gitlab.com", forgejo: "codeberg.org" } as const;
const withControl = (forge: keyof typeof host, extra: object = {}) => renderPipeline({ forge, ...input, control: resolveControl({ repo: `${host[forge]}/acme/control`, op: "deploy" }, "infra"), ...extra });
/** The control job's dispatch script: its last step on GitHub and Forgejo, its heredoc on GitLab. */
const dispatchOf = (forge: keyof typeof host): { run: string; env: Record<string, string> } => {
  const d = doc(withControl(forge).content);
  if (forge === "gitlab") return { run: (d.control.script as string[]).find((s) => s.includes("CONTROL_DISPATCH"))!, env: {} };
  const step = d.jobs.control.steps.at(-1);
  return { run: step.run, env: step.env };
};

describe("control: the dispatch in a member's pipeline", () => {
  it("github: a repository_dispatch to the control repo, with the token in a header, under the event the control repo listens for", () => {
    const r = run(dispatchOf("github").run, { CHANT_CONTROL_TOKEN: "sekret", CHANT_CONTROL_SHA: "abc123", CHANT_CONTROL_OUTCOME: "applied" });
    expect(r.status).toBe(0);
    expect(r.log).toContain("https://api.github.com/repos/acme/control/dispatches");
    expect(r.log).toContain('"event_type":"terragucci-applied"');
    expect(r.log).toContain('"member":"infra","op":"deploy","sha":"abc123"');
    expect(r.out).not.toContain("sekret");
    expect(chantControlPipelineFile("github").content).toContain("terragucci-applied");
  });
  it("gitlab and forgejo: a pipeline trigger, and a dispatch of the workflow terragucci writes in the control repo", () => {
    const gl = dispatchOf("gitlab").run;
    expect(gl).toContain("https://gitlab.com/api/v4/projects/acme%2Fcontrol/trigger/pipeline");
    expect(gl).toContain("variables[CHANT_CONTROL_MEMBER]=$member");
    const fj = dispatchOf("forgejo").run;
    const file = chantControlPipelineFile("forgejo").path.split("/").at(-1);
    expect(file).toBe("terragucci-dependents.yml");
    expect(fj).toContain(`https://codeberg.org/api/v1/repos/acme/control/actions/workflows/${file}/dispatches`);
  });
  it.each(["github", "gitlab", "forgejo"] as const)("%s: only the default branch's waves send it, through a job of its own that alone holds the token", (forge) => {
    const plain = renderPipeline({ forge, ...input });
    const r = withControl(forge);
    expect(plain.content).not.toContain("TERRAGUCCI_CONTROL_TOKEN");
    const d = doc(r.content);
    const job = forge === "gitlab" ? d.control : d.jobs.control;
    expect(job.needs).toEqual(["apply-wave-1"]);
    if (forge === "gitlab") {
      expect(job.resource_group).toBe("terragucci-control");
      expect(dispatchOf(forge).run).toContain('CHANT_CONTROL_TOKEN="${TERRAGUCCI_CONTROL_TOKEN:-}"');
    } else {
      expect(dispatchOf(forge).env.CHANT_CONTROL_TOKEN).toBe("${{ secrets.TERRAGUCCI_CONTROL_TOKEN }}");
      expect(r.content.split("secrets.TERRAGUCCI_CONTROL_TOKEN").length).toBe(2);
      expect(job.concurrency.group).toContain("github.sha");
    }
  });
});

describe("control: the control repo's pipeline", () => {
  it("is the forge lexicon's, in terragucci's words, behind terragucci's first line", () => {
    for (const forge of ["github", "gitlab", "forgejo"] as const) {
      const p = chantControlPipelineFile(forge);
      expect(p.content.split("\n")[0]).toContain("terragucci");
      expect(p.content).toContain("--dependents-of");
    }
  });
});

describe("control: the control repo as a typed member", () => {
  it("ships a kind whose member file is terragucci.yml, checked by the schema the package ships", () => {
    const pkg = join(__dirname, "..");
    const kinds = JSON.parse(readFileSync(join(pkg, "workspace-kinds.json"), "utf-8"));
    expect(kinds.kinds[0]).toMatchObject({ name: "terragucci-control", memberFile: { path: "terragucci.yml", schema: "dist/terragucci.schema.json" } });
    expect(JSON.parse(readFileSync(join(pkg, "package.json"), "utf-8")).exports["./workspace-kinds"]).toBe("./workspace-kinds.json");
  });
});

describe("control: the control repo is told once per commit", () => {
  // A comment's re-run and the resume start the wave jobs of the run again, and that run's control job tells the control repo.
  it.each(["github", "forgejo"] as const)("%s: the resume workflow and the comment job hold no control token", (forge) => {
    const r = withControl(forge, { resume: 15 });
    const resume = r.extra!.find((e) => /resume/.test(e.path))!;
    expect(Object.keys(doc(resume.content).jobs)).toEqual(["resume"]);
    expect(resume.content).not.toContain("CONTROL");
    expect(JSON.stringify(doc(r.content).jobs["apply-comment"])).not.toContain("CONTROL_TOKEN");
  });
  it("gitlab: one control job, and the resume job drops the control tokens GitLab hands every job before it runs", () => {
    const d = doc(withControl("gitlab", { resume: 15 }).content);
    expect(Object.keys(d).filter((k) => /control/.test(k))).toEqual(["control"]);
    expect(d.resume.script).toEqual(["unset CHANT_CONTROL_TOKEN CHANT_CONTROL_READ_TOKEN TERRAGUCCI_CONTROL_TOKEN TERRAGUCCI_CONTROL_READ_TOKEN", "terragucci run resume --op tf-apply"]);
  });
  it("no control, no job and no output", () => {
    const r = renderPipeline({ forge: "github", ...input, resume: 15 });
    expect(r.content).not.toContain("terragucci/control");
    expect(doc(r.content).jobs.control).toBeUndefined();
    expect(r.extra!.map((e) => e.content).join("")).not.toContain("control");
  });
  it("sends once: a commit already marked is not sent again, and a new send marks it", () => {
    const env = { CHANT_CONTROL_TOKEN: "t", CHANT_CONTROL_SHA: "abc123", CHANT_CONTROL_OUTCOME: "applied" };
    const first = run(dispatchOf("github").run, env, "0");
    expect(first.status).toBe(0);
    expect(first.log).toContain("curl ");
    expect(first.log).toContain("post status terragucci/control success");
    const again = run(dispatchOf("github").run, env, "1");
    expect(again.status).toBe(0);
    expect(again.log).not.toContain("curl ");
  });
  it("refuses a commit that is not a sha", () => {
    const r = run(dispatchOf("github").run, { CHANT_CONTROL_TOKEN: "t", CHANT_CONTROL_SHA: "x; rm -rf /", CHANT_CONTROL_OUTCOME: "applied" });
    expect(r.status).toBe(1);
    expect(r.log).toBe("");
  });
});

describe("control: the tf-plan job reads the control repo (#753)", () => {
  const withControl = (c: ControlSettings, forge: "github" | "gitlab" | "forgejo") => renderPipeline({ ...input, forge, control: resolveControl(c, "svc") } as never).content;
  for (const forge of ["github", "forgejo"] as const) {
    it(`${forge}: plan and re-plan read only the control repo's chant/lifecycle, with chant's step`, () => {
      const d = doc(withControl(control, forge));
      for (const job of ["plan", "replan"]) {
        const steps = d.jobs[job].steps.filter((s: any) => JSON.stringify(s).includes("acme/control"));
        expect(steps).toHaveLength(1);
        expect(steps[0].run).toContain("+refs/heads/chant/lifecycle:refs/heads/chant/lifecycle");
        expect(steps[0].run).toContain("CHANT_CONTROL_DIR=");
        expect(steps[0].env.CHANT_CONTROL_READ_TOKEN).toBe("${{ secrets.TERRAGUCCI_CONTROL_READ_TOKEN || github.token }}");
        expect(JSON.stringify(steps[0])).not.toContain("TERRAGUCCI_CONTROL_TOKEN");
      }
      expect(JSON.stringify(d)).not.toContain("TERRAGUCCI_CONTROL_DIR");
      expect(JSON.stringify(d)).not.toContain(".terragucci-control");
    });
    it(`${forge}: read_token_env names the secret, and nothing is added without control`, () => {
      expect(withControl({ ...control, read_token_env: "CTRL_READ" }, forge)).toContain("secrets.CTRL_READ ||");
      expect(renderPipeline({ ...input, forge } as never).content).not.toContain("terragucci-control");
    });
  }
  it("gitlab: the plan job fetches the control repo's chant/lifecycle with the read variable or the job token", () => {
    const d = doc(withControl({ ...control, repo: "gitlab.com/acme/control" }, "gitlab"));
    expect(d.plan.variables.TERRAGUCCI_CONTROL_DIR).toBeUndefined();
    const text = d.plan.script.join("\n");
    expect(text).toContain('CHANT_CONTROL_READ_TOKEN="${TERRAGUCCI_CONTROL_READ_TOKEN:-}"');
    expect(text).toContain("CI_JOB_TOKEN");
    expect(text).toContain("'https://gitlab.com/acme/control.git' '+refs/heads/chant/lifecycle:refs/heads/chant/lifecycle'");
    expect(text).not.toContain("git clone");
    expect(text).not.toContain(".terragucci-control");
  });
  it("refuses a read token that is the dispatch token", () => {
    expect(() => validateConfig({ control: { ...control, read_token_env: "TERRAGUCCI_CONTROL_TOKEN" } }, "config")).toThrow(/dispatch token/);
    expect(() => validateConfig({ control: { ...control, token_env: "A", read_token_env: "A" } }, "config")).toThrow(/dispatch token/);
  });
});
