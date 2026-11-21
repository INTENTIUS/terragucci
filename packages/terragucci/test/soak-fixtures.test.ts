import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { rolloutsSoak } from "../src/config";
import { OVERRIDE_LEDGER, OVERRIDE_OP, overrideDigest } from "../src/override";
import type { CommitCheck, RolloutForge } from "../src/rollout/forge";
import { memoryGateLedgerPort } from "@intentius/chant/op/gate";
import { ROLLOUT_SOAK_OP, rolloutSoakGate, soakOf, soakRuleFor } from "../src/rollout/wave-soak";
import { git, tmp, write } from "./helpers";

/**
 * Runs `rollouts.soak` on chant's soak over each case in fixtures/soak/ and
 * asserts the decision the case records. The cases record what the earlier
 * implementation (`rollout/soak.ts`, removed with this mapping) decided, so
 * each passing case is the old hold and the new hold agreeing. The fixtures are engine-neutral JSON
 * (see fixtures/soak/README.md); this file is the one place that maps them
 * onto terragucci's forge, checkout and gate ledger.
 */

interface Hold {
  reason: "time" | "condition" | "merge-time-unknown";
  condition?: string;
  project?: string;
  roots?: string[];
  projects?: string[];
}
interface Decision {
  outcome: "hold" | "release";
  via?: "no-soak" | "skip" | "soaked";
  rule: { after: string; afterMs: number; conditions: string[] } | null;
  clockStart: string | null;
  due: string | null;
  holds: Hold[];
  skippedBy?: { by: string; url?: string };
}
interface Case {
  name: string;
  why: string;
  soak: string | Record<string, unknown> | null;
  rollout: { kind: "module" | "provider"; name: string; aliases: string[] };
  wave: { number: number; merged: { project: string; roots: string[]; branch: string; at?: string }[] };
  now: string;
  world: {
    projects: Record<string, { driftIssue: { url: string; roots: string[]; text?: string } | null; applies: Record<string, CommitCheck["state"]>; skips: Record<string, { by: string; url?: string }[]> }>;
    denials: { root: string; at: string; rules: string[] }[];
  };
  decision: Decision;
}

const dir = join(__dirname, "fixtures", "soak");
const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();

/** A clone whose origin holds the policy-override ledger with these denials. */
function ledgerRepo(denials: Case["world"]["denials"]): string {
  const root = tmp("tg-soak-fixture-");
  const origin = join(root, "origin.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  const life = join(root, "life");
  git(root, "init", "-q", "-b", "chant/lifecycle", life);
  const plan = "jcs1-sha256:" + "1".repeat(64);
  const lines = denials.map((d) => {
    const expires = new Date(Date.parse(d.at) + 48 * 3_600_000).toISOString();
    return JSON.stringify({ version: 1, kind: "pending", op: OVERRIDE_OP, gate: d.root, timestamp: d.at, expiresAt: expires, planDigest: overrideDigest(d.root, plan, d.rules), members: [{ member: d.root, planDigest: plan }], rules: d.rules });
  });
  write(life, { [OVERRIDE_LEDGER]: lines.length ? `${lines.join("\n")}\n` : "" });
  git(life, "add", "-A");
  git(life, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "ledger");
  git(life, "push", "-q", origin, "chant/lifecycle");
  const work = join(root, "work");
  git(root, "init", "-q", "-b", "main", work);
  git(work, "remote", "add", "origin", origin);
  return work;
}

/** A checkout with one commit: the head the apply condition reads checks for. */
function checkout(): { dir: string; head: string } {
  const d = write(tmp("tg-soak-fixture-"), { "a.txt": "x" });
  git(d, "init", "-q", "-b", "main");
  git(d, "add", ".");
  git(d, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "c");
  return { dir: d, head: git(d, "rev-parse", "HEAD").trim() };
}

function forgeOf(p: Case["world"]["projects"][string], head: string): RolloutForge {
  return {
    openDriftIssue: async () => {
      if (!p.driftIssue) return undefined;
      const spans = p.driftIssue.roots.map((r) => `\`${r}\``).join(", ");
      return { url: p.driftIssue.url, body: [spans, p.driftIssue.text].filter(Boolean).join(" ") };
    },
    commitChecks: async (sha: string): Promise<CommitCheck[]> => (sha === head ? Object.entries(p.applies).map(([root, state]) => ({ name: `apply/${root}`, state })) : []),
    soakSkips: async (branch: string) => p.skips[branch] ?? [],
  } as unknown as RolloutForge;
}

async function decide(c: Case): Promise<Decision> {
  const settings = c.soak === null ? undefined : rolloutsSoak({ schedule: "0 * * * *", soak: c.soak as never });
  const rule = soakRuleFor(settings, c.rollout.kind, c.rollout.name, c.rollout.aliases);
  if (!rule) return { outcome: "release", via: "no-soak", rule: null, clockStart: null, due: null, holds: [] };
  const co = checkout();
  const projects = new Map(Object.entries(c.world.projects).map(([key, p]) => [key, { key, dir: co.dir, forge: forgeOf(p, co.head) }]));
  const gates = memoryGateLedgerPort();
  const status = await soakOf(rule, { wave: c.wave.number, merged: c.wave.merged }, { kind: c.rollout.kind, name: c.rollout.name, aliases: c.rollout.aliases, now: Date.parse(c.now), projects, repo: ledgerRepo(c.world.denials), gates }, settings!);
  const ruleOut = { after: rule.after, afterMs: rule.afterMs, conditions: [...rule.conditions] as string[] };
  const times = { clockStart: status.since ?? null, due: status.due ?? null };
  if (status.state === "skipped") {
    // The skip is the approval of the wave's soak gate on chant's ledger, and the ledger names who.
    expect(gates.resolved.map((r) => [r.op, r.gate, r.resolvedBy])).toEqual([[ROLLOUT_SOAK_OP, rolloutSoakGate(c.rollout.kind, c.rollout.name, c.wave.number), status.skippedBy!.by]]);
    expect(gates.applied.map((a) => a.approvedBy)).toEqual([status.skippedBy!.by]);
    return { outcome: "release", via: "skip", rule: ruleOut, ...times, holds: [], skippedBy: status.skippedBy! };
  }
  expect(gates.resolved).toEqual([]);
  if (status.state === "passed") return { outcome: "release", via: "soaked", rule: ruleOut, ...times, holds: [] };
  if (status.findings.length > 0) return { outcome: "hold", rule: ruleOut, ...times, holds: status.findings.map((f) => ({ reason: "condition" as const, condition: f.condition, project: f.project, roots: f.roots })) };
  const unknown = status.decision.holds.find((h) => h.reason === "clock-unknown");
  if (unknown && unknown.reason === "clock-unknown") return { outcome: "hold", rule: ruleOut, ...times, holds: [{ reason: "merge-time-unknown", projects: unknown.members }] };
  return { outcome: "hold", rule: ruleOut, ...times, holds: [{ reason: "time" }] };
}

describe("soak fixtures", () => {
  it("has the fixture files", () => {
    expect(files).toEqual(["clock.json", "conditions.json", "overrides.json", "skip.json"]);
  });

  for (const file of files) {
    const { cases } = JSON.parse(readFileSync(join(dir, file), "utf-8")) as { cases: Case[] };
    describe(file, () => {
      it("names each case once", () => {
        const names = cases.map((c) => c.name);
        expect(new Set(names).size).toBe(names.length);
      });
      for (const c of cases) {
        it(c.name, async () => {
          expect(await decide(c)).toEqual(c.decision);
        }, 30_000);
      }
    });
  }
});
