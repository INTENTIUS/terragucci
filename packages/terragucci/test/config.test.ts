import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BUILT_IN,
  ConfigError,
  forgeFromHost,
  loadConfig,
  parseProjectKey,
  resolveProject,
  resolveRepo,
  validateConfig,
} from "../src/config";
import { tmp, write } from "./helpers";

const YAML = `defaults:
  binary: tofu
  gate: on-destroy
projects:
  github.com/acme/infra:
    roots: ["envs/*/*"]
    waves:
      canary: ["envs/dev/*"]
  gitlab.example.com/platform/network:
    binary: terraform
    drift: "17 4 * * *"
  codeberg.org/acme/edge: {}
`;

const TS = `import type { TerragucciConfig } from "@intentius/terragucci";

const repo = (roots: string[]) => ({ roots });

export default {
  defaults: { binary: "tofu", gate: "on-destroy" },
  projects: {
    "github.com/acme/infra": { ...repo(["envs/*/*"]), waves: { canary: ["envs/dev/*"] } },
    "gitlab.example.com/platform/network": { binary: "terraform", drift: "17 4 * * *" },
    "codeberg.org/acme/edge": {},
  },
} satisfies TerragucciConfig;
`;

describe("loading", () => {
  it("a YAML config and its TypeScript twin, folded, load to the same value", async () => {
    const dir = write(tmp(), { "a/terragucci.yml": YAML, "b/terragucci.ts": TS });
    const yml = await loadConfig(join(dir, "a/terragucci.yml"));
    const ts = await loadConfig(join(dir, "b/terragucci.ts"));
    expect(ts).toEqual(yml);
    expect(yml.projects?.["codeberg.org/acme/edge"]).toEqual({});
  });

  it("folding refuses a config that reads the environment, and names the rule", async () => {
    const dir = write(tmp(), { "terragucci.ts": "export default { binary: process.env.TG_BINARY };\n" });
    await expect(loadConfig(join(dir, "terragucci.ts"))).rejects.toThrow(/not data \(F-Eval-Ident\)/);
  });

  it("an empty YAML file is the empty config", async () => {
    const dir = write(tmp(), { "terragucci.yml": "\n" });
    expect(await loadConfig(join(dir, "terragucci.yml"))).toEqual({});
  });
});

describe("validation", () => {
  it.each([
    [{ bianry: "tofu" }, /config\.bianry is not a setting/],
    [{ binary: "pulumi" }, /config\.binary is "pulumi"; use one of terraform, tofu, choudoufu, cdktn/],
    [{ gate: "sometimes" }, /config\.gate/],
    [{ roots: "envs/*" }, /config\.roots must be a list of strings/],
    [{ drift: 5 }, /config\.drift must be a cron schedule or false/],
    [{ env: { A: 1 } }, /config\.env must map names to string values/],
    [{ projects: { "github.com/acme": {} } }, /must be <host>\/<owner>\/<name>/],
    [{ binary: "tofu", projects: { "github.com/a/b": {} } }, /keeps shared settings under defaults; move binary there/],
    [{ defaults: { binary: "tofu" } }, /defaults only makes sense with projects/],
  ])("%j is refused", (raw, message) => {
    expect(() => validateConfig(raw, "t")).toThrow(message);
  });

  it("lists every problem at once", () => {
    expect(() => validateConfig({ binary: "x", gate: "y" }, "t")).toThrow(/2 problem\(s\)/);
  });
});

describe("resolution", () => {
  const config = validateConfig(
    {
      defaults: { binary: "tofu", gate: "always", env: { A: "1", B: "1" }, waves: { canary: ["dev/*"] } },
      projects: {
        "github.com/a/one": {},
        "github.com/a/two": { gate: "never", env: { B: "2" } },
      },
    },
    "t",
  );

  it.each([
    ["github.com/a/one", { binary: "tofu", gate: "always", env: { A: "1", B: "1" }, drift: false, tips: true }],
    ["github.com/a/two", { binary: "tofu", gate: "never", env: { A: "1", B: "2" }, drift: false, tips: true }],
  ])("%s: built-in < defaults < project", (key, expected) => {
    expect(resolveProject(config, key)).toMatchObject(expected);
  });

  it("one repo gets the built-in defaults under its own keys", () => {
    expect(resolveRepo({ gate: "always" })).toEqual({ ...BUILT_IN, gate: "always" });
    expect(resolveRepo({})).toEqual(BUILT_IN);
  });

  it("a control repo's config is refused where one repo's is expected", () => {
    expect(() => resolveRepo(config)).toThrow(ConfigError);
  });
});

describe("project keys", () => {
  it.each([
    ["github.com/acme/infra", { host: "github.com", path: "acme/infra", owner: "acme", name: "infra" }],
    ["gitlab.example.com/platform/net/core", { host: "gitlab.example.com", path: "platform/net/core", owner: "platform/net", name: "core" }],
    ["https://codeberg.org/acme/edge.git", { host: "codeberg.org", path: "acme/edge", owner: "acme", name: "edge" }],
    ["localhost:3300/admin/example", { host: "localhost:3300", path: "admin/example", owner: "admin", name: "example" }],
  ])("%s", (key, expected) => {
    expect(parseProjectKey(key)).toMatchObject(expected);
  });

  it.each(["github.com", "github.com/acme", "github.com//infra"])("%s is refused", (key) => {
    expect(() => parseProjectKey(key)).toThrow(ConfigError);
  });

  it.each([
    ["github.com", "github"],
    ["github.acme.internal", "github"],
    ["gitlab.com", "gitlab"],
    ["gitlab.example.com", "gitlab"],
    ["codeberg.org", "forgejo"],
    ["forgejo.example.com:3000", "forgejo"],
    ["git.example.com", undefined],
  ])("%s is %s", (host, forge) => {
    expect(forgeFromHost(host)).toBe(forge);
  });
});

describe("stack profiles", async () => {
  const { profilesFor } = await import("../src/cli");
  it.each([
    [{ projects: { "github.com/a/b": {}, "gitlab.example.com/c/d": {} } }, ["aws", "github", "gitlab"]],
    [{ projects: { "codeberg.org/a/b": { runtime: "fountain" } } }, ["aws", "forgejo", "fountain"]],
    [{ defaults: { forge: "forgejo" }, projects: { "localhost:3300/a/b": {} } }, ["aws", "forgejo"]],
    [{ forge: "gitlab" }, ["aws", "gitlab"]],
    [{}, ["aws"]],
  ])("%j needs %j", (config, profiles) => {
    expect(profilesFor(validateConfig(config, "t"))).toEqual(profiles);
  });
});

describe("the TypeScript folder is optional", () => {
  it("a .ts config without @intentius/tsad-reference names the install command", async () => {
    const { vi } = await import("vitest");
    vi.resetModules();
    vi.doMock("@intentius/tsad-reference", () => {
      throw new Error("Cannot find package '@intentius/tsad-reference'");
    });
    const { loadConfig: load } = await import("../src/config");
    const dir = write(tmp(), { "terragucci.ts": "export default { binary: \"tofu\" };\n" });
    await expect(load(join(dir, "terragucci.ts"))).rejects.toThrow(/npm i -D @intentius\/tsad-reference/);
    vi.doUnmock("@intentius/tsad-reference");
    vi.resetModules();
  });
});
