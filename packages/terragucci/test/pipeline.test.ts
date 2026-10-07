import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import { validateConfig } from "../src/config";
import { AGENT_COMMAND, AGENT_DIR, agentCommentInput } from "../src/agent-comment";
import { agentRunScript } from "../src/render-agent";
import { applyScript, AWS_CLI, cloudScripts, commentApplyScript, driftScript, forgeApi, movedRoots, planScript, READS_EXIT, renderPipeline, terragruntApplyScript } from "../src/render";
import type { ForgeName } from "../src/config";
import { git, tmp } from "./helpers";

const OIDC = { plan_role: "arn:aws:iam::111:role/plan-ro", apply_role: "arn:aws:iam::111:role/apply-rw" };
const layers = [["network"], ["app", "cache"]];
const FORGES: ForgeName[] = ["github", "forgejo", "gitlab"];

const render = (forge: ForgeName, oidc?: typeof OIDC): string =>
  renderPipeline({ forge, binary: "tofu", version: "1.13.1", image: "img:1", layers, env: {}, oidc }).content;

const body = (text: string): Record<string, any> => parseYAML(text.split("\n").filter((l) => !l.startsWith("#")).join("\n")) as Record<string, any>;

describe("the check job", () => {
  it.each(["github", "forgejo"] as const)("%s: validates through check-root, tests the policy, keeps the report and has the history", (forge) => {
    const check = body(render(forge)).jobs.check;
    const run = check.steps.find((s: { run?: string }) => s.run?.includes("check-root")).run as string;
    expect(run).toContain('terragucci check-root "$dir" --binary tofu || failed=1');
    expect(run).toContain("terragucci check-policy || failed=1");
    expect(run).toContain('exit "$failed"');
    expect(run).not.toContain("validate -no-color");
    // Without `policy:` the clone is shallow; with it the policy tests have the history.
    expect(check.steps[0].with).toBeUndefined();
    const withPolicy = body(renderPipeline({ forge, binary: "tofu", version: "1.13.1", image: "img:1", layers, env: {}, policy: true }).content).jobs.check;
    expect(withPolicy.steps[0].with["fetch-depth"]).toBe(0);
    expect(check.env.TG_BRANCH).toBe("${{ github.event.repository.default_branch }}");
    const keep = check.steps.find((s: { name?: string }) => s.name === "Keep the check report");
    expect(keep.with.path).toBe("terragucci-check/");
  });

  it("gitlab: the same script, the report as an artifact, the history in the clone", () => {
    const doc = body(render("gitlab"));
    expect(doc.check.script.join("\n")).toContain('terragucci check-root "$dir" --binary tofu || failed=1');
    expect(doc.check.artifacts).toEqual({ name: "terragucci-check", when: "always", paths: ["terragucci-check/"] });
    expect(doc.check.variables).toMatchObject({ TG_BRANCH: "$CI_DEFAULT_BRANCH" });
    expect(doc.check.variables.GIT_DEPTH).toBeUndefined();
    const withPolicy = body(renderPipeline({ forge: "gitlab", binary: "tofu", version: "1.13.1", image: "img:1", layers, env: {}, policy: true }).content);
    expect(withPolicy.check.variables.GIT_DEPTH).toBe("0");
  });

  it("a choudoufu pipeline passes its binary, which check-root uses to run live-check", () => {
    const text = renderPipeline({ forge: "github", binary: "choudoufu", version: "1.0.0", image: "img:1", layers, env: {} }).content;
    expect(text).toContain('terragucci check-root "$dir" --binary choudoufu || failed=1');
  });
});

describe("apply concurrency", () => {
  const GROUP = "terragucci-apply-${{ github.repository }}";

  it.each(["github", "forgejo"] as const)("%s: one apply per project, a waiting push is not cancelled", (forge) => {
    for (const job of ["apply-wave-1", "apply-wave-2"]) {
      expect(body(render(forge)).jobs[job].concurrency).toMatchObject({ group: GROUP, "cancel-in-progress": false });
    }
    expect(body(render(forge)).jobs.check.concurrency).toBeUndefined();
  });

  it("github: every apply job, the comment's too, queues in the one group with queue: max, so a job that starts waiting cancels none already waiting", () => {
    const doc = body(render("github", OIDC));
    for (const job of ["apply-wave-1", "apply-wave-2", "apply-comment"]) {
      expect(doc.jobs[job].concurrency, job).toEqual({ group: GROUP, "cancel-in-progress": false, queue: "max" });
    }
    // GitHub refuses queue: max beside cancel-in-progress: true; no job in the workflow has that pair.
    for (const [name, job] of Object.entries(doc.jobs as Record<string, any>)) {
      if (job.concurrency?.queue === "max") expect(job.concurrency["cancel-in-progress"], name).toBe(false);
    }
    // The other groups keep the default queue: a newer run of tips, version-bump or a re-plan replacing an older waiting one is wanted.
    expect(doc.jobs.replan.concurrency.queue).toBeUndefined();
    const tg = body(renderPipeline({ forge: "github", binary: "tofu", version: "1.13.1", image: "img:1", layers: [["live/dev/app"]], env: {}, terragrunt: { version: "0.99.0", parallelism: 4, exclude: [], installs: [] } }).content);
    expect(tg.jobs.apply.concurrency).toEqual({ group: GROUP, "cancel-in-progress": false, queue: "max" });
  });

  it("forgejo: no queue key, since Forgejo runs a workflow's jobs whatever their concurrency says and the lock tag holds the apply", () => {
    const doc = body(render("forgejo", OIDC));
    for (const job of ["apply-wave-1", "apply-wave-2", "apply-comment"]) {
      expect(doc.jobs[job].concurrency, job).toEqual({ group: GROUP, "cancel-in-progress": false });
    }
  });

  it("github: a push's wave stands down when the branch moved past it, because nothing cancels it any more; the comment's apply does not", () => {
    for (const wave of [1, 2]) expect(applyScript("tofu", layers, "github", undefined, { wave })).toContain("standing down");
    expect(terragruntApplyScript([["live/a"]], "github")).toContain("standing down");
    expect(applyScript("tofu", layers, "gitlab", undefined, { wave: 1 })).not.toContain("standing down");
    expect(commentApplyScript("tofu", layers, "github", OIDC)).not.toContain("standing down");
    // It stands down before the pending status and before the stage.
    const script = applyScript("tofu", layers, "github", undefined, { wave: 1 });
    expect(script.indexOf("standing down")).toBeLessThan(script.indexOf('tg status terragucci/apply pending "applying"'));
    expect(script.indexOf("standing down")).toBeLessThan(script.indexOf("terragucci stage tf-apply"));
  });

  it("gitlab: each wave's apply job is in the one resource group", () => {
    const doc = body(render("gitlab"));
    expect(doc["apply-wave-1"].resource_group).toBe("terragucci-apply");
    expect(doc["apply-wave-2"].resource_group).toBe("terragucci-apply");
    expect(doc.check.resource_group).toBeUndefined();
  });

  it("forgejo names a workflow-level group that does not cancel, or a later push cancels a run that is applying", () => {
    expect(body(render("forgejo")).concurrency).toEqual({ group: "terragucci-${{ github.event_name == 'issue_comment' && format('comment-{0}', github.event.issue.number) || github.ref }}", "cancel-in-progress": false });
    expect(body(render("github")).concurrency).toBeUndefined();
  });

  it("forgejo also takes a lock on the remote, because the runner ignores concurrency", () => {
    expect(render("forgejo")).toContain("refs/tags/terragucci-apply-lock");
    expect(render("github")).not.toContain("terragucci-apply-lock");
    expect(render("gitlab")).not.toContain("terragucci-apply-lock");
  });
});

describe("the comment trigger", () => {
  it.each(["github", "forgejo"] as const)("%s: issue_comment starts a re-plan job that never applies", (forge) => {
    const doc = body(render(forge, OIDC));
    expect(doc.on.issue_comment).toEqual({ types: ["created"] });
    expect(doc.jobs.replan.if).toContain("github.event_name == 'issue_comment'");
    expect(doc.jobs.replan.if).toContain("startsWith(github.event.comment.body, '/terragucci')");
    // `/terragucci apply` is the apply-comment job's, never the re-plan job's.
    expect(doc.jobs.replan.if).toContain("!startsWith(github.event.comment.body, '/terragucci apply')");
    // The comment-triggered run takes the plan job's read-only role, never the apply role.
    expect(JSON.stringify(doc.jobs.replan)).toContain(OIDC.plan_role);
    expect(JSON.stringify(doc.jobs.replan)).not.toContain(OIDC.apply_role);
    // Forgejo has no permissions scopes, so only github carries the read-only token.
    if (forge === "github") expect(doc.jobs.replan.permissions.contents).toBe("read");
    else expect(doc.jobs.replan.permissions?.contents).toBeUndefined();
    // The check job does not run for a comment (its fork test alone would be true for one), and the apply chain hangs off check.
    expect(doc.jobs.check.if).toContain("github.event_name == 'pull_request'");
    expect(doc.jobs["apply-wave-1"].needs).toBe("check");
  });

  it.each(["github", "forgejo"] as const)("%s: the comment never reaches a shell as an expression", (forge) => {
    const text = render(forge);
    const run = JSON.stringify(body(text).jobs.replan.steps);
    expect(run).not.toContain("github.event.comment");
    expect(run).toContain("terragucci comment --layers");
    expect(run).not.toContain("eval ");
    // The only mentions of the comment body are the jobs' startsWith filters, never a script.
    const doc = body(text);
    expect(JSON.stringify(doc.jobs["apply-comment"].steps)).not.toContain("github.event.comment");
    expect(text.match(/github\.event\.comment/g)).toHaveLength(3);
    for (const line of text.split("\n").filter((l) => l.includes("github.event.comment"))) expect(line.trim()).toMatch(/^if: /);
  });

  it("the re-plan script checks the comment before it asks for credentials, then plans the pull request's head", () => {
    const script = planScript("tofu", layers, "github", OIDC, {}, true);
    const at = (s: string): number => script.indexOf(s);
    expect(at("terragucci comment")).toBeGreaterThan(-1);
    expect(at("terragucci comment")).toBeLessThan(at("tg oidc"));
    expect(at("git checkout --quiet --detach")).toBeLessThan(at("terragucci stage tf-plan"));
    expect(script).toContain('${TG_ROOT:+--root "$TG_ROOT"}');
    expect(planScript("tofu", layers, "github", OIDC)).not.toContain("terragucci comment");
  });

  it("a re-plan of a root the change does not reach replies that it is not affected, and leaves the note and status", () => {
    const script = planScript("tofu", layers, "github", OIDC, {}, true);
    expect(script).toContain('tg reply "$TG_ROOT is not affected by this pull request, so nothing was planned."');
    expect(script.indexOf("tg reply")).toBeLessThan(script.indexOf("tg note"));
    expect(script).toContain('[ -n "${TG_ROOT:-}" ] || tg status terragucci/plan pending');
    expect(planScript("tofu", layers, "github", OIDC)).not.toContain("tg reply");
  });

  it("forgejo: the re-plan reads the commenter's permission from the event, and checks out the pull request's head by number", () => {
    const script = planScript("tofu", layers, "forgejo", OIDC, {}, true);
    expect(script).toMatch(/terragucci comment --layers [^\n]* --forge forgejo --out /);
    expect(planScript("tofu", layers, "github", OIDC, {}, true)).not.toContain("--forge");
    expect(script).toContain('git fetch --quiet origin "refs/pull/$TG_PR/head"');
    expect(script.indexOf('git checkout --quiet --detach "$TG_SHA"')).toBeLessThan(script.indexOf("tg status terragucci/plan pending"));
  });

  it.each(["github", "forgejo"] as const)("%s: `/terragucci apply` starts the apply-comment job, with the apply role, under the apply lock", (forge) => {
    const doc = body(render(forge, OIDC));
    const job = doc.jobs["apply-comment"];
    expect(job.if).toBe("github.event_name == 'issue_comment' && startsWith(github.event.comment.body, '/terragucci apply')");
    expect(job.concurrency).toEqual(doc.jobs["apply-wave-1"].concurrency);
    expect(job.concurrency).toEqual({ group: "terragucci-apply-${{ github.repository }}", "cancel-in-progress": false, ...(forge === "github" ? { queue: "max" } : {}) });
    const run = job.steps.find((s: { run?: string }) => s.run?.includes("terragucci comment-apply")).run as string;
    expect(run).toContain(OIDC.apply_role);
    expect(run).not.toContain(OIDC.plan_role);
    // It checks out the merge commit from the default branch's history, never a pull request's head.
    expect(job.steps[0]).toEqual({ uses: forge === "forgejo" ? "https://code.forgejo.org/actions/checkout@v4" : "actions/checkout@v4", with: { "fetch-depth": 0 } });
    expect(run).not.toContain("refs/pull/");
    expect(run).toContain('git checkout --quiet --detach "$TG_SHA"');
    if (forge === "github") expect(job.permissions["id-token"]).toBe("write");
    else expect(job["enable-openid-connect"]).toBe(true);
    // Each wave of a push still runs only for a push to the default branch.
    expect(doc.jobs["apply-wave-1"].if).toBe("github.ref == format('refs/heads/{0}', github.event.repository.default_branch)");
  });

  it("a Terragrunt repo, which applies in one job with no gates, gets no apply-comment job, and its re-plan job answers the comment", () => {
    const text = renderPipeline({ forge: "github", binary: "tofu", version: "1.13.1", image: "img:1", layers: [["live/dev/app"]], env: {}, terragrunt: { version: "0.99.0", parallelism: 4, exclude: [], installs: [] } }).content;
    const doc = body(text);
    expect(doc.jobs["apply-comment"]).toBeUndefined();
    expect(doc.jobs.replan.if).not.toContain("/terragucci apply");
  });

  it("the apply-comment script decides before any credential, checks out the merge commit, and runs the waves in order", () => {
    const script = commentApplyScript("tofu", layers, "github", OIDC, { gate: "always" });
    const at = (s: string): number => script.indexOf(s);
    expect(at("terragucci comment-apply --layers")).toBeGreaterThan(-1);
    expect(at("terragucci comment-apply")).toBeLessThan(at('git checkout --quiet --detach "$TG_SHA"'));
    expect(at('git checkout --quiet --detach "$TG_SHA"')).toBeLessThan(at("tg oidc"));
    expect(at("tg oidc")).toBeLessThan(at("terragucci stage tf-apply"));
    expect(script).toContain('terragucci stage tf-apply --wave "$wave" --layers');
    expect(script).toContain("--gate always");
    expect(script).not.toContain("tg stale");
    expect(script).not.toContain("terragucci-apply-lock");
    expect(commentApplyScript("tofu", layers, "github", OIDC, { canary: ["app"] })).toContain("--canary 'app'");
    // The step runs under bash -e; the script reads each wave's exit code itself, so it turns -e off first.
    expect(script.split("\n")[0]).toBe(READS_EXIT);
  });

  it("forgejo: the apply-comment script takes the lock tag without standing down for the tip, and decides again once it holds it", () => {
    const script = commentApplyScript("tofu", layers, "forgejo", OIDC);
    const at = (s: string): number => script.indexOf(s);
    expect(script).toContain("refs/tags/terragucci-apply-lock");
    expect(script).not.toContain("standing down");
    expect(script.match(/terragucci comment-apply [^\n]* --forge forgejo/g)).toHaveLength(2);
    expect(at("refs/tags/terragucci-apply-lock")).toBeLessThan(script.lastIndexOf("terragucci comment-apply"));
    expect(script.lastIndexOf("terragucci comment-apply")).toBeLessThan(at("tg oidc"));
  });

  describe("an apply a comment started", () => {
    const decision = (d: Record<string, unknown>) => JSON.stringify(d);
    const fake = (waits?: number) => fakeBin("#!/usr/bin/env bash\nexit 0\n", {
      terragucci: [
        "#!/usr/bin/env bash",
        'if [ "$1" = comment-apply ]; then while [ $# -gt 0 ]; do [ "$1" = --out ] && out="$2"; shift; done; printf \'%s\\n\' "$DECISION" > "$out"; exit 0; fi',
        'echo "wave $4 at $(git rev-parse HEAD)" >> "$LOG"',
        ...(waits ? [`if [ "$4" = ${waits} ]; then echo "wave $4 waits: chant approve tf-apply wave-$4 --plan jcs1-sha256:abc123 --sign" > "$TG_OUTCOME"; exit 3; fi`] : []),
        "exit 0",
      ].join("\n"),
    });
    const repo = (): { work: string; sha: string } => {
      const work = tmp("tg-work-");
      git(work, "init", "-q", "-b", "main");
      git(work, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "merge");
      const sha = git(work, "rev-parse", "HEAD").trim();
      git(work, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "tip");
      return { work, sha };
    };
    const envFor = (api: string, dir: string, d: string): Record<string, string> => ({
      LOG: join(dir, "stage.log"), DECISION: d, TG_TOKEN: "t", GITHUB_API_URL: api, GITHUB_REPOSITORY: "acme/infra", GITHUB_SERVER_URL: "https://forge.test", GITHUB_RUN_ID: "9",
    });

    it("applies every wave at the merge commit, posts the apply status there and replies with the run", async () => {
      const { work, sha } = repo();
      const { dir, env } = fake();
      const api = await stubApi(() => ({}));
      try {
        const r = await runStep(`cd ${work} && ${commentApplyScript("tofu", layers, "github")}`, { ...env, ...envFor(api.url, dir, decision({ go: true, pr: 7, sha, base: "main" })) });
        expect(r.status, r.out).toBe(0);
        expect(readFileSync(join(dir, "stage.log"), "utf-8").trim().split("\n")).toEqual([`wave 1 at ${sha}`, `wave 2 at ${sha}`]);
        const statuses = api.hits.filter((h) => h.url.startsWith("/repos/acme/infra/statuses/"));
        expect(statuses.every((h) => h.url === `/repos/acme/infra/statuses/${sha}`)).toBe(true);
        expect(statuses.at(-1)?.body.state).toBe("success");
        const reply = api.hits.find((h) => h.url === "/repos/acme/infra/issues/7/comments");
        expect(reply?.body.body).toBe(`terragucci: applied wave 1, 2 of pull request 7 at ${sha.slice(0, 8)}. https://forge.test/acme/infra/actions/runs/9`);
      } finally {
        api.close();
      }
    });

    it("stops at a waiting wave, approves nothing, and the reply names the wave, its digest and the approval command", async () => {
      const { work, sha } = repo();
      const { dir, env } = fake(2);
      const api = await stubApi(() => ({}));
      try {
        const r = await runStep(`cd ${work} && ${commentApplyScript("tofu", layers, "github")}`, { ...env, ...envFor(api.url, dir, decision({ go: true, pr: 7, sha, base: "main" })) });
        expect(r.status).toBe(3);
        const reply = api.hits.find((h) => h.url === "/repos/acme/infra/issues/7/comments")?.body.body as string;
        expect(reply).toContain("wave 2 waits for an approval of its set digest jcs1-sha256:abc123");
        expect(reply).toContain("`chant approve tf-apply wave-2 --plan jcs1-sha256:abc123 --sign`");
        expect(reply).toContain("(applied: wave 1)");
        expect(reply).toContain("https://forge.test/acme/infra/actions/runs/9");
        expect(api.hits.some((h) => h.url.includes("chant") || h.url.includes("lifecycle"))).toBe(false);
      } finally {
        api.close();
      }
    });

    it("runs no further than the wave the comment named", async () => {
      const { work, sha } = repo();
      const { dir, env } = fake();
      const api = await stubApi(() => ({}));
      try {
        const r = await runStep(`cd ${work} && ${commentApplyScript("tofu", layers, "github")}`, { ...env, ...envFor(api.url, dir, decision({ go: true, pr: 7, sha, base: "main", wave: 1 })) });
        expect(r.status, r.out).toBe(0);
        expect(readFileSync(join(dir, "stage.log"), "utf-8").trim()).toBe(`wave 1 at ${sha}`);
        expect(api.hits.filter((h) => h.url.includes("/statuses/")).at(-1)?.body.state).toBe("pending");
      } finally {
        api.close();
      }
    });

    // A terragucci whose stage ends `code` at wave 2, and that logs each respond call with its arguments.
    const ending = (code: number, outcome: string) => fakeBin("#!/usr/bin/env bash\nexit 0\n", {
      terragucci: [
        "#!/usr/bin/env bash",
        'if [ "$1" = comment-apply ]; then while [ $# -gt 0 ]; do [ "$1" = --out ] && out="$2"; shift; done; printf \'%s\\n\' "$DECISION" > "$out"; exit 0; fi',
        'if [ "$1" = respond ]; then echo "respond ${*:2}" >> "$LOG"; [ "$2" = apply-failed ] && cp "$4" "$LOG.triage"; exit 0; fi',
        'echo "wave $4" >> "$LOG"',
        `if [ "$4" = 2 ]; then echo ${JSON.stringify(outcome)} > "$TG_OUTCOME"; echo "Error: creating the bucket: AccessDenied"; exit ${code}; fi`,
        "exit 0",
      ].join("\n"),
    });

    it("a refused wave runs respond wave-refused for that wave, as a push's wave does, before the reply", async () => {
      const { work, sha } = repo();
      const { dir, env } = ending(4, "wave 2 was refused: its plans changed since the approval");
      const api = await stubApi(() => ({}));
      try {
        const r = await runStep(`cd ${work} && ${commentApplyScript("tofu", layers, "github")}`, { ...env, ...envFor(api.url, dir, decision({ go: true, pr: 7, sha, base: "main" })) });
        expect(r.status, r.out).toBe(4);
        const calls = readFileSync(join(dir, "stage.log"), "utf-8").trim().split("\n");
        expect(calls).toEqual(["wave 1", "wave 2", "respond wave-refused --wave 2 --approved terragucci-report/approved --current terragucci-report/current"]);
        expect(api.hits.find((h) => h.url === "/repos/acme/infra/issues/7/comments")?.body.body).toContain("wave 2 was refused");
        expect(api.hits.filter((h) => h.url.includes("/statuses/")).at(-1)?.body.state).toBe("failure");
      } finally {
        api.close();
      }
    });

    it("a failed wave runs respond apply-failed on that wave's log, as a push's wave does, and later waves do not run", async () => {
      const { work, sha } = repo();
      const { dir, env } = ending(1, "");
      const api = await stubApi(() => ({}));
      try {
        const r = await runStep(`cd ${work} && ${commentApplyScript("tofu", [["network"], ["app"], ["cache"]], "github")}`, { ...env, ...envFor(api.url, dir, decision({ go: true, pr: 7, sha, base: "main" })) });
        expect(r.status, r.out).toBe(1);
        const calls = readFileSync(join(dir, "stage.log"), "utf-8").trim().split("\n");
        expect(calls[0]).toBe("wave 1");
        expect(calls[1]).toBe("wave 2");
        expect(calls[2]).toMatch(/^respond apply-failed --log \S+$/);
        expect(calls).toHaveLength(3);
        // The log is the failed wave's own output, which the step still prints.
        expect(readFileSync(join(dir, "stage.log.triage"), "utf-8")).toContain("Error: creating the bucket: AccessDenied");
        expect(r.out).toContain("Error: creating the bucket: AccessDenied");
        expect(api.hits.find((h) => h.url === "/repos/acme/infra/issues/7/comments")?.body.body).toContain("wave 2 did not apply");
      } finally {
        api.close();
      }
    });

    it("a waiting wave gets no response, and a response set to off is not called", async () => {
      expect(commentApplyScript("tofu", layers, "github")).toContain("terragucci respond wave-refused --wave \"$wave\"");
      expect(commentApplyScript("tofu", layers, "github")).toContain('terragucci respond apply-failed --log "$log" || true');
      const off = commentApplyScript("tofu", layers, "github", undefined, { respond: { "apply-failed": "off", "wave-refused": "off" } });
      expect(off).not.toContain("terragucci respond");
      expect(off).toContain("  rc=$?");
      const script = commentApplyScript("tofu", layers, "github");
      const waits = script.slice(script.indexOf("    3)"), script.indexOf("    4)"));
      expect(waits).not.toContain("terragucci respond");
    });

    it("a comment the decision refused runs no stage and asks for no token", async () => {
      const { work } = repo();
      const { dir, env } = fake();
      const api = await stubApi(() => ({}));
      try {
        const r = await runStep(`cd ${work} && ${commentApplyScript("tofu", layers, "github", OIDC)}`, { ...env, ...envFor(api.url, dir, decision({ go: false, reason: "pull request 7 is not merged" })) });
        expect(r.status).toBe(0);
        expect(existsSync(join(dir, "stage.log"))).toBe(false);
        expect(r.out).not.toContain("OIDC");
        expect(api.hits).toEqual([]);
      } finally {
        api.close();
      }
    });
  });

  it("gitlab: no comment trigger", () => {
    expect(render("gitlab")).not.toContain("issue_comment");
    expect(body(render("gitlab")).replan).toBeUndefined();
  });
});

describe("the agent comment", () => {
  const agent = agentCommentInput(validateConfig({ agent: { via: "forge", token_env: "AGENT_FORGE_TOKEN", comment: { max_turns: 12, timeout: 20 } }, policy: { path: "rego" } }, "t"))!;
  const withAgent = (forge: ForgeName): Record<string, any> =>
    body(renderPipeline({ forge, binary: "tofu", version: "1.13.1", image: "img:1", layers, env: {}, oidc: OIDC, agentComment: agent }).content);

  it("is off unless agent.comment is set: no agent jobs, and the re-plan job reads every /terragucci comment", () => {
    for (const forge of ["github", "forgejo"] as const) {
      const doc = body(render(forge, OIDC));
      expect(doc.jobs.agent).toBeUndefined();
      expect(doc.jobs["agent-push"]).toBeUndefined();
      expect(doc.jobs.replan.if).not.toContain("/terragucci agent");
      expect(JSON.stringify(doc.jobs.replan.steps)).not.toContain("--agent");
    }
    expect(agentCommentInput(validateConfig({ agent: { via: "forge", token_env: "T" } }, "t"))).toBeUndefined();
    expect(agentCommentInput(validateConfig({ agent: { via: "forge", token_env: "T", comment: false } }, "t"))).toBeUndefined();
  });

  it.each(["github", "forgejo"] as const)("%s: an agent comment starts the agent job, and the re-plan job leaves it alone", (forge) => {
    const doc = withAgent(forge);
    expect(doc.jobs.agent.if).toBe("github.event_name == 'issue_comment' && startsWith(github.event.comment.body, '/terragucci agent ')");
    expect(doc.jobs.replan.if).toContain("&& !startsWith(github.event.comment.body, '/terragucci agent ')");
    expect(JSON.stringify(doc.jobs.replan.steps)).toContain(" --agent on --out terragucci-comment.json");
    expect(doc.jobs.agent["timeout-minutes"]).toBe(20);
    expect(doc.jobs["agent-push"].needs).toBe("agent");
    expect(doc.jobs["agent-push"].if).toBe("needs.agent.outputs.go == '1'");
  });

  it.each(["github", "forgejo"] as const)("%s: no cloud credentials reach either job, and only the push job holds the push token", (forge) => {
    const doc = withAgent(forge);
    for (const name of ["agent", "agent-push"]) {
      const job = JSON.stringify(doc.jobs[name]);
      expect(job, name).not.toContain(OIDC.plan_role);
      expect(job, name).not.toContain(OIDC.apply_role);
      expect(job, name).not.toContain("tg oidc");
      expect(job, name).not.toContain("id-token");
      expect(job, name).not.toContain("enable-openid-connect");
    }
    expect(JSON.stringify(doc.jobs.agent)).not.toContain("AGENT_FORGE_TOKEN");
    expect(doc.jobs["agent-push"].env.TG_TOKEN).toBe("${{ secrets.AGENT_FORGE_TOKEN }}");
    // The model's key is in the agent's step alone, not the job, and not the push job.
    const run = doc.jobs.agent.steps.find((s: { name?: string }) => s.name === "Run the agent on the ask");
    expect(run.env.ANTHROPIC_API_KEY).toBe("${{ secrets.ANTHROPIC_API_KEY }}");
    expect(run.env.TG_AGENT_MAX_TURNS).toBe("12");
    expect(run.env.TG_TOKEN).toBeUndefined();
    expect(doc.jobs.agent.env?.ANTHROPIC_API_KEY).toBeUndefined();
    expect(JSON.stringify(doc.jobs["agent-push"])).not.toContain("ANTHROPIC_API_KEY");
    // Checkouts keep no credentials for the agent to find.
    for (const name of ["agent", "agent-push"]) {
      const checkout = doc.jobs[name].steps.find((s: { uses?: string }) => s.uses?.includes("checkout"));
      expect(checkout.with["persist-credentials"], name).toBe(false);
    }
    if (forge === "github") {
      expect(doc.jobs.agent.permissions).toEqual({ contents: "read", "pull-requests": "write" });
      expect(doc.jobs["agent-push"].permissions).toEqual({ contents: "read" });
    }
  });

  it.each(["github", "forgejo"] as const)("%s: the ask never reaches a shell as an expression", (forge) => {
    const doc = withAgent(forge);
    for (const name of ["agent", "agent-push"]) expect(JSON.stringify(doc.jobs[name].steps), name).not.toContain("github.event.comment");
    const ask = doc.jobs.agent.steps.find((s: { id?: string }) => s.id === "ask").run as string;
    expect(ask).toContain(`terragucci comment --agent run${forge === "forgejo" ? " --forge forgejo" : ""} --policy-dir 'rego' --out /tmp/terragucci-agent/decision.json --prompt /tmp/terragucci-agent/prompt.md || exit 1`);
    const run = doc.jobs.agent.steps.find((s: { name?: string }) => s.name === "Run the agent on the ask").run as string;
    expect(run).toContain(`( ${AGENT_COMMAND} ) <"$TG_AGENT_PROMPT"`);
    expect(run).toContain('git -c core.hooksPath=/dev/null diff --cached --binary --no-renames "$TG_SHA" >/tmp/terragucci-agent/change/change.patch');
    const push = doc.jobs["agent-push"].steps.at(-1).run as string;
    expect(push).toContain("terragucci comment --agent push --change /tmp/terragucci-agent/change --policy-dir 'rego'");
    expect(doc.jobs.agent.steps.at(-1).uses).toMatch(forge === "forgejo" ? /upload-artifact@v3$/ : /^actions\/upload-artifact@v4$/);
    expect(doc.jobs["agent-push"].steps[1].uses).toMatch(forge === "forgejo" ? /download-artifact@v3$/ : /^actions\/download-artifact@v4$/);
  });

  it("the default command is Claude Code in print mode with the file tools and no web, MCP or project settings", () => {
    expect(AGENT_COMMAND).toMatch(/^npx -y @anthropic-ai\/claude-code@\d+\.\d+\.\d+ -p /);
    for (const flag of ['--max-turns "$TG_AGENT_MAX_TURNS"', "--permission-prompts none", "--setting-sources user", "--strict-mcp-config", '"Edit(.git/**)"', '"WebFetch"']) expect(AGENT_COMMAND).toContain(flag);
    expect(AGENT_COMMAND).not.toContain("dangerously");
    expect(AGENT_COMMAND).not.toContain("bypassPermissions");
    const custom = agentCommentInput(validateConfig({ agent: { via: "forge", token_env: "T", comment: { command: "my-agent --stdin", key_secret: "OPENAI_KEY" } } }, "t"))!;
    const doc = body(renderPipeline({ forge: "github", binary: "tofu", version: "1.13.1", image: "img:1", layers, env: {}, agentComment: custom }).content);
    const run = doc.jobs.agent.steps.find((s: { name?: string }) => s.name === "Run the agent on the ask");
    expect(run.run).toContain('( my-agent --stdin ) <"$TG_AGENT_PROMPT"');
    expect(run.env.OPENAI_KEY).toBe("${{ secrets.OPENAI_KEY }}");
    expect(run.env.TG_AGENT_MAX_TURNS).toBe("30");
    expect(doc.jobs.agent["timeout-minutes"]).toBe(30);
  });

  it("gitlab: refused, since a merge request note starts no pipeline", () => {
    expect(() => renderPipeline({ forge: "gitlab", binary: "tofu", version: "1.13.1", image: "img:1", layers, env: {}, agentComment: agent })).toThrow(/GitLab starts none for a merge request note/);
  });

  it("an agent that fails in the step's own shell still writes its exit code and the patch, so the push job can say it stopped", async () => {
    const work = tmp("tg-agent-work-");
    git(work, "init", "-q", "-b", "main");
    git(work, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "head");
    const sha = git(work, "rev-parse", "HEAD").trim();
    const dir = tmp("tg-agent-dir-");
    writeFileSync(join(dir, "prompt.md"), "the ask\n");
    const script = agentRunScript("echo half > half.txt; exit 2").replaceAll(AGENT_DIR, dir);
    expect(script.split("\n")[0]).toBe(READS_EXIT);
    const r = await runStep(`cd ${work} && ${script}`, { TG_SHA: sha });
    expect(r.status, r.out).toBe(0);
    expect(readFileSync(join(dir, "change", "rc"), "utf-8").trim()).toBe("2");
    expect(readFileSync(join(dir, "change", "change.patch"), "utf-8")).toContain("half.txt");
  });

  it("the agent's step runs without the runner's token variables, which Forgejo sets whatever permissions: says", async () => {
    const work = tmp("tg-agent-work-");
    git(work, "init", "-q", "-b", "main");
    git(work, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "head");
    const sha = git(work, "rev-parse", "HEAD").trim();
    const dir = tmp("tg-agent-dir-");
    writeFileSync(join(dir, "prompt.md"), "the ask\n");
    const script = agentRunScript('env | grep -E "^(GITHUB_TOKEN|FORGEJO_TOKEN|GITEA_TOKEN|ACTIONS_RUNTIME_TOKEN|ACTIONS_ID_TOKEN_REQUEST_TOKEN|ACTIONS_ID_TOKEN_REQUEST_URL)=" > seen.txt || true; echo "$ANTHROPIC_API_KEY" > key.txt').replaceAll(AGENT_DIR, dir);
    const tokens = Object.fromEntries(["GITHUB_TOKEN", "FORGEJO_TOKEN", "GITEA_TOKEN", "ACTIONS_RUNTIME_TOKEN", "ACTIONS_ID_TOKEN_REQUEST_TOKEN", "ACTIONS_ID_TOKEN_REQUEST_URL"].map((k) => [k, "secret"]));
    const r = await runStep(`cd ${work} && ${script}`, { TG_SHA: sha, ANTHROPIC_API_KEY: "model-key", ...tokens });
    expect(r.status, r.out).toBe(0);
    expect(readFileSync(join(work, "seen.txt"), "utf-8")).toBe("");
    expect(readFileSync(join(work, "key.txt"), "utf-8").trim()).toBe("model-key");
  });
});

describe("publish job", () => {
  const withPublish = (forge: ForgeName): string =>
    renderPipeline({ forge, binary: "tofu", version: "1.13.1", image: "img:1", layers, env: {}, publish: true }).content;

  it.each(FORGES)("%s: no publish job unless modules.publish is set", (forge) => {
    expect(render(forge)).not.toContain("terragucci publish");
    expect(render(forge)).not.toContain("TERRAGUCCI_REGISTRY");
  });

  it.each(["github", "forgejo"] as const)("%s: runs after apply on the default branch, with the registry credentials in that job only", (forge) => {
    const jobs = body(withPublish(forge)).jobs;
    expect(jobs.publish.needs).toBe("apply-wave-2");
    expect(jobs.publish.if).toContain("default_branch");
    expect(jobs.publish.env.TERRAGUCCI_REGISTRY_USER).toContain("secrets.TERRAGUCCI_REGISTRY_USER");
    expect(jobs.publish.env.TERRAGUCCI_REGISTRY_INSECURE).toContain("secrets.TERRAGUCCI_REGISTRY_INSECURE");
    expect(jobs.publish.steps[0].with["fetch-depth"]).toBe(0);
    expect(jobs.publish.steps.at(-1).run).toContain("terragucci publish");
    for (const name of ["check", "plan", "apply-wave-1", "apply-wave-2"]) expect(JSON.stringify(jobs[name])).not.toContain("REGISTRY");
  });

  it("gitlab: a publish job after apply, on the default branch, with full history", () => {
    const doc = body(withPublish("gitlab"));
    expect(doc.publish.needs).toEqual(["apply-wave-2"]);
    expect(doc.publish.rules[0].if).toContain("CI_DEFAULT_BRANCH");
    expect(doc.publish.variables.GIT_DEPTH).toBe("0");
    expect(doc.publish.script.join("\n")).toContain("terragucci publish");
    expect(JSON.stringify(doc["apply-wave-2"])).not.toContain("terragucci publish");
  });
});

describe("statuses", () => {
  it.each(FORGES)("%s: one status per stage, never one per root", (forge) => {
    const text = render(forge);
    const contexts = [...text.matchAll(/tg status (terragucci\/[a-z]+) /g)].map((m) => m[1]);
    expect([...new Set(contexts)].sort()).toEqual(["terragucci/apply", "terragucci/plan"]);
    expect(planScript("tofu", layers, forge)).not.toMatch(/tg status [^\n]*\$dir/);
    expect(applyScript("tofu", layers, forge)).not.toMatch(/tg status [^\n]*\$dir/);
  });

  it("plan runs on pull requests only and apply on the default branch only", () => {
    const gh = body(render("github")).jobs;
    expect(gh.plan.if).toContain("github.event_name == 'pull_request'");
    expect(gh["apply-wave-1"].if).toContain("default_branch");
    const gl = body(render("gitlab"));
    expect(gl.plan.rules[0].if).toContain("merge_request_event");
    expect(gl["apply-wave-1"].rules[0].if).toContain("CI_DEFAULT_BRANCH");
  });
});

describe("credentials", () => {
  it.each(FORGES)("%s: the plan job holds the plan role and the apply job holds the apply role, never the other", (forge) => {
    const doc = body(render(forge, OIDC));
    const jobs = forge === "gitlab" ? doc : doc.jobs;
    const flat = (j: unknown): string => JSON.stringify(j);
    expect(flat(jobs.plan)).toContain(OIDC.plan_role);
    expect(flat(jobs.plan)).not.toContain(OIDC.apply_role);
    expect(flat(jobs["apply-wave-1"])).toContain(OIDC.apply_role);
    expect(flat(jobs["apply-wave-1"])).not.toContain(OIDC.plan_role);
    expect(flat(jobs.check)).not.toMatch(/role/);
  });

  it("github: id-token is written for plan and apply; only an apply wave that can wait writes contents, for its gate record", () => {
    const doc = body(render("github", OIDC));
    for (const j of ["plan", "apply-wave-1", "apply-wave-2"]) expect(doc.jobs[j].permissions["id-token"]).toBe("write");
    expect(doc.jobs.plan.permissions.contents).toBe("read");
    expect(doc.jobs["apply-wave-1"].permissions.contents).toBe("write");
    expect(doc.permissions).toEqual({ contents: "read" });
    const never = body(renderPipeline({ forge: "github", binary: "tofu", version: "1.13.1", image: "img:1", layers, env: {}, oidc: OIDC, gate: "never" }).content);
    expect(never.jobs["apply-wave-1"].permissions.contents).toBe("read");
  });

  it("forgejo: the jobs that assume a role set enable-openid-connect, and the token comes from the runner's OIDC endpoint", () => {
    const text = render("forgejo", OIDC);
    const doc = body(text);
    for (const j of ["plan", "apply-wave-1", "apply-wave-2"]) {
      expect(doc.jobs[j]["enable-openid-connect"]).toBe(true);
      expect(doc.jobs[j].permissions["id-token"]).toBe("write");
    }
    expect(doc.jobs.check["enable-openid-connect"]).toBeUndefined();
    expect(doc["enable-openid-connect"]).toBeUndefined();
    expect(text).toContain("tg oidc");
    // A runner that serves no token stops the job and says what Forgejo needs.
    expect(text).toContain('if [ -z "${ACTIONS_ID_TOKEN_REQUEST_URL:-}" ]; then');
    expect(text).toContain("Forgejo Runner 12.5 or later, to a job that sets enable-openid-connect: true");
    expect(text).toContain("|| exit 1");
    expect(render("forgejo")).not.toContain("enable-openid-connect");
    expect(render("github", OIDC)).not.toContain("enable-openid-connect");
  });

  it.each(["github", "forgejo"] as const)("%s: a fork's pull request runs no plan, so no token or OIDC reaches it", (forge) => {
    const jobs = body(render(forge, OIDC)).jobs;
    expect(jobs.plan.if).toContain("github.event.pull_request.head.repo.full_name == github.repository");
    expect(jobs.check.if).toContain("!= github.repository");
    expect(render(forge)).not.toContain("pull_request_target");
    expect(render(forge)).not.toContain("secrets.");
  });

  it("gitlab: id_tokens on plan and apply, and plan skips a fork's merge request", () => {
    const doc = body(render("gitlab", OIDC));
    expect(doc.plan.id_tokens).toEqual({ TERRAGUCCI_OIDC: { aud: "sts.amazonaws.com" } });
    expect(doc["apply-wave-1"].id_tokens).toEqual({ TERRAGUCCI_OIDC: { aud: "sts.amazonaws.com" } });
    expect(doc.check.id_tokens).toBeUndefined();
    expect(doc.plan.rules[0].if).toContain("$CI_MERGE_REQUEST_SOURCE_PROJECT_PATH == $CI_PROJECT_PATH");
  });

  it.each(FORGES)("%s: with no oidc setting there is no id-token and no role", (forge) => {
    const text = render(forge);
    expect(text).not.toMatch(/id-token|id_tokens|AWS_ROLE_ARN/);
  });

  it("the config refuses one role for both stages, and a half-set pair", () => {
    expect(() => validateConfig({ oidc: { plan_role: "r", apply_role: "r" } }, "t")).toThrow(/same role/);
    expect(() => validateConfig({ oidc: { plan_role: "r" } }, "t")).toThrow(/apply_role must name a role/);
    expect(validateConfig({ oidc: OIDC }, "t").oidc).toEqual(OIDC);
  });
});

// ── running the generated scripts ────────────────────────────────────────────

/** A directory with fake binaries first on PATH: `tofu` by default, or others by name. */
function fakeBin(script: string, scripts: Record<string, string> = {}): { dir: string; env: Record<string, string> } {
  const dir = tmp("tg-bin-");
  const bin = join(dir, "bin");
  mkdirSync(bin);
  for (const [name, text] of Object.entries({ tofu: script, ...scripts })) {
    writeFileSync(join(bin, name), text);
    chmodSync(join(bin, name), 0o755);
  }
  return { dir, env: { PATH: `${bin}:${process.env.PATH}` } };
}

/** A `terragucci` that stands in for the apply stage and exits 0. */
const STAGE_OK = { terragucci: "#!/usr/bin/env bash\nexit 0\n" };

describe("the plugin cache", () => {
  it("roots applied together never share a cache directory, even when the env names one", async () => {
    const { dir, env } = fakeBin(
      `#!/usr/bin/env bash\ncase "$2" in init) echo "$(basename "\${1#-chdir=}") $TF_PLUGIN_CACHE_DIR" >> "\${LOG}"; sleep 0.3 ;; plan) for a in "$@"; do case "$a" in -out=*) : > "\${a#-out=}" ;; esac; done ;; show) echo '{"resource_changes":[]}' ;; esac\nexit 0\n`,
    );
    await terragucciBin(join(dir, "bin"));
    const log = join(dir, "cache.log");
    const script = join(dir, "apply.sh");
    writeFileSync(script, applyScript("tofu", [["a", "b", "c"]], "github"));
    const r = spawnSync("bash", [script], { cwd: dir, env: { ...process.env, ...env, LOG: log, TF_PLUGIN_CACHE_DIR: "/shared/cache" }, encoding: "utf-8" });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const dirs = readFileSync(log, "utf-8").trim().split("\n").map((l) => l.split(" ")[1]);
    expect(dirs).toHaveLength(3);
    expect(new Set(dirs).size).toBe(3);
    expect(dirs).not.toContain("/shared/cache");
    for (const d of dirs) expect(existsSync(d)).toBe(false);
  });
});

interface Hit { method: string; url: string; body: any }

/** A stand-in forge API: records requests, answers from `routes`. */
async function stubApi(routes: (hit: Hit) => unknown): Promise<{ url: string; hits: Hit[]; close: () => void }> {
  const hits: Hit[] = [];
  const server = createServer((req: IncomingMessage, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const hit = { method: req.method!, url: req.url!, body: raw ? JSON.parse(raw) : undefined };
      hits.push(hit);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(routes(hit) ?? {}));
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, hits, close: () => server.close() };
}

/** The shell a `shell: bash` step runs in, on GitHub and on Forgejo's runner. */
const STEP_SHELL = ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c"];

/** Runs a script the way its job's step does: with -e and pipefail on. */
function runStep(script: string, env: Record<string, string>): Promise<{ status: number | null; out: string }> {
  return run(script, env, STEP_SHELL);
}

function run(script: string, env: Record<string, string>, shell: string[] = ["-c"]): Promise<{ status: number | null; out: string }> {
  return new Promise((ok) => {
    const p = spawn("bash", [...shell, script], { env: { ...process.env, ...env } });
    let out = "";
    p.stdout.on("data", (c) => (out += c));
    p.stderr.on("data", (c) => (out += c));
    p.on("close", (status) => ok({ status, out }));
  });
}

/**
 * A fake binary for the plan stage: `plan -out=FILE` writes the root's name
 * into FILE, `show -json FILE` prints a plan for it from $PLANS/<root>.json,
 * and a root named in $FAIL fails to plan.
 */
const FAKE_TOFU = `#!/usr/bin/env bash
dir="\${1#-chdir=}"; shift; root="$(basename "$dir")"
case "$1" in
  init) exit 0 ;;
  plan)
    case " \${FAIL:-} " in *" $root "*) echo "Error: no credentials" >&2; exit 1 ;; esac
    for a in "$@"; do case "$a" in -out=*) echo "$root" > "\${a#-out=}" ;; esac; done
    echo "Plan: planned $root"; exit 0 ;;
  show)
    file="\${@: -1}"; r="$(cat "$file")"
    if [ "$2" = "-json" ]; then cat "$PLANS/$r.json"; else echo "plan text of $r"; fi ;;
esac
`;

const rc = (address: string, actions: string[], before: unknown, after: unknown) => {
  const [type, name] = address.split(".");
  return { address, mode: "managed", type, name, change: { actions, before, after, after_unknown: {}, before_sensitive: {}, after_sensitive: {} } };
};
const planOf = (changes: unknown[]) => JSON.stringify({ format_version: "1.2", resource_changes: changes, output_changes: {}, errored: false });

let CLI: string | undefined;
/** A `terragucci` on the path, bundled from this tree as the CI image carries it. */
async function terragucciBin(bin: string): Promise<void> {
  if (!CLI) {
    const { build } = await import("esbuild");
    CLI = join(tmp("tg-cli-"), "terragucci.mjs");
    await build({
      entryPoints: [join(import.meta.dirname, "../src/cli.ts")], outfile: CLI, bundle: true, platform: "node", format: "esm", target: "node22",
      external: ["@intentius/tsad-reference", "@cdktn/hcl2json", "typescript"], logLevel: "silent",
      banner: { js: "import { createRequire as __r } from 'node:module';\nconst require = __r(import.meta.url);" },
    });
  }
  writeFileSync(join(bin, "terragucci"), `#!/usr/bin/env bash\nexec node ${JSON.stringify(CLI)} "$@"\n`);
  chmodSync(join(bin, "terragucci"), 0o755);
}

async function planRepo(): Promise<{ repo: string; env: Record<string, string> }> {
  const { dir, env } = fakeBin(FAKE_TOFU);
  await terragucciBin(join(dir, "bin"));
  const repo = tmp("tg-repo-");
  const plans = join(dir, "plans");
  mkdirSync(plans);
  const queue = (r: string) => rc("aws_sqs_queue.jobs", ["update"], { name: "jobs", delay: 1 }, { name: "jobs", delay: 2 });
  writeFileSync(join(plans, "network.json"), planOf([queue("network")]));
  writeFileSync(join(plans, "app.json"), planOf([queue("app")]));
  writeFileSync(join(plans, "cache.json"), planOf([queue("cache"), rc("aws_db_instance.main", ["delete"], { id: "db" }, null), rc("aws_db_instance.old", ["delete"], { id: "old" }, null)]));
  for (const r of ["network", "app", "cache"]) mkdirSync(join(repo, r));
  return { repo, env: { ...env, PLANS: plans } };
}

describe("the plan stage", () => {
  it("runs the plan report, posts its note as the one plan note, and one status from its counts", async () => {
    const { repo, env } = await planRepo();
    const api = await stubApi(() => []);
    try {
      const r = await run(`cd ${JSON.stringify(repo)}\n${planScript("tofu", [["network"], ["app", "cache"]], "github")}`, {
        ...env, TG_TOKEN: "t", TG_SHA: "abc123", TG_PR: "7", GITHUB_API_URL: api.url, GITHUB_REPOSITORY: "acme/infra",
        GITHUB_SERVER_URL: "http://forge", GITHUB_RUN_ID: "9",
      });
      expect(r.status, r.out).toBe(0);
      const statuses = api.hits.filter((h) => h.url.includes("/statuses/"));
      expect(statuses.map((h) => [h.url, h.body.context, h.body.state])).toEqual([
        ["/repos/acme/infra/statuses/abc123", "terragucci/plan", "pending"],
        ["/repos/acme/infra/statuses/abc123", "terragucci/plan", "success"],
      ]);
      expect(statuses[1].body.description).toBe("3 roots, 2 groups, 2 destroys");
      const note = api.hits.find((h) => h.method === "POST" && h.url === "/repos/acme/infra/issues/7/comments")!;
      const lines = note.body.body.split("\n");
      expect(lines[0]).toBe("<!-- terragucci:plan roots=app,cache,network -->");
      expect(note.body.body).toBe(`${lines[0]}\n${readFileSync(join(repo, "terragucci-report/note.md"), "utf-8")}`);
      // With no reports.url, the report is only in the run's artifact: links go to the run page, with no anchors.
      expect(note.body.body).toContain("[`cache: aws_db_instance.main`](http://forge/acme/infra/actions/runs/9) (destroy)");
      expect(note.body.body).toContain("is `report.html` in the `terragucci-report` artifact of [this run](http://forge/acme/infra/actions/runs/9)");
      expect(note.body.body).not.toContain("runs/9#");
      const report = JSON.parse(readFileSync(join(repo, "terragucci-report/report.json"), "utf-8"));
      expect(report.run).toMatchObject({ commit: "abc123", project: "forge/acme/infra", binary: "tofu" });
      expect(report.roots.map((x: { path: string }) => x.path)).toEqual(["network", "app", "cache"].sort());
      expect(readFileSync(join(repo, "terragucci-report/roots/cache/plan.txt"), "utf-8")).toBe("plan text of cache\n");
    } finally {
      api.close();
    }
  });

  it("a root that fails to plan fails the stage and its status, and the note still goes up, in the step's own shell", async () => {
    const { repo, env } = await planRepo();
    const api = await stubApi(() => []);
    try {
      const r = await runStep(`cd ${JSON.stringify(repo)}\n${planScript("tofu", [["network"], ["app", "cache"]], "github")}`, {
        ...env, FAIL: "app", TG_TOKEN: "t", TG_SHA: "s", TG_PR: "7", GITHUB_API_URL: api.url, GITHUB_REPOSITORY: "o/r", GITHUB_SERVER_URL: "http://forge", GITHUB_RUN_ID: "1",
      });
      expect(r.status).toBe(1);
      expect(api.hits.at(-1)!.body).toMatchObject({ context: "terragucci/plan", state: "failure", description: "1 failed: 3 roots, 2 groups, 2 destroys" });
      expect(api.hits.some((h) => h.url === "/repos/o/r/issues/7/comments" && h.body.body.includes("refused to plan"))).toBe(true);
    } finally {
      api.close();
    }
  });

  it("the plan, re-plan and Terragrunt plan scripts turn off the step's -e, since each reads the stage's exit code", () => {
    expect(planScript("tofu", layers, "github").split("\n")[0]).toBe(READS_EXIT);
    expect(planScript("tofu", layers, "forgejo", OIDC, {}, true).split("\n")[0]).toBe(READS_EXIT);
    expect(planScript("tofu", layers, "github", undefined, { terragrunt: { prelude: "true" } }).split("\n")[0]).toBe(READS_EXIT);
    // GitLab runs the script in its own bash from a heredoc; the first line is the same there.
    expect(body(render("gitlab")).plan.script.join("\n")).toContain(`bash <<'PLAN'\n${READS_EXIT}\n`);
  });

  it("names the stage's roots, binary and bucket, so it plans what the pipeline names", () => {
    const s = planScript("tofu", layers, "github", undefined, { reports: { bucket: "s3://r", endpoint: "http://minio:9000", prefix: "p" }, canary: ["network"] });
    expect(s).toContain("terragucci stage tf-plan --out terragucci-report --binary tofu --layers 'network;app,cache'");
    expect(s).toContain("--canary 'network' --bucket 's3://r' --bucket-endpoint 'http://minio:9000' --bucket-prefix 'p'");
    expect(s).not.toContain("--bucket-url");
  });

  it("passes the bucket's address when reports.url is set, so the note links the bucket's copy (#131)", () => {
    const reports = { bucket: "s3://r", prefix: "p", url: "https://reports.example" };
    expect(planScript("tofu", layers, "forgejo", undefined, { reports })).toContain("--bucket-prefix 'p' --bucket-url 'https://reports.example'");
    expect(driftScript("tofu", layers, "github", undefined, { reports })).toContain("--bucket-url 'https://reports.example'");
  });

  it.each(FORGES)("%s: the plan job keeps the report with the job", (forge) => {
    const doc = body(render(forge));
    if (forge === "gitlab") {
      expect(doc.plan.artifacts).toEqual({ name: "terragucci-report", when: "always", paths: ["terragucci-report/"], reports: { terraform: "terragucci-report/gitlab-terraform.json" } });
      expect(doc.plan.script.join("\n")).toContain('--report-url "$CI_JOB_URL/artifacts/file/terragucci-report/report.html"');
    } else {
      const keep = doc.jobs.plan.steps.at(-1);
      expect(keep.if).toBe("always()");
      expect(keep.uses).toMatch(forge === "forgejo" ? /upload-artifact@v3$/ : /^actions\/upload-artifact@v4$/);
      expect(keep.with).toMatchObject({ name: "terragucci-report", path: "terragucci-report/" });
    }
  });

  it.each(FORGES)("%s: each apply job keeps the wave's report with the job", (forge) => {
    const doc = body(render(forge));
    const name = Object.keys(forge === "gitlab" ? doc : doc.jobs).find((k) => k.startsWith("apply"))!;
    if (forge === "gitlab") {
      expect(doc[name].artifacts).toMatchObject({ name: `terragucci-report-${name}`, when: "always", paths: expect.arrayContaining(["terragucci-report/"]) });
    } else {
      const keep = doc.jobs[name].steps.find((s: { name?: string }) => s.name === "Keep the apply report");
      expect(keep.if).toBe("always()");
      expect(keep.uses).toMatch(forge === "forgejo" ? /upload-artifact@v3$/ : /^actions\/upload-artifact@v4$/);
      expect(keep.with).toMatchObject({ name: `terragucci-report-${name}`, path: "terragucci-report/" });
    }
  });

  it("the stage plans without taking the state lock, so a pull request never blocks an apply", () => {
    expect(readFileSync(join(import.meta.dirname, "../src/report/stage.ts"), "utf-8")).toContain('"-lock=false"');
  });
});

describe("stale plan notes", () => {
  const applyEnv = (api: string, bin: Record<string, string>): Record<string, string> => ({
    // No branch, so a GitHub wave does not ask a remote for the tip (STAND_DOWN), whatever the test's own environment says.
    ...bin, TG_TOKEN: "t", TG_SHA: "s", TG_BRANCH: "main", GITHUB_REF_NAME: "", GITHUB_API_URL: api, GITHUB_REPOSITORY: "acme/infra", GITHUB_SERVER_URL: "http://forge", GITHUB_RUN_ID: "1",
  });
  const noteFor = (roots: string): { id: number; body: string } => ({ id: 55, body: `<!-- terragucci:plan roots=${roots} -->\n## terragucci plan\n` });

  it("marks a note stale when main moved under one of its roots", async () => {
    const { env } = fakeBin("#!/usr/bin/env bash\nexit 0\n", STAGE_OK);
    const api = await stubApi((h) => (h.url.startsWith("/repos/acme/infra/pulls") ? [{ number: 7 }] : h.url.includes("/issues/7/comments") && h.method === "GET" ? [noteFor("network,other")] : {}));
    try {
      const r = await run(applyScript("tofu", [["network"], ["app"]], "github"), applyEnv(api.url, env));
      expect(r.status).toBe(0);
      const edit = api.hits.find((h) => h.method === "PATCH")!;
      expect(edit.url).toBe("/repos/acme/infra/issues/comments/55");
      const lines = edit.body.body.split("\n");
      expect(lines[0]).toBe("<!-- terragucci:plan roots=network,other -->");
      expect(lines[1]).toBe("> This plan is stale: main moved under network. Push to this pull request to plan again. <!-- terragucci:stale -->");
    } finally {
      api.close();
    }
  });

  it("leaves a note alone when none of its roots moved, or when it is already stale", async () => {
    const { env } = fakeBin("#!/usr/bin/env bash\nexit 0\n", STAGE_OK);
    const stale = { id: 55, body: "<!-- terragucci:plan roots=app -->\n> stale <!-- terragucci:stale -->\n" };
    for (const note of [noteFor("elsewhere"), stale]) {
      const api = await stubApi((h) => (h.url.startsWith("/repos/acme/infra/pulls") ? [{ number: 7 }] : h.method === "GET" ? [note] : {}));
      try {
        await run(applyScript("tofu", [["app"]], "github"), applyEnv(api.url, env));
        expect(api.hits.some((h) => h.method === "PATCH")).toBe(false);
      } finally {
        api.close();
      }
    }
  });

  it("posts apply as pending from the first wave, then success from the last, once for the whole stage", async () => {
    const { env } = fakeBin("#!/usr/bin/env bash\nexit 0\n", STAGE_OK);
    const api = await stubApi(() => []);
    try {
      await run(applyScript("tofu", layers, "github", undefined, { wave: 1 }), applyEnv(api.url, env));
      await run(applyScript("tofu", layers, "github", undefined, { wave: 2 }), applyEnv(api.url, env));
      const s = api.hits.filter((h) => h.url.includes("/statuses/")).map((h) => [h.body.context, h.body.state, h.body.description]);
      expect(s).toEqual([
        ["terragucci/apply", "pending", "applying"],
        ["terragucci/apply", "success", "3 roots in 2 groups applied"],
      ]);
    } finally {
      api.close();
    }
  });

  it.each([
    [3, "pending", "wave 1 waits: chant approve tf-apply wave-1 --plan jcs1-sha256:abc123 --sign"],
    [4, "failure", "wave 1 was refused: its plans changed since the approval"],
  ] as const)("a wave that ends %i in the step's own shell still posts its status before the job fails", async (code, state, outcome) => {
    const { env } = fakeBin("#!/usr/bin/env bash\nexit 0\n", { terragucci: `#!/usr/bin/env bash\necho ${JSON.stringify(outcome)} > "$TG_OUTCOME"\nexit ${code}\n` });
    const api = await stubApi(() => []);
    try {
      const script = applyScript("tofu", layers, "github", undefined, { wave: 1 });
      expect(script.split("\n")[0]).toBe(READS_EXIT);
      const r = await runStep(script, applyEnv(api.url, env));
      expect(r.status, r.out).toBe(code);
      const s = api.hits.filter((h) => h.url.includes("/statuses/")).map((h) => [h.body.state, h.body.description]);
      expect(s.at(-1)).toEqual([state, outcome]);
    } finally {
      api.close();
    }
  });
});

describe("the Terragrunt apply in the step's own shell", () => {
  it("a wave that fails posts the failure status and runs the apply-failed response before the job fails, and later waves do not run", async () => {
    const { dir, env } = fakeBin("#!/usr/bin/env bash\nexit 0\n", {
      terragrunt: '#!/usr/bin/env bash\necho "$*" >> "$LOG"\necho "Error: apply failed"\nexit 1\n',
      terragucci: '#!/usr/bin/env bash\necho "terragucci $*" >> "$LOG"\nexit 0\n',
    });
    const log = join(dir, "calls.log");
    const api = await stubApi(() => []);
    try {
      const script = terragruntApplyScript([["live/a"], ["live/b"]], "github");
      expect(script.split("\n")[0]).toBe(READS_EXIT);
      const r = await runStep(`cd ${dir} && ${script}`, {
        ...env, LOG: log, TG_TOKEN: "t", TG_SHA: "s", TG_BRANCH: "main", GITHUB_REF_NAME: "", GITHUB_API_URL: api.url, GITHUB_REPOSITORY: "acme/infra", GITHUB_SERVER_URL: "http://forge", GITHUB_RUN_ID: "1",
      });
      expect(r.status, r.out).toBe(1);
      const calls = readFileSync(log, "utf-8").trim().split("\n");
      expect(calls.filter((c) => c.startsWith("run --all"))).toHaveLength(1);
      expect(calls.some((c) => c.startsWith("terragucci respond apply-failed --log "))).toBe(true);
      const s = api.hits.filter((h) => h.url.includes("/statuses/")).map((h) => [h.body.state, h.body.description]);
      expect(s.at(-1)).toEqual(["failure", "an apply failed"]);
    } finally {
      api.close();
    }
  });
});

describe("a GitHub wave whose push is no longer the branch tip", () => {
  it("stands down with a success status and applies nothing, since the apply group no longer cancels it", async () => {
    const origin = tmp("tg-origin-");
    git(origin, "init", "-q", "--bare");
    const work = tmp("tg-work-");
    git(work, "init", "-q", "-b", "main");
    git(work, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "one");
    git(work, "remote", "add", "origin", origin);
    git(work, "push", "-q", "origin", "main");
    const tip = git(work, "rev-parse", "HEAD").trim();
    const { dir, env } = fakeBin("#!/usr/bin/env bash\nexit 0\n", { terragucci: `#!/usr/bin/env bash\necho applied >> "$LOG"\nexit 0\n` });
    const log = join(dir, "apply.log");
    const api = await stubApi(() => []);
    try {
      const base = { ...env, LOG: log, TG_TOKEN: "t", TG_BRANCH: "main", GITHUB_REF_NAME: "main", GITHUB_API_URL: api.url, GITHUB_REPOSITORY: "acme/infra", GITHUB_SERVER_URL: "http://forge", GITHUB_RUN_ID: "1" };
      const old = await runStep(`cd ${work} && ${applyScript("tofu", layers, "github", undefined, { wave: 2 })}`, { ...base, GITHUB_SHA: "0".repeat(40), TG_SHA: "0".repeat(40) });
      expect(old.status, old.out).toBe(0);
      expect(old.out).toContain("standing down");
      expect(existsSync(log)).toBe(false);
      expect(api.hits.filter((h) => h.url.includes("/statuses/")).map((h) => [h.body.state, h.body.description])).toEqual([["success", "superseded by a newer push"]]);
      // The push at the tip applies.
      const now = await runStep(`cd ${work} && ${applyScript("tofu", layers, "github", undefined, { wave: 2 })}`, { ...base, GITHUB_SHA: tip, TG_SHA: tip });
      expect(now.status, now.out).toBe(0);
      expect(readFileSync(log, "utf-8").trim()).toBe("applied");
    } finally {
      api.close();
    }
  });
});

describe("two concurrent pushes to main on forgejo", () => {
  it("apply one after the other", async () => {
    const origin = tmp("tg-origin-");
    git(origin, "init", "-q", "--bare");
    const work = tmp("tg-work-");
    git(work, "init", "-q", "-b", "main");
    git(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "one");
    git(work, "remote", "add", "origin", origin);
    git(work, "push", "-q", "origin", "main");
    const sha = git(work, "rev-parse", "HEAD").trim();
    const { dir, env } = fakeBin("#!/usr/bin/env bash\nexit 0\n", {
      terragucci: `#!/usr/bin/env bash\necho "start $RUN $(date +%s.%N)" >> "$LOG"; sleep 1; echo "end $RUN $(date +%s.%N)" >> "$LOG"\nexit 0\n`,
    });
    const log = join(dir, "apply.log");
    const script = applyScript("tofu", [["a"]], "forgejo");
    const base = { ...env, LOG: log, TG_BRANCH: "main", GITHUB_REF_NAME: "main", GITHUB_SHA: sha, TG_SHA: sha, TG_LOCK_POLL: "0.2" };
    const go = (id: string) => spawnSync("true") && new Promise<{ status: number | null; out: string }>((ok) => {
      const p = spawn("bash", ["-c", script], { cwd: work, env: { ...process.env, ...base, RUN: id, GITHUB_RUN_ID: id } });
      let out = "";
      p.stdout.on("data", (c) => (out += c));
      p.stderr.on("data", (c) => (out += c));
      p.on("close", (status) => ok({ status, out }));
    });
    const results = await Promise.all([go("1"), go("2")]);
    expect(results.map((r) => r.status)).toEqual([0, 0]);
    const events = readFileSync(log, "utf-8").trim().split("\n").map((l) => l.split(" "));
    expect(events.map((e) => e[0])).toEqual(["start", "end", "start", "end"]);
    expect(events[0][1]).toBe(events[1][1]);
    expect(Number(events[1][2])).toBeLessThanOrEqual(Number(events[2][2]));
    expect(git(origin, "tag", "--list").trim()).toBe("");
  }, 30_000);

  it("a run whose commit is no longer the branch tip stands down", async () => {
    const origin = tmp("tg-origin-");
    git(origin, "init", "-q", "--bare");
    const work = tmp("tg-work-");
    git(work, "init", "-q", "-b", "main");
    git(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "one");
    git(work, "remote", "add", "origin", origin);
    git(work, "push", "-q", "origin", "main");
    const { dir, env } = fakeBin("#!/usr/bin/env bash\nexit 0\n", { terragucci: `#!/usr/bin/env bash\necho applied >> "$LOG"\nexit 0\n` });
    const log = join(dir, "apply.log");
    const r = await run(`cd ${work} && ${applyScript("tofu", [["a"]], "forgejo")}`, {
      ...env, LOG: log, TG_BRANCH: "main", GITHUB_REF_NAME: "main", GITHUB_SHA: "0".repeat(40), TG_SHA: "0".repeat(40), GITHUB_RUN_ID: "1",
    });
    expect(r.status).toBe(0);
    expect(r.out).toContain("standing down");
    expect(existsSync(log)).toBe(false);
  });

  describe("a holder that died without releasing the lock", () => {
    function held(lease: string): { origin: string; work: string; sha: string } {
      const origin = tmp("tg-origin-");
      git(origin, "init", "-q", "--bare");
      const work = tmp("tg-work-");
      git(work, "init", "-q", "-b", "main");
      git(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "one");
      git(work, "remote", "add", "origin", origin);
      git(work, "push", "-q", "origin", "main");
      const sha = git(work, "rev-parse", "HEAD").trim();
      const tree = git(work, "mktree").trim();
      const dead = git(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit-tree", tree, "-m", lease).trim();
      git(work, "push", "-q", "origin", `${dead}:refs/tags/terragucci-apply-lock`);
      return { origin, work, sha };
    }
    const env = (sha: string, extra: Record<string, string> = {}): Record<string, string> => ({
      TG_BRANCH: "main", GITHUB_REF_NAME: "main", GITHUB_SHA: sha, TG_SHA: sha, GITHUB_RUN_ID: "5", TG_LOCK_POLL: "0.2", ...extra,
    });

    it("is taken over when its run is no longer running, per the forge API", async () => {
      const { origin, work, sha } = held(`run 99 ${Math.floor(Date.now() / 1000)}`);
      const { env: bin } = fakeBin("#!/usr/bin/env bash\nexit 0\n", STAGE_OK);
      const api = await stubApi((h) => (h.url === "/repos/acme/infra/actions/runs/99" ? { status: "cancelled" } : {}));
      try {
        const r = await run(`cd ${work} && ${applyScript("tofu", [["a"]], "forgejo")}`, env(sha, { ...bin, TG_TOKEN: "t", GITHUB_API_URL: api.url, GITHUB_REPOSITORY: "acme/infra" }));
        expect(r.status).toBe(0);
        expect(r.out).toContain("run 99, which is gone; taking it over");
        expect(r.out).toContain("all roots applied");
        expect(git(origin, "tag", "--list").trim()).toBe("");
      } finally {
        api.close();
      }
    });

    it("is taken over when its lease is stale, with no forge API to ask", async () => {
      const { origin, work, sha } = held("run 99 1000");
      const { env: bin } = fakeBin("#!/usr/bin/env bash\nexit 0\n", STAGE_OK);
      const r = await run(`cd ${work} && ${applyScript("tofu", [["a"]], "forgejo")}`, env(sha, bin));
      expect(r.status).toBe(0);
      expect(r.out).toContain("taking it over");
      expect(git(origin, "tag", "--list").trim()).toBe("");
    });

    it("is respected while its run is still running", async () => {
      const { work, sha } = held(`run 99 ${Math.floor(Date.now() / 1000)}`);
      const { env: bin } = fakeBin("#!/usr/bin/env bash\nexit 0\n", STAGE_OK);
      const api = await stubApi((h) => (h.url === "/repos/acme/infra/actions/runs/99" ? { status: "running" } : {}));
      try {
        const p = spawn("bash", ["-c", `cd ${work} && ${applyScript("tofu", [["a"]], "forgejo")}`], { env: { ...process.env, ...env(sha, { ...bin, TG_TOKEN: "t", GITHUB_API_URL: api.url, GITHUB_REPOSITORY: "acme/infra" }) } });
        let out = "";
        p.stdout.on("data", (c) => (out += c));
        await new Promise((ok) => setTimeout(ok, 2500));
        p.kill();
        expect(out).not.toContain("all roots applied");
        expect(out).not.toContain("taking it over");
      } finally {
        api.close();
      }
    });
  });
});

describe("the drift stage", () => {
  const withDrift = (forge: ForgeName, oidc?: typeof OIDC): string =>
    renderPipeline({ forge, binary: "tofu", version: "1.13.1", image: "img:1", layers, env: {}, oidc, drift: "0 6 * * *" }).content;

  it.each(FORGES)("%s: no drift job unless drift names a schedule", (forge) => {
    expect(render(forge)).not.toContain("tf-drift");
  });

  it.each(["github", "forgejo"] as const)("%s: a scheduled run, or a manual one, runs drift and neither push job", (forge) => {
    const doc = body(withDrift(forge));
    expect(doc.on.schedule).toEqual([{ cron: "0 6 * * *" }]);
    expect(doc.on.workflow_dispatch).toBeDefined();
    expect(doc.jobs.drift.if).toBe("github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'");
    expect(doc.jobs["apply-wave-1"].if).toContain("github.event_name == 'push'");
    expect(doc.jobs.check.if).toContain("github.event_name == 'push'");
    expect(doc.jobs.plan.if).toContain("pull_request");
    const run = doc.jobs.drift.steps.map((s: any) => s.run).filter(Boolean).join("\n");
    expect(run).toContain("terragucci stage tf-drift");
    expect(run).toContain("--forge " + forge);
    // It reads; nothing in it applies. The drift response's apply mode opens a pull request.
    expect(run.replace("respond drift --mode apply", "respond drift")).not.toMatch(/\bapply\b/);
  });

  it("github: drift writes its issue and its pull request, and takes the read-only role", () => {
    const text = withDrift("github", OIDC);
    const drift = body(text).jobs.drift;
    expect(drift.permissions).toEqual({ contents: "write", issues: "write", "pull-requests": "write", "id-token": "write" });
    const run = drift.steps.map((s: any) => s.run).filter(Boolean).join("\n");
    expect(run).toContain(OIDC.plan_role);
    expect(run).not.toContain(OIDC.apply_role);
  });

  describe("in the step's own shell", () => {
    const fake = (code: number) => fakeBin("#!/usr/bin/env bash\nexit 0\n", {
      terragucci: `#!/usr/bin/env bash\necho "$*" >> "$LOG"\n[ "$1" = stage ] && exit ${code}\nexit 0\n`,
    });

    it.each([0, 1])("a sweep that ends %i ends the job with it, and only a clean sweep runs the drift response", async (code) => {
      const { dir, env } = fake(code);
      const log = join(dir, "terragucci.log");
      const script = driftScript("tofu", layers, "github", undefined, {}, {});
      expect(script.split("\n")[0]).toBe(READS_EXIT);
      const r = await runStep(`cd ${dir} && ${script}`, { ...env, LOG: log, TG_TOKEN: "t", GITHUB_SERVER_URL: "https://github.com", GITHUB_REPOSITORY: "acme/infra", GITHUB_RUN_ID: "1" });
      expect(r.status, r.out).toBe(code);
      const calls = readFileSync(log, "utf-8").trim().split("\n");
      expect(calls[0]).toMatch(/^stage tf-drift /);
      expect(calls.some((c) => c.startsWith("respond drift"))).toBe(code === 0);
    });
  });

  describe("movedRoots in the step's own shell", () => {
    const moved = async (roots: string[], changed: string[], before = true) => {
      const dir = tmp();
      const repo = join(dir, "repo");
      mkdirSync(repo);
      git(repo, "init", "-q", "-b", "main");
      writeFileSync(join(repo, "f"), "x");
      git(repo, "add", "-A");
      git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "one");
      const base = git(repo, "rev-parse", "HEAD").trim();
      git(repo, "remote", "add", "origin", repo);
      for (const f of changed) { mkdirSync(join(repo, f, ".."), { recursive: true }); writeFileSync(join(repo, f), "y"); }
      git(repo, "add", "-A");
      git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "two");
      const r = await runStep(`cd ${repo}\n${movedRoots(roots)}\necho "moved=$moved"`, { TG_BEFORE: before ? base : "" });
      return r.out.trim().split("\n").pop();
    };

    it("names the roots with a changed file, and every root when the push cannot be diffed", async () => {
      expect(await moved(["a", "b", "c"], ["b/x.tf"])).toBe("moved=b");
      expect(await moved(["a", "b"], ["b/x.tf"], false)).toBe("moved=a,b");
    });

    it("still matches the last root when thousands of files changed before it", async () => {
      // A long list is what made printf take SIGPIPE when grep -q quit at the first match.
      const many = Array.from({ length: 6000 }, (_, i) => `a/dir${i}/some-long-file-name-${i}.tf`);
      expect(await moved(["a", "z"], [...many, "z/last.tf"])).toBe("moved=a,z");
    });
  });

  it("gitlab: drift runs for scheduled pipelines only, and check and apply skip them", () => {
    const doc = body(withDrift("gitlab"));
    expect(doc.drift.rules).toEqual([{ if: '$CI_PIPELINE_SOURCE == "schedule"' }]);
    expect(doc.check.rules).toEqual([{ if: '$CI_PIPELINE_SOURCE != "schedule"' }]);
    expect(doc["apply-wave-1"].rules[0].if).toContain('$CI_PIPELINE_SOURCE != "schedule"');
    expect(doc.drift.script.join("\n")).toContain("terragucci stage tf-drift");
  });
});

describe("report storage keys", () => {
  const withReports = (forge: ForgeName, reports: { bucket: string; role?: string }): string =>
    renderPipeline({ forge, binary: "tofu", version: "1.13.1", image: "img:1", layers, env: {}, drift: "0 6 * * *", reports }).content;
  const KEYS = ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"];
  const WRITERS = ["plan", "drift"];

  it.each(["github", "forgejo"] as const)("%s: with a bucket and no role, the jobs that write reports map the key secrets, and no other job does", (forge) => {
    const doc = body(withReports(forge, { bucket: "s3://r" }));
    for (const job of WRITERS) for (const k of KEYS) expect(doc.jobs[job].env[k]).toBe(`\${{ secrets.${k} }}`);
    for (const job of ["check", "apply-wave-1", "apply-wave-2"]) for (const k of KEYS) expect(doc.jobs[job].env?.[k]).toBeUndefined();
  });

  it.each(["github", "forgejo"] as const)("%s: with reports.role the key secrets are not mapped", (forge) => {
    const doc = body(withReports(forge, { bucket: "s3://r", role: "arn:aws:iam::123456789012:role/terragucci-reports" }));
    for (const job of WRITERS) for (const k of KEYS) expect(doc.jobs[job].env?.[k]).toBeUndefined();
  });

  it.each(FORGES)("%s: with no bucket no key secret is mapped", (forge) => {
    expect(render(forge)).not.toContain("AWS_ACCESS_KEY_ID");
  });

  it("gitlab: the project's variables reach the jobs as they are, so nothing is mapped", () => {
    expect(withReports("gitlab", { bucket: "s3://r" })).not.toContain("AWS_ACCESS_KEY_ID");
  });
});

describe("telemetry headers secret", () => {
  const withHeaders = (forge: ForgeName): string =>
    renderPipeline({ forge, binary: "tofu", version: "1.13.1", image: "img:1", layers, env: {}, headersSecret: "OTLP_HEADERS" }).content;

  const withDrift = (forge: ForgeName): string =>
    renderPipeline({ forge, binary: "tofu", version: "1.13.1", image: "img:1", layers, env: {}, headersSecret: "OTLP_HEADERS", drift: "0 6 * * *", publish: true }).content;
  const SENDERS = ["plan", "apply-wave-1", "apply-wave-2", "drift"];

  it.each(["github", "forgejo"] as const)("%s: the secret is on the jobs that send telemetry alone", (forge) => {
    const doc = body(withDrift(forge));
    expect(doc.env?.OTEL_EXPORTER_OTLP_HEADERS).toBeUndefined();
    for (const job of SENDERS) expect(doc.jobs[job].env.OTEL_EXPORTER_OTLP_HEADERS).toBe("${{ secrets.OTLP_HEADERS }}");
    for (const job of ["check", "publish"]) expect(doc.jobs[job].env?.OTEL_EXPORTER_OTLP_HEADERS).toBeUndefined();
  });

  it("gitlab: the CI/CD variable is on the jobs that send telemetry alone", () => {
    const doc = body(withDrift("gitlab"));
    for (const job of SENDERS) expect(doc[job].variables.OTEL_EXPORTER_OTLP_HEADERS).toBe("$OTLP_HEADERS");
    for (const job of ["check", "publish"]) expect(doc[job].variables.OTEL_EXPORTER_OTLP_HEADERS).toBeUndefined();
  });

  it.each(FORGES)("%s: no headers setting renders no header variable", (forge) => {
    expect(render(forge)).not.toContain("OTEL_EXPORTER_OTLP_HEADERS");
  });

  it("validates the setting", () => {
    expect(validateConfig({ telemetry: { headers_secret: "OTLP_HEADERS" } }, "t").telemetry).toEqual({ headers_secret: "OTLP_HEADERS" });
    expect(() => validateConfig({ telemetry: { headers_secret: "not a name" } }, "t")).toThrow(/headers_secret/);
    expect(() => validateConfig({ telemetry: {} }, "t")).toThrow(/headers_secret/);
  });

  it("validates trace_url and reports.url (#131)", () => {
    const trace = "https://grafana.example/explore?left={trace_id}";
    expect(validateConfig({ telemetry: { trace_url: trace } }, "t").telemetry).toEqual({ trace_url: trace });
    expect(validateConfig({ telemetry: { headers_secret: "OTLP_HEADERS", trace_url: trace } }, "t").telemetry).toEqual({ headers_secret: "OTLP_HEADERS", trace_url: trace });
    expect(() => validateConfig({ telemetry: { trace_url: "https://grafana.example/explore" } }, "t")).toThrow(/trace_url .*\{trace_id\}/);
    expect(() => validateConfig({ telemetry: { trace_url: "grafana/{trace_id}" } }, "t")).toThrow(/trace_url/);
    expect(validateConfig({ reports: { bucket: "s3://r", url: "https://reports.example/r" } }, "t").reports).toEqual({ bucket: "s3://r", url: "https://reports.example/r" });
    expect(() => validateConfig({ reports: { bucket: "s3://r", url: "s3://r" } }, "t")).toThrow(/reports.url/);
    expect(() => validateConfig({ reports: { bucket: "s3://r", url: "https://reports.example/?x=1" } }, "t")).toThrow(/reports.url/);
  });
});

describe("respond steps", () => {
  const withRespond = (forge: ForgeName, respond?: Record<string, string>): string =>
    renderPipeline({ forge, binary: "tofu", version: "1.13.1", image: "img:1", layers, env: {}, drift: "0 6 * * *", ...(respond ? { respond } : {}) }).content;

  it.each(FORGES)("%s: triage, the refused wave, drift and fmt run by default", (forge) => {
    const text = withRespond(forge);
    expect(text).toContain('terragucci respond apply-failed --log "$log"');
    expect(text).toContain("terragucci respond wave-refused --wave 1");
    expect(text).toContain("terragucci respond drift --mode apply");
    expect(text).toContain("terragucci respond fmt --mode apply");
  });

  it.each(FORGES)("%s: a response set to off is not in the pipeline", (forge) => {
    const text = withRespond(forge, { "apply-failed": "off", "wave-refused": "off", drift: "off", fmt: "off", tips: "off" });
    expect(text).not.toContain("terragucci respond");
  });

  it("a wave waiting at a gate (exit 3) gets no response", () => {
    const script = applyScript("tofu", layers, "github", undefined, { wave: 1 });
    expect(script).toMatch(/3\) tg status terragucci\/apply pending "\$\(cat "\$outcome"\)"; exit 3 ;;/);
  });
});

describe("decide token on the plan jobs", () => {
  const withDecide = (forge: ForgeName, respond?: Record<string, string>): string =>
    renderPipeline({ forge, binary: "tofu", version: "1.13.1", image: "img:1", layers, env: {}, decideTokenEnv: "JEV_API_KEY", ...(respond ? { respond } : {}) }).content;

  it.each(["github", "forgejo"] as const)("%s: the plan and re-plan jobs map the secret when the description check is on", (forge) => {
    const doc = body(withDecide(forge, { description: "check" }));
    expect(doc.jobs.plan.env.JEV_API_KEY).toBe("${{ secrets.JEV_API_KEY }}");
    expect(doc.jobs.replan.env.JEV_API_KEY).toBe("${{ secrets.JEV_API_KEY }}");
    for (const job of ["check", "apply-wave-1"]) expect(doc.jobs[job].env?.JEV_API_KEY).toBeUndefined();
  });

  it.each(FORGES)("%s: nothing is mapped while the description check is off", (forge) => {
    expect(withDecide(forge)).not.toContain("JEV_API_KEY");
  });

  it.each(["github", "forgejo"] as const)("%s: the drift job maps the secret when drift attributes, and not otherwise", (forge) => {
    const render = (respond: Record<string, string>) =>
      renderPipeline({ forge, binary: "tofu", version: "1.13.1", image: "img:1", layers, env: {}, decideTokenEnv: "JEV_API_KEY", drift: "0 6 * * *", respond }).content;
    expect(body(render({ drift: "attribute" })).jobs.drift.env.JEV_API_KEY).toBe("${{ secrets.JEV_API_KEY }}");
    expect(body(render({ drift: "pull-request" })).jobs.drift.env.JEV_API_KEY).toBeUndefined();
    expect(body(render({ drift: "attribute" })).jobs.plan.env.JEV_API_KEY).toBeUndefined();
  });

  it.each(["github", "forgejo"] as const)("%s: the drift job installs the AWS CLI before tf-drift when drift attributes, and not otherwise", (forge) => {
    const render = (respond: Record<string, string>) =>
      renderPipeline({ forge, binary: "tofu", version: "1.13.1", image: "img:1", layers, env: {}, drift: "0 6 * * *", respond }).content;
    const steps = body(render({ drift: "attribute" })).jobs.drift.steps as { name?: string; run?: string }[];
    const at = steps.findIndex((s) => s.name?.startsWith("Install the AWS CLI"));
    expect(at).toBeGreaterThan(0);
    expect(steps[at + 1].run).toContain("terragucci stage tf-drift");
    expect(steps[at].run).toContain("if ! command -v aws");
    expect(steps[at].run).toContain(`awscli-exe-linux-$arch-${AWS_CLI.version}.zip`);
    expect(steps[at].run).toContain(AWS_CLI.sha256.x86_64);
    expect(steps[at].run).toContain(AWS_CLI.sha256.aarch64);
    expect(steps[at].run).toContain("sha256sum -c");
    expect(steps[at].run).toContain('>> "$GITHUB_PATH"');
    expect(render({ drift: "pull-request" })).not.toContain("AWS CLI");
    expect(render({})).not.toContain("AWS CLI");
    expect(body(render({ drift: "attribute" })).jobs.plan.steps.some((s: { name?: string }) => s.name?.startsWith("Install the AWS CLI"))).toBe(false);
  });

  it("gitlab: the drift job installs the AWS CLI before tf-drift when drift attributes, and not otherwise", () => {
    const render = (respond: Record<string, string>) =>
      renderPipeline({ forge: "gitlab", binary: "tofu", version: "1.13.1", image: "img:1", layers, env: {}, drift: "0 6 * * *", respond }).content;
    const script = (body(render({ drift: "attribute" })).drift.script as string[]);
    expect(script.findIndex((l) => l.includes("command -v aws"))).toBeGreaterThanOrEqual(0);
    expect(script.findIndex((l) => l.includes("command -v aws"))).toBeLessThan(script.findIndex((l) => l.includes("terragucci stage tf-drift")));
    expect(script.join("\n")).toContain('export PATH="$dir/bin:$PATH"');
    expect(render({ drift: "pull-request" })).not.toContain("command -v aws");
  });

  it("gitlab: the CI/CD variable is already in every job, so nothing is mapped", () => {
    expect(withDecide("gitlab", { description: "check" })).not.toContain("JEV_API_KEY");
  });
});

describe("the version-bump job", () => {
  const render = (forge: ForgeName, respond?: Record<string, string>, extra: object = {}): string =>
    renderPipeline({ forge, binary: "tofu", version: "1.13.1", image: "img:1", layers, env: {}, decideTokenEnv: "JEV_API_KEY", ...extra, ...(respond ? { respond } : {}) }).content;

  it.each(["github", "forgejo"] as const)("%s: respond.version-bump: suggest adds a job after the last apply that runs the response with the service's key", (forge) => {
    const job = body(render(forge, { "version-bump": "suggest" })).jobs["version-bump"];
    expect(job.needs).toBe("apply-wave-2");
    if (forge === "github") expect(job.permissions).toEqual({ contents: "write", "pull-requests": "write" });
    else expect(job.permissions?.contents).toBeUndefined();
    expect(job.env.JEV_API_KEY).toBe("${{ secrets.JEV_API_KEY }}");
    expect(job.steps[0].with["fetch-depth"]).toBe(0);
    expect(job.steps.at(-1).run).toContain("terragucci respond version-bump --mode apply || true");
  });

  it("gitlab: the job runs from the default branch with full history", () => {
    const job = body(render("gitlab", { "version-bump": "suggest" }))["version-bump"];
    expect(job.needs).toEqual(["apply-wave-2"]);
    expect(job.variables.GIT_DEPTH).toBe("0");
    expect(job.script.join("\n")).toContain("terragucci respond version-bump --mode apply || true");
  });

  it.each(FORGES)("%s: there is no job while version-bump is off", (forge) => {
    expect(render(forge)).not.toContain("version-bump");
  });
});

describe("GCP and Azure credentials", () => {
  const PROVIDER = "projects/123456/locations/global/workloadIdentityPools/forge/providers/ci";
  const GCP = { workload_identity_provider: PROVIDER, plan_service_account: "plan-ro@shop.iam.gserviceaccount.com", apply_service_account: "apply-rw@shop.iam.gserviceaccount.com" };
  const AZURE = { tenant_id: "tenant-1", subscription_id: "sub-1", plan_client_id: "client-plan", apply_client_id: "client-apply" };
  const CLOUDS = { gcp: GCP, azure: AZURE };
  const renderWith = (forge: ForgeName, oidc: Record<string, unknown>, extra: Record<string, unknown> = {}): string =>
    renderPipeline({ forge, binary: "tofu", version: "1.13.1", image: "img:1", layers, env: {}, oidc, ...extra } as never).content;

  it.each(FORGES)("%s: plan holds the plan service account and client, apply the apply ones, check neither", (forge) => {
    const doc = body(renderWith(forge, CLOUDS));
    const jobs = forge === "gitlab" ? doc : doc.jobs;
    const flat = (j: unknown): string => JSON.stringify(j);
    expect(flat(jobs.plan)).toContain(GCP.plan_service_account);
    expect(flat(jobs.plan)).toContain("ARM_CLIENT_ID='client-plan'");
    expect(flat(jobs.plan)).not.toContain(GCP.apply_service_account);
    expect(flat(jobs.plan)).not.toContain("client-apply");
    expect(flat(jobs["apply-wave-1"])).toContain(GCP.apply_service_account);
    expect(flat(jobs["apply-wave-1"])).toContain("ARM_CLIENT_ID='client-apply'");
    expect(flat(jobs["apply-wave-1"])).not.toContain(GCP.plan_service_account);
    expect(flat(jobs["apply-wave-1"])).not.toContain("client-plan");
    expect(flat(jobs.check)).not.toMatch(/GOOGLE_APPLICATION_CREDENTIALS|ARM_|id_tokens|id-token/);
    // No AWS role is set, so none is assumed.
    expect(flat(jobs.plan)).not.toContain("AWS_ROLE_ARN");
  });

  it.each(["github", "forgejo"] as const)("%s: one token request per audience, with the job's id-token permission", (forge) => {
    const text = renderWith(forge, CLOUDS);
    const doc = body(text);
    for (const j of ["plan", "replan", "apply-wave-1", "apply-wave-2"]) {
      expect(doc.jobs[j].permissions["id-token"]).toBe("write");
      if (forge === "forgejo") expect(doc.jobs[j]["enable-openid-connect"]).toBe(true);
    }
    const plan = doc.jobs.plan.steps.map((s: any) => s.run).filter(Boolean).join("\n");
    expect(plan).toContain(`tg oidc "$TERRAGUCCI_GCP_TOKEN_FILE" 'https://iam.googleapis.com/${PROVIDER}' || exit 1`);
    expect(plan).toContain(`tg oidc "$ARM_OIDC_TOKEN_FILE_PATH" 'api://AzureADTokenExchange' || exit 1`);
    expect(plan.match(/tg oidc /g)).toHaveLength(2);
    // A fork's pull request still gets no plan job, and apply runs only on the default branch.
    expect(doc.jobs.plan.if).toContain("github.event.pull_request.head.repo.full_name == github.repository");
    expect(doc.jobs["apply-wave-1"].if).toContain("github.ref == format('refs/heads/{0}', github.event.repository.default_branch)");
  });

  it("gitlab: an id_token per cloud, each with its audience, on plan, apply and drift", () => {
    const doc = body(renderWith("gitlab", CLOUDS, { drift: "0 6 * * *" }));
    const want = { TERRAGUCCI_OIDC_GCP: { aud: `https://iam.googleapis.com/${PROVIDER}` }, TERRAGUCCI_OIDC_AZURE: { aud: "api://AzureADTokenExchange" } };
    for (const j of ["plan", "apply-wave-1", "drift"]) expect(doc[j].id_tokens).toEqual(want);
    expect(doc.check.id_tokens).toBeUndefined();
    expect(doc.plan.script.join("\n")).toContain('printf \'%s\' "$TERRAGUCCI_OIDC_GCP" >"$TERRAGUCCI_GCP_TOKEN_FILE"');
    expect(doc.plan.script.join("\n")).toContain('printf \'%s\' "$TERRAGUCCI_OIDC_AZURE" >"$ARM_OIDC_TOKEN_FILE_PATH"');
    // Beside AWS, all three tokens, AWS's under its old name.
    const all = body(renderWith("gitlab", { ...OIDC, ...CLOUDS }));
    expect(all.plan.id_tokens).toEqual({ TERRAGUCCI_OIDC: { aud: "sts.amazonaws.com" }, ...want });
    expect(JSON.stringify(all.plan)).toContain(OIDC.plan_role);
  });

  it.each(FORGES)("%s: drift takes the plan identities", (forge) => {
    const run = driftScript("tofu", layers, forge, CLOUDS);
    expect(run).toContain(GCP.plan_service_account);
    expect(run).toContain("client-plan");
    expect(run).not.toContain(GCP.apply_service_account);
    expect(run).not.toContain("client-apply");
  });

  it("the token step writes the external_account file and the ARM variables the providers read", async () => {
    const api = await stubApi((hit) => ({ value: "jwt-for-" + new URL(hit.url, "http://x").searchParams.get("audience") }));
    try {
      const script = [
        forgeApi("github"),
        ...cloudScripts("github", CLOUDS, "plan", "terragucci-plan"),
        'cat "$GOOGLE_APPLICATION_CREDENTIALS"',
        'echo "gcp-token=$(cat "$(node -e \'console.log(JSON.parse(require("fs").readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS,"utf-8")).credential_source.file)\')")"',
        'echo "azure-token=$(cat "$ARM_OIDC_TOKEN_FILE_PATH")"',
        'echo "arm=$ARM_USE_OIDC,$ARM_CLIENT_ID,$ARM_TENANT_ID,$ARM_SUBSCRIPTION_ID"',
      ].join("\n");
      const r = await run(script, { ACTIONS_ID_TOKEN_REQUEST_URL: `${api.url}/token?api-version=2.0`, ACTIONS_ID_TOKEN_REQUEST_TOKEN: "req" });
      expect(r.status, r.out).toBe(0);
      const lines = r.out.trim().split("\n");
      const cred = JSON.parse(lines[0]);
      expect(cred).toMatchObject({
        type: "external_account",
        audience: `//iam.googleapis.com/${PROVIDER}`,
        subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
        token_url: "https://sts.googleapis.com/v1/token",
        service_account_impersonation_url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${GCP.plan_service_account}:generateAccessToken`,
      });
      expect(lines).toContain(`gcp-token=jwt-for-https://iam.googleapis.com/${PROVIDER}`);
      expect(lines).toContain("azure-token=jwt-for-api://AzureADTokenExchange");
      expect(lines).toContain("arm=true,client-plan,tenant-1,sub-1");
      expect(api.hits).toHaveLength(2);
    } finally {
      api.close();
    }
  });

  it("gitlab: the token step writes each cloud's id_token to its file", async () => {
    const script = [
      ...cloudScripts("gitlab", CLOUDS, "apply", "terragucci-apply"),
      'node -e \'const c=JSON.parse(require("fs").readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS,"utf-8"));console.log(require("fs").readFileSync(c.credential_source.file,"utf-8"),c.service_account_impersonation_url)\'',
      'echo "$(cat "$ARM_OIDC_TOKEN_FILE_PATH") $ARM_CLIENT_ID"',
    ].join("\n");
    const r = await run(script, { TERRAGUCCI_OIDC_GCP: "gcp-jwt", TERRAGUCCI_OIDC_AZURE: "azure-jwt" });
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain(`gcp-jwt https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${GCP.apply_service_account}:generateAccessToken`);
    expect(r.out).toContain("azure-jwt client-apply");
  });

  it("a runner that serves no token stops the job before it plans", async () => {
    const r = await run([forgeApi("forgejo"), ...cloudScripts("forgejo", { gcp: GCP }, "plan", "terragucci-plan"), "echo planned"].join("\n"), { ACTIONS_ID_TOKEN_REQUEST_URL: "" });
    expect(r.status).toBe(1);
    expect(r.out).not.toContain("planned");
  });

  it("a regional token URL and a sovereign audience reach the credential file and the token request", () => {
    const oidc = { gcp: { ...GCP, token_url: "https://sts.europe-west3.rep.googleapis.com/v1/token" }, azure: { ...AZURE, audience: "api://AzureADTokenExchangeUSGov" } };
    const run = cloudScripts("github", oidc, "plan", "terragucci-plan").join("\n");
    expect(run).toContain('"https://sts.europe-west3.rep.googleapis.com/v1/token"');
    expect(run).not.toContain("https://sts.googleapis.com/v1/token");
    expect(run).toContain(`tg oidc "$ARM_OIDC_TOKEN_FILE_PATH" 'api://AzureADTokenExchangeUSGov' || exit 1`);
    expect(run).not.toContain("'api://AzureADTokenExchange'");
    expect(cloudScripts("github", CLOUDS, "plan", "terragucci-plan").join("\n")).toContain('"https://sts.googleapis.com/v1/token"');
  });

  it.each(["github", "forgejo"] as const)("%s: the no-token check runs once per script however many clouds are set", (forge) => {
    const count = (s: string): number => s.split("ACTIONS_ID_TOKEN_REQUEST_URL:-").length - 1;
    expect(count(cloudScripts(forge, { ...OIDC, ...CLOUDS }, "plan", "terragucci-plan").join("\n"))).toBe(1);
    expect(count(cloudScripts(forge, CLOUDS, "apply", "terragucci-apply").join("\n"))).toBe(1);
    expect(count(cloudScripts(forge, OIDC, "plan", "terragucci-plan").join("\n"))).toBe(1);
  });

  it("the config takes a token_url and an audience, and refuses empty or non-https ones", () => {
    const oidc = { gcp: { ...GCP, token_url: "https://sts.europe-west3.rep.googleapis.com/v1/token" }, azure: { ...AZURE, audience: "api://AzureADTokenExchangeChina" } };
    expect(validateConfig({ oidc }, "t").oidc).toEqual(oidc);
    expect(() => validateConfig({ oidc: { gcp: { ...GCP, token_url: "http://sts.example/v1/token" } } }, "t")).toThrow(/token_url must be an https URL/);
    expect(() => validateConfig({ oidc: { azure: { ...AZURE, audience: "" } } }, "t")).toThrow(/azure.audience must be a non-empty string/);
  });

  it("the config takes gcp and azure beside or instead of AWS, and refuses one identity for both stages", () => {
    expect(validateConfig({ oidc: CLOUDS }, "t").oidc).toEqual(CLOUDS);
    expect(validateConfig({ oidc: { ...OIDC, ...CLOUDS } }, "t").oidc).toEqual({ ...OIDC, ...CLOUDS });
    expect(() => validateConfig({ oidc: { gcp: { ...GCP, apply_service_account: GCP.plan_service_account } } }, "t")).toThrow(/same service account/);
    expect(() => validateConfig({ oidc: { azure: { ...AZURE, apply_client_id: "client-plan" } } }, "t")).toThrow(/same client/);
    expect(() => validateConfig({ oidc: { gcp: { ...GCP, workload_identity_provider: "my-pool" } } }, "t")).toThrow(/provider's resource name/);
    expect(() => validateConfig({ oidc: { gcp: { ...GCP, plan_service_account: "plan-ro" } } }, "t")).toThrow(/service account's email/);
    expect(() => validateConfig({ oidc: { azure: { tenant_id: "t" } } }, "t")).toThrow(/azure.plan_client_id must be set/);
    expect(() => validateConfig({ oidc: { azure: { ...AZURE, region: "x" } } }, "t")).toThrow(/azure.region is not a setting/);
    expect(() => validateConfig({ oidc: {} }, "t")).toThrow(/must set plan_role and apply_role \(AWS\), gcp, azure, or several/);
    expect(() => validateConfig({ oidc: { plan_role: "r", gcp: GCP } }, "t")).toThrow(/apply_role must name a role/);
  });
});
