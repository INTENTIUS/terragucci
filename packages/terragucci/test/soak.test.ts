import { describe, expect, it } from "vitest";
import { describeRollout, rollout, rolloutExit, waveBranch, type RolloutOptions } from "../src/rollout";
import { fetchForge, type CommitCheck, type RolloutForge, type SoakSkip, type WavePullRequest } from "../src/rollout/forge";
import { memoryGateLedgerPort } from "@intentius/chant/op/gate";
import type { SoakCheckReader } from "@intentius/chant/pipeline/soak";
import { driftNamedTargets, soakCheckReader } from "@intentius/chant/pipeline/soak-checks";
import { forgeSources, rolloutSoakGate, soakRuleFor, ROLLOUT_SOAK_OP } from "../src/rollout/wave-soak";
import { rolloutsProblems, rolloutsSoak } from "../src/config";
import { targetAt, type Fetch } from "../src/forge";
import { backend, bareFrom, git, remoteState, tmp, write } from "./helpers";

const GIT_MODULE = "git::https://example.com/acme/infra.git//modules/network";
const call = (ref: string) => `module "network" {\n  source = "${GIT_MODULE}?ref=${ref}"\n  name   = "x"\n}\n`;
const HOUR = 3_600_000;
const T0 = Date.parse("2026-03-01T10:00:00Z");

const SOAK = (soak: string) => `waves:\n  canary: ["envs/dev/*"]\nrollouts:\n  schedule: "0 * * * *"\n  soak:\n${soak}\n`;

/** Three roots in three waves: a canary, a network root, and an app reading the network's state. */
function pinnedRepo(config: string): { repo: string; bare: string } {
  const dir = write(tmp(), {
    "terragucci.yml": config,
    "envs/dev/app/main.tf": backend("dev/app.tfstate") + call("modules/network/v1.3.0"),
    "envs/prod/net/main.tf": backend("prod/net.tfstate") + call("modules/network/v1.3.0"),
    "envs/prod/app/main.tf": backend("prod/app.tfstate") + remoteState("prod/net.tfstate") + call("modules/network/v1.3.0"),
    "modules/network/main.tf": 'variable "name" {}\n',
  });
  const bare = bareFrom(dir);
  const repo = tmp();
  git(repo, "clone", "-q", bare, ".");
  return { repo, bare };
}

/** A forge in memory with merge times, a drift issue and skip comments. */
class MemoryForge implements RolloutForge {
  prs = new Map<string, WavePullRequest & { title: string }>();
  checks = new Map<string, CommitCheck[]>();
  drift: { url: string; body: string } | undefined;
  skips = new Map<string, SoakSkip[]>();
  constructor(readonly bare: string) {}
  async defaultBranch() {
    return "main";
  }
  async findPullRequest(branch: string) {
    return this.prs.get(branch) ?? null;
  }
  async createPullRequest(pr: { base: string; head: string; title: string; body: string }) {
    const url = `https://forge/p/pull/${this.prs.size + 1}`;
    this.prs.set(pr.head, { url, state: "open", body: pr.body, title: pr.title });
    return url;
  }
  async commitChecks(sha: string) {
    return this.checks.get(sha) ?? [];
  }
  async listPullRequests() {
    return [];
  }
  async openDriftIssue() {
    return this.drift;
  }
  async soakSkips(branch: string) {
    return this.skips.get(branch) ?? [];
  }
  /** Merge a wave's branch and report its apply as done, at `at`. */
  mergeAndApply(branch: string, at: number): string {
    const work = tmp();
    git(work, "clone", "-q", this.bare, ".");
    git(work, "-c", "user.name=t", "-c", "user.email=t@t", "merge", "-q", "--no-ff", "-m", "merge", `origin/${branch}`);
    git(work, "push", "-q", "origin", "main");
    const sha = git(work, "rev-parse", "HEAD").trim();
    this.prs.set(branch, { ...this.prs.get(branch)!, state: "merged", mergeCommit: sha, mergedAt: new Date(at).toISOString() });
    this.checks.set(sha, [{ name: "terragucci / apply (push)", state: "success" }]);
    return sha;
  }
}

const b = (n: number) => waveBranch("modules/network", "1.4.0", n);
const opts = (forge: MemoryForge, now: number, extra: Partial<RolloutOptions> = {}): RolloutOptions => ({ kind: "module", name: "modules/network", to: "1.4.0", mode: "apply", forge: () => forge, clock: () => now, ...extra });

describe("rollouts.soak in the config", () => {
  it("takes a duration or a map, and refuses what it cannot read", () => {
    const ok = (soak: unknown) => rolloutsProblems({ schedule: "0 * * * *", soak }, "rollouts");
    expect(ok("24h")).toEqual([]);
    expect(ok({ after: "6h", conditions: ["drift", "apply", "policy"], overrides: [{ module: "acme/*", after: "0" }, { provider: "hashicorp/*", conditions: ["apply"] }] })).toEqual([]);
    expect(ok("a day")).toEqual([expect.stringContaining("rollouts.soak must be a duration")]);
    expect(ok({ conditions: ["drift"] })).toEqual([expect.stringContaining("rollouts.soak.duration must be a duration")]);
    expect(ok({ after: "1h", conditions: ["health"] })).toEqual([expect.stringContaining("rollouts.soak.conditions must be a list of drift, apply, policy")]);
    expect(ok({ after: "1h", wait: 1 })).toEqual([expect.stringContaining("rollouts.soak.wait is not a setting")]);
    expect(ok({ after: "1h", overrides: [{ after: "1h" }] })).toEqual([expect.stringContaining("names a module or a provider glob")]);
    expect(ok({ after: "1h", overrides: [{ module: "acme/*" }] })).toEqual([expect.stringContaining("sets after, conditions, or both")]);
    expect(rolloutsProblems("0 * * * *", "rollouts")).toEqual([]);
  });

  it("reads a duration as a soak with no conditions, and lets the first override that names the rollout decide", () => {
    expect(rolloutsSoak({ schedule: "x", soak: "24h" })).toEqual({ after: "24h" });
    expect(rolloutsSoak("0 * * * *")).toBeUndefined();
    const soak = { after: "24h", conditions: ["drift" as const], overrides: [{ module: "acme/vpc/*", after: "0" }, { module: "acme/*/*", conditions: ["apply" as const] }, { provider: "hashicorp/*", after: "2h" }] };
    expect(soakRuleFor(soak, "module", "acme/vpc/aws")).toMatchObject({ after: "0", afterMs: 0, conditions: ["drift"] });
    expect(soakRuleFor(soak, "module", "acme/eks/aws")).toMatchObject({ after: "24h", afterMs: 24 * HOUR, conditions: ["apply"] });
    expect(soakRuleFor(soak, "module", "other/net/aws")).toMatchObject({ after: "24h" });
    expect(soakRuleFor(soak, "provider", "hashicorp/aws")).toMatchObject({ after: "2h", afterMs: 2 * HOUR });
    expect(soakRuleFor(undefined, "module", "x")).toBeUndefined();
  });
});

describe("a rollout under rollouts.soak", () => {
  it("holds the next wave until the soak is up, and says when it is due", async () => {
    const { repo, bare } = pinnedRepo(SOAK("    after: 24h"));
    const forge = new MemoryForge(bare);
    await rollout(repo, opts(forge, T0));
    expect(forge.prs.get(b(1))!.body).toContain("Wave 2 opens once this wave has soaked for 24h after it merges.");
    expect(forge.prs.get(b(1))!.body).toContain("/terragucci skip-soak");
    forge.mergeAndApply(b(1), T0);

    let r = await rollout(repo, opts(forge, T0 + HOUR));
    expect([r.status, rolloutExit(r), r.waves[1]!.parts[0]!.state]).toEqual(["soaking", 3, "soaking"]);
    expect(forge.prs.has(b(2))).toBe(false);
    expect(r.waves[0]!.soak).toMatchObject({ state: "soaking", since: "2026-03-01T10:00:00.000Z", due: "2026-03-02T10:00:00.000Z" });
    const text = describeRollout(r);
    expect(text).toContain("the next wave is due 2026-03-02T10:00:00.000Z");
    expect(text).toContain("waiting for: 24h to pass since wave 1 merged");

    // A dry run says the same and opens nothing.
    r = await rollout(repo, opts(forge, T0 + 23 * HOUR, { mode: "dry-run" }));
    expect(r.status).toBe("soaking");

    r = await rollout(repo, opts(forge, T0 + 24 * HOUR));
    expect([r.status, r.waves[0]!.soak?.state]).toEqual(["opened", "passed"]);
    expect(forge.prs.has(b(2))).toBe(true);
    expect(describeRollout(r)).toContain("soaked 24h since 2026-03-01T10:00:00.000Z");
  }, 30_000);

  it("holds past the time while a condition finds something, and opens once it clears", async () => {
    const { repo, bare } = pinnedRepo(SOAK("    after: 1h\n    conditions: [drift, apply, policy]"));
    const forge = new MemoryForge(bare);
    await rollout(repo, opts(forge, T0));
    forge.mergeAndApply(b(1), T0);
    let found = true;
    const asked: unknown[] = [];
    const soakRead: SoakCheckReader = async (check, ctx) => {
      asked.push([ctx.targets, check.kind, check.onFail, ctx.since]);
      return found && check.kind === "drift" ? { status: "failed", targets: ctx.targets, detail: "the drift issue https://forge/p/issues/9 is open and names envs/dev/app" } : { status: "passed", detail: "ok" };
    };
    const health = soakRead;

    // Inside the hour the conditions are not read.
    await rollout(repo, opts(forge, T0 + HOUR / 2, { soakRead: health }));
    expect(asked).toEqual([]);

    let r = await rollout(repo, opts(forge, T0 + 2 * HOUR, { soakRead: health }));
    expect([r.status, forge.prs.has(b(2))]).toEqual(["soaking", false]);
    expect(asked.map((a) => (a as unknown[]).slice(1))).toEqual([["drift", "hold", "2026-03-01T10:00:00.000Z"], ["apply", "hold", "2026-03-01T10:00:00.000Z"], ["policy", "hold", "2026-03-01T10:00:00.000Z"]]);
    expect(r.waves[0]!.soak!.findings).toMatchObject([{ condition: "drift", roots: ["envs/dev/app"], detail: "the drift issue https://forge/p/issues/9 is open and names envs/dev/app" }]);
    expect(describeRollout(r)).toContain("waiting for:");
    expect(describeRollout(r)).toContain("names envs/dev/app");

    found = false;
    r = await rollout(repo, opts(forge, T0 + 3 * HOUR, { soakRead: health }));
    expect([r.status, forge.prs.has(b(2))]).toEqual(["opened", true]);
  }, 30_000);

  it("is skipped by a person's comment, and the report names them", async () => {
    const { repo, bare } = pinnedRepo(SOAK("    after: 24h"));
    const forge = new MemoryForge(bare);
    await rollout(repo, opts(forge, T0));
    forge.mergeAndApply(b(1), T0);
    expect((await rollout(repo, opts(forge, T0 + HOUR))).status).toBe("soaking");

    forge.skips.set(b(1), [{ by: "dana", url: "https://forge/p/pull/1" }]);
    const gates = memoryGateLedgerPort();
    const r = await rollout(repo, opts(forge, T0 + 2 * HOUR, { gates }));
    // chant's early end: the comment is the approval of the wave's soak gate, and the ledger names who.
    expect(gates.resolved.map((x) => [x.op, x.gate, x.resolvedBy, x.url])).toEqual([[ROLLOUT_SOAK_OP, rolloutSoakGate("module", "modules/network", 1), "dana", "https://forge/p/pull/1"]]);
    expect(gates.applied.map((x) => [x.gate, x.approvedBy])).toEqual([[rolloutSoakGate("module", "modules/network", 1), "dana"]]);
    expect([r.status, r.waves[0]!.soak?.state, r.waves[0]!.soak?.skippedBy?.by]).toEqual(["opened", "skipped", "dana"]);
    expect(describeRollout(r)).toContain("soak skipped by dana (https://forge/p/pull/1)");
  }, 30_000);

  it("uses the override for a module, and no soak at all with none configured", async () => {
    const overridden = pinnedRepo(SOAK("    after: 24h\n    overrides:\n      - module: modules/*\n        after: \"0\""));
    const f1 = new MemoryForge(overridden.bare);
    await rollout(overridden.repo, opts(f1, T0));
    f1.mergeAndApply(b(1), T0);
    expect((await rollout(overridden.repo, opts(f1, T0))).status).toBe("opened");

    const plain = pinnedRepo('waves:\n  canary: ["envs/dev/*"]\nrollouts: "0 * * * *"\n');
    const f2 = new MemoryForge(plain.bare);
    await rollout(plain.repo, opts(f2, T0));
    f2.mergeAndApply(b(1), T0);
    const r = await rollout(plain.repo, opts(f2, T0));
    expect([r.status, r.waves[0]!.soak]).toEqual(["opened", undefined]);
  }, 30_000);

  it("holds when the forge gave no merge time, so the soak cannot be counted", async () => {
    const { repo, bare } = pinnedRepo(SOAK("    after: 1h"));
    const forge = new MemoryForge(bare);
    await rollout(repo, opts(forge, T0));
    forge.mergeAndApply(b(1), T0);
    forge.prs.set(b(1), { ...forge.prs.get(b(1))!, mergedAt: undefined });
    const r = await rollout(repo, opts(forge, T0 + 99 * HOUR));
    expect(r.status).toBe("soaking");
    expect(r.waves[0]!.soak!.waitingFor[0]).toContain("no merge time");
  }, 30_000);
});

describe("what the soak's conditions read", () => {
  const project = (forge: RolloutForge, dir = tmp()) => ({ key: "p", dir, forge });
  const targets = ["envs/dev/app", "envs/prod/net"];
  const ctx = (check: "drift" | "apply" | "policy") => ({ environment: "rollout", member: "p", targets, since: new Date(T0).toISOString(), now: new Date(T0 + HOUR) });
  const read = (projects: ReturnType<typeof project>[], repo = tmp()) => soakCheckReader(forgeSources(new Map(projects.map((p) => [p.key, p])), repo));

  it("finds the wave's roots in the drift issue's code spans", async () => {
    expect(driftNamedTargets("2 of 9 roots drifted: `envs/dev/app`, `envs/dev/other`.", targets)).toEqual(["envs/dev/app"]);
    const forge = { openDriftIssue: async () => ({ url: "u/9", body: "`envs/prod/net` drifted" }) } as unknown as RolloutForge;
    expect(await read([project(forge)])({ kind: "drift" }, ctx("drift"))).toEqual({ status: "failed", targets: ["envs/prod/net"], detail: "the drift issue u/9 is open and names envs/prod/net" });
    const none = { openDriftIssue: async () => undefined } as unknown as RolloutForge;
    expect((await read([project(none)])({ kind: "drift" }, ctx("drift"))).status).toBe("passed");
  });

  it("finds a failed apply on the default branch's newest commit, in the project's checkout", async () => {
    const dir = write(tmp(), { "a.txt": "x" });
    git(dir, "init", "-q", "-b", "main");
    git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "add", ".");
    git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "c");
    const head = git(dir, "rev-parse", "HEAD").trim();
    const forge = { commitChecks: async (sha: string) => (sha === head ? [{ name: "apply/envs/prod/net", state: "failure" }, { name: "apply/envs/dev/app", state: "success" }] : []) } as unknown as RolloutForge;
    expect(await read([project(forge, dir)])({ kind: "apply" }, ctx("apply"))).toEqual({ status: "failed", targets: ["envs/prod/net"], detail: "the newest apply failed for envs/prod/net" });
  });

  it("finds no policy denial on a repository whose gate ledger holds none", async () => {
    const dir = tmp();
    git(dir, "clone", "-q", bareFrom(write(tmp(), { "a.txt": "x" })), ".");
    expect((await read([project({} as RolloutForge)], dir)({ kind: "policy" }, ctx("policy"))).status).toBe("passed");
  });
});

describe("the forge's reads for the soak", () => {
  const answers: Record<string, unknown> = {
    "https://api.github.com/repos/acme/infra/pulls?state=all&sort=updated&direction=desc&per_page=100&page=1": [
      { html_url: "g/7", number: 7, title: "t", state: "closed", merged_at: "2026-03-01T10:00:00Z", updated_at: "2026-03-01T10:05:00Z", merge_commit_sha: "abc", body: "b", head: { ref: "terragucci/rollout/x-1.4.0/wave-1" } },
    ],
    "https://api.github.com/repos/acme/infra/issues/7/comments?per_page=100&page=1": [
      { id: 1, body: "/terragucci skip-soak", user: { login: "dana" }, created_at: "2026-03-01T11:00:00Z" },
      { id: 2, body: "/terragucci skip-soak", user: { login: "visitor" }, created_at: "2026-03-01T12:00:00Z" },
      { id: 3, body: "please skip the soak", user: { login: "dana" }, created_at: "2026-03-01T13:00:00Z" },
    ],
    "https://api.github.com/repos/acme/infra/collaborators/dana/permission": { permission: "write" },
    "https://api.github.com/repos/acme/infra/collaborators/visitor/permission": { permission: "read" },
  };
  // The pull request list is asked once by its head branch; every answer here is for the same one.
  const fetch: Fetch = async (url) => {
    const key = url.includes("/pulls?state=all&head=") ? Object.keys(answers)[0]! : url;
    return { ok: key in answers, status: key in answers ? 200 : 404, json: async () => answers[key], text: async () => JSON.stringify(answers[key] ?? []) };
  };

  it("counts the soak from the merged pull request's last change, and takes a skip only from someone who may push", async () => {
    const forge = fetchForge(fetch, targetAt("github", "https://github.com", "acme/infra", ""));
    expect((await forge.findPullRequest("terragucci/rollout/x-1.4.0/wave-1"))?.mergedAt).toBe("2026-03-01T10:05:00Z");
    expect(await forge.soakSkips!("terragucci/rollout/x-1.4.0/wave-1")).toEqual([{ by: "dana", url: "g/7" }]);
  });
});
