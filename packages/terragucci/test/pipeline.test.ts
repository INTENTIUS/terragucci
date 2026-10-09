import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer, type IncomingMessage } from "node:http";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import { validateConfig } from "../src/config";
import { AGENT_COMMAND, AGENT_DIR, agentCommentInput } from "../src/agent-comment";
import { agentRunScript } from "../src/render-agent";
import { applyScript, AWS_CLI, cloudScripts, commentApplyScript, confirmScript, driftScript, forgeApi, gitlabApplyScript, gitlabMergeScript, gitlabProtectedPlanScript, gitlabTokenCheck, mergeScript, movedRoots, planFilesScript, planScript, replanDecideScript, dropForgeTokens, publishScript, READS_EXIT, renderPipeline } from "../src/render";
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
    // Without `policy:` the clone is shallow; with it the policy tests have the history. Neither keeps credentials.
    expect(check.steps[0].with).toEqual({ "persist-credentials": false });
    // The check runs the branch's code, so the job and its step hold no forge token.
    expect(JSON.stringify(check)).not.toContain("TG_TOKEN:");
    expect(check.permissions).toBeUndefined();
    expect(run.split("\n")[0]).toBe(dropForgeTokens("sh"));
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

  it("gitlab: every push remote uses the server's own protocol and port", () => {
    const remote = 'git remote set-url origin "${CI_SERVER_PROTOCOL}://oauth2:${TG_TOKEN}@${CI_SERVER_FQDN}/${CI_PROJECT_PATH}.git"';
    expect(publishScript("gitlab")).toContain(remote);
    expect(applyScript("tofu", layers, "gitlab")).toContain(remote);
    // A policy denial is recorded on chant/lifecycle for an override, so a wave under gate: never pushes too when policy is set.
    expect(applyScript("tofu", layers, "gitlab", undefined, { wave: 1, gate: "never" })).not.toContain(remote);
    expect(applyScript("tofu", layers, "gitlab", undefined, { wave: 1, gate: "never", policy: true })).toContain(remote);
    const policyNever = renderPipeline({ forge: "gitlab", binary: "tofu", version: "1.13.1", image: "img:1", layers, env: {}, policy: true, gate: "never" }).content;
    expect(body(policyNever)["apply-wave-1"].script.join("\n")).toContain(remote);
    const all = renderPipeline({ forge: "gitlab", binary: "tofu", version: "1.13.1", image: "img:1", layers, env: {}, policy: true }).content;
    expect(all).not.toContain("CI_SERVER_HOST");
    expect(all).not.toContain("https://oauth2");
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
    expect(tg.jobs["apply-wave-1"].concurrency).toEqual({ group: GROUP, "cancel-in-progress": false, queue: "max" });
  });

  it("forgejo: no queue key, since Forgejo runs a workflow's jobs whatever their concurrency says and the lock tag holds the apply", () => {
    const doc = body(render("forgejo", OIDC));
    for (const job of ["apply-wave-1", "apply-wave-2", "apply-comment"]) {
      expect(doc.jobs[job].concurrency, job).toEqual({ group: GROUP, "cancel-in-progress": false });
    }
  });

  it("github: a push's wave stands down when the branch moved past it, because nothing cancels it any more; the comment's apply does not", () => {
    for (const wave of [1, 2]) expect(applyScript("tofu", layers, "github", undefined, { wave })).toContain("standing down");
    expect(applyScript("tofu", [["live/a"]], "github", undefined, { wave: 1, terragrunt: { prelude: "true" } })).toContain("standing down");
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

  it("the re-plan decides from the comment with the token, before the head is checked out, and plans the head with no token", () => {
    const decide = replanDecideScript(layers, "github");
    expect(decide).toContain("terragucci comment --layers");
    expect(decide).toContain('[ -n "$TG_ROOT" ] || tg status terragucci/plan pending "planning"');
    expect(decide).toContain('>>"$GITHUB_OUTPUT"');
    const job = body(render("github")).jobs.replan;
    const names = job.steps.map((s: any) => s.id ?? s.uses ?? s.name);
    expect(names.indexOf("decide")).toBeLessThan(names.lastIndexOf("actions/checkout@v4"));
    expect(job.steps.find((s: any) => s.id === "decide").env).toEqual({ TG_TOKEN: "${{ github.token }}" });
    const plan = job.steps.find((s: any) => typeof s.run === "string" && s.run.includes("terragucci stage tf-plan"));
    expect(plan.env.TG_TOKEN).toBeUndefined();
    expect(plan.run).toContain('${TG_ROOT:+--root "$TG_ROOT"}');
    expect(plan.run.split("\n")[0]).toBe(dropForgeTokens());
    expect(JSON.stringify(job.env ?? {})).not.toContain("TG_TOKEN");
    for (const s of job.steps.filter((s: any) => s.uses === "actions/checkout@v4")) expect(s.with["persist-credentials"]).toBe(false);
  });

  it("a re-plan of a root the change does not reach is answered by the replan-note job, which leaves the note and status", () => {
    const doc = body(render("github"));
    expect(doc.jobs["replan-note"].needs).toBe("replan");
    expect(doc.jobs["replan-note"].steps.at(-1).run).toContain('${TG_ROOT:+--root "$TG_ROOT"}');
    expect(doc.jobs["plan-note"].steps.at(-1).run).not.toContain("--root");
  });

  it("forgejo: the re-plan reads the commenter's permission from the event, and checks out the pull request's head by number", () => {
    expect(replanDecideScript(layers, "forgejo")).toMatch(/terragucci comment --layers [^\n]* --forge forgejo --out /);
    expect(replanDecideScript(layers, "github")).not.toContain("--forge");
    const job = body(render("forgejo")).jobs.replan;
    expect(JSON.stringify(job.steps)).toContain("refs/pull/${{ steps.decide.outputs.pr }}/head");
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

  it.each(["github", "forgejo"] as const)("%s: a Terragrunt repo gets the apply-comment job, which runs its waves of units with --terragrunt after the apply prelude, and no canary", (forge) => {
    const credentials = { "live/prod/**": { plan: "arn:aws:iam::1:role/p", apply: "arn:aws:iam::1:role/a" } };
    const doc = body(renderPipeline({ forge, binary: "tofu", version: "1.13.1", image: "img:1", layers: [["live/dev/a"], ["live/prod/a", "live/prod/b"]], env: {}, gate: "always", canary: ["live/dev/**"], terragrunt: { version: "0.99.0", parallelism: 4, exclude: [], installs: [], credentials } }).content);
    const job = doc.jobs["apply-comment"];
    expect(job.if).toBe("github.event_name == 'issue_comment' && startsWith(github.event.comment.body, '/terragucci apply')");
    expect(doc.jobs.replan.if).toContain("!startsWith(github.event.comment.body, '/terragucci apply')");
    expect(job.concurrency).toEqual(doc.jobs["apply-wave-1"].concurrency);
    const run = job.steps.find((s: { run?: string }) => s.run?.includes("terragucci comment-apply")).run as string;
    expect(run).toMatch(/terragucci comment-apply --layers 'live\/dev\/a;live\/prod\/a,live\/prod\/b'( --forge forgejo)? --out /);
    expect(run).not.toContain("--canary");
    expect(run).toContain('terragucci stage tf-apply --wave "$wave" --layers \'live/dev/a;live/prod/a,live/prod/b\' --binary tofu --gate always --terragrunt $rest');
    // A comment that asks for every wave runs the last with --rest, so the waves past the pipeline's jobs apply too.
    expect(run).toContain('rest=""; if [ "$TG_WAVE" = "-" ] && [ "$wave" = "$last" ]; then rest="--rest"; fi');
    expect(run).not.toContain("-auto-approve");
    // The apply jobs' prelude: the caches and the auth provider with the apply roles, after the decision and the checkout.
    expect(run).toContain('TG_DOWNLOAD_DIR="$PWD/.terragrunt-cache/sources"');
    expect(run).toContain("TERRAGUCCI_PHASE=apply");
    expect(run).not.toContain("TERRAGUCCI_PHASE=plan");
    expect(run.indexOf('git checkout --quiet --detach "$TG_SHA"')).toBeLessThan(run.indexOf("TERRAGUCCI_PHASE=apply"));
    expect(run).toContain('tg status terragucci/apply success "every wave of units applied"');
    expect(job.steps.find((s: { uses?: string }) => s.uses?.endsWith("actions/cache@v4"))?.with.path).toBe(".terragrunt-cache");
    if (forge === "github") expect(job.permissions).toMatchObject({ contents: "write", "id-token": "write" });
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

    it("in a Terragrunt repo the last wave runs with --rest, and a refusal past it is answered for the wave that stopped", async () => {
      const { work, sha } = repo();
      const { dir, env } = fakeBin("#!/usr/bin/env bash\nexit 0\n", {
        terragucci: [
          "#!/usr/bin/env bash",
          'if [ "$1" = comment-apply ]; then while [ $# -gt 0 ]; do [ "$1" = --out ] && out="$2"; shift; done; printf \'%s\\n\' "$DECISION" > "$out"; exit 0; fi',
          'if [ "$1" = respond ]; then echo "respond ${*:2}" >> "$LOG"; exit 0; fi',
          'echo "wave $4${*: -1:1}" | sed "s/--terragrunt$//" >> "$LOG"',
          'if [ "$4" = 2 ]; then echo "wave 3 changed after approval: live/c" > "$TG_OUTCOME"; exit 4; fi',
          "exit 0",
        ].join("\n"),
      });
      const api = await stubApi(() => ({}));
      try {
        const script = commentApplyScript("tofu", [["live/a"], ["live/b"]], "github", undefined, { terragrunt: { prelude: "true" } });
        const r = await runStep(`cd ${work} && ${script}`, { ...env, ...envFor(api.url, dir, decision({ go: true, pr: 7, sha, base: "main" })) });
        expect(r.status, r.out).toBe(4);
        const calls = readFileSync(join(dir, "stage.log"), "utf-8").trim().split("\n");
        expect(calls).toEqual(["wave 1", "wave 2--rest", "respond wave-refused --wave 3 --approved terragucci-report/approved --current terragucci-report/current"]);
        expect(api.hits.find((h) => h.url === "/repos/acme/infra/issues/7/comments")?.body.body).toContain("wave 3 was refused");
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

describe("locks: plan", () => {
  const renderLocks = (forge: ForgeName, extra: object = {}): Record<string, any> =>
    body(renderPipeline({ forge, binary: "tofu", version: "1.13.1", image: "img:1", layers, env: {}, oidc: OIDC, locksPlan: true, ...extra }).content);

  it.each(["github", "forgejo"] as const)("%s: the pr-lock job runs on pull_request_target and on plan, lock and unlock comments, from the default branch, with no cloud role and no binary", (forge) => {
    const doc = renderLocks(forge);
    expect(doc.on.pull_request_target).toEqual({ types: ["opened", "reopened", "synchronize", "closed"] });
    const job = doc.jobs["pr-lock"];
    expect(job.if).toBe("github.event_name == 'pull_request_target' || (github.event_name == 'issue_comment' && (startsWith(github.event.comment.body, '/terragucci plan') || (startsWith(github.event.comment.body, '/terragucci lock') || startsWith(github.event.comment.body, '/terragucci unlock'))))");
    if (forge === "github") expect(job.permissions).toEqual({ contents: "write", statuses: "write", "pull-requests": "write" });
    expect(job.env).toEqual({ TG_TOKEN: "${{ github.token }}" });
    // The checkout is the default branch's: no ref of the pull request, no install, no OIDC.
    expect(job.steps).toHaveLength(2);
    expect(job.steps[0].with).toEqual({ "fetch-depth": 0 });
    expect(JSON.stringify(job)).not.toContain(OIDC.plan_role);
    expect(JSON.stringify(job)).not.toContain("head.sha");
    expect(job["enable-openid-connect"]).toBeUndefined();
    expect(job.steps[1].run.trim()).toBe(`set -euo pipefail\nterragucci pr-lock --layers 'network;app,cache'${forge === "forgejo" ? " --forge forgejo" : ""}`);
    // The re-plan job leaves lock and unlock to it; apply-comment still takes only apply.
    expect(doc.jobs.replan.if).toContain("!(startsWith(github.event.comment.body, '/terragucci lock') || startsWith(github.event.comment.body, '/terragucci unlock'))");
    // Pushes, plans and applies do not run on the new trigger: every other job names its own event or needs check.
    for (const [name, j] of Object.entries(doc.jobs) as [string, any][]) {
      if (name === "pr-lock") continue;
      expect(String(j.if ?? "") + String(j.needs ?? ""), name).toMatch(/event_name == '(push|pull_request|issue_comment|pull_request_review|schedule)'|check|apply-wave|confirm|replan/);
    }
    if (forge === "forgejo") expect(doc.concurrency.group).toContain("github.event_name == 'pull_request_target' && format('lock-{0}', github.event.pull_request.number)");
  });

  it("under apply.when: pull-request, pr-lock reads only plan comments, and the apply-comment job keeps lock and unlock; a Terragrunt repo locks units", () => {
    const doc = renderLocks("github", { applyWhen: "pull-request", terragrunt: { version: "0.99.0", parallelism: 4, exclude: [], installs: [] }, layers: [["live/a"]] });
    expect(doc.jobs["pr-lock"].if).toBe("github.event_name == 'pull_request_target' || (github.event_name == 'issue_comment' && startsWith(github.event.comment.body, '/terragucci plan'))");
    expect(doc.jobs["pr-lock"].steps[1].run).toContain("terragucci pr-lock --layers 'live/a' --when pull-request --terragrunt");
    expect(doc.jobs["apply-comment"].if).toContain("'/terragucci unlock'");
    expect(doc.jobs.replan.if).not.toContain("!(startsWith(github.event.comment.body, '/terragucci lock')");
  });

  it("GitLab refuses it, and without it no pipeline has pull_request_target or pr-lock", () => {
    expect(() => renderLocks("gitlab")).toThrow(/locks: plan is not supported on GitLab/);
    for (const forge of ["github", "forgejo"] as const) {
      expect(render(forge)).not.toContain("pull_request_target");
      expect(body(render(forge)).jobs["pr-lock"]).toBeUndefined();
    }
  });
});

describe("apply before merge (apply.when: pull-request)", () => {
  const renderPr = (forge: ForgeName, merge?: "auto" | "manual", mergeToken?: string, requires?: ("approved" | "mergeable" | "undiverged" | "checks")[]): Record<string, any> =>
    body(renderPipeline({ forge, binary: "tofu", version: "1.13.1", image: "img:1", layers, env: {}, oidc: OIDC, applyWhen: "pull-request", ...(merge ? { applyMerge: merge } : {}), ...(mergeToken ? { applyMergeTokenEnv: mergeToken } : {}), ...(requires ? { applyRequires: requires } : {}) }).content);

  it.each(["github", "forgejo"] as const)("%s: the comment job takes apply, lock and unlock, and the push after the merge confirms instead of applying", (forge) => {
    const doc = renderPr(forge);
    const job = doc.jobs["apply-comment"];
    expect(job.if).toBe("github.event_name == 'issue_comment' && (startsWith(github.event.comment.body, '/terragucci apply') || startsWith(github.event.comment.body, '/terragucci lock') || startsWith(github.event.comment.body, '/terragucci unlock'))");
    expect(doc.jobs.replan.if).toContain("!(startsWith(github.event.comment.body, '/terragucci apply') || startsWith(github.event.comment.body, '/terragucci lock') || startsWith(github.event.comment.body, '/terragucci unlock'))");
    // Forgejo ignores permissions:, so only GitHub's jobs carry them.
    if (forge === "github") expect(job.permissions.contents).toBe("write");
    if (forge === "github") expect(job.permissions.checks).toBe("read");
    const run = job.steps.find((s: { run?: string }) => s.run?.includes("terragucci comment-apply")).run as string;
    expect(run).toContain("--when pull-request");
    expect(run).not.toContain("--requires");
    expect(doc.jobs["apply-wave-1"]).toBeUndefined();
    const confirm = doc.jobs.confirm;
    expect(confirm.needs).toBe("check");
    expect(confirm.if).toBe("github.ref == format('refs/heads/{0}', github.event.repository.default_branch)");
    if (forge === "github") expect(confirm.permissions.contents).toBe("read");
    const plan = confirm.steps.find((s: { run?: string }) => s.run?.includes("terragucci stage tf-plan")).run as string;
    expect(plan).toContain(OIDC.plan_role);
    expect(plan).not.toContain(OIDC.apply_role);
    expect(plan).not.toContain("tf-apply");
    expect(doc.jobs.tips.needs).toBe("confirm");
  });

  it("apply.requires is written as --requires only when it leaves a requirement out", () => {
    const run = (requires?: ("approved" | "mergeable" | "undiverged" | "checks")[]): string =>
      renderPr("github", undefined, undefined, requires).jobs["apply-comment"].steps.find((s: { run?: string }) => s.run?.includes("terragucci comment-apply")).run as string;
    expect(run(["checks", "undiverged", "mergeable", "approved"])).not.toContain("--requires");
    expect(run(["approved"])).toContain("--when pull-request --requires approved --out");
    expect(run([])).toContain("--requires none");
  });

  it("apply after merge is unchanged when apply.when is unset", () => {
    const doc = body(render("github", OIDC));
    expect(doc.jobs.confirm).toBeUndefined();
    expect(doc.jobs["apply-wave-1"]).toBeDefined();
    expect(doc.jobs["apply-comment"].permissions.checks).toBeUndefined();
  });

  it("an open pull request's waves read the gate rule from its base, and only apply.merge auto merges", () => {
    const manual = commentApplyScript("tofu", layers, "github", OIDC, { when: "pull-request" });
    expect(manual).toContain('if [ "$TG_OPEN" = 1 ]; then what="the head"; tf_base="--base origin/$TG_BASE"; fi');
    expect(manual).toContain('terragucci stage tf-apply --wave "$wave" --layers');
    expect(manual).toMatch(/--gate on-destroy \$tf_base/);
    // The responses read the base's settings on an open pull request, and carry no flag after a merge.
    expect(manual).toContain('terragucci respond wave-refused --wave "$wave" --approved terragucci-report/approved --current terragucci-report/current $tf_base || true');
    expect(manual).toContain('terragucci respond apply-failed --log "$log" $tf_base || true');
    expect(manual).not.toContain("pr-merge");
    expect(manual).not.toContain("GITHUB_OUTPUT");
    expect(manual).toContain("Merge it when you are ready");
    const auto = commentApplyScript("tofu", layers, "forgejo", OIDC, { when: "pull-request", merge: "auto" });
    // The job that ran the pull request's code never merges: it hands the head on, after the loop, which exits at the first wave that does not apply.
    expect(auto).not.toContain("terragucci pr-merge");
    expect(auto.indexOf('echo "merge=1"')).toBeGreaterThan(auto.indexOf("done\n"));
    expect(mergeScript("forgejo")).toContain('terragucci pr-merge --pr "$TG_PR" --sha "$TG_SHA" --forge forgejo');
  });

  it("gitlab needs comments and a merge token: the comments job reads the note and starts the apply pipeline with that token", () => {
    expect(() => renderPr("gitlab", undefined, "MERGE_TOKEN")).toThrow(/apply\.when: pull-request on GitLab needs comments: <cron>/);
    expect(() => body(renderPipeline({ forge: "gitlab", binary: "tofu", version: "1.13.1", image: "img:1", layers, env: {}, comments: "*/5 * * * *", applyWhen: "pull-request" }).content)).toThrow(/needs apply\.merge_token_env/);
  });

  describe("gitlab", () => {
    const gl = (extra: Partial<Parameters<typeof renderPipeline>[0]> = {}): Record<string, any> =>
      body(renderPipeline({ forge: "gitlab", binary: "tofu", version: "1.13.1", image: "img:1", layers, env: {}, oidc: OIDC, comments: "*/5 * * * *", applyWhen: "pull-request", applyMergeTokenEnv: "MERGE_TOKEN", ...extra }).content);

    it("the push after the merge confirms; the apply pipeline runs mr-apply alone, from the default branch, under the apply group", () => {
      const doc = gl();
      expect(doc["apply-wave-1"]).toBeUndefined();
      expect(doc.confirm.rules[0].if).toBe('$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH && $CI_PIPELINE_SOURCE != "schedule" && $TERRAGUCCI_MR == null');
      expect(doc.confirm.script.join("\n")).toContain(OIDC.plan_role);
      expect(doc.confirm.script.join("\n")).not.toContain(OIDC.apply_role);
      expect(doc.check.rules[0].if).toBe('$CI_PIPELINE_SOURCE != "schedule" && $TERRAGUCCI_MR == null');
      const job = doc["mr-apply"];
      expect(job.rules).toEqual([{ if: '$CI_PIPELINE_SOURCE == "api" && $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH && $TERRAGUCCI_MR' }]);
      expect(job.resource_group).toBe("terragucci-apply");
      expect(job.variables.GIT_DEPTH).toBe("0");
      expect(job.environment).toBeUndefined();
      expect(JSON.stringify(job)).not.toContain("MERGE_TOKEN");
      const run = job.script.join("\n");
      expect(run).toContain("terragucci comment-apply --forge gitlab --layers 'network;app,cache' --when pull-request --out terragucci-comment.json || exit 1");
      // The decision comes before the apply role.
      expect(run.indexOf("terragucci comment-apply")).toBeLessThan(run.indexOf(OIDC.apply_role));
      expect(run).toContain('tf_base="--base origin/$TG_BASE"');
      expect(run).toMatch(/--gate on-destroy \$tf_base/);
      // No status on the head: a failed one would fail the merge request's own pipeline.
      expect(run).not.toContain("tg status");
      expect(run).toContain("Merge it when you are ready");
      expect(doc["pr-merge"]).toBeUndefined();
    });

    it("the comments job polls with --when pull-request and holds the merge token, in the merge environment, as pr-merge does", () => {
      const doc = gl({ applyMerge: "auto", applyRequires: ["approved", "checks"] });
      expect(doc.comments.variables).toEqual({ TG_TOKEN: "$GITLAB_TOKEN", TG_MERGE_TOKEN: "$MERGE_TOKEN", GIT_STRATEGY: "none" });
      expect(doc.comments.environment).toEqual({ name: "terragucci-merge", action: "access" });
      expect(doc.comments.script.join("\n")).toContain("terragucci comment --forge gitlab --poll --layers 'network;app,cache' --when pull-request --requires approved,checks");
      const merge = doc["pr-merge"];
      expect(merge.needs).toEqual([{ job: "mr-apply", artifacts: false }]);
      expect(merge.environment).toEqual({ name: "terragucci-merge", action: "access" });
      expect(merge.variables).toEqual({ TG_TOKEN: "$GITLAB_TOKEN", TG_MERGE_TOKEN: "$MERGE_TOKEN" });
      expect(merge.id_tokens).toBeUndefined();
      expect(merge.script.join("\n")).toContain('terragucci pr-merge --forge gitlab --pr "$TG_PR" --sha "$TG_SHA"');
      const run = doc["mr-apply"].script.join("\n");
      expect(run).toContain("--when pull-request --requires approved,checks --out");
      expect(run).toContain("<!-- terragucci:applied head=$TG_SHA pipeline=$CI_PIPELINE_ID -->");
      expect(run).not.toContain("terragucci pr-merge");
    });

    it("a Terragrunt repo's mr-apply runs its waves of units with --terragrunt and locks units", () => {
      const run = gitlabApplyScript("tofu", [["live/a"], ["live/b"]], OIDC, { when: "pull-request", terragrunt: { prelude: "# prelude" } });
      expect(run).toContain("terragucci comment-apply --forge gitlab --layers 'live/a;live/b' --when pull-request --terragrunt --out");
      expect(run).toContain("# prelude");
      expect(run).toMatch(/terragucci stage tf-apply --wave "\$wave" .*--terragrunt \$tf_base \$rest/);
    });

    it("pr-merge reads nothing the mr-apply job wrote: only the pipeline's variables pass, as digits and a sha", () => {
      const run = gitlabMergeScript();
      expect(run).toContain('case "${TERRAGUCCI_MR:-}" in ""|*[!0-9]*)');
      expect(run).toContain('case "${TERRAGUCCI_HEAD:-}" in ""|*[!0-9a-f]*)');
      expect(run).not.toMatch(/artifact|dotenv/);
    });
  });

  it("apply.merge auto merges in a pr-merge job of its own, the only job that gets apply.merge_token_env's secret", () => {
    // Forgejo pushes a merge as its doer, and refuses a push to a branch from the job's own token.
    expect(() => renderPr("forgejo", "auto")).toThrow(/apply\.merge: auto on Forgejo needs apply\.merge_token_env/);
    for (const forge of ["github", "forgejo"] as const) {
      const doc = renderPr(forge, "auto", "MERGE_TOKEN");
      const apply = doc.jobs["apply-comment"];
      const merge = doc.jobs["pr-merge"];
      expect(apply.env.TG_MERGE_TOKEN).toBeUndefined();
      expect(JSON.stringify(apply)).not.toContain("MERGE_TOKEN");
      expect(apply.outputs).toEqual({ merge: "${{ steps.apply.outputs.merge }}", sha: "${{ steps.apply.outputs.sha }}", waves: "${{ steps.apply.outputs.waves }}" });
      expect(apply.steps.find((s: { run?: string }) => s.run?.includes("terragucci comment-apply")).id).toBe("apply");
      expect(merge.needs).toBe("apply-comment");
      expect(merge.if).toBe("needs.apply-comment.outputs.merge == '1'");
      expect(merge.env).toEqual({
        TG_TOKEN: "${{ github.token }}",
        TG_MERGE_TOKEN: "${{ secrets.MERGE_TOKEN }}",
        TG_PR: "${{ github.event.issue.number }}",
        TG_SHA: "${{ needs.apply-comment.outputs.sha }}",
        TG_WAVES: "${{ needs.apply-comment.outputs.waves }}",
      });
      // No cloud role, no install, no checkout of the pull request: the default branch's checkout and the merge.
      expect(JSON.stringify(merge)).not.toContain(OIDC.apply_role);
      expect(merge.steps).toHaveLength(2);
      expect(merge.steps[0].uses).toMatch(/actions\/checkout@v4$/);
      expect(merge.steps[0].with).toBeUndefined();
      // The outputs never reach the script as expressions, only through the environment.
      expect(merge.steps[1].run).not.toContain("${{");
    }
    expect(renderPr("github", "auto").jobs["pr-merge"].env.TG_MERGE_TOKEN).toBeUndefined();
    expect(renderPr("github", "manual").jobs["pr-merge"]).toBeUndefined();
    expect(renderPr("forgejo", "manual").jobs["apply-comment"].outputs).toBeUndefined();
  });

  it.each(["github", "forgejo"] as const)("%s: a Terragrunt repo applies before merge: the comment locks units, the waves of units run from the head, and the confirm job plans every unit after the plan prelude", (forge) => {
    const tgLayers = [["live/canary/one"], ["live/fleet/two"]];
    const doc = body(renderPipeline({ forge, binary: "tofu", version: "1.13.1", image: "img:1", layers: tgLayers, env: {}, gate: "always", terragrunt: { version: "0.99.0", parallelism: 4, exclude: [], installs: [] }, applyWhen: "pull-request", applyMerge: "auto", ...(forge === "forgejo" ? { applyMergeTokenEnv: "MERGE_TOKEN" } : {}) }).content);
    expect(doc.jobs["apply-wave-1"]).toBeUndefined();
    expect(doc.jobs["pr-merge"]).toBeDefined();
    const run = doc.jobs["apply-comment"].steps.find((s: { run?: string }) => s.run?.includes("terragucci comment-apply")).run as string;
    expect(run).toContain("--when pull-request --terragrunt --out terragucci-comment.json");
    expect(run).toContain('terragucci stage tf-apply --wave "$wave" --layers \'live/canary/one;live/fleet/two\' --binary tofu --gate always --terragrunt $tf_base $rest');
    // Forgejo decides again once it holds the apply lock, and says nothing twice.
    if (forge === "forgejo") expect(run).toContain("--terragrunt --again --out");
    else expect(run).not.toContain("--again");
    const confirm = doc.jobs.confirm.steps.find((s: { run?: string }) => s.run?.includes("terragucci stage tf-plan")).run as string;
    expect(confirm).toContain("--terragrunt");
    expect(confirm).toContain('TG_DOWNLOAD_DIR="$PWD/.terragrunt-cache/sources"');
    expect(confirm.indexOf("TG_DOWNLOAD_DIR")).toBeLessThan(confirm.indexOf("terragucci stage tf-plan"));
    expect(confirm).toContain("every unit plans no change");
    // A merge-mode Terragrunt pipeline's decision carries no --terragrunt: it takes no locks.
    const merge = body(renderPipeline({ forge, binary: "tofu", version: "1.13.1", image: "img:1", layers: tgLayers, env: {}, terragrunt: { version: "0.99.0", parallelism: 4, exclude: [], installs: [] } }).content);
    expect(merge.jobs["apply-comment"].steps.find((s: { run?: string }) => s.run?.includes("terragucci comment-apply")).run).not.toContain("--terragrunt --out");
  });

  describe("in the step's own shell", () => {
    const fake = () => fakeBin("#!/usr/bin/env bash\nexit 0\n", {
      terragucci: [
        "#!/usr/bin/env bash",
        'if [ "$1" = comment-apply ]; then while [ $# -gt 0 ]; do [ "$1" = --out ] && out="$2"; shift; done; printf \'%s\\n\' "$DECISION" > "$out"; exit 0; fi',
        'if [ "$1" = pr-merge ]; then echo "$*" >> "$LOG"; if [ -n "${MERGE_FAILS:-}" ]; then echo "terragucci pr-merge: not merged: the forge refused the merge (POST answered 409)"; exit 1; fi; echo "terragucci pr-merge: merged pull request 7 at abcdef12"; exit 0; fi',
        'if [ "$1" = stage ] && [ "$2" = tf-plan ]; then mkdir -p terragucci-report; printf \'%s\' "$REPORT" > terragucci-report/report.json; exit 0; fi',
        'echo "$*" >> "$LOG"',
        "exit 0",
      ].join("\n"),
    });
    const head = (): { work: string; sha: string } => {
      const work = tmp("tg-work-");
      git(work, "init", "-q", "-b", "main");
      git(work, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "head");
      return { work, sha: git(work, "rev-parse", "HEAD").trim() };
    };
    const envFor = (api: string, dir: string, d: Record<string, unknown>): Record<string, string> => ({
      LOG: join(dir, "stage.log"), DECISION: JSON.stringify(d), TG_TOKEN: "t", GITHUB_API_URL: api, GITHUB_REPOSITORY: "acme/infra", GITHUB_SERVER_URL: "https://forge.test", GITHUB_RUN_ID: "9",
    });

    it("applies an open pull request's head with --base and, with apply.merge auto, hands the head to pr-merge, which merges it and says so", async () => {
      const { work, sha } = head();
      const { dir, env } = fake();
      const api = await stubApi(() => ({}));
      const output = join(dir, "output");
      try {
        const r = await runStep(`cd ${work} && ${commentApplyScript("tofu", layers, "github", undefined, { when: "pull-request", merge: "auto" })}`, { ...env, ...envFor(api.url, dir, { go: true, open: true, pr: 7, sha, base: "main" }), GITHUB_OUTPUT: output });
        expect(r.status, r.out).toBe(0);
        const log = readFileSync(join(dir, "stage.log"), "utf-8").trim().split("\n");
        expect(log.filter((l) => l.startsWith("stage tf-apply")).every((l) => l.endsWith("--base origin/main"))).toBe(true);
        expect(log.some((l) => l.startsWith("pr-merge"))).toBe(false);
        expect(readFileSync(output, "utf-8")).toBe(`merge=1\nsha=${sha}\nwaves=1, 2\n`);
        expect(api.hits.filter((h) => h.url === "/repos/acme/infra/issues/7/comments")).toEqual([]);
        const m = await runStep(`cd ${work} && ${mergeScript("github")}`, { ...env, ...envFor(api.url, dir, {}), TG_PR: "7", TG_SHA: sha, TG_WAVES: "1, 2" });
        expect(m.status, m.out).toBe(0);
        expect(readFileSync(join(dir, "stage.log"), "utf-8").trim().split("\n").at(-1)).toBe(`pr-merge --pr 7 --sha ${sha}`);
        const reply = api.hits.find((h) => h.url === "/repos/acme/infra/issues/7/comments")?.body.body as string;
        expect(reply).toBe(`terragucci: applied wave 1, 2 of pull request 7 at ${sha.slice(0, 8)}, and merged pull request 7 at abcdef12. https://forge.test/acme/infra/actions/runs/9`);
      } finally {
        api.close();
      }
    });

    it("pr-merge reads what the apply job handed on as data: a head that is not a sha merges nothing, and the waves keep only digits", async () => {
      const { work, sha } = head();
      const { dir, env } = fake();
      const api = await stubApi(() => ({}));
      try {
        const bad = await runStep(`cd ${work} && ${mergeScript("github")}`, { ...env, ...envFor(api.url, dir, {}), TG_PR: "7", TG_SHA: "$(touch pwned)", TG_WAVES: "1" });
        expect(bad.status).toBe(1);
        expect(existsSync(join(work, "pwned"))).toBe(false);
        expect(existsSync(join(dir, "stage.log"))).toBe(false);
        const odd = await runStep(`cd ${work} && ${mergeScript("github")}`, { ...env, ...envFor(api.url, dir, {}), TG_PR: "7", TG_SHA: sha, TG_WAVES: "1, 2 `id` $(id)" });
        expect(odd.status, odd.out).toBe(0);
        const reply = api.hits.find((h) => h.url === "/repos/acme/infra/issues/7/comments")?.body.body as string;
        expect(reply).toContain("applied wave 1, 2 of pull request 7");
        // A Terragrunt run's last wave says it ran every wave after it; the reply keeps the numbers.
        const tg = await runStep(`cd ${work} && ${mergeScript("github")}`, { ...env, ...envFor(api.url, dir, {}), TG_PR: "7", TG_SHA: sha, TG_WAVES: "1, 2 and every wave after it" });
        expect(tg.status, tg.out).toBe(0);
        expect(api.hits.filter((h) => h.url === "/repos/acme/infra/issues/7/comments").at(-1)?.body.body).toContain("applied wave 1, 2 of pull request 7 at");
      } finally {
        api.close();
      }
    });

    it("a refused merge fails the job, and the reply gives the forge's reason once", async () => {
      const { work, sha } = head();
      const { dir, env } = fake();
      const api = await stubApi(() => ({}));
      try {
        const r = await runStep(`cd ${work} && ${mergeScript("github")}`, { ...env, ...envFor(api.url, dir, {}), TG_PR: "7", TG_SHA: sha, TG_WAVES: "1, 2", MERGE_FAILS: "1" });
        expect(r.status, r.out).toBe(1);
        const reply = api.hits.find((h) => h.url === "/repos/acme/infra/issues/7/comments")?.body.body as string;
        expect(reply).toBe(`terragucci: applied wave 1, 2 of pull request 7 at ${sha.slice(0, 8)}, and it was not merged: the forge refused the merge (POST answered 409). Merge it by hand. https://forge.test/acme/infra/actions/runs/9`);
      } finally {
        api.close();
      }
    });

    it("a merged pull request applies its merge commit without --base and is not merged again", async () => {
      const { work, sha } = head();
      const { dir, env } = fake();
      const api = await stubApi(() => ({}));
      try {
        const r = await runStep(`cd ${work} && ${commentApplyScript("tofu", layers, "github", undefined, { when: "pull-request", merge: "auto" })}`, { ...env, ...envFor(api.url, dir, { go: true, pr: 7, sha, base: "main" }) });
        expect(r.status, r.out).toBe(0);
        const log = readFileSync(join(dir, "stage.log"), "utf-8");
        expect(log).not.toContain("--base");
        expect(log).not.toContain("pr-merge");
      } finally {
        api.close();
      }
    });

    it("the confirm job fails naming the roots that still plan a change, and passes when none does", async () => {
      const { work } = head();
      const { env } = fake();
      const api = await stubApi(() => ({}));
      const report = (changes: unknown[]) => JSON.stringify({ roots: [{ path: "network", changes }, { path: "app", changes: [{ action: "read" }] }] });
      try {
        const base = { TG_TOKEN: "t", TG_SHA: "a".repeat(40), GITHUB_API_URL: api.url, GITHUB_REPOSITORY: "acme/infra", GITHUB_SERVER_URL: "https://forge.test", GITHUB_RUN_ID: "9" };
        const moved = await runStep(`cd ${work} && ${confirmScript("tofu", layers, "github")}`, { ...env, ...base, REPORT: report([{ action: "update" }]) });
        expect(moved.status).toBe(1);
        expect(api.hits.filter((h) => h.url.includes("/statuses/")).at(-1)?.body).toMatchObject({ context: "terragucci/apply", state: "failure", description: "roots still plan a change after the merge: network" });
        const still = await runStep(`cd ${work} && ${confirmScript("tofu", layers, "github")}`, { ...env, ...base, REPORT: report([]) });
        expect(still.status, still.out).toBe(0);
        expect(api.hits.filter((h) => h.url.includes("/statuses/")).at(-1)?.body.state).toBe("success");
      } finally {
        api.close();
      }
    });
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

  it.each(["github", "forgejo"] as const)("%s: with attest, the publish job alone gets the signing key's secrets", (forge) => {
    expect(JSON.stringify(body(withPublish(forge)).jobs)).not.toContain("COSIGN");
    const jobs = body(renderPipeline({ forge, binary: "tofu", version: "1.13.1", image: "img:1", layers, env: {}, publish: true, attest: true }).content).jobs;
    expect(jobs.publish.env.COSIGN_PRIVATE_KEY).toBe("${{ secrets.COSIGN_PRIVATE_KEY }}");
    expect(jobs.publish.env.COSIGN_PASSWORD).toBe("${{ secrets.COSIGN_PASSWORD }}");
    const steps = jobs.publish.steps.map((s: { run?: string }) => s.run ?? "");
    expect(steps.findIndex((r: string) => r.includes("terragucci install cosign 2.6.5"))).toBe(steps.length - 2);
    expect(JSON.stringify(body(withPublish(forge)).jobs.publish)).not.toContain("install cosign");
    for (const name of ["check", "plan", "apply-wave-1", "apply-wave-2"]) expect(JSON.stringify(jobs[name])).not.toContain("COSIGN");
  });

  it.each(["github", "forgejo"] as const)("%s: with modules.registry in a bucket, the publish job alone gets the bucket's key secrets", (forge) => {
    expect(JSON.stringify(body(withPublish(forge)).jobs.publish)).not.toContain("AWS_ACCESS_KEY_ID");
    const jobs = body(renderPipeline({ forge, binary: "tofu", version: "1.13.1", image: "img:1", layers, env: {}, publish: true, publishBucket: "s3://acme-modules" }).content).jobs;
    expect(jobs.publish.env.AWS_ACCESS_KEY_ID).toBe("${{ secrets.AWS_ACCESS_KEY_ID }}");
    expect(jobs.publish.env.AWS_SECRET_ACCESS_KEY).toBe("${{ secrets.AWS_SECRET_ACCESS_KEY }}");
    const azure = body(renderPipeline({ forge, binary: "tofu", version: "1.13.1", image: "img:1", layers, env: {}, publish: true, publishBucket: "az://acmemods/modules" }).content).jobs;
    expect(azure.publish.env.AZURE_STORAGE_KEY).toBe("${{ secrets.AZURE_STORAGE_KEY }}");
    for (const name of ["check", "plan", "apply-wave-1", "apply-wave-2"]) expect(JSON.stringify(jobs[name])).not.toContain("AWS_ACCESS_KEY_ID");
  });

  it("gitlab: a publish job after apply, on the default branch, with full history", () => {
    const doc = body(withPublish("gitlab"));
    expect(doc.publish.needs).toEqual(["apply-wave-2"]);
    expect(doc.publish.rules[0].if).toContain("CI_DEFAULT_BRANCH");
    expect(doc.publish.variables.GIT_DEPTH).toBe("0");
    expect(doc.publish.script.join("\n")).toContain("terragucci publish");
    expect(JSON.stringify(doc["apply-wave-2"])).not.toContain("terragucci publish");
    expect(doc.publish.script.join("\n")).not.toContain("install cosign");
    const attested = body(renderPipeline({ forge: "gitlab", binary: "tofu", version: "1.13.1", image: "img:1", layers, env: {}, publish: true, attest: true }).content);
    expect(attested.publish.script[0]).toContain('dir="$(terragucci install cosign 2.6.5)"');
    expect(attested.publish.script[0]).toContain('export PATH="$dir:$PATH"');
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

  it("github: with a drift schedule the note jobs read the drift job's runs, and without one they do not", () => {
    const drift = body(renderPipeline({ forge: "github", binary: "tofu", version: "1.13.1", image: "img:1", layers, env: {}, drift: "0 6 * * *" }).content);
    expect(drift.jobs["plan-note"].permissions.actions).toBe("read");
    expect(drift.jobs["replan-note"].permissions.actions).toBe("read");
    expect(drift.jobs.plan.permissions.actions).toBeUndefined();
    expect(drift.jobs.drift.permissions.actions).toBeUndefined();
    expect(body(render("github")).jobs["plan-note"].permissions.actions).toBeUndefined();
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
  // Each init logs its root, its cache and how many inits are running with it.
  const INIT_LOG = `#!/usr/bin/env bash\ncase "$2" in init) r="$(basename "\${1#-chdir=}")"; touch "\${LOG}.running.$r"; echo "$r $TF_PLUGIN_CACHE_DIR $(ls "\${LOG}".running.* | wc -l | tr -d ' ')" >> "\${LOG}"; sleep 0.3; mv "\${LOG}.running.$r" "\${LOG}.done.$r" ;; plan) for a in "$@"; do case "$a" in -out=*) : > "\${a#-out=}" ;; esac; done ;; show) echo '{"resource_changes":[]}' ;; esac\nexit 0\n`;

  async function inits(cache: string | undefined): Promise<string[][]> {
    const { dir, env } = fakeBin(INIT_LOG);
    await terragucciBin(join(dir, "bin"));
    const log = join(dir, "cache.log");
    const script = join(dir, "apply.sh");
    writeFileSync(script, applyScript("tofu", [["a", "b", "c"]], "github"));
    const jobEnv: NodeJS.ProcessEnv = { ...process.env, ...env, LOG: log };
    delete jobEnv.TF_PLUGIN_CACHE_DIR;
    if (cache) jobEnv.TF_PLUGIN_CACHE_DIR = cache;
    const r = spawnSync("bash", [script], { cwd: dir, env: jobEnv, encoding: "utf-8" });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    return readFileSync(log, "utf-8").trim().split("\n").map((l) => l.split(" "));
  }

  it("roots applied together share the job's cache directory, one init at a time", async () => {
    const lines = await inits("/shared/cache");
    expect(lines).toHaveLength(3);
    expect(lines.map((l) => l[1])).toEqual(["/shared/cache", "/shared/cache", "/shared/cache"]);
    expect(lines.map((l) => l[2])).toEqual(["1", "1", "1"]);
  });

  it("without one, they share a cache of the wave's own, which goes when the wave ends", async () => {
    const lines = await inits(undefined);
    expect(lines).toHaveLength(3);
    const dirs = new Set(lines.map((l) => l[1]));
    expect(dirs.size).toBe(1);
    const [only] = [...dirs];
    expect(only).not.toBe("");
    expect(existsSync(only)).toBe(false);
    expect(lines.map((l) => l[2])).toEqual(["1", "1", "1"]);
  });
});

interface Hit { method: string; url: string; body: any }

/** A route's answer with a status code of its own; any other value is sent with 200. */
class Answer {
  constructor(readonly status: number, readonly body: unknown) {}
}

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
      const answer = routes(hit);
      if (answer instanceof Answer) res.statusCode = answer.status;
      res.end(JSON.stringify((answer instanceof Answer ? answer.body : answer) ?? {}));
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

  it("gitlab: by default the plan job holds the project token and posts its note and status itself", () => {
    const doc = body(render("gitlab"));
    expect(doc.plan.variables.TG_TOKEN).toBe("$GITLAB_TOKEN");
    expect(doc.plan.script.join("\n")).toContain('tg note "$note"');
    // The check holds no token of its own and drops the ones GitLab hands it; the fmt job pushes the formatting.
    expect(doc.check.variables.TG_TOKEN).toBeUndefined();
    expect(doc.check.script.join("\n")).toMatch(/^unset TG_TOKEN TG_MERGE_TOKEN GITLAB_TOKEN CI_JOB_TOKEN\n/);
    expect(doc.check.after_script).toBeUndefined();
    expect(doc.fmt).toMatchObject({ stage: "check", needs: ["check"], variables: { TG_TOKEN: "$GITLAB_TOKEN" } });
    expect(doc.fmt.rules[0].when).toBe("on_failure");
    expect(doc.comments).toBeUndefined();
  });

  it("gitlab.token: protected: the plan job holds no forge token, calls no API, and writes the note and the status into the report for the comments job", async () => {
    const { repo, env } = await planRepo();
    const api = await stubApi(() => []);
    try {
      const r = await run(`cd ${JSON.stringify(repo)}\n${gitlabProtectedPlanScript("tofu", [["network"], ["app", "cache"]])}`, {
        ...env, TG_SHA: "abc123", TG_PR: "7", CI_API_V4_URL: api.url, CI_PROJECT_ID: "9", CI_JOB_URL: "http://gitlab/acme/infra/-/jobs/5",
      });
      expect(r.status, r.out).toBe(0);
      expect(api.hits).toEqual([]);
      const note = readFileSync(join(repo, "terragucci-report/plan-note.md"), "utf-8");
      expect(note).toBe(`<!-- terragucci:plan roots=app,cache,network -->\n${readFileSync(join(repo, "terragucci-report/note.md"), "utf-8")}`);
      expect(readFileSync(join(repo, "terragucci-report/plan-status.txt"), "utf-8")).toBe("success 3 roots, 2 groups, 2 destroys\n");
      // A token that reaches the job means the variable is not protected: the job stops before it plans.
      const seen = await run(`cd ${JSON.stringify(repo)}\n${gitlabProtectedPlanScript("tofu", [["network"]])}`, { ...env, GITLAB_TOKEN: "leaked" });
      expect(seen.status).toBe(1);
      expect(seen.out).toContain("GITLAB_TOKEN reaches this merge request's pipeline");
    } finally {
      api.close();
    }
    const strict = (extra: Record<string, unknown> = {}) => renderPipeline({ forge: "gitlab", binary: "tofu", version: "1.13.1", image: "img:1", layers, env: {}, gitlabToken: "protected", comments: "*/5 * * * *", ...extra }).content;
    const doc = body(strict());
    expect(doc.plan.variables.TG_TOKEN).toBeUndefined();
    expect(Object.values(doc.plan.variables)).not.toContain("$GITLAB_TOKEN");
    expect(doc.plan.script.join("\n")).not.toMatch(/tg (note|status)/);
    expect(doc.plan.script.join("\n")).toContain(gitlabTokenCheck());
    // A branch's pipeline is the branch's own too: the check job gets no token and commits no formatting.
    expect(doc.check.variables.TG_TOKEN).toBeUndefined();
    expect(doc.check.after_script).toBeUndefined();
    expect(doc.comments.script.join("\n")).toContain("--plan-notes");
    expect(body(strict({ tokenEnv: "FORGE_TOKEN" })).plan.script.join("\n")).toContain('if [ -n "${FORGE_TOKEN:-}" ]; then');
    // The comments job posts the note, so the setting needs it.
    expect(() => renderPipeline({ forge: "gitlab", binary: "tofu", version: "1.13.1", image: "img:1", layers, env: {}, gitlabToken: "protected" })).toThrow(/gitlab.token: protected needs comments:/);
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
    expect(planFilesScript("tofu", layers, "forgejo", OIDC, {}, { replan: true }).split("\n")[0]).toBe(READS_EXIT);
    expect(planScript("tofu", layers, "github", undefined, { terragrunt: { prelude: "true" } }).split("\n")[0]).toBe(READS_EXIT);
    // GitLab runs the script in its own bash from a heredoc; the first line is the same there.
    expect(body(render("gitlab")).plan.script.join("\n")).toContain(`bash <<'PLAN' || exit $?\n${READS_EXIT}\n`);
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

describe("a GitLab wave in the runner's own shell", () => {
  const gitlabEnv = (api: string, bin: Record<string, string>): Record<string, string> => ({
    ...bin, TG_TOKEN: "t", TG_SHA: "s", TG_BRANCH: "main", CI_API_V4_URL: api, CI_PROJECT_ID: "9", CI_PIPELINE_URL: "http://gitlab/p/1", CI_SERVER_PROTOCOL: "http", CI_SERVER_FQDN: "gitlab", CI_PROJECT_PATH: "acme/infra",
  });
  const waveJob = (wave: number, gate?: "always"): string[] => body(renderPipeline({ forge: "gitlab", binary: "tofu", version: "1.13.1", image: "img:1", layers, env: {}, gate }).content)[`apply-wave-${wave}`].script;
  const stage = (code: number, outcome: string): Record<string, string> => ({ terragucci: `#!/usr/bin/env bash\necho ${JSON.stringify(outcome)} > "$TG_OUTCOME"\nexit ${code}\n` });

  it("the runner's eval turns a failed command's code into 1, and the heredoc's `exit` keeps it", async () => {
    expect((await runJob(["bash <<'X'\nexit 3\nX"], {})).status).toBe(1);
    expect((await runJob(["bash <<'X' || exit $?\nexit 3\nX"], {})).status).toBe(3);
    expect((await runJob(["bash <<'X' || exit $?\nexit 0\nX", "echo after"], {})).out).toContain("after");
  });

  it.each([
    [3, "failed", "wave 1 waits: chant approve tf-apply wave-1 --plan jcs1-sha256:abc123 --sign"],
    [4, "failed", "wave 1 was refused: its plans changed since the approval"],
    [1, "failed", "an apply failed"],
  ] as const)("a wave that ends %i ends its job with that code, and its status call is not refused", async (code, state, outcome) => {
    const { dir, env } = fakeBin("#!/usr/bin/env bash\nexit 0\n", stage(code, outcome));
    git(dir, "init", "-q");
    git(dir, "remote", "add", "origin", "http://gitlab/acme/infra.git");
    const gl = gitlabStatuses();
    const api = await stubApi(gl.route);
    try {
      const r = await runJob(waveJob(1), gitlabEnv(api.url, env), dir);
      expect(r.status, r.out).toBe(code);
      expect(r.out).not.toContain("answered 400");
      expect(gl.posted).toEqual([["terragucci/apply", "running", "applying", 201], ["terragucci/apply", state, code === 1 ? "an apply failed" : outcome, 201]]);
      // A running status keeps the pipeline running; this one ended.
      expect(gl.current("terragucci/apply")).toBe(state);
    } finally {
      api.close();
    }
  });

  it("a later wave that waits fails the running status, and the retry after the approval posts a new one", async () => {
    const wait = "wave 2 waits: chant approve tf-apply wave-2 --plan jcs1-sha256:abc123 --sign";
    const gl = gitlabStatuses();
    const api = await stubApi(gl.route);
    try {
      for (const [wave, code] of [[1, 0], [2, 3], [2, 0]] as const) {
        const { dir, env } = fakeBin("#!/usr/bin/env bash\nexit 0\n", stage(code, wait));
        git(dir, "init", "-q");
        git(dir, "remote", "add", "origin", "http://gitlab/acme/infra.git");
        const r = await runJob(waveJob(wave, "always"), gitlabEnv(api.url, env), dir);
        expect(r.status, r.out).toBe(code);
        expect(r.out).not.toContain("answered 400");
      }
      expect(gl.posted).toEqual([
        ["terragucci/apply", "running", "applying", 201],
        ["terragucci/apply", "failed", wait, 201],
        ["terragucci/apply", "success", "3 roots in 2 groups applied", 201],
      ]);
    } finally {
      api.close();
    }
  });

  it("names the job's own pipeline on a status of the job's commit, and no pipeline on another commit", async () => {
    const api = await stubApi(() => ({}));
    try {
      const post = (sha: string) => runStep(`${forgeApi("gitlab")}\ntg status terragucci/apply pending applying`, { TG_TOKEN: "t", TG_SHA: sha, CI_COMMIT_SHA: "s", CI_PIPELINE_ID: "102", CI_API_V4_URL: api.url, CI_PROJECT_ID: "9", CI_PIPELINE_URL: "http://gitlab/p/102" });
      await post("s");
      await post("other");
      const sent = api.hits.filter((h) => h.url.includes("/statuses/")).map((h) => h.body.pipeline_id);
      expect(sent).toEqual([102, undefined]);
    } finally {
      api.close();
    }
  });

  it("the stub refuses what GitLab refuses: running again, or back to pending, from running", async () => {
    const gl = gitlabStatuses();
    const api = await stubApi(gl.route);
    try {
      const post = (state: string) => fetch(`${api.url}/projects/9/statuses/s`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "x", state }) }).then((r) => r.status);
      expect(await post("running")).toBe(201);
      expect(await post("running")).toBe(400);
      expect(await post("pending")).toBe(400);
      expect(await post("failed")).toBe(201);
      expect(await post("running")).toBe(201);
    } finally {
      api.close();
    }
  });
});

/**
 * GitLab's commit statuses for one pipeline, as its API keeps them: a post
 * reuses the status of that name while it is pending or running, else starts
 * a new one, and answers 400 for a move its state machine has no event for
 * (`running` is enqueue then run, `pending` is enqueue).
 */
function gitlabStatuses(): { route: (hit: Hit) => unknown; posted: [string, string, string, number][]; current: (name: string) => string | undefined } {
  const jobs: { name: string; state: string }[] = [];
  const posted: [string, string, string, number][] = [];
  const route = (hit: Hit): unknown => {
    if (!(hit.method === "POST" && hit.url.includes("/statuses/"))) return hit.method === "GET" ? [] : {};
    const { name, state, description } = hit.body;
    const open = jobs.find((j) => j.name === name && ["pending", "running"].includes(j.state));
    const from = open?.state ?? "created";
    const to = ({
      pending: from === "created" ? "pending" : undefined,
      running: ["created", "pending"].includes(from) ? "running" : undefined,
      success: "success",
      failed: "failed",
    } as Record<string, string | undefined>)[state];
    if (!to) {
      posted.push([name, state, description, 400]);
      return new Answer(400, { message: `400 Bad request - Cannot transition status via :${state === "running" ? "run" : "enqueue"} from :${from}` });
    }
    if (open) open.state = to;
    else jobs.push({ name, state: to });
    posted.push([name, state, description, 201]);
    return new Answer(201, { name, status: to });
  };
  return { route, posted, current: (name) => jobs.filter((j) => j.name === name).at(-1)?.state };
}

/**
 * Runs a job's `script:` lines the way gitlab-runner 17.11's bash shell does
 * by default (shells/bash.go, Finish): the lines in one `eval`, behind a pipe,
 * under errexit and pipefail, fed to bash on its stdin.
 */
function runJob(lines: string[], env: Record<string, string>, cwd?: string): Promise<{ status: number | null; out: string }> {
  const quoted = `'${lines.join("\n").replaceAll("'", "'\\''")}'`;
  const script = ["trap exit 1 TERM", "", "if set -o | grep pipefail > /dev/null; then set -o pipefail; fi; set -o errexit", "set +o noclobber", `: | eval ${quoted}`, "exit 0", ""].join("\n");
  return new Promise((ok) => {
    const p = spawn("bash", [], { cwd, env: { ...process.env, ...env } });
    let out = "";
    p.stdout.on("data", (c) => (out += c));
    p.stderr.on("data", (c) => (out += c));
    p.on("close", (status) => ok({ status, out }));
    p.stdin.end(script);
  });
}

describe("a Terragrunt wave in the step's own shell", () => {
  it("runs the stage with --terragrunt after the prelude, and a wave that fails posts the failure status and runs the apply-failed response before the job fails", async () => {
    const { dir, env } = fakeBin("#!/usr/bin/env bash\nexit 0\n", {
      terragucci: '#!/usr/bin/env bash\necho "terragucci $*" >> "$LOG"\ncase "$1" in stage) echo "Error: apply failed"; exit 1 ;; esac\nexit 0\n',
    });
    const log = join(dir, "calls.log");
    const api = await stubApi(() => []);
    try {
      const script = applyScript("tofu", [["live/a"], ["live/b"]], "github", undefined, { wave: 1, terragrunt: { prelude: 'echo prelude >> "$LOG"' }, respond: { "apply-failed": "triage" } });
      expect(script.split("\n")[0]).toBe(READS_EXIT);
      expect(script).not.toContain("--canary");
      const r = await runStep(`cd ${dir} && ${script}`, {
        ...env, LOG: log, TG_TOKEN: "t", TG_SHA: "s", TG_BRANCH: "main", GITHUB_REF_NAME: "", GITHUB_API_URL: api.url, GITHUB_REPOSITORY: "acme/infra", GITHUB_SERVER_URL: "http://forge", GITHUB_RUN_ID: "1",
      });
      expect(r.status, r.out).toBe(1);
      const calls = readFileSync(log, "utf-8").trim().split("\n");
      expect(calls[0]).toBe("prelude");
      expect(calls.find((c) => c.startsWith("terragucci stage tf-apply"))).toBe("terragucci stage tf-apply --wave 1 --layers live/a;live/b --binary tofu --gate on-destroy --terragrunt");
      expect(calls.some((c) => c.startsWith("terragucci respond apply-failed --log "))).toBe(true);
      const s = api.hits.filter((h) => h.url.includes("/statuses/")).map((h) => [h.body.state, h.body.description]);
      expect(s.at(-1)).toEqual(["failure", "an apply failed"]);
    } finally {
      api.close();
    }
  });

  it("a Terragrunt repo gets one apply job per wave, each running the stage with --terragrunt, and the gate it is given", () => {
    const doc = body(renderPipeline({ forge: "forgejo", binary: "tofu", version: "1.13.1", image: "img:1", layers: [["live/dev/a"], ["live/prod/a", "live/prod/b"]], env: {}, gate: "always", terragrunt: { version: "0.99.0", parallelism: 4, exclude: [], installs: [] } }).content);
    expect(Object.keys(doc.jobs).filter((j) => j.startsWith("apply-wave"))).toEqual(["apply-wave-1", "apply-wave-2"]);
    expect(doc.jobs["apply-wave-2"].needs).toBe("apply-wave-1");
    const run = (j: string): string => doc.jobs[j].steps.map((st: { run?: string }) => st.run ?? "").join("\n");
    expect(run("apply-wave-1")).toContain("terragucci stage tf-apply --wave 1 --layers 'live/dev/a;live/prod/a,live/prod/b' --binary tofu --gate always --terragrunt 2>&1");
    // The last job also runs any wave the repo has past the jobs, and a refusal names the wave that stopped.
    expect(run("apply-wave-2")).toContain("terragucci stage tf-apply --wave 2 --layers 'live/dev/a;live/prod/a,live/prod/b' --binary tofu --gate always --terragrunt --rest");
    expect(run("apply-wave-2")).toContain('tg status terragucci/apply success "every wave of units applied"');
    expect(run("apply-wave-1")).not.toContain("-auto-approve");
    // A waiting wave records its plan on chant/lifecycle. Forgejo ignores permissions:, so GitHub's job carries them.
    const gh = body(renderPipeline({ forge: "github", binary: "tofu", version: "1.13.1", image: "img:1", layers: [["live/dev/a"], ["live/prod/a", "live/prod/b"]], env: {}, gate: "always", terragrunt: { version: "0.99.0", parallelism: 4, exclude: [], installs: [] } }).content);
    expect(gh.jobs["apply-wave-1"].permissions.contents).toBe("write");
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

describe("own_jobs", () => {
  // The explain-refusal job of each tab of the agent-refused-wave guide, as its own-jobs file.
  const guide = readFileSync(join(__dirname, "../../../docs-site/src/content/docs/guides/agent-refused-wave.mdx"), "utf-8");
  const tab = (label: string): string => {
    const from = guide.indexOf(`<TabItem label="${label}">`);
    const block = guide.slice(guide.indexOf("```yaml", from) + "```yaml".length, guide.indexOf("```\n", guide.indexOf("```yaml", from) + 7));
    const lines = block.split("\n").filter((l) => l.trim() !== "");
    const cut = Math.min(...lines.map((l) => l.match(/^ */)![0].length));
    return lines.map((l) => l.slice(cut)).join("\n") + "\n";
  };

  it.each([["github", "GitHub"], ["forgejo", "Forgejo"], ["gitlab", "GitLab"]] as const)("%s: the guide's explain-refusal job goes into the pipeline with every key and value it has, after terragucci's jobs", (forge, label) => {
    const own = parseYAML(tab(label)) as Record<string, Record<string, unknown>>;
    expect(Object.keys(own)).toEqual(["explain-refusal"]);
    const text = renderPipeline({ forge, binary: "tofu", version: "1.13.1", image: "img:1", layers, env: {}, ownJobs: own }).content;
    const doc = body(text);
    const jobs = forge === "gitlab" ? doc : doc.jobs;
    expect(jobs["explain-refusal"]).toEqual(own["explain-refusal"]);
    expect(Object.keys(jobs).at(-1)).toBe("explain-refusal");
    // Without own_jobs the pipeline is the one it was.
    expect(text.startsWith(renderPipeline({ forge, binary: "tofu", version: "1.13.1", image: "img:1", layers, env: {} }).content)).toBe(true);
  });

  it("refuses a name terragucci gives a job, and on GitLab a keyword", () => {
    expect(() => renderPipeline({ forge: "forgejo", binary: "tofu", version: "1.13.1", image: "img:1", layers, env: {}, ownJobs: { "apply-wave-1": { "runs-on": "x" } } })).toThrow("own_jobs.apply-wave-1: terragucci writes a job of that name");
    expect(() => renderPipeline({ forge: "gitlab", binary: "tofu", version: "1.13.1", image: "img:1", layers, env: {}, ownJobs: { stages: { script: ["x"] } } })).toThrow("own_jobs.stages: GitLab reads stages as a keyword");
    expect(validateConfig({ own_jobs: "ci/own-jobs.yml" }, "t")).toEqual({ own_jobs: "ci/own-jobs.yml" });
    expect(() => validateConfig({ own_jobs: "../jobs.yml" }, "t")).toThrow("config.own_jobs must be a map of job name to job, or the path of a .yml file in the repo");
    expect(() => validateConfig({ own_jobs: { "bad name": { x: 1 } } }, "t")).toThrow('config.own_jobs: "bad name" is not a job name');
    expect(() => validateConfig({ own_jobs: { ok: "text" } }, "t")).toThrow("config.own_jobs.ok must be a job");
  });
});

describe("apply.branches", () => {
  const branches = { release: ["prod/*"] };
  const tree = [["dev/net", "prod/net"], ["dev/app", "prod/app"]];
  const pipeline = (forge: ForgeName, extra: Record<string, unknown> = {}) =>
    renderPipeline({ forge, binary: "tofu", version: "1.13.1", image: "img:1", layers: tree, env: {}, applyBranches: branches, ...extra } as never).content;

  it.each(["github", "forgejo"] as const)("%s: the waves run on the default branch and on release, each passing the map and the branch it runs on", (forge) => {
    const doc = body(pipeline(forge));
    for (const j of ["apply-wave-1", "apply-wave-2"]) {
      expect(doc.jobs[j].if).toBe("(github.ref == format('refs/heads/{0}', github.event.repository.default_branch) || github.ref == 'refs/heads/release')");
      const run = doc.jobs[j].steps.map((x: { run?: string }) => x.run ?? "").join("\n");
      expect(run).toContain(`--branches 'release=prod/*' --branch "$GITHUB_REF_NAME"`);
    }
    // The apply a comment starts is of a merge into the default branch: it passes the map, and no branch.
    const comment = doc.jobs["apply-comment"].steps.map((x: { run?: string }) => x.run ?? "").join("\n");
    expect(comment).toContain("--branches 'release=prod/*'");
    expect(comment).not.toContain("--branch ");
    // Tips, publish and the like stay on the default branch.
    expect(doc.jobs.check.if).toBe("github.event_name == 'push' || (github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name != github.repository)");
  });

  it("on GitLab the apply jobs run on release too, and read the branch from CI_COMMIT_BRANCH", () => {
    const doc = body(pipeline("gitlab"));
    expect(doc["apply-wave-1"].rules).toEqual([{ if: '($CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH || $CI_COMMIT_BRANCH == "release")' }]);
    expect(JSON.stringify(doc["apply-wave-2"].script)).toContain(`--branches 'release=prod/*' --branch \\"$CI_COMMIT_BRANCH\\"`);
  });

  it("in a Terragrunt repo the waves pass the map and the branch as well, so a branch applies its units", () => {
    const doc = body(pipeline("forgejo", { terragrunt: { version: "0.99.0", parallelism: 4, exclude: [], installs: [] } }));
    const run = doc.jobs["apply-wave-1"].steps.map((x: { run?: string }) => x.run ?? "").join("\n");
    expect(run).toContain("--terragrunt");
    expect(run).toContain(`--branches 'release=prod/*' --branch "$GITHUB_REF_NAME"`);
    expect(doc.jobs["apply-wave-1"].if).toBe("(github.ref == format('refs/heads/{0}', github.event.repository.default_branch) || github.ref == 'refs/heads/release')");
    expect(validateConfig({ terragrunt: { version: "1.1.6" }, apply: { branches: { release: ["live/prod/*"] } } }, "t")).toEqual({ terragrunt: { version: "1.1.6" }, apply: { branches: { release: ["live/prod/*"] } } });
  });

  it("renders as before without the map, and is refused with apply.when: pull-request", () => {
    for (const forge of FORGES) {
      expect(pipeline(forge, { applyBranches: undefined })).not.toContain("--branches");
      expect(pipeline(forge, { applyBranches: {} })).toBe(pipeline(forge, { applyBranches: undefined }));
    }
    expect(() => pipeline("forgejo", { applyWhen: "pull-request" })).toThrow(/apply\.branches: apply\.when: pull-request/);
  });

  it("is checked by config check", () => {
    expect(validateConfig({ apply: { branches: { release: ["envs/prod/*"], "env/dr": ["envs/dr/*"] } } }, "t")).toEqual({ apply: { branches: { release: ["envs/prod/*"], "env/dr": ["envs/dr/*"] } } });
    expect(() => validateConfig({ apply: { branches: [] } }, "t")).toThrow("config.apply.branches must map branch names to lists of root globs");
    expect(() => validateConfig({ apply: { branches: { release: [] } } }, "t")).toThrow("config.apply.branches.release must be a list of root globs");
    expect(() => validateConfig({ apply: { branches: { "rel ease": ["a"] } } }, "t")).toThrow("is not a branch name terragucci takes");
    expect(() => validateConfig({ apply: { branches: { "a/../b": ["a"] } } }, "t")).toThrow("is not a branch name terragucci takes");
    expect(() => validateConfig({ apply: { branches: { release: ["a,b"] } } }, "t")).toThrow("must be a list of root globs");
    expect(() => validateConfig({ apply: { branches: { release: ["envs/prod/*"], hotfix: ["envs/prod/*"] } } }, "t")).toThrow("envs/prod/* is under both release and hotfix");
    expect(() => validateConfig({ apply: { when: "pull-request", branches: { release: ["a"] } } }, "t")).toThrow("config.apply.branches: apply.when: pull-request");
  });
});

describe("a wave split across jobs (waves.jobs)", () => {
  const wide = [["net"], ["a", "b", "c", "d", "e"]];
  const pipeline = (forge: ForgeName, extra: Record<string, unknown> = {}) =>
    body(renderPipeline({ forge, binary: "tofu", version: "1.13.1", image: "img:1", layers: wide, env: {}, waveJobs: 2, ...extra } as never).content);

  it.each(["github", "forgejo"] as const)("%s: the wave's own job decides, its shares apply side by side, and a job after them posts the success", (forge) => {
    const doc = pipeline(forge);
    const names = Object.keys(doc.jobs).filter((j) => /^apply-(wave|done)/.test(j));
    expect(names).toEqual(["apply-wave-1", "apply-wave-2", "apply-wave-2-share-1", "apply-wave-2-share-2", "apply-done"]);
    // A wave of one root stays one job; the wide wave's job decides and needs the wave before.
    expect(doc.jobs["apply-wave-2"].needs).toBe("apply-wave-1");
    expect(doc.jobs["apply-wave-2-share-1"].needs).toBe("apply-wave-2");
    expect(doc.jobs["apply-done"].needs).toEqual(["apply-wave-2-share-1", "apply-wave-2-share-2"]);
    const step = (j: string): string => doc.jobs[j].steps.map((x: { run?: string }) => x.run ?? "").join("\n");
    expect(step("apply-wave-1")).not.toContain("--shares");
    expect(step("apply-wave-2")).toContain("--wave 2 --layers 'net;a,b,c,d,e' --binary tofu --gate on-destroy --shares 2");
    expect(step("apply-wave-2")).not.toContain("--share ");
    expect(step("apply-wave-2-share-2")).toContain("--shares 2 --share 2");
    // Only the done job posts the success; the deciding job and the shares post none.
    for (const j of ["apply-wave-2", "apply-wave-2-share-1"]) expect(step(j)).not.toContain("roots in 2 groups applied");
    expect(step("apply-done")).toContain('tg status terragucci/apply success "6 roots in 2 groups applied"');
    // The decision goes from the wave's job to its shares as an artifact.
    const upload = doc.jobs["apply-wave-2"].steps.find((x: { name?: string }) => x.name === "Hand the decision to the wave's shares");
    expect(upload.with).toMatchObject({ name: "terragucci-wave-2", path: "terragucci-wave/" });
    const fetch = doc.jobs["apply-wave-2-share-1"].steps.findIndex((x: { name?: string }) => x.name === "Fetch the wave's decision");
    expect(doc.jobs["apply-wave-2-share-1"].steps[fetch].with).toEqual({ name: "terragucci-wave-2", path: "terragucci-wave" });
    expect(fetch).toBeLessThan(doc.jobs["apply-wave-2-share-1"].steps.findIndex((x: { run?: string }) => x.run?.includes("terragucci stage tf-apply")));
    // The shares run outside the apply concurrency group; every apply job holds the run's shared lock instead.
    expect(doc.jobs["apply-wave-2-share-1"].concurrency).toBeUndefined();
    expect(doc.jobs["apply-wave-2"].concurrency).toBeDefined();
    for (const j of names.filter((n) => n !== "apply-done")) {
      expect(step(j)).toContain(`hold_ref="\${hold_prefix}${j}"`);
      // Forgejo's dialect drops permissions; GitHub's job token needs contents: write to push the tags.
      if (forge === "github") expect(doc.jobs[j].permissions.contents).toBe("write");
    }
    if (forge === "github") expect(doc.jobs["apply-done"].permissions).toEqual({ contents: "read", statuses: "write" });
  });

  it("on GitHub the apply a comment starts takes the lock tag the shares hold", () => {
    const run = (doc: Record<string, any>): string => JSON.stringify(doc.jobs["apply-comment"].steps);
    expect(run(pipeline("github"))).toContain("refs/tags/terragucci-apply-lock");
    expect(run(body(renderPipeline({ forge: "github", binary: "tofu", version: "1.13.1", image: "img:1", layers: wide, env: {} }).content))).not.toContain("refs/tags/terragucci-apply-lock");
  });

  it("renders as before when no wave has more roots than one job", () => {
    const plain = renderPipeline({ forge: "forgejo", binary: "tofu", version: "1.13.1", image: "img:1", layers, env: {} }).content;
    expect(renderPipeline({ forge: "forgejo", binary: "tofu", version: "1.13.1", image: "img:1", layers: [["network"], ["app"]], env: {}, waveJobs: 4 }).content).toBe(
      renderPipeline({ forge: "forgejo", binary: "tofu", version: "1.13.1", image: "img:1", layers: [["network"], ["app"]], env: {} }).content,
    );
    expect(renderPipeline({ forge: "forgejo", binary: "tofu", version: "1.13.1", image: "img:1", layers, env: {}, waveJobs: 1 }).content).toBe(plain);
  });

  it("splits a canary wave by the canary's own roots", () => {
    const doc = pipeline("forgejo", { layers: [["dev/a", "dev/b", "prod/a", "prod/b", "prod/c"]], canary: ["dev/*"], waveJobs: 3 });
    expect(Object.keys(doc.jobs).filter((j) => /^apply-(wave|done)/.test(j))).toEqual(["apply-wave-1", "apply-wave-1-share-1", "apply-wave-1-share-2", "apply-wave-2", "apply-wave-2-share-1", "apply-wave-2-share-2", "apply-wave-2-share-3", "apply-done"]);
    expect(doc.jobs["apply-wave-2"].needs).toEqual(["apply-wave-1-share-1", "apply-wave-1-share-2"]);
  });

  it.each(["github", "forgejo"] as const)("%s: a Terragrunt wave splits the same way, and a job after the last wave's shares runs any later wave with --rest", (forge) => {
    const tg = { version: "0.99.0", parallelism: 4, exclude: [], installs: [] };
    const doc = pipeline(forge, { layers: [["live/net"], ["live/a", "live/b", "live/c"]], terragrunt: tg });
    const names = Object.keys(doc.jobs).filter((j) => /^apply-(wave|done|rest)/.test(j));
    expect(names).toEqual(["apply-wave-1", "apply-wave-2", "apply-wave-2-share-1", "apply-wave-2-share-2", "apply-rest"]);
    const step = (j: string): string => doc.jobs[j].steps.map((x: { run?: string }) => x.run ?? "").join("\n");
    expect(step("apply-wave-1")).not.toContain("--rest");
    expect(step("apply-wave-1")).not.toContain("--shares");
    expect(step("apply-wave-2")).toContain("--terragrunt --shares 2");
    expect(step("apply-wave-2")).not.toContain("--rest");
    expect(step("apply-wave-2-share-1")).toContain("--terragrunt --shares 2 --share 1");
    // The job after the shares applies like a wave's: credentials, caches and the stage with --rest from the wave past the pipeline's.
    expect(doc.jobs["apply-rest"].needs).toEqual(["apply-wave-2-share-1", "apply-wave-2-share-2"]);
    expect(step("apply-rest")).toContain("terragucci stage tf-apply --wave 3 --layers 'live/net;live/a,live/b,live/c' --binary tofu --gate on-destroy --terragrunt --rest");
    expect(step("apply-rest")).toContain('tg status terragucci/apply success "every wave of units applied"');
    expect(step("apply-rest")).toContain('hold_ref="${hold_prefix}apply-rest"');
    // A Terragrunt wave that is not the last keeps --rest on the last wave's job.
    const early = pipeline(forge, { layers: [["live/a", "live/b", "live/c"], ["live/z"]], terragrunt: tg });
    expect(Object.keys(early.jobs).filter((j) => /^apply-(wave|done|rest)/.test(j))).toEqual(["apply-wave-1", "apply-wave-1-share-1", "apply-wave-1-share-2", "apply-wave-2"]);
    expect(early.jobs["apply-wave-2"].steps.map((x: { run?: string }) => x.run ?? "").join("\n")).toContain("--terragrunt --rest");
  });

  it("is refused on GitLab and with apply.when: pull-request, by config check and by init", () => {
    expect(() => renderPipeline({ forge: "gitlab", binary: "tofu", version: "1.13.1", image: "img:1", layers: wide, env: {}, waveJobs: 2 })).toThrow(/waves\.jobs: a wave splits across jobs on GitHub and Forgejo/);
    expect(() => renderPipeline({ forge: "forgejo", binary: "tofu", version: "1.13.1", image: "img:1", layers: wide, env: {}, waveJobs: 2, applyWhen: "pull-request" })).toThrow(/waves\.jobs: apply\.when: pull-request/);
    expect(() => validateConfig({ waves: { jobs: 0 } }, "t")).toThrow("config.waves.jobs must be a whole number of 1 or more");
    expect(() => validateConfig({ waves: { jobs: 1.5 } }, "t")).toThrow("config.waves.jobs must be a whole number of 1 or more");
    expect(() => validateConfig({ forge: "gitlab", waves: { jobs: 3 } }, "t")).toThrow("config.waves.jobs: a wave splits across jobs on GitHub and Forgejo");
    expect(() => validateConfig({ apply: { when: "pull-request" }, waves: { jobs: 3 } }, "t")).toThrow("config.waves.jobs: apply.when: pull-request");
    expect(validateConfig({ terragrunt: { version: "1.1.6" }, waves: { jobs: 3 } }, "t")).toEqual({ terragrunt: { version: "1.1.6" }, waves: { jobs: 3 } });
    expect(() => validateConfig({ terragrunt: { version: "1.1.6" }, roots: ["live/*"] }, "t")).toThrow("config.roots: a Terragrunt repo's units are the ones terragrunt find lists, so remove roots and leave units out with terragrunt.exclude");
    expect(validateConfig({ waves: { jobs: 3, canary: ["dev/*"] } }, "t")).toEqual({ waves: { jobs: 3, canary: ["dev/*"] } });
  });

  describe("the shared lock", () => {
    function remote(): { origin: string; work: string; sha: string } {
      const origin = tmp("tg-origin-");
      git(origin, "init", "-q", "--bare");
      const work = tmp("tg-work-");
      git(work, "init", "-q", "-b", "main");
      git(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "one");
      git(work, "remote", "add", "origin", origin);
      git(work, "push", "-q", "origin", "main");
      return { origin, work, sha: git(work, "rev-parse", "HEAD").trim() };
    }
    const share = (s: number): string => applyScript("tofu", wide, "forgejo", undefined, { wave: 2, shares: 2, share: s, sharedLock: `apply-wave-2-share-${s}` });

    it("lets a wave's shares apply side by side while another run waits, and leaves no tag behind", async () => {
      const { origin, work, sha } = remote();
      const { dir, env } = fakeBin("#!/usr/bin/env bash\nexit 0\n", {
        terragucci: `#!/usr/bin/env bash\necho "start $JOB $(date +%s.%N)" >> "$LOG"; sleep 1.5; echo "end $JOB $(date +%s.%N)" >> "$LOG"\nexit 0\n`,
      });
      const log = join(dir, "apply.log");
      const base = { ...env, LOG: log, TG_BRANCH: "main", GITHUB_REF_NAME: "main", GITHUB_SHA: sha, TG_SHA: sha, TG_LOCK_POLL: "0.2" };
      const go = (script: string, job: string, id: string, delay = 0) => new Promise<{ status: number | null; out: string }>((ok) => {
        setTimeout(() => {
          const p = spawn("bash", ["-c", script], { cwd: work, env: { ...process.env, ...base, JOB: job, GITHUB_RUN_ID: id } });
          let out = "";
          p.stdout.on("data", (c) => (out += c));
          p.stderr.on("data", (c) => (out += c));
          p.on("close", (status) => ok({ status, out }));
        }, delay);
      });
      // Run 7's shares start first; run 8's wave job starts while they hold the lock.
      const results = await Promise.all([go(share(1), "s1", "7"), go(share(2), "s2", "7", 300), go(applyScript("tofu", [["x"]], "forgejo"), "other", "8", 600)]);
      expect(results.map((r) => r.status), results.map((r) => r.out).join("\n")).toEqual([0, 0, 0]);
      const events = readFileSync(log, "utf-8").trim().split("\n").map((l) => l.split(" "));
      const when = (what: string, job: string): number => Number(events.find((e) => e[0] === what && e[1] === job)![2]);
      // The shares overlap, and the other run starts only once both ended.
      expect(when("start", "s2")).toBeLessThan(when("end", "s1"));
      expect(when("start", "other")).toBeGreaterThanOrEqual(Math.max(when("end", "s1"), when("end", "s2")));
      expect(results[1].out).toContain("this run holds the apply lock; apply-wave-2-share-2 joins it");
      expect(git(origin, "tag", "--list").trim()).toBe("");
    }, 30_000);

    it("keeps the lock while another job of its run still holds it, and the run's next job lets it go", async () => {
      const { origin, work, sha } = remote();
      const { env } = fakeBin("#!/usr/bin/env bash\nexit 0\n", STAGE_OK);
      const lease = git(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit-tree", git(work, "mktree").trim(), "-m", `run 7 ${Math.floor(Date.now() / 1000)}`).trim();
      git(work, "push", "-q", "origin", `${lease}:refs/tags/terragucci-apply-lock`, `${lease}:refs/tags/terragucci-apply-hold-7-apply-wave-2-share-2`);
      const vars = { ...env, TG_BRANCH: "main", GITHUB_REF_NAME: "main", GITHUB_SHA: sha, TG_SHA: sha, GITHUB_RUN_ID: "7", TG_LOCK_POLL: "0.2" };
      const first = await run(`cd ${work} && ${share(1)}`, vars);
      expect(first.status, first.out).toBe(0);
      expect(git(origin, "tag", "--list").trim().split("\n")).toEqual(["terragucci-apply-hold-7-apply-wave-2-share-2", "terragucci-apply-lock"]);
      // The sibling went without dropping its hold; the run's next job joins the lock and, the last of the run, lets it go.
      git(work, "push", "-q", "origin", ":refs/tags/terragucci-apply-hold-7-apply-wave-2-share-2");
      const next = await run(`cd ${work} && ${applyScript("tofu", [...wide, ["z"]], "forgejo", undefined, { wave: 3, sharedLock: "apply-wave-3" })}`, vars);
      expect(next.status, next.out).toBe(0);
      expect(next.out).toContain("this run holds the apply lock; apply-wave-3 joins it");
      expect(git(origin, "tag", "--list").trim()).toBe("");
    });

    it("takes over a lock whose run is gone, and drops the holds that run left", async () => {
      const { origin, work, sha } = remote();
      const { env } = fakeBin("#!/usr/bin/env bash\nexit 0\n", STAGE_OK);
      const lease = git(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit-tree", git(work, "mktree").trim(), "-m", "run 99 1000").trim();
      git(work, "push", "-q", "origin", `${lease}:refs/tags/terragucci-apply-lock`, `${lease}:refs/tags/terragucci-apply-hold-99-apply-wave-2-share-1`);
      const r = await run(`cd ${work} && ${share(1)}`, { ...env, TG_BRANCH: "main", GITHUB_REF_NAME: "main", GITHUB_SHA: sha, TG_SHA: sha, GITHUB_RUN_ID: "7", TG_LOCK_POLL: "0.2" });
      expect(r.status, r.out).toBe(0);
      expect(r.out).toContain("run 99, which is gone; taking it over");
      expect(git(origin, "tag", "--list").trim()).toBe("");
    });
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

describe("the rollout job", () => {
  const input = { binary: "tofu" as const, version: "1.13.1", image: "img:1", layers, env: {} };

  it.each(FORGES)("%s: no rollout job, and the same pipeline, unless rollouts names a schedule", (forge) => {
    const r = renderPipeline({ forge, ...input });
    expect(r.extra).toBeUndefined();
    expect(r.content).not.toContain("respond rollout");
  });

  it.each(["github", "forgejo"] as const)("%s: a workflow of its own runs respond rollout on the schedule or by hand, and the pipeline does not change", (forge) => {
    const r = renderPipeline({ forge, ...input, rollouts: "*/15 * * * *" });
    expect(r.content).toBe(renderPipeline({ forge, ...input }).content);
    const rollout = r.extra!.find((f) => f.path === `.${forge}/workflows/terragucci-rollout.yml`)!;
    expect(r.extra!.length).toBe(1);
    const doc = body(rollout.content);
    expect(doc.on).toEqual({ schedule: [{ cron: "*/15 * * * *" }], workflow_dispatch: {} });
    expect(Object.keys(doc.jobs)).toEqual(["rollout"]);
    expect(doc.jobs.rollout.env.TG_TOKEN).toBe("${{ github.token }}");
    const run = doc.jobs.rollout.steps.map((s: any) => s.run).filter(Boolean).join("\n");
    expect(run).toContain(`export ${forge === "github" ? "GITHUB_TOKEN" : "FORGEJO_TOKEN"}="$TG_TOKEN"`);
    expect(run).toContain("terragucci respond rollout --mode apply");
    expect(run).not.toContain("|| true");
  });

  it("github: with token_env the job opens the wave and pushes its branch with that secret, so the wave's pull request is planned", () => {
    const doc = body(renderPipeline({ forge: "github", ...input, rollouts: "*/15 * * * *", tokenEnv: "ROLLOUT_TOKEN" }).extra![0]!.content);
    expect(doc.jobs.rollout.env.TG_TOKEN).toBe("${{ secrets.ROLLOUT_TOKEN }}");
    expect(doc.jobs.rollout.steps[0].with).toEqual({ "fetch-depth": 0, token: "${{ secrets.ROLLOUT_TOKEN }}" });
    expect(doc.jobs.rollout.permissions).toEqual({ contents: "write", "pull-requests": "write", statuses: "read", checks: "read" });
    expect(doc.jobs.rollout.steps.map((s: any) => s.run).join("\n")).toContain('export ROLLOUT_TOKEN="$TG_TOKEN"');
  });

  it("gitlab: the rollouts schedule runs the rollout job, and drift leaves that schedule's pipelines alone", () => {
    const doc = body(renderPipeline({ forge: "gitlab", ...input, rollouts: "*/15 * * * *", drift: "0 6 * * *" }).content);
    expect(doc.rollout.rules).toEqual([{ if: '$CI_PIPELINE_SOURCE == "schedule" && $TERRAGUCCI_SCHEDULE == "rollouts"' }]);
    expect(doc.rollout.script.join("\n")).toContain("terragucci respond rollout --mode apply");
    expect(doc.rollout.variables.GIT_DEPTH).toBe("0");
    expect(doc.drift.rules).toEqual([{ if: '$CI_PIPELINE_SOURCE == "schedule" && $TERRAGUCCI_SCHEDULE != "comments" && $TERRAGUCCI_SCHEDULE != "rollouts"' }]);
    expect(doc.check.rules).toEqual([{ if: '$CI_PIPELINE_SOURCE != "schedule"' }]);
  });

  it("gitlab: with apply.resume too, drift leaves both the resume and the rollouts schedules alone", () => {
    const doc = body(renderPipeline({ forge: "gitlab", ...input, rollouts: "*/15 * * * *", drift: "0 6 * * *", resume: 10 }).content);
    expect(doc.drift.rules).toEqual([{ if: '$CI_PIPELINE_SOURCE == "schedule" && $TERRAGUCCI_SCHEDULE != "comments" && $TERRAGUCCI_SCHEDULE != "resume" && $TERRAGUCCI_SCHEDULE != "rollouts"' }]);
  });

  it("github: with apply.resume too, the rollout workflow sits beside the resume workflow", () => {
    const r = renderPipeline({ forge: "github", ...input, rollouts: "*/15 * * * *", resume: 10 });
    expect(r.extra!.map((f) => f.path)).toContain(".github/workflows/terragucci-rollout.yml");
    expect(r.extra!.length).toBe(2);
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

  it("gitlab: drift runs for scheduled pipelines other than the comments schedule's, and check and apply skip them", () => {
    const doc = body(withDrift("gitlab"));
    expect(doc.drift.rules).toEqual([{ if: '$CI_PIPELINE_SOURCE == "schedule" && $TERRAGUCCI_SCHEDULE != "comments"' }]);
    expect(doc.check.rules).toEqual([{ if: '$CI_PIPELINE_SOURCE != "schedule"' }]);
    expect(doc["apply-wave-1"].rules[0].if).toContain('$CI_PIPELINE_SOURCE != "schedule"');
    expect(doc.drift.script.join("\n")).toContain("terragucci stage tf-drift");
  });
});

describe("the comments job (GitLab)", () => {
  const withComments = (extra: Partial<Parameters<typeof renderPipeline>[0]> = {}): Record<string, any> =>
    body(renderPipeline({ forge: "gitlab", binary: "tofu", version: "1.13.1", image: "img:1", layers, env: {}, comments: "*/5 * * * *", ...extra }).content);

  it("is there only when comments is set", () => {
    expect(body(render("gitlab")).comments).toBeUndefined();
    expect(render("gitlab")).not.toContain("TERRAGUCCI_SCHEDULE");
  });

  it("runs for the comments schedule alone, one poll at a time, with no checkout and no cloud credentials", () => {
    const doc = withComments({ oidc: OIDC });
    expect(doc.comments.rules).toEqual([{ if: '$CI_PIPELINE_SOURCE == "schedule" && $TERRAGUCCI_SCHEDULE == "comments"' }]);
    expect(doc.comments.resource_group).toBe("terragucci-comments");
    expect(doc.comments.variables).toEqual({ TG_TOKEN: "$GITLAB_TOKEN", GIT_STRATEGY: "none" });
    expect(doc.comments.id_tokens).toBeUndefined();
    const run = doc.comments.script.join("\n");
    expect(run).toContain("terragucci comment --forge gitlab --poll --layers 'network;app,cache'");
    expect(run).not.toContain(OIDC.apply_role);
    expect(run).not.toContain(OIDC.plan_role);
    expect(doc.stages).toContain("comments");
  });

  it("names the token comments reads from token_env", () => {
    expect(withComments({ tokenEnv: "TG_GITLAB" }).comments.variables.TG_TOKEN).toBe("$TG_GITLAB");
  });

  it("keeps check, apply and publish out of every scheduled pipeline, with or without drift", () => {
    const doc = withComments({ publish: true });
    expect(doc.drift).toBeUndefined();
    expect(doc.check.rules).toEqual([{ if: '$CI_PIPELINE_SOURCE != "schedule"' }]);
    for (const job of ["apply-wave-1", "apply-wave-2", "tips", "publish"]) expect(doc[job].rules[0].if, job).toBe('$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH && $CI_PIPELINE_SOURCE != "schedule"');
    expect(doc.plan.rules[0].if).toContain("merge_request_event");
    const both = withComments({ drift: "0 6 * * *" });
    expect(both.drift.rules).toEqual([{ if: '$CI_PIPELINE_SOURCE == "schedule" && $TERRAGUCCI_SCHEDULE != "comments"' }]);
    expect(both.comments.rules[0].if).toContain('$TERRAGUCCI_SCHEDULE == "comments"');
  });

  it.each(["github", "forgejo"] as const)("%s: refused, since a comment starts the comment jobs there", (forge) => {
    expect(() => renderPipeline({ forge, binary: "tofu", version: "1.13.1", image: "img:1", layers, env: {}, comments: "*/5 * * * *" })).toThrow(/comments is for GitLab/);
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

describe("approval: pr-review", () => {
  it.each(["github", "forgejo"] as const)("%s: the plan job posts terragucci/approval after the note, and a review of the head re-posts it", (forge) => {
    const doc = body(renderPipeline({ forge, binary: "tofu", version: "1.13.1", image: "img:1", layers, env: {}, prReview: true }).content);
    expect(Object.keys(doc.on)).toContain("pull_request_review");
    // The plan job holds no token; its note job posts the note, then terragucci/approval from the same report.
    expect(doc.jobs["plan-note"].steps.at(-1).run).toContain(`terragucci plan-note --forge ${forge} --report terragucci-report`);
    expect(doc.jobs["plan-note"].steps.at(-1).run).toContain("--approval-status");
    expect(doc.jobs["replan-note"].steps.at(-1).run).toContain("--approval-status");
    expect(doc.jobs.approval.if).toContain("github.event_name == 'pull_request_review'");
    // Forgejo reads no job permissions, so its dialect writes none.
    if (forge === "github") expect(doc.jobs.approval.permissions).toEqual({ contents: "read", statuses: "write", "pull-requests": "read" });
    else expect(doc.jobs.approval.permissions).toBeUndefined();
    expect(doc.jobs.approval.steps[0].run).toBe(`terragucci approval-status --forge ${forge}`);
  });

  it("is not in a pipeline without it, and on GitLab, whose approval rules hold a merge request, the pipeline posts no terragucci/approval", () => {
    const doc = body(render("github"));
    expect(Object.keys(doc.on)).not.toContain("pull_request_review");
    expect(doc.jobs.approval).toBeUndefined();
    const gitlab = renderPipeline({ forge: "gitlab", binary: "tofu", version: "1.13.1", image: "img:1", layers, env: {}, prReview: true }).content;
    expect(gitlab).not.toContain("approval-status");
    expect(validateConfig({ forge: "gitlab", approval: "pr-review" }, "t")).toEqual({ forge: "gitlab", approval: "pr-review" });
  });
});

describe("no forge token where the change's code runs", () => {
  const OIDC = { plan_role: "arn:aws:iam::1:role/plan", apply_role: "arn:aws:iam::1:role/apply" };
  it.each(["github", "forgejo"] as const)("%s: the plan job posts the pending status before the checkout, and plans with no token and no credentials in the checkout", (forge) => {
    const plan = body(render(forge, OIDC)).jobs.plan;
    expect(plan.env.TG_TOKEN).toBeUndefined();
    const steps = plan.steps as { name?: string; uses?: string; run?: string; env?: Record<string, string>; with?: Record<string, unknown> }[];
    const checkout = steps.findIndex((s) => String(s.uses).endsWith("actions/checkout@v4"));
    // Only the step before the checkout holds the token.
    expect(steps.findIndex((s) => s.env?.TG_TOKEN)).toBe(0);
    expect(steps.filter((s) => s.env?.TG_TOKEN)).toHaveLength(1);
    expect(checkout).toBe(1);
    expect(steps[checkout].with!["persist-credentials"]).toBe(false);
    const run = steps.find((s) => s.run?.includes("terragucci stage tf-plan"))!.run!;
    expect(run.split("\n")[0]).toBe(dropForgeTokens());
    expect(run).not.toContain("tg note");
    expect(run).not.toContain("tg status");
    expect(run).toContain(">terragucci-report/plan-status.txt");
    if (forge === "github") expect(plan.permissions).toEqual({ contents: "read", statuses: "write", "id-token": "write" });
  });

  it.each(["github", "forgejo"] as const)("%s: the plan-note job runs after the plan, checks nothing out and posts from the report", (forge) => {
    const note = body(render(forge)).jobs["plan-note"];
    expect(note.needs).toBe("plan");
    expect(note.if).toContain("needs.plan.result == 'success' || needs.plan.result == 'failure'");
    expect(note.env).toMatchObject({ TG_TOKEN: "${{ github.token }}", TG_PLAN_RESULT: "${{ needs.plan.result }}" });
    expect(JSON.stringify(note.steps)).not.toContain("actions/checkout");
    expect(note.steps.at(-1).if).toBe("always()");
    expect(note.steps.at(-1).run).toContain(`terragucci plan-note --forge ${forge} --report terragucci-report`);
  });

  it.each(["github", "forgejo"] as const)("%s: the formatting is committed by a job of its own after a failed check", (forge) => {
    const doc = body(render(forge));
    expect(doc.jobs.fmt.needs).toBe("check");
    expect(doc.jobs.fmt.if).toContain("needs.check.result == 'failure' && github.event_name == 'push'");
    expect(doc.jobs.fmt.env.TG_TOKEN).toBe("${{ github.token }}");
    expect(doc.jobs.fmt.steps.at(-1).run).toContain("terragucci respond fmt --mode apply");
    expect(JSON.stringify(doc.jobs.check)).not.toContain("respond fmt");
    expect(body(renderPipeline({ forge, binary: "tofu", version: "1.13.1", image: "img:1", layers, env: {}, respond: { fmt: "off" } }).content).jobs.fmt).toBeUndefined();
    // A Terragrunt repo gets the job too: respond fmt runs terragrunt hcl fmt beside the binary's.
    const tg = body(renderPipeline({ forge, binary: "tofu", version: "1.13.1", image: "img:1", layers: [["live/a"]], env: {}, terragrunt: { version: "0.99.0", parallelism: 4, exclude: [], installs: [{ tool: "terragrunt", version: "0.99.0" }] } }).content);
    expect(tg.jobs.fmt.steps.at(-1).run).toContain("terragucci respond fmt --mode apply --binary tofu");
    expect(tg.jobs.fmt.steps.map((x: { name?: string }) => x.name)).toContain("Install terragrunt 0.99.0");
  });

  it("the step that runs the change's code starts again without the runner's token variables, and keeps the OIDC ones", async () => {
    const dir = mkdtempSync(join(tmpdir(), "drop-"));
    const script = join(dir, "step.sh");
    writeFileSync(script, `${dropForgeTokens()}\nenv | sort > "${dir}/env"\ncat /proc/$$/environ 2>/dev/null | tr '\\0' '\\n' > "${dir}/proc" || true\n`);
    const r = spawnSync("bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", script], { env: { PATH: process.env.PATH, GITHUB_TOKEN: "x1", GITEA_TOKEN: "x2", ACTIONS_RUNTIME_TOKEN: "x3", TG_TOKEN: "x4", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "keep" }, encoding: "utf-8" });
    expect(r.status, r.stderr).toBe(0);
    const env = readFileSync(join(dir, "env"), "utf-8");
    expect(env).not.toMatch(/^(GITHUB_TOKEN|GITEA_TOKEN|ACTIONS_RUNTIME_TOKEN|TG_TOKEN)=/m);
    expect(env).toContain("ACTIONS_ID_TOKEN_REQUEST_TOKEN=keep");
    // Where /proc exists, the shell's own process environment no longer holds them either.
    const proc = readFileSync(join(dir, "proc"), "utf-8");
    if (proc) expect(proc).not.toMatch(/x[1-4]/);
  });
});

describe("the check step's restart line, for every binary", () => {
  const TG = { version: "0.99.0", parallelism: 4, exclude: [], installs: [] };
  const checkRun = (forge: "github" | "forgejo", binary: "tofu" | "terraform" | "choudoufu", tg: boolean): string =>
    body(renderPipeline({ forge, binary, version: "1.13.1", image: "img:1", layers: tg ? [["live/dev/app"]] : layers, env: {}, ...(tg ? { terragrunt: TG } : {}) }).content)
      .jobs.check.steps.find((s: { run?: string }) => typeof s.run === "string" && s.run.includes(" fmt ")).run as string;
  const cases = [["tofu", false], ["terraform", false], ["choudoufu", false], ["tofu", true]] as const;
  const tokens = { GITHUB_TOKEN: "x1", GITEA_TOKEN: "x2", ACTIONS_RUNTIME_TOKEN: "x3", TG_TOKEN: "x4" };
  const after = 'echo "reached ${GITHUB_TOKEN:-none} ${GITEA_TOKEN:-none} ${ACTIONS_RUNTIME_TOKEN:-none} ${TG_TOKEN:-none}"';

  it.each(cases)("%s (terragrunt: %s): under sh -c, with or without a PATH, the step runs on without the tokens", (binary, tg) => {
    for (const forge of ["github", "forgejo"] as const) {
      const first = checkRun(forge, binary, tg).split("\n")[0];
      expect(first).toBe(dropForgeTokens("sh"));
      // `sh -c` makes $0 "sh", which is no script file, and an empty environment has no PATH for env.
      for (const [shell, env] of [["/bin/sh", { ...tokens }], ["sh", { PATH: process.env.PATH, ...tokens }]] as const) {
        const r = spawnSync(shell, ["-c", `${first}\n${after}`], { env, encoding: "utf-8" });
        expect(r.stderr).not.toMatch(/cannot (open|execute)/);
        expect(r.status, r.stderr).toBe(0);
        expect(r.stdout.trim()).toBe("reached none none none none");
      }
    }
  });

  it.each(cases)("%s (terragrunt: %s): run as the runner runs it, sh -e <file>, the shell starts again without the tokens", (binary, tg) => {
    const dir = mkdtempSync(join(tmpdir(), "restart-"));
    const script = join(dir, "step.sh");
    writeFileSync(script, `${checkRun("forgejo", binary, tg).split("\n")[0]}\n${after} "\${TG_NO_FORGE_TOKEN:-}"\n`);
    const r = spawnSync("sh", ["-e", script], { env: { PATH: process.env.PATH, ...tokens }, encoding: "utf-8" });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe("reached none none none none 1");
  });
});

describe("the resume and rollout workflows run merged code only", () => {
  it.each(["github", "forgejo"] as const)("%s: each starts on its schedule or by hand, never on a pull request or a comment, from the default branch", (forge) => {
    const r = renderPipeline({ forge, binary: "tofu", version: "1.13.1", image: "img:1", layers, env: {}, gate: "always", resume: 15, rollouts: "*/15 * * * *" });
    expect(r.extra).toHaveLength(2);
    for (const f of r.extra!) {
      const doc = body(f.content);
      expect(Object.keys(doc.on).sort(), f.path).toEqual(["schedule", "workflow_dispatch"]);
      for (const job of Object.values(doc.jobs) as { steps: { with?: Record<string, unknown> }[] }[]) {
        // The checkout is the scheduled run's: the default branch, never a pull request's ref.
        for (const s of job.steps) expect(String(s.with?.ref ?? ""), f.path).not.toContain("refs/pull");
      }
    }
  });
});

describe("atlantis_comments", () => {
  const withAliases = (forge: ForgeName, extra: Record<string, unknown> = {}): string =>
    renderPipeline({ forge, binary: "tofu", version: "1.13.1", image: "img:1", layers, env: {}, atlantisComments: true, ...extra }).content;

  it.each(["github", "forgejo"] as const)("%s: atlantis plan starts the replan job and atlantis apply the apply-comment job, and every job reads the aliases", (forge) => {
    const wf = body(withAliases(forge));
    expect(wf.env.TG_ATLANTIS_COMMENTS).toBe("1");
    expect(wf.jobs.replan.if).toBe("github.event_name == 'issue_comment' && (startsWith(github.event.comment.body, '/terragucci') || startsWith(github.event.comment.body, 'atlantis plan')) && !(startsWith(github.event.comment.body, '/terragucci apply') || startsWith(github.event.comment.body, 'atlantis apply'))");
    expect(wf.jobs["apply-comment"].if).toBe("github.event_name == 'issue_comment' && (startsWith(github.event.comment.body, '/terragucci apply') || startsWith(github.event.comment.body, 'atlantis apply'))");
  });

  it("with apply.when: pull-request and locks: plan, the lock and plan-lock jobs take the alias too", () => {
    const wf = body(withAliases("github", { applyWhen: "pull-request", locksPlan: true }));
    expect(wf.jobs["apply-comment"].if).toContain("startsWith(github.event.comment.body, 'atlantis apply') || startsWith(github.event.comment.body, '/terragucci lock')");
    expect(wf.jobs["pr-lock"].if).toContain("(startsWith(github.event.comment.body, '/terragucci plan') || startsWith(github.event.comment.body, 'atlantis plan'))");
  });

  it("gitlab: the comments job's poll reads the aliases from the pipeline's variables", () => {
    expect(body(withAliases("gitlab", { comments: "*/5 * * * *" })).comments.variables.TG_ATLANTIS_COMMENTS).toBe("1");
  });

  it("off by default: no job names atlantis", () => {
    for (const forge of FORGES) expect(render(forge)).not.toContain("atlantis");
  });

  it("is true or false in terragucci.yml", () => {
    expect(validateConfig({ atlantis_comments: true }, "t")).toEqual({ atlantis_comments: true });
    expect(() => validateConfig({ atlantis_comments: "yes" }, "t")).toThrow(/atlantis_comments must be true or false/);
  });
});
