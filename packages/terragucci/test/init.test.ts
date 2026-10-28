import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import { dashboardSettings, renderDashboards } from "../src/dashboards";
import { init } from "../src/init";
import { MARKER } from "../src/render";
import { git, tmp, twoRootRepo, write } from "./helpers";

function withRemote(remote: string): string {
  const dir = twoRootRepo();
  git(dir, "init", "-q");
  git(dir, "remote", "add", "origin", remote);
  return dir;
}

describe("init", () => {
  it.each([
    ["https://github.com/acme/infra.git", ".github/workflows/terragucci.yml", "github"],
    ["https://codeberg.org/acme/infra.git", ".forgejo/workflows/terragucci.yml", "forgejo"],
    ["git@gitlab.com:acme/infra.git", ".gitlab/terragucci.yml", "gitlab"],
  ])("own_jobs from a file in %s: init writes the jobs into the pipeline as they are, and again on the next init", async (remote, file, forge) => {
    const job = forge === "gitlab"
      ? 'explain:\n  stage: apply\n  needs: [apply-wave-1]\n  rules:\n    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH\n      when: on_failure\n  script:\n    - echo "wave 1 was refused: ${CI_JOB_ID}"\n'
      : 'explain:\n  needs: apply-wave-1\n  if: failure()\n  runs-on: ubuntu-latest\n  steps:\n    - run: echo "${{ github.run_id }}"\n      env: { KEY: "${{ secrets.KEY }}" }\n';
    const dir = write(withRemote(remote), { "terragucci.yml": "own_jobs: ci/own-jobs.yml\n", "ci/own-jobs.yml": job });
    const first = await init(dir, { binary: "tofu" });
    const text = readFileSync(join(dir, file), "utf-8");
    const doc = parseYAML(text) as Record<string, any>;
    const jobs = forge === "gitlab" ? doc : doc.jobs;
    expect(jobs.explain).toEqual(parseYAML(job).explain);
    expect(text).toContain("# Your own jobs, from own_jobs in terragucci.yml, as they are there.");
    // The next init writes the same file, own job and all.
    const again = await init(dir, { binary: "tofu" });
    expect(again.files.find((f) => f.path.endsWith(file))?.status).toBe("unchanged");
    expect(readFileSync(join(dir, file), "utf-8")).toBe(text);
    expect(first.files.find((f) => f.path.endsWith(file))?.status).toBe("created");
  });

  it("drift with binary: choudoufu runs for roots under live resource markers and for roots without them", async () => {
    const live = `terraform {\n  live {\n    estate = "shop-app"\n  }\n}\n\nresource "terraform_data" "x" {\n  input = 1\n}\n`;
    const stock = `terraform {\n  backend "s3" {\n    bucket = "b"\n    key    = "net.tfstate"\n  }\n}\n`;
    const repo = (files: Record<string, string>) => write(withRemote("https://codeberg.org/acme/infra.git"), files);
    await expect(init(repo({ "terragucci.yml": 'binary: choudoufu\ndrift: "0 6 * * *"\n', "app/main.tf": live, "net/main.tf": stock }), { dryRun: true })).resolves.toBeDefined();
    await expect(init(repo({ "terragucci.yml": 'binary: choudoufu\ndrift: "0 6 * * *"\n', "net/main.tf": stock, "net/estate.chdf.hcl": 'estate = "net"\n' }), { dryRun: true })).resolves.toBeDefined();
  });

  it("own_jobs refuses a missing file, a file that holds no jobs, and a name terragucci gives a job", async () => {
    const gh = (files: Record<string, string>) => write(withRemote("https://github.com/acme/infra.git"), files);
    await expect(init(gh({ "terragucci.yml": "own_jobs: ci/none.yml\n" }), { binary: "tofu", dryRun: true })).rejects.toThrow("own_jobs names ci/none.yml, which the repo does not have");
    await expect(init(gh({ "terragucci.yml": "own_jobs: ci/j.yml\n", "ci/j.yml": "- a\n- b\n" }), { binary: "tofu", dryRun: true })).rejects.toThrow("own_jobs (ci/j.yml) must be a map of job name to job");
    await expect(init(gh({ "terragucci.yml": "own_jobs: ci/j.yml\n", "ci/j.yml": "explain: []\n" }), { binary: "tofu", dryRun: true })).rejects.toThrow("own_jobs (ci/j.yml).explain must be a job");
    await expect(init(gh({ "terragucci.yml": "own_jobs:\n  check:\n    runs-on: ubuntu-latest\n" }), { binary: "tofu", dryRun: true })).rejects.toThrow("own_jobs.check: terragucci writes a job of that name");
    const gl = write(withRemote("git@gitlab.com:acme/infra.git"), { "terragucci.yml": "own_jobs:\n  variables:\n    script: [x]\n" });
    await expect(init(gl, { binary: "tofu", dryRun: true })).rejects.toThrow("own_jobs.variables: GitLab reads variables as a keyword");
  });

  it("comments on GitLab: the pipeline gets the comments job, and the note names the schedule and its variable", async () => {
    const dir = write(withRemote("git@gitlab.com:acme/infra.git"), { "terragucci.yml": "comments: \"*/5 * * * *\"\n" });
    const r = await init(dir, { binary: "tofu", dryRun: true });
    const pipeline = r.files.find((f) => f.path.endsWith(".gitlab/terragucci.yml"))!;
    expect(parseYAML(pipeline.content.split("\n").filter((l) => !l.startsWith("#")).join("\n")).comments).toBeDefined();
    expect(r.notes.join("\n")).toMatch(/comments is set: add a pipeline schedule with the cron \*\/5 \* \* \* \* and the variable TERRAGUCCI_SCHEDULE set to comments/);
    const gh = write(withRemote("https://github.com/acme/infra.git"), { "terragucci.yml": "comments: \"*/5 * * * *\"\n" });
    await expect(init(gh, { binary: "tofu", dryRun: true })).rejects.toThrow(/comments is for GitLab/);
  });

  it("rollouts writes the rollout workflow beside the pipeline, respond.rollout: off leaves it out, and init removes the one it wrote", async () => {
    const dir = write(withRemote("https://github.com/acme/infra.git"), { "terragucci.yml": 'rollouts: "*/15 * * * *"\n' });
    const before = await init(dir, { binary: "tofu", dryRun: true });
    let r = await init(dir, { binary: "tofu" });
    const path = join(dir, ".github/workflows/terragucci-rollout.yml");
    expect(r.files.map((f) => [f.path.slice(dir.length + 1), f.status])).toContainEqual([".github/workflows/terragucci-rollout.yml", "created"]);
    expect(readFileSync(path, "utf-8")).toContain("terragucci respond rollout --mode apply");
    // The pipeline is the one a repo without rollouts gets.
    const plain = await init(write(withRemote("https://github.com/acme/infra.git"), {}), { binary: "tofu", dryRun: true });
    expect(before.files[0]!.content).toBe(plain.files[0]!.content);

    write(dir, { "terragucci.yml": 'rollouts: "*/15 * * * *"\nrespond:\n  rollout: "off"\n' });
    r = await init(dir, { binary: "tofu", dryRun: true });
    expect(r.files.find((f) => f.path === path)?.status).toBe("removed");
    expect(r.notes).toContain("rollouts is set and respond.rollout is off, so no rollout job is written");
    r = await init(dir, { binary: "tofu" });
    expect(existsSync(path)).toBe(false);
    r = await init(dir, { binary: "tofu" });
    expect(r.files.some((f) => f.path === path)).toBe(false);
  });

  it("review.agent writes the review workflow beside the pipeline, refuses one it did not write, and removes the one it wrote once review is off", async () => {
    const dir = write(withRemote("https://github.com/acme/infra.git"), { "terragucci.yml": "review:\n  agent: true\n" });
    const path = join(dir, ".github/workflows/terragucci-review.yml");
    let r = await init(dir, { binary: "tofu" });
    expect(r.files.find((f) => f.path === path)?.status).toBe("created");
    expect(readFileSync(path, "utf-8")).toContain("workflow_run:");
    write(dir, { "terragucci.yml": "review:\n  agent: false\n" });
    r = await init(dir, { binary: "tofu" });
    expect(r.files.find((f) => f.path === path)?.status).toBe("removed");
    expect(existsSync(path)).toBe(false);
    write(dir, { "terragucci.yml": "review:\n  agent: true\n", ".github/workflows/terragucci-review.yml": "name: mine\n" });
    await expect(init(dir, { binary: "tofu", dryRun: true })).rejects.toThrow(/terragucci-review.yml exists and terragucci did not write it/);
  });

  it("rollouts refuses to overwrite a rollout workflow it did not write, and on GitLab names the schedule to add", async () => {
    const dir = write(withRemote("https://github.com/acme/infra.git"), { "terragucci.yml": 'rollouts: "*/15 * * * *"\n', ".github/workflows/terragucci-rollout.yml": "name: mine\n" });
    await expect(init(dir, { binary: "tofu", dryRun: true })).rejects.toThrow(/terragucci-rollout.yml exists and terragucci did not write it/);
    const gl = write(withRemote("git@gitlab.com:acme/infra.git"), { "terragucci.yml": 'rollouts: "*/15 * * * *"\n' });
    const r = await init(gl, { binary: "tofu", dryRun: true });
    expect(r.notes.join("\n")).toMatch(/rollouts is set: add a pipeline schedule with the cron \*\/15 \* \* \* \* and the variable TERRAGUCCI_SCHEDULE set to rollouts/);
  });

  it("apply.resume writes the resume workflow beside the pipeline, refuses one it did not write, and removes the one it wrote once apply.resume goes", async () => {
    const dir = write(withRemote("https://github.com/acme/infra.git"), { "terragucci.yml": "apply:\n  resume: 10\n" });
    const path = join(dir, ".github/workflows/terragucci-resume.yml");
    let r = await init(dir, { binary: "tofu" });
    expect(r.files.find((f) => f.path === path)?.status).toBe("created");
    expect(readFileSync(path, "utf-8").startsWith(MARKER)).toBe(true);
    write(dir, { "terragucci.yml": "gate: on-destructive\n" });
    r = await init(dir, { binary: "tofu", dryRun: true });
    expect(r.files.find((f) => f.path === path)?.status).toBe("removed");
    r = await init(dir, { binary: "tofu" });
    expect(existsSync(path)).toBe(false);
    r = await init(dir, { binary: "tofu" });
    expect(r.files.some((f) => f.path === path)).toBe(false);
    // A resume workflow terragucci did not write is neither overwritten nor removed.
    write(dir, { "terragucci.yml": "apply:\n  resume: 10\n", ".github/workflows/terragucci-resume.yml": "name: mine\n" });
    await expect(init(dir, { binary: "tofu", dryRun: true })).rejects.toThrow(/terragucci-resume.yml exists and terragucci did not write it/);
    write(dir, { "terragucci.yml": "gate: on-destructive\n" });
    r = await init(dir, { binary: "tofu", dryRun: true });
    expect(r.files.some((f) => f.path === path)).toBe(false);
  });

  it("apply.resume and ephemeral on GitLab: the notes name each schedule's cron and its TERRAGUCCI_SCHEDULE variable", async () => {
    const gl = write(withRemote("git@gitlab.com:acme/infra.git"), { "terragucci.yml": 'apply:\n  resume: 10\nephemeral:\n  roots: ["app"]\n  sweep: 15\n' });
    const notes = (await init(gl, { binary: "tofu", dryRun: true })).notes.join("\n");
    expect(notes).toMatch(/apply\.resume is set: add a pipeline schedule with the cron \*\/10 \* \* \* \* and the variable TERRAGUCCI_SCHEDULE set to resume/);
    expect(notes).toMatch(/ephemeral is set: add a pipeline schedule with the cron \*\/15 \* \* \* \* and the variable TERRAGUCCI_SCHEDULE set to ephemeral/);
    // The default sweep, 30 minutes.
    const dflt = write(withRemote("git@gitlab.com:acme/infra.git"), { "terragucci.yml": 'ephemeral:\n  roots: ["app"]\n' });
    expect((await init(dflt, { binary: "tofu", dryRun: true })).notes.join("\n")).toMatch(/cron \*\/30 \* \* \* \* and the variable TERRAGUCCI_SCHEDULE set to ephemeral/);
    // GitHub schedules both in workflows of its own, so no note asks for one.
    const gh = write(withRemote("https://github.com/acme/infra.git"), { "terragucci.yml": "apply:\n  resume: 10\n" });
    expect((await init(gh, { binary: "tofu", dryRun: true })).notes.join("\n")).not.toMatch(/TERRAGUCCI_SCHEDULE set to resume/);
  });

  it("gitlab.token: protected says how to protect the variable, writes the plan job with no token, and needs comments", async () => {
    const dir = write(withRemote("git@gitlab.com:acme/infra.git"), { "terragucci.yml": "comments: \"*/5 * * * *\"\ngitlab:\n  token: protected\n" });
    const r = await init(dir, { binary: "tofu", dryRun: true });
    const doc = parseYAML(r.files.find((f) => f.path.endsWith(".gitlab/terragucci.yml"))!.content.split("\n").filter((l) => !l.startsWith("#")).join("\n")) as Record<string, any>;
    expect(doc.plan.variables.TG_TOKEN).toBeUndefined();
    expect(r.notes.join("\n")).toMatch(/gitlab\.token is protected: under Settings > CI\/CD > Variables, edit GITLAB_TOKEN and tick Protect variable and Mask variable/);
    const bare = write(withRemote("git@gitlab.com:acme/infra.git"), { "terragucci.yml": "gitlab:\n  token: protected\n" });
    await expect(init(bare, { binary: "tofu", dryRun: true })).rejects.toThrow(/gitlab\.token: protected needs comments/);
    // The default names no protection: the plan job holds the token.
    expect((await init(withRemote("git@gitlab.com:acme/infra.git"), { binary: "tofu", dryRun: true })).notes.join("\n")).not.toMatch(/gitlab\.token/);
  });

  it("on GitLab, apply.when pull-request needs comments and a merge token, and then writes the mr-apply job", async () => {
    const dir = withRemote("git@gitlab.com:acme/infra.git");
    write(dir, { "terragucci.yml": "apply:\n  when: pull-request\n" });
    await expect(init(dir, { binary: "tofu" })).rejects.toThrow(/pull-request on GitLab needs comments: <cron>.*needs apply\.merge_token_env/);
    expect(existsSync(join(dir, ".gitlab-ci.yml"))).toBe(false);
    write(dir, { "terragucci.yml": "comments: \"*/5 * * * *\"\napply:\n  when: pull-request\n  merge: auto\n  merge_token_env: MERGE_TOKEN\n" });
    const r = await init(dir, { binary: "tofu", dryRun: true });
    const doc = parseYAML(r.files.find((f) => f.path.endsWith(".gitlab/terragucci.yml"))!.content.split("\n").filter((l) => !l.startsWith("#")).join("\n"));
    expect(Object.keys(doc)).toEqual(expect.arrayContaining(["mr-apply", "pr-merge", "confirm", "comments"]));
    expect(doc["apply-wave-1"]).toBeUndefined();
  });

  it.each([
    ["https://github.com/acme/infra.git", ".github/workflows/terragucci.yml"],
    ["git@gitlab.com:acme/infra.git", ".gitlab/terragucci.yml"],
    ["https://codeberg.org/acme/infra.git", ".forgejo/workflows/terragucci.yml"],
  ])("a repo whose origin is %s gets %s", async (remote, path) => {
    const dir = withRemote(remote);
    const r = await init(dir, { binary: "tofu" });
    // approval: ledger is the default, and it needs no chant.workspace.json. On GitLab the repo's .gitlab-ci.yml includes the pipeline.
    const gitlab = path.startsWith(".gitlab/");
    expect(r.files.map((f) => [f.path.slice(dir.length + 1), f.status])).toEqual([[path, "created"], ...(gitlab ? [] : [[".chant/op-waves/tf-apply.spec.json", "created"]]), ["chant.config.ts", "created"], ...(gitlab ? [[".gitlab-ci.yml", "created"]] : []), ["terragucci.components.json", "created"]]);
    const text = readFileSync(join(dir, path), "utf-8");
    expect(text.startsWith(MARKER)).toBe(true);
    const parsed = parseYAML(text.split("\n").filter((l) => !l.startsWith("#")).join("\n")) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(expect.arrayContaining(gitlab ? ["stages", "check", "apply-wave-1"] : ["name", "on", "jobs"]));
  });

  it("the pipeline applies the network before the app, and validates both", async () => {
    const dir = withRemote("https://github.com/acme/infra.git");
    const r = await init(dir, { binary: "tofu" });
    expect(r.layers).toEqual([["network"], ["app"]]);
    const text = readFileSync(r.files[0].path, "utf-8");
    expect(text).toContain("for dir in 'app' 'network'; do");
    // One job per wave: the network's wave first, and the app's needs it.
    expect(text).toContain("terragucci stage tf-apply --wave 1 --layers 'network;app'");
    expect(text).toContain("terragucci stage tf-apply --wave 2 --layers 'network;app'");
    expect(text).toMatch(/apply-wave-2:\n(?:.*\n)*? {4}needs: apply-wave-1\n/);
  });

  it("a second run changes nothing", async () => {
    const dir = withRemote("https://github.com/acme/infra.git");
    await init(dir, { binary: "tofu" });
    const again = await init(dir, { binary: "tofu" });
    expect(again.files.map((f) => f.status)).toEqual(["unchanged", "unchanged", "unchanged", "unchanged"]);
  });

  it("refuses to overwrite a pipeline file it did not write, unless forced", async () => {
    const dir = write(withRemote("https://github.com/acme/infra.git"), { ".github/workflows/terragucci.yml": "name: mine\n" });
    await expect(init(dir, { binary: "tofu" })).rejects.toThrow(/terragucci did not write it/);
    const forced = await init(dir, { binary: "tofu", force: true });
    expect(forced.files[0].status).toBe("updated");
  });

  it("an undetectable forge needs --forge, which is then saved to terragucci.yml", async () => {
    const dir = withRemote("https://git.example.com/acme/infra.git");
    await expect(init(dir)).rejects.toThrow(/pass --forge/);
    const r = await init(dir, { forge: "gitlab" });
    expect(r.configNote).toMatch(/records forge/);
    expect(readFileSync(join(dir, "terragucci.yml"), "utf-8")).toBe("forge: gitlab\n");
    expect((await init(dir)).files.map((f) => f.status)).toEqual(["unchanged", "unchanged", "unchanged", "unchanged"]);
  });

  it("a detectable choice is not written to terragucci.yml", async () => {
    const dir = withRemote("https://github.com/acme/infra.git");
    const r = await init(dir, { forge: "github" });
    expect(r.configNote).toBe("no terragucci.yml needed (defaults fit)");
    expect(existsSync(join(dir, "terragucci.yml"))).toBe(false);
  });

  it("a --binary that the config contradicts is noted, and one it lacks names the line to add", async () => {
    const dir = write(withRemote("https://github.com/acme/infra.git"), { "terragucci.yml": "binary: terraform\n" });
    const r = await init(dir, { binary: "tofu", dryRun: true });
    expect(r.notes.join("\n")).toMatch(/--binary tofu is ignored: terragucci.yml sets binary: terraform/);
    const bare = write(withRemote("https://github.com/acme/infra.git"), { "terragucci.yml": "roots: [network]\n" });
    await expect(init(bare, { binary: "choudoufu", dryRun: true })).rejects.toThrow(/terragucci.yml exists and init does not edit it; add binary: choudoufu to it/);
  });

  it("terragucci.yml roots, binary, version and env reach the pipeline", async () => {
    const dir = write(withRemote("https://github.com/acme/infra.git"), {
      "terragucci.yml": 'roots: ["network"]\nbinary: terraform\nversion: "1.14.9"\nenv:\n  AWS_REGION: eu-west-1\n',
    });
    const r = await init(dir);
    expect(r.roots).toEqual(["network"]);
    const text = readFileSync(r.files[0].path, "utf-8");
    expect(text).toContain("ghcr.io/intentius/terragucci-terraform:");
    expect(text).not.toContain("terragucci install");
    expect(text).toContain("AWS_REGION: eu-west-1");
    expect(text).not.toContain("'app'");
  });

  it("the canary wave and the gate policy reach the apply jobs", async () => {
    const dir = write(withRemote("https://github.com/acme/infra.git"), { "terragucci.yml": 'gate: always\nwaves:\n  canary: ["app"]\n' });
    const r = await init(dir, { binary: "tofu" });
    expect(r.notes.join("\n")).not.toMatch(/gated waves/);
    const text = readFileSync(r.files[0].path, "utf-8");
    expect(text).toContain("terragucci stage tf-apply --wave 1 --layers 'network;app' --canary 'app' --binary tofu --gate always");
    expect(text).toContain("apply-wave-2:");
    expect(text).not.toContain("apply-wave-3:");
  });

  it("under approval: sealed, chant.workspace.json lists every wave gate under identity.gates, so each needs a sealed approval", async () => {
    const dir = write(withRemote("https://github.com/acme/infra.git"), { "terragucci.yml": 'approval: sealed\nwaves:\n  canary: ["app"]\n' });
    await init(dir, { binary: "tofu" });
    expect(JSON.parse(readFileSync(join(dir, "chant.workspace.json"), "utf-8"))).toEqual({
      name: "infra",
      schema: 1,
      minReader: "0.102.0",
      members: [],
      identity: { gates: { "wave-1": {}, "wave-2": {} } },
    });
  });

  it("an existing chant.workspace.json keeps what it has and gains the gates it lacks", async () => {
    const mine = { name: "shop", schema: 1, minReader: "0.90.0", members: [{ name: "app", path: "app" }], identity: { gates: { "wave-1": { class: "human" } } } };
    const dir = write(withRemote("https://github.com/acme/infra.git"), { "chant.workspace.json": JSON.stringify(mine) });
    const r = await init(dir, { binary: "tofu" });
    expect(r.files.map((f) => f.status)).toEqual(["created", "created", "created", "updated", "created"]);
    expect(JSON.parse(readFileSync(join(dir, "chant.workspace.json"), "utf-8"))).toEqual({
      ...mine,
      minReader: "0.102.0",
      identity: { gates: { "wave-1": { class: "human" }, "wave-2": {} } },
    });
    expect((await init(dir, { binary: "tofu" })).files.map((f) => f.status)).toEqual(["unchanged", "unchanged", "unchanged", "unchanged", "unchanged"]);
  });

  it("under approval: ledger, the default, init writes no chant.workspace.json and the pipeline carries no --approval", async () => {
    const dir = withRemote("https://github.com/acme/infra.git");
    const r = await init(dir, { binary: "tofu" });
    expect(existsSync(join(dir, "chant.workspace.json"))).toBe(false);
    expect(readFileSync(r.files[0].path, "utf-8")).not.toContain("--approval");
  });

  it("approval: ledger drops the wave gates an earlier init listed and keeps the rest of the declaration", async () => {
    const mine = { name: "shop", schema: 1, minReader: "0.102.0", members: [], identity: { attribution: "identified", gates: { "wave-1": {}, "wave-2": {}, "deploy-prod": {} } } };
    const dir = write(withRemote("https://github.com/acme/infra.git"), { "terragucci.yml": "approval: ledger\n", "chant.workspace.json": JSON.stringify(mine) });
    const r = await init(dir, { binary: "tofu" });
    expect(r.files.map((f) => f.status)).toEqual(["created", "created", "created", "updated", "created"]);
    expect(JSON.parse(readFileSync(join(dir, "chant.workspace.json"), "utf-8"))).toEqual({ ...mine, identity: { attribution: "identified", gates: { "deploy-prod": {} } } });
    expect((await init(dir, { binary: "tofu" })).files.map((f) => f.status)).toEqual(["unchanged", "unchanged", "unchanged", "unchanged", "unchanged"]);
  });

  it("with no approval key, a declaration that lists wave gates stays sealed, and --approval ledger is saved and drops them", async () => {
    const mine = { name: "shop", schema: 1, minReader: "0.102.0", members: [], identity: { gates: { "wave-1": {}, "wave-2": {} } } };
    const dir = write(withRemote("https://github.com/acme/infra.git"), { "chant.workspace.json": JSON.stringify(mine) });
    expect((await init(dir, { binary: "tofu" })).files.map((f) => f.status)).toEqual(["created", "created", "created", "unchanged", "created"]);
    const r = await init(dir, { binary: "tofu", approval: "ledger" });
    expect(readFileSync(join(dir, "terragucci.yml"), "utf-8")).toBe("approval: ledger\n");
    expect(r.configNote).toMatch(/records approval/);
    expect(JSON.parse(readFileSync(join(dir, "chant.workspace.json"), "utf-8"))).toEqual({ name: "shop", schema: 1, minReader: "0.102.0", members: [] });
  });

  it("--approval sealed is saved to terragucci.yml and lists the wave gates", async () => {
    const dir = withRemote("https://github.com/acme/infra.git");
    await init(dir, { binary: "tofu", approval: "sealed" });
    expect(readFileSync(join(dir, "terragucci.yml"), "utf-8")).toBe("approval: sealed\n");
    expect(JSON.parse(readFileSync(join(dir, "chant.workspace.json"), "utf-8")).identity.gates).toEqual({ "wave-1": {}, "wave-2": {} });
  });

  it.each([
    ["never", "never"],
    ["on-destructive", "on-destructive"],
    ["always", "always"],
  ] as const)("--gate %s renders the pipeline with it and writes gate: into a new terragucci.yml", async (gate, want) => {
    const dir = withRemote("https://github.com/acme/infra.git");
    const r = await init(dir, { binary: "tofu", gate });
    expect(readFileSync(r.files[0].path, "utf-8")).toContain(`--gate ${want}`);
    expect(readFileSync(join(dir, "terragucci.yml"), "utf-8")).toBe(`gate: ${want}\n`);
    expect(r.configNote).toBe(`terragucci.yml records gate: ${want}`);
    // The next run reads the key, and changes nothing.
    const again = await init(dir, { binary: "tofu", gate });
    expect(again.files.every((f) => f.status === "unchanged")).toBe(true);
    expect(readFileSync(again.files[0].path, "utf-8")).toContain(`--gate ${want}`);
  });

  it("--gate adds gate: to an existing terragucci.yml and keeps the rest of it", async () => {
    const dir = write(withRemote("https://github.com/acme/infra.git"), { "terragucci.yml": "# ours\nbinary: tofu\n" });
    const dry = await init(dir, { gate: "never", dryRun: true });
    expect(dry.files.find((f) => f.path === join(dir, "terragucci.yml"))).toMatchObject({ status: "updated", content: "# ours\nbinary: tofu\ngate: never\n" });
    expect(readFileSync(join(dir, "terragucci.yml"), "utf-8")).toBe("# ours\nbinary: tofu\n");
    const r = await init(dir, { gate: "never" });
    expect(readFileSync(join(dir, "terragucci.yml"), "utf-8")).toBe("# ours\nbinary: tofu\ngate: never\n");
    expect(readFileSync(r.files[0].path, "utf-8")).toContain("--gate never");
    expect(r.configNote).toBe("terragucci.yml records gate: never");
  });

  it("--gate that differs from the config's gate is refused without --force, and with it replaces the line", async () => {
    const dir = write(withRemote("https://github.com/acme/infra.git"), { "terragucci.yml": "gate: always\nbinary: tofu\n" });
    await expect(init(dir, { gate: "never" })).rejects.toThrow("--gate never differs from terragucci.yml, which sets gate: always; pass --force to write gate: never into it, or drop --gate");
    expect(readFileSync(join(dir, "terragucci.yml"), "utf-8")).toBe("gate: always\nbinary: tofu\n");
    const r = await init(dir, { gate: "never", force: true });
    expect(readFileSync(join(dir, "terragucci.yml"), "utf-8")).toBe("gate: never\nbinary: tofu\n");
    expect(readFileSync(r.files[0].path, "utf-8")).toContain("--gate never");
  });

  it("--gate on-destructive agrees with a config that spells it on-destroy, and leaves the file alone", async () => {
    const dir = write(withRemote("https://github.com/acme/infra.git"), { "terragucci.yml": "gate: on-destroy\n" });
    const r = await init(dir, { binary: "tofu", gate: "on-destructive" });
    expect(r.files.some((f) => f.path === join(dir, "terragucci.yml"))).toBe(false);
    expect(readFileSync(join(dir, "terragucci.yml"), "utf-8")).toBe("gate: on-destroy\n");
  });

  it("a control repo's project carries its approval in the pipeline, which has no config of its own to read at base", async () => {
    const dir = withRemote("https://github.com/acme/infra.git");
    const r = await init(dir, { settings: { gate: "on-destructive", drift: false, runtime: "forge", tips: true, env: {}, binary: "tofu", approval: "sealed" } });
    const text = readFileSync(r.files[0].path, "utf-8");
    expect(text).toContain("--gate on-destructive --approval sealed");
    expect(JSON.parse(readFileSync(join(dir, "chant.workspace.json"), "utf-8")).identity.gates).toEqual({ "wave-1": {}, "wave-2": {} });
  });

  it("a repo with no roots is an error that says what a root is", async () => {
    const dir = write(tmp(), { "README.md": "x" });
    await expect(init(dir, { forge: "github" })).rejects.toThrow(/backend or a provider block/);
  });

  it("writes the dashboards the declarations render, from the template the bundle carries (#163)", async () => {
    const dir = write(withRemote("https://codeberg.org/acme/infra.git"), {
      "terragucci.yml": "binary: tofu\ndashboards: true\nreports:\n  bucket: s3://terragucci-reports\n  prefix: reports\n  url: http://localhost:4580/terragucci-reports\n",
    });
    const r = await init(dir, { dryRun: true });
    const written = r.files.filter((f) => f.path.includes("/observability/terragucci/")).map((f) => [f.path.slice(dir.length + 1), f.content]);
    const want = renderDashboards(dashboardSettings(true)!, { reports: "http://localhost:4580/terragucci-reports/reports" }).map((f) => [f.path, f.content]);
    expect(written).toEqual(want);
  });

  it("a control repo config is refused", async () => {
    const dir = write(withRemote("https://github.com/acme/infra.git"), { "terragucci.yml": "projects:\n  github.com/a/b: {}\n" });
    await expect(init(dir)).rejects.toThrow(/run terragucci reconcile instead/);
  });
});

describe("describeInit", async () => {
  const { describeInit } = await import("../src/init");
  it("a dry run says would write, and writes nothing", async () => {
    const dir = withRemote("https://github.com/acme/infra.git");
    const r = await init(dir, { binary: "tofu", dryRun: true });
    expect(describeInit(dir, r, true)).toContain("would write .github/workflows/terragucci.yml");
    expect(existsSync(join(dir, ".github"))).toBe(false);
  });
});
