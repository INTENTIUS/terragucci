import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import {
  copyBackend,
  EPHEMERAL_DONE,
  EPHEMERAL_LEDGER,
  ephemeralDown,
  ephemeralSweep,
  ephemeralUp,
  liveEnvironments,
  parseEphemeral,
  readLive,
  suffixedKey,
  updateList,
  type EphemeralRecord,
} from "../src/ephemeral";
import { parseLedger } from "../src/apply";
import { validateConfig, type ForgeName } from "../src/config";
import { renderPipeline } from "../src/render";
import { ledgerEntries, parseLedgerLog, EPHEMERAL_DONE_FILE } from "../src/report/audit";
import { buildEstate, renderEstateHtml } from "../src/report/estate";
import type { Fetch } from "../src/forge";
import { git, tmp, write } from "./helpers";

const T = (m: number): string => new Date(Date.UTC(2026, 0, 1, 0, m)).toISOString();
const body = (text: string): Record<string, any> => parseYAML(text.split("\n").filter((l) => !l.startsWith("#")).join("\n")) as Record<string, any>;

describe("a copy's state key", () => {
  it("adds the suffix before .tfstate, else at the end", () => {
    expect(suffixedKey("envs/dev/terraform.tfstate", "pr-7")).toBe("envs/dev/terraform-pr-7.tfstate");
    expect(suffixedKey("envs/dev", "pr-7")).toBe("envs/dev-pr-7");
    expect(suffixedKey("envs/dev/", "pr-7")).toBe("envs/dev-pr-7");
  });

  it("is read from the root's backend block, and refused where no key can take a suffix", () => {
    const dir = tmp("tg-eph-backend-");
    const root = (name: string, tf: string): string => write(join(dir, name), { "main.tf": tf });
    expect(copyBackend(root("s3", 'terraform {\n  backend "s3" {\n    bucket = "b"\n    key    = "app/one.tfstate" # the key\n  }\n}\n'), "s3", "pr-3")).toEqual({ type: "s3", attribute: "key", key: "app/one-pr-3.tfstate", location: "s3://b/app/one-pr-3.tfstate" });
    expect(copyBackend(root("gcs", 'terraform {\n  backend "gcs" {\n    bucket = "b"\n    prefix = "app"\n  }\n}\n'), "gcs", "pr-3")).toMatchObject({ attribute: "prefix", key: "app-pr-3", location: "gs://b/app-pr-3" });
    expect(copyBackend(root("none", 'resource "terraform_data" "x" {}\n'), "none", "pr-3")).toMatchObject({ type: "local", attribute: "path", key: "terraform-pr-3.tfstate" });
    expect(copyBackend(write(join(dir, "json"), { "cdk.tf.json": JSON.stringify({ terraform: { backend: { s3: { bucket: "b", key: "j.tfstate" } } } }) }), "json", "pr-3")).toMatchObject({ key: "j-pr-3.tfstate" });
    expect(() => copyBackend(root("cloud", "terraform {\n  cloud {\n    organization = \"o\"\n  }\n}\n"), "cloud", "pr-3")).toThrow(/HCP Terraform \(a cloud block\)/);
    expect(() => copyBackend(root("http", 'terraform {\n  backend "http" {\n    address = "https://x"\n  }\n}\n'), "http", "pr-3")).toThrow(/not a GitLab project's state API/);
    expect(() => copyBackend(root("nokey", 'terraform {\n  backend "s3" {\n    bucket = "b"\n  }\n}\n'), "nokey", "pr-3")).toThrow(/names no key/);
  });
});

describe("the live copies", () => {
  const rec = (r: Partial<EphemeralRecord>): EphemeralRecord => ({ version: 1, kind: "ephemeral-apply", op: "tf-ephemeral", gate: "pr-1", pr: 1, suffix: "pr-1", roots: [{ root: "a", location: "s3://b/a-pr-1.tfstate", result: "applied" }], planDigest: "d", by: "x", timestamp: T(0), result: "applied", commit: "c1", expiresAt: T(60), ...r });

  it("an apply makes one, a destroy that destroyed every root ends it, and one that failed leaves it live", () => {
    const records = [
      rec({}),
      rec({ pr: 2, gate: "pr-2", suffix: "pr-2" }),
      rec({ timestamp: T(10), commit: "c2", expiresAt: T(70) }),
      rec({ pr: 2, kind: "ephemeral-destroy", result: "failed", reason: "closed", roots: [{ root: "a", location: "x", result: "failed" }] }),
    ];
    const live = liveEnvironments(records);
    expect(live.get(1)).toMatchObject({ commit: "c2", expiresAt: T(70), roots: ["a"] });
    expect(live.get(2)).toMatchObject({ destroyFailed: true });
    expect(liveEnvironments([...records, rec({ pr: 2, kind: "ephemeral-destroy", result: "destroyed", reason: "expired" })]).has(2)).toBe(false);
    expect(parseEphemeral(`${records.map((r) => JSON.stringify(r)).join("\n")}\nnot json\n{"version":2}\n`)).toHaveLength(4);
  });

  it("the bucket's list replaces one pull request's row and drops it once destroyed", () => {
    const row = { pull_request: 4, suffix: "pr-4", roots: [], commit: "c", applied: T(0), expires: T(60), status: "live" as const };
    const one = updateList(undefined, "p", 4, row, T(1));
    expect(one).toMatchObject({ schema: "terragucci.ephemeral/v1", project: "p", environments: [row] });
    const two = updateList(JSON.stringify(one), "p", 2, { ...row, pull_request: 2 }, T(2));
    expect(two.environments.map((r) => r.pull_request)).toEqual([2, 4]);
    expect(updateList(JSON.stringify(two), "p", 4, undefined, T(3)).environments.map((r) => r.pull_request)).toEqual([2]);
  });
});

// The binary: logs each call, writes the plan file as "<root>-<create|destroy>", and shows the matching plan.
const FAKE = `#!/usr/bin/env bash
dir="\${1#-chdir=}"; root="$(basename "$dir")"
echo "$root $*" >> "$ARGS"
case "$2" in
  init) [ -n "\${FAIL_INIT:-}" ] && { echo "init broke"; exit 1; } ;;
  plan) kind=create; for a in "$@"; do [ "$a" = -destroy ] && kind=destroy; done
        for a in "$@"; do case "$a" in -out=*) echo "$root-$kind" > "\${a#-out=}" ;; esac; done; echo "Plan: 1" ;;
  show) cat "$PLANS/$(cat "\${@: -1}").json" ;;
  apply) echo "$(cat "\${@: -1}")" >> "$LOG"; [ -n "\${FAIL_APPLY:-}" ] && exit 1 ;;
esac
exit 0
`;

// Terragrunt: --version fails (discovery walks the files); `run --working-dir <unit> -- init` records the
// backend the unit's key gives, as root.hcl reads the suffix (TG_NO_SUFFIX: it does not), then runs the binary.
const FAKE_TG = `#!/usr/bin/env bash
[ "$1" = run ] || exit 1
while [ "$1" != --working-dir ]; do shift; done; unit="$2"
while [ "$1" != -- ]; do shift; done; shift
cd "$unit" || exit 1
suffix="\${TERRAGUCCI_EPHEMERAL_SUFFIX:-}"; [ -n "\${TG_NO_SUFFIX:-}" ] && suffix=""
echo "$unit \${TERRAGUCCI_EPHEMERAL_SUFFIX:-}" >> "$(dirname "$LOG")/tg.log"
mkdir -p .terraform
printf '{"backend":{"type":"s3","config":{"bucket":"state","key":"x/%s/terraform%s.tfstate"}}}' "$unit" "$suffix" > .terraform/terraform.tfstate
exec "$TG_TF_PATH" -chdir="$PWD" "$@"
`;

const change = (action: "create" | "delete") =>
  JSON.stringify({ resource_changes: [{ address: "terraform_data.x", mode: "managed", type: "terraform_data", name: "x", change: { actions: [action], before: action === "delete" ? { input: "1" } : null, after: action === "create" ? { input: "1" } : null, after_unknown: {} } }] });

describe("a pull request's copy", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  function setup(config: string): { work: string; origin: string; bin: string; log: string; args: string; head: string; out: string[] } {
    const dir = tmp("tg-eph-");
    const origin = join(dir, "origin.git");
    git(dir, "init", "-q", "--bare", origin);
    const work = join(dir, "work");
    write(work, {
      "terragucci.yml": config,
      "preview/app/main.tf": 'terraform {\n  backend "s3" {\n    bucket = "state"\n    key    = "x/preview/app.tfstate"\n  }\n}\n',
      "preview/net/main.tf": 'terraform {\n  backend "s3" {\n    bucket = "state"\n    key    = "x/preview/net.tfstate"\n  }\n}\n',
      "prod/app/main.tf": 'terraform {\n  backend "s3" {\n    bucket = "state"\n    key    = "x/prod/app.tfstate"\n  }\n}\n',
    });
    git(work, "init", "-q", "-b", "main");
    git(work, "add", "-A");
    git(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "one");
    git(work, "remote", "add", "origin", origin);
    git(work, "push", "-q", "origin", "main");
    // The pull request's head: a commit only origin's pull request ref holds.
    git(work, "checkout", "-q", "-b", "change");
    write(work, { "preview/app/rev.txt": "2\n" });
    git(work, "add", "-A");
    git(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "change");
    const head = git(work, "rev-parse", "HEAD").trim();
    git(work, "push", "-q", "origin", "HEAD:refs/pull/7/head");
    git(work, "checkout", "-q", "main");
    git(work, "branch", "-q", "-D", "change");
    const plans = join(dir, "plans");
    write(plans, { "app-create.json": change("create"), "net-create.json": change("create"), "app-destroy.json": change("delete"), "net-destroy.json": change("delete") });
    const bin = join(dir, "tofu");
    writeFileSync(bin, FAKE);
    chmodSync(bin, 0o755);
    vi.stubEnv("PLANS", plans);
    vi.stubEnv("LOG", join(dir, "apply.log"));
    vi.stubEnv("ARGS", join(dir, "args.log"));
    const out: string[] = [];
    return { work, origin, bin, log: join(dir, "apply.log"), args: join(dir, "args.log"), head, out };
  }
  const lines = (f: string): string[] => (existsSync(f) ? readFileSync(f, "utf-8").trim().split("\n").filter(Boolean) : []);
  const fakeTerragrunt = (s: ReturnType<typeof setup>): string => {
    const f = join(s.log, "..", "terragrunt");
    writeFileSync(f, FAKE_TG);
    chmodSync(f, 0o755);
    return f;
  };
  const done = (origin: string): EphemeralRecord[] => parseEphemeral(git(origin, "show", `chant/lifecycle:${EPHEMERAL_DONE}`));
  const opts = (s: ReturnType<typeof setup>, extra: Record<string, unknown> = {}) => ({ binary: s.bin, env: { ...process.env, GITHUB_ACTOR: "dev" }, log: (l: string) => s.out.push(l), ...extra });

  it("applies the head's copy of the ephemeral roots under suffixed keys, records it with its expiry, and a close destroys it through a planned destroy", async () => {
    const s = setup('gate: never\nephemeral:\n  roots: ["preview/*"]\n  ttl: 2h\n');
    expect(await ephemeralUp(s.work, { ...opts(s), pr: 7, head: s.head, now: T(0) })).toBe(0);
    // preview/* only, each initialised under its own key with -pr-7, never prod/app and never the root's own key.
    const inits = lines(s.args).filter((l) => l.includes(" init "));
    expect(inits.map((l) => l.split(" ")[0]).sort()).toEqual(["app", "net"]);
    expect(inits.find((l) => l.startsWith("app"))).toContain("-backend-config=key=x/preview/app-pr-7.tfstate");
    expect(lines(s.args).some((l) => l.includes("prod"))).toBe(false);
    expect(lines(s.log).sort()).toEqual(["app-create", "net-create"]);
    const [applied] = done(s.origin);
    expect(applied).toMatchObject({ kind: "ephemeral-apply", pr: 7, suffix: "pr-7", result: "applied", commit: s.head, by: "dev", expiresAt: T(120) });
    expect(applied.roots.map((r) => r.location).sort()).toEqual(["s3://state/x/preview/app-pr-7.tfstate", "s3://state/x/preview/net-pr-7.tfstate"]);
    expect([...readLive(s.work).keys()]).toEqual([7]);

    expect(await ephemeralDown(s.work, { ...opts(s), pr: 7, reason: "closed", now: T(5) })).toBe(0);
    expect(lines(s.log).slice(2)).toEqual(["net-destroy", "app-destroy"]);
    expect(lines(s.args).filter((l) => l.includes(" plan ")).slice(2).every((l) => l.includes("-destroy"))).toBe(true);
    const destroyed = done(s.origin)[1];
    expect(destroyed).toMatchObject({ kind: "ephemeral-destroy", pr: 7, reason: "closed", result: "destroyed", commit: s.head });
    expect(destroyed.planDigest).toMatch(/sha256/);
    expect(readLive(s.work).size).toBe(0);
    // A second close finds nothing to destroy and records nothing.
    expect(await ephemeralDown(s.work, { ...opts(s), pr: 7, reason: "closed", now: T(6) })).toBe(0);
    expect(done(s.origin)).toHaveLength(2);
    expect(s.out.join("\n")).toContain("pull request 7 has no live ephemeral copy");

    // The audit trail lists the apply and the destroy from the record.
    const log = git(s.origin, "log", "-p", "--unified=0", "--reverse", "--format=%x1e%H%x1f%an%x1f%aI", "chant/lifecycle", "--", EPHEMERAL_DONE_FILE);
    const entries = ledgerEntries("host/o/r", EPHEMERAL_DONE_FILE, parseLedgerLog(log));
    expect(entries.map((e) => [e.kind, e.what, e.result, e.detail?.reason])).toEqual([["ephemeral-apply", "pr-7", "applied", undefined], ["ephemeral-destroy", "pr-7", "destroyed", "closed"]]);
    expect(entries[1].digest).toBe(destroyed.planDigest);
  });

  it("waits at its gate under gate: always, and applies once its digest is approved", async () => {
    const s = setup('gate: always\nephemeral:\n  roots: ["preview/app"]\n');
    expect(await ephemeralUp(s.work, { ...opts(s), pr: 7, head: s.head, now: T(0) })).toBe(3);
    expect(lines(s.log)).toEqual([]);
    const pending = parseLedger(git(s.origin, "show", `chant/lifecycle:${EPHEMERAL_LEDGER}`)).pending;
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ op: "tf-ephemeral", gate: "pr-7", members: [{ member: "preview/app" }] });
    expect(s.out.join("\n")).toContain(`chant approve tf-ephemeral pr-7 --plan ${pending[0].planDigest}`);
    // The approval, as chant writes it.
    const clone = join(tmp("tg-eph-approve-"), "l");
    git(tmp(), "clone", "-q", "-b", "chant/lifecycle", s.origin, clone);
    const file = join(clone, EPHEMERAL_LEDGER);
    writeFileSync(file, `${readFileSync(file, "utf-8")}${JSON.stringify({ version: 1, kind: "resolution", op: "tf-ephemeral", gate: "pr-7", resolvedBy: "alice", timestamp: T(1), planDigest: pending[0].planDigest })}\n`);
    git(clone, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-am", "approve");
    git(clone, "push", "-q", "origin", "chant/lifecycle");
    expect(await ephemeralUp(s.work, { ...opts(s), pr: 7, head: s.head, now: T(2) })).toBe(0);
    expect(lines(s.log)).toEqual(["app-create"]);
    expect(done(s.origin)[0]).toMatchObject({ approvedBy: "alice", expiresAt: T(2 + 24 * 60) });
  });

  it("the sweep destroys a copy whose TTL passed, and one whose pull request closed, and leaves the rest", async () => {
    const s = setup('gate: never\nephemeral:\n  roots: ["preview/app"]\n  ttl: 30m\n');
    expect(await ephemeralUp(s.work, { ...opts(s), pr: 7, head: s.head, now: T(0) })).toBe(0);
    vi.stubEnv("TG_TOKEN", "t");
    const states: Record<number, string> = { 7: "open" };
    const fetchFn: Fetch = async (url) => ({ ok: true, status: 200, json: async () => ({ state: states[Number(url.split("/").pop())] }), text: async () => "" });
    const env = { ...process.env, GITHUB_REPOSITORY: "o/r", GITHUB_SERVER_URL: "https://github.example", TG_TOKEN: "t" };
    expect(await ephemeralSweep(s.work, { ...opts(s), env, fetch: fetchFn, now: T(10) })).toBe(0);
    expect(readLive(s.work).has(7)).toBe(true);
    expect(s.out.join("\n")).toContain(`pull request 7: its copy stays; it expires ${T(30)}`);
    expect(await ephemeralSweep(s.work, { ...opts(s), env, fetch: fetchFn, now: T(31) })).toBe(0);
    expect(readLive(s.work).has(7)).toBe(false);
    expect(done(s.origin)[1]).toMatchObject({ kind: "ephemeral-destroy", reason: "expired", by: "terragucci" });
    // Up again, then the forge says the pull request closed.
    expect(await ephemeralUp(s.work, { ...opts(s), pr: 7, head: s.head, now: T(40) })).toBe(0);
    states[7] = "closed";
    expect(await ephemeralSweep(s.work, { ...opts(s), env, fetch: fetchFn, now: T(41) })).toBe(0);
    expect(done(s.origin)[3]).toMatchObject({ kind: "ephemeral-destroy", reason: "closed" });
  });

  it("a destroy that fails leaves the copy live for the next sweep", async () => {
    const s = setup('gate: never\nephemeral:\n  roots: ["preview/app"]\n');
    expect(await ephemeralUp(s.work, { ...opts(s), pr: 7, head: s.head, now: T(0) })).toBe(0);
    vi.stubEnv("FAIL_APPLY", "1");
    expect(await ephemeralDown(s.work, { ...opts(s, { env: { ...process.env } }), pr: 7, reason: "closed", now: T(1) })).toBe(1);
    expect(done(s.origin)[1]).toMatchObject({ result: "failed" });
    expect(readLive(s.work).get(7)).toMatchObject({ destroyFailed: true });
  });

  it("is a config error where no copy can be made: no ephemeral roots", async () => {
    const none = setup("gate: never\n");
    await expect(ephemeralUp(none.work, { ...opts(none), pr: 7, head: none.head })).rejects.toThrow(/names no ephemeral roots/);
  });

  it("with synth, runs the command in the head's checkout before it finds the roots, and again in the applied commit's before a destroy", async () => {
    // The command writes out/stacks/app/cdk.tf.json from app.txt; git holds neither out/ nor a root.
    const synth = "mkdir -p out/stacks/app && echo synth >> \"$SYNTH_LOG\" && printf '{\"terraform\":{\"backend\":{\"s3\":{\"bucket\":\"state\",\"key\":\"x/app.tfstate\"}}}}' > out/stacks/app/cdk.tf.json";
    const s = setup(`gate: never\nsynth: ${JSON.stringify(synth)}\nephemeral:\n  roots: ["out/stacks/*"]\n`);
    const synthLog = join(s.log, "..", "synth.log");
    vi.stubEnv("SYNTH_LOG", synthLog);
    expect(await ephemeralUp(s.work, { ...opts(s), pr: 7, head: s.head, now: T(0) })).toBe(0);
    expect(lines(synthLog)).toEqual(["synth"]);
    expect(lines(s.args).find((l) => l.includes(" init "))).toContain("-backend-config=key=x/app-pr-7.tfstate");
    expect(done(s.origin)[0].roots).toEqual([{ root: "out/stacks/app", location: "s3://state/x/app-pr-7.tfstate", result: "applied" }]);
    expect(await ephemeralDown(s.work, { ...opts(s), pr: 7, reason: "closed", now: T(1) })).toBe(0);
    expect(lines(synthLog)).toEqual(["synth", "synth"]);
    expect(done(s.origin)[1]).toMatchObject({ result: "destroyed" });
    // A synth that fails copies nothing, and says so.
    const broken = setup('gate: never\nsynth: "exit 3"\nephemeral:\n  roots: ["out/stacks/*"]\n');
    expect(await ephemeralUp(broken.work, { ...opts(broken), pr: 7, head: broken.head, now: T(0) })).toBe(1);
    expect(broken.out.join("\n")).toContain("the synth command failed, so there are no roots to copy");
    expect(lines(broken.args)).toEqual([]);
  });

  it("in a Terragrunt repo, prepares each unit through Terragrunt with the suffix set, and refuses a unit whose key does not take it", async () => {
    const s = setup('gate: never\nterragrunt: {}\nephemeral:\n  roots: ["live/preview/*"]\n');
    const tgBin = fakeTerragrunt(s);
    git(s.work, "checkout", "-q", "-b", "units");
    write(s.work, {
      "root.hcl": `remote_state {\n  backend = "s3"\n  config = {\n    bucket = "state"\n    key    = "x/\${path_relative_to_include()}/terraform\${get_env("TERRAGUCCI_EPHEMERAL_SUFFIX", "")}.tfstate"\n  }\n}\n`,
      "live/preview/net/terragrunt.hcl": 'include "root" {\n  path = find_in_parent_folders("root.hcl")\n}\n',
      "live/preview/app/terragrunt.hcl": 'include "root" {\n  path = find_in_parent_folders("root.hcl")\n}\n\ndependency "net" {\n  config_path = "../net"\n}\n',
      "live/prod/app/terragrunt.hcl": 'include "root" {\n  path = find_in_parent_folders("root.hcl")\n}\n',
    });
    git(s.work, "add", "-A");
    git(s.work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "units");
    const head = git(s.work, "rev-parse", "HEAD").trim();
    git(s.work, "push", "-q", "-f", "origin", "HEAD:refs/pull/7/head");
    git(s.work, "push", "-q", "-f", "origin", "HEAD:main");
    const env = { ...process.env, GITHUB_ACTOR: "dev", TERRAGUCCI_TERRAGRUNT: tgBin };
    expect(await ephemeralUp(s.work, { ...opts(s), env, pr: 7, head, now: T(0) })).toBe(0);
    // net before app, which reads it; never live/prod/app; each prepared with the suffix, and never given a -backend-config.
    const prepared = lines(join(s.log, "..", "tg.log"));
    expect(prepared).toEqual(["live/preview/net -pr-7", "live/preview/app -pr-7"]);
    expect(lines(s.args).some((l) => l.includes("-backend-config"))).toBe(false);
    expect(lines(s.log)).toEqual(["net-create", "app-create"]);
    expect(done(s.origin)[0].roots.map((r) => r.location)).toEqual(["s3://state/x/live/preview/net/terraform-pr-7.tfstate", "s3://state/x/live/preview/app/terraform-pr-7.tfstate"]);
    expect(await ephemeralDown(s.work, { ...opts(s), env, pr: 7, reason: "closed", now: T(1) })).toBe(0);
    expect(lines(s.log).slice(2)).toEqual(["app-destroy", "net-destroy"]);

    // A key that does not read the suffix: refused before anything plans, as a config error naming the file.
    write(s.work, { "root.hcl": 'remote_state {\n  backend = "s3"\n  config = {\n    bucket = "state"\n    key    = "x/${path_relative_to_include()}/terraform.tfstate"\n  }\n}\n' });
    git(s.work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-am", "no suffix");
    const bare = git(s.work, "rev-parse", "HEAD").trim();
    git(s.work, "push", "-q", "-f", "origin", "HEAD:refs/pull/8/head");
    const before = lines(s.args).length;
    await expect(ephemeralUp(s.work, { ...opts(s), env, pr: 8, head: bare, now: T(2) })).rejects.toThrow(/ephemeral: the remote_state block in root.hcl does not read TERRAGUCCI_EPHEMERAL_SUFFIX, so a copy would plan at the unit's own key; make the remote_state block's key read the suffix/);
    expect(lines(s.args).length).toBe(before);
    // A key the file names but Terragrunt does not give the binary (the variable read elsewhere): refused once prepared.
    write(s.work, { "root.hcl": '# TERRAGUCCI_EPHEMERAL_SUFFIX is read nowhere\nremote_state {\n  backend = "s3"\n  config = {\n    bucket = "state"\n    key    = "x/${path_relative_to_include()}/terraform.tfstate"\n  }\n}\n' });
    git(s.work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-am", "suffix in a comment");
    const comment = git(s.work, "rev-parse", "HEAD").trim();
    git(s.work, "push", "-q", "-f", "origin", "HEAD:refs/pull/9/head");
    const planned = lines(s.args).filter((l) => / (plan|apply) /.test(l)).length;
    await expect(ephemeralUp(s.work, { ...opts(s), env: { ...env, TG_NO_SUFFIX: "1" }, pr: 9, head: comment, now: T(3) })).rejects.toThrow(/live\/preview\/net: its s3 backend's key is x\/live\/preview\/net\/terraform\.tfstate with TERRAGUCCI_EPHEMERAL_SUFFIX set, which is the unit's own state, so its copy is refused/);
    expect(lines(s.args).filter((l) => / (plan|apply) /.test(l)).length).toBe(planned);
  });

  it("reads its settings from the base, never the pull request's own terragucci.yml", async () => {
    const s = setup('gate: never\nephemeral:\n  roots: ["preview/app"]\n');
    // The pull request widens ephemeral.roots in its own copy of the file; the base's still names preview/app alone.
    git(s.work, "checkout", "-q", "-b", "wider");
    write(s.work, { "terragucci.yml": 'gate: never\nephemeral:\n  roots: ["**"]\n' });
    expect(await ephemeralUp(s.work, { ...opts(s), base: "main", pr: 7, head: s.head, now: T(0) })).toBe(0);
    expect(lines(s.log)).toEqual(["app-create"]);
  });
});

describe("ephemeral in terragucci.yml", () => {
  it("is checked by config check", () => {
    expect(validateConfig({ ephemeral: { roots: ["envs/preview/*"], ttl: "3d", sweep: 15 } }, "t")).toEqual({ ephemeral: { roots: ["envs/preview/*"], ttl: "3d", sweep: 15 } });
    expect(() => validateConfig({ ephemeral: ["a"] }, "t")).toThrow("config.ephemeral must be a map");
    expect(() => validateConfig({ ephemeral: { roots: [] } }, "t")).toThrow("config.ephemeral.roots must be a list of root globs");
    expect(() => validateConfig({ ephemeral: { roots: ["a"], ttl: "2w" } }, "t")).toThrow("config.ephemeral.ttl must be a duration");
    expect(() => validateConfig({ ephemeral: { roots: ["a"], sweep: 2 } }, "t")).toThrow("config.ephemeral.sweep must be a whole number of minutes from 5 to 60");
    expect(() => validateConfig({ ephemeral: { roots: ["a"], workspace: "x" } }, "t")).toThrow("config.ephemeral.workspace is not a setting");
    // Every binary and repo shape takes it: a Terragrunt repo and synth alike.
    expect(validateConfig({ terragrunt: { version: "1.1.0" }, ephemeral: { roots: ["a"] } }, "t")).toMatchObject({ ephemeral: { roots: ["a"] } });
    expect(validateConfig({ synth: "npx cdktn synth", ephemeral: { roots: ["a"] } }, "t")).toMatchObject({ synth: "npx cdktn synth" });
    expect(() => validateConfig({ forge: "gitlab", gitlab: { token: "protected" }, comments: "*/5 * * * *", ephemeral: { roots: ["a"] } }, "t")).toThrow("config.ephemeral: a merge request pipeline applies the copy");
  });
});

describe("the ephemeral jobs", () => {
  const tree = [["network"], ["preview/app"]];
  const pipeline = (forge: ForgeName, extra: Record<string, unknown> = {}) =>
    renderPipeline({ forge, binary: "tofu", version: "1.13.1", image: "img:1", layers: tree, env: {}, ephemeral: { sweep: 15 }, ...extra } as never);

  it.each(["github", "forgejo"] as const)("%s: the default branch's workflow applies a pull request's copy and destroys it on close, and a schedule sweeps", (forge) => {
    const rendered = pipeline(forge, { oidc: { plan_role: "arn:aws:iam::1:role/p", apply_role: "arn:aws:iam::1:role/a" } });
    const doc = body(rendered.content);
    expect(doc.on.pull_request_target.types).toEqual(["opened", "reopened", "synchronize", "closed"]);
    const job = doc.jobs.ephemeral;
    expect(job.if).toBe("github.event_name == 'pull_request_target' && github.event.pull_request.head.repo.full_name == github.repository");
    expect(job.env).toMatchObject({ TG_PR: "${{ github.event.pull_request.number }}", TG_SHA: "${{ github.event.pull_request.head.sha }}", TG_ACTION: "${{ github.event.action }}" });
    const run = job.steps.map((x: { run?: string }) => x.run ?? "").join("\n");
    expect(run).toContain('terragucci ephemeral down --pr "$TG_PR" --reason closed');
    expect(run).toContain('terragucci ephemeral up --pr "$TG_PR" --head "$TG_SHA"');
    // The apply role, never the plan role.
    expect(run).toContain("arn:aws:iam::1:role/a");
    expect(run).not.toContain("arn:aws:iam::1:role/p");
    expect(job.steps[0].uses).toMatch(/actions\/checkout@v4$/);
    expect(job.steps[0].with).toEqual({ "fetch-depth": 0 });
    const sweep = rendered.extra!.find((f) => f.path.endsWith("terragucci-ephemeral.yml"))!;
    expect(sweep.path).toBe(`.${forge}/workflows/terragucci-ephemeral.yml`);
    const sw = body(sweep.content);
    expect(sw.on.schedule).toEqual([{ cron: "*/15 * * * *" }]);
    expect(sw.jobs.sweep.steps.map((x: { run?: string }) => x.run ?? "").join("\n")).toContain("terragucci ephemeral sweep");
    // The push's jobs do not run on the pull request's events.
    for (const [name, j] of Object.entries(doc.jobs as Record<string, { if?: string; needs?: unknown }>)) {
      if (name === "ephemeral") continue;
      expect(j.needs !== undefined || (j.if ?? "").includes("github.event_name"), name).toBe(true);
    }
  });

  it("on GitLab the merge request's pipeline applies its copy, and a schedule sweeps the expired and the closed", () => {
    const doc = body(pipeline("gitlab", { drift: "0 6 * * *" }).content);
    expect(doc.ephemeral.rules).toEqual([{ if: '$CI_PIPELINE_SOURCE == "merge_request_event" && $CI_MERGE_REQUEST_SOURCE_PROJECT_PATH == $CI_PROJECT_PATH' }]);
    const script = JSON.stringify(doc.ephemeral.script);
    expect(script).toContain("terragucci ephemeral up --pr \\\"$CI_MERGE_REQUEST_IID\\\"");
    expect(script).toContain('--base \\"origin/${CI_DEFAULT_BRANCH}\\"');
    expect(doc["ephemeral-sweep"].rules).toEqual([{ if: '$CI_PIPELINE_SOURCE == "schedule" && $TERRAGUCCI_SCHEDULE == "ephemeral"' }]);
    expect(doc.drift.rules[0].if).toContain('$TERRAGUCCI_SCHEDULE != "ephemeral"');
  });

  it("renders as before without it, renders in a Terragrunt repo and with synth, and is refused on GitLab with a protected token", () => {
    for (const forge of ["github", "forgejo", "gitlab"] as const) {
      const plain = pipeline(forge, { ephemeral: undefined });
      expect(plain.content).not.toContain("ephemeral");
      expect((plain.extra ?? []).some((f) => f.path.includes("ephemeral"))).toBe(false);
    }
    // Terragrunt: the job points Terragrunt's caches where every Terragrunt job does, and maps each unit to its apply role.
    const tg = { installs: [], version: "0.99.1", parallelism: 4, exclude: [], credentials: { "live/**": { plan: "arn:aws:iam::1:role/tp", apply: "arn:aws:iam::1:role/ta" } } };
    for (const forge of ["github", "forgejo"] as const) {
      const doc = body(pipeline(forge, { terragrunt: tg }).content);
      const run = doc.jobs.ephemeral.steps.map((x: { run?: string }) => x.run ?? "").join("\n");
      expect(run).toMatch(/export TG_DOWNLOAD_DIR=[\s\S]*TERRAGUCCI_PHASE=apply[\s\S]*terragucci ephemeral up/);
      expect(run).toContain("arn:aws:iam::1:role/ta");
      expect(run).not.toContain("arn:aws:iam::1:role/tp");
    }
    const gl = JSON.stringify(body(pipeline("gitlab", { terragrunt: tg }).content).ephemeral.script);
    expect(gl).toMatch(/TG_DOWNLOAD_DIR.*terragucci ephemeral up/);
    // synth: the job runs terragucci ephemeral, which runs the command in the head's checkout.
    expect(body(pipeline("github", { synth: "npx cdktn synth" }).content).jobs.ephemeral).toBeDefined();
    expect(() => pipeline("gitlab", { gitlabToken: "protected", comments: "*/5 * * * *" })).toThrow(/ephemeral: a merge request pipeline/);
  });
});

describe("the estate page", () => {
  it("lists each live ephemeral environment with its roots and expiry", () => {
    const list = updateList(undefined, "host/o/r", 7, { pull_request: 7, pull_request_url: "https://host/o/r/pulls/7", suffix: "pr-7", roots: [{ root: "preview/app", location: "s3://state/x/preview/app-pr-7.tfstate" }], commit: "abcdef1234567890", applied: T(0), expires: T(120), status: "live" }, T(0));
    const later = updateList(JSON.stringify(list), "host/o/r", 8, { ...list.environments[0], pull_request: 8, expires: T(10) }, T(0));
    const estate = buildEstate([{ project: "host/o/r", reports: [], ephemeral: later }], new Date(T(30)));
    expect(estate.totals.ephemeral).toBe(2);
    expect(estate.projects[0].ephemeral!.map((e) => e.pull_request)).toEqual([7, 8]);
    const html = renderEstateHtml(estate);
    expect(html).toContain('<h2 id="ephemeral">Ephemeral environments</h2>');
    expect(html).toMatch(/<tr data-pr="7">.*s3:\/\/state\/x\/preview\/app-pr-7\.tfstate.*in 1h 30m/);
    expect(html).toMatch(/<tr data-pr="8">.*expired .*the next sweep destroys it/);
    expect(renderEstateHtml(buildEstate([{ project: "host/o/r", reports: [] }], new Date(T(30))))).toContain("No pull request has a live ephemeral environment.");
  });
});
