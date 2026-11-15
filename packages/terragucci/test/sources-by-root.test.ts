import { describe, expect, it } from "vitest";
import { ConfigError, validateConfig, type SourcesByRoot } from "../src/config";
import { loadHclParser } from "../src/rollout/parser";
import { sourceListsIn } from "../src/root-config";
import { sourceChecker } from "../src/sources";
import { git, tmp, write } from "./helpers";

const parser = await loadHclParser();

const problems = (raw: unknown): string[] => {
  try {
    validateConfig(raw, "terragucci.yml");
    return [];
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    return e.problems ?? [e.message];
  }
};

const providerRoot = (source: string): string => `terraform {\n  required_providers {\n    p = {\n      source = "${source}"\n    }\n  }\n}\n`;

const BY_ROOT: SourcesByRoot = {
  "envs/prow*": { providers: ["hashicorp/http", "hashicorp/google"] },
  default: { providers: ["hashicorp/google"] },
};

describe("sources by root glob", () => {
  it("takes root globs with a default, and proxies beside them", () => {
    expect(problems({ sources: BY_ROOT })).toEqual([]);
    expect(problems({ sources: { ...BY_ROOT, proxies: [{ artifactory: "acme.jfrog.io", repo: "tf-remote" }] } })).toEqual([]);
  });

  it("refuses a map with no default, an empty entry, a stray key and lists beside root globs", () => {
    expect(problems({ sources: { "envs/**": { providers: ["hashicorp/*"] } } })[0]).toContain("config.sources.default is missing");
    expect(problems({ sources: { "envs/**": {}, default: { providers: ["hashicorp/*"] } } })[0]).toContain('config.sources["envs/**"] must be a map with modules, providers or both');
    expect(problems({ sources: { "envs/**": { provider: ["hashicorp/*"] }, default: { providers: ["hashicorp/*"] } } })[0]).toContain('config.sources["envs/**"].provider is not a setting');
    expect(problems({ sources: { modules: ["./**"], "envs/**": { providers: ["hashicorp/*"] }, default: { providers: ["hashicorp/*"] } } })[0]).toContain("config.sources.modules is beside root globs");
    expect(problems({ sources: { default: { providers: [] } } })[0]).toContain("config.sources.default.providers must be a list of source globs");
  });

  it("gives a root the first glob's lists, else the default, and an added root the default", () => {
    expect(sourceListsIn(BY_ROOT, {}, "envs/prow-build")).toEqual({ providers: ["hashicorp/http", "hashicorp/google"] });
    expect(sourceListsIn(BY_ROOT, {}, "envs/dev")).toEqual({ providers: ["hashicorp/google"] });
    expect(sourceListsIn(BY_ROOT, {}, "envs/prow-build", true)).toEqual({ providers: ["hashicorp/google"] });
    const first: SourcesByRoot = { "envs/**": { providers: ["hashicorp/google"] }, "envs/prow*": { providers: ["hashicorp/http"] }, default: { providers: [] } };
    expect(sourceListsIn(first, {}, "envs/prow-build")).toEqual({ providers: ["hashicorp/google"] });
  });

  it("reaches an instance by its own name or by its directory's glob", () => {
    const config = { instances: { "envs/prow": ["canary", "prod"] } };
    expect(sourceListsIn(BY_ROOT, config, "envs/prow@canary")).toEqual({ providers: ["hashicorp/http", "hashicorp/google"] });
    expect(sourceListsIn({ "envs/prow@canary": { providers: ["hashicorp/http"] }, default: { providers: ["hashicorp/google"] } }, config, "envs/prow@prod")).toEqual({ providers: ["hashicorp/google"] });
  });
});

describe("the checker with sources by root", () => {
  /** Two roots: `envs/prow` on http, and `envs/dev` on google with an http provider in a file of its own. */
  function repoWithHttp(): { repo: string } {
    const repo = tmp("tg-sources-byroot-");
    write(repo, { "envs/prow/main.tf": providerRoot("hashicorp/http"), "envs/dev/main.tf": providerRoot("hashicorp/google"), "envs/dev/extra.tf": providerRoot("hashicorp/http").replace("p =", "q =") });
    return { repo };
  }

  it("lets the root its glob names use http and refuses the others", async () => {
    const { repo } = repoWithHttp();
    const check = (await sourceChecker(repo, BY_ROOT, undefined, {}, { parser, afterInit: false }))!;
    expect(await check.before("envs/prow")).toEqual([]);
    const refused = await check.before("envs/dev");
    expect(refused).toHaveLength(1);
    expect(refused[0]).toContain("provider hashicorp/http");
    expect(refused[0]).toContain("sources.providers: hashicorp/google");
  });

  it("gives a root the pull request adds the default, though a glob of the base matches its path", async () => {
    // The base holds the list and the pull request's copy of it is ignored, so a pull request cannot widen it for its own new root.
    const repo = tmp("tg-sources-byroot-base-");
    git(repo, "init", "-q", "-b", "main");
    write(repo, { "terragucci.yml": `sources:\n  "envs/prow*":\n    providers: [hashicorp/http, hashicorp/google]\n  default:\n    providers: [hashicorp/google]\n`, "envs/prow/main.tf": providerRoot("hashicorp/http") });
    git(repo, "add", "-A");
    git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "base");
    const base = git(repo, "rev-parse", "HEAD").trim();
    git(repo, "checkout", "-q", "-b", "change");
    write(repo, { "envs/prow-copy/main.tf": providerRoot("hashicorp/http"), "terragucci.yml": "sources:\n  default:\n    providers: [hashicorp/http]\n" });
    git(repo, "add", "-A");
    git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "change");
    const check = (await sourceChecker(repo, { default: { providers: ["hashicorp/http"] } }, base, {}, { parser, afterInit: false }))!;
    expect(await check.before("envs/prow")).toEqual([]);
    const refused = await check.before("envs/prow-copy");
    expect(refused).toHaveLength(1);
    expect(refused[0]).toContain("provider hashicorp/http");
  });

  it("checks the instances of one directory against its glob's lists", async () => {
    const repo = tmp("tg-sources-byroot-inst-");
    write(repo, { "terragucci.yml": "instances:\n  envs/prow: [canary, prod]\n", "envs/prow/main.tf": providerRoot("hashicorp/http") });
    const check = (await sourceChecker(repo, BY_ROOT, undefined, {}, { parser, afterInit: false }))!;
    expect(await check.before("envs/prow@canary")).toEqual([]);
    const other = (await sourceChecker(repo, { default: { providers: ["hashicorp/google"] } }, undefined, {}, { parser, afterInit: false }))!;
    expect(await other.before("envs/prow@canary")).toHaveLength(1);
  });

  it("with lists for every root behaves as before", async () => {
    const { repo } = repoWithHttp();
    const check = (await sourceChecker(repo, { providers: ["hashicorp/google"] }, undefined, {}, { parser, afterInit: false }))!;
    expect(await check.before("envs/prow")).toHaveLength(1);
    const wide = (await sourceChecker(repo, { providers: ["hashicorp/google", "hashicorp/http"] }, undefined, {}, { parser, afterInit: false }))!;
    expect(await wide.before("envs/prow")).toEqual([]);
    expect(await wide.before("envs/dev")).toEqual([]);
  });
});
