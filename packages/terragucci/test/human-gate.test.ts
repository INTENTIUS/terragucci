import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const GATE = join(__dirname, "..", "..", "..", "stack", "human-gate.sh");

/** The gate as an agent meets it: a new session, so no terminal; CI unset. */
function gate(dir: string, script: string, env: Record<string, string> = {}): Promise<{ code: number | null; stderr: string; ms: number }> {
  const base = { ...process.env };
  delete base.GITHUB_ACTIONS;
  delete base.GITLAB_CI;
  delete base.TG_HUMAN_RUN;
  const start = Date.now();
  return new Promise((res) => {
    const child = spawn("bash", ["-c", `. "${dir}/stack/human-gate.sh"; ${script}`], {
      detached: true,
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...base, TG_GRANT_FILE: join(dir, "grant"), TMPDIR: dir, ...env },
    });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += String(d)));
    child.on("close", (code) => res({ code, stderr, ms: Date.now() - start }));
  });
}

function setup(grant?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "tg-gate-"));
  mkdirSync(join(dir, "stack"));
  copyFileSync(GATE, join(dir, "stack", "human-gate.sh"));
  if (grant !== undefined) writeFileSync(join(dir, "grant"), grant);
  return dir;
}

const later = () => Math.floor(Date.now() / 1000) + 3600;

describe.skipIf(process.platform === "win32")("the human gate's grant", () => {
  it("stops an agent with no grant", async () => {
    const r = await gate(setup(), 'human_gate "claims" a');
    expect(r.code).toBe(3);
    expect(r.stderr).toContain("Not granted: no grant");
  });

  it("stops a run that names nothing, even with a grant", async () => {
    const r = await gate(setup(`expires ${later()}\na 2\n`), 'human_gate "claims"');
    expect(r.code).toBe(3);
  });

  it("passes a granted name a run at a time, then stops it when its runs are spent", async () => {
    const dir = setup(`expires ${later()}\na 2\nb 2\n`);
    expect((await gate(dir, 'human_gate "claims" a')).code).toBe(0);
    expect(readFileSync(join(dir, "grant"), "utf-8")).toContain("a 1\nb 2");
    expect((await gate(dir, 'human_gate "claims" a b')).code).toBe(0);
    expect(readFileSync(join(dir, "grant"), "utf-8")).toContain("a 0\nb 1");
    const spent = await gate(dir, 'human_gate "claims" a');
    expect(spent.code).toBe(3);
    expect(spent.stderr).toContain("a has no runs left in the grant");
  });

  it("stops a name the grant does not hold, and takes nothing", async () => {
    const dir = setup(`expires ${later()}\na 2\n`);
    const r = await gate(dir, 'human_gate "claims" a c');
    expect(r.code).toBe(3);
    expect(r.stderr).toContain("c is not in the grant");
    expect(readFileSync(join(dir, "grant"), "utf-8")).toContain("a 2");
  });

  it("stops an agent once the grant expired", async () => {
    const r = await gate(setup(`expires ${Math.floor(Date.now() / 1000) - 1}\na 2\n`), 'human_gate "claims" a');
    expect(r.code).toBe(3);
    expect(r.stderr).toContain("the grant expired");
  });

  it("stops a granted run that writes nothing, and says so", async () => {
    const r = await gate(setup(`expires ${later()}\na 2\n`), 'human_gate "claims" a; sleep 60', { TG_STALL_SECONDS: "2", TG_GRANT_POLL: "1" });
    expect(r.stderr).toContain("STOPPED: nothing written for");
    expect(r.ms).toBeLessThan(20_000);
  }, 30_000);

  it("lets what a granted run starts pass without a grant of its own", async () => {
    const dir = setup(`expires ${later()}\na 2\n`);
    const r = await gate(dir, `human_gate "claims" a && bash -c '. "${dir}/stack/human-gate.sh"; human_gate "inner"'`);
    expect(r.code).toBe(0);
  });
});
