import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { parseYAML } from "@intentius/chant/yaml";
import { describe, expect, it } from "vitest";
import { ConfigError, SETTING_KEYS, validateConfig } from "../src/config";
import { CONFIG_SCHEMA_URL, configSchema, configSchemaProblems, type JsonSchema } from "../src/config-schema";

const repo = join(import.meta.dirname, "../../..");
const goldens = join(import.meta.dirname, "golden/config");
/** The schema as it ships in the package and on the docs site. */
const SHIPPED = [join(repo, "packages/terragucci/src/terragucci.schema.json"), join(repo, "docs-site/public/terragucci.schema.json")];

const read = (path: string): unknown => {
  const text = readFileSync(path, "utf-8");
  return text.trim() === "" ? {} : parseYAML(text);
};

/** Whether config.ts accepts a parsed config. */
function checks(raw: unknown): { ok: boolean; problems: string[] } {
  try {
    validateConfig(raw, "terragucci.yml");
    return { ok: true, problems: [] };
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    return { ok: false, problems: e.problems ?? [e.message] };
  }
}

const files = (dir: string): string[] => readdirSync(join(goldens, dir)).filter((f) => f.endsWith(".yml")).sort().map((f) => join(goldens, dir, f));

/** Every terragucci.yml in the repo's examples and the stack's fixtures. */
function repoConfigs(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      const abs = join(dir, name);
      if (statSync(abs).isDirectory()) walk(abs);
      else if (name === "terragucci.yml") out.push(abs);
    }
  };
  for (const d of ["example", "example-terragrunt", "stack/fixtures"]) if (existsSync(join(repo, d))) walk(join(repo, d));
  return out.sort();
}

async function ajv(): Promise<(v: unknown) => boolean> {
  const Ajv = (await import("ajv/dist/2020.js")).default;
  return new Ajv({ strict: true, allowUnionTypes: true, strictRequired: false, strictTypes: false }).compile(configSchema());
}

describe("terragucci.schema.json", () => {
  it("ships as configSchema() builds it, in the package and on the docs site (UPDATE_GOLDEN=1 rewrites both)", () => {
    const text = `${JSON.stringify(configSchema(), null, 2)}\n`;
    for (const path of SHIPPED) {
      if (process.env.UPDATE_GOLDEN) writeFileSync(path, text);
      expect(readFileSync(path, "utf-8"), relative(repo, path)).toBe(text);
    }
    expect(configSchema().$id).toBe(CONFIG_SCHEMA_URL);
  });

  it("names every setting config.ts accepts, and no other, at the top, under defaults and under each project", () => {
    const s = configSchema();
    const project = (s.$defs as Record<string, JsonSchema>).project;
    expect(Object.keys(project.properties as object).sort()).toEqual([...SETTING_KEYS].sort());
    expect(Object.keys(s.properties as object).sort()).toEqual([...SETTING_KEYS, "defaults", "projects"].sort());
  });

  it("is a schema a standard validator compiles in strict mode, and its verdict on every golden is the built-in validator's", async () => {
    const validate = await ajv();
    for (const f of [...files("valid"), ...files("invalid"), ...files("check-only"), ...repoConfigs()]) {
      const raw = JSON.parse(JSON.stringify(read(f) ?? null));
      expect(validate(raw), relative(repo, f)).toBe(configSchemaProblems(raw).length === 0);
    }
  });
});

describe("config check and the schema agree", () => {
  it.each(files("valid").map((f) => [relative(goldens, f), f]))("%s: both accept", (_name, f) => {
    const raw = read(f);
    expect(checks(raw).problems).toEqual([]);
    expect(configSchemaProblems(raw)).toEqual([]);
  });

  it.each(files("invalid").map((f) => [relative(goldens, f), f]))("%s: both refuse", (_name, f) => {
    const raw = read(f);
    expect(checks(raw).ok).toBe(false);
    expect(configSchemaProblems(raw)).not.toEqual([]);
  });

  // Rules across keys or maps that the schema leaves to config.ts.
  it.each(files("check-only").map((f) => [relative(goldens, f), f]))("%s: config check alone refuses", (_name, f) => {
    const raw = read(f);
    expect(checks(raw).ok).toBe(false);
    expect(configSchemaProblems(raw)).toEqual([]);
  });

  it("on every terragucci.yml in the examples and the stack's fixtures", () => {
    const found = repoConfigs();
    expect(found.length).toBeGreaterThan(5);
    for (const f of found) {
      const raw = read(f);
      expect(checks(raw).problems, relative(repo, f)).toEqual([]);
      expect(configSchemaProblems(raw), relative(repo, f)).toEqual([]);
    }
  });

  it("the schema accepts every YAML example on the config reference that config check accepts", () => {
    const page = readFileSync(join(repo, "docs-site/src/content/docs/reference/config.md"), "utf-8");
    const blocks = [...page.matchAll(/^```ya?ml\n([\s\S]*?)^```/gm)].map((m) => m[1]);
    let accepted = 0;
    for (const b of blocks) {
      let raw: unknown;
      try {
        raw = parseYAML(b);
      } catch {
        continue;
      }
      if (!checks(raw).ok) continue;
      accepted++;
      expect(configSchemaProblems(raw), b).toEqual([]);
    }
    expect(accepted).toBeGreaterThan(5);
  });
});
