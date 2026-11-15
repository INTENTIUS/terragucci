import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { adoptArgs, adoptExit, adoptModule, describeAdopt, gitParts } from "../src/modules-adopt";
import { continueRollouts, rollout, waveBranch } from "../src/rollout";
import type { CommitCheck, RolloutForge, WavePullRequest } from "../src/rollout/forge";
import { loadHclParser } from "../src/rollout/parser";
import { LOCAL_FROM } from "../src/rollout/adopt";
import { adoptLocal } from "../src/rollout/range";
import { backend, bareFrom, git, remoteState, tmp, write } from "./helpers";

const MODULE = `variable "name" {\n  type = string\n}\n\noutput "name" {\n  value = var.name\n}\n`;
const call = (name: string, source = "../modules/x", extra = "") => `module "${name}" {\n  source = "${source}"\n${extra}  name   = "${name}"\n}\n`;

class MemoryForge implements RolloutForge {
  prs = new Map<string, WavePullRequest & { title: string }>();
  checks = new Map<string, CommitCheck[]>();
  asked = 0;
  constructor(readonly bare: string) {}
  async defaultBranch() {
    this.asked++;
    return "main";
  }
  async findPullRequest(branch: string) {
    this.asked++;
    return this.prs.get(branch) ?? null;
  }
  async createPullRequest(pr: { base: string; head: string; title: string; body: string }) {
    const url = `https://forge/pull/${this.prs.size + 1}`;
    this.prs.set(pr.head, { url, state: "open", body: pr.body, title: pr.title });
    return url;
  }
  async commitChecks(sha: string) {
    return this.checks.get(sha) ?? [];
  }
  async listPullRequests(prefix: string) {
    return [...this.prs].filter(([b]) => b.startsWith(prefix)).reverse().map(([branch, pr]) => ({ branch, url: pr.url, title: pr.title, state: pr.state, body: pr.body }));
  }
  mergeAndApply(branch: string): void {
    const work = tmp();
    git(work, "clone", "-q", this.bare, ".");
    git(work, "-c", "user.name=t", "-c", "user.email=t@t", "merge", "-q", "--no-ff", "-m", "merge", `origin/${branch}`);
    git(work, "push", "-q", "origin", "main");
    const sha = git(work, "rev-parse", "HEAD").trim();
    this.prs.set(branch, { ...this.prs.get(branch)!, state: "merged", mergeCommit: sha });
    this.checks.set(sha, [{ name: "terragucci / apply (push)", state: "success" }]);
  }
}

/** A git repository that publishes modules/x: the module's files, tagged `modules/x/v<version>` for each version given. */
function publisher(content = MODULE, versions = ["1.0.0"]): { url: string; source: string } {
  const dir = write(tmp("terragucci-source-"), { "modules/x/main.tf": content });
  git(dir, "init", "-q", "-b", "main");
  git(dir, "add", "-A");
  git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "release");
  for (const v of versions) git(dir, "tag", `modules/x/v${v}`);
  return { url: dir, source: `git::file://${dir}//modules/x` };
}

/** Roots a1, a2 (reads a1's state) and b call modules/x by path; modules/y, which is no root, calls it too; c does not. */
function estate(more: Record<string, string> = {}): { repo: string; bare: string } {
  const dir = write(tmp(), {
    "modules/x/main.tf": MODULE,
    "modules/y/main.tf": call("inner", "../x"),
    "a1/main.tf": backend("a1.tfstate") + call("x"),
    "a2/main.tf": backend("a2.tfstate") + remoteState("a1.tfstate") + call("x") + call("again"),
    "b/main.tf": backend("b.tfstate") + call("x"),
    "c/main.tf": backend("c.tfstate") + call("y", "../modules/y"),
    ...more,
  });
  const bare = bareFrom(dir);
  const repo = tmp();
  git(repo, "clone", "-q", bare, ".");
  return { repo, bare };
}

describe("adoptLocal", () => {
  it("rewrites the source literal of each call that names the directory, and no other byte", async () => {
    const parser = await loadHclParser();
    const text = `# a\n${call("one", "../modules/x", "  # held\n")}${call("two", "../modules/z")}${call("three", "./../modules/x")}`;
    const out = await adoptLocal(text, "a/main.tf", { dir: "modules/x", source: "git::https://h/o/r.git//modules/x?ref=modules/x/v1.0.0" }, parser);
    expect(out.calls).toEqual([{ call: "module.one", outcome: "moved" }, { call: "module.three", outcome: "moved" }]);
    expect(out.content).toBe(text.replaceAll(`source = "../modules/x"`, `source = "git::https://h/o/r.git//modules/x?ref=modules/x/v1.0.0"`).replace(`source = "./../modules/x"`, `source = "git::https://h/o/r.git//modules/x?ref=modules/x/v1.0.0"`));
  });

  it("adds a version line for a registry address", async () => {
    const parser = await loadHclParser();
    const text = call("one");
    const out = await adoptLocal(text, "a/main.tf", { dir: "modules/x", source: "mods.example.com/acme/x/generic", version: "1.0.0" }, parser);
    expect(out.content).toBe(`module "one" {\n  source = "mods.example.com/acme/x/generic"\n  version = "1.0.0"\n  name   = "one"\n}\n`);
  });

  it("refuses a call with a version argument or a source that is not a literal, and writes nothing", async () => {
    const parser = await loadHclParser();
    const withVersion = call("one", "../modules/x", `  version = "1.0.0"\n`);
    const a = await adoptLocal(withVersion, "a/main.tf", { dir: "modules/x", source: "x" }, parser);
    expect(a.calls[0]).toMatchObject({ outcome: "refused" });
    expect(a.content).toBe(withVersion);
    const expr = `module "one" {\n  source = "\${path.module}/../modules/x"\n}\n`;
    expect((await adoptLocal(expr, "a/main.tf", { dir: "modules/x", source: "x" }, parser)).calls).toEqual([]);
  });
});

describe("gitParts", () => {
  it("splits a git source at the directory, not at the scheme", () => {
    expect(gitParts("git::https://h/o/r.git//modules/x")).toEqual({ url: "https://h/o/r.git", subdir: "modules/x" });
    expect(gitParts("git::file:///tmp/r//modules/x")).toEqual({ url: "file:///tmp/r", subdir: "modules/x" });
    expect(() => gitParts("git::https://h/o/r.git")).toThrow(/directory/);
  });
});

describe("terragucci modules adopt", () => {
  it("lists the callers and the waves with --dry-run, and asks no forge", async () => {
    const { repo } = estate();
    const pub = publisher();
    const forge = new MemoryForge("unused");
    const r = await adoptModule(repo, "modules/x", { tableOnly: true, source: pub.source, rollout: { forge: () => forge } });
    expect(forge.asked).toBe(0);
    expect(r.version).toBe("1.0.0");
    expect(r.compared).toBe(true);
    expect(r.source).toBe(`${pub.source}?ref=modules/x/v1.0.0`);
    expect(r.callers.map((c) => [c.dir, c.call, c.state])).toEqual([
      ["a1", "module.x", "local"],
      ["a2", "module.again", "local"],
      ["a2", "module.x", "local"],
      ["b", "module.x", "local"],
      ["modules/y", "module.inner", "left"],
    ]);
    expect(r.rollout!.from).toBe(LOCAL_FROM);
    expect(r.rollout!.waves.map((w) => w.parts.map((p) => p.roots))).toEqual([[["a1", "b"]], [["a2"]]]);
    expect(adoptExit(r)).toBe(0);
    const text = describeAdopt(r);
    expect(text).toContain("to adopt");
    expect(text).toContain("left: a module's call");
    expect(text).toContain("wave 2");
  }, 60_000);

  it("opens a pull request per wave that moves only its roots, then an ordinary rollout moves the module", async () => {
    const { repo, bare } = estate();
    const pub = publisher(MODULE, ["1.0.0", "1.1.0"]);
    const forge = new MemoryForge(bare);
    const opts = { mode: "apply" as const, source: pub.source, version: "1.0.0", rollout: { forge: () => forge } };
    const first = await adoptModule(repo, "modules/x", opts);
    const w1 = waveBranch("modules/x", "1.0.0", 1, LOCAL_FROM);
    const w2 = waveBranch("modules/x", "1.0.0", 2, LOCAL_FROM);
    expect(first.rollout!.status).toBe("opened");
    const changed = (branch: string) => git(bare, "diff", "--name-only", `main...${branch}`).trim().split("\n");
    expect(changed(w1)).toEqual(["a1/main.tf", "b/main.tf"]);
    const pinned = `${pub.source}?ref=modules/x/v1.0.0`;
    expect(git(bare, "show", `${w1}:a1/main.tf`)).toContain(`source = "${pinned}"`);
    expect(git(bare, "show", `${w1}:a2/main.tf`)).toContain(`source = "../modules/x"`);
    expect(forge.prs.get(w1)!.body).toContain("should show no changes");
    expect(forge.prs.get(w1)!.title).toContain("adopt modules/x at 1.0.0, wave 1 of 2");
    expect(readFileSync(join(repo, "a1/main.tf"), "utf-8")).toContain(`source = "../modules/x"`);

    forge.mergeAndApply(w1);
    const next = await continueRollouts(repo, { mode: "apply", forge: () => forge });
    expect(next.rollouts.map((x) => x.action)).toEqual(["ran"]);
    expect(changed(w2)).toEqual(["a2/main.tf"]);
    const a2 = git(bare, "show", `${w2}:a2/main.tf`);
    expect(a2.match(new RegExp(pinned.replaceAll("/", "\\/").replace("?", "\\?"), "g"))).toHaveLength(2);
    forge.mergeAndApply(w2);

    // Every caller names the pinned source: a rollout of the module now moves it.
    const again = await rollout(repo, { kind: "module", name: "modules/x", to: "1.1.0", mode: "dry-run", forge: () => forge });
    expect(again.from).toBe("1.0.0");
    expect(again.waves.flatMap((w) => w.parts.flatMap((p) => p.roots)).sort()).toEqual(["a1", "a2", "b"]);
    // And a second adopt has nothing left to move.
    const done = await adoptModule(repo, "modules/x", { ...opts, mode: "dry-run" });
    expect(done.rollout?.status ?? "none").toBe("complete");
  }, 120_000);

  it("takes the newest published version when none is named", async () => {
    const { repo } = estate();
    const pub = publisher(MODULE, ["1.0.0", "1.2.0", "1.10.0"]);
    const r = await adoptModule(repo, "modules/x", { tableOnly: true, source: pub.source });
    expect(r.version).toBe("1.10.0");
  }, 60_000);

  it("refuses a directory that differs from its release, naming the file", async () => {
    const { repo } = estate();
    const pub = publisher(MODULE + `\nlocals {\n  a = 1\n}\n`);
    await expect(adoptModule(repo, "modules/x", { tableOnly: true, source: pub.source })).rejects.toThrow(/differs from its release 1\.0\.0 in main\.tf/);
  }, 60_000);

  it("says what to publish when the version has no tag, and when nothing is published", async () => {
    const { repo } = estate();
    const pub = publisher();
    await expect(adoptModule(repo, "modules/x", { tableOnly: true, source: pub.source, version: "2.0.0" })).rejects.toThrow(/no tag modules\/x\/v2\.0\.0.*terragucci publish/);
    const none = publisher(MODULE, []);
    await expect(adoptModule(repo, "modules/x", { tableOnly: true, source: none.source })).rejects.toThrow(/found no published version of modules\/x/);
    await expect(adoptModule(repo, "modules/x", { tableOnly: true })).rejects.toThrow(/nothing says where modules\/x is published/);
  }, 60_000);

  it("compares with the files an injected source gives, for a registry address that is not fetched", async () => {
    const { repo } = estate();
    const seen: string[] = [];
    const r = await adoptModule(repo, "modules/x", {
      tableOnly: true,
      source: "mods.example.com/acme/x/generic",
      version: "1.0.0",
      published: (t, v) => {
        seen.push(`${t.kind} ${v}`);
        return join(repo, "modules/x");
      },
    });
    expect(seen).toEqual(["registry 1.0.0"]);
    expect(r.compared).toBe(true);
    expect(r.source).toBe(`mods.example.com/acme/x/generic (version = "1.0.0")`);
    const without = await adoptModule(repo, "modules/x", { tableOnly: true, source: "oci://reg.example.com/acme/x", version: "1.0.0" });
    expect(without.compared).toBe(false);
    expect(describeAdopt(without)).toContain("were not compared");
  }, 60_000);

  it("refuses an OCI release of a directory that calls a module outside itself", async () => {
    const { repo } = estate();
    write(repo, { "modules/x/more.tf": call("sib", "../y") });
    await expect(adoptModule(repo, "modules/x", { tableOnly: true, source: "oci://reg.example.com/acme/x", version: "1.0.0" })).rejects.toThrow(/outside itself/);
  }, 60_000);

  it("stops a root whose call cannot be edited out of the rollout, with a tip, before any wave", async () => {
    const { repo } = estate({ "b/main.tf": backend("b.tfstate") + call("x", "../modules/x", `  version = "1.0.0"\n`) });
    const pub = publisher();
    const r = await adoptModule(repo, "modules/x", { tableOnly: true, source: pub.source });
    expect(r.rollout!.roots.find((x) => x.root === "b")).toMatchObject({ state: "refused" });
    expect(r.rollout!.roots.find((x) => x.root === "b")!.reason).toContain("cannot adopt");
    expect(r.rollout!.tips.map((t) => t.rule)).toEqual(["rollout-adopt"]);
    expect(r.rollout!.waves.map((w) => w.parts.map((p) => p.roots))).toEqual([[["a1"]], [["a2"]]]);
  }, 60_000);

  it("parses its arguments and refuses a source with a pin or a directory outside the repository", async () => {
    expect(adoptArgs(["modules/x"], { "dry-run": true, source: "oci://r/x", version: "1.0.0" })).toEqual({ dir: "modules/x", options: { mode: "dry-run", tableOnly: true, source: "oci://r/x", version: "1.0.0" } });
    expect(() => adoptArgs([], {})).toThrow(/usage/);
    const { repo } = estate();
    await expect(adoptModule(repo, "modules/x", { tableOnly: true, source: "git::https://h/o/r.git//modules/x?ref=v1" })).rejects.toThrow(/carries a pin/);
    await expect(adoptModule(repo, "../elsewhere", { tableOnly: true })).rejects.toThrow(/not a directory in this repository/);
  }, 60_000);
});
