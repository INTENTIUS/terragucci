// choudoufu's cone plans (src/cone.ts): which plans pass -cone=<base>, what
// the plan's output and its FILE.cone.json say, the cone in the plan digest,
// and the line the plan note gives it. The stage runs a stand-in choudoufu
// that answers with recorded output, so no provider or state is needed.
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { terraformChangeSetPart } from "@intentius/chant-lexicon-terraform/change-set";
import { coneArgs, conePlanDigest, coneRoot, readPlanCone, type PlanCone } from "../src/cone";
import { buildReport } from "../src/report/build";
import { runStage } from "../src/report/stage";
import { coneLine, renderNote } from "../src/report/views";
import { validate } from "../../../scripts/schema-check";
import { git, tmp, write } from "./helpers";
import { plan, rc, RUN } from "./report-fixtures";

const SCHEMA = JSON.parse(readFileSync(join(import.meta.dirname, "../src/report/report.schema.json"), "utf-8"));

const LIVE = 'terraform {\n  live {\n    estate = "app"\n  }\n}\n';

/** The cone warning as choudoufu prints it with -no-color: the detail wrapped at the terminal's width. */
const CONE_WARNING = `
Warning: Cone plan

This plan covers the cone of the change since origin/main: 3 of the estate's
40 blocks (GitHub issue #1956). Drift and removals outside it are a full
plan's to report.
`;

const FALLBACK_WARNING = `
Warning: Cone plan fell back to a full plan

This plan covers the whole estate (guard provider-changed): a provider block
changed: aws.
`;

const RECORD = { schema: 1, base: "origin/main", base_sha: "0123abcd", targets: ["aws_sqs_queue.jobs", "aws_sqs_queue.dlq", "module.svc"] };

describe("coneArgs", () => {
  it("passes -cone=<base> to choudoufu on a live root with a base", () => {
    expect(coneArgs("choudoufu", "origin/main", ["-input=false", "-out=/w/0.tfplan"], true)).toEqual(["-cone=origin/main"]);
    expect(coneArgs("/usr/local/bin/choudoufu", "origin/main", [], true)).toEqual(["-cone=origin/main"]);
  });

  it("passes nothing to another binary, with no base, or on a root with no live block", () => {
    expect(coneArgs("tofu", "origin/main", [], true)).toEqual([]);
    expect(coneArgs("terraform", "origin/main", [], true)).toEqual([]);
    expect(coneArgs("choudoufu", undefined, [], true)).toEqual([]);
    expect(coneArgs("choudoufu", "origin/main", [], false)).toEqual([]);
  });

  it.each([["-target=aws_sqs_queue.jobs"], ["-target"], ["-exclude=module.svc"], ["-destroy"], ["-refresh-only"], ["-json"], ["-estate"], ["-estate=app"]])("passes nothing beside %s", (flag) => {
    expect(coneArgs("choudoufu", "origin/main", ["-input=false", flag], true)).toEqual([]);
  });

  it("does not take a flag that starts like an excluded one for it", () => {
    expect(coneArgs("choudoufu", "origin/main", ["-estate-outputs-from=net"], true)).toEqual(["-cone=origin/main"]);
  });
});

describe("coneRoot", () => {
  const repo = write(tmp(), {
    "live/main.tf": LIVE,
    "estate/main.tf": LIVE,
    "estate/estate.chdf.hcl": 'estate "app" {}\n',
    "plain/main.tf": 'resource "terraform_data" "x" {}\n',
  });
  it("takes a root under a live block, and not an estate file's or a state-backed root", () => {
    expect(coneRoot(repo, "live")).toBe(true);
    expect(coneRoot(repo, "estate")).toBe(false);
    expect(coneRoot(repo, "plain")).toBe(false);
  });
});

describe("readPlanCone", () => {
  const planFile = (record?: unknown): string => {
    const f = join(tmp(), "0.tfplan");
    writeFileSync(f, "");
    if (record !== undefined) writeFileSync(`${f}.cone.json`, typeof record === "string" ? record : JSON.stringify(record));
    return f;
  };

  it("reads the cone's size from the warning and its targets from the record", () => {
    expect(readPlanCone(`Plan: 0 to add, 1 to change, 0 to destroy.\n${CONE_WARNING}`, planFile(RECORD), "origin/main")).toEqual({
      base: "origin/main",
      blocks: 3,
      of: 40,
      record: { base: "origin/main", base_sha: "0123abcd", targets: ["aws_sqs_queue.dlq", "aws_sqs_queue.jobs", "module.svc"] },
    });
  });

  it("reads the record alone when no warning gives the size", () => {
    expect(readPlanCone("", planFile(RECORD), "origin/main")).toMatchObject({ base: "origin/main", record: { targets: ["aws_sqs_queue.dlq", "aws_sqs_queue.jobs", "module.svc"] } });
  });

  it("reads the guard's kind and reason, joined across lines, from a fallback", () => {
    expect(readPlanCone(FALLBACK_WARNING, planFile(), "origin/main")).toEqual({ base: "origin/main", fallback: { kind: "provider-changed", reason: "a provider block changed: aws" } });
  });

  it("takes a fallback after the cone warning, as the sweep's half of the guard prints it, over the cone", () => {
    const sweep = "\nWarning: Cone plan fell back to a full plan\n\nThis plan covers the whole estate (guard sweep-outside-cone): the sweep found 1\nmarked object(s) outside the cone that no block declares, such as aws_sqs_queue.old.\n";
    expect(readPlanCone(CONE_WARNING + sweep, planFile(), "origin/main").fallback).toEqual({
      kind: "sweep-outside-cone",
      reason: "the sweep found 1 marked object(s) outside the cone that no block declares, such as aws_sqs_queue.old",
    });
  });

  it("reads a warning drawn in a box", () => {
    const boxed = "╷\n│ Warning: Cone plan fell back to a full plan\n│\n│ This plan covers the whole estate (guard cone-too-large): the cone holds 30 of\n│ the estate's 40 blocks, over the 30% limit.\n╵\n";
    expect(readPlanCone(boxed, planFile(), "origin/main").fallback).toEqual({ kind: "cone-too-large", reason: "the cone holds 30 of the estate's 40 blocks, over the 30% limit" });
  });

  it("counts a plan with neither a fallback nor a record as full, and says so", () => {
    expect(readPlanCone("", planFile(), "origin/main").fallback?.kind).toBe("unknown");
    expect(readPlanCone("", planFile("not json"), "origin/main").fallback?.kind).toBe("unknown");
  });
});

describe("conePlanDigest", () => {
  const digest = "sha256:" + "a".repeat(64);
  const cone = (targets: string[]): PlanCone => ({ base: "origin/main", record: { base: "origin/main", base_sha: "x", targets } });

  it("leaves a full plan's digest as it is", () => {
    expect(conePlanDigest(digest, undefined)).toBe(digest);
    expect(conePlanDigest(digest, { base: "origin/main", fallback: { kind: "provider-changed", reason: "a provider block changed: aws" } })).toBe(digest);
  });

  it("puts the cone's targets in, in any order, so another cone is another digest", () => {
    const a = conePlanDigest(digest, cone(["b", "a"]));
    expect(a).not.toBe(digest);
    expect(conePlanDigest(digest, cone(["a", "b"]))).toBe(a);
    expect(conePlanDigest(digest, cone(["a", "b", "c"]))).not.toBe(a);
    expect(conePlanDigest("sha256:" + "b".repeat(64), cone(["a", "b"]))).not.toBe(a);
  });
});

describe("a cone plan in the report and the note", () => {
  const p = plan([rc("aws_sqs_queue.jobs", ["update"], { visibility_timeout_seconds: 30 }, { visibility_timeout_seconds: 60 })]);
  const coned: PlanCone = { base: "origin/main", blocks: 3, of: 40, record: RECORD };
  const full: PlanCone = { base: "origin/main", fallback: { kind: "provider-changed", reason: "a provider block changed: aws" } };
  const report = buildReport({
    run: { ...RUN, binary: "choudoufu" },
    roots: [
      { path: "envs/app", plan: p, planner: "choudoufu", cone: coned },
      { path: "envs/db", plan: p, planner: "choudoufu", cone: full },
      { path: "envs/net", plan: p, planner: "choudoufu" },
    ],
    waves: [{ number: 1, roots: ["envs/app", "envs/db", "envs/net"] }],
    gate: "always",
  });
  const root = (path: string) => report.roots.find((r) => r.path === path)!;

  it("keeps the counts, never the addresses, and validates against the schema", () => {
    expect(root("envs/app").cone).toEqual({ base: "origin/main", blocks: 3, of: 40, targets: 3 });
    expect(root("envs/db").cone).toEqual({ base: "origin/main", fallback: { kind: "provider-changed", reason: "a provider block changed: aws" } });
    expect(root("envs/net").cone).toBeUndefined();
    expect(validate(SCHEMA, report)).toEqual([]);
  });

  it("binds the cone into the root's plan digest, and a fallback's digest is the plan's own", () => {
    const own = terraformChangeSetPart({ member: "envs/app", plan: p, planner: "choudoufu" }).member.planDigest!;
    expect(root("envs/app").plan_digest).toBe(conePlanDigest(own, coned));
    expect(root("envs/app").plan_digest).not.toBe(own);
    expect(root("envs/db").plan_digest).toBe(terraformChangeSetPart({ member: "envs/db", plan: p, planner: "choudoufu" }).member.planDigest);
  });

  it("names each cone's size and each fallback's reason in the note", () => {
    const line = "Cone plans of the change since `origin/main`: `envs/app` 3 of its 40 blocks; `envs/db` the whole estate, since a provider block changed: aws (guard `provider-changed`).";
    expect(coneLine(report)).toBe(line);
    expect(renderNote(report)).toContain(line);
  });

  it("says nothing when no root planned with -cone", () => {
    const plain = buildReport({ run: RUN, roots: [{ path: "envs/net", plan: p, planner: "tofu" }], waves: [{ number: 1, roots: ["envs/net"] }] });
    expect(coneLine(plain)).toBeUndefined();
    expect(renderNote(plain)).not.toContain("Cone plans");
  });
});

/** A choudoufu that logs each call, plans what the root's plan.json holds, and with -cone prints the root's warning.txt and copies its cone.json beside the plan. */
function fakeChoudoufu(dir: string): string {
  const path = join(dir, "choudoufu");
  writeFileSync(path, `#!/bin/sh
chdir="\${1#-chdir=}"; shift
echo "$chdir $*" >> "${dir}/calls.log"
case "$1" in
  init) exit 0 ;;
  plan)
    cone=""; out=""
    for a in "$@"; do case "$a" in -cone=*) cone="\${a#-cone=}" ;; -out=*) out="\${a#-out=}" ;; esac; done
    cp "$chdir/plan.json" "$out"
    if [ -n "$cone" ]; then
      [ -f "$chdir/warning.txt" ] && cat "$chdir/warning.txt"
      [ -f "$chdir/cone.json" ] && cp "$chdir/cone.json" "$out.cone.json"
    fi
    echo "Plan: 0 to add, 1 to change, 0 to destroy."; exit 0 ;;
  show) if [ "$2" = "-json" ]; then cat "$3"; else echo "plan text for $chdir"; fi ;;
esac
`);
  chmodSync(path, 0o755);
  return path;
}

/** A repo on main, and a branch `change` that edits every root. */
function based(yml: string): string {
  const PLAN = JSON.stringify(plan([rc("aws_sqs_queue.jobs", ["update"], { visibility_timeout_seconds: 30 }, { visibility_timeout_seconds: 60 })]));
  const dir = write(tmp(), {
    "terragucci.yml": yml,
    "envs/app/main.tf": LIVE,
    "envs/app/plan.json": PLAN,
    "envs/app/warning.txt": CONE_WARNING.replace("origin/main", "main"),
    "envs/app/cone.json": JSON.stringify({ ...RECORD, base: "main" }),
    "envs/db/main.tf": LIVE,
    "envs/db/plan.json": PLAN,
    "envs/db/warning.txt": FALLBACK_WARNING,
    "envs/net/main.tf": "",
    "envs/net/plan.json": PLAN,
  });
  const commit = (m: string) => git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", m);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "add", "-A");
  commit("main");
  git(dir, "checkout", "-q", "-b", "change");
  write(dir, { "envs/app/main.tf": `${LIVE}# changed\n`, "envs/db/main.tf": `${LIVE}# changed\n`, "envs/net/main.tf": "# changed\n" });
  git(dir, "add", "-A");
  commit("change");
  return dir;
}

const planCalls = (bin: string): string[] => readFileSync(join(bin, "calls.log"), "utf-8").split("\n").filter((l) => / plan /.test(l));
const callOf = (calls: string[], root: string): string => calls.find((c) => c.includes(`/${root} `))!;

describe("terragucci stage tf-plan under choudoufu", () => {
  it("plans a pull request's live roots with -cone=<base>, and the report and the note say what each cone came to", { timeout: 60_000 }, async () => {
    const repo = based('binary: choudoufu\nroots: ["envs/*"]\n');
    const bin = tmp();
    const logs: string[] = [];
    const { report, dir } = await runStage("tf-plan", repo, { binary: fakeChoudoufu(bin), base: "main", out: join(tmp(), "r"), env: { PATH: process.env.PATH } }, (l) => logs.push(l));
    const calls = planCalls(bin);
    expect(callOf(calls, "envs/app")).toContain("plan -cone=main ");
    expect(callOf(calls, "envs/db")).toContain("plan -cone=main ");
    // A root with no live block is state-backed, and choudoufu refuses -cone on it.
    expect(callOf(calls, "envs/net")).not.toContain("-cone");
    const root = (path: string) => report.roots.find((r) => r.path === path)!;
    expect(root("envs/app").cone).toEqual({ base: "main", blocks: 3, of: 40, targets: 3 });
    expect(root("envs/db").cone).toEqual({ base: "main", fallback: { kind: "provider-changed", reason: "a provider block changed: aws" } });
    expect(root("envs/net").cone).toBeUndefined();
    expect(logs).toContain("envs/app: planned the cone of the change since main, 3 of the estate's 40 blocks");
    expect(logs).toContain("envs/db: planned the whole estate, since a provider block changed: aws (guard provider-changed)");
    const note = readFileSync(join(dir, "note.md"), "utf-8");
    expect(note).toContain("Cone plans of the change since `main`: `envs/app` 3 of its 40 blocks; `envs/db` the whole estate, since a provider block changed: aws (guard `provider-changed`).");
  });

  it("plans in full under approval: pr-review with the apply after merge, whose review binds this plan's digest to the merge commit's", { timeout: 60_000 }, async () => {
    const repo = based('binary: choudoufu\nroots: ["envs/*"]\napproval: pr-review\n');
    const bin = tmp();
    const { report } = await runStage("tf-plan", repo, { binary: fakeChoudoufu(bin), base: "main", out: join(tmp(), "r"), env: { PATH: process.env.PATH } }, () => {});
    for (const c of planCalls(bin)) expect(c).not.toContain("-cone");
    expect(report.roots.every((r) => r.cone === undefined)).toBe(true);
  });

  it("plans a drift run in full", { timeout: 60_000 }, async () => {
    const repo = based('binary: choudoufu\nroots: ["envs/*"]\n');
    const bin = tmp();
    await runStage("tf-drift", repo, { binary: fakeChoudoufu(bin), out: join(tmp(), "r"), env: { PATH: process.env.PATH } }, () => {});
    for (const c of planCalls(bin)) expect(c).not.toContain("-cone");
  });
});
