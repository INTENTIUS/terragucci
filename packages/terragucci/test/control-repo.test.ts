import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import { validateConfig, type ControlSettings } from "../src/config";
import { controlPipeline, dependentsScript, dispatchScript, resolveControl } from "../src/control-repo";
import { commentApplyScript, renderPipeline, resumeScript } from "../src/render";
import { tmp } from "./helpers";

const layers = [["a"]];
const input = { binary: "tofu" as const, version: "1.13.1", image: "img:1", layers, env: {} };
const control: ControlSettings = { repo: "github.com/acme/control", op: "deploy" };
const doc = (text: string): any => parseYAML(text);

/** Runs a script with a fake curl and npm/npx that record their arguments. */
function run(script: string, env: Record<string, string>): { status: number; out: string; log: string } {
  const dir = tmp();
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const log = join(dir, "calls.log");
  for (const [name, body] of Object.entries({
    curl: `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${log}\nprev=""; for a in "$@"; do [ "$prev" = "-o" ] && echo '{}' > "$a"; prev="$a"; done\nprintf 200`,
    npm: `#!/usr/bin/env bash\necho "npm $*" >> ${log}`,
    npx: `#!/usr/bin/env bash\necho "npx $*" >> ${log}`,
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

describe("control: the dispatch step in a member's pipeline", () => {
  const c = resolveControl(control, "infra");
  it("github: a repository_dispatch to the control repo, with the token in a header", () => {
    const r = run(dispatchScript(c), { TG_CONTROL_TOKEN: "sekret", TG_SHA: "abc123" });
    expect(r.status).toBe(0);
    expect(r.log).toContain("https://api.github.com/repos/acme/control/dispatches");
    expect(r.log).toContain('"event_type":"terragucci-applied"');
    expect(r.log).toContain('"member":"infra","op":"deploy","sha":"abc123"');
    expect(r.out).not.toContain("sekret");
  });
  it("gitlab and forgejo: a pipeline trigger and a workflow dispatch", () => {
    const gl = dispatchScript(resolveControl({ repo: "gitlab.com/acme/ctl", op: "deploy" }, "infra"));
    expect(gl).toContain("https://gitlab.com/api/v4/projects/acme%2Fctl/trigger/pipeline");
    expect(gl).toContain("variables[TERRAGUCCI_MEMBER]=$member");
    const fj = dispatchScript(resolveControl({ repo: "codeberg.org/acme/ctl", op: "deploy" }, "infra"));
    expect(fj).toContain("https://codeberg.org/api/v1/repos/acme/ctl/actions/workflows/terragucci-dependents.yml/dispatches");
  });
  it.each(["github", "gitlab", "forgejo"] as const)("%s: only the default branch's last apply sends it, through a job of its own", (forge) => {
    const host = { github: "github.com", gitlab: "gitlab.com", forgejo: "codeberg.org" }[forge];
    const plain = renderPipeline({ forge, ...input });
    const r = renderPipeline({ forge, ...input, control: resolveControl({ repo: `${host}/acme/control`, op: "deploy" }, "infra") });
    expect(plain.content).not.toContain("TG_CONTROL_TOKEN");
    const d = doc(r.content);
    const job = forge === "gitlab" ? d.control : d.jobs.control;
    expect(job).toBeDefined();
    if (forge === "gitlab") {
      expect(job.needs).toEqual(["apply-wave-1"]);
      expect(job.variables.TG_CONTROL_TOKEN).toBe("$TERRAGUCCI_CONTROL_TOKEN");
    } else {
      expect(job.needs).toBe("apply-wave-1");
      expect(job.env.TG_CONTROL_TOKEN).toBe("${{ secrets.TERRAGUCCI_CONTROL_TOKEN }}");
      expect(job.permissions ?? { statuses: "write" }).toEqual({ statuses: "write" });
    }
  });
});

describe("control: the control repo's pipeline", () => {
  it("github: runs on the dispatch, passes the payload as environment, never in the script", () => {
    const p = controlPipeline("github");
    expect(p.path).toBe(".github/workflows/terragucci-dependents.yml");
    const d = doc(p.content);
    expect(d.on.repository_dispatch).toEqual({ types: ["terragucci-applied"] });
    const step = d.jobs.dependents.steps.find((s: any) => s.run);
    expect(step.env.TERRAGUCCI_MEMBER).toContain("client_payload.member");
    expect(step.run).not.toContain("client_payload");
    expect(step.run).toContain('chant workspace run --dependents-of "$member" --op "$op"');
  });
  it("forgejo and gitlab get their own triggers", () => {
    expect(doc(controlPipeline("forgejo").content).on.repository_dispatch).toBeUndefined();
    const gl = doc(controlPipeline("gitlab").content);
    expect(gl.dependents.rules[0].if).toContain('$CI_PIPELINE_SOURCE == "trigger"');
  });
  it("the script runs the dependents of the member the dispatch names, and refuses an odd name", () => {
    const ok = run(dependentsScript(), { TERRAGUCCI_MEMBER: "infra", TERRAGUCCI_OP: "deploy" });
    expect(ok.status).toBe(0);
    expect(ok.log).toContain("npx --no-install chant workspace run --dependents-of infra --op deploy --json");
    const bad = run(dependentsScript(), { TERRAGUCCI_MEMBER: "infra; echo hi", TERRAGUCCI_OP: "deploy" });
    expect(bad.status).toBe(2);
    expect(bad.log).toBe("");
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

describe("control: every path that completes an apply tells the control repo, once", () => {
  const forges = ["github", "forgejo"] as const;
  const host = { github: "github.com", forgejo: "codeberg.org" };
  const c = (forge: (typeof forges)[number]) => resolveControl({ repo: `${host[forge]}/acme/control`, op: "deploy" }, "infra");
  const render = (forge: (typeof forges)[number], extra: object = {}) => renderPipeline({ forge, ...input, resume: 15, control: c(forge), ...extra });
  const resumeDoc = (r: ReturnType<typeof renderPipeline>) => doc(r.extra!.find((e) => /resume/.test(e.path))!.content);

  it.each(forges)("%s: the resume workflow hands its commit to a control job of its own", (forge) => {
    const d = resumeDoc(render(forge));
    const step = d.jobs.resume.steps.find((st: any) => st.id === "resume");
    expect(step.run).toContain('echo "control_sha=$TG_SHA" >> "$GITHUB_OUTPUT"');
    expect(d.jobs.resume.outputs.control_sha).toBe("${{ steps.resume.outputs.control_sha }}");
    const job = d.jobs.control;
    expect(job.needs).toBe("resume");
    expect(job.if).toBe("needs.resume.outputs.control_sha != ''");
    expect(job.env.TG_SHA).toBe("${{ needs.resume.outputs.control_sha }}");
    expect(job.env.TG_CONTROL_TOKEN).toBe("${{ secrets.TERRAGUCCI_CONTROL_TOKEN }}");
    expect(job.permissions ?? { statuses: "write" }).toEqual({ statuses: "write" });
    expect(JSON.stringify(d.jobs.resume)).not.toContain("TG_CONTROL_TOKEN");
    expect(job.steps[0].run).toContain("/dispatches");
  });
  it.each(forges)("%s: a comment that applied a merged commit hands it on, and the open head does not", (forge) => {
    const d = doc(render(forge).content);
    expect(d.jobs["apply-comment"].outputs.control_sha).toBe("${{ steps.apply.outputs.control_sha }}");
    expect(d.jobs["apply-comment"].steps.find((st: any) => st.id === "apply")).toBeDefined();
    expect(JSON.stringify(d.jobs["apply-comment"])).not.toContain("TG_CONTROL_TOKEN");
    const job = d.jobs["control-comment"];
    expect(job.needs).toBe("apply-comment");
    expect(job.env.TG_SHA).toBe("${{ needs.apply-comment.outputs.control_sha }}");
    expect(job.steps[0].run).toContain("/dispatches");
    // apply.when: pull-request: the push after the merge confirms and dispatches; a comment dispatches only for a merged commit.
    const pr = doc(render(forge, { applyWhen: "pull-request" }).content);
    expect(pr.jobs.control.needs).toBe("confirm");
    expect(pr.jobs["control-comment"].needs).toBe("apply-comment");
  });
  it.each(forges)("%s: the push, the resume and the comment dispatch share one script, so one mark", (forge) => {
    const d = doc(render(forge).content);
    const r = resumeDoc(render(forge));
    const scripts = [d.jobs.control.steps[0].run, d.jobs["control-comment"].steps[0].run, r.jobs.control.steps[0].run];
    expect(new Set(scripts).size).toBe(1);
    expect(scripts[0]).toContain("terragucci post sent terragucci/control");
    expect(d.jobs.control.concurrency.group).toContain("github.sha");
  });
  it("no control, no job and no output", () => {
    const r = renderPipeline({ forge: "github", ...input, resume: 15 });
    expect(r.content).not.toContain("control");
    expect(r.extra!.map((e) => e.content).join("")).not.toContain("control");
  });
  it("gitlab: a retried wave unblocks the one control job, and mr-apply applies a head, so neither adds a dispatch", () => {
    const d = doc(renderPipeline({ forge: "gitlab", ...input, resume: 15, comments: "*/5 * * * *", applyWhen: "pull-request", applyMergeTokenEnv: "MERGE_TOKEN", control: resolveControl({ repo: "gitlab.com/acme/ctl", op: "deploy" }, "infra") }).content);
    expect(Object.keys(d).filter((k) => /control/.test(k))).toEqual(["control"]);
    expect(d.control.needs).toEqual(["confirm"]);
    expect(JSON.stringify(d["mr-apply"])).not.toContain("CONTROL");
    expect(JSON.stringify(d.resume)).not.toContain("CONTROL");
  });

  const hand = (open: string, last: string) => {
    const line = commentApplyScript("tofu", layers, "github", undefined, { control: true, when: "pull-request" }).split("\n").find((l) => l.includes("control_sha"))!;
    const out = join(tmp(), "out");
    const r = spawnSync("bash", ["-c", `last=${last}; count=1; TG_SHA=abc123; TG_OPEN=${open}; ${line}`], { env: { ...process.env, GITHUB_OUTPUT: out }, encoding: "utf-8" });
    let written = "";
    try {
      written = readFileSync(out, "utf-8");
    } catch {}
    return { status: r.status, written };
  };
  it("a comment hands on the commit only when every wave applied from the merge commit", () => {
    expect(hand("0", "1").written).toBe("control_sha=abc123\n");
    expect(hand("1", "1").written).toBe("");
    expect(hand("0", "2").written).toBe("");
  });
  it("resumeScript hands its commit on after the wave loop", () => {
    const lines = resumeScript("tofu", layers, "github", undefined, { control: true }).split("\n");
    const loop = lines.findIndex((l) => l.includes("tf-apply"));
    expect(lines.findIndex((l) => l.includes("control_sha"))).toBeGreaterThan(loop);
    expect(resumeScript("tofu", layers, "github", undefined, {})).not.toContain("control_sha");
  });

  it("sends once: a commit already marked is not sent again, and a new send marks it", () => {
    const script = dispatchScript(c("github"), "github");
    const withPost = (sent: string) => {
      const dir = tmp();
      const bin = join(dir, "bin");
      mkdirSync(bin);
      const log = join(dir, "calls.log");
      const body = {
        curl: `#!/usr/bin/env bash\nprintf 'curl %s\\n' "$*" >> ${log}\nprev=""; for a in "$@"; do [ "$prev" = "-o" ] && echo '{}' > "$a"; prev="$a"; done\nprintf 200`,
        terragucci: `#!/usr/bin/env bash\nprintf 'terragucci %s\\n' "$*" >> ${log}\n[ "$2" = sent ] && echo ${sent}\nexit 0`,
      };
      for (const [name, text] of Object.entries(body)) {
        writeFileSync(join(bin, name), text);
        chmodSync(join(bin, name), 0o755);
      }
      const r = spawnSync("bash", ["-c", script], { env: { PATH: `${bin}:${process.env.PATH}`, TG_CONTROL_TOKEN: "t", TG_SHA: "abc123" }, encoding: "utf-8" });
      return { status: r.status, log: readFileSync(log, "utf-8") };
    };
    const first = withPost("0");
    expect(first.status).toBe(0);
    expect(first.log).toContain("curl ");
    expect(first.log).toContain("post status terragucci/control success");
    const again = withPost("1");
    expect(again.status).toBe(0);
    expect(again.log).not.toContain("curl ");
  });
  it("refuses a commit that is not a sha", () => {
    const r = run(dispatchScript(c("github"), "github"), { TG_CONTROL_TOKEN: "t", TG_SHA: "x; rm -rf /" });
    expect(r.status).toBe(1);
    expect(r.log).toBe("");
  });
});

describe("control: the tf-plan job reads the control repo (#753)", () => {
  const withControl = (c: ControlSettings, forge: "github" | "gitlab" | "forgejo") => renderPipeline({ ...input, forge, control: resolveControl(c, "svc") } as never).content;
  for (const forge of ["github", "forgejo"] as const) {
    it(`${forge}: plan and re-plan check the control repo out, pinned and read-only, and name its directory`, () => {
      const d = doc(withControl(control, forge));
      for (const job of ["plan", "replan"]) {
        const step = d.jobs[job].steps.find((s: any) => s.name?.startsWith("Check out the control repo"));
        expect(step.uses).toMatch(/actions\/checkout@[0-9a-f]{40}$/);
        expect(step.with).toMatchObject({ repository: "acme/control", path: ".terragucci-control", "persist-credentials": false });
        expect(step.with.token).toBe("${{ secrets.TERRAGUCCI_CONTROL_READ_TOKEN || github.token }}");
        expect(JSON.stringify(step)).not.toContain("TERRAGUCCI_CONTROL_TOKEN");
      }
      expect((d.jobs.plan.env ?? d.env).TERRAGUCCI_CONTROL_DIR ?? d.jobs.plan.env.TERRAGUCCI_CONTROL_DIR).toBe("${{ github.workspace }}/.terragucci-control");
    });
    it(`${forge}: read_token_env names the secret, and nothing is added without control`, () => {
      expect(withControl({ ...control, read_token_env: "CTRL_READ" }, forge)).toContain("secrets.CTRL_READ ||");
      expect(renderPipeline({ ...input, forge } as never).content).not.toContain("terragucci-control");
    });
  }
  it("gitlab: the plan job clones the control repo with the read variable or the job token", () => {
    const d = doc(withControl({ ...control, repo: "gitlab.com/acme/control" }, "gitlab"));
    expect(d.plan.variables.TERRAGUCCI_CONTROL_DIR).toBe("$CI_PROJECT_DIR/.terragucci-control");
    const text = d.plan.script.join("\n");
    expect(text).toContain("git clone --quiet --depth 1");
    expect(text).toContain("${TERRAGUCCI_CONTROL_READ_TOKEN:-${CI_JOB_TOKEN:-}}@gitlab.com/acme/control.git");
  });
  it("refuses a read token that is the dispatch token", () => {
    expect(() => validateConfig({ control: { ...control, read_token_env: "TERRAGUCCI_CONTROL_TOKEN" } }, "config")).toThrow(/dispatch token/);
    expect(() => validateConfig({ control: { ...control, token_env: "A", read_token_env: "A" } }, "config")).toThrow(/dispatch token/);
  });
});
