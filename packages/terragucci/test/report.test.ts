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
import { validateConfig } from "../src/config";
import { PLAN_KEYS, redactPlan } from "../src/report/redact";
import { S3Client, S3Error, s3FromEnv, sign, type S3Fetch } from "../src/report/s3";
import { REDACTED, type Report } from "../src/report/schema";
import { artifactReportUrl, preventDestroyIn, projectFromRemote, reportLinks, runFacts } from "../src/report/stage";
import { addToIndex, bucketReportUrl, copyToRun, INDEX_TRIES, indexEntry, renderIndexHtml, reportsBase, runPath, traceKey, updateIndex, uploadReport, writeReportDir } from "../src/report/store";
import { isArtifactPage, NOTE_FOOTER, renderGitLabTerraform, renderNote, renderText } from "../src/report/views";
import { TACO_NOTE_URL, TACO_PNG } from "../src/report/taco";
import { fixture200, plan, rc, RUN, smallFixture } from "./report-fixtures";
import { tmp, validate, write, type Json } from "./helpers";

const GOLDEN = join(import.meta.dirname, "__golden__/report.small.json");
const SCHEMA = JSON.parse(readFileSync(join(import.meta.dirname, "../src/report/report.schema.json"), "utf-8"));

const small = (): Report => buildReport({ run: RUN, roots: smallFixture(), waves: [{ number: 1, roots: ["envs/dev/orders", "envs/dev/search"] }, { number: 2, roots: ["envs/prod/orders", "envs/prod/search"] }] });

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

  it("the note ends with the small taco from the docs site, and the HTML carries it inline", () => {
    const note = renderNote(report);
    expect(note.endsWith(`\n${NOTE_FOOTER}\n`)).toBe(true);
    expect(NOTE_FOOTER).toBe(`<sub><img src="${TACO_NOTE_URL}" width="26" height="16" alt=""> Posted by [terragucci](https://intentius.io/terragucci/)</sub>`);
    const html = renderHtml(report);
    expect(html).toContain(`<link rel="icon" type="image/png" href="${TACO_PNG}">`);
    expect(html).toContain(`<h1 class="brand"><img class="taco" src="${TACO_PNG}" width="51" height="31" alt="">`);
    // A few hundred bytes, so the report stays one small file.
    expect(TACO_PNG.length).toBeLessThan(1200);
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

  it("covers every top-level key a binary prints: no secret survives in any of them", () => {
    const S = (n: string) => `SECRET-${n}`;
    const change = (n: string) => ({ actions: ["update"], before: { pw: S(`${n}-before`), name: "x" }, after: { pw: S(`${n}-after`), name: "x" }, before_sensitive: { pw: true }, after_sensitive: { pw: true } });
    const full: Record<string, unknown> = {
      format_version: "1.2",
      terraform_version: "1.14.0",
      variables: { pw: { value: S("variable") } },
      planned_values: { outputs: { o: { sensitive: true, value: S("planned-output") } }, root_module: { resources: [{ address: "a.b", values: { pw: S("planned") }, sensitive_values: { pw: true } }] } },
      resource_changes: [{ address: "a.b", change: change("resource-change") }],
      resource_drift: [{ address: "a.b", change: change("resource-drift") }],
      deferred_changes: [{ reason: "instance_count_unknown", resource_change: { address: "a.c", change: change("deferred") } }],
      action_invocations: [{ address: "action.x.y", type: "x", config_values: { token: S("action"), region: "us-east-1" }, config_sensitive: { token: true } }],
      output_changes: { o: { actions: ["update"], before: S("output-before"), after: S("output-after"), before_sensitive: true, after_sensitive: true } },
      prior_state: { values: { outputs: { o: { sensitive: true, value: S("prior-output") } }, root_module: { resources: [{ values: { pw: S("prior") }, sensitive_values: { pw: true } }] } } },
      configuration: { root_module: { variables: { pw: { sensitive: true, default: S("default") } } } },
      relevant_attributes: [{ resource: "a.b", attribute: ["pw"] }],
      checks: [{ address: { kind: "resource", name: "b", type: "a" }, status: "pass" }],
      applyable: true,
      complete: true,
      errored: false,
      timestamp: "2026-10-07T00:00:00Z",
    };
    expect(Object.keys(full).sort()).toEqual([...PLAN_KEYS.values, ...PLAN_KEYS.plain].sort());
    const r = redactPlan(full);
    expect(JSON.stringify(r.plan)).not.toContain("SECRET-");
    expect(JSON.stringify(r.plan)).toContain("us-east-1");
    expect(r.values).toBe(15);
    expect(Object.keys(r.plan as object).sort()).toEqual(Object.keys(full).sort());
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
          rc("aws_sqs_queue.found", ["update"], { max_message_size: 1048576 }, { max_message_size: 262144 }, { importing: { id: "q" } }),
          rc("ephemeral.aws_secretsmanager_secret_version.pw", ["read"], null, { secret_string: "x" }, { mode: "ephemeral" }),
        ]),
      }],
    });
    const changes = report.roots[0].changes;
    expect(changes.find((c) => c.address === "aws_db_instance.main")!.write_only).toEqual(["password_wo_version"]);
    expect(changes.some((c) => c.address.startsWith("ephemeral."))).toBe(false);
    expect(report.named).toEqual([
      { root: "a", address: "aws_s3_bucket.old", type: "aws_s3_bucket", action: "import" },
      { root: "a", address: "aws_sqs_queue.found", type: "aws_sqs_queue", action: "import" },
    ]);
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
    expect(note.endsWith(`${NOTE_FOOTER}\n`)).toBe(true);
  });
});

/** Every relative href in the HTML, without its fragment. */
const hrefs = (html: string): string[] => [...new Set([...html.matchAll(/href="([^"#][^"]*)"/g)].map((m) => m[1]).filter((h) => !/^(https?|data):/.test(h)))];

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

  it("with no static keys, assumes AWS_ROLE_ARN with the token in AWS_WEB_IDENTITY_TOKEN_FILE once, and signs with the session it got", async () => {
    const dir = tmp();
    const tokenFile = join(dir, "token");
    writeFileSync(tokenFile, "eyJ.token.sig\n");
    const env = { AWS_ROLE_ARN: "arn:aws:iam::123456789012:role/plan", AWS_WEB_IDENTITY_TOKEN_FILE: tokenFile, AWS_REGION: "eu-west-2" };
    const target = s3FromEnv({ bucket: "s3://acme-reports" }, env);
    expect(target).toMatchObject({ bucket: "acme-reports", region: "eu-west-2", webIdentity: { roleArn: env.AWS_ROLE_ARN, tokenFile, endpoint: "https://sts.eu-west-2.amazonaws.com" } });
    const calls: { url: string; init: Parameters<S3Fetch>[1] }[] = [];
    const fake: S3Fetch = async (url, init) => {
      calls.push({ url, init });
      if (url.startsWith("https://sts.")) {
        const xml = `<AssumeRoleWithWebIdentityResponse><AssumeRoleWithWebIdentityResult><Credentials><AccessKeyId>ASIAWEB</AccessKeyId><SecretAccessKey>web/secret</SecretAccessKey><SessionToken>tok&amp;en</SessionToken><Expiration>2999-01-01T00:00:00Z</Expiration></Credentials></AssumeRoleWithWebIdentityResult></AssumeRoleWithWebIdentityResponse>`;
        return { ok: true, status: 200, text: async () => xml };
      }
      return { ok: true, status: 200, text: async () => "" };
    };
    const s3 = new S3Client(target, fake);
    await s3.put("a.json", "{}", "application/json");
    await s3.put("b.json", "{}", "application/json");
    expect(calls.map((c) => c.url)).toEqual(["https://sts.eu-west-2.amazonaws.com/", "https://acme-reports.s3.eu-west-2.amazonaws.com/a.json", "https://acme-reports.s3.eu-west-2.amazonaws.com/b.json"]);
    const form = new URLSearchParams(calls[0].init.body as string);
    expect(Object.fromEntries(form)).toEqual({ Action: "AssumeRoleWithWebIdentity", Version: "2011-06-15", RoleArn: env.AWS_ROLE_ARN, RoleSessionName: "terragucci-report", WebIdentityToken: "eyJ.token.sig" });
    expect(calls[0].init.headers.authorization).toBeUndefined();
    expect(calls[1].init.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=ASIAWEB\/\d{8}\/eu-west-2\/s3\/aws4_request, /);
    expect(calls[1].init.headers["x-amz-security-token"]).toBe("tok&en");
  });

  it("picks reports.role, then static keys, then AWS_ROLE_ARN, and names what is missing", () => {
    const keys = { AWS_ACCESS_KEY_ID: "AK", AWS_SECRET_ACCESS_KEY: "SK" };
    const oidc = { AWS_ROLE_ARN: "arn:aws:iam::123456789012:role/plan", AWS_WEB_IDENTITY_TOKEN_FILE: "/tmp/t", AWS_ENDPOINT_URL: "http://floci:4566/" };
    const role = "arn:aws:iam::123456789012:role/reports";
    expect(s3FromEnv({ bucket: "b" }, { ...keys, ...oidc })).toMatchObject({ accessKeyId: "AK", endpoint: "http://floci:4566", region: "us-east-1" });
    expect(s3FromEnv({ bucket: "b" }, oidc)).toMatchObject({ webIdentity: { roleArn: oidc.AWS_ROLE_ARN, endpoint: "http://floci:4566" } });
    expect(s3FromEnv({ bucket: "b", role }, { ...keys, ...oidc })).toMatchObject({ webIdentity: { roleArn: role } });
    expect(s3FromEnv({ bucket: "b" }, { ...oidc, AWS_ENDPOINT_URL_STS: "https://sts.example" })).toMatchObject({ webIdentity: { endpoint: "https://sts.example" } });
    expect(() => s3FromEnv({ bucket: "b", role }, keys)).toThrow(/reports.role is set, but AWS_WEB_IDENTITY_TOKEN_FILE is not/);
    expect(() => s3FromEnv({ bucket: "b" }, { AWS_ROLE_ARN: oidc.AWS_ROLE_ARN })).toThrow(/AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY, or AWS_ROLE_ARN and AWS_WEB_IDENTITY_TOKEN_FILE/);
    expect(() => s3FromEnv({ bucket: "b" }, { AWS_ACCESS_KEY_ID: "", AWS_SECRET_ACCESS_KEY: "" })).toThrow(S3Error);
  });

  it("a refused web identity names STS's error, and the next request asks again", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "token"), "t");
    let sts = 0;
    const fake: S3Fetch = async () => {
      sts++;
      return { ok: false, status: 403, text: async () => "<ErrorResponse><Error><Code>AccessDenied</Code><Message>Not authorized to perform sts:AssumeRoleWithWebIdentity</Message></Error></ErrorResponse>" };
    };
    const s3 = new S3Client(s3FromEnv({ bucket: "b" }, { AWS_ROLE_ARN: "arn:aws:iam::123456789012:role/plan", AWS_WEB_IDENTITY_TOKEN_FILE: join(dir, "token") }), fake);
    await expect(s3.get("x")).rejects.toThrow("AssumeRoleWithWebIdentity for arn:aws:iam::123456789012:role/plan: 403 AccessDenied: Not authorized to perform sts:AssumeRoleWithWebIdentity");
    await expect(s3.get("x")).rejects.toThrow(/AccessDenied/);
    expect(sts).toBe(2);
    const missing = new S3Client(s3FromEnv({ bucket: "b" }, { AWS_ROLE_ARN: "arn:aws:iam::123456789012:role/plan", AWS_WEB_IDENTITY_TOKEN_FILE: join(dir, "absent") }), fake);
    await expect(missing.get("x")).rejects.toThrow(/cannot read the OIDC token/);
  });

  it("reports.role is a role ARN of its own", () => {
    const role = "arn:aws:iam::123456789012:role/terragucci-reports";
    expect(validateConfig({ reports: { bucket: "s3://b", role } }, "t").reports?.role).toBe(role);
    expect(() => validateConfig({ reports: { bucket: "s3://b", role: "reports" } }, "t")).toThrow(/reports.role must be an AWS role ARN/);
    expect(() => validateConfig({ oidc: { plan_role: role, apply_role: "arn:aws:iam::123456789012:role/apply" }, reports: { bucket: "s3://b", role } }, "t")).toThrow(/reports.role is a job's own role/);
  });

  it("runs uploading at once each keep their row: the index is written If-Match the copy read, and read again when another run wrote it", async () => {
    // A store with S3's conditional writes: an ETag per object, 412 on a stale If-Match or an If-None-Match on an object that exists.
    const objects = new Map<string, { body: string; etag: string }>();
    let n = 0;
    const refused: string[] = [];
    // Every run reads the project's index before any writes it, so all but one write lose the first time.
    const PROJECT_INDEX = "reports/forgejo.example/acme/infra/index.json";
    let firstReads = 0;
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const fake: S3Fetch = async (url, init) => {
      const key = decodeURIComponent(new URL(url).pathname.replace(/^\/acme-reports\//, ""));
      if (init.method === "GET" && key === PROJECT_INDEX && firstReads < 6) {
        if (++firstReads === 6) open();
        await gate;
      }
      await new Promise((r) => setTimeout(r, Math.random() * 3));
      const held = objects.get(key);
      const headers = (etag?: string) => ({ get: (h: string) => (h === "etag" ? etag ?? null : null) });
      if (init.method === "GET") return held ? { ok: true, status: 200, text: async () => held.body, headers: headers(held.etag) } : { ok: false, status: 404, text: async () => "", headers: headers() };
      const ifMatch = init.headers["if-match"];
      const ifNone = init.headers["if-none-match"];
      if ((ifMatch !== undefined && ifMatch !== held?.etag) || (ifNone === "*" && held)) {
        refused.push(key);
        return { ok: false, status: 412, text: async () => "PreconditionFailed", headers: headers() };
      }
      const etag = `"${++n}"`;
      objects.set(key, { body: Buffer.from(init.body as Uint8Array).toString("utf-8"), etag });
      return { ok: true, status: 200, text: async () => "", headers: headers(etag) };
    };
    const runs = Array.from({ length: 6 }, (_, i) => buildReport({ run: { ...RUN, commit: String(i).repeat(40), finished: `2026-10-05T09:00:0${i}.000Z` }, roots: smallFixture() }));
    const noWait = async () => {};
    await Promise.all(runs.map((r) => {
      const dir = tmp();
      writeReportDir(dir, r, plans(r));
      return uploadReport(new S3Client({ bucket: "acme-reports", endpoint: "http://minio:9000", region: "us-east-1", accessKeyId: "AK", secretAccessKey: "SK" }, fake), dir, r, "reports", noWait);
    }));
    expect(refused.filter((k) => k === PROJECT_INDEX).length).toBeGreaterThanOrEqual(5);
    for (const at of ["reports/forgejo.example/acme/infra", "reports"]) {
      const index = JSON.parse(objects.get(`${at}/index.json`)!.body);
      expect(index.reports.map((r: Json) => r.commit).sort()).toEqual(runs.map((r) => r.run.commit).sort());
      const html = objects.get(`${at}/index.html`)!.body;
      for (const r of runs) expect(html).toContain(r.run.commit.slice(0, 12));
    }
  });

  it("an index another run keeps rewriting fails the upload by name after INDEX_TRIES tries, and a store with no ETags is written once", async () => {
    let puts = 0;
    const busy: S3Fetch = async (_url, init) => {
      if (init.method === "GET") return { ok: true, status: 200, text: async () => JSON.stringify({ reports: [] }), headers: { get: (h: string) => (h === "etag" ? `"${puts}"` : null) } };
      puts++;
      return { ok: false, status: 412, text: async () => "", headers: { get: () => null } };
    };
    const target = { bucket: "acme-reports", endpoint: "http://minio:9000", region: "us-east-1", accessKeyId: "AK", secretAccessKey: "SK" };
    const waits: number[] = [];
    await expect(updateIndex(new S3Client(target, busy), "reports/index.json", indexEntry(small(), "x"), async (a) => void waits.push(a))).rejects.toThrow(`reports/index.json changed under this run ${INDEX_TRIES} times in a row`);
    expect(puts).toBe(INDEX_TRIES);
    expect(waits).toEqual(Array.from({ length: INDEX_TRIES - 1 }, (_, i) => i + 1));

    const sent: Record<string, string>[] = [];
    const plain: S3Fetch = async (_url, init) => {
      if (init.method === "PUT") sent.push(init.headers);
      return init.method === "GET" ? { ok: true, status: 200, text: async () => "{}" } : { ok: true, status: 200, text: async () => "" };
    };
    await updateIndex(new S3Client(target, plain), "reports/index.json", indexEntry(small(), "x"));
    expect(sent.length).toBe(1);
    expect(sent[0]["if-match"]).toBeUndefined();
    expect(sent[0]["if-none-match"]).toBeUndefined();
  });

  it("a store that answers a conditional write with 501 is written without the condition from then on", async () => {
    const sent: Record<string, string>[] = [];
    const fake: S3Fetch = async (_url, init) => {
      if (init.method === "GET") return { ok: false, status: 404, text: async () => "" };
      sent.push(init.headers);
      return init.headers["if-none-match"] ? { ok: false, status: 501, text: async () => "NotImplemented" } : { ok: true, status: 200, text: async () => "" };
    };
    const s3 = new S3Client({ bucket: "b", endpoint: "http://gcs:9000", region: "us-east-1", accessKeyId: "AK", secretAccessKey: "SK" }, fake);
    await updateIndex(s3, "index.json", indexEntry(small(), "x"));
    await updateIndex(s3, "index.json", indexEntry(small(), "y"));
    expect(sent.map((h) => h["if-none-match"] ?? "-")).toEqual(["*", "-", "-"]);
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

  it("a wave's job keeps its report as an artifact, so with no bucket address its note links that", () => {
    expect(artifactReportUrl({ CI_JOB_URL: "https://gitlab.example/acme/infra/-/jobs/8" })).toBe("https://gitlab.example/acme/infra/-/jobs/8/artifacts/file/terragucci-report/report.html");
    expect(artifactReportUrl({ GITHUB_SERVER_URL: "https://forgejo.example/", GITHUB_REPOSITORY: "acme/infra", GITHUB_RUN_ID: "42" })).toBe(RUN_PAGE);
    expect(artifactReportUrl({})).toBeUndefined();
    const wave = { ...small(), run: { ...RUN, stage: "tf-apply" as const, wave: 2 } };
    expect(reportLinks(wave, { given: artifactReportUrl({ GITHUB_SERVER_URL: "https://forgejo.example", GITHUB_REPOSITORY: "acme/infra", GITHUB_RUN_ID: "42" }) }).note).toEqual({ reportUrl: RUN_PAGE, artifacts: true });
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
