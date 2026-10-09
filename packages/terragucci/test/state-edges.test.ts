import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { estate } from "../src/estate";
import { buildReport, type RootInput } from "../src/report/build";
import { buildEstate, readInlineEstate, renderEstateHtml } from "../src/report/estate";
import { S3Client, type S3Fetch } from "../src/report/s3";
import type { Report, ReportRead } from "../src/report/schema";
import { addToStateEdges, EDGES_SCHEMA, edgesOf, hasEdgeFacts, readsOf, readStateEdges, type EdgeRead } from "../src/report/state-edges";
import { runStage } from "../src/report/stage";
import { uploadReport, writeReportDir } from "../src/report/store";
import { validate, type Json } from "../../../scripts/schema-check";
import { plan, rc, RUN } from "./report-fixtures";
import { backend, remoteState, tmp, write } from "./helpers";

const SRC = join(import.meta.dirname, "../src/report");
const schema = (name: string): Json => JSON.parse(readFileSync(join(SRC, name), "utf-8"));
const at = (h: number): string => `2026-10-07T${String(h).padStart(2, "0")}:00:00.000Z`;
const NOW = new Date("2026-10-07T23:00:00.000Z");
const ENV = { AWS_ACCESS_KEY_ID: "AK", AWS_SECRET_ACCESS_KEY: "SK", AWS_REGION: "us-east-1" };
/** As the report names it: app's terraform_remote_state block reading network. */
const READS_NETWORK: ReportRead[] = [{ upstream: "network", data: "up", outputs: "applied" }];
/** As edges.json keeps it. */
const EDGE_NETWORK: EdgeRead[] = [{ root: "network", via: "terraform_remote_state" }];

const changed = (): Json => plan([rc("terraform_data.x", ["update"], { input: "a" }, { input: "b" })]);
const same = (): Json => plan([]);

/** A run of `stage` over roots, each with its plan, its reads, and on an apply whether it applied. */
function run(stage: "tf-plan" | "tf-drift" | "tf-apply", finished: string, roots: Record<string, { plan?: Json; reads?: ReportRead[]; dependencies?: string[]; error?: string }>, extra: Partial<Report["run"]> = {}): Report {
  const inputs: RootInput[] = Object.entries(roots).map(([path, r]) => ({
    path,
    planner: "tofu" as const,
    ...(r.error ? { error: r.error } : { plan: r.plan ?? same() }),
    ...(stage === "tf-apply" && !r.error ? { applied: true } : {}),
    ...(r.reads ? { reads: r.reads } : {}),
    ...(r.dependencies ? { dependencies: r.dependencies } : {}),
  }));
  return buildReport({ run: { ...RUN, stage, finished, ...(stage === "tf-apply" ? { wave: 1 } : {}), ...extra }, roots: inputs, ...(stage === "tf-apply" ? { waves: [{ number: 1, roots: Object.keys(roots), approval: "not-required" as const }] } : {}) });
}

describe("each root's reads in its report", () => {
  it("are its remote state blocks' upstreams, once each, then a unit's dependencies", () => {
    expect(readsOf({ reads: [...READS_NETWORK, { upstream: "network", data: "again", outputs: "planned" }, { upstream: "dns", data: "d", outputs: "applied" }] })).toEqual([
      { root: "dns", via: "terraform_remote_state" },
      { root: "network", via: "terraform_remote_state" },
    ]);
    expect(readsOf({ dependencies: ["live/vpc", "live/vpc"] })).toEqual([{ root: "live/vpc", via: "dependency" }]);
    expect(readsOf({})).toEqual([]);
  });

  it("a unit's dependencies are in the report as roots[].dependencies", () => {
    const r = run("tf-plan", at(9), { "live/app": { dependencies: ["live/vpc"] } });
    expect(r.roots[0].dependencies).toEqual(["live/vpc"]);
    expect(validate(schema("report.schema.json"), r)).toEqual([]);
  });
});

describe("edges.json", () => {
  it("keeps each root's reads, its newest plan, and the newest apply that changed it", () => {
    let e = addToStateEdges(undefined, run("tf-apply", at(9), { network: { plan: changed() }, app: { plan: same(), reads: READS_NETWORK } }), "w1");
    expect(e.roots).toEqual([
      { root: "app", reads: EDGE_NETWORK, reads_seen: at(9), planned: { stage: "tf-apply", commit: RUN.commit, finished: at(9), wave: 1, path: "w1" } },
      { root: "network", reads: [], reads_seen: at(9), planned: { stage: "tf-apply", commit: RUN.commit, finished: at(9), wave: 1, path: "w1" }, applied: { stage: "tf-apply", commit: RUN.commit, finished: at(9), wave: 1, path: "w1" } },
    ]);
    // A later apply that changes nothing in network leaves its last apply where it was.
    e = addToStateEdges(JSON.stringify(e), run("tf-apply", at(10), { network: { plan: same() } }), "w2");
    expect(e.roots.find((r) => r.root === "network")?.applied?.finished).toBe(at(9));
    expect(validate(schema("state-edges.schema.json"), e)).toEqual([]);
  });

  it("a pull request's plan moves the plan forward but never the reads, and an older run never replaces a newer one", () => {
    let e = addToStateEdges(undefined, run("tf-apply", at(9), { app: { plan: same(), reads: READS_NETWORK } }), "w");
    e = addToStateEdges(JSON.stringify(e), run("tf-plan", at(11), { app: { plan: same(), reads: [] } }, { pull_request: "7" }), "pr");
    expect(e.roots[0]).toMatchObject({ reads: EDGE_NETWORK, planned: { stage: "tf-plan", pull_request: "7", finished: at(11) } });
    // A drift check names no reads, and leaves them; an older apply does not replace newer facts.
    e = addToStateEdges(JSON.stringify(e), run("tf-drift", at(12), { app: { plan: same() } }), "d");
    expect(e.roots[0]).toMatchObject({ reads: EDGE_NETWORK, planned: { stage: "tf-drift", finished: at(12) } });
    e = addToStateEdges(JSON.stringify(e), run("tf-apply", at(8), { app: { plan: same(), reads: [{ upstream: "other", data: "o", outputs: "applied" }] } }), "old");
    expect(e.roots[0]).toMatchObject({ reads: EDGE_NETWORK, planned: { finished: at(12) } });
    // A root that failed to plan keeps its last plan and its reads.
    e = addToStateEdges(JSON.stringify(e), run("tf-apply", at(13), { app: { error: "boom", reads: [] } }), "f");
    expect(e.roots[0]).toMatchObject({ reads: EDGE_NETWORK, planned: { finished: at(12) } });
  });

  it("is written for a report with reads or an applied change, and not for one with neither", () => {
    expect(hasEdgeFacts(run("tf-plan", at(9), { app: { reads: READS_NETWORK } }))).toBe(true);
    expect(hasEdgeFacts(run("tf-apply", at(9), { network: { plan: changed() } }))).toBe(true);
    expect(hasEdgeFacts(run("tf-plan", at(9), { network: { plan: changed() } }))).toBe(false);
    expect(hasEdgeFacts(run("tf-apply", at(9), { network: { plan: same() } }))).toBe(false);
    expect(readStateEdges("{nope").roots).toEqual([]);
  });

  it("an edge is stale when the producer applied a change after the consumer's last plan", () => {
    let e = addToStateEdges(undefined, run("tf-apply", at(9), { network: { plan: changed() } }), "w1");
    e = addToStateEdges(JSON.stringify(e), run("tf-apply", at(10), { app: { plan: changed(), reads: READS_NETWORK } }), "w2");
    expect(edgesOf(e)).toMatchObject([{ consumer: "app", producer: "network", via: "terraform_remote_state", status: "current" }]);
    e = addToStateEdges(JSON.stringify(e), run("tf-apply", at(11), { network: { plan: changed() } }), "w3");
    expect(edgesOf(e)).toMatchObject([{ status: "stale", consumer_planned: { finished: at(10) }, producer_applied: { finished: at(11), path: "w3" } }]);
    e = addToStateEdges(JSON.stringify(e), run("tf-drift", at(12), { app: { plan: same(), reads: READS_NETWORK } }), "d");
    expect(edgesOf(e)[0].status).toBe("current");
    // A producer with no recorded change: unknown.
    expect(edgesOf(addToStateEdges(undefined, run("tf-plan", at(9), { app: { reads: READS_NETWORK } }), "p"))[0].status).toBe("unknown");
  });
});

/** A bucket in memory, keyed `<bucket>:<key>`. */
function bucket() {
  const objects = new Map<string, string>();
  const fetch: S3Fetch = async (url, init) => {
    const [, name, ...rest] = new URL(url).pathname.split("/");
    const key = `${name}:${decodeURIComponent(rest.join("/"))}`;
    if (init.method === "PUT") {
      objects.set(key, typeof init.body === "string" ? init.body : Buffer.from(init.body as Uint8Array).toString("utf-8"));
      return { ok: true, status: 200, text: async () => "" };
    }
    const body = objects.get(key);
    return { ok: body !== undefined, status: body === undefined ? 404 : 200, text: async () => body ?? "" };
  };
  return { objects, fetch, s3: new S3Client({ bucket: "acme-reports", endpoint: "http://minio:9000", region: "us-east-1", accessKeyId: "AK", secretAccessKey: "SK" }, fetch) };
}

describe("the cross-state edges on the estate page", () => {
  it("lists each consumer's reads with its last plan against the producer's last apply, stale after a producer-only apply", async () => {
    const { objects, fetch, s3 } = bucket();
    const reports = [
      run("tf-apply", at(9), { network: { plan: changed() } }, { commit: "a".repeat(40) }),
      run("tf-apply", at(10), { app: { plan: same(), reads: READS_NETWORK } }, { commit: "b".repeat(40), wave: 2 }),
      run("tf-apply", at(11), { network: { plan: changed() } }, { commit: "c".repeat(40) }),
    ];
    for (const r of reports) {
      const dir = tmp();
      writeReportDir(dir, r, new Map());
      await uploadReport(s3, dir, r, "reports", async () => {});
    }
    const file = JSON.parse(objects.get(`acme-reports:reports/${RUN.project}/edges.json`)!);
    expect(file.schema).toBe(EDGES_SCHEMA);
    const r = await estate(tmp(), { reports: { bucket: "s3://acme-reports", endpoint: "http://minio:9000", prefix: "reports" } }, { fetch, env: ENV, now: NOW });
    const edges = r.estate.projects[0].edges!;
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ consumer: "app", producer: "network", status: "stale", consumer_planned: { stage: "tf-apply", wave: 2, finished: at(10) }, producer_applied: { finished: at(11) } });
    expect(edges[0].producer_applied?.report).toBe(`${RUN.project}/2026/10/${"c".repeat(40)}/tf-apply-wave-1/report.html`);
    expect(validate(schema("estate.schema.json"), r.estate)).toEqual([]);
    const html = objects.get("acme-reports:reports/estate.html")!;
    expect(html).toContain('<h2 id="state-edges">Cross-state edges</h2>');
    expect(html).toContain('<tbody class="edges" data-root="app">');
    expect(html).toContain('data-edge="app network" data-status="stale"');
    expect(readInlineEstate(html)).toEqual(r.estate);
  });

  it("says no root reads another's state when none does, and escapes root names", () => {
    expect(renderEstateHtml(buildEstate([{ project: "p", reports: [] }], NOW))).toContain("No root reads another root's state");
    const bad = addToStateEdges(undefined, run("tf-plan", at(9), { "<b id=x>": { dependencies: ["</script><i>"] } }), "x");
    const html = renderEstateHtml(buildEstate([{ project: "p", reports: [], edges: bad }], NOW));
    expect(html).not.toContain("<b id=x>");
    expect(html).not.toContain("</script><i>");
  });
});
