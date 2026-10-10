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

  it("a file that holds only comments is the empty config", async () => {
    const dir = write(tmp(), { "terragucci.yml": "# nothing set yet\n" });
    expect(await loadConfig(join(dir, "terragucci.yml"))).toEqual({});
  });

  // #803: a top-level list used to parse as {} and pass as the empty config.
  it.each([
    ["a list", "- binary: tofu\n- gate: on-destroy\n", "a list"],
    ["an empty flow list", "[]\n", "a list"],
    ["a quoted string", '"binary"\n', "a string"],
    ["a number", "5\n", "a number"],
  ])("refuses a file that holds %s, and says the config must be a mapping", async (_what, text, got) => {
    const dir = write(tmp(), { "terragucci.yml": text });
    const path = join(dir, "terragucci.yml");
    await expect(loadConfig(path)).rejects.toThrow(ConfigError);
    await expect(loadConfig(path)).rejects.toThrow(`${path}: the config must be a mapping of setting names to values (key: value at the top level), and this file holds ${got}`);
  });

  it("refuses a JSON config that is an array", async () => {
    const dir = write(tmp(), { "terragucci.json": '[{"binary":"tofu"}]' });
    await expect(loadConfig(join(dir, "terragucci.json"))).rejects.toThrow(/must be a mapping .* holds a list/);
  });
});

describe("validation", () => {
  it.each([
    [{ bianry: "tofu" }, /config\.bianry is not a setting/],
    [{ binary: "pulumi" }, /config\.binary is "pulumi"; use one of terraform, tofu, choudoufu/],
    [{ binary: "cdktn" }, /config\.binary is "cdktn"; use one of terraform, tofu, choudoufu$/],
    [{ gate: "sometimes" }, /config\.gate/],
    [{ roots: "envs/*" }, /config\.roots must be a list of strings/],
    [{ drift: 5 }, /config\.drift must be a cron schedule or false/],
    [{ comments: 5 }, /config\.comments must be a cron schedule or false/],
    [{ rollouts: 5 }, /config\.rollouts must be a cron schedule or false/],
    [{ projects: { "github.com/acme/a": { rollouts: "*/15 * * * *" } } }, /projects\["github.com\/acme\/a"\]\.rollouts: a control repo's rollout plans its waves across every project/],
    [{ defaults: { rollouts: "*/15 * * * *" }, projects: { "github.com/acme/a": {} } }, /defaults\.rollouts: a control repo's rollout/],
    [{ forge: "github", comments: "*/5 * * * *" }, /config\.comments: comments is for GitLab/],
    [{ env: { A: 1 } }, /config\.env must map names to string values/],
    [{ projects: { "github.com/acme": {} } }, /must be <host>\/<owner>\/<name>/],
    [{ binary: "tofu", projects: { "github.com/a/b": {} } }, /keeps shared settings under defaults; move binary there/],
    [{ defaults: { binary: "tofu" } }, /defaults only makes sense with projects/],
    [{ defaults: { url: "https://git.example.com/acme/infra" }, projects: { "github.com/a/b": {} } }, /defaults\.url would clone one repo for every project; set url on each project/],
    [{ policy: true }, /config\.policy must be a map/],
    [{ policy: { engine: "sentinel" } }, /config\.policy\.engine is "sentinel"; use one of conftest, opa/],
    [{ policy: { path: "../elsewhere" } }, /config\.policy\.path must be a directory inside the repo/],
    [{ policy: { override: true } }, /config\.policy\.override must be a list of the forge identities or signers/],
    [{ policy: { override: [] } }, /config\.policy\.override must be a list/],
    [{ policy: { overide: ["a"] } }, /config\.policy\.overide is not a setting/],
    [{ policy: { namespace: "a b" } }, /config\.policy\.namespace must be a Rego package name/],
    [{ terragrunt: true }, /config\.terragrunt must be a map/],
    [{ terragrunt: { verison: "1.1.6" } }, /config\.terragrunt\.verison is not a setting/],
    [{ terragrunt: { version: "latest" } }, /config\.terragrunt\.version must be a release version/],
    [{ terragrunt: { version: "0.99.0" } }, /needs Terragrunt 1\.1 or later/],
    [{ terragrunt: { version: "1.0.4" } }, /needs Terragrunt 1\.1 or later/],
    [{ terragrunt: { exclude: "catalog/**" } }, /config\.terragrunt\.exclude must be a list of strings/],
    [{ terragrunt: { parallelism: 0 } }, /config\.terragrunt\.parallelism must be a whole number of 1 or more/],
    [{ terragrunt: { parallelism: 2.5 } }, /parallelism must be a whole number/],
    [{ terragrunt: { dependents: "all" } }, /config\.terragrunt\.dependents is "all"; use one of follow, plan/],
    [{ terragrunt: { credentials: ["live/**"] } }, /credentials must map unit path globs/],
    [{ terragrunt: { credentials: { "live/**": "arn:x" } } }, /credentials\["live\/\*\*"\] must be a map with plan and apply/],
    [{ terragrunt: { credentials: { "live/**": { plan: "arn:p" } } } }, /credentials\["live\/\*\*"\]\.apply must name a role/],
    [{ terragrunt: { credentials: { "live/**": { plan: "arn:p", apply: "arn:a", role: "x" } } } }, /\.role is not a setting \(settings: plan, apply\)/],
    [{ terragrunt: { credentials: { "live/**": { plan: "arn:x", apply: "arn:x" } } } }, /uses one role for plan and apply/],
    [{ defaults: { terragrunt: { parallelism: -1 } }, projects: { "github.com/a/b": {} } }, /defaults\.terragrunt\.parallelism/],
    [{ parallelism: 0 }, /config\.parallelism must be a whole number of 1 or more/],
    [{ parallelism: "8" }, /config\.parallelism must be a whole number of 1 or more/],
    [{ apply: "pull-request" }, /config\.apply must be a map \(settings: when, merge, merge_token_env, requires, resume, branches\)/],
    [{ apply: { when: "pull-request", requires: ["reviewed"] } }, /config\.apply\.requires must be a list of approved, mergeable, undiverged, checks/],
    [{ apply: { when: "pull-request", requires: "approved" } }, /config\.apply\.requires must be a list/],
    [{ apply: { when: "pull-request", requires: ["approved", "approved"] } }, /config\.apply\.requires names a requirement twice/],
    [{ apply: { requires: ["approved"] } }, /config\.apply\.requires is set, and only a pull request applied before it merges/],
    [{ apply: { when: "pull-request", merge: "auto", requires: ["checks"] } }, /config\.apply\.requires leaves out approved, and apply\.merge: auto merges only an approved head/],
    [{ apply: { when: "approve" } }, /config\.apply\.when is "approve"; use one of merge, pull-request/],
    [{ apply: { when: "pull-request", merge: "now" } }, /config\.apply\.merge is "now"; use one of manual, auto/],
    [{ apply: { merge: "auto" } }, /config\.apply\.merge is set, and only a pull request applied before it merges/],
    [{ apply: { when: "pull-request", lock: true } }, /config\.apply\.lock is not a setting/],
    [{ apply: { when: "pull-request", merge: "auto", merge_token_env: "merge-token" } }, /config\.apply\.merge_token_env must name the secret holding the token the merge is made with/],
    [{ apply: { when: "pull-request", merge_token_env: "MERGE_TOKEN" } }, /config\.apply\.merge_token_env is set, and only apply\.merge: auto merges/],
    [{ forge: "gitlab", apply: { when: "pull-request", merge_token_env: "MERGE_TOKEN" } }, /config\.apply\.when: pull-request on GitLab needs comments: <cron>/],
    [{ forge: "gitlab", comments: "*/5 * * * *", apply: { when: "pull-request" } }, /config\.apply\.when: pull-request on GitLab needs apply\.merge_token_env/],
    [{ locks: "always" }, /config\.locks is "always"; use one of apply, plan/],
    [{ forge: "gitlab", locks: "plan" }, /config\.locks: plan is not supported on GitLab, where no merge request event runs a job from the default branch/],
    [{ forge: "gitlab", gitlab: { token: "protected" } }, /config\.gitlab\.token: protected needs comments: <cron>/],
    [{ gitlab: { token: "hidden" } }, /config\.gitlab\.token is "hidden"; use one of unprotected, protected/],
    [{ gitlab: "protected" }, /config\.gitlab must be a map \(settings: token\)/],
    [{ gitlab: { tokn: "protected" } }, /config\.gitlab\.tokn is not a setting/],
    [{ forge: "github", gitlab: { token: "protected" } }, /config\.gitlab is for GitLab projects/],
  ])("%j is refused", (raw, message) => {
    expect(() => validateConfig(raw, "t")).toThrow(message);
  });

  it.each([
    [{ terragrunt: {} }],
    [{ terragrunt: { version: "1.1.6", exclude: ["catalog/**", "live/sandbox/**"], parallelism: 3, dependents: "follow" } }],
    [{ terragrunt: { version: "1.2.0-rc1", dependents: "plan" } }],
    [{ parallelism: 4 }],
    [{ apply: { when: "merge" } }],
    [{ apply: { when: "pull-request" } }],
    [{ apply: { when: "pull-request", merge: "auto" } }],
    [{ forge: "gitlab", comments: "*/5 * * * *", apply: { when: "pull-request", merge_token_env: "MERGE_TOKEN" } }],
    [{ forge: "gitlab", comments: "*/5 * * * *", apply: { when: "pull-request", merge: "auto", merge_token_env: "MERGE_TOKEN" } }],
    [{ apply: { when: "pull-request", merge: "auto", merge_token_env: "MERGE_TOKEN" } }],
    [{ locks: "plan" }],
    [{ rollouts: "*/15 * * * *", respond: { rollout: "off" } }],
    [{ rollouts: false }],
    [{ policy: { path: "policy", override: ["github:alice", "bob"] } }],
    [{ locks: "apply", forge: "gitlab" }],
    [{ forge: "gitlab", comments: "*/5 * * * *", gitlab: { token: "protected" } }],
    [{ forge: "gitlab", gitlab: { token: "unprotected" } }],
    [{ locks: "plan", apply: { when: "pull-request" }, forge: "forgejo" }],
    [{ binary: "tofu", terragrunt: { credentials: { "live/prod/**": { plan: "arn:aws:iam::111:role/plan", apply: "arn:aws:iam::111:role/apply" } } } }],
  ])("%j is accepted as written", (raw) => {
    expect(validateConfig(raw, "t")).toEqual(raw);
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

  it("a project's terragrunt keys override the defaults' one by one; credentials replace as a whole", () => {
    const tg = validateConfig(
      {
        defaults: { terragrunt: { version: "1.1.6", parallelism: 8, credentials: { "live/**": { plan: "p1", apply: "a1" } } } },
        projects: { "gitlab.com/a/b": { terragrunt: { parallelism: 3, credentials: { "live/prod/**": { plan: "p2", apply: "a2" } } } } },
      },
      "t",
    );
    expect(resolveProject(tg, "gitlab.com/a/b").terragrunt).toEqual({
      version: "1.1.6",
      parallelism: 3,
      credentials: { "live/prod/**": { plan: "p2", apply: "a2" } },
    });
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
    [{ projects: { "codeberg.org/a/b": { runtime: "forge" } } }, ["aws", "forgejo"]],
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
