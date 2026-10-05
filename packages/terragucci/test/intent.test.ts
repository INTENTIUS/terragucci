/**
 * terragucci#30: a pull request whose description does not match its plan,
 * against recorded decision responses. The states in stack/fixtures/decide
 * (pr-intent-module-bump.json, pr-intent-destroy.json) are the ones the
 * example sends; the answers below are laya-serve's shape, as in
 * fixtures/decide/laya-response.json, with the noul set per case.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { validateConfig } from "../src/config";
import type { DecideFetch, DecideSettings } from "../src/decide";
import { LAYA_MODEL } from "../src/images";
import { buildReport, planFiles } from "../src/report/build";
import type { S3Fetch } from "../src/report/s3";
import { runKey, writeReportDir } from "../src/report/store";
import { respond } from "../src/respond";
import { checkDescription, intentState } from "../src/respond/intent";
import { tmp } from "./helpers";
import { plan, rc, RUN } from "./report-fixtures";

const LAYA: DecideSettings = { backend: "laya", url: "http://decide.local:8790" };

/** laya-serve answering the one question, `description`, with this probability of "the description does not match". */
function answers(noul: number): DecideFetch {
  return async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ model: LAYA_MODEL, answers: { description: { type: "noul", noul, confidence: 0.5, answer_confidence: Math.max(noul, 1 - noul) } } }),
  });
}
const unreachable: DecideFetch = async () => {
  throw new Error("connect ECONNREFUSED 127.0.0.1:8790");
};

const queue = (env: string) => rc("module.service.aws_sqs_queue.jobs", ["update"], { name: `${env}-jobs`, visibility_timeout_seconds: 30 }, { name: `${env}-jobs`, visibility_timeout_seconds: 60 });
const root = (path: string, changes: unknown[]) => ({ path, plan: plan(changes as never[]), planner: "tofu" as const, files: planFiles(path) });

/** A report directory as `stage tf-plan` writes it. */
function reportDir(kind: "module-bump" | "destroy"): string {
  const roots =
    kind === "module-bump"
      ? [root("envs/dev/email", [queue("dev")]), root("envs/staging/email", [queue("staging")])]
      : [root("envs/staging/email", [rc("module.service.aws_dynamodb_table.records[0]", ["delete"], { name: "records" }, null)])];
  const dir = join(tmp("intent-"), "terragucci-report");
  writeReportDir(dir, buildReport({ run: RUN, roots }), new Map());
  return dir;
}

const MODULE_BUMP = { title: "service module: raise the SQS visibility timeout to 60 seconds", description: "Raises visibility_timeout_seconds from 30 to 60 on the jobs queue of every service. Updates in place; nothing is destroyed or replaced." };
const RETAG = { title: "retag email", description: "Retag the staging email service. Tags only." };

const read = (dir: string, f: string): string => readFileSync(join(dir, f), "utf-8");

describe("description check: the three cases of #30", () => {
  it("a module bump described as one gets no flag, and the note is as it was", async () => {
    const dir = reportDir("module-bump");
    const before = { note: read(dir, "note.md"), html: read(dir, "report.html") };
    const r = await checkDescription({ dir, ...MODULE_BUMP, decide: LAYA, write: true, fetch: answers(0.04) });
    expect(r.record).toMatchObject({ status: "confident", flagged: false, unmentioned: [] });
    expect(read(dir, "note.md")).toBe(before.note);
    expect(read(dir, "report.html")).toBe(before.html);
  });

  it("a destroy described as 'retag email' is flagged at the top of the note and in the report, naming the destroy", async () => {
    const dir = reportDir("destroy");
    const note = read(dir, "note.md");
    const r = await checkDescription({ dir, ...RETAG, decide: LAYA, write: true, fetch: answers(0.93) });
    expect(r.record).toMatchObject({ status: "confident", flagged: true, probability: 0.93, model: LAYA_MODEL });
    expect(r.record.unmentioned).toEqual(["envs/staging/email: module.service.aws_dynamodb_table.records[0]"]);
    const after = read(dir, "note.md");
    expect(after.startsWith("> Check the description of this pull request.")).toBe(true);
    expect(after.split("\n")[0]).toContain("`envs/staging/email: module.service.aws_dynamodb_table.records[0]` (destroy)");
    // Everything the deterministic note said is still there, after the flag.
    expect(after.endsWith(note)).toBe(true);
    expect(read(dir, "report.html")).toContain('id="description-flag"');
    expect(JSON.parse(read(dir, "intent.json"))).toMatchObject({ flagged: true });
    // The report itself is untouched, so its digests and groups are.
    expect(JSON.parse(read(dir, "report.json")).change_set).toMatch(/^jcs1-sha256:[0-9a-f]{64}$/);
  });

  it("an unreachable decision service leaves the note as it was", async () => {
    const dir = reportDir("destroy");
    const before = { note: read(dir, "note.md"), html: read(dir, "report.html"), json: read(dir, "report.json") };
    const r = await checkDescription({ dir, ...RETAG, decide: LAYA, write: true, fetch: unreachable });
    expect(r.record).toMatchObject({ status: "unavailable", flagged: false });
    expect(r.text).toMatch(/^no flag: /);
    expect(read(dir, "note.md")).toBe(before.note);
    expect(read(dir, "report.html")).toBe(before.html);
    expect(read(dir, "report.json")).toBe(before.json);
  });
});

describe("description check: the other ways to no flag", () => {
  it("below the threshold, the decision is recorded and the note is unchanged", async () => {
    const dir = reportDir("destroy");
    const note = read(dir, "note.md");
    const r = await checkDescription({ dir, ...RETAG, decide: LAYA, write: true, fetch: answers(0.7) });
    expect(r.record).toMatchObject({ status: "not-confident", flagged: false });
    expect(r.record.decision).toMatch(/below the 0\.80 threshold/);
    expect(read(dir, "note.md")).toBe(note);
    expect(JSON.parse(read(dir, "intent.json")).status).toBe("not-confident");
  });

  it("with decide: unset, asks nothing and writes nothing", async () => {
    const dir = reportDir("destroy");
    let asked = 0;
    const r = await checkDescription({ dir, ...RETAG, decide: undefined, write: true, fetch: async () => (asked++, answers(0.99)("", {} as never)) });
    expect(asked).toBe(0);
    expect(r.record.status).toBe("off");
    expect(existsSync(join(dir, "intent.json"))).toBe(false);
  });

  it("a dry run reports the flag and writes nothing", async () => {
    const dir = reportDir("destroy");
    const note = read(dir, "note.md");
    const r = await checkDescription({ dir, ...RETAG, decide: LAYA, write: false, fetch: answers(0.93) });
    expect(r.record.flagged).toBe(true);
    expect(read(dir, "note.md")).toBe(note);
  });

  it("flagging twice leaves one flag", async () => {
    const dir = reportDir("destroy");
    const note = read(dir, "note.md");
    await checkDescription({ dir, ...RETAG, decide: LAYA, write: true, fetch: answers(0.93) });
    await checkDescription({ dir, ...RETAG, decide: LAYA, write: true, fetch: answers(0.95) });
    const after = read(dir, "note.md");
    expect(after.split("\n").filter((l) => l.includes("terragucci:description"))).toHaveLength(1);
    expect(after.endsWith(note)).toBe(true);
    expect(read(dir, "report.html").match(/id="description-flag"/g)).toHaveLength(1);
  });

  it("names only the destroys the text leaves out", async () => {
    const dir = join(tmp("intent-"), "terragucci-report");
    const roots = [
      root("envs/staging/email", [rc("aws_dynamodb_table.records", ["delete"], { name: "records" }, null)]),
      root("envs/staging/queue", [rc("aws_sqs_queue.jobs", ["delete", "create"], { name: "jobs" }, { name: "jobs" })]),
    ];
    writeReportDir(dir, buildReport({ run: RUN, roots }), new Map());
    const r = await checkDescription({ dir, title: "drop the records table", description: "Removes aws_dynamodb_table.records.", decide: LAYA, write: true, fetch: answers(0.9) });
    expect(r.record.unmentioned).toEqual(["envs/staging/queue: aws_sqs_queue.jobs"]);
  });
});

describe("description check: the state the model reads", () => {
  it("is the title, the description and the report's counts, destroys, replacements and groups, with no plan values", () => {
    const dir = reportDir("destroy");
    const report = JSON.parse(read(dir, "report.json"));
    const s = intentState(report, RETAG.title, RETAG.description);
    expect(s.plan.counts).toEqual({ add: 0, change: 0, destroy: 1, replace: 0 });
    expect(s.plan.destroys).toEqual(["envs/staging/email: module.service.aws_dynamodb_table.records[0]"]);
    expect(s.plan.replacements).toEqual([]);
    expect(s.plan.groups).toHaveLength(1);
    expect(JSON.stringify(s)).not.toContain('"name":"records"');
  });
});

describe("respond description", () => {
  const config = (dir: string, body: string): string => {
    const file = join(dir, "terragucci.yml");
    writeFileSync(file, body);
    return file;
  };

  it("is an event that takes check and off, and is off by default", () => {
    expect(() => validateConfig({ respond: { description: "check" } }, "terragucci.yml")).not.toThrow();
    expect(() => validateConfig({ respond: { description: "agent" } }, "terragucci.yml")).toThrow();
  });

  it("does nothing until respond.description is check", async () => {
    const dir = reportDir("destroy");
    const repo = join(dir, "..");
    const r = await respond("description", repo, { config: config(repo, "decide:\n  backend: laya\n  url: http://decide.local:8790\n"), title: RETAG.title, description: RETAG.description, decideFetch: answers(0.93) });
    expect(r.skipped).toBe("respond.description is off");
  });

  it("flags in apply mode, reading the title and description from the GitHub event file", async () => {
    const dir = reportDir("destroy");
    const repo = join(dir, "..");
    const cfg = config(repo, "respond:\n  description: check\ndecide:\n  backend: laya\n  url: http://decide.local:8790\n");
    const event = join(repo, "event.json");
    writeFileSync(event, JSON.stringify({ pull_request: { title: RETAG.title, body: RETAG.description } }));
    const r = await respond("description", repo, { config: cfg, mode: "apply", env: { GITHUB_EVENT_PATH: event }, decideFetch: answers(0.93) });
    expect(r.text).toMatch(/^> Check the description/);
    expect(read(dir, "note.md").startsWith("> Check the description")).toBe(true);
  });

  it("reads GitLab's merge request variables, and with no pull request text leaves the note alone", async () => {
    const dir = reportDir("destroy");
    const repo = join(dir, "..");
    const cfg = config(repo, "respond:\n  description: check\ndecide:\n  backend: laya\n  url: http://decide.local:8790\n");
    const none = await respond("description", repo, { config: cfg, mode: "apply", env: {}, decideFetch: answers(0.93) });
    expect(none.skipped).toMatch(/no pull request title/);
    const r = await respond("description", repo, { config: cfg, mode: "apply", env: { CI_MERGE_REQUEST_TITLE: "retag email", CI_MERGE_REQUEST_DESCRIPTION: "Tags only." }, decideFetch: answers(0.93) });
    expect((r.data as { flagged: boolean }).flagged).toBe(true);
  });

  it("copies what it changed over the bucket's copy the stage uploaded, so the bucket holds the flag too (#131)", async () => {
    const dir = reportDir("destroy");
    const repo = join(dir, "..");
    const cfg = config(repo, "respond:\n  description: check\ndecide:\n  backend: laya\n  url: http://decide.local:8790\nreports:\n  bucket: s3://acme-reports\n  endpoint: http://minio:9000\n  prefix: reports\n");
    const objects = new Map<string, string>();
    const s3Fetch: S3Fetch = async (url, init) => {
      if (init.method === "PUT") objects.set(decodeURIComponent(new URL(url).pathname.replace(/^\/acme-reports\//, "")), Buffer.from(init.body as Uint8Array).toString("utf-8"));
      return { ok: true, status: 200, text: async () => "" };
    };
    const env = { CI_MERGE_REQUEST_TITLE: RETAG.title, CI_MERGE_REQUEST_DESCRIPTION: RETAG.description, AWS_ACCESS_KEY_ID: "AK", AWS_SECRET_ACCESS_KEY: "SK" };
    const r = await respond("description", repo, { config: cfg, mode: "apply", env, decideFetch: answers(0.93), s3Fetch });
    const key = runKey(JSON.parse(read(dir, "report.json")), "reports");
    expect(r.text).toContain(`copied intent.json, note.md, report.html to the bucket under ${key}`);
    for (const f of ["note.md", "report.html", "intent.json"]) expect(objects.get(`${key}/${f}`), f).toBe(read(dir, f));
    expect(objects.get(`${key}/note.md`)!.startsWith("> Check the description")).toBe(true);
  });

  it("with no flag to write, copies nothing but the decision record", async () => {
    const dir = reportDir("module-bump");
    const repo = join(dir, "..");
    const cfg = config(repo, "respond:\n  description: check\ndecide:\n  backend: laya\n  url: http://decide.local:8790\nreports:\n  bucket: s3://acme-reports\n  endpoint: http://minio:9000\n");
    const puts: string[] = [];
    const s3Fetch: S3Fetch = async (url, init) => {
      if (init.method === "PUT") puts.push(new URL(url).pathname);
      return { ok: true, status: 200, text: async () => "" };
    };
    const env = { CI_MERGE_REQUEST_TITLE: MODULE_BUMP.title, CI_MERGE_REQUEST_DESCRIPTION: MODULE_BUMP.description, AWS_ACCESS_KEY_ID: "AK", AWS_SECRET_ACCESS_KEY: "SK" };
    await respond("description", repo, { config: cfg, mode: "apply", env, decideFetch: answers(0.05), s3Fetch });
    expect(puts.map((p) => p.split("/").pop())).toEqual(["intent.json"]);
  });
});

describe("respond description from the forge API", () => {
  const repoWithConfig = (): { dir: string; repo: string; cfg: string } => {
    const dir = reportDir("destroy");
    const repo = join(dir, "..");
    const cfg = join(repo, "terragucci.yml");
    writeFileSync(cfg, "respond:\n  description: check\ndecide:\n  backend: laya\n  url: http://decide.local:8790\n");
    return { dir, repo, cfg };
  };
  const forge = (payload: unknown, urls: string[]) =>
    (async (url: string) => {
      urls.push(url);
      return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) };
    });

  it("a re-plan's comment event has no pull request, so GitHub's pull is read", async () => {
    const { repo, cfg } = repoWithConfig();
    const event = join(repo, "comment.json");
    writeFileSync(event, JSON.stringify({ comment: { body: "/terragucci plan" } }));
    const urls: string[] = [];
    const env = { GITHUB_EVENT_PATH: event, TG_FORGE: "github", TG_PR: "7", TG_TOKEN: "t", GITHUB_API_URL: "https://api.github.com", GITHUB_REPOSITORY: "o/r" };
    const r = await respond("description", repo, { config: cfg, mode: "apply", env, fetch: forge({ title: RETAG.title, body: RETAG.description }, urls), decideFetch: answers(0.93) });
    expect(urls).toEqual(["https://api.github.com/repos/o/r/pulls/7"]);
    expect((r.data as { flagged: boolean }).flagged).toBe(true);
  });

  it("reads a GitLab merge request's description", async () => {
    const { repo, cfg } = repoWithConfig();
    const urls: string[] = [];
    const env = { TG_FORGE: "gitlab", TG_PR: "3", TG_TOKEN: "t", CI_API_V4_URL: "https://gl.test/api/v4", CI_PROJECT_ID: "42" };
    const r = await respond("description", repo, { config: cfg, mode: "apply", env, fetch: forge({ title: RETAG.title, description: RETAG.description }, urls), decideFetch: answers(0.93) });
    expect(urls).toEqual(["https://gl.test/api/v4/projects/42/merge_requests/3"]);
    expect((r.data as { flagged: boolean }).flagged).toBe(true);
  });

  it("skips the check when the forge does not answer", async () => {
    const { repo, cfg } = repoWithConfig();
    const env = { TG_FORGE: "github", TG_PR: "7", TG_TOKEN: "t", GITHUB_API_URL: "https://api.github.com", GITHUB_REPOSITORY: "o/r" };
    const failing = (async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => "" }));
    const r = await respond("description", repo, { config: cfg, mode: "apply", env, fetch: failing, decideFetch: answers(0.93) });
    expect(r.skipped).toMatch(/no pull request title/);
  });
});
