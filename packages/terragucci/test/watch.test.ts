import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { validateConfig, rolloutsSchedule, rolloutsWatch } from "../src/config";
import { globMatch } from "../src/detect";
import type { Fetch } from "../src/publish/oci";
import type { Fetch as ForgeFetch } from "../src/forge";
import { addBehind } from "../src/report/behind";
import { buildEstate, renderEstateHtml, type ProjectIndex } from "../src/report/estate";
import { respond } from "../src/respond";
import { waveBranch } from "../src/rollout";
import type { CommitCheck, RolloutForge, WavePullRequest } from "../src/rollout/forge";
import { behindOf, namesOf, pickRelease, plainReleases, registrySources, type ReleaseSources, type Subject } from "../src/rollout/releases";
import { botApply, describeWatch, watchExit, watchRollouts } from "../src/rollout/watch";
import { backend, bareFrom, git, tmp, write } from "./helpers";

const VPC = "registry.terraform.io/acme/vpc/aws";
const mod = (version: string, source = VPC) => `module "vpc" {\n  source  = "${source}"\n  version = "${version}"\n}\n`;
const NOW = new Date("2026-11-15T12:00:00Z");
const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();

/** A forge in memory: pull requests by branch and checks by commit. */
class MemoryForge implements RolloutForge {
  prs = new Map<string, WavePullRequest & { title: string }>();
  checks = new Map<string, CommitCheck[]>();
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
  async listPullRequests(prefix: string) {
    return [...this.prs].filter(([branch]) => branch.startsWith(prefix)).reverse().map(([branch, pr]) => ({ branch, url: pr.url, title: pr.title, state: pr.state, body: pr.body }));
  }
  /** A bot's pull request, as Renovate or Dependabot names it. */
  bot(branch: string, title: string, state: WavePullRequest["state"], mergeCommit?: string): void {
    this.prs.set(branch, { url: `https://forge/p/pull/bot-${this.prs.size + 1}`, state, body: "", title, ...(mergeCommit ? { mergeCommit } : {}) });
  }
}

/** Releases and dates from a table, recording what was asked. */
function table(releases: Record<string, string[]>, dates: Record<string, string> = {}): ReleaseSources & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    async versions(s: Subject) {
      asked.push(`${s.kind} ${s.name}`);
      return releases[s.name];
    },
    async published(s: Subject, version: string) {
      return dates[`${s.name}@${version}`];
    },
  };
}

function checkout(files: Record<string, string>): string {
  const bare = bareFrom(write(tmp(), files));
  const repo = tmp();
  git(repo, "clone", "-q", bare, ".");
  return repo;
}

const bareOf = (repo: string): string => git(repo, "remote", "get-url", "origin").trim();
const changedFiles = (bare: string, branch: string) => git(bare, "diff", "--name-only", `main...${branch}`).trim().split("\n").filter(Boolean);

const WATCH = { module: "acme/*/aws" };
const config = (watch: object[] = [WATCH]) => `waves:\n  canary: ["dev/*"]\nrollouts:\n  schedule: "0 6 * * *"\n  watch: ${JSON.stringify(watch)}\n`;
const fleet = (version = "5.0.0", extra: Record<string, string> = {}, rules?: object[]) => ({
  "terragucci.yml": config(rules),
  "dev/app/main.tf": backend("dev/app.tfstate") + mod(version),
  "prod/app/main.tf": backend("prod/app.tfstate") + mod(version),
  ...extra,
});
const RELEASES = { [VPC]: ["5.0.0", "5.1.0", "5.1.1", "6.0.0", "6.1.0-rc.1"] };

describe("rollouts settings", () => {
  const problems = (rollouts: unknown): string[] => {
    try {
      validateConfig({ rollouts }, "terragucci.yml");
      return [];
    } catch (e) {
      return (e as Error).message.split("\n");
    }
  };

  it("takes a cron alone, as before, or a schedule with watch rules", () => {
    expect(problems("0 6 * * *")).toEqual([]);
    expect(problems({ schedule: "0 6 * * *", watch: [{ module: "acme/*/aws", follow: ["patch"], min_age: "3d" }, { provider: "hashicorp/*" }] })).toEqual([]);
    expect(rolloutsSchedule({ schedule: "0 6 * * *" })).toBe("0 6 * * *");
    expect(rolloutsSchedule("0 7 * * *")).toBe("0 7 * * *");
    expect(rolloutsWatch("0 7 * * *")).toEqual([]);
  });

  it("names what is wrong with a rule", () => {
    const text = (r: unknown) => problems(r).join("\n");
    expect(text({ watch: [{ module: "a/b/c" }] })).toContain("rollouts.schedule must be a cron schedule");
    expect(text({ schedule: "x", watch: [{}] })).toContain("names a module or a provider glob, and one of them");
    expect(text({ schedule: "x", watch: [{ module: "a", provider: "b" }] })).toContain("names a module or a provider glob, and one of them");
    expect(text({ schedule: "x", watch: [{ module: "a", follow: ["huge"] }] })).toContain("follow must be a list of patch, minor, major");
    expect(text({ schedule: "x", watch: [{ module: "a", min_age: "a week" }] })).toContain("min_age must be a duration");
    expect(text({ schedule: "x", watch: [{ module: "a", then: 1 }] })).toContain("watch[0].then is not a setting");
  });
});

describe("choosing a release", () => {
  const rule = { follow: ["patch", "minor"] as const };
  const releases = plainReleases(["5.0.0", "5.1.0", "5.1.1", "6.0.0", "6.1.0-rc.1", "5.1.1"]);
  const none = async () => undefined;

  it("lists plain releases newest first, without a pre-release", () => {
    expect(releases.map((r) => `${r.major}.${r.minor}.${r.patch}`)).toEqual(["6.0.0", "5.1.1", "5.1.0", "5.0.0"]);
  });

  it("takes the newest release of a bump the rule follows, and says what it passed over", async () => {
    expect(await pickRelease("5.0.0", releases, rule, none, NOW)).toEqual({ to: "5.1.1", held: "6.0.0 is a major release and the rule follows patch, minor" });
    expect(await pickRelease("5.0.0", releases, { follow: ["patch"] }, none, NOW)).toEqual({ held: "6.0.0 is a major release and the rule follows patch" });
    expect(await pickRelease("5.0.0", releases, { follow: ["major"] }, none, NOW)).toEqual({ to: "6.0.0" });
    expect(await pickRelease("5.1.1", plainReleases(["5.1.1", "5.1.0"]), rule, none, NOW)).toEqual({});
  });

  it("holds a release younger than min_age and takes an older one that qualifies, and one with no date waits", async () => {
    const dates: Record<string, string> = { "5.1.1": ago(1), "5.1.0": ago(10) };
    const age = { ...rule, minAgeMs: 3 * DAY };
    const published = async (v: string) => dates[v];
    expect(await pickRelease("5.0.0", releases, age, published, NOW)).toEqual({ to: "5.1.0", held: "5.1.1 was published 24h ago, under min_age" });
    expect(await pickRelease("5.0.0", plainReleases(["5.0.0", "5.1.1"]), age, published, NOW)).toEqual({ held: "5.1.1 was published 24h ago, under min_age" });
    expect(await pickRelease("5.0.0", plainReleases(["5.0.0", "5.1.1"]), age, none, NOW)).toEqual({ held: "5.1.1 has no release date, so it cannot meet min_age" });
  });

  it("measures how far a version is behind", () => {
    expect(behindOf("5.0.0", releases)).toEqual({ latest: "6.0.0", releases: 3, bump: "major" });
    expect(behindOf("6.0.0", releases)).toBeUndefined();
    expect(behindOf("main", releases)).toBeUndefined();
  });

  it("matches a glob against an address with or without its host", () => {
    expect(namesOf({ kind: "module", name: VPC })).toContain("acme/vpc/aws");
    expect(namesOf({ kind: "module", name: "acme/vpc/aws" })).toContain("registry.terraform.io/acme/vpc/aws");
    expect(namesOf({ kind: "provider", name: "registry.opentofu.org/hashicorp/aws" })).toContain("hashicorp/aws");
    const match = (glob: string, subject: Subject) => namesOf(subject).some((n) => globMatch(glob, n));
    expect(["acme/**", "acme/*/aws", "registry.terraform.io/acme/vpc/aws"].map((g) => match(g, { kind: "module", name: VPC }))).toEqual([true, true, true]);
    expect(match("acme/*", { kind: "module", name: VPC })).toBe(false);
  });
});

describe("the default release sources", () => {
  it("reads a module's versions and a release's date from a registry, and a provider's versions", async () => {
    const urls: string[] = [];
    const fetch: Fetch = async (url) => {
      urls.push(url);
      const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response;
      if (url.endsWith("/.well-known/terraform.json")) return json({ "modules.v1": "/v1/modules/", "providers.v1": "/v1/providers/" });
      if (url.endsWith("/acme/vpc/aws/versions")) return json({ modules: [{ versions: [{ version: "5.0.0" }, { version: "5.1.0" }] }] });
      if (url.endsWith("/acme/vpc/aws/5.1.0")) return json({ published_at: "2026-11-01T00:00:00Z" });
      if (url.endsWith("/v1/providers/hashicorp/aws/versions")) return json({ versions: [{ version: "6.1.0" }, { version: "6.2.0" }] });
      return { ok: false, status: 404, json: async () => ({}), text: async () => "" } as unknown as Response;
    };
    const s = registrySources({ fetch });
    expect(await s.versions({ kind: "module", name: "acme/vpc/aws" })).toEqual(["5.0.0", "5.1.0"]);
    expect(await s.published({ kind: "module", name: VPC }, "5.1.0")).toBe("2026-11-01T00:00:00Z");
    expect(await s.published({ kind: "module", name: VPC }, "5.0.0")).toBeUndefined();
    expect(await s.versions({ kind: "provider", name: "registry.terraform.io/hashicorp/aws" })).toEqual(["6.1.0", "6.2.0"]);
    expect(await s.versions({ kind: "module", name: "git::https://example.com/acme/infra.git//modules/network" })).toBeUndefined();
    expect(urls.every((u) => u.startsWith("https://registry.terraform.io/"))).toBe(true);
  });
});

describe("rollouts.watch", () => {
  it("starts a rollout from the pinned version to the newest release the rule follows, and in a dry run only says so", async () => {
    const repo = checkout(fleet());
    const forge = new MemoryForge();
    const sources = table(RELEASES);
    const dry = await watchRollouts(repo, { mode: "dry-run", forge: () => forge, sources, now: NOW });
    expect(dry.watched).toMatchObject([{ kind: "module", name: VPC, at: ["5.0.0"], latest: "6.0.0", from: "5.0.0", to: "5.1.1", action: "would-start" }]);
    expect(dry.watched[0]!.reason).toBe("2 waves");
    expect(forge.prs.size).toBe(0);
    expect(describeWatch(dry)).toBe(`${VPC} 5.0.0 -> 5.1.1: would-start (2 waves)`);
    expect(watchExit(dry)).toBe(0);

    const run = await watchRollouts(repo, { mode: "apply", forge: () => forge, sources, now: NOW });
    expect(run.watched[0]).toMatchObject({ action: "started", from: "5.0.0", to: "5.1.1" });
    const branch = waveBranch(VPC, "5.1.1", 1);
    expect([...forge.prs.keys()]).toEqual([branch]);
    expect(changedFiles(bareOf(repo), branch)).toEqual(["dev/app/main.tf"]);
    expect(git(bareOf(repo), "show", `${branch}:dev/app/main.tf`)).toContain('version = "5.1.1"');
    expect(forge.prs.get(branch)!.body).toContain('"from":"5.0.0","to":"5.1.1"');
  }, 30_000);

  it("leaves a module alone while its rollout is in flight, and once the rollout ran", async () => {
    const repo = checkout(fleet());
    const forge = new MemoryForge();
    const sources = table(RELEASES);
    await watchRollouts(repo, { mode: "apply", forge: () => forge, sources, now: NOW });
    const again = await watchRollouts(repo, { mode: "apply", forge: () => forge, sources, now: NOW });
    expect(again.watched[0]).toMatchObject({ action: "in-flight" });
    expect(again.watched[0]!.reason).toMatch(/^a rollout to 5\.1\.1 is waiting: wave 1 is open: https:\/\/forge\/p\/pull\/1$/);
    expect(forge.prs.size).toBe(1);
  }, 30_000);

  it("skips a release whose rollout already finished and names the roots it left behind", async () => {
    const repo = checkout(fleet("5.0.0", { "legacy/app/main.tf": backend("legacy/app.tfstate") + mod("4.9.0") }));
    const forge = new MemoryForge();
    // The rollout to 5.1.1 ran from 5.0.0 and its last wave merged; legacy never joined it.
    forge.prs.set(waveBranch(VPC, "5.1.1", 2), {
      url: "https://forge/p/pull/9",
      state: "merged",
      title: "terragucci rollout: x, wave 2 of 2",
      body: `<!-- terragucci-rollout ${JSON.stringify({ kind: "module", name: VPC, from: "5.0.0", to: "5.1.1", wave: 2, waves: 2, roots: ["prod/app"] })} -->`,
    });
    const r = await watchRollouts(repo, { mode: "apply", forge: () => forge, sources: table({ [VPC]: ["4.9.0", "5.0.0", "5.1.1"] }), now: NOW });
    expect(r.watched[0]!.at).toEqual(["5.0.0", "4.9.0"]);
    expect(r.watched[0]).toMatchObject({ action: "skipped", from: "5.0.0", to: "5.1.1" });
    expect(r.watched[0]!.reason).toContain("a rollout to 5.1.1 already ran");
    expect(forge.prs.size).toBe(1);
  }, 30_000);

  it("holds a release the rule does not follow, or that is too young, and reports a constraint it does not follow", async () => {
    const repo = checkout(fleet("5.0.0", { "stage/app/main.tf": backend("stage/app.tfstate") + mod("~> 5.0") }, [{ module: "acme/*/aws", follow: ["patch"] }]));
    const forge = new MemoryForge();
    const r = await watchRollouts(repo, { mode: "apply", forge: () => forge, sources: table(RELEASES), now: NOW });
    expect(r.watched[0]).toMatchObject({ action: "held", constraints: ["stage/app"] });
    expect(r.watched[0]!.reason).toBe("6.0.0 is a major release and the rule follows patch. One root names a version constraint, which the watch does not follow; terragucci pin modules makes it an exact pin.");

    const aged = checkout(fleet("5.0.0", {}, [{ module: "acme/*/aws", min_age: "3d" }]));
    const young = await watchRollouts(aged, { mode: "apply", forge: () => forge, sources: table(RELEASES, { [`${VPC}@5.1.1`]: ago(1), [`${VPC}@5.1.0`]: ago(2) }), now: NOW });
    expect(young.watched[0]).toMatchObject({ action: "held", reason: "5.1.1 was published 24h ago, under min_age" });
    const old = await watchRollouts(aged, { mode: "dry-run", forge: () => forge, sources: table(RELEASES, { [`${VPC}@5.1.1`]: ago(1), [`${VPC}@5.1.0`]: ago(9) }), now: NOW });
    expect(old.watched[0]).toMatchObject({ action: "would-start", to: "5.1.0" });
    expect(forge.prs.size).toBe(0);
  }, 30_000);

  it("reads only what a rule names, and says up to date when nothing is newer", async () => {
    const repo = checkout(fleet("5.1.1", { "other/main.tf": backend("other.tfstate") + mod("1.0.0", "registry.terraform.io/other/thing/aws") }));
    const sources = table({ ...RELEASES, "registry.terraform.io/other/thing/aws": ["1.1.0"] });
    const r = await watchRollouts(repo, { mode: "apply", forge: () => new MemoryForge(), sources, now: NOW });
    expect(r.watched.map((w) => [w.name, w.action])).toEqual([[VPC, "held"]]);
    expect(sources.asked).toEqual([`module ${VPC}`]);
    const latest = await watchRollouts(repo, { mode: "apply", forge: () => new MemoryForge(), sources: table({ [VPC]: ["5.1.1"] }), now: NOW });
    expect(latest.watched[0]).toMatchObject({ action: "up-to-date", reason: "no newer release" });
  }, 30_000);

  it("skips a module whose releases cannot be listed, and reports a registry that threw", async () => {
    const gitSource = "git::https://example.com/acme/infra.git//modules/network?ref=modules/network/v1.3.0";
    const repo = checkout({ "terragucci.yml": config([{ module: "git::*/**" }, { module: "acme/*/aws" }]), "a/main.tf": backend("a.tfstate") + `module "net" {\n  source = "${gitSource}"\n}\n`, "b/main.tf": backend("b.tfstate") + mod("5.0.0") });
    const sources: ReleaseSources = {
      async versions(s) {
        if (s.name === VPC) throw new Error("registry.terraform.io answered 503");
        return undefined;
      },
      async published() {
        return undefined;
      },
    };
    const r = await watchRollouts(repo, { mode: "apply", forge: () => new MemoryForge(), sources, now: NOW });
    expect(r.watched.map((w) => [w.name, w.action])).toEqual([["git::https://example.com/acme/infra.git//modules/network", "skipped"], [VPC, "failed"]]);
    expect(r.watched[1]!.reason).toBe("registry.terraform.io answered 503");
    expect(watchExit(r)).toBe(1);
  }, 30_000);

  describe("with Renovate or Dependabot", () => {
    const start = async (forge: MemoryForge, repo = checkout(fleet())) => ({ repo, r: await watchRollouts(repo, { mode: "apply", forge: () => forge, sources: table(RELEASES), now: NOW }) });

    it("waits while the bot's pull request for the same bump is open: it is the canary", async () => {
      const forge = new MemoryForge();
      forge.bot("renovate/acme-vpc-aws-5.x", "Update Terraform acme/vpc/aws to v5.1.1", "open");
      const { r } = await start(forge);
      expect(r.watched[0]).toMatchObject({ action: "waiting-on-bot", bot: "https://forge/p/pull/bot-1", to: "5.1.1" });
      expect(r.watched[0]!.reason).toContain("it is the canary");
      expect([...forge.prs.keys()]).toEqual(["renovate/acme-vpc-aws-5.x"]);
    }, 30_000);

    it("reads Dependabot's branch and title, and ignores a pull request for another version or module", async () => {
      const forge = new MemoryForge();
      forge.bot("dependabot/terraform/dev/app/acme/vpc/aws-5.1.1", "Bump acme/vpc/aws from 5.0.0 to 5.1.1 in /dev/app", "open");
      expect((await start(forge)).r.watched[0]!.action).toBe("waiting-on-bot");
      const other = new MemoryForge();
      other.bot("renovate/acme-vpc-aws-5.x", "Update acme/vpc/aws to v5.1.0", "open");
      other.bot("renovate/other", "Update acme/db/aws to v5.1.1", "open");
      expect((await start(other)).r.watched[0]!.action).toBe("started");
    }, 30_000);

    it("waits for the bot's merge to apply, then starts the rollout for the roots it did not move", async () => {
      const forge = new MemoryForge();
      forge.bot("renovate/acme-vpc-aws-5.x", "Update acme/vpc/aws to v5.1.1", "merged", "abc123");
      forge.checks.set("abc123", [{ name: "apply/dev/app", state: "pending" }]);
      const { repo, r } = await start(forge);
      expect(r.watched[0]).toMatchObject({ action: "waiting-on-bot" });
      expect(r.watched[0]!.reason).toBe("https://forge/p/pull/bot-1 merged and its apply has not reported");

      forge.checks.set("abc123", [{ name: "apply/dev/app", state: "failure" }]);
      expect((await watchRollouts(repo, { mode: "apply", forge: () => forge, sources: table(RELEASES), now: NOW })).watched[0]).toMatchObject({ action: "stopped", reason: "https://forge/p/pull/bot-1 merged and its apply failed" });

      forge.checks.set("abc123", [{ name: "apply/dev/app", state: "success" }]);
      const go = await watchRollouts(repo, { mode: "apply", forge: () => forge, sources: table(RELEASES), now: NOW });
      expect(go.watched[0]).toMatchObject({ action: "started", bot: "https://forge/p/pull/bot-1" });
      expect(go.watched[0]!.reason).toMatch(/^https:\/\/forge\/p\/pull\/bot-1 was the canary\. /);
      expect(forge.prs.has(waveBranch(VPC, "5.1.1", 1))).toBe(true);
    }, 30_000);

    it("leaves a release alone when the bot's pull request was closed unmerged", async () => {
      const forge = new MemoryForge();
      forge.bot("renovate/acme-vpc-aws-5.x", "Update acme/vpc/aws to v5.1.1", "closed");
      const { r } = await start(forge);
      expect(r.watched[0]).toMatchObject({ action: "stopped" });
      expect(r.watched[0]!.reason).toBe("https://forge/p/pull/bot-1 was closed without merging, so registry.terraform.io/acme/vpc/aws 5.1.1 is left alone");
      expect(forge.prs.size).toBe(1);
    }, 30_000);

    it("reads a merge's apply from the per-root checks, the terragucci/apply status, or the apply jobs", () => {
      expect(botApply([{ name: "apply/a", state: "success" }, { name: "apply/b", state: "pending" }])).toBe("pending");
      expect(botApply([{ name: "apply/a", state: "success" }, { name: "apply/b", state: "success" }])).toBe("success");
      expect(botApply([{ name: "terragucci/apply", state: "success" }])).toBe("success");
      expect(botApply([{ name: "terragucci / apply-wave-1 (push)", state: "failure" }])).toBe("failure");
      expect(botApply([])).toBe("pending");
    });
  });

  it("follows a provider's lock file, and names it by the address the lock holds", async () => {
    const LOCK = (v: string) => `provider "registry.opentofu.org/hashicorp/aws" {\n  version = "${v}"\n  hashes = [\n    "h1:${v}=",\n  ]\n}\n`;
    const SRC = (v: string) => `terraform {\n  required_providers {\n    aws = {\n      source  = "hashicorp/aws"\n      version = "${v}"\n    }\n  }\n}\n`;
    const repo = checkout({
      "terragucci.yml": config([{ provider: "hashicorp/*" }]),
      "dev/main.tf": backend("dev.tfstate") + SRC("6.67.0"),
      "dev/.terraform.lock.hcl": LOCK("6.67.0"),
    });
    const forge = new MemoryForge();
    const locked: string[] = [];
    const locker = () => (dir: string, address: string, to: string) => {
      locked.push(`${address} ${to}`);
      writeFileSync(join(dir, ".terraform.lock.hcl"), LOCK(to));
    };
    const sources = table({ "registry.opentofu.org/hashicorp/aws": ["6.67.0", "6.67.1", "6.68.0"] });
    const r = await watchRollouts(repo, { mode: "apply", forge: () => forge, sources, locker, now: NOW });
    expect(r.watched[0]).toMatchObject({ kind: "provider", name: "registry.opentofu.org/hashicorp/aws", from: "6.67.0", to: "6.68.0", action: "started" });
    expect(locked).toEqual(["registry.opentofu.org/hashicorp/aws 6.68.0"]);
    expect(describeWatch(r)).toContain("provider registry.opentofu.org/hashicorp/aws 6.67.0 -> 6.68.0: started");
  }, 30_000);

  it("does nothing, and asks nobody, when no rule is set", async () => {
    const repo = checkout({ "terragucci.yml": 'rollouts: "0 6 * * *"\n', "a/main.tf": backend("a.tfstate") + mod("5.0.0") });
    const sources = table(RELEASES);
    expect(await watchRollouts(repo, { sources })).toEqual({ mode: "dry-run", watched: [] });
    expect(sources.asked).toEqual([]);
  });
});

describe("respond rollout with watch", () => {
  it("continues the rollouts in flight and then lists what the watch would start", async () => {
    const files = { ...fleet(), "terragucci.yml": `forge: forgejo\nurl: https://forge.test/acme/infra\ntoken_env: FORGE_TOKEN\n${config()}` };
    const repo = checkout(files);
    const fetch: ForgeFetch = async (url) => {
      const body = url.endsWith("/repos/acme/infra") ? { default_branch: "main" } : [];
      return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
    };
    const r = await respond("rollout", repo, { fetch, watchSources: table(RELEASES) });
    expect(r.text).toBe(`no rollout in flight\n${VPC} 5.0.0 -> 5.1.1: would-start (2 waves)`);
    expect((r.data as { watch: { watched: unknown[] } }).watch.watched).toHaveLength(1);
  }, 30_000);
});

describe("how far behind", () => {
  const index = (project: string, modules: Array<[string, string]>, providers: Array<[string, string]>): ProjectIndex => ({
    project,
    reports: [],
    versions: {
      schema: "terragucci.versions/v1",
      roots: [{ root: "app", commit: "c1", finished: "2026-11-01T00:00:00Z", path: "r", providers: providers.map(([provider, version]) => ({ provider, version })), modules: modules.map(([source, version], i) => ({ call: `module.m${i}`, source, version })) }],
    },
  } as ProjectIndex);

  it("gives each version in use its newest release, how many are newer and the bump, in the data and on the page", async () => {
    const estate = buildEstate([index("github.com/acme/web", [[VPC, "5.0.0"], ["git::https://example.com/x.git", "1.0.0"]], [["registry.terraform.io/hashicorp/aws", "6.68.0"]])], NOW);
    await addBehind(estate.versions!, {
      async versions(s) {
        if (s.name === VPC) return ["5.0.0", "5.1.0", "6.0.0"];
        if (s.kind === "provider") return ["6.68.0"];
        return undefined;
      },
      async published() {
        return undefined;
      },
    });
    const v = estate.versions!;
    expect(v.modules.find((m) => m.source === VPC)!.versions[0]!.behind).toEqual({ latest: "6.0.0", releases: 2, bump: "major" });
    expect(v.providers[0]!.versions[0]!.behind).toBeUndefined();
    expect(v.unread).toEqual([{ name: "git::https://example.com/x.git", reason: "its releases are not listed for this kind of source" }]);
    const html = renderEstateHtml(estate);
    expect(html).toContain("<th>Behind</th>");
    expect(html).toContain("2 releases behind, major");
    expect(html).toContain("No newest release was read for");
  });

  it("leaves the page as it was when no registry was asked", () => {
    const html = renderEstateHtml(buildEstate([index("github.com/acme/web", [[VPC, "5.0.0"]], [])], NOW));
    expect(html).not.toContain("<th>Behind</th>");
  });
});
