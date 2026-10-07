import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { main } from "../src/cli";
import { ConfigError, validateConfig } from "../src/config";
import type { Fetch } from "../src/forge";
import { buildReport, planFiles } from "../src/report/build";
import { respond } from "../src/respond";
import { codify, driftOf, hcl, importBlocks, literal, parseImport } from "../src/respond/drift";
import { moduleNotes, releaseNotes } from "../src/respond/notes";
import { describeRefused, refusedDiff } from "../src/respond/refused";
import { addCanary, canaryFor, missingLocks, pinFromLock, tipProposals } from "../src/respond/tips";
import { bareFrom, git, tmp, write } from "./helpers";
import { plan, rc, RUN } from "./report-fixtures";

const problems = (raw: unknown): string[] => {
  try {
    validateConfig(raw, "terragucci.yml");
    return [];
  } catch (e) {
    return (e as ConfigError).problems ?? [(e as Error).message];
  }
};

describe("respond: the config", () => {
  it("takes a response per event, and the deterministic one needs nothing else", () => {
    expect(problems({ respond: { drift: "pull-request", "apply-failed": "triage", plan: "summary" } })).toEqual([]);
  });

  it("names a key that is not an event and a response the event does not take", () => {
    expect(problems({ respond: { deploy: "summary", drift: "fix-it" } })).toEqual([
      "config.respond.deploy is not an event (events: plan, wave-refused, apply-failed, drift, tips, fmt, publish, rollout, version-bump, description)",
      'config.respond.drift is "fix-it"; use one of pull-request, attribute, off',
    ]);
  });

  it("refuses an agent response and the question event, with or without an agent block", () => {
    expect(problems({ respond: { "apply-failed": "agent", question: "off" }, agent: { via: "forge", token_env: "AGENT_TOKEN" } })).toEqual([
      "config.respond.apply-failed: agent is not supported; remove it, and apply-failed takes its default response, triage",
      "config.respond.question is not supported; remove it",
    ]);
  });

  it("refuses runtime fountain and agent.via fountain, and takes forge for both", () => {
    expect(problems({ runtime: "fountain", agent: { via: "fountain", token_env: "AGENT_TOKEN" } })).toEqual([
      "config.runtime: fountain is not supported; every stage runs on the forge's CI, so remove runtime",
      "config.agent.via: fountain is not supported; the agent runs in a forge job, so use forge",
    ]);
    expect(problems({ runtime: "forge", agent: { via: "forge", token_env: "AGENT_TOKEN" } })).toEqual([]);
  });

  it("checks the integration itself", () => {
    expect(problems({ agent: { token_env: "" , runs: "x" } })).toEqual([
      "config.agent.runs is not a setting (settings: via, token_env, comment)",
      "config.agent.via is missing; use forge",
      "config.agent.token_env must name the variable holding the agent's forge token",
    ]);
  });

  it("has no role setting, since the agent job holds no cloud role", () => {
    expect(problems({ agent: { via: "forge", token_env: "AGENT_TOKEN", role: "arn:aws:iam::1:role/plan" } })).toEqual([
      "config.agent.role is not a setting (settings: via, token_env, comment)",
    ]);
  });

  it("in a control repo, an agent response in a project is refused by the project's name", () => {
    const base = { defaults: { agent: { via: "forge", token_env: "AGENT_TOKEN" } }, projects: { "github.com/acme/a": { respond: { drift: "pull-request" } } } };
    expect(problems(base)).toEqual([]);
    expect(problems({ projects: { "github.com/acme/a": { respond: { drift: "agent" } } } })[0]).toMatch(/^projects\["github.com\/acme\/a"\]\.respond\.drift: agent is not supported/);
  });
});

// ── wave refused ─────────────────────────────────────────────────────────────

const table = (key: string) =>
  rc("module.service.aws_dynamodb_table.records[0]", ["delete", "create"], { name: "shop-prod-search-records", hash_key: "id" }, { name: "shop-prod-search-records", hash_key: key }, { replace_paths: [["hash_key"]] });
const queue = (t: number) => rc("module.service.aws_sqs_queue.jobs", ["update"], { visibility_timeout_seconds: 30 }, { visibility_timeout_seconds: t });

const report = (search: unknown[], orders: unknown[]) =>
  buildReport({
    run: RUN,
    roots: [
      { path: "envs/prod/orders", plan: plan(orders as never[]), planner: "tofu", files: planFiles("envs/prod/orders") },
      { path: "envs/prod/search", plan: plan(search as never[]), planner: "tofu", files: planFiles("envs/prod/search") },
    ],
    waves: [{ number: 2, roots: ["envs/prod/orders", "envs/prod/search"] }],
  });

describe("respond wave-refused: the root-by-root diff", () => {
  it("names the root whose plan moved and the attributes that moved in it", () => {
    const approved = report([queue(60)], [queue(60)]);
    const current = report([queue(60), table("sku")], [queue(60)]);
    const d = refusedDiff(approved, current, 2);
    expect(d.approved_set).not.toBe(d.current_set);
    expect(d.roots.map((r) => r.root)).toEqual(["envs/prod/search"]);
    expect(d.roots[0]!.changes).toEqual([{ address: "module.service.aws_dynamodb_table.records[0]", now: "replace", attributes: ["hash_key"] }]);
    const text = describeRefused(d);
    expect(text).toContain("Wave 2 applies nothing");
    expect(text).toContain("`envs/prod/search`");
    expect(text).not.toContain("envs/prod/orders");
  });

  it("names a changed value inside a change both plans make", () => {
    const d = refusedDiff(report([queue(60)], [queue(60)]), report([queue(90)], [queue(60)]), 2);
    expect(d.roots[0]!.changes).toEqual([{ address: "module.service.aws_sqs_queue.jobs", was: "update", now: "update", attributes: ["visibility_timeout_seconds"] }]);
  });

  it("finds nothing when the plans match", () => {
    const r = report([queue(60)], [queue(60)]);
    expect(refusedDiff(r, report([queue(60)], [queue(60)]), 2).roots).toEqual([]);
    expect(describeRefused(refusedDiff(r, r))).toMatch(/every root's plan matches/);
  });
});

// ── drift ────────────────────────────────────────────────────────────────────

const ROOT = `resource "aws_sqs_queue" "jobs" {
  name                       = "shop-dev-jobs"
  visibility_timeout_seconds = 30 # seconds
  message_retention_seconds  = var.retention
  redrive_policy = jsonencode({
    maxReceiveCount = 5
  })
}

resource "aws_s3_bucket" "files" {
  count  = 2
  bucket = "files-\${count.index}"
}
`;

const driftPlan = (entries: unknown[]) => ({ format_version: "1.2", resource_drift: entries });
const drifted = (address: string, before: Record<string, unknown>, after: Record<string, unknown> | null, extra: Record<string, unknown> = {}) => {
  const parts = address.replace(/\[\d+\]$/, "").split(".");
  return { address, mode: "managed", type: parts.at(-2), name: parts.at(-1), change: { actions: after ? ["update"] : ["delete"], before, after }, ...extra };
};

describe("respond drift: codify literals, leave the rest with a reason", () => {
  const repo = () => write(tmp(), { "envs/dev/orders/main.tf": ROOT });

  it("writes the live value where the root sets a literal, and leaves a variable, a default and a module", () => {
    const dir = repo();
    const d = driftOf(
      driftPlan([
        drifted("aws_sqs_queue.jobs", { visibility_timeout_seconds: 30, message_retention_seconds: 345600, delay_seconds: 0, name: "shop-dev-jobs" }, { visibility_timeout_seconds: 45, message_retention_seconds: 86400, delay_seconds: 5, name: "shop-dev-jobs" }),
        drifted("module.service.aws_sqs_queue.jobs", { visibility_timeout_seconds: 30 }, { visibility_timeout_seconds: 60 }, { module_address: "module.service" }),
        drifted("aws_s3_bucket.files[1]", { bucket: "files-1" }, { bucket: "files-x" }, { index: 1 }),
        drifted("aws_sqs_queue.gone", { name: "gone" }, null),
      ]),
    );
    const r = codify("envs/dev/orders", join(dir, "envs/dev/orders"), d);
    expect(r.codified).toEqual([{ root: "envs/dev/orders", address: "aws_sqs_queue.jobs", path: "visibility_timeout_seconds", file: "envs/dev/orders/main.tf", from: "30", to: "45" }]);
    expect(r.files.get("main.tf")).toContain("visibility_timeout_seconds = 45 # seconds");
    expect(r.left.map((l) => [l.address, l.path, l.reason])).toEqual([
      ["aws_sqs_queue.jobs", "delay_seconds", "not set in the root's block; it comes from a default or the provider"],
      ["aws_sqs_queue.jobs", "message_retention_seconds", "set from an expression (var.retention)"],
      ["module.service.aws_sqs_queue.jobs", undefined, "reached through module.service; the value is set in a module"],
      ["aws_s3_bucket.files[1]", undefined, "an instance of count or for_each; one literal sets every instance"],
      ["aws_sqs_queue.gone", undefined, "deleted outside Terraform; the next apply makes it again, or remove it from the code if that was the intent"],
    ]);
  });

  it("leaves a literal the root changed since the last apply", () => {
    const dir = repo();
    const r = codify("r", join(dir, "envs/dev/orders"), driftOf(driftPlan([drifted("aws_sqs_queue.jobs", { visibility_timeout_seconds: 20 }, { visibility_timeout_seconds: 45 })])));
    expect(r.codified).toEqual([]);
    expect(r.left[0]!.reason).toMatch(/not the one last applied/);
  });

  it("reads and writes HCL literals", () => {
    expect(literal('"abc" # note')).toEqual({ value: "abc" });
    expect(literal("30")).toEqual({ value: 30 });
    expect(literal("false")).toEqual({ value: false });
    expect(literal('"${var.x}-a"')).toBeUndefined();
    expect(literal("var.x")).toBeUndefined();
    expect(hcl("a${b}")).toBe('"a$${b}"');
    expect(hcl(["a"])).toBeUndefined();
  });

  it("writes import blocks from address=id", () => {
    expect(importBlocks([parseImport("aws_sqs_queue.extra=https://sqs.us-east-1.amazonaws.com/1/extra")])).toBe(
      'import {\n  to = aws_sqs_queue.extra\n  id = "https://sqs.us-east-1.amazonaws.com/1/extra"\n}\n',
    );
    expect(() => parseImport("no-id")).toThrow(ConfigError);
  });
});

// ── tips ─────────────────────────────────────────────────────────────────────

const LOCK = `provider "registry.opentofu.org/hashicorp/aws" {
  version     = "6.67.0"
  constraints = "~> 6.0"
}

provider "registry.opentofu.org/hashicorp/random" {
  version = "3.7.2"
}
`;

describe("respond tips: one pull request per tip", () => {
  const repo = () =>
    write(tmp(), {
      "envs/dev/app/main.tf": `terraform {\n  required_providers {\n    aws = {\n      source  = "hashicorp/aws"\n      version = "~> 6.0"\n    }\n    random = {\n      source = "hashicorp/random"\n    }\n  }\n}\n`,
      "envs/dev/app/.terraform.lock.hcl": LOCK,
      "envs/prod/app/main.tf": `terraform {\n  required_providers {\n    aws = {\n      source  = "hashicorp/aws"\n      version = "6.67.0"\n    }\n  }\n}\n`,
    });

  it("pins each provider from the lock file, one provider per pull request", () => {
    const dir = repo();
    const pins = pinFromLock(dir, ["envs/dev/app", "envs/prod/app"]);
    expect([...pins.keys()]).toEqual(["hashicorp/aws", "hashicorp/random"]);
    const aws = pins.get("hashicorp/aws")!.files.get("envs/dev/app/main.tf")!;
    expect(aws).toContain('version = "6.67.0"');
    expect(aws).not.toContain("3.7.2");
    const random = pins.get("hashicorp/random")!.files.get("envs/dev/app/main.tf")!;
    expect(random).toContain('      source  = "hashicorp/random"\n      version = "3.7.2"\n');
    expect(random).toContain('version = "~> 6.0"');
  });

  it("finds roots with no lock file, and picks a canary", () => {
    const dir = repo();
    expect(missingLocks(dir, ["envs/dev/app", "envs/prod/app"])).toEqual(["envs/prod/app"]);
    expect(canaryFor(["envs/prod/app", "envs/dev/app"])).toEqual(["envs/dev/app"]);
    expect(canaryFor(["b", "a"])).toEqual(["b"]);
  });

  it("adds waves.canary to the config, or writes one", () => {
    const dir = repo();
    expect(addCanary(dir, ["envs/dev/app"])).toEqual({ file: "terragucci.yml", text: 'waves:\n  canary: ["envs/dev/app"]\n' });
    writeFileSync(join(dir, "terragucci.yml"), "binary: tofu\n");
    expect(addCanary(dir, ["envs/dev/app"])).toEqual({ file: "terragucci.yml", text: 'binary: tofu\nwaves:\n  canary: ["envs/dev/app"]\n' });
    writeFileSync(join(dir, "terragucci.yml"), "waves: { canary: [] }\n");
    expect(addCanary(dir, ["x"])).toHaveProperty("refused");
  });

  it("lists every tip's pull request on a dry run", () => {
    const dir = repo();
    const p = tipProposals(dir, ["envs/dev/app", "envs/prod/app"], "tofu", {});
    expect(p.map((x) => x.branch)).toEqual(["terragucci/tip/pin-hashicorp-aws", "terragucci/tip/pin-hashicorp-random", "terragucci/tip/lock-files", "terragucci/tip/canary"]);
    expect(tipProposals(dir, ["envs/dev/app", "envs/prod/app"], "tofu", { canary: ["envs/dev/*"] }).map((x) => x.branch)).not.toContain("terragucci/tip/canary");
  });
});

// ── release notes ────────────────────────────────────────────────────────────

describe("respond publish: release notes from conventional commits", () => {
  it("groups breaking changes, features, fixes and the rest", () => {
    expect(releaseNotes(["feat(network)!: drop the v4 subnets", "fix: tag the NAT gateway", "feat: an IPv6 block\n\nbody", "chore: bump tflint", "Merge branch 'x'"])).toBe(
      "### Breaking changes\n\n- network: drop the v4 subnets\n\n### Features\n\n- an IPv6 block\n\n### Fixes\n\n- tag the NAT gateway\n\n### Other changes\n\n- bump tflint\n- Merge branch 'x'",
    );
  });

  it("takes the commits between a module's last two tags", () => {
    const dir = write(tmp(), { "modules/net/main.tf": "# 1\n", "modules/other/main.tf": "# 1\n" });
    const commit = (m: string) => git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-qam", m);
    git(dir, "init", "-q", "-b", "main");
    git(dir, "add", "-A");
    commit("feat: first");
    git(dir, "tag", "modules/net/v0.1.0");
    writeFileSync(join(dir, "modules/net/main.tf"), "# 2\n");
    commit("fix(net): second");
    writeFileSync(join(dir, "modules/other/main.tf"), "# 2\n");
    commit("feat: not this module");
    git(dir, "tag", "modules/net/v0.1.1");
    expect(moduleNotes(dir, "modules/net")).toEqual({ module: "modules/net", version: "0.1.1", previous: "0.1.0", notes: "### Fixes\n\n- net: second" });
    expect(moduleNotes(dir, "modules/net", "0.1.0")!.notes).toBe("### Features\n\n- first");
  });
});

// ── respond() ────────────────────────────────────────────────────────────────

/** A forgejo answering what a pull request needs, recording what was asked. */
function forgejo() {
  const calls: string[] = [];
  const fetch: Fetch = async (url, init) => {
    calls.push(`${init?.method ?? "GET"} ${url}`);
    const body = url.endsWith("/repos/acme/infra") ? { default_branch: "main" } : init?.method === "POST" ? { html_url: "https://forge.test/acme/infra/pulls/7", number: 7 } : [];
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  };
  return { fetch, calls };
}

/** A checkout of `files` whose origin is a bare repo, with forgejo named as its forge. */
function checkout(files: Record<string, string>): { repo: string; bare: string } {
  const bare = bareFrom(write(tmp(), { "terragucci.yml": "forge: forgejo\nurl: https://forge.test/acme/infra\ntoken_env: FORGE_TOKEN\n", ...files }));
  const repo = tmp();
  git(repo, "clone", "-q", bare, ".");
  return { repo, bare };
}

/** A stand-in binary: init passes, the refresh-only plan's JSON is `driftJson`. */
function fakeBinary(driftJson: unknown): string {
  const dir = tmp();
  writeFileSync(join(dir, "plan.json"), JSON.stringify(driftJson));
  const bin = join(dir, "tf");
  writeFileSync(bin, `#!/bin/sh\ncase "$2" in\n  init) exit 0 ;;\n  plan) for a in "$@"; do case "$a" in -out=*) : > "\${a#-out=}" ;; esac; done; exit 0 ;;\n  show) cat ${JSON.stringify(join(dir, "plan.json"))} ;;\nesac\n`);
  chmodSync(bin, 0o755);
  return bin;
}

describe("respond: running a response", () => {
  it("does nothing for an event set to off", async () => {
    const dir = write(tmp(), { "terragucci.yml": 'respond:\n  "wave-refused": off\n' });
    expect(await respond("wave-refused", dir, {})).toMatchObject({ response: "off", skipped: "respond.wave-refused is off" });
  });

  it("names the events when given another", async () => {
    await expect(respond("deploy", tmp(), {})).rejects.toThrow(/the events are plan, wave-refused/);
  });

  it("triages an apply log by default", async () => {
    const log = "Error: creating IAM Role (app): operation error IAM: CreateRole, https response error StatusCode: 409, RequestID: r, EntityAlreadyExists: Role with name app already exists.\n\n  with aws_iam_role.app,\n";
    const plain = await respond("apply-failed", tmp(), { log });
    expect(plain.text).toMatch(/^- `aws_iam_role.app`: already-exists \(EntityAlreadyExists\)\. /);
    expect(plain.response).toBe("triage");
  });

  it("drift: a dry run lists the pull request, and apply opens it with the live value written", async () => {
    const { repo, bare } = checkout({ "app/main.tf": `terraform {\n  backend "s3" {}\n}\n\n${ROOT}` });
    const bin = fakeBinary(driftPlan([drifted("aws_sqs_queue.jobs", { visibility_timeout_seconds: 30 }, { visibility_timeout_seconds: 45 })]));
    const dry = await respond("drift", repo, { binary: bin });
    expect(dry.proposals).toEqual([{ branch: "terragucci/drift", title: "Codify drift", files: ["app/main.tf"], state: "would-open" }]);
    expect(readFileSync(join(repo, "app/main.tf"), "utf-8")).toContain("visibility_timeout_seconds = 30");

    const forge = forgejo();
    const r = await respond("drift", repo, { binary: bin, mode: "apply", fetch: forge.fetch, env: { FORGE_TOKEN: "t" } });
    expect(r.proposals).toMatchObject([{ state: "opened", pullRequest: "https://forge.test/acme/infra/pulls/7", files: ["app/main.tf"] }]);
    expect(git(bare, "show", "terragucci/drift:app/main.tf")).toContain("visibility_timeout_seconds = 45 # seconds");
    expect(git(bare, "rev-parse", "main")).toBe(git(repo, "rev-parse", "HEAD"));
    expect(forge.calls.filter((c) => c.startsWith("POST"))).toEqual(["POST https://forge.test/api/v1/repos/acme/infra/pulls"]);
  });

  it("drift: attributions the stage already made are used, and the audit log is not read again", async () => {
    const { repo } = checkout({ "terragucci.yml": "forge: forgejo\nurl: https://forge.test/acme/infra\ntoken_env: FORGE_TOKEN\nrespond:\n  drift: attribute\n", "app/main.tf": `terraform {\n  backend "s3" {}\n}\n\n${ROOT}` });
    const bin = fakeBinary(driftPlan([drifted("aws_sqs_queue.jobs", { visibility_timeout_seconds: 30 }, { visibility_timeout_seconds: 45 })]));
    const audit = { lookup: vi.fn(async () => ({ status: "unavailable" as const, reason: "must not be read" })) };
    const attributions = { app: { attributions: [{ root: "app", address: "aws_sqs_queue.jobs", path: "visibility_timeout_seconds", actor: "human" as const, source: "audit" as const, detail: "UpdateQueue by a person" }], notes: [] } };
    const r = await respond("drift", repo, { binary: bin, audit, attributions });
    expect(audit.lookup).not.toHaveBeenCalled();
    expect((r.data as { attributions: unknown[] }).attributions).toEqual(attributions.app.attributions);
  });

  it("drift: import blocks and the generated config go in the same pull request", async () => {
    const { repo } = checkout({ "app/main.tf": 'terraform {\n  backend "s3" {}\n}\n' });
    const dir = tmp();
    const bin = join(dir, "tf");
    // init and show as before; a plan with -generate-config-out writes the config, as the binary does.
    writeFileSync(join(dir, "plan.json"), JSON.stringify(driftPlan([])));
    writeFileSync(
      bin,
      `#!/bin/sh\nd="\${1#-chdir=}"\ncase "$2" in\n  init) exit 0 ;;\n  plan) for a in "$@"; do case "$a" in -out=*) : > "\${a#-out=}" ;; -generate-config-out=*) printf 'resource "aws_sqs_queue" "extra" {\\n  name = "extra"\\n}\\n' > "$d/\${a#-generate-config-out=}" ;; esac; done; exit 0 ;;\n  show) cat ${JSON.stringify(join(dir, "plan.json"))} ;;\nesac\n`,
    );
    chmodSync(bin, 0o755);
    const r = await respond("drift", repo, { binary: bin, root: "app", imports: [{ address: "aws_sqs_queue.extra", id: "https://sqs/1/extra" }] });
    expect(r.proposals![0]!.files).toEqual(["app/terragucci_generated.tf", "app/terragucci_imports.tf"]);
    expect(existsSync(join(repo, "app/terragucci_imports.tf"))).toBe(false);
  });

  it("fmt commits to the pull request's branch and refuses the default branch", async () => {
    const { repo, bare } = checkout({ "app/main.tf": 'locals {\n    a   = 1\n}\n' });
    git(repo, "push", "-q", "origin", "HEAD:refs/heads/feature");
    const forge = forgejo();
    await expect(respond("fmt", repo, { branch: "main", mode: "apply", fetch: forge.fetch, binary: "tofu" })).rejects.toThrow(/default branch/);
    const dry = await respond("fmt", repo, { branch: "feature", binary: "tofu" });
    expect(dry.text).toBe("feature: would commit tofu fmt on app/main.tf");
    const r = await respond("fmt", repo, { branch: "feature", mode: "apply", fetch: forge.fetch, binary: "tofu" });
    expect(r.text).toBe("feature: committed tofu fmt on app/main.tf");
    expect(git(bare, "show", "feature:app/main.tf")).toBe("locals {\n  a = 1\n}\n");
    expect(git(bare, "log", "-1", "--format=%s", "feature").trim()).toBe("style: tofu fmt");
    expect(git(bare, "rev-parse", "main")).not.toBe(git(bare, "rev-parse", "feature"));
  });
});

describe("terragucci respond on the command line", () => {
  const run = async (dir: string, ...argv: string[]) => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      const code = await main(argv);
      return { code, out: spy.mock.calls.map((c) => c.join(" ")).join("\n") };
    } finally {
      process.chdir(cwd);
      spy.mockRestore();
    }
  };

  it("triages a log file into one envelope", async () => {
    const dir = write(tmp(), { "apply.log": "Error: Error acquiring the state lock\n\nLock Info:\n  ID: 1\n" });
    const { code, out } = await run(dir, "respond", "apply-failed", "--log", "apply.log", "--json");
    expect(code).toBe(0);
    const e = JSON.parse(out);
    expect(e).toMatchObject({ command: "respond", status: "ok", results: { event: "apply-failed", response: "triage", data: { known: [{ class: "state-lock" }] } } });
  });

  it("refuses an import that is not address=id, and an unknown mode", async () => {
    expect((await run(tmp(), "respond", "drift", "--import", "nope", "--json")).code).toBe(2);
    expect((await run(tmp(), "respond", "drift", "--mode", "yes", "--json")).code).toBe(2);
  });

  it("leaves a rollout alone when respond.rollout is off", async () => {
    const dir = write(tmp(), { "terragucci.yml": "respond:\n  rollout: off\n" });
    const { code, out } = await run(dir, "respond", "rollout", "modules/x", "--json");
    expect(code).toBe(0);
    expect(JSON.parse(out).results.skipped).toBe("respond.rollout is off");
  });
});

describe("respond with --base: an open pull request's responses read the default branch's settings", () => {
  const log = "Error: creating the bucket: AccessDenied\n";
  const pr = (baseYml: string, headYml: string) => {
    const dir = tmp();
    git(dir, "init", "-q", "-b", "main");
    write(dir, { "terragucci.yml": baseYml });
    git(dir, "add", "-A");
    git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "base");
    git(dir, "checkout", "-q", "-b", "pr");
    write(dir, { "terragucci.yml": headYml });
    git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-am", "the pull request turns the response off");
    return dir;
  };

  it("a pull request that turns apply-failed off still gets the base's response, and without --base its own setting holds", async () => {
    const dir = pr("binary: tofu\n", "respond:\n  apply-failed: off\n");
    const withBase = await respond("apply-failed", dir, { log, base: "main" });
    expect(withBase.skipped).toBeUndefined();
    expect(withBase.response).toBe("triage");
    const after = await respond("apply-failed", dir, { log });
    expect(after.skipped).toBe("respond.apply-failed is off");
  });

  it("a base the checkout does not have gives no response and says why", async () => {
    const dir = pr("binary: tofu\n", "binary: tofu\nparallelism: 2\n");
    const r = await respond("apply-failed", dir, { log, base: "origin/gone" });
    expect(r.skipped).toContain("origin/gone");
    expect(r.skipped).toContain("no response");
    expect(r.response).toBe("off");
  });

  it("the CLI takes --base", async () => {
    const dir = pr("binary: tofu\n", "respond:\n  apply-failed: off\n");
    writeFileSync(join(dir, "apply.log"), log);
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const prev = process.cwd();
    process.chdir(dir);
    try {
      expect(await main(["respond", "apply-failed", "--log", "apply.log", "--base", "main"])).toBe(0);
      expect(out.mock.calls.flat().join("\n")).not.toContain("respond.apply-failed is off");
    } finally {
      process.chdir(prev);
      out.mockRestore();
    }
  });
});
