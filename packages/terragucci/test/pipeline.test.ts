import { downloadArtifact, forgeRef, uploadArtifact } from "../src/action-pins";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer, type IncomingMessage } from "node:http";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FORGE_TOKEN_VARS } from "@intentius/chant/ci-handover";
import { ciToolInstallLine } from "@intentius/chant/ci-image";
import { parseYAML } from "@intentius/chant/yaml";
import { validateConfig } from "../src/config";
import { AGENT_COMMAND, AGENT_DIR, agentCommentInput } from "../src/agent-comment";
import { CHANT_AGENT_PATHS } from "../src/render-chant-agent";
import { cloudLoginSpec, LOGIN_SPEC_ENV } from "@intentius/chant/ci-login";
import { AWS_CLI, forgejoSkipLevels, cloudLoginLines, needsDepths, runnerEvaluatedIf, loginSpec, confirmScript, driftScript, forgeApi, planVerbScript, dropForgeTokens, publishScript, READS_EXIT, renderPipeline } from "../src/render";
import { NOTE_WORDS } from "../src/report/views";
import type { ForgeName } from "../src/config";
import { driftOp, git, tmp } from "./helpers";

// A describe that tests the repo-wide scope (one apply at a time, by group, resource group or lock tag) sets it here.
const scope = vi.hoisted(() => ({ value: undefined as undefined | "repo" | "root" | "resource" }));
vi.mock("../src/apply-rows", async (orig) => {
  const m = await orig<typeof import("../src/apply-rows")>();
  return { ...m, applyScope: (binary: string) => scope.value ?? m.applyScope(binary) };
});
const repoWide = (): void => {
  beforeEach(() => {
    scope.value = "repo";
  });
  afterEach(() => {
    scope.value = undefined;
  });
};

const OIDC = { plan_role: "arn:aws:iam::111:role/plan-ro", apply_role: "arn:aws:iam::111:role/apply-rw" };
const layers = [["network"], ["app", "cache"]];
const FORGES: ForgeName[] = ["github", "forgejo", "gitlab"];

const render = (forge: ForgeName, oidc?: typeof OIDC): string =>
  renderPipeline({ forge, binary: "tofu", version: "1.13.1", image: "img:1", layers, env: {}, oidc }).content;

const body = (text: string): Record<string, any> => parseYAML(text.split("\n").filter((l) => !l.startsWith("#")).join("\n")) as Record<string, any>;

describe("the fmt job under locks: plan", () => {
  it.each(["github", "forgejo"] as const)("%s: after chant's commit job pushes the formatting, which starts no run, its push job answers the pull request's lock", (forge) => {
    const push = (locksPlan: boolean) => body(renderPipeline({ forge, binary: "tofu", version: "1.13.1", image: "img:1", layers, env: {}, ...(locksPlan ? { locksPlan } : {}) } as never).content).jobs["fmt-push"];
    const on = push(true);
    expect(on.steps.at(-1).run).toContain("terragucci pr-lock --layers");
    expect(on.env.TG_TOKEN).toBe("${{ github.token }}");
    // Forgejo's dialect drops permissions: its job token has them all.
    if (forge === "github") expect(on.permissions).toMatchObject({ contents: "write", statuses: "write", "pull-requests": "write" });
    const off = push(false);
    expect(JSON.stringify(off)).not.toContain("pr-lock");
    if (forge === "github") expect(off.permissions.statuses).toBeUndefined();
  });
});

describe("Forgejo's limit on skipped needs", () => {
  // Forgejo 16 skips the jobs below a skipped job one level of needs at a time while it creates the run, and
  // creates no run past five levels: five waves and the tips job below check left a pull request with no plan.
  const deep = (forge: ForgeName, waves: number): Record<string, any> =>
    body(renderPipeline({ forge, binary: "tofu", version: "1.13.1", image: "img:1", layers: Array.from({ length: waves }, (_, i) => [`r${i}`]), env: {} }).content);

  it("forgejo: check's if goes to the runner once more than five jobs chain below it", () => {
    // Four waves, the last wave's status job (apply-done) and tips below check.
    const doc = deep("forgejo", 4);
    const depth = needsDepths(new Map(Object.entries(doc.jobs).map(([k, v]) => [k, { props: v }])));
    expect(depth.get("check")).toBe(forgejoSkipLevels + 1);
    expect(doc.jobs.check.if.startsWith(`${runnerEvaluatedIf} && (github.event_name == 'push' || `)).toBe(true);
    // Only the head of the chain: the waves below keep their own if.
    expect(doc.jobs["apply-wave-1"].if).not.toContain("env.");
    expect(doc.jobs.plan.if).not.toContain("env.");
  });

  it("forgejo: three waves, apply-done and tips stay within the limit, and check's if is Forgejo's to evaluate", () => {
    expect(deep("forgejo", 3).jobs.check.if).toBe("github.event_name == 'push' || (github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name != github.repository)");
  });

  it("github: no limit, so check's if is left as it is", () => {
    expect(deep("github", 8).jobs.check.if).not.toContain("env.");
  });

  it("counts the longest chain, through a job that needs several", () => {
    const job = (needs?: string | string[]) => ({ props: needs === undefined ? {} : { needs } });
    const depth = needsDepths(new Map<string, unknown>([["a", job()], ["b", job("a")], ["c", job(["a", "b"])], ["d", job("c")]]));
    expect([depth.get("a"), depth.get("b"), depth.get("c"), depth.get("d")]).toEqual([3, 2, 1, 0]);
  });
});

describe("the check job", () => {
  it.each(["github", "forgejo"] as const)("%s: validates through check-root, tests the policy, keeps the report and has the history", (forge) => {
    const check = body(render(forge)).jobs.check;
    const run = check.steps.find((s: { run?: string }) => s.run?.includes("check-root")).run as string;
    expect(run).toContain('terragucci check-root "$dir" --binary tofu\n');
    // Three roots check at once, each into its own files; the output is printed in root order and a root's status sets `failed`.
    expect(run).toContain('tg_check "$dir"; then echo 0 >"$tgtmp/$n.rc"');
    expect(run).toContain('[ "$(cat "$tgtmp/$n.rc" 2>/dev/null)" = 0 ] || failed=1');
    expect(run).toContain("terragucci check-policy || failed=1");
    expect(run).toContain('exit "$failed"');
    expect(run).not.toContain("validate -no-color");
    expect(check.permissions).toBeUndefined();
    expect(run.split("\n")[0]).toBe(dropForgeTokens("sh"));
    const withPolicy = body(renderPipeline({ forge, binary: "tofu", version: "1.13.1", image: "img:1", layers, env: {}, policy: true }).content).jobs.check;
    expect(check.env.TG_BRANCH).toBe("${{ github.event.repository.default_branch }}");
    {
      // A script checks out, with the token in its own step alone; the check step is the job's last. Without `policy:`
      // the clone is shallow; with it the policy tests have the history.
      expect(check.steps[0].name).toBe("Check out the change");
      expect(check.steps[0].env).toEqual({ TG_TOKEN: "${{ github.token }}" });
      expect(check.steps[0].run).toContain("--depth=1");
      expect(withPolicy.steps[0].run).not.toContain("--depth=1");
      expect(withPolicy.steps[0].run).toContain("+refs/heads/*:refs/remotes/origin/*");
      expect(check.steps.filter((s: { env?: Record<string, string> }) => s.env?.TG_TOKEN)).toHaveLength(1);
      expect(check.steps.at(-1).run).toBe(run);
      expect(JSON.stringify(check.steps)).not.toMatch(/actions\/(checkout|upload-artifact|cache)/);
      expect(check.outputs.report_0).toBe("${{ steps.check.outputs.report_0 }}");
      // The check-report job keeps the report the check job hands on.
      const keeper = body(render(forge)).jobs["check-report"];
      expect(keeper.needs).toBe("check");
      expect(keeper.steps[0].run).toContain("${{ toJSON(needs.check.outputs.report_0) }}");
      const keep = keeper.steps.find((s: { name?: string }) => s.name === "Keep the check report");
      expect(keep.uses).toBe(forgeRef(forge, uploadArtifact(forge)));
      expect(keep.with).toMatchObject({ name: "terragucci-check", path: "terragucci-check/" });
      expect(JSON.stringify(keeper)).not.toMatch(/checkout|TG_TOKEN/);
    }
  });

  it("gitlab: the same script, the report as an artifact, the history in the clone", () => {
    const doc = body(render("gitlab"));
    expect(doc.check.script.join("\n")).toContain('tg_check "$dir"; then echo 0 >"$tgtmp/$n.rc"');
    // With respond.fmt on (the default), the check also keeps the finding dotenv that starts chant's commit job (chant#4749).
    expect(doc.check.artifacts).toEqual({ name: "terragucci-check", when: "always", paths: ["terragucci-check/", ".chant/commit/finding.env"], reports: { dotenv: ".chant/commit/finding.env" } });
    expect(doc.check.variables).toMatchObject({ TG_BRANCH: "$CI_DEFAULT_BRANCH" });
    expect(doc.check.variables.GIT_DEPTH).toBeUndefined();
    const withPolicy = body(renderPipeline({ forge: "gitlab", binary: "tofu", version: "1.13.1", image: "img:1", layers, env: {}, policy: true }).content);
    expect(withPolicy.check.variables.GIT_DEPTH).toBe("0");
  });

  it("gitlab: every push remote uses the server's own protocol and port", () => {
    const remote = 'git remote set-url origin "${CI_SERVER_PROTOCOL}://oauth2:${TG_TOKEN}@${CI_SERVER_FQDN}/${CI_PROJECT_PATH}.git"';
    expect(publishScript("gitlab")).toContain(remote);
    const all = renderPipeline({ forge: "gitlab", binary: "tofu", version: "1.13.1", image: "img:1", layers, env: {}, policy: true }).content;
    expect(all).not.toContain("CI_SERVER_HOST");
    expect(all).not.toContain("https://oauth2");
  });

  it("a choudoufu pipeline passes its binary, which check-root uses to run live-check", () => {
    const text = renderPipeline({ forge: "github", binary: "choudoufu", version: "1.0.0", image: "img:1", layers, env: {} }).content;
    expect(text).toContain('terragucci check-root "$dir" --binary choudoufu\n');
    expect(text).toContain('tg_init choudoufu -chdir="$dir" init -backend=false');
  });
});

describe("apply concurrency", () => {
  const cdf = (forge: ForgeName): string => renderPipeline({ forge, binary: "choudoufu", version: "0.25.0", image: "img:1", layers, env: {}, oidc: OIDC }).content;

  it.each(FORGES)("%s: no apply job waits for another run's: two roots apply at once, and the backend's state lock keeps one root's applies apart", (forge) => {
    for (const text of [render(forge, OIDC), cdf(forge)]) {
      const doc = body(text);
      const jobs = forge === "gitlab" ? doc : doc.jobs;
      for (const [name, job] of Object.entries(jobs as Record<string, any>)) {
        if (!/^apply-|^mr-apply$/.test(name)) continue;
        expect(job.concurrency, name).toBeUndefined();
        expect(job.resource_group, name).toBeUndefined();
      }
      expect(text).not.toContain("terragucci-apply-lock");
      expect(text).not.toContain("terragucci-apply-hold");
    }
  });

  it("forgejo: each push to the default branch runs in a group of its own commit, so a later push neither cancels nor waits for an earlier one", () => {
    const group = body(render("forgejo")).concurrency;
    expect(group["cancel-in-progress"]).toBe(false);
    expect(group.group).toContain("github.event_name == 'push' && github.ref == format('refs/heads/{0}', github.event.repository.default_branch) && format('{0}-{1}', github.ref, github.sha) || github.ref }}");
    // Comments and dispatches keep their pull request's group, and another branch's pushes wait for each other as before.
    expect(group.group).toMatch(/^terragucci-\$\{\{ github\.event_name == 'issue_comment' && format\('comment-\{0\}'/);
  });

  // The stand-down for a newer push and the refusal of what another run applies are chant's wave runner's (the spec's standDown).
  it.each(["github", "forgejo"] as const)("%s: a wave split across jobs decides in its own job and applies in its shares, with no concurrency group and no lock tag", (forge) => {
    const doc = body(renderPipeline({ forge, binary: "tofu", version: "1.13.1", image: "img:1", layers: [["net"], ["a", "b", "c", "d", "e"]], env: {}, waveJobs: 2 } as never).content);
    const run = (j: string): string => doc.jobs[j].steps.map((x: { run?: string }) => x.run ?? "").join("\n");
    expect(run("apply-wave-2")).toContain("terragucci run wave --spec .chant/op-waves/tf-apply.spec.json --wave 2 --render-spec --decide");
    for (const s of [1, 2]) expect(run(`apply-wave-2-share-${s}`)).toContain(`--wave 2 --render-spec --share ${s}`);
    for (const j of ["apply-wave-1", "apply-wave-2", "apply-wave-2-share-1", "apply-wave-2-share-2"]) {
      expect(doc.jobs[j].concurrency, j).toBeUndefined();
      expect(run(j), j).not.toContain("terragucci-apply-lock");
    }
  });

  it("choudoufu: a wave holds the resources it changes on chant/lifecycle, so its job may push there", () => {
    const doc = body(renderPipeline({ forge: "github", binary: "choudoufu", version: "0.25.0", image: "img:1", layers, env: {}, oidc: OIDC, gate: "never" }).content);
    for (const job of ["apply-wave-1", "apply-wave-2"]) expect(doc.jobs[job].permissions.contents, job).toBe("write");
  });
});

describe("apply concurrency with a repo-wide scope", () => {
  // terragucci's own lock tag, apply group and resource group under a repo-wide scope went with its apply jobs; chant's wave runner keeps applies apart.
  repoWide();

  it("forgejo names a workflow-level group that does not cancel, or a later push cancels a run that is applying", () => {
    expect(body(render("forgejo")).concurrency).toEqual({ group: "terragucci-${{ github.event_name == 'issue_comment' && format('comment-{0}', github.event.issue.number) || (github.event_name == 'workflow_dispatch' && github.event.inputs.pr != '') && format('comment-{0}', github.event.inputs.pr) || github.ref }}", "cancel-in-progress": false });
    expect(body(render("github")).concurrency).toBeUndefined();
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
    expect(doc.jobs["apply-wave-1"].needs).toEqual(["check"]);
  });

  it.each(["github", "forgejo"] as const)("%s: the comment never reaches a shell as an expression", (forge) => {
    const text = render(forge);
    const run = JSON.stringify(body(text).jobs.replan.steps);
    // chant's re-plan decision reads the comment from the event file (terragucci issue 1411).
    expect(run).not.toContain("github.event.comment");
    expect(run).toContain("GITHUB_EVENT_PATH");
    expect(run).not.toContain("eval ");
    // The only mentions of the comment body are the jobs' if filters, never a script.
    const doc = body(text);
    expect(JSON.stringify(doc.jobs["apply-comment"].steps)).not.toContain("github.event.comment");
    for (const line of text.split("\n").filter((l) => l.includes("${{ github.event.comment"))) expect(line.trim()).toMatch(/^if: /);
    expect(text).not.toContain("${{ github.event.comment");
  });

  it("the re-plan decides from the comment with the token, before the head is checked out, and plans the head with no token", () => {
    const job = body(render("github")).jobs.replan;
    const names = job.steps.map((s: any) => s.id ?? s.uses ?? s.name);
    expect(names.indexOf("decide")).toBeLessThan(names.indexOf("head"));
    expect(job.steps.find((s: any) => s.id === "decide").env.CHANT_REPLAN_TOKEN).toBe("${{ github.token }}");
    // A re-plan of the whole change says it is planning, on the head the decision read.
    expect(job.steps.find((s: any) => s.name === "Say on the head that the plan started").env).toMatchObject({ CHANT_PENDING_SHA: "${{ steps.decide.outputs.head }}", CHANT_PENDING_CONTEXT: "terragucci/plan" });
    const plan = job.steps.find((s: any) => typeof s.run === "string" && s.run.includes("terragucci stage tf-plan"));
    expect(plan.env.CHANT_PLAN_ARGUMENT).toBe("${{ steps.decide.outputs.argument }}");
    expect(plan.run).toContain('TG_ROOT="${CHANT_PLAN_ARGUMENT:-}"');
    expect(plan.run).toContain('${TG_ROOT:+--root "$TG_ROOT"}');
    expect(plan.run.split("\n")[0]).toContain("-u GITHUB_TOKEN");
    expect(JSON.stringify(job.env ?? {})).not.toMatch(/TG_TOKEN|github\.token/);
    // The checkout is a script with the token in its own step alone, and the plan step is the job's last.
    const checkouts = job.steps.filter((s: any) => s.name?.startsWith("Check out"));
    expect(checkouts).toHaveLength(1);
    expect(checkouts[0].env.CHANT_CHECKOUT_TOKEN).toBe("${{ github.token }}");
    expect(job.steps.at(-1)).toBe(plan);
    expect(JSON.stringify(job.steps)).not.toContain("actions/checkout");
  });

  it("a re-plan of a root the change does not reach is answered by the replan-note job, which leaves the note and status", () => {
    const doc = body(render("github"));
    expect(doc.jobs["replan-note"].needs).toEqual(["replan"]);
    expect(doc.jobs["replan-note"].steps.at(-1).run).toContain('--not-affected "$CHANT_PLAN_ARGUMENT"');
    expect(doc.jobs["plan-note"].steps.at(-1).run).not.toContain("--not-affected");
  });

  it("forgejo: the re-plan asks the forge whether the commenter can write, and checks out the pull request's head by number", () => {
    const job = body(render("forgejo")).jobs.replan;
    expect(job.steps.find((s: any) => s.id === "decide").env.CHANT_REPLAN_PERMISSION).toBe("1");
    expect(body(render("github")).jobs.replan.steps.find((s: any) => s.id === "decide").env.CHANT_REPLAN_PERMISSION).toBeUndefined();
    expect(JSON.stringify(job.steps)).toContain("refs/pull/${{ steps.decide.outputs.pr }}/head");
  });

  it.each(["github", "forgejo"] as const)("%s: a workflow_dispatch with pr starts the replan job, never drift, check, plan or an apply", (forge) => {
    const doc = body(render(forge, OIDC));
    expect(doc.on.workflow_dispatch.inputs.pr).toMatchObject({ required: false, type: "string" });
    expect(doc.on.workflow_dispatch.inputs.root).toMatchObject({ required: false, type: "string" });
    expect(doc.jobs.replan.if).toContain("(github.event_name == 'workflow_dispatch' && github.event.inputs.pr != '')");
    expect(doc.jobs.replan.concurrency.group).toBe("terragucci-replan-${{ github.repository }}-${{ github.event.issue.number || github.event.inputs.pr }}");
    // The inputs, like the comment, reach the decision only through the event file, never a script.
    expect(JSON.stringify(doc.jobs.replan.steps)).not.toContain("github.event.inputs");
    expect(doc.jobs.replan.steps.find((s: any) => s.id === "decide").env.CHANT_REPLAN_DISPATCH_ARGUMENT).toBe("root");
    for (const [name, j] of Object.entries(doc.jobs) as [string, any][]) {
      if (name === "replan" || name === "replan-note") continue;
      expect(String(j.if ?? ""), name).not.toMatch(/workflow_dispatch' && github\.event\.inputs\.pr != ''|event_name == 'workflow_dispatch'$/);
    }
    // On Forgejo the dispatch waits in its pull request's comment group, not behind the default branch's applying run.
    if (forge === "forgejo") expect(doc.concurrency.group).toContain("(github.event_name == 'workflow_dispatch' && github.event.inputs.pr != '') && format('comment-{0}', github.event.inputs.pr)");
  });

  // The apply on a comment is chant's comment job (components pr-comment): it re-runs the merge commit's wave jobs, which hold the
  // apply role, so the comment job holds no cloud credential and runs no stage of its own.
  it.each(["github", "forgejo"] as const)("%s: `/terragucci apply` starts chant's comment job, which holds no cloud role and names the wave jobs it re-runs", (forge) => {
    const doc = body(render(forge, OIDC));
    const job = doc.jobs["apply-comment"];
    expect(job.if).toBe("github.event_name == 'issue_comment' && startsWith(github.event.comment.body, '/terragucci apply')");
    expect(job.concurrency).toBeUndefined();
    const answer = job.steps.find((s: { run?: string }) => s.run?.includes("terragucci components pr-comment"));
    expect(answer.run).toBe(`npx --no-install terragucci components pr-comment --forge ${forge}`);
    expect(JSON.parse(answer.env.CHANT_COMMENT_JOBS)).toMatchObject({ applyOnMerge: true, waves: { op: "tf-apply", count: 2 }, applyJobs: ["apply-wave-1", "apply-wave-2"] });
    expect(JSON.stringify(job)).not.toContain(OIDC.apply_role);
    expect(JSON.stringify(job)).not.toContain(OIDC.plan_role);
    expect(JSON.stringify(job)).not.toContain("terragucci stage tf-apply");
    if (forge === "github") {
      expect(job.permissions).toEqual({ actions: "write", contents: "write", "pull-requests": "write", statuses: "read" });
      expect(job.permissions["id-token"]).toBeUndefined();
    }
    expect(job["enable-openid-connect"]).toBeUndefined();
    // The wave jobs hold the apply role and run only for a push to the default branch.
    expect(JSON.stringify(doc.jobs["apply-wave-1"])).toContain(OIDC.apply_role);
    expect(doc.jobs["apply-wave-1"].if).toContain("github.event_name == 'push' && (github.ref == format('refs/heads/{0}', github.event.repository.default_branch))");
  });

  it.each(["github", "forgejo"] as const)("%s: a Terragrunt repo gets the same comment job over its waves of units", (forge) => {
    const doc = body(renderPipeline({ forge, binary: "tofu", version: "1.13.1", image: "img:1", layers: [["live/dev/a"], ["live/prod/a", "live/prod/b"]], env: {}, gate: "always", canary: ["live/dev/**"], terragrunt: { version: "0.99.0", parallelism: 4, exclude: [], installs: [] } }).content);
    const job = doc.jobs["apply-comment"];
    expect(job.if).toBe("github.event_name == 'issue_comment' && startsWith(github.event.comment.body, '/terragucci apply')");
    expect(doc.jobs.replan.if).toContain("!startsWith(github.event.comment.body, '/terragucci apply')");
    const answer = job.steps.find((s: { run?: string }) => s.run?.includes("terragucci components pr-comment"));
    expect(JSON.parse(answer.env.CHANT_COMMENT_JOBS)).toMatchObject({ waves: { op: "tf-apply", count: 2 }, applyJobs: ["apply-wave-1", "apply-wave-2"] });
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
    expect(doc.jobs.replan.if).toContain("!startsWith(github.event.comment.body, '/terragucci lock') && !startsWith(github.event.comment.body, '/terragucci unlock')");
    // Pushes, plans and applies do not run on the new trigger: every other job names its own event or needs check.
    for (const [name, j] of Object.entries(doc.jobs) as [string, any][]) {
      if (name === "pr-lock") continue;
      expect(String(j.if ?? "") + String(j.needs ?? ""), name).toMatch(/event_name == '(push|pull_request|issue_comment|pull_request_review|schedule)'|check|apply-wave|apply-done|confirm|replan|fmt/);
    }
    if (forge === "forgejo") expect(doc.concurrency.group).toContain("github.event_name == 'pull_request_target' && format('lock-{0}', github.event.pull_request.number)");
  });

  it("under apply.when: pull-request, pr-lock reads only plan comments; a Terragrunt repo locks units", () => {
    const doc = renderLocks("github", { applyWhen: "pull-request", terragrunt: { version: "0.99.0", parallelism: 4, exclude: [], installs: [] }, layers: [["live/a"]] });
    expect(doc.jobs["pr-lock"].if).toBe("github.event_name == 'pull_request_target' || (github.event_name == 'issue_comment' && startsWith(github.event.comment.body, '/terragucci plan'))");
    expect(doc.jobs["pr-lock"].steps[1].run).toContain("terragucci pr-lock --layers 'live/a' --when pull-request --terragrunt");
    expect(doc.jobs.replan.if).toContain("!startsWith(github.event.comment.body, '/terragucci lock')");
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

  // The decision on an open pull request's head, its split wave jobs and pr-merge are chant's (the comment job's wavesBeforeMerge).
  it.each(["github", "forgejo"] as const)("%s: the comment job decides the head and dispatches the split waves, and the push after the merge confirms instead of applying", (forge) => {
    const doc = renderPr(forge);
    const job = doc.jobs["apply-comment"];
    // Before merge it answers lock and unlock too, by the reach line (chant issue 5061).
    expect(job.if).toBe("github.event_name == 'issue_comment' && (startsWith(github.event.comment.body, '/terragucci apply') || startsWith(github.event.comment.body, '/terragucci lock') || startsWith(github.event.comment.body, '/terragucci unlock'))");
    expect(JSON.stringify(job)).toContain("terragucci reach --layers 'network;app,cache'");
    expect(doc.jobs.replan.if).toContain("!startsWith(github.event.comment.body, '/terragucci apply') && !startsWith(github.event.comment.body, '/terragucci lock') && !startsWith(github.event.comment.body, '/terragucci unlock')");
    // Forgejo ignores permissions:, so only GitHub's jobs carry them.
    if (forge === "github") expect(job.permissions).toMatchObject({ actions: "write", contents: "write", checks: "read" });
    const answer = job.steps.find((s: { run?: string }) => s.run?.includes("terragucci components pr-comment"));
    const jobs = JSON.parse(answer.env.CHANT_COMMENT_JOBS);
    expect(jobs.wavesBeforeMerge).toMatchObject({ workflow: "terragucci.yml", inputs: { pr: "apply_pr", head: "apply_head", digest: "apply_digest" }, plan: ["terragucci/plan"] });
    expect(JSON.stringify(job)).not.toContain(OIDC.apply_role);
    // The waves run on the dispatch of a decided head, never on a push.
    for (const name of ["apply-wave-1-plan", "apply-wave-1-gate", "apply-wave-1", "apply-wave-1-record"]) {
      expect(doc.jobs[name].if, name).toContain("github.event_name == 'push' && (false)");
      expect(doc.jobs[name].if, name).toContain("github.event.inputs.apply_head != ''");
    }
    expect(doc.on.workflow_dispatch.inputs).toMatchObject({ apply_pr: expect.any(Object), apply_head: expect.any(Object), apply_digest: expect.any(Object) });
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

  it("apply after merge is unchanged when apply.when is unset", () => {
    const doc = body(render("github", OIDC));
    expect(doc.jobs.confirm).toBeUndefined();
    expect(doc.jobs["apply-wave-1"]).toBeDefined();
    expect(doc.jobs["apply-comment"].permissions.checks).toBeUndefined();
  });

  it("gitlab needs comments and a merge token: the comments job reads the note and starts the apply pipeline with that token", () => {
    expect(() => renderPr("gitlab", undefined, "MERGE_TOKEN")).toThrow(/apply\.when: pull-request on GitLab needs comments: <cron>/);
    expect(() => body(renderPipeline({ forge: "gitlab", binary: "tofu", version: "1.13.1", image: "img:1", layers, env: {}, comments: "*/5 * * * *", applyWhen: "pull-request" }).content)).toThrow(/needs apply\.merge_token_env/);
  });

  describe("gitlab", () => {
    const gl = (extra: Partial<Parameters<typeof renderPipeline>[0]> = {}): Record<string, any> =>
      body(renderPipeline({ forge: "gitlab", binary: "tofu", version: "1.13.1", image: "img:1", layers, env: {}, oidc: OIDC, comments: "*/5 * * * *", applyWhen: "pull-request", applyMergeTokenEnv: "MERGE_TOKEN", ...extra }).content);

    it("the push after the merge confirms; the waves run in the pipeline the comments job starts with the decided head", () => {
      const doc = gl();
      expect(doc.confirm.rules[0].if).toBe('$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH && $CI_PIPELINE_SOURCE != "schedule" && $CHANT_PLAN_NOTES == null && $CHANT_BEFORE_MERGE_HEAD == null');
      expect(doc.confirm.script.join("\n")).toContain(OIDC.plan_role);
      expect(doc.confirm.script.join("\n")).not.toContain(OIDC.apply_role);
      expect(doc.check.rules[0].if).toBe('$CI_PIPELINE_SOURCE != "schedule" && $CHANT_PLAN_NOTES == null && $CHANT_BEFORE_MERGE_HEAD == null');
      expect(doc["mr-apply"]).toBeUndefined();
      for (const name of ["apply-wave-1-plan", "apply-wave-1-gate", "apply-wave-1", "apply-wave-1-record"]) {
        const rules = doc[name].rules.map((r: { if: string }) => r.if);
        for (const r of rules) expect(r, name).toContain('$CI_PIPELINE_SOURCE != "push"');
        expect(rules.some((r: string) => r.includes("$CHANT_BEFORE_MERGE_HEAD =~") && r.includes("$CI_PIPELINE_SOURCE =~ /^(web|api|trigger)$/")), name).toBe(true);
      }
      expect(JSON.stringify(doc["apply-wave-1"])).not.toContain("MERGE_TOKEN");
      // apply.merge manual: chant's pr-merge job says the head applied and merges nothing, so it holds no merge token.
      expect(doc["pr-merge"].script).toEqual(["terragucci run wave --op tf-apply --wave 2 --merge manual --forge gitlab --gate tf-apply"]);
      expect(JSON.stringify(doc["pr-merge"])).not.toContain("MERGE_TOKEN");
    });

    it("the comments job polls with --when pull-request and holds the merge token, in the merge environment, as chant's pr-merge does", () => {
      const doc = gl({ applyMerge: "auto", applyRequires: ["approved", "checks"] });
      expect(doc.comments.variables).toEqual({ TG_TOKEN: "$GITLAB_TOKEN", TG_MERGE_TOKEN: "$MERGE_TOKEN", GIT_DEPTH: "0", CHANT_LOCK_REACH: "terragucci reach --layers 'network;app,cache'" });
      expect(doc.comments.environment).toEqual({ name: "terragucci-merge", action: "access" });
      expect(doc.comments.script.join("\n")).toContain("terragucci comment --forge gitlab --poll --layers 'network;app,cache' --when pull-request --requires approved,checks");
      const merge = doc["pr-merge"];
      expect(merge.needs).toEqual(["apply-wave-2-record"]);
      expect(merge.environment).toEqual({ name: "terragucci-merge", action: "access" });
      expect(merge.variables).toEqual({ GIT_DEPTH: "0", CHANT_MERGE_TOKEN: "$MERGE_TOKEN" });
      expect(merge.id_tokens).toBeUndefined();
      expect(merge.script).toEqual(["terragucci run wave --op tf-apply --wave 2 --merge auto --forge gitlab --gate tf-apply --merge-token-env CHANT_MERGE_TOKEN"]);
      expect(JSON.stringify(doc["apply-wave-1"])).not.toContain("MERGE_TOKEN");
    });
  });

  it("apply.merge auto merges in chant's pr-merge job, the only wave job that gets apply.merge_token_env's secret", () => {
    // Forgejo pushes a merge as its doer, and refuses a push to a branch from the job's own token.
    expect(() => renderPr("forgejo", "auto")).toThrow(/apply\.merge: auto on Forgejo needs apply\.merge_token_env/);
    for (const forge of ["github", "forgejo"] as const) {
      const doc = renderPr(forge, "auto", "MERGE_TOKEN");
      const merge = doc.jobs["pr-merge"];
      expect(merge.needs).toEqual(["apply-wave-2-record"]);
      const step = merge.steps.at(-1);
      // The merge releases the locks the decision took in terragucci's lock file (gate tf-apply).
      expect(step.run).toBe(`terragucci run wave --op tf-apply --wave 2 --merge auto --forge ${forge} --gate tf-apply --merge-token-env CHANT_MERGE_TOKEN`);
      expect(step.env.CHANT_MERGE_TOKEN).toBe("${{ secrets.MERGE_TOKEN }}");
      expect(JSON.stringify(merge)).not.toContain(OIDC.apply_role);
      for (const [name, job] of Object.entries(doc.jobs as Record<string, any>)) {
        if (name !== "pr-merge") expect(JSON.stringify(job), name).not.toContain("secrets.MERGE_TOKEN");
      }
    }
    expect(JSON.stringify(renderPr("github", "auto").jobs["pr-merge"])).not.toContain("secrets.");
  });

  it.each(["github", "forgejo"] as const)("%s: a Terragrunt repo applies before merge: the waves of units run on a decided head, and the confirm job plans every unit after the plan prelude", (forge) => {
    const tgLayers = [["live/canary/one"], ["live/fleet/two"]];
    const doc = body(renderPipeline({ forge, binary: "tofu", version: "1.13.1", image: "img:1", layers: tgLayers, env: {}, gate: "always", terragrunt: { version: "0.99.0", parallelism: 4, exclude: [], installs: [] }, applyWhen: "pull-request", applyMerge: "auto", ...(forge === "forgejo" ? { applyMergeTokenEnv: "MERGE_TOKEN" } : {}) }).content);
    expect(doc.jobs["pr-merge"]).toBeDefined();
    expect(doc.jobs["apply-wave-1"].if).toContain("github.event.inputs.apply_head != ''");
    const confirm = doc.jobs.confirm.steps.find((s: { run?: string }) => s.run?.includes("terragucci stage tf-plan")).run as string;
    expect(confirm).toContain("--terragrunt");
    expect(confirm).toContain('TG_DOWNLOAD_DIR="$PWD/.terragrunt-cache/sources"');
    expect(confirm.indexOf("TG_DOWNLOAD_DIR")).toBeLessThan(confirm.indexOf("terragucci stage tf-plan"));
    expect(confirm).toContain("every unit plans no change");
  });

  describe("in the step's own shell", () => {
    const fake = () => fakeBin("#!/usr/bin/env bash\nexit 0\n", {
      terragucci: [
        "#!/usr/bin/env bash",
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

  it.each(["github", "forgejo"] as const)("%s: an agent comment is chant's agent job, in a workflow of its own, and the re-plan job leaves it alone", (forge) => {
    const out = renderPipeline({ forge, binary: "tofu", version: "1.13.1", image: "img:1", layers, env: {}, oidc: OIDC, agentComment: agent });
    const doc = body(out.content);
    expect(doc.jobs.agent).toBeUndefined();
    expect(doc.jobs["agent-push"]).toBeUndefined();
    expect(doc.jobs.replan.if).toContain("&& !startsWith(github.event.comment.body, '/terragucci agent')");
    expect(doc.jobs.replan.steps.find((s: any) => s.id === "decide").env.CHANT_REPLAN_OTHERS).toBe('["/terragucci apply","/terragucci agent"]');
    expect(out.extra?.map((f) => f.path)).toContain(CHANT_AGENT_PATHS[forge]);
  });

  it("the default command is Claude Code in print mode with the file tools and no web, MCP or project settings", () => {
    expect(AGENT_COMMAND).toMatch(/^npx -y @anthropic-ai\/claude-code@\d+\.\d+\.\d+ -p /);
    for (const flag of ['--max-turns "$TG_AGENT_MAX_TURNS"', "--permission-prompts none", "--setting-sources user", "--strict-mcp-config", '"Edit(.git/**)"', '"WebFetch"']) expect(AGENT_COMMAND).toContain(flag);
    expect(AGENT_COMMAND).not.toContain("dangerously");
    expect(AGENT_COMMAND).not.toContain("bypassPermissions");
  });

  it("gitlab: needs comments, whose job starts chant's agent pipeline on the default branch", () => {
    expect(() => renderPipeline({ forge: "gitlab", binary: "tofu", version: "1.13.1", image: "img:1", layers, env: {}, agentComment: agent })).toThrow(/agent\.comment on GitLab needs comments: <cron>/);
    const out = renderPipeline({ forge: "gitlab", binary: "tofu", version: "1.13.1", image: "img:1", layers, env: {}, agentComment: agent, comments: "*/5 * * * *" });
    const doc = parseYAML(out.content) as any;
    expect(doc.comments.script[0]).toContain("--agent chant");
    expect(doc.agent).toBeUndefined();
    expect(doc["agent-push"]).toBeUndefined();
    expect(out.content).toContain(`- local: ${CHANT_AGENT_PATHS.gitlab}`);
    // The pipeline the comments job starts runs the agent's jobs alone.
    expect(doc["apply-wave-1"].rules[0].if).toContain("$CHANT_AGENT_PR == null");
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
    // apply-done is chant's status job after the last wave.
    expect(jobs.publish.needs).toBe("apply-done");
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
    expect(doc.publish.needs).toEqual(["apply-done"]);
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
    // terragucci/apply is posted by chant's status jobs after each wave, once per wave, never per root.
    const contexts = [...text.matchAll(/--apply-status (\S+)/g)].map((m) => m[1]);
    expect([...new Set(contexts)]).toEqual(["terragucci/apply"]);
    expect(contexts).toHaveLength(2);
    expect(text).not.toMatch(/tg status [^\n]*\$dir/);
    // terragucci/plan is chant's note job's, under the context branch protection names (terragucci issue 1411).
    expect([...new Set([...text.matchAll(/--context (\S+)/g)].map((m) => m[1]))]).toEqual(["terragucci/plan"]);
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

  it("github: id-token is written for plan and apply; an apply wave writes contents, for its gate record, under any gate", () => {
    const doc = body(render("github", OIDC));
    for (const j of ["plan", "apply-wave-1", "apply-wave-2"]) expect(doc.jobs[j].permissions["id-token"]).toBe("write");
    expect(doc.jobs.plan.permissions.contents).toBe("read");
    expect(doc.jobs["apply-wave-1"].permissions.contents).toBe("write");
    expect(doc.permissions).toEqual({ contents: "read" });
    // The wave's job takes the stricter of --gate and the top-level gate at base, so a wave under gate: never may wait too.
    const never = body(renderPipeline({ forge: "github", binary: "tofu", version: "1.13.1", image: "img:1", layers, env: {}, oidc: OIDC, gate: "never" }).content);
    expect(never.jobs["apply-wave-1"].permissions.contents).toBe("write");
  });

  it("github: with a drift schedule the note jobs check the drift job's watch, and without one they do not", () => {
    const out = renderPipeline({ forge: "github", binary: "tofu", version: "1.13.1", image: "img:1", layers, env: {}, drift: "0 6 * * *" });
    const drift = body(out.content);
    // chant's note job reads the runs (actions: read) and checks the watch the pipeline gives it, never the plan job's report.
    expect(drift.jobs["plan-note"].permissions.actions).toBe("read");
    expect(drift.jobs["replan-note"].permissions.actions).toBe("read");
    expect(drift.jobs.plan.permissions.actions).toBeUndefined();
    const post = (doc: Record<string, any>): Record<string, string> => doc.jobs["plan-note"].steps.at(-1).env;
    expect(JSON.parse(post(drift).CHANT_PLAN_WATCHES)).toEqual([{ op: "tf-drift", cron: "0 6 * * *", files: [".github/workflows/terragucci-drift.yml", ".github/workflows/terragucci.yml"] }]);
    // The drift job is chant's Op in a workflow of its own (terragucci#1305), which reads no runs.
    expect(driftOp(out, "github")!.text).not.toContain("actions: read");
    expect(post(body(render("github"))).CHANT_PLAN_WATCHES).toBeUndefined();
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
    // The plan and wave jobs trade the runner's OIDC token for their identities (chant's trade step).
    expect(text).toContain("CHANT_CLOUD_TRADE");
    expect(render("forgejo")).not.toContain("enable-openid-connect");
    // chant's login names the setting in what it tells a Forgejo job with no token; GitHub's jobs set no such key.
    expect(render("github", OIDC)).not.toMatch(/^\s*enable-openid-connect:/m);
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
    expect(doc.plan.id_tokens).toEqual({ CHANT_ID_TOKEN_AWS: { aud: "sts.amazonaws.com" } });
    expect(doc["apply-wave-1"].id_tokens).toEqual({ CHANT_ID_TOKEN_AWS: { aud: "sts.amazonaws.com" } });
    expect(doc.check.id_tokens).toBeUndefined();
    expect(doc.plan.rules[0].if).toContain("$CI_MERGE_REQUEST_SOURCE_PROJECT_ID == $CI_MERGE_REQUEST_PROJECT_ID");
  });

  it.each(FORGES)("%s: with no oidc setting there is no id-token and no role", (forge) => {
    const text = render(forge);
    // The wave jobs' guard names the permission in an error message; no job asks for a token.
    expect(text).not.toMatch(/^\s*(id-token|id_tokens):|AWS_ROLE_ARN|CHANT_CLOUD_TRADE/m);
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
    // A stand-in terragucci still says things on the forge as the real one does: `tg status|note|reply|stale` runs `terragucci post`.
    const body = name === "terragucci" && CLI ? text.replace(/^(#![^\n]*\n)/, (shebang) => `${shebang}if [ "$1" = post ]; then exec node ${JSON.stringify(CLI)} "$@"; fi\n`) : text;
    writeFileSync(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  }
  return { dir, env: { PATH: `${bin}:${process.env.PATH}` } };
}

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
// The real CLI, built once: the stand-in terragucci of each step hands `post` to it (fakeBin).
beforeAll(async () => {
  await terragucciBin(tmp("tg-cli-bin-"));
}, 120_000);
/** A `terragucci` on the path, bundled from this tree as the CI image carries it. */
async function terragucciBin(bin: string): Promise<void> {
  if (!CLI) {
    const { build } = await import("esbuild");
    // The shipped bundle's external chant core where the installed chant serves compiled JS (terragucci#1281).
    const { chantExternalPlugin } = await import("@intentius/chant/bundle-check");
    // Beside the root's node_modules, so the external chant core resolves as it does for the installed package.
    const cache = join(import.meta.dirname, "../../../node_modules/.cache/terragucci");
    mkdirSync(cache, { recursive: true });
    CLI = join(cache, `pipeline-cli-${process.pid}.mjs`);
    await build({
      entryPoints: [join(import.meta.dirname, "../src/cli.ts")], outfile: CLI, bundle: true, platform: "node", format: "esm", target: "node22",
      external: ["@intentius/tsad-reference", "@cdktn/hcl2json", "typescript"], logLevel: "silent", plugins: [chantExternalPlugin(join(import.meta.dirname, ".."))],
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
  // The plan verb writes chant's hand-off, and chant's note job posts it through terragucci's bin (terragucci issue 1411).
  const HEAD = "a".repeat(40);
  const postNote = (repo: string, api: string, extra: Record<string, string> = {}) =>
    run(`cd ${JSON.stringify(repo)}\nterragucci components pr-post --pr 7 --head ${HEAD} --env default --output terragucci-report --forge github --result success --context terragucci/plan`, {
      GITHUB_TOKEN: "t", GITHUB_API_URL: api, GITHUB_REPOSITORY: "acme/infra", GITHUB_SERVER_URL: "http://forge", GITHUB_RUN_ID: "9",
      CHANT_PLAN_NOTE_WORDS: JSON.stringify({ ...NOTE_WORDS, productMarker: "terragucci:plan" }), ...extra,
    });

  it("plans, hands the note off, and chant's note job posts it as the one plan note, with one status from its counts", async () => {
    const { repo, env } = await planRepo();
    const api = await stubApi(() => []);
    try {
      const r = await run(`cd ${JSON.stringify(repo)}\n${planVerbScript("tofu", [["network"], ["app", "cache"]], "github")}`, {
        ...env, TG_SHA: HEAD, TG_PR: "7", GITHUB_SERVER_URL: "http://forge", GITHUB_REPOSITORY: "acme/infra", GITHUB_RUN_ID: "9", GITHUB_BASE_REF: "",
      });
      expect(r.status, r.out).toBe(0);
      // The plan job holds no token: it asked the forge nothing.
      expect(api.hits).toEqual([]);
      const handoff = JSON.parse(readFileSync(join(repo, "terragucci-report/pr-plan-note.json"), "utf-8"));
      expect(handoff).toMatchObject({ kind: "plan-note-handoff", pr: 7, head: HEAD, env: "default", state: "success", description: "3 roots, 2 groups, 2 destroys", marker: "roots=app,cache,network" });
      const posted = await postNote(repo, api.url, env);
      expect(posted.status, posted.out).toBe(0);
      const statuses = api.hits.filter((h) => h.url.includes("/statuses/"));
      expect(statuses.map((h) => [h.url, h.body.context, h.body.state, h.body.description])).toEqual([[`/repos/acme/infra/statuses/${HEAD}`, "terragucci/plan", "success", "3 roots, 2 groups, 2 destroys"]]);
      const note = api.hits.find((h) => h.method === "POST" && h.url === "/repos/acme/infra/issues/7/comments")!;
      const lines = note.body.body.split("\n");
      expect(lines[0]).toBe("<!-- chant-pr:default -->");
      expect(lines[1]).toBe("<!-- terragucci:plan roots=app,cache,network -->");
      // The note is terragucci's, rendered by chant from the same data and words as note.md.
      expect(note.body.body).toContain(readFileSync(join(repo, "terragucci-report/note.md"), "utf-8").split("\n").find((l) => l.startsWith("### terragucci"))!);
      // With no reports.url, the report is only in the run's artifact: links go to the run page, with no anchors.
      expect(note.body.body).toContain("[`cache: aws_db_instance.main`](http://forge/acme/infra/actions/runs/9) (destroy)");
      expect(note.body.body).toContain("is `report.html` in the `terragucci-report` artifact of [this run](http://forge/acme/infra/actions/runs/9)");
      expect(note.body.body).not.toContain("runs/9#");
      const report = JSON.parse(readFileSync(join(repo, "terragucci-report/report.json"), "utf-8"));
      expect(report.run).toMatchObject({ commit: HEAD, project: "forge/acme/infra", binary: "tofu" });
      expect(report.roots.map((x: { path: string }) => x.path)).toEqual(["network", "app", "cache"].sort());
      expect(readFileSync(join(repo, "terragucci-report/roots/cache/plan.txt"), "utf-8")).toBe("plan text of cache\n");
    } finally {
      api.close();
    }
  });

  it("gitlab: the plan job holds no forge token, and chant's plan-note job posts from the plan notes pipeline", () => {
    const doc = body(render("gitlab"));
    expect(doc.plan.variables.TG_TOKEN).toBeUndefined();
    expect(Object.values(doc.plan.variables)).not.toContain("$GITLAB_TOKEN");
    expect(doc.plan.script.join("\n")).not.toMatch(/tg (note|status)/);
    expect(doc.plan.script.join("\n")).toContain("unset TG_TOKEN TG_MERGE_TOKEN GITLAB_TOKEN");
    expect(doc["plan-note"].rules).toEqual([{ if: '$CI_PIPELINE_SOURCE =~ /^(schedule|web|api|trigger)$/ && $CHANT_PLAN_NOTES == "1" && $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH' }]);
    expect(doc["plan-note"].script.at(-1)).toBe("npx --no-install terragucci components pr-post --open --env default --output terragucci-report --forge gitlab --context terragucci/plan");
    expect(body(renderPipeline({ forge: "gitlab", binary: "tofu", version: "1.13.1", image: "img:1", layers, env: {}, tokenEnv: "FORGE_TOKEN" }).content)["plan-note"].variables.CHANT_GITLAB_TOKEN).toBe("$FORGE_TOKEN");
    // The check holds no token of its own and drops the ones GitLab hands it; chant's commit job pushes the formatting (chant#4749).
    expect(doc.check.variables.TG_TOKEN).toBeUndefined();
    expect(doc.check.script.join("\n").split("\n")[0]).toBe(`unset ${["TG_TOKEN", "TG_MERGE_TOKEN", ...FORGE_TOKEN_VARS].join(" ")}`);
    expect(doc.check.after_script).toBeUndefined();
    expect(doc.fmt).toMatchObject({ stage: "check", needs: [{ job: "check", artifacts: true }] });
    expect(doc["fmt-push"].script.join("\n")).toContain('export CHANT_GITLAB_TOKEN="$GITLAB_TOKEN"');
    expect(doc.comments).toBeUndefined();
  });

  it("gitlab.token: protected: no branch pipeline holds the token, and it no longer needs comments to post the plan notes", () => {
    const strict = (extra: Record<string, unknown> = {}) => renderPipeline({ forge: "gitlab", binary: "tofu", version: "1.13.1", image: "img:1", layers, env: {}, gitlabToken: "protected", ...extra }).content;
    const doc = body(strict());
    expect(doc.plan.variables.TG_TOKEN).toBeUndefined();
    // A branch's pipeline is the branch's own too: the check job gets no token and commits no formatting.
    expect(doc.check.variables.TG_TOKEN).toBeUndefined();
    expect(doc.fmt).toBeUndefined();
    expect(doc["plan-note"]).toBeDefined();
    expect(body(strict({ comments: "*/5 * * * *" })).comments.script.join("\n")).not.toContain("--plan-notes");
  });

  it("a root that fails to plan fails the plan and hands off a failure, in the step's own shell", async () => {
    const { repo, env } = await planRepo();
    const r = await runStep(`cd ${JSON.stringify(repo)}\n${planVerbScript("tofu", [["network"], ["app", "cache"]], "github")}`, {
      ...env, FAIL: "app", TG_SHA: HEAD, TG_PR: "7", GITHUB_SERVER_URL: "http://forge", GITHUB_REPOSITORY: "o/r", GITHUB_RUN_ID: "1",
    });
    expect(r.status).toBe(1);
    const handoff = JSON.parse(readFileSync(join(repo, "terragucci-report/pr-plan-note.json"), "utf-8"));
    expect(handoff).toMatchObject({ state: "failure", description: "1 failed: 3 roots, 2 groups, 2 destroys" });
    expect(JSON.stringify(handoff.note.named)).toContain("refused");
  });

  it("the plan verb runs in its own bash and turns off -e, since it reads the stage's exit code", () => {
    for (const forge of FORGES) expect(planVerbScript("tofu", layers, forge).split("\n").slice(0, 2)).toEqual(["bash <<'PLAN' || exit $?", READS_EXIT]);
    expect(planVerbScript("tofu", layers, "github", { terragrunt: { prelude: "true" } }).split("\n")[1]).toBe(READS_EXIT);
    expect(body(render("gitlab")).plan.script.join("\n")).toContain(`bash <<'PLAN' || exit $?\n${READS_EXIT}\n`);
  });

  it("names the stage's roots, binary and bucket, so it plans what the pipeline names", () => {
    const s = planVerbScript("tofu", layers, "github", { reports: { bucket: "s3://r", endpoint: "http://minio:9000", prefix: "p" }, canary: ["network"] });
    expect(s).toContain("terragucci stage tf-plan --out terragucci-report --binary tofu --layers 'network;app,cache'");
    expect(s).toContain("--canary 'network' --bucket 's3://r' --bucket-endpoint 'http://minio:9000' --bucket-prefix 'p'");
    expect(s).not.toContain("--bucket-url");
    expect(s).toContain('terragucci plan-handoff --report terragucci-report --env default --exit "$rc"');
  });

  it("passes the bucket's address when reports.url is set, so the note links the bucket's copy (#131)", () => {
    const reports = { bucket: "s3://r", prefix: "p", url: "https://reports.example" };
    expect(planVerbScript("tofu", layers, "forgejo", { reports })).toContain("--bucket-prefix 'p' --bucket-url 'https://reports.example'");
    expect(driftScript("tofu", layers, "github", undefined, { reports })).toContain("--bucket-url 'https://reports.example'");
  });

  it.each(FORGES)("%s: the run keeps the plan report as its artifact", (forge) => {
    const doc = body(render(forge));
    if (forge === "gitlab") {
      // chant's plan job, with terragucci's report and the merge request widget's terraform report (chant issue 5004).
      expect(doc.plan.artifacts).toEqual({ name: "terragucci-report", when: "always", paths: ["terragucci-report"], reports: { terraform: "terragucci-report/gitlab-terraform.json" } });
      expect(doc.plan.script.join("\n")).toContain('--report-url "$CI_JOB_URL/artifacts/file/terragucci-report/report.html"');
    } else {
      // The plan job hands the report on, and the plan-note job keeps it.
      const keep = doc.jobs["plan-note"].steps.find((s: { name?: string }) => s.name === "Keep the plan report");
      expect(keep.if).toBe("always()");
      expect(keep.uses).toBe(forgeRef(forge, uploadArtifact(forge)));
      expect(keep.with).toMatchObject({ name: "terragucci-report", path: "terragucci-report" });
      expect(JSON.stringify(doc.jobs.plan.steps)).not.toContain("upload-artifact");
    }
  });

  it.each(FORGES)("%s: each apply job keeps the wave's report with the job", (forge) => {
    const doc = body(render(forge));
    const name = Object.keys(forge === "gitlab" ? doc : doc.jobs).find((k) => k.startsWith("apply-wave"))!;
    if (forge === "gitlab") {
      expect(doc[name].artifacts).toMatchObject({ name: `terragucci-report-${name}`, when: "always", paths: expect.arrayContaining(["terragucci-report/"]) });
    } else {
      const keep = doc.jobs[name].steps.find((s: { name?: string }) => s.name === "Keep the apply report");
      expect(keep.if).toBe("always()");
      expect(keep.uses).toBe(forgeRef(forge, uploadArtifact(forge)));
      expect(keep.with).toMatchObject({ name: `terragucci-report-${name}`, path: "terragucci-report/" });
    }
  });

  it("the stage plans without taking the state lock, so a pull request never blocks an apply", () => {
    expect(readFileSync(join(import.meta.dirname, "../src/report/stage.ts"), "utf-8")).toContain('"-lock=false"');
  });
});

// The stale marking of plan notes and the terragucci/apply status are chant's jobs beside the waves (stale-notes, the status jobs).
describe("stale plan notes and the apply status", () => {
  it.each(["github", "forgejo"] as const)("%s: a push to the default branch marks stale notes in chant's stale-notes job, and each wave's status job posts terragucci/apply", (forge) => {
    const doc = body(render(forge));
    const stale = doc.jobs["stale-notes"];
    expect(stale.if).toContain("github.event_name == 'push'");
    expect(stale.steps.at(-1).run).toBe(`npx --no-install terragucci components pr-post --stale --tip "$TIP_SHA" --env default --forge ${forge} --context terragucci/plan --preview-comment`);
    expect(doc.jobs["apply-wave-1-status"].needs).toEqual(["apply-wave-1"]);
    expect(doc.jobs["apply-wave-1-status"].steps.at(-1).run).toBe(`terragucci run wave --op tf-apply --wave 1 --of 2 --apply-status terragucci/apply --at "$GITHUB_SHA" --forge ${forge}`);
    expect(doc.jobs["apply-done"].needs).toEqual(["apply-wave-2"]);
    expect(doc.jobs["apply-done"].steps.at(-1).run).toContain("--wave 2 --of 2 --apply-status terragucci/apply");
  });
});

describe("a GitLab job in the runner's own shell", () => {
  it("the runner's eval turns a failed command's code into 1, and the heredoc's `exit` keeps it", async () => {
    expect((await runJob(["bash <<'X'\nexit 3\nX"], {})).status).toBe(1);
    expect((await runJob(["bash <<'X' || exit $?\nexit 3\nX"], {})).status).toBe(3);
    expect((await runJob(["bash <<'X' || exit $?\nexit 0\nX", "echo after"], {})).out).toContain("after");
  });

  it("names the job's own pipeline on a status of the job's commit, and no pipeline on another commit", async () => {
    const api = await stubApi(() => ({}));
    // tg status runs `terragucci post`, which the job image carries on the path.
    const bin = tmp("tg-status-bin-");
    await terragucciBin(bin);
    try {
      const post = (sha: string) => runStep(`${forgeApi("gitlab")}\ntg status terragucci/apply pending applying`, { PATH: `${bin}:${process.env.PATH}`, TG_TOKEN: "t", TG_SHA: sha, CI_COMMIT_SHA: "s", CI_PIPELINE_ID: "102", CI_API_V4_URL: api.url, CI_PROJECT_ID: "9", CI_PIPELINE_URL: "http://gitlab/p/102" });
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

describe("a Terragrunt wave", () => {
  it("a Terragrunt repo gets one apply job per wave, each running chant's wave with the spec, after the Terragrunt prelude", () => {
    const doc = body(renderPipeline({ forge: "forgejo", binary: "tofu", version: "1.13.1", image: "img:1", layers: [["live/dev/a"], ["live/prod/a", "live/prod/b"]], env: {}, gate: "always", terragrunt: { version: "0.99.0", parallelism: 4, exclude: [], installs: [] } }).content);
    expect(Object.keys(doc.jobs).filter((j) => /^apply-wave-\d+$/.test(j))).toEqual(["apply-wave-1", "apply-wave-2"]);
    expect(doc.jobs["apply-wave-2"].needs).toEqual(["apply-wave-1"]);
    const run = (j: string): string => doc.jobs[j].steps.map((st: { run?: string }) => st.run ?? "").join("\n");
    expect(run("apply-wave-1")).toContain("terragucci run wave --spec .chant/op-waves/tf-apply.spec.json --wave 1 --render-spec");
    expect(run("apply-wave-2")).toContain("terragucci run wave --spec .chant/op-waves/tf-apply.spec.json --wave 2 --render-spec");
    expect(run("apply-wave-1")).toContain('TG_DOWNLOAD_DIR="$PWD/.terragrunt-cache/sources"');
    expect(run("apply-wave-1")).not.toContain("-auto-approve");
    // A waiting wave records its plan on chant/lifecycle. Forgejo ignores permissions:, so GitHub's job carries them.
    const gh = body(renderPipeline({ forge: "github", binary: "tofu", version: "1.13.1", image: "img:1", layers: [["live/dev/a"], ["live/prod/a", "live/prod/b"]], env: {}, gate: "always", terragrunt: { version: "0.99.0", parallelism: 4, exclude: [], installs: [] } }).content);
    expect(gh.jobs["apply-wave-1"].permissions.contents).toBe("write");
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

  // Which roots a branch applies is the spec's (terragucci waves-spec reads apply.branches at base); the jobs run on its branches.
  it.each(["github", "forgejo"] as const)("%s: the waves run on the default branch and on release, and the job guard admits both", (forge) => {
    const doc = body(pipeline(forge));
    const refs = "(github.ref == format('refs/heads/{0}', github.event.repository.default_branch) || github.ref == 'refs/heads/release')";
    for (const j of ["apply-wave-1", "apply-wave-2"]) {
      expect(doc.jobs[j].if, j).toContain(`github.event_name == 'push' && (${refs})`);
      expect(JSON.parse(doc.jobs[j].steps[0].env.CHANT_JOB_GUARD)).toMatchObject({ branches: ["release"], defaultBranch: true });
    }
    // Tips, publish and the like stay on the default branch.
    expect(doc.jobs.check.if).toBe("github.event_name == 'push' || (github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name != github.repository)");
  });

  it("on GitLab the apply jobs run on release too", () => {
    const doc = body(pipeline("gitlab"));
    const rules = doc["apply-wave-1"].rules.map((r: { if: string }) => r.if);
    expect(rules).toHaveLength(2);
    expect(rules[0]).toContain("$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH");
    expect(rules[1]).toContain('$CI_COMMIT_BRANCH == "release"');
  });

  it("in a Terragrunt repo the waves run on release as well, so a branch applies its units", () => {
    const doc = body(pipeline("forgejo", { terragrunt: { version: "0.99.0", parallelism: 4, exclude: [], installs: [] } }));
    expect(doc.jobs["apply-wave-1"].if).toContain("github.ref == 'refs/heads/release'");
    expect(validateConfig({ terragrunt: { version: "1.1.6" }, apply: { branches: { release: ["live/prod/*"] } } }, "t")).toEqual({ terragrunt: { version: "1.1.6" }, apply: { branches: { release: ["live/prod/*"] } } });
  });

  it("renders as before without the map, and is refused with apply.when: pull-request", () => {
    for (const forge of FORGES) {
      expect(pipeline(forge, { applyBranches: undefined })).not.toContain("refs/heads/release");
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

  it.each(["github", "forgejo"] as const)("%s: the wave's own job decides, its shares apply side by side, and the last wave's status job posts the success", (forge) => {
    const doc = pipeline(forge);
    const names = Object.keys(doc.jobs).filter((j) => /^apply-(wave|done)/.test(j));
    expect(names).toEqual(["apply-wave-1", "apply-wave-2", "apply-wave-2-share-1", "apply-wave-2-share-2", "apply-wave-1-status", "apply-done"]);
    expect(doc.jobs["apply-wave-2"].needs).toEqual(["apply-wave-1"]);
    expect(doc.jobs["apply-wave-2-share-1"].needs).toEqual(["apply-wave-2"]);
    expect(doc.jobs["apply-done"].needs).toEqual(["apply-wave-2", "apply-wave-2-share-1", "apply-wave-2-share-2"]);
    const step = (j: string): string => doc.jobs[j].steps.map((x: { run?: string }) => x.run ?? "").join("\n");
    expect(step("apply-wave-1")).not.toContain("--decide");
    expect(step("apply-wave-2")).toContain("--wave 2 --render-spec --decide");
    expect(step("apply-wave-2-share-2")).toContain("--wave 2 --render-spec --share 2");
    expect(step("apply-done")).toContain("--wave 2 --of 2 --apply-status terragucci/apply");
    for (const j of names) expect(doc.jobs[j].concurrency, j).toBeUndefined();
    if (forge === "github") {
      for (const j of ["apply-wave-1", "apply-wave-2", "apply-wave-2-share-1", "apply-wave-2-share-2"]) expect(doc.jobs[j].permissions.contents, j).toBe("write");
      expect(doc.jobs["apply-done"].permissions).toEqual({ contents: "read", statuses: "write" });
    }
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
    expect(Object.keys(doc.jobs).filter((j) => /^apply-wave-\d+(-share-\d+)?$|^apply-done$/.test(j))).toEqual(["apply-wave-1", "apply-wave-1-share-1", "apply-wave-1-share-2", "apply-wave-2", "apply-wave-2-share-1", "apply-wave-2-share-2", "apply-wave-2-share-3", "apply-done"]);
    expect(doc.jobs["apply-wave-2"].needs).toEqual(["apply-wave-1-share-1", "apply-wave-1-share-2"]);
  });

  it.each(["github", "forgejo"] as const)("%s: a Terragrunt wave splits the same way", (forge) => {
    const tg = { version: "0.99.0", parallelism: 4, exclude: [], installs: [] };
    const doc = pipeline(forge, { layers: [["live/net"], ["live/a", "live/b", "live/c"]], terragrunt: tg });
    const names = Object.keys(doc.jobs).filter((j) => /^apply-wave-\d+(-share-\d+)?$/.test(j));
    expect(names).toEqual(["apply-wave-1", "apply-wave-2", "apply-wave-2-share-1", "apply-wave-2-share-2"]);
    const step = (j: string): string => doc.jobs[j].steps.map((x: { run?: string }) => x.run ?? "").join("\n");
    expect(step("apply-wave-2")).toContain("--wave 2 --render-spec --decide");
    expect(step("apply-wave-2-share-1")).toContain("--wave 2 --render-spec --share 1");
  });

  it("on GitLab: the wave's job decides, the shares need it, and no apply job holds a resource group", () => {
    const doc = parseYAML(renderPipeline({ forge: "gitlab", binary: "tofu", version: "1.13.1", image: "img:1", layers: wide, env: {}, waveJobs: 2 }).content) as any;
    const applies = Object.keys(doc).filter((k) => k.startsWith("apply-"));
    expect(applies).toEqual(["apply-wave-1", "apply-wave-2", "apply-wave-2-share-1", "apply-wave-2-share-2", "apply-wave-1-status", "apply-done"]);
    for (const k of applies) expect(doc[k].resource_group, k).toBeUndefined();
    expect(doc["apply-wave-2"].script.join("\n")).toContain("--wave 2 --render-spec --decide");
    expect(doc["apply-wave-2-share-1"].script.join("\n")).toContain("--wave 2 --render-spec --share 1");
    expect(JSON.stringify(doc["apply-wave-2-share-1"].needs)).toContain("apply-wave-2");
    // `tg alive` asks GitLab for the pipeline.
    expect(forgeApi("gitlab")).toContain('repo + "/pipelines/" + a[0]');
    expect(forgeApi("forgejo")).toContain('repo + "/actions/runs/" + a[0]');
  });

  it("is refused with apply.when: pull-request, by config check and by init", () => {
    expect(() => renderPipeline({ forge: "forgejo", binary: "tofu", version: "1.13.1", image: "img:1", layers: wide, env: {}, waveJobs: 2, applyWhen: "pull-request" })).toThrow(/waves\.jobs: apply\.when: pull-request/);
    expect(() => validateConfig({ waves: { jobs: 0 } }, "t")).toThrow("config.waves.jobs must be a whole number of 1 or more");
    expect(() => validateConfig({ waves: { jobs: 1.5 } }, "t")).toThrow("config.waves.jobs must be a whole number of 1 or more");
    expect(validateConfig({ forge: "gitlab", waves: { jobs: 3 } }, "t")).toEqual({ forge: "gitlab", waves: { jobs: 3 } });
    expect(() => validateConfig({ apply: { when: "pull-request" }, waves: { jobs: 3 } }, "t")).toThrow("config.waves.jobs: apply.when: pull-request");
    expect(validateConfig({ terragrunt: { version: "1.1.6" }, waves: { jobs: 3 } }, "t")).toEqual({ terragrunt: { version: "1.1.6" }, waves: { jobs: 3 } });
    expect(() => validateConfig({ terragrunt: { version: "1.1.6" }, roots: ["live/*"] }, "t")).toThrow("config.roots: a Terragrunt repo's units are the ones terragrunt find lists, so remove roots and leave units out with terragrunt.exclude");
    expect(validateConfig({ waves: { jobs: 3, canary: ["dev/*"] } }, "t")).toEqual({ waves: { jobs: 3, canary: ["dev/*"] } });
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
    expect(doc.on.schedule).toEqual([{ cron: "*/15 * * * *" }]);
    expect(Object.keys(doc.on.workflow_dispatch.inputs)).toEqual(["module", "version"]);
    expect(Object.keys(doc.jobs)).toEqual(["rollout"]);
    expect(doc.jobs.rollout.env.TG_TOKEN).toBe("${{ github.token }}");
    const run = doc.jobs.rollout.steps.map((s: any) => s.run).filter(Boolean).join("\n");
    expect(run).toContain(`export ${forge === "github" ? "GITHUB_TOKEN" : "FORGEJO_TOKEN"}="$TG_TOKEN"`);
    expect(run).toContain("terragucci respond rollout --mode apply");
    expect(run).not.toContain("|| true");
  });

  it.each(["github", "forgejo"] as const)("%s: the rollout workflow's dispatch takes module and version, and starts that rollout (golden)", (forge) => {
    const rollout = renderPipeline({ forge, ...input, rollouts: "*/15 * * * *" }).extra!.find((f) => f.path === `.${forge}/workflows/terragucci-rollout.yml`)!;
    const doc = body(rollout.content);
    expect(doc.name).toBe("terragucci-rollout");
    expect(doc.on.workflow_dispatch.inputs).toEqual({
      module: { description: expect.any(String), required: false, type: "string" },
      version: { description: expect.any(String), required: false, type: "string" },
    });
    expect(doc.jobs.rollout.env).toMatchObject({ TG_MODULE: "${{ github.event.inputs.module }}", TG_VERSION: "${{ github.event.inputs.version }}" });
    const run = doc.jobs.rollout.steps.map((s: any) => s.run).filter(Boolean).join("\n");
    expect(run).toContain('terragucci rollout "$@" --mode apply || code=$?');
    const path = join(__dirname, "golden", `rollout-${forge}.yml`);
    if (process.env.UPDATE_GOLDEN || !existsSync(path)) writeFileSync(path, rollout.content);
    expect(rollout.content).toBe(readFileSync(path, "utf-8"));
  });

  it("github: with token_env the job opens the wave and pushes its branch with that secret, so the wave's pull request is planned", () => {
    const doc = body(renderPipeline({ forge: "github", ...input, rollouts: "*/15 * * * *", tokenEnv: "ROLLOUT_TOKEN" }).extra![0]!.content);
    expect(doc.jobs.rollout.env.TG_TOKEN).toBe("${{ secrets.ROLLOUT_TOKEN }}");
    expect(doc.jobs.rollout.steps[0].with).toEqual({ "fetch-depth": 0, token: "${{ secrets.ROLLOUT_TOKEN }}" });
    expect(doc.jobs.rollout.permissions).toEqual({ contents: "write", "pull-requests": "write", statuses: "read", checks: "read" });
    expect(doc.jobs.rollout.steps.map((s: any) => s.run).join("\n")).toContain('export ROLLOUT_TOKEN="$TG_TOKEN"');
  });

  it("gitlab: the rollouts schedule runs the rollout job, and drift leaves that schedule's pipelines alone", () => {
    const out = renderPipeline({ forge: "gitlab", ...input, rollouts: "*/15 * * * *", drift: "0 6 * * *" });
    const doc = body(out.content);
    expect(doc.rollout.rules).toEqual([{ if: '$CI_PIPELINE_SOURCE == "schedule" && $TERRAGUCCI_SCHEDULE == "rollouts"' }]);
    expect(doc.rollout.script.join("\n")).toContain("terragucci respond rollout --mode apply");
    expect(doc.rollout.variables.GIT_DEPTH).toBe("0");
    expect(driftOp(out, "gitlab")!.job.rules).toEqual([{ if: '$CI_PIPELINE_SOURCE == "schedule" && $TERRAGUCCI_SCHEDULE != "comments" && $TERRAGUCCI_SCHEDULE != "resume" && $TERRAGUCCI_SCHEDULE != "rollouts" && $TERRAGUCCI_SCHEDULE != "ephemeral" && $TERRAGUCCI_SCHEDULE != "plan-notes" && $CHANT_PLAN_NOTES == null' }]);
    expect(doc.check.rules).toEqual([{ if: '$CI_PIPELINE_SOURCE != "schedule" && $CHANT_PLAN_NOTES == null' }]);
  });

  it("gitlab: with apply.resume too, drift leaves both the resume and the rollouts schedules alone", () => {
    const out = renderPipeline({ forge: "gitlab", ...input, rollouts: "*/15 * * * *", drift: "0 6 * * *", resume: 10 });
    expect(driftOp(out, "gitlab")!.job.rules).toEqual([{ if: '$CI_PIPELINE_SOURCE == "schedule" && $TERRAGUCCI_SCHEDULE != "comments" && $TERRAGUCCI_SCHEDULE != "resume" && $TERRAGUCCI_SCHEDULE != "rollouts" && $TERRAGUCCI_SCHEDULE != "ephemeral" && $TERRAGUCCI_SCHEDULE != "plan-notes" && $CHANT_PLAN_NOTES == null' }]);
  });

  it("github: with apply.resume too, the rollout workflow sits beside the resume workflow", () => {
    const r = renderPipeline({ forge: "github", ...input, rollouts: "*/15 * * * *", resume: 10 });
    expect(r.extra!.map((f) => f.path)).toContain(".github/workflows/terragucci-rollout.yml");
    expect(r.extra!.length).toBe(2);
  });
});

describe("the drift stage", () => {
  const withDrift = (forge: ForgeName, oidc?: typeof OIDC) =>
    renderPipeline({ forge, binary: "tofu", version: "1.13.1", image: "img:1", layers, env: {}, oidc, drift: "0 6 * * *" });

  it.each(FORGES)("%s: no drift job unless drift names a schedule", (forge) => {
    expect(render(forge)).not.toContain("tf-drift");
  });

  it.each(["github", "forgejo"] as const)("%s: a scheduled run, or a manual one, runs drift's own workflow and neither push job", (forge) => {
    const out = withDrift(forge);
    const doc = body(out.content);
    // The drift job is chant's Op in a workflow of its own (terragucci#1305): the pipeline keeps no drift cron.
    expect(doc.on.schedule).toBeUndefined();
    expect(doc.jobs.drift).toBeUndefined();
    const op = driftOp(out, forge)!;
    expect(op.text).toContain("cron: '0 6 * * *'");
    expect(op.text).toContain("workflow_dispatch");
    expect(doc.jobs["apply-wave-1"].if).toContain("github.event_name == 'push'");
    expect(doc.jobs.check.if).toContain("github.event_name == 'push'");
    expect(doc.jobs.plan.if).toContain("pull_request");
    const run = op.script;
    expect(run).toContain("terragucci stage tf-drift");
    expect(run).toContain("--forge " + forge);
    // It reads; nothing in it applies. The drift response's apply mode opens a pull request.
    expect(run.replace("respond drift --mode apply", "respond drift")).not.toMatch(/\bapply\b/);
  });

  it("github: drift writes its issue and its pull request, and takes the read-only role", () => {
    const op = driftOp(withDrift("github", OIDC), "github")!;
    // chant's Op workflow asks for the scopes: the drift issue and pull request, and the OIDC token.
    for (const scope of ["contents: write", "issues: write", "pull-requests: write", "id-token: write"]) expect(op.text).toContain(scope);
    const run = op.script;
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

  it("gitlab: drift runs for scheduled pipelines other than the comments schedule's, and check and apply skip them", () => {
    const out = withDrift("gitlab");
    const doc = body(out.content);
    // The drift job is chant's Op in an included file (chant issue 4753), with terragucci's schedule rule.
    expect(out.content).toContain("include:\n  - local: .gitlab/terragucci-drift.yml\n");
    expect(doc.stages).toContain("drift");
    const op = driftOp(out, "gitlab")!;
    expect(op.job.stage).toBe("drift");
    expect(op.job.rules).toEqual([{ if: '$CI_PIPELINE_SOURCE == "schedule" && $TERRAGUCCI_SCHEDULE != "comments" && $TERRAGUCCI_SCHEDULE != "resume" && $TERRAGUCCI_SCHEDULE != "rollouts" && $TERRAGUCCI_SCHEDULE != "ephemeral" && $TERRAGUCCI_SCHEDULE != "plan-notes" && $CHANT_PLAN_NOTES == null' }]);
    expect(doc.check.rules).toEqual([{ if: '$CI_PIPELINE_SOURCE != "schedule" && $CHANT_PLAN_NOTES == null' }]);
    expect(doc["apply-wave-1"].rules[0].if).toContain('$CI_PIPELINE_SOURCE != "schedule"');
    expect(op.script).toContain("terragucci stage tf-drift");
  });
});

describe("the comments job (GitLab)", () => {
  const withComments = (extra: Partial<Parameters<typeof renderPipeline>[0]> = {}): Record<string, any> =>
    body(renderPipeline({ forge: "gitlab", binary: "tofu", version: "1.13.1", image: "img:1", layers, env: {}, comments: "*/5 * * * *", ...extra }).content);

  it("is there only when comments is set", () => {
    expect(body(render("gitlab")).comments).toBeUndefined();
    expect(render("gitlab")).not.toContain('$TERRAGUCCI_SCHEDULE == "comments"');
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
    expect(doc.check.rules).toEqual([{ if: '$CI_PIPELINE_SOURCE != "schedule" && $CHANT_PLAN_NOTES == null' }]);
    for (const job of ["tips", "publish"]) expect(doc[job].rules[0].if, job).toBe('$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH && $CI_PIPELINE_SOURCE != "schedule" && $CHANT_PLAN_NOTES == null');
    // chant's wave jobs run on a push, and in a scheduled pipeline only for the resume schedule's retries.
    for (const job of ["apply-wave-1", "apply-wave-2"]) expect(doc[job].rules[0].if, job).toBe('(($CI_PIPELINE_SOURCE != "schedule" || $TERRAGUCCI_SCHEDULE == "resume") && $CHANT_PLAN_NOTES == null) && ($CI_PIPELINE_SOURCE == "push" && $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH)');
    expect(doc.plan.rules[0].if).toContain("merge_request_event");
    const both = withComments({ drift: "0 6 * * *" });
    const op = driftOp(renderPipeline({ forge: "gitlab", binary: "tofu", version: "1.13.1", image: "img:1", layers, env: {}, comments: "*/5 * * * *", drift: "0 6 * * *" }), "gitlab")!;
    expect(op.job.rules).toEqual([{ if: '$CI_PIPELINE_SOURCE == "schedule" && $TERRAGUCCI_SCHEDULE != "comments" && $TERRAGUCCI_SCHEDULE != "resume" && $TERRAGUCCI_SCHEDULE != "rollouts" && $TERRAGUCCI_SCHEDULE != "ephemeral" && $TERRAGUCCI_SCHEDULE != "plan-notes" && $CHANT_PLAN_NOTES == null' }]);
    expect(both.comments.rules[0].if).toContain('$TERRAGUCCI_SCHEDULE == "comments"');
  });

  it.each(["github", "forgejo"] as const)("%s: refused, since a comment starts the comment jobs there", (forge) => {
    expect(() => renderPipeline({ forge, binary: "tofu", version: "1.13.1", image: "img:1", layers, env: {}, comments: "*/5 * * * *" })).toThrow(/comments is for GitLab/);
  });
});

describe("report storage keys", () => {
  const withReportsOut = (forge: ForgeName, reports: { bucket: string; role?: string }) =>
    renderPipeline({ forge, binary: "tofu", version: "1.13.1", image: "img:1", layers, env: {}, drift: "0 6 * * *", reports });
  const withReports = (forge: ForgeName, reports: { bucket: string; role?: string }): string => {
    const out = withReportsOut(forge, reports);
    return [out.content, ...(out.extra ?? []).map((f) => f.content)].join("\n");
  };
  const KEYS = ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"];

  it.each(["github", "forgejo"] as const)("%s: with a bucket and no role, the jobs that write reports map the key secrets, and no other job does", (forge) => {
    const out = withReportsOut(forge, { bucket: "s3://r" });
    const doc = body(out.content);
    const drift = driftOp(out, forge)!.job;
    for (const k of KEYS) expect(doc.jobs.plan.env[k]).toBe(`\${{ secrets.${k} }}`);
    for (const k of KEYS) expect(drift.env[k]).toBe(`\${{ secrets.${k} }}`);
    for (const job of ["check", "apply-wave-1", "apply-wave-2"]) for (const k of KEYS) expect(doc.jobs[job].env?.[k]).toBeUndefined();
  });

  it.each(["github", "forgejo"] as const)("%s: with reports.role the key secrets are not mapped", (forge) => {
    const out = withReportsOut(forge, { bucket: "s3://r", role: "arn:aws:iam::123456789012:role/terragucci-reports" });
    for (const k of KEYS) expect(body(out.content).jobs.plan.env?.[k]).toBeUndefined();
    for (const k of KEYS) expect(driftOp(out, forge)!.job.env?.[k]).toBeUndefined();
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

  const withDrift = (forge: ForgeName) =>
    renderPipeline({ forge, binary: "tofu", version: "1.13.1", image: "img:1", layers, env: {}, headersSecret: "OTLP_HEADERS", drift: "0 6 * * *", publish: true });
  const SENDERS = ["plan", "apply-wave-1", "apply-wave-2"];

  it.each(["github", "forgejo"] as const)("%s: the secret is on the jobs that send telemetry alone", (forge) => {
    const out = withDrift(forge);
    const doc = body(out.content);
    expect(doc.env?.OTEL_EXPORTER_OTLP_HEADERS).toBeUndefined();
    for (const job of SENDERS) expect(doc.jobs[job].env.OTEL_EXPORTER_OTLP_HEADERS).toBe("${{ secrets.OTLP_HEADERS }}");
    expect(driftOp(out, forge)!.job.env.OTEL_EXPORTER_OTLP_HEADERS).toBe("${{ secrets.OTLP_HEADERS }}");
    for (const job of ["check", "publish"]) expect(doc.jobs[job].env?.OTEL_EXPORTER_OTLP_HEADERS).toBeUndefined();
  });

  it("gitlab: the CI/CD variable is on the jobs that send telemetry alone", () => {
    const out = withDrift("gitlab");
    const doc = body(out.content);
    for (const job of SENDERS) expect(doc[job].variables.OTEL_EXPORTER_OTLP_HEADERS).toBe("$OTLP_HEADERS");
    expect(driftOp(out, "gitlab")!.job.variables.OTEL_EXPORTER_OTLP_HEADERS).toBe("$OTLP_HEADERS");
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
  /** The pipeline and its extra files, the drift Op's script among them. */
  const withRespond = (forge: ForgeName, respond?: Record<string, string>): string => {
    const out = renderPipeline({ forge, binary: "tofu", version: "1.13.1", image: "img:1", layers, env: {}, drift: "0 6 * * *", ...(respond ? { respond } : {}) });
    return [out.content, ...(out.extra ?? []).map((f) => f.content)].join("\n");
  };

  // apply-failed and wave-refused are the waves spec's respond, which chant's wave runner calls.
  it.each(FORGES)("%s: drift and fmt run by default", (forge) => {
    const text = withRespond(forge);
    expect(text).toContain("terragucci respond drift --mode apply");
    // fmt is chant's commit job (chant#4749): it runs terragucci fmt after a check that found formatting.
    expect(text).toContain("terragucci commit prepare");
    expect(text).toContain('"terragucci","fmt","--binary","tofu"');
  });

  it.each(FORGES)("%s: a response set to off is not in the pipeline", (forge) => {
    const text = withRespond(forge, { "apply-failed": "off", "wave-refused": "off", drift: "off", fmt: "off", tips: "off" });
    expect(text).not.toContain("terragucci respond");
    expect(text).not.toContain("terragucci commit");
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
      renderPipeline({ forge, binary: "tofu", version: "1.13.1", image: "img:1", layers, env: {}, decideTokenEnv: "JEV_API_KEY", drift: "0 6 * * *", respond });
    expect(driftOp(render({ drift: "attribute" }), forge)!.job.env.JEV_API_KEY).toBe("${{ secrets.JEV_API_KEY }}");
    expect(driftOp(render({ drift: "pull-request" }), forge)!.job.env.JEV_API_KEY).toBeUndefined();
    expect(body(render({ drift: "attribute" }).content).jobs.plan.env.JEV_API_KEY).toBeUndefined();
  });

  it.each(["github", "forgejo"] as const)("%s: the drift job installs the AWS CLI before tf-drift when drift attributes, and not otherwise", (forge) => {
    const render = (respond: Record<string, string>) =>
      renderPipeline({ forge, binary: "tofu", version: "1.13.1", image: "img:1", layers, env: {}, drift: "0 6 * * *", respond });
    // The drift Op's script installs the AWS CLI, onto its own shell's PATH, before tf-drift reads with it.
    const script = driftOp(render({ drift: "attribute" }), forge)!.script;
    // chant's install line, downloading with node (chant#4952).
    expect(script).toContain(ciToolInstallLine("aws-cli", AWS_CLI.version, { download: "node", onPath: true }));
    expect(script.indexOf("command -v aws")).toBeLessThan(script.indexOf("terragucci stage tf-drift"));
    expect(script).not.toContain("curl");
    expect(script).not.toContain("GITHUB_PATH");
    expect(driftOp(render({ drift: "pull-request" }), forge)!.script).not.toContain("command -v aws");
    expect(driftOp(render({}), forge)!.script).not.toContain("command -v aws");
    expect(body(render({ drift: "attribute" }).content).jobs.plan.steps.some((s: { name?: string }) => s.name?.startsWith("Install the AWS CLI"))).toBe(false);
  });

  it("gitlab: the drift job installs the AWS CLI before tf-drift when drift attributes, and not otherwise", () => {
    const render = (respond: Record<string, string>) =>
      renderPipeline({ forge: "gitlab", binary: "tofu", version: "1.13.1", image: "img:1", layers, env: {}, drift: "0 6 * * *", respond });
    const script = driftOp(render({ drift: "attribute" }), "gitlab")!.script;
    expect(script.indexOf("command -v aws")).toBeGreaterThanOrEqual(0);
    expect(script.indexOf("command -v aws")).toBeLessThan(script.indexOf("terragucci stage tf-drift"));
    expect(script).toContain(ciToolInstallLine("aws-cli", AWS_CLI.version, { download: "node", onPath: true }));
    expect(driftOp(render({ drift: "pull-request" }), "gitlab")!.script).not.toContain("command -v aws");
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
    // apply-done is chant's status job after the last wave.
    expect(job.needs).toBe("apply-done");
    if (forge === "github") expect(job.permissions).toEqual({ contents: "write", "pull-requests": "write" });
    else expect(job.permissions?.contents).toBeUndefined();
    expect(job.env.JEV_API_KEY).toBe("${{ secrets.JEV_API_KEY }}");
    expect(job.steps[0].with["fetch-depth"]).toBe(0);
    expect(job.steps.at(-1).run).toContain("terragucci respond version-bump --mode apply || true");
  });

  it("gitlab: the job runs from the default branch with full history", () => {
    const job = body(render("gitlab", { "version-bump": "suggest" }))["version-bump"];
    expect(job.needs).toEqual(["apply-done"]);
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
  const renderWithOut = (forge: ForgeName, oidc: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    renderPipeline({ forge, binary: "tofu", version: "1.13.1", image: "img:1", layers, env: {}, oidc, ...extra } as never);
  const renderWith = (forge: ForgeName, oidc: Record<string, unknown>, extra: Record<string, unknown> = {}): string => renderWithOut(forge, oidc, extra).content;

  it.each(FORGES)("%s: plan holds the plan service account and client, apply the apply ones, check neither", (forge) => {
    const doc = body(renderWith(forge, CLOUDS));
    const jobs = forge === "gitlab" ? doc : doc.jobs;
    const flat = (j: unknown): string => JSON.stringify(j);
    expect(flat(jobs.plan)).toContain(GCP.plan_service_account);
    expect(flat(jobs.plan)).toContain('\\"clientId\\":\\"client-plan\\"');
    expect(flat(jobs.plan)).not.toContain(GCP.apply_service_account);
    expect(flat(jobs.plan)).not.toContain("client-apply");
    expect(flat(jobs["apply-wave-1"])).toContain(GCP.apply_service_account);
    expect(flat(jobs["apply-wave-1"])).toContain('\\"clientId\\":\\"client-apply\\"');
    expect(flat(jobs["apply-wave-1"])).not.toContain(GCP.plan_service_account);
    expect(flat(jobs["apply-wave-1"])).not.toContain("client-plan");
    expect(flat(jobs.check)).not.toMatch(/CHANT_CLOUD_LOGIN|id_tokens|id-token/);
    // No AWS role is set, so the login has no AWS part.
    expect(flat(jobs.plan)).not.toContain('CHANT_CLOUD_LOGIN=\'{\\"aws\\"');
  });

  it.each(["github", "forgejo"] as const)("%s: one token request per audience, with the job's id-token permission", (forge) => {
    const text = renderWith(forge, CLOUDS);
    const doc = body(text);
    for (const j of ["plan", "replan", "apply-wave-1", "apply-wave-2"]) {
      expect(doc.jobs[j].permissions["id-token"]).toBe("write");
      if (forge === "forgejo") expect(doc.jobs[j]["enable-openid-connect"]).toBe(true);
    }
    const plan = doc.jobs.plan.steps.map((s: any) => s.run).filter(Boolean).join("\n");
    // One login, with both clouds: oidc.azure takes only the token itself, so the plan jobs log in with chant's login, which
    // the product plan runs in steps of its own before the plan step (terragucci issue 1411).
    const specs = [...plan.matchAll(new RegExp(`export ${LOGIN_SPEC_ENV}='([^']*)'`, "g"))].map((m) => JSON.parse(m[1]!));
    expect(specs).toEqual([cloudLoginSpec(loginSpec(CLOUDS, "plan", "terragucci-plan"))]);
    expect(doc.jobs.plan.steps.find((s: any) => s.name === "Trade the job's OIDC token for the plan identities")).toBeUndefined();
    // A fork's pull request still gets no plan job, and apply runs only on the default branch.
    expect(doc.jobs.plan.if).toContain("github.event.pull_request.head.repo.full_name == github.repository");
    expect(doc.jobs["apply-wave-1"].if).toContain("github.ref == format('refs/heads/{0}', github.event.repository.default_branch)");
  });

  it("gitlab: an id_token per cloud, each with its audience, on plan, apply and drift", () => {
    const out = renderWithOut("gitlab", CLOUDS, { drift: "0 6 * * *" });
    const doc = body(out.content);
    const want = { CHANT_ID_TOKEN_GCP: { aud: `https://iam.googleapis.com/${PROVIDER}` }, CHANT_ID_TOKEN_AZURE: { aud: "api://AzureADTokenExchange" } };
    for (const j of ["plan", "apply-wave-1"]) expect(doc[j].id_tokens).toEqual(want);
    expect(driftOp(out, "gitlab")!.job.id_tokens).toEqual(want);
    expect(doc.check.id_tokens).toBeUndefined();
    // chant's login reads them and unsets them in the script.
    expect(doc.plan.script.join("\n")).toContain("unset CHANT_CLOUD_LOGIN_VARS CHANT_CLOUD_LOGIN CHANT_ID_TOKEN_GCP CHANT_ID_TOKEN_AZURE");
    // Beside AWS, all three tokens.
    const all = body(renderWith("gitlab", { ...OIDC, ...CLOUDS }));
    expect(all.plan.id_tokens).toEqual({ CHANT_ID_TOKEN_AWS: { aud: "sts.amazonaws.com" }, ...want });
    expect(JSON.stringify(all.plan)).toContain(OIDC.plan_role);
  });

  it("gitlab: the Azure id_token carries oidc.azure.audience, as GitHub's and Forgejo's token request does", () => {
    const out = renderWithOut("gitlab", { azure: { ...AZURE, audience: "api://AzureADTokenExchangeUSGov" } }, { drift: "0 6 * * *" });
    const doc = body(out.content);
    for (const j of ["plan", "apply-wave-1"]) expect(doc[j].id_tokens).toEqual({ CHANT_ID_TOKEN_AZURE: { aud: "api://AzureADTokenExchangeUSGov" } });
    expect(driftOp(out, "gitlab")!.job.id_tokens).toEqual({ CHANT_ID_TOKEN_AZURE: { aud: "api://AzureADTokenExchangeUSGov" } });
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
        ...cloudLoginLines("github", CLOUDS, "plan", "terragucci-plan"),
        'cat "$GOOGLE_APPLICATION_CREDENTIALS"',
        'echo "gcp-token=$(cat "$(node -e \'console.log(JSON.parse(require("fs").readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS,"utf-8")).credential_source.file)\')")"',
        'echo "azure-token=$(cat "$ARM_OIDC_TOKEN_FILE_PATH")"',
        'echo "arm=$ARM_USE_OIDC,$ARM_CLIENT_ID,$ARM_TENANT_ID,$ARM_SUBSCRIPTION_ID"',
      ].join("\n");
      const r = await run(script, { ACTIONS_ID_TOKEN_REQUEST_URL: `${api.url}/token?api-version=2.0`, ACTIONS_ID_TOKEN_REQUEST_TOKEN: "req", RUNNER_TEMP: mkdtempSync(join(tmpdir(), "tg-login-")) });
      expect(r.status, r.out).toBe(0);
      const lines = r.out.trim().split("\n").filter((l) => !l.startsWith("chant: "));
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

  it("gitlab: the login writes each cloud's id_token to its file", async () => {
    const script = [
      ...cloudLoginLines("gitlab", CLOUDS, "apply", "terragucci-apply"),
      'node -e \'const c=JSON.parse(require("fs").readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS,"utf-8"));console.log(require("fs").readFileSync(c.credential_source.file,"utf-8"),c.service_account_impersonation_url)\'',
      'echo "$(cat "$ARM_OIDC_TOKEN_FILE_PATH") $ARM_CLIENT_ID"',
      'echo "left=${CHANT_ID_TOKEN_GCP:-none}"',
    ].join("\n");
    const r = await run(script, { CHANT_ID_TOKEN_GCP: "gcp-jwt", CHANT_ID_TOKEN_AZURE: "azure-jwt", RUNNER_TEMP: mkdtempSync(join(tmpdir(), "tg-login-")) });
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain(`gcp-jwt https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${GCP.apply_service_account}:generateAccessToken`);
    expect(r.out).toContain("azure-jwt client-apply");
    expect(r.out).toContain("left=none");
  });

  it("a runner that serves no token stops the job before it plans", async () => {
    const r = await run([...cloudLoginLines("forgejo", { gcp: GCP }, "plan", "terragucci-plan"), "echo planned"].join("\n"), { ACTIONS_ID_TOKEN_REQUEST_URL: "", RUNNER_TEMP: mkdtempSync(join(tmpdir(), "tg-login-")) });
    expect(r.status).toBe(1);
    expect(r.out).not.toContain("planned");
  });

  it("a regional token URL and a sovereign audience reach the login", () => {
    const oidc = { gcp: { ...GCP, token_url: "https://sts.europe-west3.rep.googleapis.com/v1/token" }, azure: { ...AZURE, audience: "api://AzureADTokenExchangeUSGov" } };
    const spec = loginSpec(oidc, "plan", "terragucci-plan");
    expect(spec.gcp?.stsEndpoint).toBe("https://sts.europe-west3.rep.googleapis.com/v1/token");
    expect(spec.azure?.audience).toBe("api://AzureADTokenExchangeUSGov");
    expect(loginSpec(CLOUDS, "plan", "terragucci-plan").gcp?.stsEndpoint).toBeUndefined();
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
    // The plan job holds no token; chant's note job posts the note, then terragucci/approval from the same report.
    for (const job of ["plan-note", "replan-note"]) {
      const after = doc.jobs[job].steps.at(-1);
      expect(after.name).toBe("The product's lines after the note");
      expect(after.run).toBe(`[ ! -f terragucci-report/report.json ] || TG_TOKEN="$GITHUB_TOKEN" TG_PR="$PR_NUMBER" TG_SHA="$HEAD_SHA" terragucci approval-status --forge ${forge} --report terragucci-report || true`);
    }
    expect(doc.jobs["plan-note"].steps.at(-1).env.HEAD_SHA).toBe("${{ github.event.pull_request.head.sha }}");
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
    expect(JSON.stringify(plan.env)).not.toMatch(/TG_TOKEN|github\.token/);
    const steps = plan.steps as { name?: string; uses?: string; run?: string; env?: Record<string, string>; with?: Record<string, unknown> }[];
    const checkout = steps.findIndex((s) => s.name === "Check out the change");
    // chant's plan job: the pending step and the checkout script hold the token, for the status and the fetches, and no other step.
    const holders = steps.flatMap((s, i) => (JSON.stringify(s.env ?? {}).includes("github.token") ? [i] : []));
    expect(holders).toEqual([0, checkout]);
    expect(steps[0]).toMatchObject({ name: "Say on the head that the plan started", env: { CHANT_PENDING_CONTEXT: "terragucci/plan", CHANT_PENDING_DESCRIPTION: "planning", CHANT_PENDING_SHA: "${{ github.event.pull_request.head.sha }}" } });
    expect(steps[checkout].env).toEqual({ CHANT_CHECKOUT_TOKEN: "${{ github.token }}" });
    expect(JSON.stringify(steps)).not.toContain("actions/checkout");
    const run = steps.find((s) => s.run?.includes("terragucci stage tf-plan"))!.run!;
    expect(run.split("\n")[0]).toContain("-u GITHUB_TOKEN");
    expect(run).not.toContain("tg note");
    expect(run).not.toContain("tg status");
    expect(run).toContain("terragucci plan-handoff --report terragucci-report");
    expect(steps.at(-1)!.run).toBe(run);
    if (forge === "github") expect(plan.permissions).toEqual({ contents: "read", statuses: "write", "id-token": "write" });
  });

  it.each(["github", "forgejo"] as const)("%s: the plan-note job runs after the plan, at the target branch's commit, and posts from the report", (forge) => {
    const note = body(render(forge)).jobs["plan-note"];
    expect(note.needs).toEqual(["plan"]);
    expect(note.if).toContain("needs.plan.result == 'success' || needs.plan.result == 'failure'");
    // The target branch's commit, where none of the change's code is.
    expect(note.steps[0]).toMatchObject({ name: "Check out the target branch's commit", with: { ref: "${{ github.event.pull_request.base.sha }}" } });
    const post = note.steps.find((s: { name?: string }) => s.name === "Post the plan note and terragucci/plan");
    expect(post.if).toBe("always()");
    expect(post.env).toMatchObject({ PLAN_RESULT: "${{ needs.plan.result }}", HEAD_SHA: "${{ github.event.pull_request.head.sha }}", GITHUB_TOKEN: "${{ github.token }}" });
    expect(post.run).toContain(`npx --no-install terragucci components pr-post --pr "$PR_NUMBER" --head "$HEAD_SHA" --env default --output terragucci-report --forge ${forge} --result "$PLAN_RESULT" --context terragucci/plan`);
  });

  it.each(["github", "forgejo"] as const)("%s: chant's commit job formats and commits after a check that found formatting, and the check holds no token", (forge) => {
    const doc = body(render(forge));
    // The check exits 3 for formatting and says so as its finding output; it holds no token that pushes.
    expect(doc.jobs.check.outputs.finding).toBe("${{ steps.check.outputs.finding }}");
    expect(doc.jobs.check.steps.at(-1).run).toContain(`fmt -check -recursive -diff . || exit 3`);
    expect(doc.jobs.check.steps.at(-1).run).toContain(`if [ "$code" -eq 3 ]; then echo "finding=true" >>"$GITHUB_OUTPUT"; fi`);
    expect(JSON.stringify(doc.jobs.check)).not.toContain("terragucci commit");
    // The commit job follows the check's finding, fetches the pushed commit, and runs terragucci fmt with no token.
    expect(doc.jobs.fmt.needs).toBe("check");
    expect(doc.jobs.fmt.if).toBe("always() && needs.check.outputs.finding == 'true'");
    expect(doc.jobs.fmt.env.CHANT_COMMIT_COMMAND).toBe(JSON.stringify(["terragucci", "fmt", "--binary", "tofu"]));
    expect(doc.jobs.fmt.env.CHANT_COMMIT_ALLOWED_FILES).toBe(JSON.stringify(["*.tf", "*.tofu", "*.tfvars", "*.hcl"]));
    expect(JSON.stringify(doc.jobs.fmt)).toContain("PUSHED_SHA");
    // The push job pushes with the job's own token.
    expect(doc.jobs["fmt-push"].needs).toBe("fmt");
    expect(JSON.stringify(doc.jobs["fmt-push"])).toContain("npx --no-install terragucci commit land");
    expect(body(renderPipeline({ forge, binary: "tofu", version: "1.13.1", image: "img:1", layers, env: {}, respond: { fmt: "off" } }).content).jobs.fmt).toBeUndefined();
    // A Terragrunt repo: terragucci fmt runs terragrunt hcl fmt too, after the install step.
    const tg = body(renderPipeline({ forge, binary: "tofu", version: "1.13.1", image: "img:1", layers: [["live/a"]], env: {}, terragrunt: { version: "0.99.0", parallelism: 4, exclude: [], installs: [{ tool: "terragrunt", version: "0.99.0" }] } }).content);
    expect(tg.jobs.fmt.env.CHANT_COMMIT_COMMAND).toBe(JSON.stringify(["terragucci", "fmt", "--binary", "tofu", "--terragrunt"]));
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
    writeFileSync(script, `${checkRun("forgejo", binary, tg).split("\n")[0]}\n${after} "\${CHANT_NO_FORGE_TOKEN:-}"\n`);
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
    // chant's re-plan takes the alias when TG_ATLANTIS_COMMENTS is set, and leaves `atlantis apply` to the apply-comment job.
    expect(wf.jobs.replan.if).toContain("startsWith(github.event.comment.body, 'atlantis plan')");
    expect(wf.jobs.replan.if).not.toContain("'atlantis apply'");
    expect(wf.jobs.replan.steps.find((s: any) => s.id === "decide").env.CHANT_REPLAN_GATED).toBe('[{"comment":"atlantis plan","when":"TG_ATLANTIS_COMMENTS"}]');
    expect(wf.jobs["apply-comment"].if).toBe("github.event_name == 'issue_comment' && (startsWith(github.event.comment.body, '/terragucci apply') || startsWith(github.event.comment.body, 'atlantis apply'))");
  });

  it("with apply.when: pull-request and locks: plan, the lock and plan-lock jobs take the alias too", () => {
    const wf = body(withAliases("github", { applyWhen: "pull-request", locksPlan: true }));
    expect(wf.jobs["apply-comment"].if).toContain("startsWith(github.event.comment.body, 'atlantis apply')");
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
