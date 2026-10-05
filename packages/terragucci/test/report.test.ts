import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { composeChangeSet } from "@intentius/chant/change-set";
import { groupChangeSet, renderPlanSummaryText } from "@intentius/chant/plan-summary";
import { terraformChangeSetPart } from "@intentius/chant-lexicon-terraform/change-set";
import { terraformPlanDigest } from "@intentius/chant-lexicon-terraform/plan-digest";
import { describe, expect, it } from "vitest";
import { buildReport, planFiles } from "../src/report/build";
import { changeKind, foldChange, HIGHLIGHTS } from "../src/report/highlight";
import { readInlineReport, renderHtml } from "../src/report/html";
import { redactPlan } from "../src/report/redact";
import { S3Client, sign, type S3Fetch } from "../src/report/s3";
import { REDACTED, type Report } from "../src/report/schema";
import { preventDestroyIn, projectFromRemote, reportLinks, runFacts } from "../src/report/stage";
import { addToIndex, bucketReportUrl, copyToRun, indexEntry, renderIndexHtml, reportsBase, runPath, traceKey, uploadReport, writeReportDir } from "../src/report/store";
import { isArtifactPage, renderGitLabTerraform, renderNote, renderText } from "../src/report/views";
import { fixture200, plan, rc, RUN, smallFixture } from "./report-fixtures";
import { tmp, write } from "./helpers";

const GOLDEN = join(import.meta.dirname, "__golden__/report.small.json");
const SCHEMA = JSON.parse(readFileSync(join(import.meta.dirname, "../src/report/report.schema.json"), "utf-8"));

const small = (): Report => buildReport({ run: RUN, roots: smallFixture(), waves: [{ number: 1, roots: ["envs/dev/orders", "envs/dev/search"] }, { number: 2, roots: ["envs/prod/orders", "envs/prod/search"] }] });

/** Enough of JSON Schema for this one: type, const, enum, required, properties, items, additionalProperties and local $ref. */
function validate(schema: Json, value: unknown, at = "$", root: Json = schema): string[] {
  if (typeof schema.$ref === "string") return validate(root.$defs[(schema.$ref as string).split("/").pop()!], value, at, root);
  const errs: string[] = [];
  const types = schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
  const typeOf = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v);
  if (types.length && !types.some((t: string) => t === typeOf(value) || (t === "number" && typeof value === "number"))) return [`${at}: ${typeOf(value)} is not ${types.join("|")}`];
  if ("const" in schema && JSON.stringify(schema.const) !== JSON.stringify(value)) errs.push(`${at}: not ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value)) errs.push(`${at}: ${JSON.stringify(value)} not in enum`);
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const k of schema.required ?? []) if (!(k in (value as Json))) errs.push(`${at}: missing ${k}`);
    for (const [k, v] of Object.entries(value as Json)) {
      const sub = schema.properties?.[k] ?? schema.additionalProperties;
      if (sub && typeof sub === "object") errs.push(...validate(sub, v, `${at}.${k}`, root));
      else if (schema.properties && !schema.additionalProperties) errs.push(`${at}: ${k} is not in the schema`);
    }
  }
  if (Array.isArray(value) && schema.items) value.forEach((v, i) => errs.push(...validate(schema.items, v, `${at}[${i}]`, root)));
  return errs;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

describe("terragucci.report/v1", () => {
  it("matches its golden and its JSON Schema", () => {
    const report = small();
    const text = JSON.stringify(report, null, 2) + "\n";
    if (process.env.UPDATE_GOLDEN) {
      mkdirSync(dirname(GOLDEN), { recursive: true });
      writeFileSync(GOLDEN, text);
    }
    expect(text).toBe(readFileSync(GOLDEN, "utf-8"));
    expect(validate(SCHEMA, report)).toEqual([]);
  });

  it("the schema refuses a report missing a field or with a field it does not know", () => {
    const { named: _named, ...missing } = small();
    expect(validate(SCHEMA, missing)).toContain("$: missing named");
    expect(validate(SCHEMA, { ...small(), surprise: 1 })).toContain("$: surprise is not in the schema");
  });

  it("names every destroy, replacement and refusal, and none is folded into a group", () => {
    const report = small();
    expect(report.named.map((n) => [n.action, n.root, n.address])).toEqual([
      ["refused", "envs/prod/search", undefined],
      ["delete", "envs/prod/orders", "aws_db_instance.main"],
    ]);
    expect(report.roots.find((r) => r.path === "envs/prod/search")).toMatchObject({ status: "failed", plan_digest: null, fold: "open" });
  });

  it("the change set digest is chant's, over the unredacted plans", () => {
    const roots = smallFixture();
    const parts = roots.filter((r) => r.plan).map((r) => terraformChangeSetPart({ member: r.path, plan: r.plan, planner: "tofu" }));
    const orders = roots.find((r) => r.path === "envs/prod/orders")!;
    expect(small().roots.find((r) => r.path === "envs/prod/orders")!.plan_digest).toBe(terraformPlanDigest(orders.plan));
    expect(parts.length).toBe(3);
  });

  it("gives each wave chant's set digest, and none to a wave with a root that refused", () => {
    const w = small().waves;
    expect(w[0].set_digest).toMatch(/^jcs1-sha256:/);
    expect(w[1].set_digest).toBeNull();
  });
});

describe("every view renders from the JSON alone", () => {
  const report = small();
  const fromJson = JSON.parse(JSON.stringify(report)) as Report;

  it("the text view is chant's grouped summary of the same plans", () => {
    const doc = composeChangeSet(smallFixture().map((r) => (r.plan ? terraformChangeSetPart({ member: r.path, plan: r.plan, planner: "tofu" }) : {
      member: { member: r.path, lexicon: "terraform", planner: "tofu" as const, status: "failed" as const, error: r.error, planDigest: null, holes: [] }, entries: [],
    })));
    expect(renderText(fromJson)).toBe(renderPlanSummaryText(groupChangeSet(doc)));
  });

  it("note, HTML and GitLab counts are the same from the parsed JSON", () => {
    expect(renderNote(fromJson)).toBe(renderNote(report));
    expect(renderHtml(fromJson)).toBe(renderHtml(report));
    expect(renderGitLabTerraform(fromJson)).toEqual({ create: 0, update: 4, delete: 1 });
  });

  it("the note links each group to its anchor and each destroy to its root", () => {
    const note = renderNote(report, { reportUrl: "https://ci/a/report.html" });
    for (const g of report.groups) expect(note).toContain(`(https://ci/a/report.html#group-${g.id})`);
    expect(note).toContain("(https://ci/a/report.html#root-envs/prod/orders) (destroy)");
    expect(note).toContain("(https://ci/a/report.html#root-envs/prod/search) (refused to plan)");
  });
});

describe("the inline JSON", () => {
  it("is read back by finding the script tag, with no HTML parser", () => {
    const report = small();
    expect(readInlineReport(renderHtml(report))).toEqual(report);
  });

  it("the documented sed line gets it out of the file", () => {
    const dir = tmp();
    const report = small();
    report.roots[0].changes[0].attributes.push({ path: "evil", after: "</script><script>alert(1)</script><!--" });
    writeFileSync(join(dir, "report.html"), renderHtml(report));
    const out = execFileSync("sh", ["-c", `sed -n '/id="terragucci-report"/,/<\\/script>/p' report.html | sed '1d;$d'`], { cwd: dir, encoding: "utf-8" });
    expect(JSON.parse(out)).toEqual(report);
  });
});

describe("redaction", () => {
  it("replaces every value a plan marks sensitive, and the digest is taken before", () => {
    const p = plan([rc("aws_db_instance.main", ["update"], { password: "old", tags: { a: ["x", "y"] } }, { password: "new", tags: { a: ["x", "z"] } }, { before_sensitive: { password: true, tags: { a: [false, true] } }, after_sensitive: { password: true } })], {
      output_changes: { dsn: { actions: ["update"], before: "dsn-a", after: "dsn-b", before_sensitive: true, after_sensitive: true } },
      variables: { pw: { value: "secret" }, region: { value: "us-east-1" } },
      prior_state: { values: { outputs: { dsn: { sensitive: true, value: "dsn-a" } }, root_module: { resources: [{ values: { password: "old" }, sensitive_values: { password: true } }], child_modules: [{ resources: [{ values: { k: "v" }, sensitive_values: { k: true } }] }] } } },
      configuration: { root_module: { variables: { pw: { sensitive: true, default: "secret" }, region: {} }, module_calls: { m: { module: { variables: { k: { sensitive: true, default: "v" } } } } } } },
    });
    const before = terraformPlanDigest(p);
    const r = redactPlan(p);
    const text = JSON.stringify(r.plan);
    for (const s of ['"old"', '"new"', '"y"', '"secret"', '"v"', '"dsn-a"', '"dsn-b"']) expect(text).not.toContain(s);
    expect(text).toContain('"us-east-1"');
    expect(text).toContain('"x"');
    expect(r.values).toBe(11);
    expect(terraformPlanDigest(p)).toBe(before);
    expect(JSON.stringify(p)).toContain('"old"');
  });

  it("the report says how many values it redacted, and its marker", () => {
    expect(buildReport({ run: RUN, roots: [], redacted: 3 }).redaction).toEqual({ marker: REDACTED, values: 3 });
  });
});

describe("the highlight table", () => {
  const examples: Record<string, string> = {
    aws_iam_role_policy: "IAM", google_project_iam_member: "IAM", azurerm_role_assignment: "IAM",
    aws_security_group: "security group", aws_vpc_security_group_ingress_rule: "security group", google_compute_firewall: "security group",
    aws_network_acl: "network ACL", aws_network_acl_rule: "network ACL",
    aws_kms_key: "KMS", google_kms_crypto_key: "KMS",
    aws_route53_record: "DNS", google_dns_record_set: "DNS", cloudflare_record: "DNS",
  };

  it.each(Object.entries(examples))("%s is highlighted, and says why", (type, why) => {
    const attributes = [{ path: "policy", before: "a", after: "b" }];
    const r = foldChange({ type, action: "update", attributes, kind: changeKind("update", attributes) });
    expect(r.fold).toBe("open");
    expect(r.why).toContain(why);
  });

  it("covers every rule in the table", () => {
    for (const rule of HIGHLIGHTS) expect(Object.keys(examples).some((t) => rule.match.test(t)), rule.why).toBe(true);
  });

  it.each(Object.keys(examples))("a tags-only change to %s stays folded", (type) => {
    const attributes = [{ path: "tags", before: { a: "1" }, after: { a: "2" } }, { path: "tags_all", before: { a: "1" }, after: { a: "2" } }];
    expect(foldChange({ type, action: "update", attributes, kind: changeKind("update", attributes) })).toEqual({ fold: "folded" });
  });

  it("description-only and known-after-apply-only updates fold; an ordinary update gets no reason", () => {
    expect(changeKind("update", [{ path: "description", before: "a", after: "b" }])).toBe("description");
    expect(changeKind("update", [{ path: "arn", unknown: true }])).toBe("unknown");
    expect(foldChange({ type: "aws_sqs_queue", action: "update", attributes: [{ path: "x" }] })).toEqual({ fold: "open" });
  });

  it("names the paths that forced a replacement, and prevent_destroy", () => {
    expect(foldChange({ type: "aws_db_instance", action: "replace", attributes: [], replace_paths: [["engine_version"], ["tags", "x"]] }).why).toBe("replaces, forced by engine_version, tags.x");
    expect(foldChange({ type: "aws_s3_bucket", action: "update", attributes: [{ path: "x" }] }, true).why).toBe("under prevent_destroy");
  });

  it("reads prevent_destroy from the root and the local modules it calls", () => {
    const repo = write(tmp(), {
      "envs/a/main.tf": 'module "m" {\n  source = "../../modules/m"\n}\nresource "aws_s3_bucket" "logs" {\n  lifecycle {\n    prevent_destroy = true\n  }\n}\nresource "aws_s3_bucket" "tmp" {}\n',
      "modules/m/main.tf": 'resource "aws_db_instance" "main" {\n  lifecycle { prevent_destroy = true }\n}\n',
    });
    expect([...preventDestroyIn(join(repo, "envs/a"))].sort()).toEqual(["aws_db_instance.main", "aws_s3_bucket.logs"]);
  });

  it("labels write-only versions, names imports apart from destroys, and leaves ephemeral values out", () => {
    const report = buildReport({
      run: RUN,
      roots: [{
        path: "a", planner: "tofu", plan: plan([
          rc("aws_db_instance.main", ["update"], { password_wo_version: 1 }, { password_wo_version: 2 }),
          rc("aws_s3_bucket.old", ["no-op"], { bucket: "old" }, { bucket: "old" }, { importing: { id: "old" } }),
          rc("ephemeral.aws_secretsmanager_secret_version.pw", ["read"], null, { secret_string: "x" }, { mode: "ephemeral" }),
        ]),
      }],
    });
    const changes = report.roots[0].changes;
    expect(changes.find((c) => c.address === "aws_db_instance.main")!.write_only).toEqual(["password_wo_version"]);
    expect(changes.some((c) => c.address.startsWith("ephemeral."))).toBe(false);
    expect(report.named).toEqual([{ root: "a", address: "aws_s3_bucket.old", type: "aws_s3_bucket", action: "import" }]);
  });
});

describe("the 200-root fixture", () => {
  const report = buildReport({ run: RUN, roots: fixture200() });

  it("folds the 180 identical roots into one group, with the outlier and failures apart", () => {
    const big = report.groups.find((g) => g.units.length === 180)!;
    expect(big.fold).toBe("folded");
    expect(report.roots.filter((r) => r.fold === "open").length).toBe(15 + 2 + 1 + 1 + 1);
    expect(report.named.filter((n) => n.action === "replace").length).toBe(15);
    expect(report.named.filter((n) => n.action === "delete").length).toBe(2);
    expect(report.named.filter((n) => n.action === "refused").length).toBe(1);
    expect(report.roots.find((r) => r.path === "envs/r198/app")!.why[0]).toMatch(/^outlier/);
  });

  it("the tags-only security group change stays folded, the IAM change is open", () => {
    const r000 = report.roots.find((r) => r.path === "envs/r000/app")!;
    expect(r000.changes.find((c) => c.type === "aws_security_group")).toMatchObject({ kind: "tags", fold: "folded" });
    expect(r000.highlights).toEqual([]);
    const r197 = report.roots.find((r) => r.path === "envs/r197/app")!;
    expect(r197.highlights.map((h) => h.why)).toEqual(["IAM: changes who may do what"]);
  });

  it("lists the attributes that differ between a group's roots", () => {
    const big = report.groups.find((g) => g.units.length === 180)!;
    expect(big.varies).toEqual([]);
    const mixed = buildReport({ run: RUN, roots: [0, 1].map((i) => ({ path: `r${i}`, planner: "tofu" as const, plan: plan([rc("aws_sqs_queue.jobs", ["update"], { name: `r${i}-jobs`, delay: 1 }, { name: `r${i}-jobs-x`, delay: 2 })]) })) });
    expect(mixed.groups[0].units.length).toBe(2);
    expect(mixed.groups[0].varies).toEqual([{ address: "aws_sqs_queue.jobs", paths: ["name"] }]);
  });

  it("makes a note under GitHub's cap and an HTML report under 2 MB", () => {
    expect([...renderNote(report)].length).toBeLessThan(65_536);
    expect(Buffer.byteLength(renderHtml(report))).toBeLessThan(2 * 1024 * 1024);
  });

  it("a note cut for space keeps every destroy and says what it left out", () => {
    const note = renderNote(report, { limit: 3000 });
    expect([...note].length).toBeLessThanOrEqual(3000);
    for (const n of report.named.filter((x) => x.action === "delete")) expect(note).toContain(`${n.root}: ${n.address}`);
    expect(note).toMatch(/\*\*Cut:\*\* this note leaves out/);
  });
});

/** Every relative href in the HTML, without its fragment. */
const hrefs = (html: string): string[] => [...new Set([...html.matchAll(/href="([^"#][^"]*)"/g)].map((m) => m[1]).filter((h) => !/^https?:/.test(h)))];

describe("where reports go", () => {
  const plans = (report: Report) => new Map(report.roots.map((r) => [r.path, { text: `plan of ${r.path}\n`, json: "{}\n" }]));

  it("every root's links resolve in the CI artifact", () => {
    const report = buildReport({ run: RUN, roots: fixture200() });
    const dir = tmp();
    writeReportDir(dir, report, plans(report));
    const html = readFileSync(join(dir, "report.html"), "utf-8");
    const links = hrefs(html);
    expect(links.length).toBe(199 * 2);
    for (const h of links) expect(existsSync(join(dir, h)), h).toBe(true);
    for (const r of report.roots.filter((x) => x.status === "planned")) {
      expect(r.plan).toEqual(planFiles(r.path));
      expect(r.job_url).toBe(RUN.job_url);
      expect(html).toContain(`id="root-${r.path}"`);
    }
  });

  it("copies the run to the bucket under its path, links resolve there, and a second run adds to the index", async () => {
    const objects = new Map<string, string>();
    const fake: S3Fetch = async (url, init) => {
      const key = decodeURIComponent(new URL(url).pathname.replace(/^\/reports-bucket\//, ""));
      expect(init.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AK\/\d{8}\/us-east-1\/s3\/aws4_request, SignedHeaders=/);
      if (init.method === "PUT") objects.set(key, Buffer.from(init.body as Uint8Array).toString("utf-8"));
      const body = objects.get(key);
      return { ok: init.method === "PUT" || body !== undefined, status: init.method === "PUT" ? 200 : body === undefined ? 404 : 200, text: async () => body ?? "" };
    };
    const s3 = new S3Client({ bucket: "reports-bucket", endpoint: "http://minio:9000", region: "us-east-1", accessKeyId: "AK", secretAccessKey: "SK" }, fake);
    const first = small();
    const dir1 = tmp();
    writeReportDir(dir1, first, plans(first));
    const up = await uploadReport(s3, dir1, first, "reports");
    expect(up.prefix).toBe(`reports/forgejo.example/acme/infra/2026/10/${RUN.commit}/tf-plan`);
    for (const h of hrefs(objects.get(`${up.prefix}/report.html`)!)) expect(objects.has(`${up.prefix}/${h}`), h).toBe(true);

    const second = buildReport({ run: { ...RUN, commit: "b".repeat(40), finished: "2026-10-05T09:00:00.000Z" }, roots: smallFixture() });
    const dir2 = tmp();
    writeReportDir(dir2, second, plans(second));
    await uploadReport(s3, dir2, second, "reports");

    const project = JSON.parse(objects.get("reports/forgejo.example/acme/infra/index.json")!);
    expect(project.reports.map((r: Json) => r.path)).toEqual([`2026/10/${"b".repeat(40)}/tf-plan`, `2026/10/${RUN.commit}/tf-plan`]);
    expect(project.reports[1].destroys).toEqual(["envs/prod/orders: aws_db_instance.main"]);
    const top = JSON.parse(objects.get("reports/index.json")!);
    expect(top.reports.length).toBe(2);
    for (const r of top.reports) expect(objects.has(`reports/${r.path}/report.html`)).toBe(true);
    const indexHtml = objects.get("reports/forgejo.example/acme/infra/index.html")!;
    for (const h of hrefs(indexHtml)) expect(objects.has(`reports/forgejo.example/acme/infra/${h}`), h).toBe(true);
  });

  it("a rerun replaces its own row instead of listing twice", () => {
    const e = indexEntry(small(), "x");
    const once = addToIndex(undefined, e);
    expect(addToIndex(JSON.stringify(once), e).reports.length).toBe(1);
    expect(addToIndex("not json", e).reports.length).toBe(1);
  });

  it("a wave's report goes under stage-wave-N", () => {
    expect(runPath({ ...small(), run: { ...RUN, stage: "tf-apply", wave: 2 } })).toBe(`2026/10/${RUN.commit}/tf-apply-wave-2`);
  });

  it("signs a request as AWS's Signature Version 4 example does", () => {
    // AWS's documented example: GET /test.txt from examplebucket with a Range header.
    const h = sign(
      { region: "us-east-1", accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" },
      "GET", "https://examplebucket.s3.amazonaws.com/test.txt", { Range: "bytes=0-9" },
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", new Date("2013-05-24T00:00:00Z"),
    );
    expect(h.authorization).toBe("AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41");
  });

  it("names the project from an https or ssh remote", () => {
    expect(projectFromRemote("https://github.com/acme/infra.git")).toBe("github.com/acme/infra");
    expect(projectFromRemote("git@gitlab.example:group/sub/infra.git")).toBe("gitlab.example/group/sub/infra");
    expect(projectFromRemote("http://forgejo:3000/me/example")).toBe("forgejo/me/example");
  });
});

describe("drill down from every view (#131)", () => {
  const TRACE = "0af7651916cd43dd8448eb211c80319c";
  const RUN_PAGE = "https://forgejo.example/acme/infra/actions/runs/42";
  const SERVED = { bucket: "s3://acme-reports", prefix: "reports", url: "https://reports.acme.example/" };
  const REPORT_HTML = `https://reports.acme.example/reports/forgejo.example/acme/infra/2026/10/${RUN.commit}/tf-plan/report.html`;

  /** An S3 store in a map, as the bucket tests use. */
  function store(): { objects: Map<string, string>; s3: S3Client } {
    const objects = new Map<string, string>();
    const fake: S3Fetch = async (url, init) => {
      const key = decodeURIComponent(new URL(url).pathname.replace(/^\/acme-reports\//, ""));
      if (init.method === "PUT") objects.set(key, Buffer.from(init.body as Uint8Array).toString("utf-8"));
      const body = objects.get(key);
      return { ok: init.method === "PUT" || body !== undefined, status: init.method === "PUT" ? 200 : body === undefined ? 404 : 200, text: async () => body ?? "" };
    };
    return { objects, s3: new S3Client({ bucket: "acme-reports", endpoint: "http://minio:9000", region: "us-east-1", accessKeyId: "AK", secretAccessKey: "SK" }, fake) };
  }

  it("with reports.url, the note links the bucket's report.html with its anchors, whatever URL the pipeline passed", () => {
    const report = small();
    const links = reportLinks(report, { reports: SERVED, given: RUN_PAGE });
    expect(links.run.report_url).toBe(REPORT_HTML);
    expect(links.note).toEqual({ reportUrl: REPORT_HTML });
    expect(bucketReportUrl(report, SERVED)).toBe(REPORT_HTML);
    const note = renderNote(report, links.note);
    expect(note).toContain(`[Full report](${REPORT_HTML})`);
    for (const g of report.groups) expect(note).toContain(`(${REPORT_HTML}#group-${g.id})`);
    expect(note).toContain(`(${REPORT_HTML}#root-envs/prod/orders) (destroy)`);
  });

  it("without reports.url, a bucket is never guessed: GitHub and Forgejo's note says the report is in the run's artifacts, with no anchors", () => {
    const report = small();
    const links = reportLinks(report, { reports: { bucket: "s3://acme-reports", prefix: "reports" }, given: RUN_PAGE });
    expect(links.run.report_url).toBeUndefined();
    expect(links.note).toEqual({ reportUrl: RUN_PAGE, artifacts: true });
    const note = renderNote(report, links.note);
    expect(note).toContain(`The full report is \`report.html\` in the \`terragucci-report\` artifact of [this run](${RUN_PAGE}).`);
    expect(note).not.toContain("[Full report]");
    expect(note).not.toContain(`${RUN_PAGE}#`);
    for (const g of report.groups) expect(note).toContain(`[Group ${g.id}](${RUN_PAGE})`);
    expect(reportsBase({ prefix: "reports" })).toBeUndefined();
  });

  it("GitLab's artifact file is report.html itself, so its note keeps the anchors", () => {
    const url = "https://gitlab.example/acme/infra/-/jobs/7/artifacts/file/terragucci-report/report.html";
    expect(isArtifactPage(url)).toBe(false);
    expect(isArtifactPage(RUN_PAGE)).toBe(true);
    const links = reportLinks(small(), { given: url });
    expect(links.note).toEqual({ reportUrl: url });
    expect(renderNote(small(), links.note)).toContain(`${url}#root-envs/prod/orders`);
  });

  it("a wave's report, given no URL, is absolute once reports.url is set", () => {
    const wave = { ...small(), run: { ...RUN, stage: "tf-apply" as const, wave: 2 } };
    const links = reportLinks(wave, { reports: SERVED });
    expect(links.note.reportUrl).toBe(`https://reports.acme.example/reports/forgejo.example/acme/infra/2026/10/${RUN.commit}/tf-apply-wave-2/report.html`);
    expect(renderNote(wave, links.note)).toContain(`[Full report](${links.note.reportUrl})`);
    expect(reportLinks(wave, {}).note).toEqual({});
  });

  it("report.json carries the trace id; report.html links the trace with telemetry.trace_url, and shows the id without it", () => {
    const traced = reportLinks(small(), { traceId: TRACE, traceUrl: "https://grafana.example/explore?trace={trace_id}" });
    expect(traced.run).toEqual({ trace_id: TRACE, trace_url: `https://grafana.example/explore?trace=${TRACE}` });
    const html = renderHtml({ ...small(), run: { ...RUN, ...traced.run } });
    expect(html).toContain(`<a href="https://grafana.example/explore?trace=${TRACE}" id="trace">trace</a>`);
    const bare = reportLinks(small(), { traceId: TRACE });
    expect(bare.run).toEqual({ trace_id: TRACE });
    expect(renderHtml({ ...small(), run: { ...RUN, ...bare.run } })).toContain(`trace <code id="trace">${TRACE}</code>`);
    expect(renderHtml(small())).not.toContain('id="trace"');
    expect(validate(SCHEMA, { ...small(), run: { ...RUN, ...traced.run, report_url: REPORT_HTML, commit_url: "https://x/c", pull_request: "7", pull_request_url: "https://x/p" } })).toEqual([]);
  });

  it("the run's facts link the commit, the pull request and the job on each forge", () => {
    const repo = tmp();
    const gh = runFacts(repo, { GITHUB_SERVER_URL: "https://github.com", GITHUB_REPOSITORY: "acme/infra", GITHUB_RUN_ID: "9", GITHUB_SHA: "abc123", TG_PR: "7" });
    expect(gh).toMatchObject({ project: "github.com/acme/infra", commit_url: "https://github.com/acme/infra/commit/abc123", pull_request: "7", pull_request_url: "https://github.com/acme/infra/pull/7", job_url: "https://github.com/acme/infra/actions/runs/9" });
    const fj = runFacts(repo, { GITHUB_SERVER_URL: "http://forgejo:3000", GITHUB_REPOSITORY: "me/example", GITHUB_SHA: "abc123", TG_PR: "7" }, "forgejo");
    expect(fj.pull_request_url).toBe("http://forgejo:3000/me/example/pulls/7");
    expect(runFacts(repo, { GITHUB_SERVER_URL: "http://forgejo:3000", GITHUB_REPOSITORY: "me/example", GITHUB_SHA: "abc123", TG_PR: "7", GITEA_ACTIONS: "true" }).pull_request_url).toBe("http://forgejo:3000/me/example/pulls/7");
    const gl = runFacts(repo, { CI_PROJECT_PATH: "acme/infra", CI_SERVER_HOST: "gitlab.example", CI_PROJECT_URL: "https://gitlab.example/acme/infra", CI_JOB_URL: "https://gitlab.example/acme/infra/-/jobs/5", CI_COMMIT_SHA: "abc123", TG_PR: "3" });
    expect(gl).toMatchObject({ commit_url: "https://gitlab.example/acme/infra/-/commit/abc123", pull_request_url: "https://gitlab.example/acme/infra/-/merge_requests/3", job_url: "https://gitlab.example/acme/infra/-/jobs/5" });
    // A push to main names no pull request, and a value that is not a number is never put in a URL.
    expect(runFacts(repo, { GITHUB_REPOSITORY: "acme/infra", GITHUB_SHA: "abc123" }).pull_request).toBeUndefined();
    expect(runFacts(repo, { GITHUB_REPOSITORY: "acme/infra", GITHUB_SHA: "abc123", TG_PR: "7/../x" }).pull_request_url).toBeUndefined();
  });

  it("index rows link the commit, the pull request, the job and the trace", () => {
    const report = { ...small(), run: { ...RUN, commit_url: "https://forgejo.example/acme/infra/commit/4f1a", pull_request: "7", pull_request_url: "https://forgejo.example/acme/infra/pulls/7", trace_url: `https://grafana.example/t/${TRACE}` } };
    const entry = indexEntry(report, "2026/10/x/tf-plan");
    expect(entry).toMatchObject({ commit_url: report.run.commit_url, pull_request: "7", pull_request_url: report.run.pull_request_url, job_url: RUN.job_url, trace_url: report.run.trace_url });
    const html = renderIndexHtml(addToIndex(undefined, entry), "Plan reports");
    for (const u of [report.run.commit_url, report.run.pull_request_url, RUN.job_url, report.run.trace_url]) expect(html).toContain(`href="${u}"`);
    expect(html).toContain(">#7</a>");
    // A row without them still renders, with no empty link.
    expect(renderIndexHtml(addToIndex(undefined, indexEntry({ ...small(), run: { ...RUN, job_url: undefined } }, "p")), "t")).not.toContain('href=""');
  });

  it("a traced run's upload writes the page a dashboard's trace row links, which leads to its report", async () => {
    const { objects, s3 } = store();
    const report = { ...small(), run: { ...RUN, trace_id: TRACE } };
    const dir = tmp();
    writeReportDir(dir, report, new Map());
    const up = await uploadReport(s3, dir, report, "reports");
    const page = objects.get(traceKey(TRACE, "reports"))!;
    expect(traceKey(TRACE, "reports")).toBe(`reports/traces/${TRACE}.html`);
    const target = /url=([^"]+)"/.exec(page)![1];
    // Resolved against reports/traces/, the redirect lands on the run's report.html.
    expect(new URL(target, "https://b/reports/traces/x.html").pathname).toBe(`/${up.prefix}/report.html`);
    expect(objects.has(`${up.prefix}/report.html`)).toBe(true);
    // An untraced run writes no trace page.
    const plain = store();
    await uploadReport(plain.s3, dir, small(), "reports");
    expect([...plain.objects.keys()].some((k) => k.includes("/traces/"))).toBe(false);
  });

  it("what respond changes after the upload reaches the bucket's copy", async () => {
    const { objects, s3 } = store();
    const report = small();
    const dir = tmp();
    writeReportDir(dir, report, new Map());
    const up = await uploadReport(s3, dir, report, "reports");
    writeFileSync(join(dir, "note.md"), "> flagged\n" + readFileSync(join(dir, "note.md"), "utf-8"));
    writeFileSync(join(dir, "intent.json"), "{}\n");
    const put = await copyToRun(s3, dir, report, ["note.md", "intent.json"], "reports");
    expect(put).toEqual([`${up.prefix}/note.md`, `${up.prefix}/intent.json`]);
    expect(objects.get(`${up.prefix}/note.md`)!.startsWith("> flagged")).toBe(true);
    expect(objects.get(`${up.prefix}/intent.json`)).toBe("{}\n");
  });
});
