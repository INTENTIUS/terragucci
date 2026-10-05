/**
 * respond version-bump (terragucci#32): the model is asked for a bump only when
 * no commit since a module's last release carries a conventional type.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { validateConfig } from "../src/config";
import type { DecideFetch, DecideSettings } from "../src/decide";
import { LAYA_MODEL } from "../src/images";
import { respond } from "../src/respond";
import { isConventional, versionBumps } from "../src/respond/version-bump";
import { git, tmp, write } from "./helpers";

const SETTINGS: DecideSettings = { backend: "laya", url: "http://decide.test" };

/** A decision service that answers the bump question with these probabilities, and records every call. */
function service(probabilities: Record<string, number>): { fetch: DecideFetch; calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  const choice = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]![0];
  const fetch: DecideFetch = async (_url, init) => {
    calls.push(JSON.parse(init.body) as Record<string, unknown>);
    const text = JSON.stringify({ model: LAYA_MODEL, answers: { bump: { type: "choice", choice, probabilities } } });
    return { ok: true, status: 200, text: async () => text };
  };
  return { fetch, calls };
}

/** A repo whose module `net` was released at 1.2.0 and then changed by `messages`, one commit each. */
function repoWith(messages: string[], extra: Record<string, string> = {}): string {
  const dir = write(tmp(), { "modules/net/main.tf": 'variable "cidr" {}\n', ...extra });
  const commit = (m: string) => git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-qam", m);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "add", "-A");
  commit("first");
  git(dir, "tag", "modules/net/v1.2.0");
  messages.forEach((m, i) => {
    writeFileSync(join(dir, "modules/net/main.tf"), `variable "cidr" {}\nvariable "extra${i}" {}\n`);
    commit(m);
  });
  return dir;
}

describe("version-bump: conventional commits bypass the model", () => {
  it("never calls the service when a commit has a conventional type", async () => {
    for (const messages of [["feat: an IPv6 block"], ["fix(net): tag it", "tidy up"], ["rework the subnets", "chore: bump"], ["drop v4\n\nBREAKING CHANGE: v4 is gone"]]) {
      const { fetch, calls } = service({ major: 0.1, minor: 0.1, patch: 0.8 });
      const out = await versionBumps(repoWith(messages), { decide: SETTINGS }, { fetch });
      expect(calls).toEqual([]);
      expect(out.proposals).toEqual([]);
      expect(out.suggestions[0]).toMatchObject({ module: "modules/net", source: "conventional" });
    }
  });

  it("decides the bump as tf-publish does", async () => {
    const { fetch } = service({ major: 0.1, minor: 0.1, patch: 0.8 });
    const bump = async (messages: string[]) => (await versionBumps(repoWith(messages), { decide: SETTINGS }, { fetch })).suggestions[0]!.version;
    expect(await bump(["feat: a"])).toBe("1.3.0");
    expect(await bump(["fix: a"])).toBe("1.2.1");
    expect(await bump(["feat!: a"])).toBe("2.0.0");
  });

  it("never calls the service for a module with a version file, or with no commits since its release", async () => {
    const { fetch, calls } = service({ major: 0.1, minor: 0.1, patch: 0.8 });
    const pinned = await versionBumps(repoWith(["rework the subnets"], { "modules/net/version": "1.5.0\n" }), { decide: SETTINGS }, { fetch });
    expect(pinned.suggestions[0]!.note).toContain("overrides");
    const idle = await versionBumps(repoWith([]), { decide: SETTINGS }, { fetch });
    expect(idle.suggestions[0]!.note).toBe("no commits since the last release");
    expect(calls).toEqual([]);
  });

  it("tells a conventional message from free text", () => {
    expect(["feat: x", "Fix(api): y", "refactor!: z", "x\n\nBREAKING CHANGE: y"].map(isConventional)).toEqual([true, true, true, true]);
    expect(["rework the subnets", "Merge branch 'x'", "wip: thing", "update: x"].map(isConventional)).toEqual([false, false, false, false]);
  });
});

describe("version-bump: free-text commits", () => {
  it("shows a confident suggestion with its probability in the release pull request", async () => {
    const { fetch, calls } = service({ major: 0.05, minor: 0.85, patch: 0.1 });
    const out = await versionBumps(repoWith(["add an extra input to the network module"]), { decide: SETTINGS }, { fetch });
    expect(calls).toHaveLength(1);
    const asked = calls[0]!;
    expect(JSON.stringify(asked.state)).toContain("add an extra input to the network module");
    expect(JSON.stringify(asked.state)).toContain('+variable \\"extra0\\"');
    expect(out.suggestions[0]).toMatchObject({ source: "suggested", bump: "minor", version: "1.3.0", probability: 0.85 });
    const [p] = out.proposals;
    expect(p!.title).toBe("Release modules/net 1.3.0");
    expect(p!.files.get("modules/net/version")).toBe("1.3.0\n");
    expect(p!.body).toContain("Suggested bump: **minor**, 1.2.0 to 1.3.0, with probability 0.85");
    expect(p!.body).toContain("Nothing is published until then");
  });

  it("omits a suggestion below the threshold and proposes patch with a note", async () => {
    const { fetch } = service({ major: 0.3, minor: 0.4, patch: 0.3 });
    const out = await versionBumps(repoWith(["rework the subnets"]), { decide: SETTINGS }, { fetch });
    expect(out.suggestions[0]).toMatchObject({ source: "default", bump: "patch", version: "1.2.1" });
    expect(out.suggestions[0]!.probability).toBeUndefined();
    expect(out.proposals[0]!.body).toContain("Proposed bump: patch, 1.2.0 to 1.2.1");
    expect(out.proposals[0]!.body).toContain("below the 0.70 threshold");
    expect(out.proposals[0]!.body).not.toContain("Suggested bump");
  });

  it("proposes patch when the service is off or unreachable", async () => {
    const off = await versionBumps(repoWith(["rework the subnets"]), {}, {});
    expect(off.suggestions[0]).toMatchObject({ source: "default", version: "1.2.1" });
    const down: DecideFetch = async () => {
      throw new Error("connection refused");
    };
    const unreachable = await versionBumps(repoWith(["rework the subnets"]), { decide: SETTINGS }, { fetch: down });
    expect(unreachable.suggestions[0]).toMatchObject({ source: "default", version: "1.2.1" });
    expect(unreachable.proposals[0]!.body).toContain("did not answer");
  });
});

describe("respond version-bump", () => {
  const config = "respond:\n  version-bump: suggest\ndecide:\n  backend: laya\n  url: http://decide.test\n";

  it("is off until it is set, and takes suggest", async () => {
    expect(() => validateConfig({ respond: { "version-bump": "suggest" } }, "terragucci.yml")).not.toThrow();
    expect(() => validateConfig({ respond: { "version-bump": "guess" } }, "terragucci.yml")).toThrow();
    const dir = repoWith(["rework the subnets"], { "terragucci.yml": "{}\n" });
    expect(await respond("version-bump", dir, {})).toMatchObject({ response: "off", skipped: "respond.version-bump is off" });
  });

  it("lists the suggestion and the pull request it would open in a dry run, and publishes nothing", async () => {
    const dir = repoWith(["add an extra input to the network module"], { "terragucci.yml": config });
    const { fetch } = service({ major: 0.05, minor: 0.85, patch: 0.1 });
    const r = await respond("version-bump", dir, { decideFetch: fetch });
    expect(r.text).toContain("modules/net 1.2.0 -> 1.3.0");
    expect(r.text).toContain("minor (0.85, threshold 0.70");
    expect(r.proposals).toEqual([{ branch: "terragucci/release/modules-net", title: "Release modules/net 1.3.0", files: ["modules/net/version"], state: "would-open" }]);
    expect(git(dir, "tag", "--list", "modules/net/*").trim()).toBe("modules/net/v1.2.0");
  });

  it("does not call the service for conventional commits", async () => {
    const dir = repoWith(["fix: tag it"], { "terragucci.yml": config });
    const { fetch, calls } = service({ major: 0.05, minor: 0.85, patch: 0.1 });
    const r = await respond("version-bump", dir, { decideFetch: fetch });
    expect(calls).toEqual([]);
    expect(r.proposals).toEqual([]);
    expect(r.text).toContain("modules/net 1.2.0 -> 1.2.1");
  });
});

describe("version-bump --since", () => {
  /** A repo with no release tag: `base` is the commit to count from. */
  function untagged(messages: string[], versionAtBase?: string): { dir: string; base: string } {
    const dir = write(tmp(), { "modules/net/main.tf": 'variable "cidr" {}\n', ...(versionAtBase ? { "modules/net/version": `${versionAtBase}\n` } : {}) });
    const commit = (m: string) => git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-qam", m);
    git(dir, "init", "-q", "-b", "main");
    git(dir, "add", "-A");
    commit("first");
    const base = git(dir, "rev-parse", "HEAD").trim();
    messages.forEach((m, i) => {
      writeFileSync(join(dir, "modules/net/main.tf"), `variable "cidr" {}\nvariable "extra${i}" {}\n`);
      commit(m);
    });
    return { dir, base };
  }

  it("without it, a module with no tag is the first release", async () => {
    const { dir } = untagged(["feat: a"]);
    const out = await versionBumps(dir, { decide: SETTINGS }, {});
    expect(out.suggestions[0]).toMatchObject({ last: "none", source: "none" });
  });

  it("counts commits from the ref and bumps the version file there", async () => {
    const { dir, base } = untagged(["feat: an IPv6 block"], "1.2.0");
    const out = await versionBumps(dir, { decide: SETTINGS }, { since: base });
    expect(out.suggestions[0]).toMatchObject({ module: "modules/net", last: "1.2.0", source: "conventional", version: "1.3.0" });
  });

  it("asks the model when the commits are not conventional", async () => {
    const { dir, base } = untagged(["rework the subnets"], "1.2.0");
    const { fetch, calls } = service({ major: 0.05, minor: 0.9, patch: 0.05 });
    const out = await versionBumps(dir, { decide: SETTINGS }, { since: base, fetch });
    expect(calls).toHaveLength(1);
    expect(out.suggestions[0]).toMatchObject({ source: "suggested", bump: "minor", version: "1.3.0" });
  });

  it("starts from 0.0.0 when the module had no version file at the ref", async () => {
    const { dir, base } = untagged(["fix: a"]);
    expect((await versionBumps(dir, { decide: SETTINGS }, { since: base })).suggestions[0]).toMatchObject({ last: "0.0.0", version: "0.0.1" });
  });

  it("says so for a ref that does not exist, and the module's own tags win over it", async () => {
    const { dir } = untagged(["feat: a"]);
    expect((await versionBumps(dir, { decide: SETTINGS }, { since: "nope" })).suggestions[0]!.note).toMatch(/not a ref/);
    const tagged = repoWith(["fix: a"]);
    expect((await versionBumps(tagged, { decide: SETTINGS }, { since: "HEAD" })).suggestions[0]).toMatchObject({ last: "1.2.0", version: "1.2.1" });
  });
});
