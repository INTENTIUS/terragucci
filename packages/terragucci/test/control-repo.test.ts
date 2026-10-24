import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import { validateConfig, type ControlSettings } from "../src/config";
import { controlPipeline, dependentsScript, dispatchScript, resolveControl } from "../src/control-repo";
import { renderPipeline } from "../src/render";
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
      expect(job.permissions ?? {}).toEqual({});
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
