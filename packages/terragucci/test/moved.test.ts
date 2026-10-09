import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Fetch } from "../src/forge";
import { runStage } from "../src/report/stage";
import { respond } from "../src/respond";
import { movedProposals, reportRenames } from "../src/respond/tips";
import { repoTips } from "../src/tips";
import { appendBlocks, declaringFile, movedBlocks, renamesIn } from "../src/tips/moved";
import { bareFrom, git, tmp, write } from "./helpers";

const P = "registry.opentofu.org/hashicorp/aws";
const rc = (address: string, action: "create" | "delete", values: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
  const [type, name] = address.split(".");
  return {
    address,
    mode: "managed",
    type,
    name,
    provider_name: P,
    change: action === "delete" ? { actions: ["delete"], before: values, after: null } : { actions: ["create"], before: null, after: values, after_unknown: { id: true, arn: true }, after_sensitive: {} },
    ...(action === "delete" ? { action_reason: "delete_because_no_resource_config" } : {}),
    ...extra,
  };
};
const plan = (...changes: unknown[]) => ({ format_version: "1.2", resource_changes: changes });
const bucketBefore = (name: string) => ({ id: name, arn: `arn:aws:s3:::${name}`, bucket: name, tags: { team: "data" }, force_destroy: false });
const bucketAfter = (name: string) => ({ bucket: name, tags: { team: "data" }, force_destroy: false });

describe("renamesIn: a destroy and a create of the same configuration", () => {
  it("pairs a deleted resource with the created one whose known values all match", () => {
    expect(renamesIn("app", plan(rc("aws_s3_bucket.old", "delete", bucketBefore("logs")), rc("aws_s3_bucket.logs", "create", bucketAfter("logs"))))).toEqual([
      { root: "app", type: "aws_s3_bucket", from: "aws_s3_bucket.old", to: "aws_s3_bucket.logs" },
    ]);
  });

  it("does not pair a create whose configuration differs, or of another type or provider", () => {
    expect(renamesIn("app", plan(rc("aws_s3_bucket.old", "delete", bucketBefore("logs")), rc("aws_s3_bucket.logs", "create", { ...bucketAfter("logs"), tags: { team: "web" } })))).toEqual([]);
    expect(renamesIn("app", plan(rc("aws_s3_bucket.old", "delete", bucketBefore("logs")), rc("aws_s3_bucket.logs", "create", bucketAfter("other"))))).toEqual([]);
    expect(renamesIn("app", plan(rc("aws_s3_bucket.old", "delete", bucketBefore("logs")), { ...rc("aws_s3_bucket.logs", "create", bucketAfter("logs")), type: "aws_s3_bucket_policy" }))).toEqual([]);
    expect(renamesIn("app", plan(rc("aws_s3_bucket.old", "delete", bucketBefore("logs")), { ...rc("aws_s3_bucket.logs", "create", bucketAfter("logs")), provider_name: "registry.opentofu.org/acme/aws" }))).toEqual([]);
  });

  it("leaves out pairs that are not one to one", () => {
    const empty = (a: string, act: "create" | "delete") => rc(a, act, act === "delete" ? { id: "x", input: null } : { input: null });
    expect(renamesIn("app", plan(empty("terraform_data.a", "delete"), empty("terraform_data.b", "create"), empty("terraform_data.c", "create")))).toEqual([]);
    expect(renamesIn("app", plan(empty("terraform_data.a", "delete"), empty("terraform_data.z", "delete"), empty("terraform_data.b", "create")))).toEqual([]);
  });

  it("leaves out instances with a key, resources in a module, and deletes for another reason", () => {
    const d = rc("aws_s3_bucket.old", "delete", bucketBefore("logs"));
    const c = rc("aws_s3_bucket.logs", "create", bucketAfter("logs"));
    expect(renamesIn("app", plan({ ...d, index: 0 }, c))).toEqual([]);
    expect(renamesIn("app", plan(d, { ...c, module_address: "module.m" }))).toEqual([]);
    expect(renamesIn("app", plan({ ...d, action_reason: "delete_because_count_index" }, c))).toEqual([]);
    expect(renamesIn("app", plan({ ...d, change: { ...d.change, actions: ["delete", "create"] } }, c))).toEqual([]);
  });

  it("skips values known only after apply and sensitive ones, and compares nested values", () => {
    const d = rc("aws_db_instance.old", "delete", { id: "db", password: "s3cret", tags: { a: "1", b: "2" }, ports: [5432] });
    const c = rc("aws_db_instance.new", "create", { password: "different", tags: { a: "1", b: "2" }, ports: [5432] });
    (c.change as Record<string, unknown>).after_sensitive = { password: true };
    expect(renamesIn("app", plan(d, c))).toHaveLength(1);
    const nested = rc("aws_db_instance.new", "create", { password: "s3cret", tags: { a: "1", b: "3" }, ports: [5432] });
    expect(renamesIn("app", plan(d, nested))).toEqual([]);
    const listed = rc("aws_db_instance.new", "create", { password: "s3cret", tags: { a: "1", b: "2" }, ports: [5432, 5433] });
    expect(renamesIn("app", plan(d, listed))).toEqual([]);
  });

  it("reads nothing from a plan with no resource changes", () => {
    expect(renamesIn("app", {})).toEqual([]);
    expect(renamesIn("app", null)).toEqual([]);
  });
});

describe("the moved block", () => {
  it("is written after the block of the new address", () => {
    const dir = write(tmp(), { "a.tf": 'resource "aws_s3_bucket" "logs" {\n  bucket = "logs"\n}\n', "b.tf": 'resource "aws_s3_bucket" "other" {}\n' });
    expect(declaringFile(dir, "aws_s3_bucket.logs")).toBe("a.tf");
    expect(declaringFile(dir, "aws_s3_bucket.gone")).toBeUndefined();
    const blocks = movedBlocks([{ root: ".", type: "aws_s3_bucket", from: "aws_s3_bucket.old", to: "aws_s3_bucket.logs" }]);
    expect(blocks).toBe("moved {\n  from = aws_s3_bucket.old\n  to   = aws_s3_bucket.logs\n}\n");
    expect(appendBlocks('resource "x" "y" {}\n\n', blocks)).toBe(`resource "x" "y" {}\n\n${blocks}`);
  });

  it("is a tip on the report, unless tips are off", async () => {
    const renames = [{ root: "app", type: "aws_s3_bucket", from: "aws_s3_bucket.old", to: "aws_s3_bucket.logs" }];
    const dir = tmp();
    const tips = await repoTips(dir, ["app"], { settings: { gate: "on-destroy", tips: true }, renames });
    expect(tips).toEqual([expect.objectContaining({ rule: "terragucci-moved", root: "app", url: "https://intentius.io/terragucci/reference/tips/#terragucci-moved" })]);
    expect(tips[0]!.message).toContain("aws_s3_bucket.old is destroyed and aws_s3_bucket.logs created");
    expect(await repoTips(dir, ["app"], { settings: { gate: "on-destroy", tips: false }, renames })).toEqual([]);
  });
});

/** A forgejo answering what a pull request needs, recording what was asked. */
function forgejo() {
  const calls: { method: string; url: string; body?: string }[] = [];
  const fetch: Fetch = async (url, init) => {
    calls.push({ method: init?.method ?? "GET", url, ...(init?.body ? { body: init.body } : {}) });
    const body = url.endsWith("/repos/acme/infra") ? { default_branch: "main" } : init?.method === "POST" ? { html_url: "https://forge.test/acme/infra/pulls/9", number: 9 } : [];
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  };
  return { fetch, calls };
}

/** A tf-plan report whose app root's plan renames terraform_data.old to terraform_data.new. */
function writeReport(dir: string, renamed = true) {
  const report = join(dir, "terragucci-report");
  mkdirSync(join(report, "roots", "app"), { recursive: true });
  writeFileSync(join(report, "report.json"), JSON.stringify({ roots: [{ path: "app", status: "planned", plan: { json: "roots/app/plan.json" } }, { path: "web", status: "failed", plan: {} }] }));
  const changes = renamed
    ? [rc("terraform_data.old", "delete", { id: "1", input: "hello", output: "hello", triggers_replace: null }), { ...rc("terraform_data.new", "create", { input: "hello", triggers_replace: null }), change: { actions: ["create"], before: null, after: { input: "hello", triggers_replace: null }, after_unknown: { id: true, output: true }, after_sensitive: {} } }]
    : [];
  writeFileSync(join(report, "roots", "app", "plan.json"), JSON.stringify(plan(...changes)));
  return report;
}

describe("respond tips --report: the moved block's pull request", () => {
  const files = { "terragucci.yml": "forge: forgejo\nurl: https://forge.test/acme/infra\ntoken_env: FORGE_TOKEN\n", "app/main.tf": 'resource "terraform_data" "old" {\n  input = "hello"\n}\n' };

  it("reads the renames from the report's plans", () => {
    const dir = tmp();
    writeReport(dir);
    expect(reportRenames(join(dir, "terragucci-report"))).toEqual([{ root: "app", type: "terraform_data", from: "terraform_data.old", to: "terraform_data.new" }]);
    expect(() => reportRenames(join(dir, "nowhere"))).toThrow(/no report/);
  });

  it("names the file and the branch it goes into on a dry run", () => {
    const dir = write(tmp(), { "app/main.tf": 'resource "terraform_data" "new" {}\n' });
    const [p] = movedProposals(dir, [{ root: "app", type: "terraform_data", from: "terraform_data.old", to: "terraform_data.new" }], "rename");
    expect(p).toMatchObject({ branch: "terragucci/tip/moved-app", base: "rename", expect: ["app/main.tf"] });
    expect(p!.title).toBe("Move terraform_data.old to terraform_data.new in app instead of replacing it");
  });

  it("opens a pull request into the renaming branch that adds the moved block", async () => {
    const bare = bareFrom(write(tmp(), files));
    const repo = tmp();
    git(repo, "clone", "-q", bare, ".");
    git(repo, "checkout", "-q", "-b", "rename");
    writeFileSync(join(repo, "app/main.tf"), 'resource "terraform_data" "new" {\n  input = "hello"\n}\n');
    git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-qam", "rename");
    git(repo, "push", "-q", "origin", "rename");
    writeReport(repo);
    const forge = forgejo();
    const r = await respond("tips", repo, { report: "terragucci-report", branch: "rename", mode: "apply", fetch: forge.fetch, env: { FORGE_TOKEN: "t" } });
    expect(r.proposals).toEqual([expect.objectContaining({ branch: "terragucci/tip/moved-app", state: "opened", files: ["app/main.tf"] })]);
    const pushed = git(bare, "show", "terragucci/tip/moved-app:app/main.tf");
    expect(pushed).toBe('resource "terraform_data" "new" {\n  input = "hello"\n}\n\nmoved {\n  from = terraform_data.old\n  to   = terraform_data.new\n}\n');
    expect(git(bare, "rev-parse", "terragucci/tip/moved-app^").trim()).toBe(git(bare, "rev-parse", "rename").trim());
    const pr = forge.calls.find((c) => c.method === "POST")!;
    expect(JSON.parse(pr.body!)).toMatchObject({ head: "terragucci/tip/moved-app", base: "rename" });
    // Only the plan's tip: no pin, lock file or canary pull request from the default branch.
    expect(r.proposals).toHaveLength(1);
  });

  it("opens nothing when the plans rename nothing, or when tips respond off", async () => {
    const dir = write(tmp(), files);
    writeReport(dir, false);
    expect((await respond("tips", dir, { report: "terragucci-report" })).text).toBe("no tip to fix");
    writeFileSync(join(dir, "terragucci.yml"), "respond:\n  tips: off\n");
    writeReport(dir);
    expect((await respond("tips", dir, { report: "terragucci-report" })).skipped).toBe("respond.tips is off");
  });
});

describe("stage tf-plan: the rename tip", () => {
  /** A tofu that shows the plan each root's directory holds. */
  function fakeTofu(dir: string): string {
    const path = join(dir, "tofu");
    writeFileSync(path, `#!/bin/sh
chdir="\${1#-chdir=}"; shift
case "$1" in
  init) exit 0 ;;
  plan) for a in "$@"; do case "$a" in -out=*) : > "\${a#-out=}" ;; esac; done; exit 0 ;;
  show) if [ "$2" = "-json" ]; then cat "$chdir/plan.json"; else echo "plan text"; fi ;;
esac
`);
    chmodSync(path, 0o755);
    return path;
  }
  const renamed = plan(rc("aws_s3_bucket.old", "delete", bucketBefore("logs")), rc("aws_s3_bucket.logs", "create", bucketAfter("logs")));

  it("names the rename on the report, and tips: false leaves it out", { timeout: 60_000 }, async () => {
    for (const tips of [true, false]) {
      const repo = write(tmp(), { "terragucci.yml": `roots: ["app"]\ntips: ${tips}\n`, "app/main.tf": "", "app/plan.json": JSON.stringify(renamed) });
      const { report } = await runStage("tf-plan", repo, { binary: fakeTofu(tmp()), env: { PATH: process.env.PATH } }, () => {});
      const moved = (report.tips ?? []).filter((t) => t.rule === "terragucci-moved");
      expect(moved.map((t) => t.root)).toEqual(tips ? ["app"] : []);
    }
  });
});
