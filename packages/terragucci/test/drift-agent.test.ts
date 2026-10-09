import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import { AGENT_COMMAND, agentDriftInput } from "../src/agent-comment";
import { ConfigError, validateConfig } from "../src/config";
import { DRIFT_ISSUE_JS, driftPrompt, pushDriftChange, writeDriftPrompt } from "../src/drift-agent";
import type { Fetch } from "../src/forge";
import { driftScript, renderPipeline } from "../src/render";
import type { Report } from "../src/report/schema";
import { git, tmp, write } from "./helpers";

const OIDC = { plan_role: "arn:aws:iam::111:role/plan-ro", apply_role: "arn:aws:iam::111:role/apply-rw" };
const layers = [["network"], ["app"]];
const body = (text: string): Record<string, any> => parseYAML(text.split("\n").filter((l) => !l.startsWith("#")).join("\n")) as Record<string, any>;
const problemsOf = (raw: unknown): string[] => {
  try {
    validateConfig(raw, "t");
    return [];
  } catch (e) {
    return (e as ConfigError).problems ?? [(e as Error).message];
  }
};

const base = { via: "forge", token_env: "AGENT_FORGE_TOKEN" };

describe("agent.drift in terragucci.yml", () => {
  it("is off by default, takes the comment's defaults with true, and its own settings", () => {
    expect(agentDriftInput(validateConfig({ agent: base }, "t"))).toBeUndefined();
    expect(agentDriftInput(validateConfig({ drift: "0 6 * * *", respond: { drift: "off" }, agent: { ...base, drift: false } }, "t"))).toBeUndefined();
    expect(agentDriftInput(validateConfig({ drift: "0 6 * * *", respond: { drift: "off" }, agent: { ...base, drift: true } }, "t"))).toEqual({
      tokenSecret: "AGENT_FORGE_TOKEN",
      keySecret: "ANTHROPIC_API_KEY",
      command: AGENT_COMMAND,
      maxTurns: 30,
      timeout: 30,
      policyDir: "policy",
    });
    expect(agentDriftInput(validateConfig({ drift: "0 6 * * *", respond: { drift: "attribute" }, agent: { ...base, drift: { command: "my-agent", timeout: 5 } } }, "t"))).toMatchObject({ command: "my-agent", timeout: 5 });
  });

  it("needs a drift schedule, and a respond.drift other than the codified pull request", () => {
    expect(problemsOf({ agent: { ...base, drift: true } })).toEqual(["config.agent.drift runs when the drift job opens the drift issue; set drift to a cron schedule"]);
    expect(problemsOf({ drift: "0 6 * * *", agent: { ...base, drift: true } })).toEqual([
      "config.respond.drift: agent.drift opens the drift pull request itself, so the codified one would be a second; set respond.drift to attribute or off",
    ]);
    expect(problemsOf({ drift: "0 6 * * *", respond: { drift: "off" }, agent: { ...base, drift: { model: "x" } } })).toEqual([
      "config.agent.drift.model is not a setting (settings: command, key_secret, max_turns, timeout)",
    ]);
    expect(problemsOf({ agent: { ...base, fix: true } })).toEqual(["config.agent.fix is not a setting (settings: via, token_env, comment, drift)"]);
  });
});

/** A tf-drift report: app's queue moved from 30 to 45, a sensitive attribute moved, and db is gone. */
function report(): Report {
  return {
    run: { project: "forgejo.test/acme/infra", commit: "c".repeat(40), stage: "tf-drift", binary: "tofu", runtime: "forge", started: "x", finished: "2026-10-09T06:00:00.000Z" },
    roots: [
      {
        path: "app",
        status: "planned",
        changes: [
          { address: "aws_sqs_queue.jobs", type: "aws_sqs_queue", action: "update", attributes: [{ path: "visibility_timeout_seconds", before: 30, after: 45 }, { path: "policy", sensitive: true }] },
          { address: "aws_db_instance.db", type: "aws_db_instance", action: "delete", attributes: [] },
        ],
      },
      { path: "net", status: "planned", changes: [] },
    ],
  } as unknown as Report;
}

describe("the drift agent's prompt", () => {
  it("gives each drifted resource with the state's and the live value, as data, and never a sensitive one", () => {
    const p = driftPrompt({ report: report(), issue: 12, policyDir: "rego" });
    expect(p).toContain("drift issue #12");
    expect(p).toContain("<drift>\nroot app:\n  aws_sqs_queue.jobs: changed\n    visibility_timeout_seconds: state 30, live 45\n    policy: sensitive, not shown\n  aws_db_instance.db: no longer exists\n</drift>");
    expect(p).not.toContain("root net");
    expect(p).toContain("untrusted input");
    expect(p).toContain("rego/");
    expect(p).toContain("Do not commit or push");
  });

  it("is written only for a run that opened the drift issue", () => {
    const dir = write(tmp(), { "report.json": JSON.stringify(report()), "issue.json": JSON.stringify({ action: "opened", number: 12, url: "u" }) });
    const out = join(dir, "prompt.md");
    expect(writeDriftPrompt({ report: dir, out, policyDir: "policy" })).toEqual({ issue: 12, roots: 1 });
    expect(readFileSync(out, "utf-8")).toContain("visibility_timeout_seconds");
    writeFileSync(join(dir, "issue.json"), JSON.stringify({ action: "updated", number: 12 }));
    expect(() => writeDriftPrompt({ report: dir, out, policyDir: "policy" })).toThrow(/opened no drift issue/);
  });

  it("the drift job's outputs say agent=1 and the issue only when the run opened it", () => {
    const run = (content: string | undefined): string => {
      const dir = tmp();
      if (content !== undefined) writeFileSync(join(dir, "issue.json"), content);
      return spawnSync(process.execPath, ["-e", DRIFT_ISSUE_JS, join(dir, "issue.json")], { encoding: "utf-8" }).stdout;
    };
    expect(run(JSON.stringify({ action: "opened", number: 7 }))).toBe("agent=1\nissue=7\n");
    expect(run(JSON.stringify({ action: "updated", number: 7 }))).toBe("agent=0\n");
    expect(run(JSON.stringify({ action: "opened", number: "7; id" }))).toBe("agent=0\n");
    expect(run("not json")).toBe("agent=0\n");
    expect(run(undefined)).toBe("agent=0\n");
  });
});

interface Sent { method: string; path: string; body: any }

/** A forge with a bare repo whose main the drift job planned, the agent's patch against it, and the push job's fresh checkout. */
function setupPush(opts: { patch?: Record<string, string>; rc?: string; moved?: boolean; pulls?: unknown[] } = {}) {
  const root = tmp("tg-drift-push-");
  const bare = join(root, "forge.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
  const seed = write(join(root, "seed"), { "app/main.tf": "resource \"aws_sqs_queue\" \"jobs\" {\n  visibility_timeout_seconds = 30\n}\n", ".forgejo/workflows/terragucci.yml": "on: push\n", "terragucci.yml": "gate: never\n" });
  git(seed, "init", "-q", "-b", "main");
  git(seed, "add", "-A");
  git(seed, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "init");
  git(seed, "push", "-q", bare, "main");
  const sha = git(seed, "rev-parse", "HEAD").trim();
  const agentTree = join(root, "agent");
  execFileSync("git", ["clone", "-q", bare, agentTree]);
  for (const [p, c] of Object.entries(opts.patch ?? {})) {
    mkdirSync(join(agentTree, p, ".."), { recursive: true });
    writeFileSync(join(agentTree, p), c);
  }
  git(agentTree, "add", "-A");
  const change = join(root, "change");
  mkdirSync(change);
  writeFileSync(join(change, "change.patch"), git(agentTree, "diff", "--cached", "--binary", "--no-renames", sha));
  writeFileSync(join(change, "rc"), `${opts.rc ?? "0"}\n`);
  const checkout = join(root, "checkout");
  execFileSync("git", ["clone", "-q", bare, checkout]);
  git(checkout, "checkout", "-q", "--detach", sha);
  const sent: Sent[] = [];
  const f: Fetch = async (url, init) => {
    const path = url.replace("https://forge.test/api/v1", "");
    const method = init?.method ?? "GET";
    sent.push({ method, path, body: init?.body ? JSON.parse(init.body) : undefined });
    const reply = method === "GET" && path === "/repos/acme/infra" ? { default_branch: "main" }
      : method === "GET" && path.startsWith("/repos/acme/infra/pulls") ? (opts.pulls ?? [])
      : method === "POST" && path === "/repos/acme/infra/pulls" ? { html_url: "https://forge.test/acme/infra/pulls/9", number: 9 }
      : {};
    return { ok: true, status: 200, json: async () => reply, text: async () => "" } as never;
  };
  const env = {
    ...process.env,
    GITHUB_REPOSITORY: "acme/infra",
    GITHUB_API_URL: "https://forge.test/api/v1",
    GITHUB_SERVER_URL: "https://forge.test",
    TG_TOKEN: "agent-token",
    TG_ISSUE: "12",
    TG_SHA: opts.moved ? "b".repeat(40) : sha,
  };
  const run = () => pushDriftChange({ change, cwd: checkout, env, fetch: f, policyDir: "policy", forge: "forgejo" });
  const branch = (name: string) => spawnSync("git", ["-C", bare, "rev-parse", "--verify", "-q", name], { encoding: "utf-8" }).stdout.trim();
  const comments = () => sent.filter((s) => s.method === "POST" && s.path === "/repos/acme/infra/issues/12/comments").map((s) => s.body.body as string);
  return { run, sent, sha, bare, branch, comments, checkout };
}

describe("pushDriftChange", () => {
  it("commits the agent's change on a branch of its own, opens the pull request, and says so on the drift issue", async () => {
    const s = setupPush({ patch: { "app/main.tf": "resource \"aws_sqs_queue\" \"jobs\" {\n  visibility_timeout_seconds = 45\n}\n" } });
    const r = await s.run();
    expect(r).toMatchObject({ opened: true, pullRequest: "https://forge.test/acme/infra/pulls/9", paths: ["app/main.tf"] });
    expect(s.branch("terragucci/drift-agent-12")).toBe(r.commit);
    expect(git(s.bare, "rev-parse", `${r.commit}^`).trim()).toBe(s.sha);
    expect(git(s.bare, "show", `${r.commit}:app/main.tf`)).toContain("= 45");
    expect(s.branch("main")).toBe(s.sha);
    const pr = s.sent.find((x) => x.method === "POST" && x.path === "/repos/acme/infra/pulls")!;
    expect(pr.body).toMatchObject({ head: "terragucci/drift-agent-12", base: "main", title: "Bring the code in line with drift issue #12" });
    expect(pr.body.body).toContain("Nothing was applied, approved or merged.");
    expect(s.comments()).toEqual([expect.stringContaining("terragucci: the drift agent opened https://forge.test/acme/infra/pulls/9, changing `app/main.tf`")]);
  });

  it("refuses a change to CI, terragucci.yml or the policy, and opens nothing", async () => {
    const s = setupPush({ patch: { "app/main.tf": "# ok\n", ".forgejo/workflows/terragucci.yml": "on: schedule\n", "policy/allow.rego": "package x\n" } });
    const r = await s.run();
    expect(r.opened).toBe(false);
    expect(r.fail).toBeUndefined();
    expect(s.branch("terragucci/drift-agent-12")).toBe("");
    expect(s.sent.some((x) => x.path === "/repos/acme/infra/pulls")).toBe(false);
    expect(s.comments()[0]).toContain("`.forgejo/workflows/terragucci.yml`, `policy/allow.rego`, which an agent may not change");
    expect(git(s.checkout, "status", "--porcelain")).toBe("");
  });

  it("opens nothing when the agent failed, changed nothing, or the checkout is not the planned commit", async () => {
    const failed = setupPush({ patch: { "app/main.tf": "# half\n" }, rc: "2" });
    expect((await failed.run()).opened).toBe(false);
    expect(failed.comments()[0]).toContain("the drift agent stopped with exit code 2");
    const nothing = setupPush();
    expect((await nothing.run()).opened).toBe(false);
    expect(nothing.comments()[0]).toContain("the drift agent changed nothing");
    const moved = setupPush({ patch: { "app/main.tf": "# x\n" }, moved: true });
    expect((await moved.run()).opened).toBe(false);
    expect(moved.comments()[0]).toContain("is not the commit the drift job planned");
    expect(moved.branch("terragucci/drift-agent-12")).toBe("");
  });

  it("never force-pushes over a branch an earlier run left", async () => {
    const s = setupPush({ patch: { "app/main.tf": "# x\n" } });
    git(s.checkout, "push", "-q", s.bare, `${s.sha}:refs/heads/terragucci/drift-agent-12`);
    // An unrelated commit on that branch: the new one is not on top of it.
    const other = join(s.checkout, "..", "other");
    execFileSync("git", ["clone", "-q", "-b", "terragucci/drift-agent-12", s.bare, other]);
    writeFileSync(join(other, "x.txt"), "x\n");
    git(other, "add", "-A");
    git(other, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "earlier");
    git(other, "push", "-q", "origin", "terragucci/drift-agent-12");
    const before = s.branch("terragucci/drift-agent-12");
    const r = await s.run();
    expect(r).toMatchObject({ opened: false, fail: true });
    expect(s.branch("terragucci/drift-agent-12")).toBe(before);
    expect(s.comments()[0]).toContain("could not push the drift agent's change");
    expect(s.comments()[0]).not.toContain("agent-token");
  });

  it("refuses an issue or sha the shell should not see", async () => {
    expect(await pushDriftChange({ change: "/nonexistent", env: { TG_ISSUE: "1; id", TG_SHA: "a".repeat(40) } })).toMatchObject({ opened: false, fail: true });
  });
});

describe("the drift agent's jobs", () => {
  const agent = agentDriftInput(validateConfig({ drift: "0 6 * * *", respond: { drift: "off" }, agent: { ...base, drift: { max_turns: 12, timeout: 20 } }, policy: { path: "rego" } }, "t"))!;
  const withAgent = (forge: "github" | "forgejo"): Record<string, any> =>
    body(renderPipeline({ forge, binary: "tofu", version: "1.13.1", image: "img:1", layers, env: {}, oidc: OIDC, drift: "0 6 * * *", respond: { drift: "off" }, agentDrift: agent }).content);

  it("are off unless agent.drift is set", () => {
    const doc = body(renderPipeline({ forge: "github", binary: "tofu", version: "1.13.1", image: "img:1", layers, env: {}, drift: "0 6 * * *", respond: { drift: "off" } }).content);
    expect(doc.jobs["drift-agent"]).toBeUndefined();
    expect(doc.jobs.drift.outputs).toBeUndefined();
    expect(JSON.stringify(doc.jobs.drift)).not.toContain("issue.json");
  });

  it.each(["github", "forgejo"] as const)("%s: run after the drift job when it opened the issue, on the commit it planned", (forge) => {
    const doc = withAgent(forge);
    expect(doc.jobs.drift.outputs).toEqual({ agent: "${{ steps.drift.outputs.agent }}", issue: "${{ steps.drift.outputs.issue }}" });
    const step = doc.jobs.drift.steps.find((s: { id?: string }) => s.id === "drift");
    expect(step.run).toContain("terragucci-report/issue.json >>\"$GITHUB_OUTPUT\"");
    expect(doc.jobs["drift-agent"].needs).toBe("drift");
    expect(doc.jobs["drift-agent"].if).toBe("needs.drift.outputs.agent == '1'");
    expect(doc.jobs["drift-agent"]["timeout-minutes"]).toBe(20);
    expect(doc.jobs["drift-agent-push"].needs).toEqual(["drift", "drift-agent"]);
    expect(doc.jobs["drift-agent-push"].env.TG_ISSUE).toBe("${{ needs.drift.outputs.issue }}");
    for (const name of ["drift-agent", "drift-agent-push"]) {
      const checkout = doc.jobs[name].steps.find((s: { uses?: string }) => s.uses?.includes("checkout"));
      expect(checkout.with).toEqual({ ref: "${{ github.sha }}", "persist-credentials": false });
    }
    const prompt = doc.jobs["drift-agent"].steps.find((s: { name?: string }) => s.name === "Write the agent's prompt from the drift report").run as string;
    expect(prompt).toContain("terragucci drift-agent prompt --report /tmp/terragucci-agent/drift --out /tmp/terragucci-agent/prompt.md --policy-dir 'rego'");
    expect(doc.jobs["drift-agent-push"].steps.at(-1).run).toContain(`terragucci drift-agent push --forge ${forge} --change /tmp/terragucci-agent/change --policy-dir 'rego'`);
  });

  it.each(["github", "forgejo"] as const)("%s: the agent's job holds no forge write token and no cloud role, and only the push job holds the agent's token", (forge) => {
    const doc = withAgent(forge);
    for (const name of ["drift-agent", "drift-agent-push"]) {
      const job = JSON.stringify(doc.jobs[name]);
      expect(job, name).not.toContain(OIDC.plan_role);
      expect(job, name).not.toContain("id-token");
      expect(job, name).not.toContain("github.token");
      // Forgejo's runner ignores permissions, and the dialect drops them.
      if (forge === "github") expect(doc.jobs[name].permissions, name).toEqual({ contents: "read" });
    }
    expect(JSON.stringify(doc.jobs["drift-agent"])).not.toContain("AGENT_FORGE_TOKEN");
    expect(doc.jobs["drift-agent-push"].env.TG_TOKEN).toBe("${{ secrets.AGENT_FORGE_TOKEN }}");
    const run = doc.jobs["drift-agent"].steps.find((s: { name?: string }) => s.name === "Run the agent on the drift");
    expect(run.env.ANTHROPIC_API_KEY).toBe("${{ secrets.ANTHROPIC_API_KEY }}");
    expect(run.env.TG_AGENT_MAX_TURNS).toBe("12");
    // The step drops the runner's own token variables, which Forgejo sets whatever permissions say.
    expect(run.run).toContain("unset GITHUB_TOKEN FORGEJO_TOKEN GITEA_TOKEN");
    expect(JSON.stringify(doc.jobs["drift-agent-push"])).not.toContain("ANTHROPIC_API_KEY");
  });

  it("is refused on GitLab, without a drift schedule, and beside the codified drift pull request", () => {
    const input = { binary: "tofu" as const, version: "1.13.1", image: "img:1", layers, env: {} };
    expect(() => renderPipeline({ ...input, forge: "gitlab", drift: "0 6 * * *", respond: { drift: "off" }, agentDrift: agent })).toThrow(/agent.drift runs on GitHub and Forgejo/);
    expect(() => renderPipeline({ ...input, forge: "github", agentDrift: agent })).toThrow(/set drift to a cron schedule/);
    expect(() => renderPipeline({ ...input, forge: "github", drift: "0 6 * * *", agentDrift: agent })).toThrow(/agent.drift opens the drift pull request itself/);
  });

  it("the drift script keeps the stage's exit code after writing the outputs", () => {
    const s = driftScript("tofu", layers, "forgejo", undefined, {}, undefined, false, true);
    expect(s).toContain("rc=$?");
    expect(s.trim().endsWith('exit "$rc"')).toBe(true);
  });
});
