import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendLifecycle } from "../src/apply";
import { MIGRATE_LEDGER, runMigrations, type BinaryExec } from "../src/migrate";
import { buildReport } from "../src/report/build";
import { addToEstates, ESTATES_SCHEMA, rosterKey, rosterOf, stockEstate, uploadRosters, waveRosters, type Roster } from "../src/report/roster";
import { S3Client, type S3Fetch } from "../src/report/s3";
import { validate, type Json } from "../../../scripts/schema-check";
import { plan, RUN } from "./report-fixtures";
import { tmp, write } from "./helpers";

const SECRET = "hunter2-do-not-store";
const AWS = "registry.opentofu.org/hashicorp/aws";
const schema = (name: string): Json => JSON.parse(readFileSync(join(import.meta.dirname, "../src/report", name), "utf-8"));

/** A planned resource with `values`. */
const res = (address: string, type: string, values: Json): Json => ({ address, mode: "managed", type, name: address.split(".").pop(), provider_name: AWS, values });

/** A choudoufu root's plan in estate `team`: a tagged queue, a Kubernetes object labelled, a policy with no marker surface, a queue another estate's marker names, and a data source. */
const livePlan = (): Json =>
  plan([], {
    planned_values: {
      root_module: {
        resources: [
          res("aws_sqs_queue.jobs", "aws_sqs_queue", { id: "https://sqs/jobs", name: "jobs", tags: { "tofu-estate": "team", "tofu-address": "aws_sqs_queue.jobs" }, policy: SECRET }),
          res("aws_sqs_queue_policy.jobs", "aws_sqs_queue_policy", { queue_url: "https://sqs/jobs", policy: SECRET }),
          res("aws_sqs_queue.stray", "aws_sqs_queue", { tags_all: { "tofu-estate": "mono" } }),
          { address: "data.aws_caller_identity.me", mode: "data", type: "aws_caller_identity", name: "me", values: { account_id: "123" } },
        ],
        child_modules: [{ address: "module.k8s", resources: [res("module.k8s.kubernetes_config_map.app", "kubernetes_config_map", { metadata: [{ name: "app", labels: { "tofu-estate": "team" } }], data: { password: SECRET } })] }],
      },
    },
  });

/** A stock root's plan: the state it leaves holds a bucket whose tags carry a marker-like key, which a stock root never reads as one. */
const stockPlan = (): Json =>
  plan([], {
    planned_values: {
      root_module: {
        resources: [res("aws_s3_bucket.logs", "aws_s3_bucket", { bucket: "logs", tags: { "tofu-estate": "terralith" } }), res("aws_db_instance.main", "aws_db_instance", { password: SECRET })],
      },
    },
  });

const FINISHED = "2026-10-16T12:00:00.000Z";

const applied = (roots: { path: string; plan: Json }[]) =>
  buildReport({
    run: { ...RUN, stage: "tf-apply", wave: 1, finished: FINISHED },
    roots: roots.map((r) => ({ ...r, planner: "tofu" as const, applied: true })),
    waves: [{ number: 1, roots: roots.map((r) => r.path), approval: "not-required" }],
  });

/** A bucket in memory, keyed by object key. */
function bucket() {
  const objects = new Map<string, string>();
  const fetch: S3Fetch = async (url, init) => {
    const [, , ...rest] = new URL(url).pathname.split("/");
    const key = decodeURIComponent(rest.join("/"));
    if (init.method === "PUT") {
      objects.set(key, typeof init.body === "string" ? init.body : Buffer.from(init.body as Uint8Array).toString("utf-8"));
      return { ok: true, status: 200, text: async () => "" };
    }
    const body = objects.get(key);
    return { ok: body !== undefined, status: body === undefined ? 404 : 200, text: async () => body ?? "" };
  };
  return { objects, s3: new S3Client({ bucket: "acme-reports", endpoint: "http://minio:9000", region: "us-east-1", accessKeyId: "AK", secretAccessKey: "SK" }, fetch) };
}

describe("a wave's rosters", () => {
  it("a choudoufu root's roster is its estate's: each managed resource by address and type, marked where its marker names the estate, and no value", () => {
    const [w] = waveRosters(applied([{ path: "teams/team", plan: livePlan() }]), new Map([["teams/team", { plan: livePlan(), estate: "team" }]]));
    expect(w).toEqual({
      project: RUN.project,
      root: "teams/team",
      roster: {
        estate: "team",
        at: FINISHED,
        resources: [
          { address: "aws_sqs_queue.jobs", type: "aws_sqs_queue", marked: true },
          { address: "aws_sqs_queue.stray", type: "aws_sqs_queue", marked: false },
          { address: "aws_sqs_queue_policy.jobs", type: "aws_sqs_queue_policy", marked: false },
          { address: "module.k8s.kubernetes_config_map.app", type: "kubernetes_config_map", marked: true },
        ],
      },
    });
    const text = JSON.stringify(w);
    for (const v of [SECRET, "https://sqs/jobs", "tofu-estate", "mono"]) expect(text).not.toContain(v);
  });

  it("a stock root's roster names the root as its estate and holds addresses and types, none marked", () => {
    const [w] = waveRosters(applied([{ path: "terralith", plan: stockPlan() }]), new Map([["terralith", { plan: stockPlan() }]]));
    expect(w!.roster).toEqual({ estate: "terralith", at: FINISHED, resources: [{ address: "aws_db_instance.main", type: "aws_db_instance", marked: false }, { address: "aws_s3_bucket.logs", type: "aws_s3_bucket", marked: false }] });
    expect(JSON.stringify(w)).not.toContain(SECRET);
    expect(stockEstate(".")).toBe("root");
  });

  it("a plan's report and a root that did not apply write none", () => {
    const planned = buildReport({ run: RUN, roots: [{ path: "terralith", plan: stockPlan(), planner: "tofu" }] });
    expect(waveRosters(planned, new Map([["terralith", { plan: stockPlan() }]]))).toEqual([]);
    const held = buildReport({ run: { ...RUN, stage: "tf-apply", wave: 1, finished: FINISHED }, roots: [{ path: "terralith", plan: stockPlan(), planner: "tofu" }], waves: [{ number: 1, roots: ["terralith"], approval: "not-required" }] });
    expect(waveRosters(held, new Map([["terralith", { plan: stockPlan() }]]))).toEqual([]);
  });
});

describe("the rosters in the bucket", () => {
  it("each goes to estates/<estate>/roster.json, and estates.json beside the reports index gains its entry with the count", async () => {
    const { objects, s3 } = bucket();
    const writes = waveRosters(applied([{ path: "teams/team", plan: livePlan() }, { path: "terralith", plan: stockPlan() }]), new Map<string, { plan: unknown; estate?: string }>([["teams/team", { plan: livePlan(), estate: "team" }], ["terralith", { plan: stockPlan() }]]));
    const keys = await uploadRosters(s3, writes, "reports", async () => {});
    expect(keys).toEqual(["reports/estates/team/roster.json", "reports/estates/terralith/roster.json", "reports/estates.json"]);
    expect(JSON.parse(objects.get("reports/estates/team/roster.json")!)).toEqual(writes[0]!.roster);
    const index = JSON.parse(objects.get("reports/estates.json")!);
    expect(index).toEqual({
      schema: ESTATES_SCHEMA,
      estates: [
        { estate: "team", count: 4, at: FINISHED, project: RUN.project, root: "teams/team", roster: "estates/team/roster.json" },
        { estate: "terralith", count: 2, at: FINISHED, project: RUN.project, root: "terralith", roster: "estates/terralith/roster.json" },
      ],
    });
    expect(validate(schema("estates.schema.json"), index)).toEqual([]);
    expect([...objects.keys()].some((k) => k.endsWith("index.json"))).toBe(false);
  });

  it("an older roster leaves a newer one and its entry as they are", async () => {
    const { objects, s3 } = bucket();
    const newer: Roster = rosterOf("teams/team", "team", livePlan(), FINISHED);
    const older: Roster = { ...rosterOf("teams/team", "team", stockPlan(), "2026-10-16T11:00:00.000Z") };
    await uploadRosters(s3, [{ roster: newer, project: RUN.project, root: "teams/team" }], "", async () => {});
    await uploadRosters(s3, [{ roster: older, project: RUN.project, root: "teams/team" }], "", async () => {});
    expect(JSON.parse(objects.get(rosterKey("team"))!)).toEqual(newer);
    expect(addToEstates(objects.get("estates.json"), []).estates).toMatchObject([{ estate: "team", count: 4, at: FINISHED }]);
  });

  it("an estate name that makes no key is refused before anything is written", async () => {
    const { objects, s3 } = bucket();
    await expect(uploadRosters(s3, [{ roster: { estate: "../x", at: FINISHED, resources: [] }, project: RUN.project, root: "x" }], "", async () => {})).rejects.toThrow(/names no key/);
    expect(objects.size).toBe(0);
  });
});

// ── an estate migration's roster ─────────────────────────────────────────
// live.json is the account: each resource's id and its markers. A root's
// want.json lists the addresses its code declares. The plan writes planned
// values with each owned resource's tags, so the roster after the retag is
// read from the plan the migration makes after its write.

const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf-8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
interface Live {
  id: string;
  estate: string;
  address: string;
}
const liveOf = (repo: string): Live[] => JSON.parse(readFileSync(join(repo, "live.json"), "utf-8")) as Live[];

function choudoufu(repo: string): BinaryExec {
  return async (_binary, args, dir) => {
    const ok = (stdout = "") => ({ code: 0, stdout, out: stdout });
    const estate = /estate\s*=\s*"([^"]+)"/.exec(readFileSync(join(dir, "main.tf"), "utf-8"))?.[1];
    const want = JSON.parse(readFileSync(join(dir, "want.json"), "utf-8")) as string[];
    if (args[0] === "init") return ok();
    if (args[0] === "plan") {
      const live = liveOf(repo);
      const owned = live.filter((l) => l.estate === estate).map((l) => l.address);
      // A follower has no marker of its own: it is owned when the resource it follows is.
      const followed = want.filter((a) => a.endsWith("_policy.jobs") && owned.includes("aws_sqs_queue.jobs"));
      const changes = [...want.filter((a) => !owned.includes(a) && !followed.includes(a)).map((a) => ({ address: a, change: { actions: ["create"] } })), ...owned.filter((a) => !want.includes(a)).map((a) => ({ address: a, change: { actions: ["delete"] } }))];
      const resources = [...owned.filter((a) => want.includes(a)).map((a) => ({ address: a, mode: "managed", type: a.split(".")[0], values: { id: live.find((l) => l.address === a)!.id, tags: { "tofu-estate": estate } } })), ...followed.map((a) => ({ address: a, mode: "managed", type: a.split(".")[0], values: { policy: SECRET } }))];
      writeFileSync(args.find((a) => a.startsWith("-out="))!.slice(5), JSON.stringify({ resource_changes: changes, planned_values: { root_module: { resources } } }));
      return ok(changes.length ? "Plan: some changes." : "No changes.");
    }
    if (args[0] === "show") return ok(readFileSync(args[2]!, "utf-8"));
    if (args[0] === "live-mv") {
      const from = args.find((a) => a.startsWith("-from-estate="))!.slice(13);
      const address = args[args.length - 1]!;
      const live = liveOf(repo);
      const r = live.find((l) => l.estate === from && l.address === address)!;
      const doc = (written: boolean) => JSON.stringify({ resource: { live_id: r.id }, followers: [{ address: "aws_sqs_queue_policy.jobs" }], written, refusal: null });
      if (args.includes("-dry-run")) return ok(doc(false));
      r.estate = estate!;
      writeFileSync(join(repo, "live.json"), JSON.stringify(live));
      return ok(doc(true));
    }
    return { code: 1, stdout: "", out: `unknown: ${args.join(" ")}` };
  };
}

const liveBlock = (estate: string): string => `terraform {\n  live {\n    estate = "${estate}"\n  }\n}\n`;

describe("an estate migration's rosters", () => {
  it("after the retag, each estate root's roster comes from the plan it makes after the write, with the live id and the follower named", async () => {
    const dir = tmp("tg-roster-");
    const origin = join(dir, "origin.git");
    git(dir, "init", "-q", "--bare", origin);
    const work = join(dir, "work");
    mkdirSync(work);
    write(work, {
      "live.json": JSON.stringify([
        { id: "q-jobs", estate: "mono", address: "aws_sqs_queue.jobs" },
        { id: "q-keep", estate: "mono", address: "aws_sqs_queue.keep" },
      ]),
      "mono/main.tf": `${liveBlock("mono")}resource "aws_sqs_queue" "keep" {}\n`,
      "mono/want.json": JSON.stringify(["aws_sqs_queue.keep"]),
      "team/main.tf": `${liveBlock("team")}resource "aws_sqs_queue" "jobs" {}\n`,
      "team/want.json": JSON.stringify(["aws_sqs_queue.jobs", "aws_sqs_queue_policy.jobs"]),
      "migrations/carve-jobs.yml": "moves:\n  - from: mono\n    to: team\n    addresses: [aws_sqs_queue.jobs]\n",
    });
    git(work, "init", "-q", "-b", "main");
    git(work, "add", "-A");
    git(work, "commit", "-q", "-m", "base");
    git(work, "remote", "add", "origin", origin);
    git(work, "push", "-q", "origin", "main");
    const exec = choudoufu(work);
    const rosters: { root: string; roster: Roster }[] = [];
    const roster = (root: string, r: Roster) => void rosters.push({ root, roster: r });
    const first = await runMigrations(work, { binary: "choudoufu", exec, env: {}, now: "2026-10-16T12:01:00.000Z", log: () => {}, roster });
    expect(first.code).toBe(3);
    // Planned and waiting: nothing was written, so no roster.
    expect(rosters).toEqual([]);
    appendLifecycle(work, MIGRATE_LEDGER, [JSON.stringify({ version: 1, kind: "resolution", op: "tf-migrate", gate: "carve-jobs", resolvedBy: "alice", timestamp: "2026-10-16T12:02:00.000Z", planDigest: first.records[0]!.digest })], {}, "approve");
    const second = await runMigrations(work, { binary: "choudoufu", exec, env: {}, now: "2026-10-16T12:03:00.000Z", log: () => {}, roster });
    expect(second.code).toBe(0);
    expect(rosters).toEqual([
      { root: "mono", roster: { estate: "mono", at: "2026-10-16T12:03:00.000Z", resources: [{ address: "aws_sqs_queue.keep", type: "aws_sqs_queue", marked: true }] } },
      {
        root: "team",
        roster: {
          estate: "team",
          at: "2026-10-16T12:03:00.000Z",
          resources: [
            { address: "aws_sqs_queue.jobs", type: "aws_sqs_queue", live_id: "q-jobs", marked: true },
            { address: "aws_sqs_queue_policy.jobs", type: "aws_sqs_queue_policy", marked: false, follows: "aws_sqs_queue.jobs" },
          ],
        },
      },
    ]);
    expect(JSON.stringify(rosters)).not.toContain(SECRET);
  });
});
