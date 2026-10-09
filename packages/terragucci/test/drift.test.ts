// `terragucci stage tf-drift`: a refresh-only plan of every root, the report
// built from what drifted, and the one issue that tracks it. The binary is a
// script that answers with recorded `show -json` output, so no provider or
// state is needed; one test also runs the real tofu where it is installed.
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findIssue, type Fetch } from "../src/forge";
import { driftPlan, renderDriftIssue, targetFromEnv, trackDrift } from "../src/report/drift";
import { buildReport } from "../src/report/build";
import { renderHtml } from "../src/report/html";
import { renderNote } from "../src/report/views";
import { runStage } from "../src/report/stage";
import { plan, rc, RUN } from "./report-fixtures";
import { tmp, write } from "./helpers";

const queueGone = rc("module.service.aws_sqs_queue.jobs", ["delete"], { name: "shop-staging-orders-jobs", arn: "arn:aws:sqs:::x" }, null);
const tagsMoved = rc("aws_s3_bucket.logs", ["update"], { bucket: "logs", tags: { team: "a" } }, { bucket: "logs", tags: { team: "b" } });
const codeChange = rc("aws_s3_bucket.logs", ["update"], { bucket: "logs" }, { bucket: "logs", versioning: true });

const drifted = plan([codeChange], { resource_drift: [queueGone, tagsMoved] });
const clean = plan([codeChange], { resource_drift: [] });

/** A `tofu` that records its calls and shows the plan each root's directory holds. */
function fakeTofu(dir: string): string {
  const path = join(dir, "tofu");
  writeFileSync(path, `#!/bin/sh
chdir="\${1#-chdir=}"; shift
echo "$chdir $*" >> "${dir}/calls.log"
case "$1" in
  init) exit 0 ;;
  plan) for a in "$@"; do case "$a" in -out=*) : > "\${a#-out=}" ;; esac; done; exit 0 ;;
  show) if [ "$2" = "-json" ]; then cat "$chdir/plan.json"; else echo "plan text"; fi ;;
esac
`);
  chmodSync(path, 0o755);
  return path;
}

const repoWith = (plans: Record<string, unknown>) =>
  write(tmp(), {
    "terragucci.yml": 'roots: ["envs/*"]\n',
    ...Object.fromEntries(Object.entries(plans).flatMap(([name, p]) => [[`envs/${name}/main.tf`, ""], [`envs/${name}/plan.json`, JSON.stringify(p)]])),
  });

describe("driftPlan", () => {
  it("reads resource_drift as the changes, and an absent list as none", () => {
    expect((driftPlan(drifted) as { resource_changes: unknown[] }).resource_changes).toHaveLength(2);
    expect((driftPlan(plan([codeChange])) as { resource_changes: unknown[] }).resource_changes).toHaveLength(0);
  });
});

describe("terragucci stage tf-drift", () => {
  it("plans refresh-only, names the root and the queue, and ignores the code change on main", { timeout: 60_000 }, async () => {
    const bin = tmp();
    const repo = repoWith({ orders: drifted, search: clean });
    const result = await runStage("tf-drift", repo, { binary: fakeTofu(bin), env: { PATH: process.env.PATH } }, () => {});
    const calls = readFileSync(join(bin, "calls.log"), "utf-8").split("\n").filter((l) => / plan /.test(l));
    expect(calls).toHaveLength(2);
    for (const c of calls) expect(c).toContain("-refresh-only");

    const { report, dir } = result;
    expect(report.run.stage).toBe("tf-drift");
    expect(report.waves).toEqual([]);
    const orders = report.roots.find((r) => r.path === "envs/orders")!;
    const search = report.roots.find((r) => r.path === "envs/search")!;
    // The update both plans carry as a code change is not drift.
    expect(search.changes).toEqual([]);
    expect(orders.changes.map((c) => [c.address, c.action])).toEqual([["aws_s3_bucket.logs", "update"], ["module.service.aws_sqs_queue.jobs", "delete"]]);
    expect(orders.fold).toBe("open");
    expect(search.why).not.toContain("drifted");
    expect(report.named.map((n) => [n.root, n.address, n.action])).toEqual([["envs/orders", "module.service.aws_sqs_queue.jobs", "delete"]]);

    const issue = readFileSync(join(dir, "issue.md"), "utf-8");
    expect(issue).toContain("1 of 2 roots have drifted");
    expect(issue).toContain("`envs/orders`");
    expect(issue).toContain("`module.service.aws_sqs_queue.jobs` (`shop-staging-orders-jobs`): no longer exists");
    expect(issue).not.toContain("envs/search");
    expect(existsSync(join(dir, "report.html"))).toBe(true);
    expect(renderHtml(report)).toContain("deleted outside Terraform");
    expect(renderNote(report)).toContain("deleted outside Terraform");
  });

  it("names who changed each drifted attribute in the issue when respond.drift is attribute", { timeout: 60_000 }, async () => {
    const asked: { type: string; ref: string }[] = [];
    const audit = {
      lookup: async (q: { type: string; ref: string }) => {
        asked.push({ type: q.type, ref: q.ref });
        return { status: "found" as const, actor: "human" as const, who: "alice@example.com", event: "PutBucketTagging", at: "2026-10-01T09:00:00Z" };
      },
    };
    const repo = repoWith({ orders: drifted });
    writeFileSync(join(repo, "terragucci.yml"), 'roots: ["envs/*"]\nrespond:\n  drift: attribute\n');
    const result = await runStage("tf-drift", repo, { binary: fakeTofu(tmp()), env: { PATH: process.env.PATH }, audit }, () => {});
    const issue = readFileSync(join(result.dir, "issue.md"), "utf-8");
    expect(asked).toEqual([{ type: "aws_s3_bucket", ref: "logs" }]);
    expect(issue).toContain("- Who changed it:");
    expect(issue).toContain("`aws_s3_bucket.logs` `tags`: a person (audit log: PutBucketTagging by alice@example.com at 2026-10-01T09:00:00Z)");
  });

  it("asks nobody and says nothing of who when respond.drift is left at its default", { timeout: 60_000 }, async () => {
    let asked = 0;
    const audit = { lookup: async () => (asked++, { status: "silent" as const }) };
    const result = await runStage("tf-drift", repoWith({ orders: drifted }), { binary: fakeTofu(tmp()), env: { PATH: process.env.PATH }, audit }, () => {});
    expect(asked).toBe(0);
    expect(readFileSync(join(result.dir, "issue.md"), "utf-8")).not.toContain("Who changed it");
  });

  it("removes an attributions.json an earlier run left in a reused report directory", { timeout: 60_000 }, async () => {
    const audit = { lookup: async () => ({ status: "found" as const, actor: "human" as const, who: "alice@example.com", event: "PutBucketTagging", at: "2026-10-01T09:00:00Z" }) };
    const repo = repoWith({ orders: drifted });
    writeFileSync(join(repo, "terragucci.yml"), 'roots: ["envs/*"]\nrespond:\n  drift: attribute\n');
    const first = await runStage("tf-drift", repo, { binary: fakeTofu(tmp()), env: { PATH: process.env.PATH }, audit }, () => {});
    const file = join(first.dir, "attributions.json");
    expect(existsSync(file)).toBe(true);
    // Same repo and report directory, now with attribution off: the old file must not survive.
    writeFileSync(join(repo, "terragucci.yml"), 'roots: ["envs/*"]\n');
    const second = await runStage("tf-drift", repo, { binary: fakeTofu(tmp()), env: { PATH: process.env.PATH } }, () => {});
    expect(second.dir).toBe(first.dir);
    expect(existsSync(file)).toBe(false);
  });

  it("plans with -refresh-only only for tf-drift", async () => {
    const bin = tmp();
    const repo = repoWith({ a: clean });
    await runStage("tf-plan", repo, { binary: fakeTofu(bin), env: { PATH: process.env.PATH } }, () => {});
    expect(readFileSync(join(bin, "calls.log"), "utf-8")).not.toContain("-refresh-only");
  });

  it("keeps the issue through the forge when a token is in the environment", { timeout: 60_000 }, async () => {
    const requests: string[] = [];
    let stored: { body: string; number: number } | undefined;
    const forgeFetch: Fetch = async (url, init) => {
      const method = init?.method ?? "GET";
      requests.push(`${method} ${new URL(url).pathname}`);
      const body = init?.body ? JSON.parse(init.body) : undefined;
      const json = (v: unknown) => ({ ok: true, status: 200, json: async () => v, text: async () => "" });
      if (method === "GET") return json(stored ? [{ html_url: "http://f/i/1", number: 1, body: stored.body }] : []);
      if (method === "POST" && url.endsWith("/issues")) { stored = { body: body.body, number: 1 }; return json({ html_url: "http://f/i/1", number: 1 }); }
      if (method === "PATCH" && body.state === "closed") { stored = undefined; return json({}); }
      if (method === "PATCH") { stored = { body: body.body, number: 1 }; return json({}); }
      return json({});
    };
    const env = { PATH: process.env.PATH, TG_TOKEN: "t", GITHUB_REPOSITORY: "me/infra", GITHUB_SERVER_URL: "http://f", GITHUB_API_URL: "http://f/api/v1" };
    const bin = tmp();
    const opts = { binary: fakeTofu(bin), env, forge: "forgejo" as const, forgeFetch };

    const found = await runStage("tf-drift", repoWith({ orders: drifted }), opts, () => {});
    expect(found.issue).toMatchObject({ action: "opened" });
    expect(stored?.body).toContain("terragucci:drift");
    // What the jobs after it read: agent.drift runs when this run opened the issue.
    expect(JSON.parse(readFileSync(join(found.dir, "issue.json"), "utf-8"))).toEqual({ action: "opened", number: 1, url: "http://f/i/1" });
    const again = await runStage("tf-drift", repoWith({ orders: drifted }), opts, () => {});
    expect(again.issue).toMatchObject({ action: "updated" });
    expect(JSON.parse(readFileSync(join(again.dir, "issue.json"), "utf-8")).action).toBe("updated");
    const none = await runStage("tf-drift", repoWith({ orders: clean }), opts, () => {});
    expect(none.issue).toMatchObject({ action: "closed" });
    expect(stored).toBeUndefined();
    expect(requests).toContain("POST /api/v1/repos/me/infra/issues/1/comments");
    const quiet = await runStage("tf-drift", repoWith({ orders: clean }), opts, () => {});
    expect(quiet.issue).toMatchObject({ action: "none" });
    expect(quiet.failed).toBe(false);
  });

  it("leaves an open issue alone when a root cannot be planned and the rest are clean", async () => {
    const open = [{ html_url: "http://f/i/1", number: 1, body: "<!-- terragucci:drift -->\nold" }];
    const calls: string[] = [];
    const forgeFetch: Fetch = async (url, init) => {
      calls.push(`${init?.method ?? "GET"} ${new URL(url).pathname}`);
      return { ok: true, status: 200, json: async () => ((init?.method ?? "GET") === "GET" ? open : {}), text: async () => "" };
    };
    const report = buildReport({
      run: { ...RUN, stage: "tf-drift" },
      roots: [{ path: "a", plan: driftPlan(clean) }, { path: "b", error: "init failed" }],
    });
    const target = targetFromEnv("forgejo", { GITHUB_REPOSITORY: "me/infra", GITHUB_SERVER_URL: "http://f" }, "t")!;
    expect(await trackDrift(forgeFetch, target, report)).toMatchObject({ action: "left-open" });
    expect(calls).toEqual(["GET /api/v1/repos/me/infra/issues"]);
    expect(renderDriftIssue(report)).toContain("could not be planned");
  });
});

describe("findIssue", () => {
  it("asks Forgejo for issues alone, and github.com with no type, which it refuses", async () => {
    const asked: string[] = [];
    const forgeFetch: Fetch = async (url) => {
      asked.push(new URL(url).search);
      return { ok: true, status: 200, json: async () => [{ html_url: "http://f/pull/2", number: 2, body: "<!-- m -->", pull_request: {} }, { html_url: "http://f/i/1", number: 1, body: "<!-- m -->" }], text: async () => "" };
    };
    for (const forge of ["github", "forgejo"] as const) {
      const target = targetFromEnv(forge, { GITHUB_REPOSITORY: "me/infra", GITHUB_SERVER_URL: "https://github.com" }, "t")!;
      expect(await findIssue(forgeFetch, target, "<!-- m -->")).toMatchObject({ number: 1 });
    }
    expect(asked).toEqual(["?state=open&per_page=100", "?state=open&type=issues&per_page=100"]);
  });
});

const TOFU = spawnSync("tofu", ["version"]).status === 0;
describe.skipIf(!TOFU)("tf-drift with tofu", () => {
  it("does not report code waiting on main as drift", { timeout: 120_000 }, async () => {
    const v = (size: number) => `resource "terraform_data" "keep" {\n  input = { size = ${size} }\n}\n`;
    const repo = write(tmp(), { "terragucci.yml": 'binary: tofu\nroots: ["envs/*"]\n', "envs/a/main.tf": v(1) });
    execFileSync("tofu", [`-chdir=${join(repo, "envs/a")}`, "apply", "-auto-approve", "-input=false", "-no-color"], { stdio: "ignore", env: { ...process.env, TF_IN_AUTOMATION: "1" } });
    // A merged change the apply has not reached yet.
    write(repo, { "envs/a/main.tf": v(2) });
    const planned = await runStage("tf-plan", repo, { out: "plan-report" }, () => {});
    expect(planned.report.roots[0].counts).toMatchObject({ update: 1 });
    const result = await runStage("tf-drift", repo, { out: "drift-report", env: { PATH: process.env.PATH } }, () => {});
    expect(result.failed).toBe(false);
    expect(result.report.roots[0].changes).toEqual([]);
    expect(result.report.totals.update).toBe(0);
    expect(result.report.named).toEqual([]);
  });
});
