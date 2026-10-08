// The plan note's diff: each group shows its plan as the binary printed it,
// each root its whole plan in a collapsed block, a long note cuts what it
// says it cut, and with a bucket the note links report.html and plan.txt.
// The fixture is a real `tofu show` (OpenTofu 1.12) of two terraform_data
// resources, one holding a sensitive variable the binary prints unmasked in
// the provider's `output` attribute.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildReport, planFiles, type RootInput } from "../src/report/build";
import { blockIs, diffFence, diffLines, planBlocks, scrubPlanText, sensitiveValues, unitBlocks } from "../src/report/plan-text";
import { S3Client, type S3Fetch } from "../src/report/s3";
import { artifactReportUrl, forgeOfEnv, reportLinks } from "../src/report/stage";
import { presignedLinks, writeReportDir } from "../src/report/store";
import { NOTE_LIMIT_FORGEJO, noteLimit, renderNote } from "../src/report/views";
import { RUN } from "./report-fixtures";
import { tmp } from "./helpers";

const FIX = join(import.meta.dirname, "fixtures/plan-text");
const SHOW = readFileSync(join(FIX, "show.txt"), "utf-8");
const PLAN = JSON.parse(readFileSync(join(FIX, "show.json"), "utf-8"));
const SECRET = "hunter2-very-secret";

const root = (path: string): RootInput => ({ path, plan: PLAN, planner: "tofu", files: planFiles(path) });

describe("the rendered plan, cut into blocks", () => {
  it("finds each resource's block by its address, with its nested lines and known-after-apply values", () => {
    const blocks = planBlocks(SHOW);
    expect(blocks.map((b) => b.header)).toEqual(["terraform_data.cfg will be updated in-place", "terraform_data.other must be replaced"]);
    const cfg = unitBlocks(SHOW, "terraform_data.cfg");
    expect(cfg.length).toBe(1);
    expect(cfg[0].lines.join("\n")).toContain('~ greeting = "hi" -> "hello"');
    expect(cfg[0].lines.join("\n")).toContain("} -> (known after apply)");
    expect(unitBlocks(SHOW, "terraform_data.cf")).toEqual([]);
    expect(blockIs(blocks[0], "terraform_data.cfg", "abcd1234")).toBe(false);
    // The outputs and the totals belong to no resource.
    expect(blocks.flatMap((b) => b.lines).some((l) => l.startsWith("Plan:") || l.includes("Changes to Outputs"))).toBe(false);
  });

  it("moves each change symbol to the first column, as Atlantis does, so the forge colours the lines", () => {
    expect(diffLines(['  ~ resource "a" "b" {', "      - 1,", "-/+ resource", "        id = 1", '  # a.b will be updated'])).toEqual([
      '~   resource "a" "b" {', "-       1,", "-/+ resource", "        id = 1", "  # a.b will be updated",
    ]);
    expect(diffFence(["a ```b"])).toBe("````diff\na ```b\n````\n");
  });

  it("masks every value the plan JSON marks sensitive, even where the binary printed it", () => {
    expect(SHOW).toContain(SECRET);
    expect(sensitiveValues(PLAN)).toContain(SECRET);
    const scrubbed = scrubPlanText(SHOW, PLAN);
    expect(scrubbed.text).not.toContain(SECRET);
    expect(scrubbed.text).toContain("- pw       = (sensitive value)");
    expect(scrubbed.values).toBeGreaterThan(0);
    // What is not sensitive stays.
    expect(scrubbed.text).toContain('~ greeting = "hi" -> "hello"');
  });
});

describe("the note's diff", () => {
  const scrubbed = scrubPlanText(SHOW, PLAN).text;
  const report = buildReport({ run: RUN, roots: [root("envs/dev/app"), root("envs/prod/app")] });
  const plans = new Map(report.roots.map((r) => [r.path, scrubbed]));

  it("a group shows its first root's diff with before and after values, once for its identical roots", () => {
    expect(report.groups.length).toBe(1);
    const note = renderNote(report, { reportUrl: "https://reports.example/run/report.html", plans });
    expect(note).toContain("As `envs/dev/app` plans it:");
    expect(note).toContain('```diff\n  # terraform_data.cfg will be updated in-place\n~   resource "terraform_data" "cfg" {');
    expect(note).toContain('~           greeting = "hi" -> "hello"');
    expect(note).toContain("Roots: `envs/dev/app`, `envs/prod/app`");
    expect(note).not.toContain(SECRET);
  });

  it("each root's whole plan is in a collapsed block with its totals, linking its plan.txt beside report.html", () => {
    const note = renderNote(report, { reportUrl: "https://reports.example/run/report.html", plans });
    expect(note).toContain("**Each root's plan:**");
    expect(note).toContain("<details><summary><code>envs/dev/app</code>: Plan: 1 to add, 1 to change, 1 to destroy.</summary>");
    expect(note).toContain("[plan.txt](https://reports.example/run/roots/envs/dev/app/plan.txt)");
    expect(note).toContain('~   g = "hi" -> "hello"');
    // The run's page holds the report as a download: no plan.txt link, and the artifact wording.
    const artifact = renderNote(report, { reportUrl: "https://forgejo.example/acme/infra/actions/runs/42", artifacts: true, plans });
    expect(artifact).not.toContain("[plan.txt]");
    expect(artifact).toContain("artifact of [this run]");
  });

  it("a long note cuts the whole plans and the diffs, and names what it cut; destroys stay", () => {
    const full = renderNote(report, { plans });
    const noPlans = full.length - 1200;
    const cut = renderNote(report, { plans, limit: noPlans });
    expect([...cut].length).toBeLessThanOrEqual(noPlans);
    expect(cut).toMatch(/\*\*Cut:\*\* this note leaves out the whole plans of (1 root|2 roots) \(/);
    expect(cut).toContain("```diff");
    for (const n of report.named.filter((x) => x.action === "replace")) expect(cut).toContain(`${n.root}: ${n.address}`);
    const tight = renderNote(report, { plans, limit: 1500 });
    expect([...tight].length).toBeLessThanOrEqual(1500);
    expect(tight).toContain("shows one group by attribute name, without the diff");
    expect(tight).not.toContain("```diff");
    expect(tight).toContain("envs/dev/app: terraform_data.other");
  });

  it("the largest whole plan goes first, so a small root's plan stays", () => {
    const big = scrubbed.replace("Plan: ", `${"        # padding\n".repeat(400)}Plan: `);
    const sized = new Map([["envs/dev/app", big], ["envs/prod/app", scrubbed]]);
    const full = renderNote(report, { plans: sized });
    const cut = renderNote(report, { plans: sized, limit: full.length - 1000 });
    expect(cut).toContain("the whole plans of 1 root ([`envs/dev/app`](roots/envs/dev/app/plan.txt))");
    expect(cut).toContain("<summary><code>envs/prod/app</code>");
    // The large root's diff goes before the small root's whole plan.
    const both = renderNote(report, { plans: sized, limit: 5000 });
    expect([...both].length).toBeLessThanOrEqual(5000);
    expect(both).toContain("shows one group by attribute name, without the diff");
    expect(both).toContain("<summary><code>envs/prod/app</code>");
  });

  it("writeReportDir gives the note the same text as plan.txt", () => {
    const dir = tmp();
    writeReportDir(dir, report, new Map(report.roots.map((r) => [r.path, { text: scrubbed, json: "{}\n" }])));
    const note = readFileSync(join(dir, "note.md"), "utf-8");
    expect(note).toContain('~           greeting = "hi" -> "hello"');
    expect(readFileSync(join(dir, "roots/envs/dev/app/plan.txt"), "utf-8")).toBe(scrubbed);
  });

  it("an instance group shows only its instance's block", () => {
    const one = buildReport({ run: RUN, roots: [root("envs/dev/app")] });
    expect(one.unit).toBe("instance");
    const note = renderNote(one, { plans: new Map([["envs/dev/app", scrubbed]]) });
    const group = note.split("#### ").find((s) => s.includes("1 instance of `terraform_data.cfg`"))!;
    expect(group).toContain("terraform_data.cfg will be updated in-place");
    expect(group).not.toContain("terraform_data.other must be replaced");
  });
});

describe("where the note sends a reader", () => {
  const report = buildReport({ run: RUN, roots: [root("envs/dev/app")] });
  const SLUICE = { GITHUB_SERVER_URL: "https://sluice.example", GITHUB_REPOSITORY: "acme/infra", GITHUB_RUN_ID: "run_jzb96v82nnh81wf5q776" };

  it("a runner whose runs keep no forge artifact gets no artifact wording, and no report link", () => {
    const page = "https://sluice.example/acme/infra/actions/runs/run_jzb96v82nnh81wf5q776";
    const links = reportLinks(report, { given: page, env: SLUICE });
    expect(links.note).toEqual({ runUrl: page });
    const note = renderNote(report, links.note);
    expect(note).not.toContain("artifact of");
    expect(note).toContain(`Planned in [this run](${page}), which keeps no report artifact`);
    expect(note).not.toContain("](report.html");
    expect(artifactReportUrl(SLUICE)).toBeUndefined();
    expect(reportLinks(report, { given: page, env: { ...SLUICE, GITHUB_RUN_ID: "42" } }).note).toEqual({ reportUrl: page, artifacts: true });
  });

  it("with a bucket and no reports.url, the note links report.html and plan.txt presigned, and says until when", async () => {
    const s3 = new S3Client({ bucket: "acme-reports", endpoint: "http://floci:4566", region: "us-east-1", accessKeyId: "AK", secretAccessKey: "SK" }, (async () => ({ ok: true, status: 200, text: async () => "" })) as S3Fetch);
    const now = new Date("2026-10-08T12:00:00Z");
    const links = await presignedLinks(s3, report, "reports", ["envs/dev/app"], 7 * 24 * 3600, now);
    expect(links.reportUrl).toMatch(/^http:\/\/floci:4566\/acme-reports\/reports\/forgejo\.example\/acme\/infra\/2026\/10\/[0-9a-f]+\/tf-plan\/report\.html\?X-Amz-/);
    expect(links.planUrls.get("envs/dev/app")).toMatch(/\/tf-plan\/roots\/envs\/dev\/app\/plan\.txt\?X-Amz-/);
    expect(links.expires).toBe("2026-10-15T12:00:00.000Z");
    const note = renderNote(report, { ...links, plans: new Map([["envs/dev/app", SHOW]]) });
    expect(note).toContain(`[Full report](${links.reportUrl})`);
    expect(note).toContain("The links to the bucket work until 2026-10-15 12:00 UTC.");
    expect(note).toContain(`[plan.txt](${links.planUrls.get("envs/dev/app")})`);
    expect(note).toContain(`${links.reportUrl}#group-`);
  });

  it("keeps to each forge's comment limit, less the lines the pipeline adds", () => {
    expect(noteLimit("github", report)).toBe(65_536 - 2 * "envs/dev/app".length - 400);
    expect(noteLimit("gitlab", report)).toBe(1_000_000 - 2 * "envs/dev/app".length - 400);
    expect(noteLimit("forgejo", report)).toBe(NOTE_LIMIT_FORGEJO - 2 * "envs/dev/app".length - 400);
    expect(forgeOfEnv({ CI_PROJECT_PATH: "a/b" })).toBe("gitlab");
    expect(forgeOfEnv({ FORGEJO_ACTIONS: "true" })).toBe("forgejo");
    expect(forgeOfEnv({})).toBe("github");
  });
});
