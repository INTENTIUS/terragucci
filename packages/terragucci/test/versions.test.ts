import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { estate } from "../src/estate";
import { buildReport, type RootInput } from "../src/report/build";
import { buildEstate, readInlineEstate, renderEstateHtml } from "../src/report/estate";
import { S3Client, type S3Fetch } from "../src/report/s3";
import type { Report, ReportRootVersions } from "../src/report/schema";
import { uploadReport, writeReportDir } from "../src/report/store";
import { addToVersions, estateVersions, rootVersions, splitSource, VERSIONS_SCHEMA, versionsRoots, type VersionsRoot } from "../src/report/versions";
import { validate, type Json } from "../../../scripts/schema-check";
import { plan, RUN } from "./report-fixtures";
import { tmp } from "./helpers";

const SRC = join(import.meta.dirname, "../src/report");
const schema = (name: string): Json => JSON.parse(readFileSync(join(SRC, name), "utf-8"));
const GOLDEN = join(import.meta.dirname, "__golden__");

/** Compare with a golden file, rewriting it under UPDATE_GOLDEN. */
function golden(name: string, value: unknown): void {
  const text = JSON.stringify(value, null, 2) + "\n";
  const file = join(GOLDEN, name);
  if (process.env.UPDATE_GOLDEN) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  expect(text).toBe(readFileSync(file, "utf-8"));
}

const at = (h: number): string => `2026-10-07T${String(h).padStart(2, "0")}:00:00.000Z`;
const AWS = "registry.opentofu.org/hashicorp/aws";
const VPC = "registry.opentofu.org/acme/vpc/aws";
const TOFU = { name: "tofu", version: "1.10.6", pin: ".opentofu-version" };

const versions = (aws: string, vpc: string): ReportRootVersions => ({
  providers: [{ provider: AWS, version: aws }, { provider: "registry.opentofu.org/hashicorp/random", version: "3.6.3" }],
  modules: [{ call: "module.vpc", source: VPC, version: vpc }, { call: "module.vpc.module.nat", source: "git::https://example.com/acme/nat.git", version: "v0.4.0" }],
});

/** A tf-apply wave of `roots`, each applied unless named in `held`, each at the versions given for it. */
function wave(n: number, finished: string, roots: Record<string, ReportRootVersions>, opts: { held?: string[]; project?: string; commit?: string } = {}): Report {
  return buildReport({
    run: { ...RUN, project: opts.project ?? RUN.project, commit: opts.commit ?? RUN.commit, stage: "tf-apply", wave: n, finished },
    roots: Object.entries(roots).map(([path, v]): RootInput => ({ path, plan: plan([]), planner: "tofu", binary: TOFU, versions: v, ...(opts.held?.includes(path) ? {} : { applied: true }) })),
    waves: [{ number: n, roots: Object.keys(roots), approval: "not-required" }],
  });
}

describe("the versions a root's init leaves", () => {
  it("reads each locked provider and each remote module call, nested ones too, and leaves local calls out", () => {
    const dir = tmp();
    mkdirSync(join(dir, ".terraform", "modules"), { recursive: true });
    writeFileSync(join(dir, ".terraform.lock.hcl"), `provider "${AWS}" {\n  version     = "5.80.0"\n  constraints = "~> 5.0"\n  hashes = ["h1:x"]\n}\n\nprovider "registry.opentofu.org/hashicorp/random" {\n  version = "3.6.3"\n}\n`);
    writeFileSync(
      join(dir, ".terraform", "modules", "modules.json"),
      JSON.stringify({
        Modules: [
          { Key: "", Source: "", Dir: "." },
          { Key: "vpc", Source: VPC, Version: "1.2.0", Dir: ".terraform/modules/vpc" },
          { Key: "vpc.nat", Source: "git::https://example.com/acme/nat.git?ref=v0.4.0", Dir: ".terraform/modules/vpc.nat" },
          { Key: "app", Source: "./modules/app", Dir: "modules/app" },
          { Key: "dns", Source: "git::https://example.com/acme/dns.git", Dir: ".terraform/modules/dns" },
        ],
      }),
    );
    expect(rootVersions(dir)).toEqual({
      providers: [{ provider: AWS, version: "5.80.0" }, { provider: "registry.opentofu.org/hashicorp/random", version: "3.6.3" }],
      modules: [
        { call: "module.dns", source: "git::https://example.com/acme/dns.git" },
        { call: "module.vpc", source: VPC, version: "1.2.0" },
        { call: "module.vpc.module.nat", source: "git::https://example.com/acme/nat.git", version: "v0.4.0" },
      ],
    });
  });

  it("reads modules.json under TF_DATA_DIR, and names nothing when init wrote no file", () => {
    const dir = tmp();
    mkdirSync(join(dir, "data", "modules"), { recursive: true });
    writeFileSync(join(dir, "data", "modules", "modules.json"), JSON.stringify({ Modules: [{ Key: "vpc", Source: VPC, Version: "1.3.0" }] }));
    expect(rootVersions(dir, { TF_DATA_DIR: "data" }).modules).toEqual([{ call: "module.vpc", source: VPC, version: "1.3.0" }]);
    expect(rootVersions(dir)).toEqual({ providers: [], modules: [] });
    writeFileSync(join(dir, "data", "modules", "modules.json"), "{not json");
    expect(rootVersions(dir, { TF_DATA_DIR: join(dir, "data") }).modules).toEqual([]);
  });

  it("takes a source's ref, tag or version as its release, and keeps the source without its query", () => {
    expect(splitSource("git::https://x/y.git?ref=v1.2.0")).toEqual({ source: "git::https://x/y.git", version: "v1.2.0" });
    expect(splitSource("oci://registry.example.com/acme/vpc?tag=1.4.0")).toEqual({ source: "oci://registry.example.com/acme/vpc", version: "1.4.0" });
    expect(splitSource("git::https://x/y.git//sub?depth=1")).toEqual({ source: "git::https://x/y.git//sub" });
    expect(splitSource(VPC)).toEqual({ source: VPC });
  });

  it("is in the report only for a tf-apply wave's roots that applied", () => {
    const r = wave(1, at(9), { a: versions("5.80.0", "1.2.0"), b: versions("5.80.0", "1.2.0") }, { held: ["b"] });
    expect(r.roots.find((x) => x.path === "a")?.versions).toEqual(versions("5.80.0", "1.2.0"));
    expect(r.roots.find((x) => x.path === "b")?.versions).toBeUndefined();
    expect(versionsRoots(r, "p")).toEqual([{ root: "a", commit: RUN.commit, finished: at(9), wave: 1, path: "p", binary: TOFU, ...versions("5.80.0", "1.2.0") }]);
    const planned = buildReport({ run: RUN, roots: [{ path: "a", plan: plan([]), planner: "tofu", versions: versions("5.80.0", "1.2.0") }] });
    expect(planned.roots[0].versions).toBeUndefined();
    expect(versionsRoots(planned, "p")).toEqual([]);
    const failed = buildReport({ run: { ...RUN, stage: "tf-apply", wave: 1 }, roots: [{ path: "a", error: "init failed", planner: "tofu", applied: true, versions: versions("5.80.0", "1.2.0") }] });
    expect(failed.roots[0].versions).toBeUndefined();
    expect(validate(schema("report.schema.json"), r)).toEqual([]);
  });

  it("keeps each root's newest entry: an older wave's run does not replace a newer one", () => {
    const entry = (root: string, finished: string, vpc: string): VersionsRoot => ({ root, commit: "c", finished, path: `p-${finished}`, providers: [], modules: [{ call: "module.vpc", source: VPC, version: vpc }] });
    let v = addToVersions(undefined, [entry("b", at(9), "1.2.0"), entry("a", at(9), "1.2.0")]);
    expect(v.roots.map((r) => r.root)).toEqual(["a", "b"]);
    v = addToVersions(JSON.stringify(v), [entry("a", at(10), "1.3.0")]);
    expect(v.roots.find((r) => r.root === "a")?.modules[0].version).toBe("1.3.0");
    v = addToVersions(JSON.stringify(v), [entry("a", at(8), "1.1.0")]);
    expect(v.roots.find((r) => r.root === "a")?.modules[0].version).toBe("1.3.0");
    expect(addToVersions("{not json", []).roots).toEqual([]);
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
const CONFIG = { reports: { bucket: "s3://acme-reports", endpoint: "http://minio:9000", prefix: "reports" } };
const SHOP = "forgejo.example/acme/shop";

describe("the versions in the bucket and on the estate page", () => {
  it("an applied wave's upload writes the project's versions.json; a plan's does not", async () => {
    const { objects, s3 } = bucket();
    const [planned] = await upload(s3, [buildReport({ run: RUN, roots: [{ path: "a", plan: plan([]), planner: "tofu", versions: versions("5.80.0", "1.2.0") }] })]);
    expect(planned.versions).toBeUndefined();
    const [applied] = await upload(s3, [wave(1, at(9), { "envs/dev/orders": versions("5.80.0", "1.2.0"), "envs/dev/platform": versions("5.70.0", "1.2.0") })]);
    expect(applied.versions).toBe(`reports/${RUN.project}/versions.json`);
    const file = JSON.parse(objects.get(`acme-reports:reports/${RUN.project}/versions.json`)!);
    expect(file.schema).toBe(VERSIONS_SCHEMA);
    expect(validate(schema("versions.schema.json"), file)).toEqual([]);
    golden("versions.json", file);
  });

  it("rolls the estate up per module, provider and binary: the versions in use, newest first, and the roots on each", async () => {
    const { objects, fetch, s3 } = bucket();
    await upload(s3, [
      wave(1, at(8), { "envs/dev/orders": versions("5.80.0", "1.2.0"), "envs/prod/orders": versions("5.70.0", "1.2.0") }),
      wave(1, at(9), { app: versions("5.80.0", "1.10.0") }, { project: SHOP }),
    ]);
    const r = await estate(tmp(), CONFIG, { fetch, env: ENV, now: NOW });
    const v = r.estate.versions!;
    expect(v.modules.find((m) => m.source === VPC)?.versions).toEqual([
      // 1.10.0 is newer than 1.2.0: the numbers compare as numbers.
      { version: "1.10.0", roots: [{ project: SHOP, root: "app", call: "module.vpc" }] },
      { version: "1.2.0", roots: [{ project: RUN.project, root: "envs/dev/orders", call: "module.vpc" }, { project: RUN.project, root: "envs/prod/orders", call: "module.vpc" }] },
    ]);
    expect(v.providers.find((p) => p.provider === AWS)?.versions.map((x) => [x.version, x.roots.length])).toEqual([["5.80.0", 2], ["5.70.0", 1]]);
    expect(v.binaries).toEqual([{ binary: "tofu", versions: [{ version: "1.10.6", roots: [{ project: RUN.project, root: "envs/dev/orders" }, { project: RUN.project, root: "envs/prod/orders" }, { project: SHOP, root: "app" }] }] }]);
    expect(validate(schema("estate.schema.json"), r.estate)).toEqual([]);
    golden("estate-versions.json", v);
    const html = objects.get("acme-reports:reports/estate.html")!;
    expect(html).toContain('<h2 id="versions">Versions</h2>');
    expect(html).toContain(`<tbody class="ver" data-module="${VPC}" data-live="2">`);
    expect(html).toContain(`<tbody class="ver" data-provider="${AWS}" data-live="2">`);
    expect(html).toContain(`<tr data-version="1.2.0"><td><code>1.2.0</code></td><td>${RUN.project}: <code>envs/dev/orders</code> <small>module.vpc</small><br>${RUN.project}: <code>envs/prod/orders</code> <small>module.vpc</small></td></tr>`);
    expect(readInlineEstate(html)).toEqual(r.estate);
  });

  it("a finished rollout leaves one version of the module in the table", async () => {
    const { objects, fetch, s3 } = bucket();
    const roots = ["envs/dev/orders", "envs/prod/orders"];
    await upload(s3, [wave(1, at(8), Object.fromEntries(roots.map((r) => [r, versions("5.80.0", "1.2.0")])))]);
    const live = async (): Promise<string[]> => {
      const r = await estate(tmp(), CONFIG, { fetch, env: ENV, now: NOW });
      return r.estate.versions!.modules.find((m) => m.source === VPC)!.versions.map((x) => x.version!);
    };
    expect(await live()).toEqual(["1.2.0"]);
    // The rollout's first wave moves dev to 1.3.0: two versions are live.
    await upload(s3, [wave(1, at(9), { "envs/dev/orders": versions("5.80.0", "1.3.0") }, { commit: "a".repeat(40) })]);
    expect(await live()).toEqual(["1.3.0", "1.2.0"]);
    expect(objects.get("acme-reports:reports/estate.html")).toContain(`data-module="${VPC}" data-live="2"`);
    // Its last wave moves prod: one is left.
    await upload(s3, [wave(1, at(10), { "envs/prod/orders": versions("5.80.0", "1.3.0") }, { commit: "b".repeat(40) })]);
    expect(await live()).toEqual(["1.3.0"]);
    expect(objects.get("acme-reports:reports/estate.html")).toContain(`data-module="${VPC}" data-live="1"`);
  });

  it("says no apply recorded versions when no project has a versions report, and leaves the field out", () => {
    const e = buildEstate([{ project: "p", reports: [] }], NOW);
    expect(e.versions).toBeUndefined();
    expect(estateVersions([{ project: "p" }])).toBeUndefined();
    expect(renderEstateHtml(e)).toContain("No apply has recorded its versions yet.");
  });

  it("names a module whose source pins no release, and escapes what a versions report holds", () => {
    const root: VersionsRoot = { root: "r</script>", commit: "c", finished: at(9), path: "x", providers: [], modules: [{ call: "module.x", source: 'git::https://x/"><b>.git' }] };
    const e = buildEstate([{ project: "p", reports: [], versions: { schema: VERSIONS_SCHEMA, roots: [root] } }], NOW);
    expect(e.versions?.modules).toEqual([{ source: 'git::https://x/"><b>.git', versions: [{ roots: [{ project: "p", root: "r</script>", call: "module.x" }] }] }]);
    const html = renderEstateHtml(e);
    expect(html).toContain('<span class="none">no version in its source</span>');
    expect(html).not.toContain("</script><b>");
    expect(html).not.toContain("<b>.git");
    expect(readInlineEstate(html)).toEqual(e);
  });
});
