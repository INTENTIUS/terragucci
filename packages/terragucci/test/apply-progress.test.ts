import { mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ApplyProgress, configAddress, configDependencies, plannedChanges, progressInterval, progressLine, recordedDone, rootProgress, type WaveProgress } from "../src/apply-progress";
import { readRecords, recordAddress, recordStoreOf, type RecordStore, type Records } from "../src/cdf-records";
import { buildEstate, renderEstateHtml, type ProjectIndex } from "../src/report/estate";
import { renderRunHtml, runSkeleton, withWave } from "../src/report/run-view";
import { validate, type Json } from "../../../scripts/schema-check";
import { tmp, write } from "./helpers";

const schema = (name: string): Json => JSON.parse(readFileSync(join(import.meta.dirname, "../src/report", name), "utf-8"));

const key = (estate: string, address: string): string => `tofu-records/${estate}/${address.split(".").at(-2)!.replace(/\[.*$/, "")}/${Buffer.from(address).toString("base64url")}`;

/** first, then second (depends_on first), then third (reads second's output). */
const plan = {
  resource_changes: [
    { address: "terraform_data.first", mode: "managed", change: { actions: ["create"] } },
    { address: "terraform_data.second", mode: "managed", change: { actions: ["create"] } },
    { address: "terraform_data.third[0]", mode: "managed", change: { actions: ["update"] } },
    { address: "terraform_data.gone", mode: "managed", change: { actions: ["delete"] } },
    { address: "terraform_data.same", mode: "managed", change: { actions: ["no-op"] } },
    { address: "data.terraform_data.read", mode: "data", change: { actions: ["read"] } },
  ],
  configuration: {
    root_module: {
      resources: [
        { address: "terraform_data.first", mode: "managed", expressions: { input: { constant_value: "first" } } },
        { address: "terraform_data.second", mode: "managed", depends_on: ["terraform_data.first"], expressions: { input: { constant_value: "second" } } },
        { address: "terraform_data.third", mode: "managed", count_expression: { constant_value: 1 }, expressions: { input: { references: ["terraform_data.second.output", "terraform_data.second", "var.x"] } } },
      ],
    },
  },
};

describe("record keys", () => {
  it("reads the address back from a key, chunked or not, under the estate's prefix only", () => {
    expect(recordAddress("tofu-records/e/", key("e", "terraform_data.first"))).toBe("terraform_data.first");
    expect(recordAddress("tofu-records/e", key("e", 'module.a["x.y"].aws_iam_policy.p[0]'))).toBe('module.a["x.y"].aws_iam_policy.p[0]');
    const long = `aws_s3_bucket.${"b".repeat(300)}`;
    const enc = Buffer.from(long).toString("base64url");
    const chunked = `tofu-records/e/aws_s3_bucket/${enc.slice(0, 230)}/${enc.slice(230)}`;
    expect(recordAddress("tofu-records/e/", chunked)).toBe(long);
    // Another estate whose name the first prefixes, and keys that are not records.
    expect(recordAddress("tofu-records/e/", key("e2", "terraform_data.first"))).toBeUndefined();
    expect(recordAddress("tofu-records/e/", "tofu-records/e/terraform_data")).toBeUndefined();
    expect(recordAddress("tofu-records/e/", "tofu-records/e/terraform_data/!!")).toBeUndefined();
  });

  it("finds the store a root's live block names, and the local default", () => {
    const repo = tmp();
    write(repo, {
      "s3/main.tf": 'terraform {\n  live {\n    estate = "e"\n    record_store "s3" {\n      bucket = "recs"\n      region = "eu-west-1"\n    }\n  }\n}\n',
      "pre/main.tf": 'terraform {\n  live {\n    estate = "e"\n    record_store "s3" {\n      bucket     = "recs"\n      key_prefix = "team/e"\n    }\n  }\n}\n',
      "local/main.tf": 'terraform {\n  live {\n    estate = "e"\n  }\n}\n',
      "side/estate.chdf.hcl": 'estate = "e"\nrecord_store "local" {\n  path = "recs"\n}\n',
      "side/main.tf": "",
      "k8s/main.tf": 'terraform {\n  live {\n    estate = "e"\n    record_store "kubernetes" {\n      namespace = "n"\n    }\n  }\n}\n',
      "plain/main.tf": 'terraform {\n  backend "s3" {}\n}\n',
    });
    expect(recordStoreOf(join(repo, "s3"), "e")).toEqual({ kind: "s3", bucket: "recs", prefix: "tofu-records/e/", region: "eu-west-1" });
    expect(recordStoreOf(join(repo, "pre"), "e")).toEqual({ kind: "s3", bucket: "recs", prefix: "team/e/" });
    expect(recordStoreOf(join(repo, "local"), "e")).toEqual({ kind: "local", dir: join(repo, "local", ".tofu-records"), prefix: "tofu-records/e/" });
    expect(recordStoreOf(join(repo, "side"), "e")).toEqual({ kind: "local", dir: join(repo, "side", "recs"), prefix: "tofu-records/e/" });
    expect(recordStoreOf(join(repo, "k8s"), "e")).toEqual({ kind: "unread", name: "kubernetes" });
    expect(recordStoreOf(join(repo, "plain"), "e")).toBeUndefined();
  });

  it("lists a local store's records with a version that moves when one is written again", async () => {
    const dir = tmp();
    const store: RecordStore = { kind: "local", dir, prefix: "tofu-records/e/" };
    const file = join(dir, key("e", "terraform_data.first"));
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, "{}");
    writeFileSync(`${file}.lock`, "");
    utimesSync(file, 1000, 1000);
    const one = await readRecords(store);
    expect([...one.keys()]).toEqual(["terraform_data.first"]);
    writeFileSync(file, "{ }");
    utimesSync(file, 2000, 2000);
    expect((await readRecords(store)).get("terraform_data.first")).not.toBe(one.get("terraform_data.first"));
  });

  it("lists an S3 store page by page with the job's keys, signed", async () => {
    const urls: string[] = [];
    const page = (keys: string[], next?: string): string =>
      `<ListBucketResult>${keys.map((k) => `<Contents><Key>${k}</Key><ETag>&quot;${k.length}&quot;</ETag></Contents>`).join("")}<IsTruncated>${next ? "true" : "false"}</IsTruncated>${next ? `<NextContinuationToken>${next}</NextContinuationToken>` : ""}</ListBucketResult>`;
    const fetchFn = async (url: string, init: { headers: Record<string, string> }) => {
      urls.push(url);
      expect(init.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AK\//);
      const body = url.includes("continuation-token") ? page([key("e", "terraform_data.second")]) : page([key("e", "terraform_data.first"), "tofu-records/e/other"], "t/1");
      return { ok: true, status: 200, text: async () => body };
    };
    const got = await readRecords({ kind: "s3", bucket: "recs", prefix: "tofu-records/e/" }, { AWS_ACCESS_KEY_ID: "AK", AWS_SECRET_ACCESS_KEY: "SK", AWS_ENDPOINT_URL: "http://floci:4566/" }, fetchFn);
    expect([...got.keys()].sort()).toEqual(["terraform_data.first", "terraform_data.second"]);
    expect(got.get("terraform_data.first")).toMatch(/^"\d+"$/);
    expect(urls[0]).toBe("http://floci:4566/recs?list-type=2&prefix=tofu-records%2Fe%2F");
    expect(urls[1]).toContain("continuation-token=t%2F1");
  });
});

describe("planned changes", () => {
  it("reads each change and what it waits on from the plan's configuration", () => {
    expect(configAddress('module.a["x"].aws_s3_bucket.b[0]')).toBe("module.a.aws_s3_bucket.b");
    expect(configDependencies(plan).get("terraform_data.third")).toEqual(["terraform_data.second"]);
    expect(plannedChanges(plan)).toEqual([
      { address: "terraform_data.first", action: "create", config: "terraform_data.first", after: [] },
      { address: "terraform_data.gone", action: "delete", config: "terraform_data.gone", after: [] },
      { address: "terraform_data.second", action: "create", config: "terraform_data.second", after: ["terraform_data.first"] },
      { address: "terraform_data.third[0]", action: "update", config: "terraform_data.third", after: ["terraform_data.second"] },
    ]);
  });

  it("follows a reference to a module to every resource in it, and replaces", () => {
    const p = {
      resource_changes: [
        { address: "module.net.aws_vpc.v", change: { actions: ["delete", "create"] } },
        { address: "aws_instance.i", change: { actions: ["create"] } },
      ],
      configuration: {
        root_module: {
          resources: [{ address: "aws_instance.i", expressions: { subnet: { references: ["module.net.subnet", "module.net"] } } }],
          module_calls: { net: { module: { resources: [{ address: "aws_vpc.v" }] } } },
        },
      },
    };
    const changes = plannedChanges(p);
    expect(changes.find((c) => c.address === "aws_instance.i")!.after).toEqual(["module.net."]);
    expect(changes.find((c) => c.address === "module.net.aws_vpc.v")!.action).toBe("replace");
    const out = rootProgress("r", changes, "applying", new Map(), new Map(), new Map(), "t");
    expect(out.map((r) => r.status)).toEqual(["waiting", "in-flight"]);
  });
});

describe("progress", () => {
  const changes = plannedChanges(plan);
  const before: Records = new Map([
    ["terraform_data.third[0]", "v1"],
    ["terraform_data.gone", "g1"],
  ]);

  it("is done where the records moved, in flight where nothing it waits on is left, waiting otherwise", () => {
    expect(recordedDone({ address: "terraform_data.first", action: "create" }, before, new Map([["terraform_data.first", "a"]]))).toBe(true);
    expect(recordedDone({ address: "terraform_data.third[0]", action: "update" }, before, before)).toBe(false);
    expect(recordedDone({ address: "terraform_data.gone", action: "delete" }, before, new Map())).toBe(true);

    const doneAt = new Map<string, string>();
    const status = (now: Records, phase: "applying" | "applied" | "failed" | "pending" = "applying", at = "t") => Object.fromEntries(rootProgress("r", changes, phase, before, now, doneAt, at).map((r) => [r.address, r.status]));
    expect(status(before, "pending")).toEqual({ "terraform_data.first": "waiting", "terraform_data.gone": "waiting", "terraform_data.second": "waiting", "terraform_data.third[0]": "waiting" });
    expect(status(before)).toEqual({ "terraform_data.first": "in-flight", "terraform_data.gone": "in-flight", "terraform_data.second": "waiting", "terraform_data.third[0]": "waiting" });
    // first's record is written: it is done, and second, which waits on it, is in flight.
    const firstDone = new Map([...before, ["terraform_data.first", "f1"]]);
    expect(status(firstDone, "applying", "t1")).toEqual({ "terraform_data.first": "done", "terraform_data.gone": "in-flight", "terraform_data.second": "in-flight", "terraform_data.third[0]": "waiting" });
    expect(doneAt.get("terraform_data.first")).toBe("t1");
    // A failed apply leaves what it did not finish not applied; first stays done.
    expect(status(firstDone, "failed")).toEqual({ "terraform_data.first": "done", "terraform_data.gone": "not-applied", "terraform_data.second": "not-applied", "terraform_data.third[0]": "not-applied" });
    // An apply that returned is done whole, records or not.
    expect(Object.values(status(new Map(), "applied"))).toEqual(["done", "done", "done", "done"]);
  });

  it("takes the interval from TG_PROGRESS_SECONDS", () => {
    expect(progressInterval({})).toBe(5000);
    expect(progressInterval({ TG_PROGRESS_SECONDS: "2" })).toBe(2000);
    expect(progressInterval({ TG_PROGRESS_SECONDS: "0" })).toBe(5000);
  });

  it("reads the records on its timer while the apply runs, and writes the progress each time it moves", async () => {
    let records: Records = new Map();
    let reads = 0;
    const seen: WaveProgress[] = [];
    const watch = new ApplyProgress([{ root: "estate", plan, store: { kind: "local", dir: "/x", prefix: "p/" }, env: {} }], {
      intervalMs: 5,
      read: async () => {
        reads++;
        return new Map(records);
      },
      changed: async (p) => {
        seen.push(p);
      },
    });
    expect(watch.total).toBe(4);
    records = new Map(before);
    await watch.start();
    await watch.phase("estate", "applying");
    records.set("terraform_data.first", "f1");
    const until = async (ok: () => boolean) => {
      for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 5));
    };
    await until(() => seen.some((p) => p.resources.find((r) => r.address === "terraform_data.second")?.status === "in-flight"));
    const mid = seen.at(-1)!;
    expect(progressLine(mid)).toBe("1 of 4 done, 2 in flight, 1 waiting");
    expect(mid.resources.find((r) => r.address === "terraform_data.first")).toMatchObject({ status: "done", done_at: expect.any(String) });
    const n = reads;
    await watch.phase("estate", "applied");
    const end = await watch.stop();
    expect(progressLine(end!)).toBe("4 of 4 done, 0 in flight, 0 waiting");
    // Once the apply ended the store is read once more, and the timer stops.
    await new Promise((r) => setTimeout(r, 30));
    expect(reads).toBeLessThanOrEqual(n + 2);
  });

  it("logs a store it cannot read once, and leaves its resources to the apply's end", async () => {
    const lines: string[] = [];
    let reads = 0;
    const watch = new ApplyProgress([{ root: "estate", plan, store: { kind: "unread", name: "kubernetes" }, env: {} }], {
      intervalMs: 1000,
      read: async () => {
        reads++;
        throw new Error("no");
      },
      changed: async () => {},
      log: (l) => lines.push(l),
    });
    await watch.start();
    await watch.phase("estate", "applying");
    await watch.phase("estate", "applied");
    const end = await watch.stop();
    expect(reads).toBe(1);
    expect(lines).toEqual(["estate: its records could not be read (no); its resources show done when its apply returns"]);
    expect(progressLine(end!)).toBe("4 of 4 done, 0 in flight, 0 waiting");
  });
});

describe("progress on the run page and the estate page", () => {
  const progress: WaveProgress = {
    read: "2026-10-10T00:00:05.000Z",
    resources: [
      { root: "estate", address: "terraform_data.first", action: "create", status: "done", done_at: "2026-10-10T00:00:04.000Z" },
      { root: "estate", address: "terraform_data.second", action: "create", status: "in-flight" },
    ],
  };
  const skeleton = runSkeleton("forgejo/p", "c".repeat(40), [["estate"]], new Map());

  it("shows each resource's status on the wave, and refreshes while it applies", () => {
    const view = withWave(undefined, skeleton, { number: 1, state: "applying", progress }, "2026-10-10T00:00:05.000Z");
    expect(view.waves[0].progress).toEqual(progress);
    expect(validate(schema("run.schema.json"), view as unknown as Json)).toEqual([]);
    const html = renderRunHtml(view);
    expect(html).toContain('data-done="1" data-in-flight="1" data-waiting="0" data-total="2"');
    expect(html).toContain('<li data-status="done" data-address="terraform_data.first">');
    expect(html).toContain('<li data-status="in-flight" data-address="terraform_data.second">');
    expect(html).toContain('http-equiv="refresh"');
    // The wave's end keeps the progress, and the page stops refreshing.
    const ended = withWave(JSON.stringify(view), skeleton, { number: 1, state: "applied" }, "2026-10-10T00:01:00.000Z");
    expect(ended.waves[0].progress).toEqual(progress);
    expect(renderRunHtml(ended)).not.toContain('http-equiv="refresh"');
  });

  it("puts a wave still applying on the estate page as counts", () => {
    const commit = "c".repeat(40);
    const view = withWave(undefined, skeleton, { number: 1, state: "applying", progress }, "2026-10-10T00:00:05.000Z");
    const index: ProjectIndex = {
      project: "forgejo/p",
      base: "forgejo/p/",
      reports: [{ project: "forgejo/p", stage: "tf-apply", wave: 1, commit, finished: "2026-10-10T00:00:00.000Z", path: "2026/10/x/tf-apply-wave-1", roots: 1, totals: { create: 2, update: 0, replace: 0, delete: 0 }, destroys: [], refused: 0 } as never],
      run: view,
    };
    const e = buildEstate([index], new Date("2026-10-10T00:00:10.000Z"));
    expect(e.projects[0].applying).toEqual([{ wave: 1, read: progress.read, total: 2, done: 1, in_flight: 1, waiting: 0 }]);
    expect(validate(schema("estate.schema.json"), e as unknown as Json)).toEqual([]);
    expect(renderEstateHtml(e)).toContain('<div class="applying" data-wave="1" data-done="1" data-in-flight="1" data-waiting="0">');
  });
});
