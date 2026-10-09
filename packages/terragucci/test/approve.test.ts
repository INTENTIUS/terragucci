import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { approve, describeMigration, describeStored, overrideDenial, waitingMigrations, waitingWaves } from "../src/approve";
import { keptPath } from "../src/migrate";
import { approvedPath, parseLedger } from "../src/apply";
import { init, signerLine } from "../src/init";
import { decideOverride, OVERRIDE_LEDGER, overrideDigest, recordedDenials } from "../src/override";
import { git, tmp, twoRootRepo, write } from "./helpers";

const T = (h: number): string => new Date(Date.UTC(2026, 0, 1, h)).toISOString();
const pending = (gate: string, digest: string, h: number) => ({ version: 1, kind: "pending", op: "tf-apply", gate, timestamp: T(h), expiresAt: T(h + 48), planDigest: digest, description: `${gate}: a` });
const resolution = (gate: string, digest: string, h: number) => ({ version: 1, kind: "resolution", op: "tf-apply", gate, resolvedBy: "alice", timestamp: T(h), planDigest: digest });
const jsonl = (...lines: unknown[]) => lines.map((l) => JSON.stringify(l)).join("\n") + "\n";

describe("waitingWaves", () => {
  it("is each gate's newest pending fact that no approval of its digest answers", () => {
    const ledger = parseLedger(jsonl(
      pending("wave-1", "jcs1-sha256:aa", 1), resolution("wave-1", "jcs1-sha256:aa", 2),
      pending("wave-2", "jcs1-sha256:bb", 1), pending("wave-2", "jcs1-sha256:cc", 3), resolution("wave-2", "jcs1-sha256:bb", 4),
      pending("wave-3", "jcs1-sha256:dd", 1), resolution("wave-3", "jcs1-sha256:dd", 0),
    ));
    expect(waitingWaves(ledger).map((w) => [w.wave, w.digest])).toEqual([[2, "jcs1-sha256:cc"], [3, "jcs1-sha256:dd"]]);
  });
});

describe("describeStored", () => {
  it("names the roots and every destroy, and says when there is no report", () => {
    expect(describeStored(JSON.stringify({ roots: [{ path: "a" }], named: [{ root: "a", address: "x.y", action: "delete" }] }))).toEqual(["  roots: a", "  destroys a: x.y"]);
    expect(describeStored(undefined)[0]).toMatch(/kept no report/);
  });
});

describe("terragucci approve", () => {
  /** A checkout whose origin's chant/lifecycle holds `ledger` and the report kept for `digest`. */
  function checkout(ledger: string, files: Record<string, string> = {}): string {
    const dir = tmp("tg-approve-");
    const origin = join(dir, "origin.git");
    execFileSync("git", ["init", "-q", "--bare", origin]);
    const life = join(dir, "life");
    git(dir, "init", "-q", "-b", "chant/lifecycle", life);
    write(life, { "_gates/tf-apply.jsonl": ledger, [approvedPath(2, "jcs1-sha256:cc")]: JSON.stringify({ roots: [{ path: "app" }], named: [] }) });
    git(life, "add", "-A");
    git(life, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "ledger");
    git(life, "push", "-q", origin, "chant/lifecycle");
    const work = join(dir, "work");
    git(dir, "init", "-q", "-b", "main", work);
    write(work, files);
    git(work, "remote", "add", "origin", origin);
    return work;
  }

  it("with one wave waiting, a dry run prints what it does and the chant approve command for its digest", async () => {
    const lines: string[] = [];
    const work = checkout(jsonl(pending("wave-2", "jcs1-sha256:cc", 1)));
    const r = await approve(work, { dryRun: true, log: (l) => void lines.push(l) });
    expect(r.command).toBe("chant approve tf-apply wave-2 --plan jcs1-sha256:cc");
    expect(lines).toContain("  roots: app");
    expect(lines.at(-1)).toBe("would run: chant approve tf-apply wave-2 --plan jcs1-sha256:cc");
  });

  it("asks for --sign under approval: sealed, passes --actor, and runs the chant it is given", async () => {
    const work = checkout(jsonl(pending("wave-2", "jcs1-sha256:cc", 1)), { "terragucci.yml": "approval: sealed\n" });
    expect((await approve(work, { dryRun: true, actor: "github:alice", log: () => {} })).command).toBe("chant approve tf-apply wave-2 --plan jcs1-sha256:cc --actor github:alice --sign");
    const fake = join(work, "..", "chant.sh");
    write(join(work, ".."), { "chant.sh": `#!/bin/sh\necho "$@" > ${JSON.stringify(join(work, "..", "args"))}\n` });
    execFileSync("chmod", ["+x", fake]);
    const lines: string[] = [];
    const r = await approve(work, { chant: fake, sign: "/keys/me", log: (l) => void lines.push(l) });
    expect(r.code).toBe(0);
    // A local origin names no forge: the approval stands, and the line says how the wave resumes.
    expect(lines.at(-1)).toMatch(/^not resumed from here: the origin is not on github.com or gitlab.com/);
    expect(readFileSync(join(work, "..", "args"), "utf-8").trim()).toBe("approve tf-apply wave-2 --plan jcs1-sha256:cc --sign /keys/me");
    const quiet: string[] = [];
    await approve(work, { chant: fake, resume: false, log: (l) => void quiet.push(l) });
    expect(quiet.at(-1)).toMatch(/^not resumed \(--no-resume\)/);
  });

  it("refuses when no wave waits, when several do and none is named, and a wave that does not wait", async () => {
    await expect(approve(checkout(jsonl(pending("wave-1", "jcs1-sha256:aa", 1), resolution("wave-1", "jcs1-sha256:aa", 2))), { dryRun: true, log: () => {} })).rejects.toThrow(/no wave waits/);
    const two = checkout(jsonl(pending("wave-1", "jcs1-sha256:aa", 1), pending("wave-2", "jcs1-sha256:cc", 1)));
    await expect(approve(two, { dryRun: true, log: () => {} })).rejects.toThrow(/2 waves wait \(wave-1, wave-2\)/);
    expect((await approve(two, { wave: "wave-2", dryRun: true, log: () => {} })).wave!.digest).toBe("jcs1-sha256:cc");
    await expect(approve(two, { wave: "3", dryRun: true, log: () => {} })).rejects.toThrow(/wave-3 is not waiting/);
  });

  it("with --plan approves only a wave waiting for that digest, and otherwise exits 1 naming the digest waiting", async () => {
    const two = checkout(jsonl(pending("wave-1", "jcs1-sha256:aa", 1), pending("wave-2", "jcs1-sha256:cc", 1)));
    // The digest picks the wave among several, with no wave named.
    expect(await approve(two, { plan: "jcs1-sha256:cc", dryRun: true, log: () => {} })).toMatchObject({ code: 0, command: "chant approve tf-apply wave-2 --plan jcs1-sha256:cc", wave: { wave: 2 } });
    expect((await approve(two, { wave: "wave-1", plan: "jcs1-sha256:aa", dryRun: true, log: () => {} })).command).toBe("chant approve tf-apply wave-1 --plan jcs1-sha256:aa");
    // A stale digest: the plans moved since it was read.
    let lines: string[] = [];
    let r = await approve(two, { wave: "wave-2", plan: "jcs1-sha256:old", log: (l) => void lines.push(l) });
    expect(r).toEqual({ code: 1, command: "" });
    expect(lines).toEqual(["not approved: wave-2 waits for jcs1-sha256:old; waiting: wave-2 for jcs1-sha256:cc. The plans moved since that digest, or were approved and applied; read the waiting plans, then approve their digest"]);
    lines = [];
    r = await approve(two, { plan: "jcs1-sha256:old", log: (l) => void lines.push(l) });
    expect(r.code).toBe(1);
    expect(lines[0]).toContain("waiting: wave-1 for jcs1-sha256:aa, wave-2 for jcs1-sha256:cc");
    // Nothing waits: the digest was approved already.
    lines = [];
    const none = checkout(jsonl(pending("wave-1", "jcs1-sha256:aa", 1), resolution("wave-1", "jcs1-sha256:aa", 2)));
    expect((await approve(none, { plan: "jcs1-sha256:aa", log: (l) => void lines.push(l) })).code).toBe(1);
    expect(lines[0]).toMatch(/^not approved: no wave waits for jcs1-sha256:aa: no wave waits for an approval/);
    await expect(approve(two, { plan: "", dryRun: true, log: () => {} })).rejects.toThrow(/--plan takes the digest/);
  });
});

describe("terragucci approve, a state migration", () => {
  const mpending = (gate: string, digest: string, h: number) => ({ ...pending(gate, digest, h), op: "tf-migrate", description: `migration ${gate}: one, two`, runId: "88", commit: "c".repeat(40) });
  const mresolution = (gate: string, digest: string, h: number) => ({ ...resolution(gate, digest, h), op: "tf-migrate" });
  const record = JSON.stringify({ moves: [{ from: "one", to: "two", addresses: ["terraform_data.b"] }], roots: [{ root: "one", location: "s3://b/one.tfstate", before: { version_id: "v1", digest: "sha256:x" } }, { root: "two", location: "s3://b/two.tfstate", before: { digest: null } }] });

  /** A checkout whose origin's chant/lifecycle holds `migrations` in the migration ledger, `waves` in the waves', and the plan record kept for split-b. */
  function checkout(migrations: string, waves = ""): string {
    const dir = tmp("tg-approve-mig-");
    const origin = join(dir, "origin.git");
    execFileSync("git", ["init", "-q", "--bare", origin]);
    const life = join(dir, "life");
    git(dir, "init", "-q", "-b", "chant/lifecycle", life);
    write(life, { "_gates/tf-migrate.jsonl": migrations, ...(waves ? { "_gates/tf-apply.jsonl": waves } : {}), [keptPath("split-b", "jcs1-sha256:mm")]: record });
    git(life, "add", "-A");
    git(life, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "ledger");
    git(life, "push", "-q", origin, "chant/lifecycle");
    const work = join(dir, "work");
    git(dir, "init", "-q", "-b", "main", work);
    git(work, "remote", "add", "origin", origin);
    return work;
  }

  it("is waiting until an approval of its newest digest answers it", () => {
    const ledger = parseLedger(jsonl(mpending("split-b", "jcs1-sha256:aa", 1), mpending("split-b", "jcs1-sha256:mm", 3), mresolution("split-b", "jcs1-sha256:aa", 4), mpending("merge-c", "jcs1-sha256:cc", 1), mresolution("merge-c", "jcs1-sha256:cc", 2)));
    expect(waitingMigrations(ledger).map((m) => [m.migration, m.digest, m.runId])).toEqual([["split-b", "jcs1-sha256:mm", "88"]]);
    expect(describeMigration(record)).toEqual(["  moves terraform_data.b from one to two", "  one: s3://b/one.tfstate at version v1", "  two: s3://b/two.tfstate, no state yet", "  every root planned with no change against its new state"]);
  });

  it("alone, a dry run says what it moves and prints chant approve tf-migrate for its digest", async () => {
    const lines: string[] = [];
    const r = await approve(checkout(jsonl(mpending("split-b", "jcs1-sha256:mm", 1))), { dryRun: true, log: (l) => void lines.push(l) });
    expect(r.command).toBe("chant approve tf-migrate split-b --plan jcs1-sha256:mm");
    expect(r.migration?.migration).toBe("split-b");
    expect(lines).toContain("  moves terraform_data.b from one to two");
    expect(lines.at(-1)).toBe("would run: chant approve tf-migrate split-b --plan jcs1-sha256:mm");
  });

  it("is named, or found by its digest, beside a waiting wave; a stale digest or another name approves nothing", async () => {
    const work = checkout(jsonl(mpending("split-b", "jcs1-sha256:mm", 1)), jsonl(pending("wave-2", "jcs1-sha256:cc", 1)));
    await expect(approve(work, { dryRun: true, log: () => {} })).rejects.toThrow(/2 gates wait \(wave-2, migration split-b\)/);
    expect((await approve(work, { wave: "split-b", dryRun: true, log: () => {} })).command).toBe("chant approve tf-migrate split-b --plan jcs1-sha256:mm");
    expect((await approve(work, { plan: "jcs1-sha256:mm", dryRun: true, log: () => {} })).command).toBe("chant approve tf-migrate split-b --plan jcs1-sha256:mm");
    expect((await approve(work, { wave: "wave-2", dryRun: true, log: () => {} })).command).toBe("chant approve tf-apply wave-2 --plan jcs1-sha256:cc");
    const lines: string[] = [];
    expect(await approve(work, { wave: "split-b", plan: "jcs1-sha256:old", log: (l) => void lines.push(l) })).toEqual({ code: 1, command: "" });
    expect(lines[0]).toContain("migration split-b waits for jcs1-sha256:mm, not jcs1-sha256:old");
    await expect(approve(work, { wave: "merge-c", dryRun: true, log: () => {} })).rejects.toThrow(/no migration merge-c waits; waiting: split-b|no migration merge-c waits for an approval; waiting: split-b/);
  });

  it("runs the chant it is given, with --sign under approval: sealed, then says how wave 1 resumes", async () => {
    const work = checkout(jsonl(mpending("split-b", "jcs1-sha256:mm", 1)));
    write(work, { "terragucci.yml": "approval: sealed\n" });
    write(join(work, ".."), { "chant.sh": `#!/bin/sh\necho "$@" > ${JSON.stringify(join(work, "..", "args"))}\n` });
    execFileSync("chmod", ["+x", join(work, "..", "chant.sh")]);
    const lines: string[] = [];
    expect((await approve(work, { chant: join(work, "..", "chant.sh"), log: (l) => void lines.push(l) })).code).toBe(0);
    expect(readFileSync(join(work, "..", "args"), "utf-8").trim()).toBe("approve tf-migrate split-b --plan jcs1-sha256:mm --sign");
    expect(lines).toContain("approved migration split-b");
    expect(lines.at(-1)).toMatch(/^not resumed from here: the origin is not on github.com or gitlab.com.*run wave 1 again/);
  });
});

describe("terragucci override", () => {
  const plan = "jcs1-sha256:" + "1".repeat(64);
  const digest = overrideDigest("envs/prod/app", plan, ["main.deny_public", "main.deny_data"]);
  const denial = (h: number, d = digest) => ({ version: 1, kind: "pending", op: "policy-override", gate: "envs/prod/app", timestamp: T(h), expiresAt: T(h + 48), planDigest: d, members: [{ member: "envs/prod/app", planDigest: plan }], rules: ["main.deny_data", "main.deny_public"] });
  function checkout(ledger: string, files: Record<string, string> = {}): string {
    const dir = tmp("tg-override-");
    const origin = join(dir, "origin.git");
    execFileSync("git", ["init", "-q", "--bare", origin]);
    const life = join(dir, "life");
    git(dir, "init", "-q", "-b", "chant/lifecycle", life);
    write(life, { [OVERRIDE_LEDGER]: ledger });
    git(life, "add", "-A");
    git(life, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "ledger");
    git(life, "push", "-q", origin, "chant/lifecycle");
    const work = join(dir, "work");
    git(dir, "init", "-q", "-b", "main", work);
    write(work, files);
    git(work, "remote", "add", "origin", origin);
    return work;
  }

  it("binds the root, its plan digest and the rules, in any order, and nothing else", () => {
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(overrideDigest("envs/prod/app", plan, ["main.deny_data", "main.deny_public", "main.deny_data"])).toBe(digest);
    expect(overrideDigest("envs/prod/app", plan, ["main.deny_data"])).not.toBe(digest);
    expect(overrideDigest("envs/prod/other", plan, ["main.deny_public", "main.deny_data"])).not.toBe(digest);
    expect(overrideDigest("envs/prod/app", "jcs1-sha256:" + "2".repeat(64), ["main.deny_public", "main.deny_data"])).not.toBe(digest);
  });

  it("an override older than the newest denial of the root does not answer it", () => {
    const rule = { mode: "ledger" as const, overriders: ["Alice"], signers: null, signersPath: ".chant/allowed_signers" };
    const line = (h: number) => ({ version: 1, kind: "resolution", op: "policy-override", gate: "envs/prod/app", resolvedBy: "alice", timestamp: T(h), planDigest: digest, note: "why" });
    const rules = ["main.deny_public", "main.deny_data"];
    expect(decideOverride(parseLedger(jsonl(denial(1), line(2))), rule, "envs/prod/app", plan, rules, T(3)).status).toBe("overridden");
    expect(decideOverride(parseLedger(jsonl(denial(1), line(2), denial(3))), rule, "envs/prod/app", plan, rules, T(4)).status).toBe("none");
    expect(recordedDenials(parseLedger(jsonl(denial(1), denial(3)))).map((d) => d.timestamp)).toEqual([T(3)]);
  });

  it("a dry run names the plan and rules denied and prints the chant approve command with the reason", async () => {
    const lines: string[] = [];
    const work = checkout(jsonl(denial(1)));
    const r = await overrideDenial(work, { root: "envs/prod/app", rules: ["main.deny_public", "main.deny_data"], reason: "the outage needs it", actor: "github:alice", dryRun: true, log: (l) => void lines.push(l) });
    expect(r.command).toBe(`chant approve policy-override envs/prod/app --plan ${digest} --note 'the outage needs it' --actor github:alice`);
    expect(lines[0]).toContain(`its plan ${plan} was denied by main.deny_data, main.deny_public`);
  });

  it("asks for --sign under approval: sealed and runs the chant it is given", async () => {
    const work = checkout(jsonl(denial(1)), { "terragucci.yml": "approval: sealed\n" });
    const fake = join(work, "..", "chant.sh");
    write(join(work, ".."), { "chant.sh": `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(join(work, "..", "args"))}\n` });
    execFileSync("chmod", ["+x", fake]);
    const r = await overrideDenial(work, { root: "envs/prod/app", rules: ["main.deny_data", "main.deny_public"], reason: "why", chant: fake, log: () => {} });
    expect(r.code).toBe(0);
    expect(readFileSync(join(work, "..", "args"), "utf-8").trim().split("\n")).toEqual(["approve", "policy-override", "envs/prod/app", "--plan", digest, "--note", "why", "--sign"]);
  });

  it("refuses rules that are not exactly the rules that denied the plan, a root with no denial, and no reason", async () => {
    const work = checkout(jsonl(denial(1)));
    await expect(overrideDenial(work, { root: "envs/prod/app", rules: ["main.deny_data"], reason: "why", dryRun: true, log: () => {} })).rejects.toThrow(/denied by main.deny_data, main.deny_public; an override names exactly those rules/);
    await expect(overrideDenial(work, { root: "envs/dev/app", rules: ["main.deny_data"], reason: "why", dryRun: true, log: () => {} })).rejects.toThrow(/no denial of envs\/dev\/app is recorded.*denied: envs\/prod\/app/);
    await expect(overrideDenial(work, { root: "envs/prod/app", rules: ["main.deny_data", "main.deny_public"], reason: " ", dryRun: true, log: () => {} })).rejects.toThrow(/needs --reason/);
  });
});

describe("init --signer", () => {
  it("under approval: sealed writes the first signers line from git config user.signingkey", async () => {
    const dir = twoRootRepo();
    git(dir, "init", "-q");
    git(dir, "remote", "add", "origin", "https://github.com/acme/infra.git");
    git(dir, "config", "user.signingkey", "key::ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGb6 me@laptop");
    expect(signerLine(dir, "github:alice")).toBe("github:alice ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGb6\n");
    const r = await init(dir, { binary: "tofu", approval: "sealed", signer: "github:alice" });
    expect(readFileSync(join(dir, ".chant/allowed_signers"), "utf-8")).toBe("github:alice ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGb6\n");
    expect(r.notes.join("\n")).toMatch(/lists github:alice/);
    // Run again, the file stays as it is.
    expect((await init(dir, { binary: "tofu", signer: "github:bob" })).notes.join("\n")).toMatch(/exists and init does not edit it/);
  });

  it("without --signer under sealed, init says how to write the file; a bad principal or no key is refused", async () => {
    const dir = twoRootRepo();
    git(dir, "init", "-q");
    git(dir, "remote", "add", "origin", "https://github.com/acme/infra.git");
    expect((await init(dir, { binary: "tofu", approval: "sealed" })).notes.join("\n")).toMatch(/terragucci init --signer/);
    expect(() => signerLine(dir, "two words")).toThrow(/not a principal/);
  });
});
