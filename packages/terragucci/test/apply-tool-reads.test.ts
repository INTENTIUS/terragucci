/**
 * An Atmos `!terraform.state` read and a Terramate `input` hold their wave
 * when the change moved what they read (#1053). A pull request plans such a
 * reader on its upstream's applied state, never on the upstream's plan, so a
 * change that edits both shows the reader planned on the old value. On the
 * default branch the reader's wave plans on what the upstream's wave applied,
 * which nobody reviewed: like a plain root's read of an output unknown at
 * review (#1012), it waits for an approval under on-destructive, and its log
 * names the read and why.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyWave } from "../src/apply";
import { EDGES_FILE, TERRAMATE_EDGES_FILE } from "../src/atmos";
import { unknownReads } from "../src/unknown-reads";
import { FAKE, T, setup } from "./apply-helpers";

const state = (key: string) => `terraform {\n  backend "s3" {\n    bucket = "s"\n    key    = "${key}"\n  }\n}\n`;
const variable = (name: string) => `variable "${name}" {\n  type = string\n}\n`;

/** The fake tofu of ./apply-helpers.ts, whose output -json prints $PLANS/<root>.outputs.json: the upstream's applied outputs. */
const FAKE_OUTPUTS = FAKE.replace(`  apply)`, `  output) cat "$PLANS/$root.outputs.json" ;;\n  apply)`);

/** The upstream's plan: its cidr moves from 10.0.0.0/16 to 10.1.0.0/16, a value known at plan time. */
const moved = (output: string) => ({
  resource_changes: [{ address: "terraform_data.this", mode: "managed", type: "terraform_data", name: "this", change: { actions: ["update"], before: { input: "10.0.0.0/16" }, after: { input: "10.1.0.0/16" }, after_unknown: {} } }],
  output_changes: { [output]: { actions: ["update"], before: "10.0.0.0/16", after: "10.1.0.0/16", after_unknown: false } },
});
/** The upstream's plan when the change leaves it alone. */
const unmoved = (output: string) => ({
  resource_changes: [{ address: "terraform_data.this", mode: "managed", type: "terraform_data", name: "this", change: { actions: ["no-op"], before: { input: "10.0.0.0/16" }, after: { input: "10.0.0.0/16" }, after_unknown: {} } }],
  output_changes: { [output]: { actions: ["no-op"], before: "10.0.0.0/16", after: "10.0.0.0/16", after_unknown: false } },
});
/** The reader's plan on the value it read: an update, which destroys nothing. */
const readerPlan = { resource_changes: [{ address: "terraform_data.this", mode: "managed", type: "terraform_data", name: "this", change: { actions: ["update"], before: { input: { vpc: "10.0.0.0/16" } }, after: { input: { vpc: "10.1.0.0/16" } }, after_unknown: {} } }] };

/** An in-memory bucket behind the S3 calls the reports make, as in ./apply-unknown-reads.test.ts. */
function bucket(): Map<string, string> {
  const objects = new Map<string, string>();
  vi.stubGlobal("fetch", async (url: string, init: { method: string; body?: string | Uint8Array }) => {
    const key = url.split("?")[0]!;
    if (init.method === "PUT") {
      objects.set(key, typeof init.body === "string" ? init.body : new TextDecoder().decode(init.body ?? new Uint8Array()));
      return new Response("", { status: 200 });
    }
    if (init.method === "GET" || init.method === "HEAD") {
      const body = objects.get(key);
      return body === undefined ? new Response(null, { status: 404 }) : new Response(init.method === "GET" ? body : null, { status: 200 });
    }
    return new Response("", { status: 200 });
  });
  return objects;
}

const REPORTS = "reports:\n  bucket: s3://reports\n  endpoint: http://s3.test\n";

/** An Atmos repo as `terragucci atmos write` leaves it: dev/app reads dev/vpc's cidr with `!terraform.state vpc .cidr`. */
const ATMOS = {
  "terragucci.yml": REPORTS,
  "atmos.yaml": "base_path: .\n",
  "dev/vpc/main.tf": state("vpc.tfstate") + variable("cidr"),
  [`dev/vpc/${EDGES_FILE}`]: JSON.stringify({ component: "components/terraform/vpc", dependencies: [], reads: [] }),
  "dev/app/main.tf": state("app.tfstate") + variable("vpc_cidr"),
  [`dev/app/${EDGES_FILE}`]: JSON.stringify({ component: "components/terraform/app", dependencies: ["dev/vpc"], reads: [{ var: "vpc_cidr", upstream: "dev/vpc", output: ["cidr"], function: "!terraform.state vpc .cidr" }] }),
};

/** A Terramate repo as `terragucci terramate generate` leaves it: stacks/app's input net_cidr reads stacks/network's cidr. */
const TERRAMATE = {
  "terragucci.yml": REPORTS,
  "terramate.tm.hcl": "terramate {\n  config {\n  }\n}\n",
  "stacks/network/main.tf": state("network.tfstate"),
  "stacks/network/stack.tm.hcl": 'stack {\n  name = "network"\n  id   = "network"\n}\n',
  [`stacks/network/${TERRAMATE_EDGES_FILE}`]: JSON.stringify({ dependencies: [], reads: [] }),
  "stacks/app/main.tf": state("app.tfstate") + variable("net_cidr"),
  "stacks/app/stack.tm.hcl": 'stack {\n  name = "app"\n  id   = "app"\n}\n\ninput "net_cidr" {\n  backend       = "default"\n  from_stack_id = "network"\n  value         = outputs.cidr.value\n  mock          = "mocked"\n}\n',
  [`stacks/app/${TERRAMATE_EDGES_FILE}`]: JSON.stringify({ dependencies: ["stacks/network"], reads: [{ var: "net_cidr", upstream: "stacks/network", output: ["cidr"], function: 'input "net_cidr" from stack network, outputs.cidr.value' }] }),
};

/** The work tree for `files`, its fake tofu answering output -json, with the upstream's plan and applied outputs. */
function repo(files: Record<string, string>, upstream: string, reader: string, upstreamPlan: unknown) {
  const s = setup(files);
  writeFileSync(s.bin, FAKE_OUTPUTS);
  const plans = join(s.work, "..", "plans");
  writeFileSync(join(plans, `${upstream}.json`), JSON.stringify(upstreamPlan));
  writeFileSync(join(plans, `${upstream}.outputs.json`), JSON.stringify({ cidr: { value: "10.1.0.0/16", type: "string", sensitive: false } }));
  writeFileSync(join(plans, `${reader}.json`), JSON.stringify(readerPlan));
  return s;
}

const env = { AWS_ACCESS_KEY_ID: "AK", AWS_SECRET_ACCESS_KEY: "SK" };

describe("a tool's read of an upstream the change touches", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("an Atmos !terraform.state read holds the wave under on-destructive and says which read and why", async () => {
    const { work, bin, log } = repo(ATMOS, "vpc", "app", moved("cidr"));
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    bucket();
    const opts = { layers: [["dev/vpc"], ["dev/app"]], binary: bin, gate: "on-destructive" as const, env };
    const said = () => out.mock.calls.flat().join("\n");

    // Wave 1 applies vpc's new cidr; wave 2 plans app on it, which the pull request's review never showed, and waits.
    expect(await applyWave(work, { ...opts, wave: 1, now: T(1) })).toBe(0);
    expect(await applyWave(work, { ...opts, wave: 2, now: T(1) })).toBe(3);
    expect(said()).toMatch(/dev\/app reads cidr of dev\/vpc, which wave 1's plan of dev\/vpc in this push \([^)]*\) changes/);
    expect(said()).toContain("nobody reviewed the plan it made on those outputs, so it waits for an approval of it although gate is on-destructive");
    expect(readLog(log)).not.toContain("applied app");
  });

  it("a Terramate input holds the wave under on-destructive and says which read and why", async () => {
    const { work, bin, log } = repo(TERRAMATE, "network", "app", moved("cidr"));
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    bucket();
    const opts = { layers: [["stacks/network"], ["stacks/app"]], binary: bin, gate: "on-destructive" as const, env };
    const said = () => out.mock.calls.flat().join("\n");

    expect(await applyWave(work, { ...opts, wave: 1, now: T(1) })).toBe(0);
    expect(await applyWave(work, { ...opts, wave: 2, now: T(1) })).toBe(3);
    expect(said()).toMatch(/stacks\/app reads cidr of stacks\/network, which wave 1's plan of stacks\/network in this push \([^)]*\) changes/);
    expect(said()).toContain("nobody reviewed the plan it made on those outputs, so it waits for an approval of it although gate is on-destructive");
    expect(readLog(log)).not.toContain("applied app");
  });

  it("an Atmos read of an upstream the change leaves alone applies with no hold under on-destructive", async () => {
    const { work, bin, log } = repo(ATMOS, "vpc", "app", unmoved("cidr"));
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    bucket();
    const opts = { layers: [["dev/vpc"], ["dev/app"]], binary: bin, gate: "on-destructive" as const, env };
    const said = () => out.mock.calls.flat().join("\n");

    expect(await applyWave(work, { ...opts, wave: 1, now: T(1) })).toBe(0);
    expect(await applyWave(work, { ...opts, wave: 2, now: T(1) })).toBe(0);
    expect(said()).not.toContain("waits for an approval");
    expect(readLog(log)).toContain("applied app");
  });
});

function readLog(log: string): string {
  try {
    return readFileSync(log, "utf-8");
  } catch {
    return "";
  }
}

describe("unknownReads, for a read the review planned on the upstream's applied state", () => {
  const read = { root: "dev/app", upstream: "dev/vpc", wave: 1, outputs: new Set(["cidr"]), review: "applied" as const };
  const noPull = async () => ({ missing: "no pull request" });

  it("holds when the upstream's plan changes an output it reads, even one known at plan time", async () => {
    const v = await unknownReads([read], { upstreamPlans: async () => [{ plan: moved("cidr"), from: "the merge's plan" }], pullReport: noPull });
    expect(v.unknown).toEqual([expect.objectContaining({ root: "dev/app", outputs: ["cidr"], carrier: "upstream-plan", from: "the merge's plan" })]);
  });

  it("lets the wave through when the upstream's plan changes no output it reads", async () => {
    const other = { ...moved("id"), output_changes: { ...moved("id").output_changes, cidr: unmoved("cidr").output_changes.cidr } };
    const v = await unknownReads([read], { upstreamPlans: async () => [{ plan: other, from: "the merge's plan" }], pullReport: noPull });
    expect(v.unknown).toEqual([]);
  });

  it("holds with no carrier when no plan of the upstream can say, whatever the pull request's report holds", async () => {
    const report = { roots: [{ path: "dev/app" }], waves: [] } as never;
    const v = await unknownReads([read], { upstreamPlans: async () => [], pullReport: async () => ({ report, from: "pull request 7's plan" }) });
    expect(v.unknown).toEqual([expect.objectContaining({ carrier: "none" })]);
    expect(v.unknown[0]!.why).toContain("applied state");
  });
});
