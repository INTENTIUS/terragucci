import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { approve, describeStored, waitingWaves } from "../src/approve";
import { approvedPath, parseLedger } from "../src/apply";
import { init, signerLine } from "../src/init";
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
    const r = await approve(work, { chant: fake, sign: "/keys/me", log: () => {} });
    expect(r.code).toBe(0);
    expect(readFileSync(join(work, "..", "args"), "utf-8").trim()).toBe("approve tf-apply wave-2 --plan jcs1-sha256:cc --sign /keys/me");
  });

  it("refuses when no wave waits, when several do and none is named, and a wave that does not wait", async () => {
    await expect(approve(checkout(jsonl(pending("wave-1", "jcs1-sha256:aa", 1), resolution("wave-1", "jcs1-sha256:aa", 2))), { dryRun: true, log: () => {} })).rejects.toThrow(/no wave waits/);
    const two = checkout(jsonl(pending("wave-1", "jcs1-sha256:aa", 1), pending("wave-2", "jcs1-sha256:cc", 1)));
    await expect(approve(two, { dryRun: true, log: () => {} })).rejects.toThrow(/2 waves wait \(wave-1, wave-2\)/);
    expect((await approve(two, { wave: "wave-2", dryRun: true, log: () => {} })).wave.digest).toBe("jcs1-sha256:cc");
    await expect(approve(two, { wave: "3", dryRun: true, log: () => {} })).rejects.toThrow(/wave-3 is not waiting/);
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
