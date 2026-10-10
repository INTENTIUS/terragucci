// stack/instance.sh: TG_STACK picks the shared stack or the capture stack,
// each with its own compose project, names, ports, state and locks.
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const stack = join(__dirname, "..", "stack");

/** Source instance.sh and locks.sh under `env`, and print what they set. */
function instance(env: Record<string, string>): Record<string, string> {
  const script = `set -euo pipefail; HERE="${stack}"; . "$HERE/locks.sh"
    for v in TG_STACK TG_PROJECT TG_NETWORK TG_STATE SMOKE_LOCKS TERRAGUCCI_FORGEJO_PORT TERRAGUCCI_FLOCI_PORT TERRAGUCCI_GRAFANA_PORT; do
      echo "$v=\${!v:-}"
    done`;
  const out = execFileSync("bash", ["-c", script], { env: { PATH: process.env.PATH ?? "", ...env }, encoding: "utf8" });
  return Object.fromEntries(out.trim().split("\n").map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
}

describe("stack instances", () => {
  it("defaults to the shared stack, as before", () => {
    const v = instance({});
    expect(v.TG_STACK).toBe("shared");
    expect(v.TG_PROJECT).toBe("terragucci");
    expect(v.TG_NETWORK).toBe("terragucci");
    expect(v.TG_STATE).toBe(join(stack, ".state"));
    expect(v.SMOKE_LOCKS).toMatch(/\/stack\/\.state\/locks$/);
    // The shared stack's ports stay the compose file's defaults.
    expect(v.TERRAGUCCI_FORGEJO_PORT).toBe("");
  });

  it("gives the capture stack its own project, ports, state and locks", () => {
    const v = instance({ TG_STACK: "capture" });
    expect(v.TG_PROJECT).toBe("terragucci-capture");
    expect(v.TG_NETWORK).toBe("terragucci-capture");
    expect(v.TG_STATE).toBe(join(stack, ".state-capture"));
    expect(v.SMOKE_LOCKS).toMatch(/\/stack\/\.state-capture\/locks$/);
    expect([v.TERRAGUCCI_FORGEJO_PORT, v.TERRAGUCCI_FLOCI_PORT, v.TERRAGUCCI_GRAFANA_PORT]).toEqual(["3400", "4680", "3410"]);
    expect(v.SMOKE_LOCKS).not.toBe(instance({}).SMOKE_LOCKS);
  });

  it("keeps a port the caller set", () => {
    expect(instance({ TG_STACK: "capture", TERRAGUCCI_FORGEJO_PORT: "3999" }).TERRAGUCCI_FORGEJO_PORT).toBe("3999");
  });

  it("refuses an instance it does not know", () => {
    const r = spawnSync("bash", ["-c", `. "${stack}/instance.sh"`], { env: { PATH: process.env.PATH ?? "", TG_STACK: "other" }, encoding: "utf8" });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("shared (the default) or capture");
  });

  it("names every container, volume and the network after the project, but the shared job cache", () => {
    const compose = readFileSync(join(stack, "docker-compose.yml"), "utf8");
    const names = [...compose.matchAll(/^\s+(?:container_name|name): (.+)$/gm)].map((m) => m[1]);
    expect(names.length).toBeGreaterThan(20);
    for (const n of names) {
      if (n === "terragucci-job-cache") continue;
      expect(n).toMatch(/^\$\{TG_PROJECT:-terragucci\}/);
    }
    expect(compose).toMatch(/^name: \$\{TG_PROJECT:-terragucci\}$/m);
  });

  it("leaves no script on the shared network or project by a literal name", () => {
    const scripts = ["smoke.sh", "example.sh", "example-terragrunt.sh", "see-runs.sh", "forge-github.sh", "smoke-aws.sh", "lib.sh", "bootstrap.sh", "down.sh", "decide.sh", "tutorial-capture.sh"];
    for (const s of scripts) {
      const text = readFileSync(join(stack, s), "utf8");
      expect(text, s).not.toMatch(/--network terragucci\b/);
      expect(text, s).not.toMatch(/--project-name terragucci\b/);
      expect(text, s).not.toMatch(/docker (?:restart|exec|cp|logs[^\n]*) terragucci-(?:forgejo|floci|prometheus|otel-collector)/);
    }
  });
});
