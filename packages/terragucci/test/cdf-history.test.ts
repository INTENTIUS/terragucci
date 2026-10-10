import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { liveHistoryArgs, parseLiveHistory, recordVersions, versionsLine, type HistoryRun } from "../src/cdf-history";
import { estate } from "../src/estate";
import { buildReport } from "../src/report/build";
import { buildHistory, changeRows, historyId, renderHistoryHtml } from "../src/report/history";
import { S3Client, type S3Fetch } from "../src/report/s3";
import type { Report, ReportRecordVersions } from "../src/report/schema";
import { uploadReport, writeReportDir } from "../src/report/store";
import { validate, type Json } from "../../../scripts/schema-check";
import { plan, rc, RUN } from "./report-fixtures";
import { tmp } from "./helpers";

const SRC = join(import.meta.dirname, "../src/report");
const schema = (name: string): Json => JSON.parse(readFileSync(join(SRC, name), "utf-8"));
const at = (h: number): string => `2026-10-10T${String(h).padStart(2, "0")}:00:00.000Z`;
const VALUE = "a-record-value-never-listed";

/** live-history -json, as choudoufu 0.25.0 prints it (internal/command/live_history.go). */
const liveJson = (n: number, store = "s3"): string =>
  JSON.stringify(
    {
      address: "terraform_data.app",
      estate: "prod",
      store,
      kept: store === "s3",
      versions: store === "s3" ? Array.from({ length: n }, (_, i) => ({ version_id: `v${n - i}`, last_modified: at(8 + n - i), current: i === 0, deleted: false })) : [],
    },
    null,
    2,
  );

const versions = (n: number): ReportRecordVersions => ({ ...parseLiveHistory(liveJson(n))!, read: at(8 + n) });

describe("choudoufu live-history", () => {
  it("runs live-history -json in the root, naming the estate and the address", async () => {
    const calls: { binary: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }[] = [];
    const exec: HistoryRun = async (binary, args, cwd, env) => {
      calls.push({ binary, args, cwd, env });
      return { code: 0, stdout: liveJson(3), stderr: "" };
    };
    const v = await recordVersions("/usr/local/bin/choudoufu", "/repo/estate", "terraform_data.app", "prod", { AWS_ROLE_ARN: "arn:aws:iam::1:role/reader" }, () => new Date(at(12)), exec);
    expect(calls).toEqual([{ binary: "/usr/local/bin/choudoufu", args: ["live-history", "-json", "-estate=prod", "terraform_data.app"], cwd: "/repo/estate", env: { AWS_ROLE_ARN: "arn:aws:iam::1:role/reader" } }]);
    expect(v).toEqual({
      kept: true,
      store: "s3",
      read: at(12),
      versions: [
        { version_id: "v3", last_modified: at(11), current: true, deleted: false },
        { version_id: "v2", last_modified: at(10), current: false, deleted: false },
        { version_id: "v1", last_modified: at(9), current: false, deleted: false },
      ],
    });
    expect(versionsLine(v)).toBe("3 versions");
    expect(liveHistoryArgs("a.b")).toEqual(["live-history", "-json", "a.b"]);
  });

  it("keeps a delete marker as deleted, and nothing but the version fields", () => {
    const text = JSON.stringify({ kept: true, store: "s3", versions: [{ version_id: "d", last_modified: at(9), current: true, deleted: true, body: VALUE }] });
    const v = parseLiveHistory(text)!;
    expect(v.versions).toEqual([{ version_id: "d", last_modified: at(9), current: true, deleted: true }]);
    expect(JSON.stringify(v)).not.toContain(VALUE);
    expect(parseLiveHistory("not json")).toBeUndefined();
    expect(parseLiveHistory(JSON.stringify({ versions: [] }))).toBeUndefined();
  });

  it.each(["kubernetes", "local"])("a %s record store keeps no past versions: that is said, and is not an error", async (store) => {
    const exec: HistoryRun = async () => ({ code: 0, stdout: liveJson(0, store), stderr: "" });
    const v = await recordVersions("choudoufu", "/r", "terraform_data.app", "prod", {}, () => new Date(at(9)), exec);
    expect(v).toEqual({ kept: false, store, versions: [], read: at(9) });
    expect(v.error).toBeUndefined();
    expect(versionsLine(v)).toBe(`the ${store} record store keeps no past versions`);
  });

  it("keeps live-history's error as it printed it when the identity cannot list versions", async () => {
    const printed = "\x1b[31m╷\x1b[0m\n│ Error: Cannot list the record's versions\n│\n│ AccessDenied: not authorized to perform: s3:ListBucketVersions\n╵";
    const exec: HistoryRun = async () => ({ code: 1, stdout: "", stderr: printed });
    const v = await recordVersions("choudoufu", "/r", "terraform_data.app", "prod", {}, () => new Date(at(9)), exec);
    expect(v).toEqual({ error: "╷\n│ Error: Cannot list the record's versions\n│\n│ AccessDenied: not authorized to perform: s3:ListBucketVersions\n╵", read: at(9) });
    expect(versionsLine(v)).toBe("not listed: ╷");
    const missing = await recordVersions("choudoufu", "/r", "a.b", undefined, {}, undefined, async () => ({ code: 127, stdout: "", stderr: "" }));
    expect(missing.error).toBe("choudoufu live-history exited 127");
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

/** Wave 1 of commit `n` applies the choudoufu root estate, changing terraform_data.app, whose record then has `n` versions. */
function applyOf(n: number, given?: ReportRecordVersions | null): Report {
  const listed = given === null ? undefined : (given ?? versions(n));
  const p = plan([rc("terraform_data.app", n === 1 ? ["create"] : ["update"], n === 1 ? null : { input: `${VALUE}-${n - 1}` }, { input: `${VALUE}-${n}` })], {
    planned_values: { root_module: { resources: [{ address: "terraform_data.app", mode: "managed", type: "terraform_data", name: "app", provider_name: "terraform.io/builtin/terraform", values: { input: `${VALUE}-${n}` } }] } },
  });
  return buildReport({
    run: { ...RUN, commit: String(n).repeat(40), stage: "tf-apply", wave: 1, binary: "choudoufu", finished: at(8 + n) },
    roots: [{ path: "estate", plan: p, planner: "tofu", applied: true, ...(listed ? { recordVersions: new Map([["terraform_data.app", listed]]) } : {}) }],
    waves: [{ number: 1, roots: ["estate"], approval: "not-required" }],
  });
}

const ENV = { AWS_ACCESS_KEY_ID: "AK", AWS_SECRET_ACCESS_KEY: "SK", AWS_REGION: "us-east-1" };
const config = { reports: { bucket: "s3://acme-reports", endpoint: "http://minio:9000", prefix: "reports" } };

describe("record versions in the report, the history and the estate page", () => {
  it("rides on the applied change in report.json and changes.json, which hold to their schemas", () => {
    const r = applyOf(2);
    expect(r.minor).toBe(32);
    expect(validate(schema("report.schema.json"), r as unknown as Json)).toEqual([]);
    expect(r.roots[0].applied_changes?.[0].record_versions?.versions?.map((v) => v.version_id)).toEqual(["v2", "v1"]);
    const rows = changeRows(r, "x");
    expect(rows[0].record_versions?.kept).toBe(true);
    expect(validate(schema("changes.schema.json"), { schema: "terragucci.changes/v1", changes: rows } as unknown as Json)).toEqual([]);
    expect(applyOf(1, null).roots[0].applied_changes?.[0].record_versions).toBeUndefined();
  });

  it("the history keeps the newest listing per address, and its page lists each version without a value", () => {
    const rows = [applyOf(3), applyOf(1), applyOf(2)].flatMap((r) => changeRows(r, `runs/${r.run.commit}`));
    const h = buildHistory([{ project: RUN.project, changes: rows }], undefined, new Date(at(20)));
    const app = h.resources[0];
    expect(app.record_versions?.versions?.map((v) => v.version_id)).toEqual(["v3", "v2", "v1"]);
    const html = renderHistoryHtml(h);
    expect(html).toContain('data-kept="true" data-versions="3"');
    expect(html.match(/<tr data-version=/g)).toHaveLength(3);
    expect(html).toContain('<tr data-version="v3"><td><time datetime="2026-10-10T11:00:00.000Z">2026-10-10T11:00:00.000Z</time></td><td><code>v3</code></td><td>current</td></tr>');
    expect(html).not.toContain(VALUE);
  });

  it("says a store keeps none, and shows an error as it was printed", () => {
    const none = applyOf(1, { kept: false, store: "kubernetes", versions: [], read: at(9) });
    const denied = applyOf(2, { error: "Error: Cannot list the record's versions\n\nAccessDenied <b>", read: at(10) });
    const page = (r: Report) => renderHistoryHtml(buildHistory([{ project: RUN.project, changes: changeRows(r, "x") }], undefined, new Date(at(20))));
    expect(page(none)).toContain("The kubernetes record store keeps no past versions");
    expect(page(none)).toContain('data-kept="false"');
    expect(page(denied)).toContain('data-kept="error"');
    expect(page(denied)).toContain("<pre class=\"none\">Error: Cannot list the record&#39;s versions\n\nAccessDenied &lt;b&gt;</pre>");
  });

  it("a record changed by three applies shows three versions on the estate page, linked to its history", async () => {
    const { objects, fetch, s3 } = bucket();
    for (const r of [applyOf(1), applyOf(2), applyOf(3)]) {
      const dir = tmp();
      writeReportDir(dir, r, new Map());
      await uploadReport(s3, dir, r, "reports", async () => {});
    }
    const res = await estate(tmp(), config, { fetch, env: ENV, now: new Date(at(20)) });
    const history = JSON.parse(objects.get("acme-reports:reports/history.json")!);
    expect(validate(schema("history.schema.json"), history)).toEqual([]);
    expect(validate(schema("estate.schema.json"), res.estate as unknown as Json)).toEqual([]);
    const id = historyId(RUN.project, "estate", "terraform_data.app");
    const app = history.resources.find((x: Json) => x.id === id);
    expect(app.record_versions.versions).toHaveLength(3);
    const resource = res.estate.projects[0].inventory!.roots[0].resources[0];
    expect(resource.record_versions).toEqual({ kept: true, count: 3 });
    const page = objects.get("acme-reports:reports/estate.html")!;
    expect(page).toContain(`<small class="versions" data-versions="3"><a href="history.html#${id}">3 versions</a></small>`);
    expect(page + objects.get("acme-reports:reports/history.html")!).not.toContain(VALUE);
  });
});
