import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { describeEstate, estate } from "../src/estate";
import { buildReport } from "../src/report/build";
import { age, buildEstate, readInlineEstate, renderEstateHtml, type ProjectIndex } from "../src/report/estate";
import { presign, S3Client, type S3Fetch } from "../src/report/s3";
import { addToIndex, capIndex, INDEX_DESTROYS, INDEX_ROWS, indexEntry, renderIndexHtml, type IndexEntry } from "../src/report/store";
import { plan, rc, RUN, smallFixture } from "./report-fixtures";
import { tmp } from "./helpers";

const NOW = new Date("2026-10-07T12:00:00.000Z");

/** An index row as indexEntry writes one, with the fields a test names. */
const row = (o: Partial<IndexEntry> & Pick<IndexEntry, "project" | "stage" | "finished">): IndexEntry => ({
  commit: "c".repeat(40),
  path: `2026/10/${o.commit ?? "c".repeat(40)}/${o.stage}${o.wave !== undefined ? `-wave-${o.wave}` : ""}`,
  roots: 3,
  groups: 1,
  totals: { create: 0, update: 1, replace: 0, delete: 0 },
  refused: 0,
  failed: 0,
  changed: 1,
  destroys: [],
  ...o,
});

/** Three projects: one planned, one drifted, one with wave 2 waiting since 09:00. */
function threeProjects(): ProjectIndex[] {
  const a = "a".repeat(40);
  const b = "b".repeat(40);
  return [
    { project: "github.com/acme/web", base: "github.com/acme/web/", reports: [row({ project: "github.com/acme/web", stage: "tf-plan", finished: "2026-10-07T11:00:00.000Z", pull_request: "7" })] },
    {
      project: "github.com/acme/data",
      base: "github.com/acme/data/",
      reports: [
        row({ project: "github.com/acme/data", stage: "tf-drift", finished: "2026-10-07T04:17:00.000Z", changed: 2, totals: { create: 0, update: 1, replace: 0, delete: 1 } }),
        row({ project: "github.com/acme/data", stage: "tf-drift", finished: "2026-10-06T04:17:00.000Z", changed: 0 }),
      ],
    },
    {
      project: "gitlab.example.com/platform/network",
      base: "gitlab.example.com/platform/network/",
      reports: [
        row({ project: "gitlab.example.com/platform/network", stage: "tf-apply", wave: 2, commit: b, finished: "2026-10-07T10:00:00.000Z", approval: "waiting", waiting_since: "2026-10-07T09:00:00.000Z" }),
        row({ project: "gitlab.example.com/platform/network", stage: "tf-apply", wave: 1, commit: b, finished: "2026-10-07T08:55:00.000Z", approval: "not-required", applied: "2026-10-07T08:55:00.000Z" }),
        // An older commit's waiting wave: the newer commit is past it.
        row({ project: "gitlab.example.com/platform/network", stage: "tf-apply", wave: 2, commit: a, finished: "2026-10-01T10:00:00.000Z", approval: "waiting", waiting_since: "2026-10-01T10:00:00.000Z" }),
      ],
    },
  ];
}

describe("the index row", () => {
  const wave = (approval: "waiting" | "approved", waitingSince?: string) =>
    buildReport({
      run: { ...RUN, stage: "tf-apply", wave: 1 },
      roots: smallFixture().slice(0, 2),
      waves: [{ number: 1, roots: ["envs/dev/orders", "envs/dev/search"], approval, ...(waitingSince ? { waitingSince } : {}) }],
    });

  it("counts failed and changed roots, and keeps a waiting wave's gate and how long it has waited", () => {
    const planned = indexEntry(buildReport({ run: RUN, roots: smallFixture() }), "p");
    expect(planned).toMatchObject({ failed: 1, changed: 3 });
    expect(planned.approval).toBeUndefined();
    const waiting = wave("waiting", "2026-10-04T09:00:00.000Z");
    expect(waiting.waves[0].waiting_since).toBe("2026-10-04T09:00:00.000Z");
    expect(indexEntry(waiting, "w")).toMatchObject({ approval: "waiting", waiting_since: "2026-10-04T09:00:00.000Z" });
    expect(indexEntry(waiting, "w").applied).toBeUndefined();
    const approved = indexEntry(wave("approved"), "w");
    expect(approved).toMatchObject({ approval: "approved", applied: RUN.finished });
    expect(approved.waiting_since).toBeUndefined();
    // A wave report from before waiting_since was kept waits from its finish.
    expect(indexEntry(wave("waiting"), "w").waiting_since).toBe(RUN.finished);
  });

  it("lists at most INDEX_DESTROYS destroys and says how many there are", () => {
    const n = INDEX_DESTROYS + 5;
    const r = buildReport({
      run: RUN,
      roots: [{ path: "big", planner: "tofu", plan: plan(Array.from({ length: n }, (_, i) => rc(`aws_s3_object.o${i}`, ["delete"], { key: `o${i}` }, null))) }],
    });
    const e = indexEntry(r, "x");
    expect(e.destroys.length).toBe(INDEX_DESTROYS);
    expect(e.destroys_total).toBe(n);
    expect(renderIndexHtml(addToIndex(undefined, e), "t")).toContain(`<summary>${n}</summary>`);
    expect(renderIndexHtml(addToIndex(undefined, e), "t")).toContain("5 more in the report");
  });
});

describe("the index cap", () => {
  it("keeps INDEX_ROWS rows and the newest row of each project, stage and wave beyond them", () => {
    const busy = Array.from({ length: INDEX_ROWS + 50 }, (_, i) => row({ project: "p/busy/x", stage: "tf-plan", finished: new Date(NOW.getTime() - i * 60_000).toISOString(), path: `busy/${i}` }));
    const quiet = [
      row({ project: "p/quiet/x", stage: "tf-drift", finished: "2026-01-02T00:00:00.000Z", path: "quiet/drift-new" }),
      row({ project: "p/quiet/x", stage: "tf-drift", finished: "2026-01-01T00:00:00.000Z", path: "quiet/drift-old" }),
      row({ project: "p/quiet/x", stage: "tf-apply", wave: 2, finished: "2026-01-01T00:00:00.000Z", path: "quiet/wave-2" }),
    ];
    const kept = capIndex([...busy, ...quiet]);
    expect(kept.length).toBe(INDEX_ROWS + 2);
    expect(kept.slice(INDEX_ROWS).map((r) => r.path)).toEqual(["quiet/drift-new", "quiet/wave-2"]);
    // addToIndex caps what it writes.
    const index = addToIndex(JSON.stringify({ schema: "terragucci.report-index/v1", reports: [...busy, ...quiet] }), row({ project: "p/busy/x", stage: "tf-plan", finished: "2026-10-07T12:01:00.000Z", path: "busy/new" }));
    expect(index.reports.length).toBe(INDEX_ROWS + 2);
    expect(index.reports[0].path).toBe("busy/new");
  });
});

describe("the estate page", () => {
  it("shows three projects, the one waiting wave with its age and the one drift", () => {
    const e = buildEstate(threeProjects(), NOW);
    expect(e.totals).toEqual({ projects: 3, waiting: 1, drifted_projects: 1, drifted_roots: 2, failed_roots: 0, unreadable: 0 });
    const net = e.projects.find((p) => p.project === "gitlab.example.com/platform/network")!;
    expect(net.waiting).toEqual([{ project: net.project, wave: 2, commit: "b".repeat(40), since: "2026-10-07T09:00:00.000Z", age_seconds: 3 * 3600, report: `gitlab.example.com/platform/network/2026/10/${"b".repeat(40)}/tf-apply-wave-2/report.html` }]);
    expect(net.apply?.waves.map((w) => [w.wave, w.approval])).toEqual([[1, "not-required"], [2, "waiting"]]);
    const data = e.projects.find((p) => p.project === "github.com/acme/data")!;
    expect(data.drift?.finished).toBe("2026-10-07T04:17:00.000Z");
    expect(data.drifted).toBe(2);
    expect(e.recent.map((r) => r.project)).toEqual(["github.com/acme/web", "gitlab.example.com/platform/network", "gitlab.example.com/platform/network", "github.com/acme/data", "github.com/acme/data", "gitlab.example.com/platform/network"]);

    const html = renderEstateHtml(e);
    expect(html).toContain("<b>1</b><span>wave waiting</span>");
    expect(html).toContain("<b>1</b><span>project drifted</span>");
    expect(html).toContain("2 of 3 roots drifted");
    expect(html).toContain(">3h 0m</time>");
    expect(html).toContain(`href="github.com/acme/web/index.html"`);
    expect(readInlineEstate(html)).toEqual(e);
    // Self-contained: nothing loads from anywhere; the taco is an inline data: image.
    expect(html).not.toMatch(/<(script|link|img)[^>]+(src|href)="(?!data:)/);
    expect(html).toContain(`<h1 class="brand"><img class="taco" src="data:image/png;base64,`);
  });

  it("counts failed roots, and names a project with no index and one whose index could not be read", () => {
    const e = buildEstate([
      { project: "a/b/c", reports: [row({ project: "a/b/c", stage: "tf-plan", finished: "2026-10-07T11:00:00.000Z", failed: 2 }), row({ project: "x/y/z", stage: "tf-plan", finished: "2026-10-07T11:30:00.000Z" })] },
      { project: "a/b/new" },
      { project: "a/b/locked", error: "GET s3://b/reports/a/b/locked/index.json: 403 AccessDenied" },
    ], NOW);
    expect(e.totals).toMatchObject({ failed_roots: 2, unreadable: 1 });
    // A row of another project in the index is not this project's.
    expect(e.recent.map((r) => r.project)).toEqual(["a/b/c"]);
    expect(e.projects.map((p) => p.status)).toEqual(["ok", "no-index", "error"]);
    const html = renderEstateHtml(e);
    expect(html).toContain("no runs in the bucket yet");
    expect(html).toContain("the index could not be read: GET s3://b/reports/a/b/locked/index.json: 403 AccessDenied");
    // No link where the page cannot reach the project.
    expect(html).not.toContain("report.html");
  });

  it("counts the roots the newest apply waves applied under a policy override, and says nothing of overrides when there are none", () => {
    const e = buildEstate([{ project: "a/b/c", reports: [row({ project: "a/b/c", stage: "tf-apply", wave: 1, finished: "2026-10-07T11:00:00.000Z", approval: "not-required", applied: "2026-10-07T11:00:00.000Z", overridden: 1 })] }], NOW);
    expect(e.totals.overridden_roots).toBe(1);
    expect(e.projects[0].overridden).toBe(1);
    const html = renderEstateHtml(e);
    expect(html).toContain("root applied by policy override");
    expect(html).toContain("1 by policy override");
    const none = buildEstate(threeProjects(), NOW);
    expect(none.totals).not.toHaveProperty("overridden_roots");
    expect(renderEstateHtml(none)).not.toContain("policy override");
  });

  it("the index row counts the roots an override let through", () => {
    const p = plan([rc("aws_s3_bucket.logs", ["create"], null, { bucket: "logs" })]);
    const override = { by: "alice", at: "2026-10-07T10:00:00.000Z", rules: ["main.deny"], reason: "why", plan_digest: "jcs1-sha256:aa", digest: "sha256:bb", sealed: false };
    const report = buildReport({ run: { ...RUN, stage: "tf-apply", wave: 1 }, roots: [{ path: "a", plan: p, policy: { result: "denied", denials: ["no"], rules: ["main.deny"], warnings: [], override } }], waves: [{ number: 1, roots: ["a"], approval: "not-required" }] });
    expect(indexEntry(report, "x").overridden).toBe(1);
    expect(indexEntry(buildReport({ run: RUN, roots: [{ path: "a", plan: p }] }), "x")).not.toHaveProperty("overridden");
  });

  it("escapes what the indexes hold, so a value never closes the inline JSON", () => {
    const html = renderEstateHtml(buildEstate([{ project: "a/b/<c>", reports: [row({ project: "a/b/<c>", stage: "tf-plan", finished: NOW.toISOString(), pull_request: "</script><script>alert(1)</script>" })] }], NOW));
    expect(html).not.toContain("</script><script>alert(1)");
    expect(html).toContain("a/b/&lt;c&gt;");
    expect(readInlineEstate(html)?.projects[0].project).toBe("a/b/<c>");
  });

  it("says ages in two units", () => {
    expect([age(59), age(600), age(3 * 3600 + 120), age(2 * 86400 + 5 * 3600)]).toEqual(["0m", "10m", "3h 2m", "2d 5h"]);
  });
});

describe("presigned links", () => {
  it("signs a GET in the query string as AWS's Signature Version 4 example does", () => {
    // AWS's documented example: GET /test.txt from examplebucket for 86400 seconds.
    const url = presign({ region: "us-east-1", accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" }, "https://examplebucket.s3.amazonaws.com/test.txt", 86400, new Date("2013-05-24T00:00:00Z"));
    expect(url).toBe("https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404");
    expect(() => presign({ region: "us-east-1", accessKeyId: "A", secretAccessKey: "S" }, "https://b.example/k", 8 * 86400, new Date())).toThrow(/1 to 604800 seconds/);
  });

  it("carries the session token and ends when an assumed role's keys do", async () => {
    const s3 = new S3Client({ bucket: "b", endpoint: "http://floci:4566", region: "us-east-1", accessKeyId: "AK", secretAccessKey: "SK", sessionToken: "t/k" });
    const { url, expires } = await s3.presign("reports/estate.html", 3600, NOW);
    expect(url).toMatch(/^http:\/\/floci:4566\/b\/reports\/estate\.html\?X-Amz-Algorithm=AWS4-HMAC-SHA256&/);
    expect(url).toContain("X-Amz-Security-Token=t%2Fk");
    expect(expires.toISOString()).toBe("2026-10-07T13:00:00.000Z");
  });
});

/** A bucket in memory that records each request's method and key. */
function bucket(objects: Map<string, string>, refuse: (key: string) => boolean = () => false) {
  const requests: string[] = [];
  const fetch: S3Fetch = async (url, init) => {
    const u = new URL(url);
    const [, name, ...rest] = u.pathname.split("/");
    const key = `${name}:${decodeURIComponent(rest.join("/"))}`;
    requests.push(`${init.method} ${key}`);
    if (refuse(key)) return { ok: false, status: 403, text: async () => "<Error><Code>AccessDenied</Code></Error>" };
    if (init.method === "PUT") {
      objects.set(key, typeof init.body === "string" ? init.body : Buffer.from(init.body as Uint8Array).toString("utf-8"));
      return { ok: true, status: 200, text: async () => "" };
    }
    const body = objects.get(key);
    return { ok: body !== undefined, status: body === undefined ? 404 : 200, text: async () => body ?? "" };
  };
  return { fetch, requests };
}

const ENV = { AWS_ACCESS_KEY_ID: "AK", AWS_SECRET_ACCESS_KEY: "SK", AWS_REGION: "us-east-1" };
const index = (reports: IndexEntry[]): string => JSON.stringify({ schema: "terragucci.report-index/v1", reports });

describe("terragucci estate", () => {
  it("in a single repo, reads the top index for the projects, each project's index.json, inventory.json and changes.json and the audit summary, and nothing else", async () => {
    const objects = new Map<string, string>();
    const all = threeProjects();
    objects.set("acme-reports:reports/index.json", index(all.flatMap((p) => p.reports!)));
    for (const p of all) objects.set(`acme-reports:reports/${p.project}/index.json`, index(p.reports!));
    const { fetch, requests } = bucket(objects);
    const cwd = tmp();
    const r = await estate(cwd, { reports: { bucket: "s3://acme-reports", endpoint: "http://minio:9000", prefix: "reports" } }, { fetch, env: ENV, now: NOW, linkSeconds: 3600 });
    const gets = requests.filter((q) => q.startsWith("GET "));
    expect(gets).toEqual([
      "GET acme-reports:reports/index.json",
      "GET acme-reports:reports/github.com/acme/data/index.json",
      "GET acme-reports:reports/github.com/acme/data/inventory.json",
      "GET acme-reports:reports/github.com/acme/data/changes.json",
      "GET acme-reports:reports/github.com/acme/web/index.json",
      "GET acme-reports:reports/github.com/acme/web/inventory.json",
      "GET acme-reports:reports/github.com/acme/web/changes.json",
      "GET acme-reports:reports/gitlab.example.com/platform/network/index.json",
      "GET acme-reports:reports/gitlab.example.com/platform/network/inventory.json",
      "GET acme-reports:reports/gitlab.example.com/platform/network/changes.json",
      "GET acme-reports:reports/audit.json",
    ]);
    for (const g of gets) expect(g).not.toMatch(/plan\.(txt|json)$|report\.json$/);
    expect(requests.filter((q) => q.startsWith("PUT "))).toEqual(["PUT acme-reports:reports/estate.json", "PUT acme-reports:reports/estate.html"]);
    expect(r.estate.totals).toMatchObject({ projects: 3, waiting: 1, drifted_projects: 1 });
    expect(JSON.parse(objects.get("acme-reports:reports/estate.json")!)).toEqual(r.estate);
    expect(readInlineEstate(objects.get("acme-reports:reports/estate.html")!)).toEqual(r.estate);
    for (const f of ["estate.html", "estate.json"]) expect(existsSync(join(cwd, "terragucci-estate", f))).toBe(true);
    expect(readFileSync(join(cwd, "terragucci-estate", "estate.html"), "utf-8")).toBe(objects.get("acme-reports:reports/estate.html"));
    expect(r.link?.url).toMatch(/^http:\/\/minio:9000\/acme-reports\/reports\/estate\.html\?X-Amz-Algorithm=.*X-Amz-Expires=3600&.*X-Amz-Signature=[0-9a-f]{64}$/);
    expect(r.link?.expires).toBe("2026-10-07T13:00:00.000Z");
    expect(r.unreadable).toEqual([]);
    const text = describeEstate(r, cwd);
    expect(text).toContain("estate: 3 projects, 1 wave waiting, 1 project drifted, 0 roots failed");
    expect(text).toContain("gitlab.example.com/platform/network: wave 2 waits, for 3h 0m");
    expect(text).toContain("wrote terragucci-estate/estate.json and terragucci-estate/estate.html");
  });

  it("from a control repo, reads each project from its own bucket, keeps going past one it cannot read, and writes under defaults", async () => {
    const objects = new Map<string, string>();
    const [web, data] = threeProjects();
    objects.set(`central:r/${web.project}/index.json`, index(web.reports!));
    objects.set(`other:x/${data.project}/index.json`, index(data.reports!));
    const { fetch, requests } = bucket(objects, (k) => k.startsWith("locked:"));
    const config = {
      defaults: { reports: { bucket: "s3://central", endpoint: "http://minio:9000", prefix: "r" } },
      projects: {
        [web.project]: {},
        [data.project]: { reports: { bucket: "s3://other", endpoint: "http://minio:9000", prefix: "x", url: "https://other.example" } },
        "github.com/acme/locked": { reports: { bucket: "s3://locked", endpoint: "http://minio:9000" } },
        "github.com/acme/fresh": {},
      },
    };
    const r = await estate(tmp(), config, { fetch, env: ENV, now: NOW });
    expect(requests.filter((q) => q.startsWith("GET "))).toEqual([
      `GET central:r/${web.project}/index.json`,
      `GET central:r/${web.project}/inventory.json`,
      `GET central:r/${web.project}/changes.json`,
      `GET other:x/${data.project}/index.json`,
      `GET other:x/${data.project}/inventory.json`,
      `GET other:x/${data.project}/changes.json`,
      "GET locked:github.com/acme/locked/index.json",
      "GET central:r/github.com/acme/fresh/index.json",
      "GET central:r/audit.json",
    ]);
    expect(r.estate.projects.map((p) => [p.project, p.status])).toEqual([[web.project, "ok"], [data.project, "ok"], ["github.com/acme/locked", "error"], ["github.com/acme/fresh", "no-index"]]);
    // Another bucket's runs link through its own address; one with no address is not linked.
    expect(r.estate.projects[1].drift?.report).toMatch(/^https:\/\/other\.example\/x\/github\.com\/acme\/data\/2026\//);
    expect(r.estate.projects[0].plan?.report).toMatch(/^github\.com\/acme\/web\/2026\//);
    expect(r.estate.projects[2].index).toBeUndefined();
    expect(r.unreadable).toEqual(["github.com/acme/locked"]);
    expect(objects.has("central:r/estate.html")).toBe(true);
    expect(describeEstate(r, "/")).toContain("github.com/acme/locked: the index could not be read: GET s3://locked/github.com/acme/locked/index.json: 403");
  });

  it("needs a bucket to read", async () => {
    await expect(estate(tmp(), {}, { env: ENV })).rejects.toThrow(/set reports.bucket in terragucci.yml, or pass --bucket/);
    await expect(estate(tmp(), { reports: { bucket: "b" } }, { env: ENV, linkSeconds: 8 * 86400 })).rejects.toThrow(/1 second to 7 days/);
  });
});
