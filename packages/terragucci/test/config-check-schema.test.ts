import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli";
import { chantExitCodes } from "../src/chant-next";
import { tmp, write } from "./helpers";

// A config error exits 1 under chant's exit-code table (chant#4553, ruling C), 2 before it.
const USAGE = (await chantExitCodes()) ? 1 : 2;

// A schema that refuses what config.ts accepts: config check must say so.
vi.mock("../src/config-schema", async (actual) => ({
  ...(await actual<typeof import("../src/config-schema")>()),
  configSchemaProblems: (config: { binary?: string }) => (config.binary === "tofu" ? ["config.binary: must be one of terraform"] : []),
}));

async function check(dir: string): Promise<{ code: number; out: string }> {
  const cwd = process.cwd();
  const lines: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void lines.push(a.join(" ")));
  vi.spyOn(console, "error").mockImplementation(() => {});
  process.chdir(dir);
  try {
    return { code: await main(["config", "check", "--json"]), out: lines.join("\n") };
  } finally {
    process.chdir(cwd);
  }
}

afterEach(() => vi.restoreAllMocks());

describe("config check", () => {
  it("validates against terragucci.schema.json too, and lists what the schema refuses", async () => {
    const refused = await check(write(tmp(), { "terragucci.yml": "binary: tofu\n" }));
    expect(refused.code).toBe(USAGE);
    expect(JSON.parse(refused.out).results.problems).toEqual(["config.binary: must be one of terraform (terragucci.schema.json)"]);
    const ok = await check(write(tmp(), { "terragucci.yml": "binary: terraform\n" }));
    expect(JSON.parse(ok.out).results.ok).toBe(true);
  });

  it("warns when agent.token_env is set without agent.login, and not once agent.login names the agent's account", async () => {
    const yml = "binary: terraform\nforge: github\nagent:\n  via: forge\n  token_env: AGENT_FORGE_TOKEN\n";
    const without = JSON.parse((await check(write(tmp(), { "terragucci.yml": yml }))).out).results;
    expect(without.warnings).toContain("agent.token_env is set without agent.login, so the agent's account isn't excluded from approving a change: set agent.login to the login AGENT_FORGE_TOKEN's token acts as");
    const withLogin = JSON.parse((await check(write(tmp(), { "terragucci.yml": `${yml}  login: acme-agent\n` }))).out).results;
    expect(withLogin.warnings ?? []).not.toContain(expect.stringContaining("agent.login"));
  });

  it("refuses a terragucci.yml that is a list, instead of checking it as the empty config (#803)", async () => {
    const refused = await check(write(tmp(), { "terragucci.yml": "- binary: terraform\n" }));
    expect(refused.code).toBe(USAGE);
    const { results } = JSON.parse(refused.out);
    expect(results.ok).toBe(false);
    expect(results.problems.join("\n")).toMatch(/the config must be a mapping .* holds a list/);
  });
});
