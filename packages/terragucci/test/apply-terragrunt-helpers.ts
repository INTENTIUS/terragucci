/** What the Terragrunt applyWave tests share: a fake terragrunt, a work tree with an origin, and an approval. */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { TerragruntExec } from "@intentius/chant-lexicon-terraform/terragrunt/run";
import { parseLedger } from "../src/apply";
import { git, tmp, write } from "./helpers";

// Hours from the start of the run: chant stamps the pending facts it records with the time it runs, so an approval at T(h) is newer than any of them.
export const T0 = Date.now();
export const T = (h: number): string => new Date(T0 + h * 3600_000).toISOString();

/**
 * A Terragrunt that knows two units: live/a, and live/b, which reads it, so
 * two dependency layers. A unit plans a create until it applied, and live/a's
 * create makes its output. `calls` keeps every `run --all` it was asked for.
 */
export function fakeTerragrunt(
  found: { path: string; dependencies: string[] }[] = [{ path: "live/a", dependencies: [] }, { path: "live/b", dependencies: ["live/a"] }],
  inputs: Record<string, string> = {},
  rendered: Record<string, unknown> = {},
): { exec: TerragruntExec; applied: Set<string>; calls: string[][]; inputs: Record<string, string> } {
  const applied = new Set<string>();
  const calls: string[][] = [];
  const flag = (args: readonly string[], name: string): string => args[args.indexOf(name) + 1];
  const exec: TerragruntExec = async (_file, args) => {
    if (args[0] === "--version") return { code: 0, stdout: "terragrunt version v1.1.6\n", stderr: "" };
    if (args[0] === "find") {
      return { code: 0, stdout: JSON.stringify(found.map((u) => ({ type: "unit", ...u }))), stderr: "" };
    }
    if (args[0] === "render") return { code: 0, stdout: JSON.stringify(rendered[args[args.indexOf("--working-dir") + 1]] ?? {}), stderr: "" };
    if (args[0] !== "run") return { code: 1, stdout: "", stderr: `unexpected ${args.join(" ")}` };
    calls.push([...args]);
    const units = args.flatMap((a, i) => (args[i - 1] === "--filter" ? [/^\{\.\/(.+)\}$/.exec(a)![1]] : []));
    const command = args[args.indexOf("--") + 1];
    const out = flag(args, "--out-dir");
    for (const u of units) {
      if (command === "plan") {
        const done = applied.has(u);
        const input = inputs[u] ?? u;
        const plan = {
          resource_changes: [{ address: "terraform_data.x", mode: "managed", type: "terraform_data", name: "x", change: done ? { actions: ["no-op"], before: { input }, after: { input }, after_unknown: {} } : { actions: ["create"], before: null, after: { input }, after_unknown: {} } }],
          ...(u === "live/a" ? { output_changes: { bucket: { actions: done ? ["no-op"] : ["create"], before: done ? "a" : null, after: "a" } } } : {}),
        };
        for (const [dir, name, text] of [[out, "tfplan.tfplan", "plan"], [flag(args, "--json-out-dir"), "tfplan.json", JSON.stringify(plan)]]) {
          mkdirSync(join(dir, u), { recursive: true });
          writeFileSync(join(dir, u, name), text);
        }
      } else {
        if (!existsSync(join(out, u, "tfplan.tfplan"))) return { code: 1, stdout: "", stderr: `no saved plan for ${u}` };
        applied.add(u);
      }
    }
    const report = flag(args, "--report-file");
    mkdirSync(dirname(report), { recursive: true });
    writeFileSync(report, JSON.stringify(units.map((u) => ({ Name: u, Result: "succeeded" }))));
    return { code: 0, stdout: "", stderr: units.map((u) => `[${u}] tofu: ${command} complete`).join("\n") };
  };
  return { exec, applied, calls, inputs };
}

export function setup(): { work: string; origin: string } {
  const dir = tmp("tg-tgwave-");
  const origin = join(dir, "origin.git");
  git(dir, "init", "-q", "--bare", origin);
  const work = join(dir, "work");
  mkdirSync(work, { recursive: true });
  git(work, "init", "-q", "-b", "main");
  write(work, { "root.hcl": "", "live/a/terragrunt.hcl": "", "live/b/terragrunt.hcl": "" });
  git(work, "add", "-A");
  git(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "one");
  git(work, "remote", "add", "origin", origin);
  git(work, "push", "-q", "origin", "main");
  return { work, origin };
}

export function approve(origin: string, gate: string, digest: string, at: string): void {
  const clone = join(tmp("tg-approve-"), "l");
  execFileSync("git", ["clone", "-q", "-b", "chant/lifecycle", origin, clone]);
  const file = join(clone, "_gates/tf-apply.jsonl");
  writeFileSync(file, `${readFileSync(file, "utf-8").replace(/\n$/, "")}\n${JSON.stringify({ version: 1, kind: "resolution", op: "tf-apply", gate, resolvedBy: "alice", timestamp: at, planDigest: digest })}\n`);
  git(clone, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-am", "approve");
  git(clone, "push", "-q", "origin", "chant/lifecycle");
}

export const ledger = (origin: string) => parseLedger(git(origin, "show", "chant/lifecycle:_gates/tf-apply.jsonl"));

export const opts = (tg: ReturnType<typeof fakeTerragrunt>, gate: "always" | "never" = "always") =>
  ({ layers: [["live/a"], ["live/b"]], binary: "tofu", gate, env: {}, terragrunt: true, terragruntExec: tg.exec });
/** The units each `run --all` was asked to plan or apply, in order. */
export const runs = (tg: ReturnType<typeof fakeTerragrunt>): string[] =>
  tg.calls.map((c) => `${c[c.indexOf("--") + 1]} ${c.flatMap((a, i) => (c[i - 1] === "--filter" ? [/^\{\.\/(.+)\}$/.exec(a)![1]] : [])).join(",")}`);

/** setup, with files at the base commit and the commit applied on top of it, so settings read at base are these. */
export function setupWith(files: Record<string, string>, units = ["live/a", "live/b"]): { work: string; origin: string } {
  const dir = tmp("tg-tgwave-");
  const origin = join(dir, "origin.git");
  git(dir, "init", "-q", "--bare", origin);
  const work = join(dir, "work");
  mkdirSync(work, { recursive: true });
  git(work, "init", "-q", "-b", "main");
  write(work, { "root.hcl": "", ...Object.fromEntries(units.map((u) => [`${u}/terragrunt.hcl`, ""])), ...files });
  git(work, "add", "-A");
  git(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "base");
  write(work, { "live/README": "the change\n" });
  git(work, "add", "-A");
  git(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "the change");
  git(work, "remote", "add", "origin", origin);
  git(work, "push", "-q", "origin", "main");
  return { work, origin };
}
