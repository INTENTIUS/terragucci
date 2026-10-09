import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { estate } from "../src/estate";
import { buildReport } from "../src/report/build";
import { buildEstate, readInlineEstate, renderEstateHtml } from "../src/report/estate";
import { addToInventory, countTypes, INVENTORY_SCHEMA, inventoryRoots, planResources, type InventoryRoot } from "../src/report/inventory";
import { S3Client, type S3Fetch } from "../src/report/s3";
import type { Report } from "../src/report/schema";
import { uploadReport, writeReportDir } from "../src/report/store";
import { validate, type Json } from "../../../scripts/schema-check";
import { plan, rc, RUN } from "./report-fixtures";
import { tmp } from "./helpers";

const SECRET = "hunter2-do-not-store";
const SRC = join(import.meta.dirname, "../src/report");
const schema = (name: string): Json => JSON.parse(readFileSync(join(SRC, name), "utf-8"));

/** A plan whose planned values hold a secret: the password of a database in a module, marked sensitive. */
export function secretPlan(): Json {
  return plan(
    [rc("module.db.aws_db_instance.main", ["update"], { identifier: "orders", password: "old" }, { identifier: "orders", password: SECRET }, { before_sensitive: { password: true }, after_sensitive: { password: true } })],
    {
      planned_values: {
        root_module: {
          resources: [
            { address: "aws_s3_bucket.logs", mode: "managed", type: "aws_s3_bucket", name: "logs", provider_name: "registry.opentofu.org/hashicorp/aws", values: { bucket: "logs" }, sensitive_values: {} },
            { address: "data.aws_caller_identity.me", mode: "data", type: "aws_caller_identity", name: "me", provider_name: "registry.opentofu.org/hashicorp/aws", values: { account_id: "123" } },
          ],
          child_modules: [
            {
              address: "module.db",
              resources: [
                { address: "module.db.aws_db_instance.main", mode: "managed", type: "aws_db_instance", name: "main", provider_name: "registry.opentofu.org/hashicorp/aws", values: { identifier: "orders", password: SECRET }, sensitive_values: { password: true } },
                { address: "module.db.random_id.suffix", mode: "managed", type: "random_id", name: "suffix", provider_name: "registry.opentofu.org/hashicorp/random", values: { hex: SECRET } },
              ],
            },
          ],
        },
      },
    },
  );
}

const at = (h: number): string => `2026-10-07T${String(h).padStart(2, "0")}:00:00.000Z`;

/** A tf-apply wave of `roots`, each applied unless named in `held`. */
function wave(n: number, finished: string, roots: string[], opts: { held?: string[]; project?: string; commit?: string } = {}): Report {
  return buildReport({
    run: { ...RUN, project: opts.project ?? RUN.project, commit: opts.commit ?? RUN.commit, stage: "tf-apply", wave: n, finished },
    roots: roots.map((path) => ({ path, plan: secretPlan(), planner: "tofu" as const, ...(opts.held?.includes(path) ? {} : { applied: true }) })),
    waves: [{ number: n, roots, approval: "not-required" }],
  });
}

describe("the inventory a plan gives", () => {
  it("lists every managed resource in the planned values, child modules too, by address, type and provider, and leaves data sources out", () => {
    expect(planResources(secretPlan())).toEqual([
      { address: "aws_s3_bucket.logs", type: "aws_s3_bucket", provider: "registry.opentofu.org/hashicorp/aws" },
      { address: "module.db.aws_db_instance.main", type: "aws_db_instance", provider: "registry.opentofu.org/hashicorp/aws" },
      { address: "module.db.random_id.suffix", type: "random_id", provider: "registry.opentofu.org/hashicorp/random" },
    ]);
    expect(planResources({})).toEqual([]);
    expect(planResources(null)).toEqual([]);
  });

  it("never carries a value, sensitive or not", () => {
    const text = JSON.stringify(planResources(secretPlan()));
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain('"orders"');
  });

  it("is in the report only for a tf-apply wave's roots that applied", () => {
    const r = wave(1, at(9), ["a", "b"], { held: ["b"] });
    expect(r.roots.find((x) => x.path === "a")?.resources).toHaveLength(3);
    expect(r.roots.find((x) => x.path === "b")?.resources).toBeUndefined();
    expect(inventoryRoots(r, "p").map((x) => x.root)).toEqual(["a"]);
    const planned = buildReport({ run: RUN, roots: [{ path: "a", plan: secretPlan(), planner: "tofu" }] });
    expect(planned.roots[0].resources).toBeUndefined();
    expect(inventoryRoots(planned, "p")).toEqual([]);
    // A root that failed lists nothing, even when the wave says it applied.
    const failed = buildReport({ run: { ...RUN, stage: "tf-apply", wave: 1 }, roots: [{ path: "a", error: "init failed", planner: "tofu", applied: true }] });
    expect(failed.roots[0].resources).toBeUndefined();
  });

  it("keeps each root's newest list: an older wave's run does not replace a newer one", () => {
    const entry = (root: string, finished: string, address: string): InventoryRoot => ({ root, commit: "c", finished, path: `p-${finished}`, resources: [{ address, type: "t", provider: "p" }] });
    let inv = addToInventory(undefined, [entry("b", at(9), "t.one"), entry("a", at(9), "t.one")]);
    expect(inv.roots.map((r) => r.root)).toEqual(["a", "b"]);
    inv = addToInventory(JSON.stringify(inv), [entry("a", at(10), "t.two")]);
    expect(inv.roots.find((r) => r.root === "a")?.resources[0].address).toBe("t.two");
    inv = addToInventory(JSON.stringify(inv), [entry("a", at(8), "t.old")]);
    expect(inv.roots.find((r) => r.root === "a")?.resources[0].address).toBe("t.two");
    expect(addToInventory("{not json", []).roots).toEqual([]);
    expect(countTypes([{ address: "x.a", type: "x", provider: "" }, { address: "y.a", type: "y", provider: "" }, { address: "y.b", type: "y", provider: "" }])).toEqual([{ type: "y", count: 2 }, { type: "x", count: 1 }]);
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
  const s3 = new S3Client({ bucket: "acme-reports", endpoint: "http://minio:9000", region: "us-east-1", accessKeyId: "AK", secretAccessKey: "SK" }, fetch);
  return { objects, fetch, s3 };
}

async function upload(s3: S3Client, reports: Report[]) {
  const out = [];
  for (const r of reports) {
    const dir = tmp();
    writeReportDir(dir, r, new Map());
    out.push(await uploadReport(s3, dir, r, "reports", async () => {}));
  }
  return out;
}

const ENV = { AWS_ACCESS_KEY_ID: "AK", AWS_SECRET_ACCESS_KEY: "SK", AWS_REGION: "us-east-1" };
const NOW = new Date("2026-10-07T12:00:00.000Z");

describe("the inventory in the bucket and on the estate page", () => {
  it("an applied wave's upload writes the project's inventory.json; a plan's does not", async () => {
    const { objects, s3 } = bucket();
    const [planned] = await upload(s3, [buildReport({ run: RUN, roots: [{ path: "a", plan: secretPlan(), planner: "tofu" }] })]);
    expect(planned.inventory).toBeUndefined();
    const [applied] = await upload(s3, [wave(1, at(9), ["envs/dev/platform", "envs/dev/orders"])]);
    expect(applied.inventory).toBe(`reports/${RUN.project}/inventory.json`);
    const inv = JSON.parse(objects.get(`acme-reports:reports/${RUN.project}/inventory.json`)!);
    expect(inv.schema).toBe(INVENTORY_SCHEMA);
    expect(validate(schema("inventory.schema.json"), inv)).toEqual([]);
    expect(inv.roots.map((r: Json) => [r.root, r.wave, r.resources.length])).toEqual([["envs/dev/orders", 1, 3], ["envs/dev/platform", 1, 3]]);
    expect(inv.roots[0].path).toBe(`2026/10/${RUN.commit}/tf-apply-wave-1`);
  });

  it("lists every root's resources by project, root and type, with a filter box, and links each root's wave report", async () => {
    const { objects, fetch, s3 } = bucket();
    await upload(s3, [wave(1, at(9), ["envs/dev/platform"]), wave(2, at(10), ["envs/dev/orders", "envs/dev/search"], { held: ["envs/dev/search"] })]);
    const r = await estate(tmp(), { reports: { bucket: "s3://acme-reports", endpoint: "http://minio:9000", prefix: "reports" } }, { fetch, env: ENV, now: NOW });
    const p = r.estate.projects[0];
    expect(p.inventory?.roots.map((x) => [x.root, x.wave, x.resources.length])).toEqual([["envs/dev/orders", 2, 3], ["envs/dev/platform", 1, 3]]);
    expect(p.inventory?.resources).toBe(6);
    expect(p.inventory?.types).toEqual([{ type: "aws_db_instance", count: 2 }, { type: "aws_s3_bucket", count: 2 }, { type: "random_id", count: 2 }]);
    expect(p.inventory?.roots[0].report).toBe(`${RUN.project}/2026/10/${RUN.commit}/tf-apply-wave-2/report.html`);
    expect(r.estate.totals.resources).toBe(6);
    const html = objects.get("acme-reports:reports/estate.html")!;
    expect(html).toContain('<h2 id="resources">Resources</h2>');
    expect(html).toContain('id="resources-filter"');
    expect(html).toContain('<tbody class="inv" data-root="envs/dev/orders">');
    expect(html).toContain("<td><code>module.db.aws_db_instance.main</code></td><td><code>aws_db_instance</code></td><td>hashicorp/aws</td>");
    expect(html).toContain("<code>aws_db_instance</code> 2");
    expect(html).toContain("<b>6</b><span>resources</span>");
    expect(readInlineEstate(html)).toEqual(r.estate);
    expect(validate(schema("estate.schema.json"), r.estate)).toEqual([]);
    // The secret in the plans never reaches a stored object.
    for (const [k, v] of objects) if (!k.includes("/roots/")) expect(v, k).not.toContain(SECRET);
  });

  it("says no apply recorded resources when no project has an inventory, and leaves the total out", () => {
    const e = buildEstate([{ project: "p", reports: [] }], NOW);
    expect(e.totals.resources).toBeUndefined();
    expect(e.projects[0].inventory).toBeUndefined();
    expect(renderEstateHtml(e)).toContain("No apply has recorded its resources yet.");
  });

  it("escapes what an inventory holds", () => {
    const e = buildEstate([{ project: "p", reports: [], inventory: { schema: INVENTORY_SCHEMA, roots: [{ root: "r", commit: "c", finished: at(9), path: "x", resources: [{ address: 'a["</script><b>"]', type: "t", provider: "p" }] }] } }], NOW);
    const html = renderEstateHtml(e);
    expect(html).not.toContain("</script><b>");
    expect(readInlineEstate(html)).toEqual(e);
  });
});
