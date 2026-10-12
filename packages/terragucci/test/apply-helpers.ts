/** What the applyWave tests share: a work tree with an origin, a fake tofu, the gate ledger's records and an approval. */

import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { vi } from "vitest";
import { type PendingRecord } from "../src/apply";
import { git, tmp, write } from "./helpers";

// Hours from the start of the run: chant stamps the pending facts it records with the time it runs, so an approval at T(h) is newer than any of them.
export const T0 = Date.now();
export const T = (h: number): string => new Date(T0 + h * 3600_000).toISOString();
export const pending = (gate: string, digest: string, at: number, hours = 48): PendingRecord => ({
  version: 1, kind: "pending", op: "tf-apply", gate, timestamp: T(at), expiresAt: T(at + hours), planDigest: digest,
});
export const resolution = (gate: string, digest: string, at: number) => ({ version: 1 as const, op: "tf-apply", gate, resolvedBy: "alice", timestamp: T(at), planDigest: digest });

/** A fake tofu: plan writes the root into the plan file, show -json prints $PLANS/<root>.json, apply logs the root. */
export const FAKE = `#!/usr/bin/env bash
dir="\${1#-chdir=}"; root="$(basename "$dir")"
case "$2" in
  plan) for a in "$@"; do case "$a" in -out=*) echo "$root" > "\${a#-out=}" ;; esac; done; echo "Plan: 1 to add" ;;
  show) cat "$PLANS/$(cat "\${@: -1}").json" ;;
  apply) echo "applied $root" >> "$LOG"; echo "Apply complete! Resources: 1 added, 0 changed, 0 destroyed." ;;
esac
exit 0
`;

/** `files` are committed on main, the base the seal rule reads. */
export function setup(files: Record<string, string> = {}): { work: string; origin: string; bin: string; log: string } {
  const dir = tmp("tg-wave-");
  const origin = join(dir, "origin.git");
  git(dir, "init", "-q", "--bare", origin);
  const work = join(dir, "work");
  mkdirSync(join(work, "a"), { recursive: true });
  git(work, "init", "-q", "-b", "main");
  write(work, files);
  git(work, "add", "-A");
  git(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "one");
  git(work, "remote", "add", "origin", origin);
  git(work, "push", "-q", "origin", "main");
  const plans = join(dir, "plans");
  mkdirSync(plans);
  writeFileSync(join(plans, "a.json"), JSON.stringify({ resource_changes: [{ address: "terraform_data.x", mode: "managed", type: "terraform_data", name: "x", change: { actions: ["create"], before: null, after: { input: "1" }, after_unknown: {} } }] }));
  const bin = join(dir, "tofu");
  writeFileSync(bin, FAKE);
  chmodSync(bin, 0o755);
  vi.stubEnv("PLANS", plans);
  vi.stubEnv("LOG", join(dir, "apply.log"));
  return { work, origin, bin, log: join(dir, "apply.log") };
}

/** Append one resolution line to origin's ledger, as `chant approve` would from a person's machine. */
export function approve(origin: string, line: Record<string, unknown>): void {
  const clone = join(tmp("tg-approve-"), "l");
  execFileSync("git", ["clone", "-q", "-b", "chant/lifecycle", origin, clone]);
  const file = join(clone, "_gates/tf-apply.jsonl");
  writeFileSync(file, `${readFileSync(file, "utf-8").replace(/\n$/, "")}\n${JSON.stringify(line)}`);
  git(clone, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-am", "approve");
  git(clone, "push", "-q", "origin", "chant/lifecycle");
}
