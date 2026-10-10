import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli";
import { tmp, write } from "./helpers";

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
    expect(refused.code).toBe(2);
    expect(JSON.parse(refused.out).results.problems).toEqual(["config.binary: must be one of terraform (terragucci.schema.json)"]);
    const ok = await check(write(tmp(), { "terragucci.yml": "binary: terraform\n" }));
    expect(JSON.parse(ok.out).results.ok).toBe(true);
  });
});
