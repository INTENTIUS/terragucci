import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import { gitlabCi } from "../src/gitlab-ci";
import { init } from "../src/init";
import { MARKER, renderPipeline } from "../src/render";
import { git, twoRootRepo, write } from "./helpers";

const included = renderPipeline({ forge: "gitlab", binary: "tofu", version: "1.13.1", image: "img:1", layers: [["network"], ["app"]], env: {} }).content;
const ENTRY = "  - local: .gitlab/terragucci.yml";

function gitlabRepo(files: Record<string, string> = {}): string {
  const dir = twoRootRepo();
  git(dir, "init", "-q");
  git(dir, "remote", "add", "origin", "git@gitlab.com:acme/infra.git");
  return write(dir, files);
}

describe("the included file", () => {
  it("keeps GitLab's default stages around terragucci's, so a job that names no stage still has one", () => {
    expect(parseYAML(included).stages).toEqual(["build", "test", "check", "plan", "apply", "tips", "deploy"]);
    expect(included.startsWith(MARKER)).toBe(true);
  });
});

describe("gitlabCi", () => {
  it("writes the whole file when there is none, when it is empty, or when terragucci wrote all of it", () => {
    for (const before of [undefined, "", `${MARKER}\nstages: [check]\n`]) {
      const text = gitlabCi(before, included);
      expect(text.startsWith(MARKER)).toBe(false);
      expect(parseYAML(text)).toEqual({ include: [{ local: ".gitlab/terragucci.yml" }] });
    }
  });

  it("adds the include above the first key of a file with none, below its comments", () => {
    const before = "# ours\n---\nvariables:\n  A: b\n\nunit:\n  script: [echo]\n";
    expect(gitlabCi(before, included)).toBe(`# ours\n---\ninclude:\n${ENTRY}\n\nvariables:\n  A: b\n\nunit:\n  script: [echo]\n`);
  });

  it("adds an entry to an include list, at its indent, and keeps the other entries", () => {
    const before = "include:\n    - template: Security/SAST.gitlab-ci.yml\n    - project: a/b\n      file: x.yml\nunit:\n  script: [echo]\n";
    const after = gitlabCi(before, included);
    expect(after).toBe(`include:\n    - local: .gitlab/terragucci.yml\n${before.slice("include:\n".length)}`);
    expect(parseYAML(after).include).toEqual([{ local: ".gitlab/terragucci.yml" }, { template: "Security/SAST.gitlab-ci.yml" }, { project: "a/b", file: "x.yml" }]);
  });

  it.each([
    "include: .gitlab/terragucci.yml\n",
    "include:\n  - /.gitlab/terragucci.yml\n",
    "include:\n  local: .gitlab/terragucci.yml\n",
    "include:\n  - local: ./.gitlab/terragucci.yml\n  - template: x.yml\n",
  ])("leaves a file that already includes it as it is: %j", (before) => {
    expect(gitlabCi(before, included)).toBe(before);
  });

  it("refuses an include it cannot add a line to, and says what to add", () => {
    expect(() => gitlabCi("include: other.yml\n", included)).toThrow(/write its include as a list and add `- local: \.gitlab\/terragucci\.yml` to it/);
    expect(() => gitlabCi("include: [other.yml]\n", included)).toThrow(/write its include as a list/);
  });

  it("refuses a job named as one of terragucci's, which GitLab would merge", () => {
    expect(() => gitlabCi("plan:\n  script: [echo]\napply-wave-1:\n  script: [echo]\n", included)).toThrow(/has jobs named plan, apply-wave-1/);
  });

  it("takes stages of the repo's own that list terragucci's in order, and refuses ones that do not", () => {
    expect(gitlabCi("stages: [lint, check, plan, apply, tips, ship]\n", included)).toContain(ENTRY);
    expect(() => gitlabCi("stages: [lint, check, apply]\n", included)).toThrow(/add check, plan, apply, tips to them, in that order/);
    expect(() => gitlabCi("stages: [plan, check, apply, tips]\n", included)).toThrow(/in that order/);
  });

  it("refuses a file that is not YAML", () => {
    expect(() => gitlabCi("a: [\n", included)).toThrow(/\.gitlab-ci\.yml is not YAML init can read/);
  });
});

describe("init on GitLab", () => {
  it("keeps the repo's own .gitlab-ci.yml, adds the include, and a second run changes nothing", async () => {
    const own = "unit-tests:\n  script:\n    - echo own\n";
    const dir = gitlabRepo({ ".gitlab-ci.yml": own });
    const r = await init(dir, { binary: "tofu" });
    expect(r.forge.value).toBe("gitlab");
    expect(r.files.map((f) => [f.path.slice(dir.length + 1), f.status])).toEqual([[".gitlab/terragucci.yml", "created"], [".gitlab-ci.yml", "updated"]]);
    expect(readFileSync(join(dir, ".gitlab-ci.yml"), "utf-8")).toBe(`include:\n${ENTRY}\n\n${own}`);
    expect(readFileSync(join(dir, ".gitlab/terragucci.yml"), "utf-8").startsWith(MARKER)).toBe(true);
    expect((await init(dir, { binary: "tofu" })).files.map((f) => f.status)).toEqual(["unchanged", "unchanged"]);
  });

  it("moves a pipeline terragucci wrote into .gitlab-ci.yml before into the included file", async () => {
    const dir = gitlabRepo();
    write(dir, { ".gitlab-ci.yml": `${MARKER}\nstages:\n  - check\n` });
    const r = await init(dir, { binary: "tofu" });
    expect(r.files.map((f) => f.status)).toEqual(["created", "updated"]);
    expect(parseYAML(readFileSync(join(dir, ".gitlab-ci.yml"), "utf-8"))).toEqual({ include: [{ local: ".gitlab/terragucci.yml" }] });
  });

  it("refuses an included file it did not write, unless forced, and never writes the repo's file in its place", async () => {
    const dir = gitlabRepo({ ".gitlab/terragucci.yml": "mine: {}\n" });
    await expect(init(dir, { binary: "tofu" })).rejects.toThrow(/\.gitlab\/terragucci\.yml exists and terragucci did not write it/);
    const forced = await init(dir, { binary: "tofu", force: true });
    expect(forced.files[0].status).toBe("updated");
  });

  it("a dry run writes neither file", async () => {
    const own = "unit-tests:\n  script: [echo]\n";
    const dir = gitlabRepo({ ".gitlab-ci.yml": own });
    await init(dir, { binary: "tofu", dryRun: true });
    expect(readFileSync(join(dir, ".gitlab-ci.yml"), "utf-8")).toBe(own);
  });
});
