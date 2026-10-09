import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { continueExit, continueRollouts, describeContinue, describeRollout, rollout, rolloutArgs, rolloutExit, waveBranch, type RolloutOptions } from "../src/rollout";
import { appliedState, fetchForge, type CommitCheck, type RolloutForge, type WavePullRequest } from "../src/rollout/forge";
import { SYNTH_ROLLOUTS } from "../src/config";
import { moveConstraint, readLock } from "../src/rollout/lock";
import { namesModule, shapePin } from "../src/rollout/pins";
import type { Fetch } from "../src/forge";
import { backend, bareFrom, git, remoteState, tmp, write } from "./helpers";

const GIT_MODULE = "git::https://example.com/acme/infra.git//modules/network";
const call = (ref: string) => `module "network" {\n  source = "${GIT_MODULE}?ref=${ref}"\n  name   = "x"\n}\n`;

/** Three roots that take modules/network by git tag: a canary, a network root, and an app reading the network's state. */
function pinnedRepo(extra: Record<string, string> = {}): string {
  return write(tmp(), {
    "terragucci.yml": 'waves:\n  canary: ["envs/dev/*"]\n',
    "envs/dev/app/main.tf": backend("dev/app.tfstate") + call("modules/network/v1.3.0"),
    "envs/prod/net/main.tf": backend("prod/net.tfstate") + call("modules/network/v1.3.0"),
    "envs/prod/app/main.tf": backend("prod/app.tfstate") + remoteState("prod/net.tfstate") + call("modules/network/v1.3.0"),
    "modules/network/main.tf": 'variable "name" {}\n',
    ...extra,
  });
}

/** A checkout whose origin is a bare repo, as a developer would have it. */
function checkout(dir: string): { repo: string; bare: string } {
  const bare = bareFrom(dir);
  const repo = tmp();
  git(repo, "clone", "-q", bare, ".");
  return { repo, bare };
}

/** A forge in memory: pull requests by branch, checks by commit, and a merge that really merges in the bare repo. */
class MemoryForge implements RolloutForge {
  prs = new Map<string, WavePullRequest & { title: string }>();
  checks = new Map<string, CommitCheck[]>();
  constructor(readonly bare: string, readonly name = "p") {}
  async defaultBranch() {
    return "main";
  }
  async findPullRequest(branch: string) {
    return this.prs.get(branch) ?? null;
  }
  async createPullRequest(pr: { base: string; head: string; title: string; body: string }) {
    const url = `https://forge/${this.name}/pull/${this.prs.size + 1}`;
    this.prs.set(pr.head, { url, state: "open", body: pr.body, title: pr.title });
    return url;
  }
  async commitChecks(sha: string) {
    return this.checks.get(sha) ?? [];
  }
  async listPullRequests(prefix: string) {
    return [...this.prs].filter(([branch]) => branch.startsWith(prefix)).reverse().map(([branch, pr]) => ({ branch, url: pr.url, title: pr.title, state: pr.state, body: pr.body }));
  }
  /** Merge a wave's branch into main, as a person would; the apply check is pending until `apply`. */
  merge(branch: string): string {
    const work = tmp();
    git(work, "clone", "-q", this.bare, ".");
    git(work, "-c", "user.name=t", "-c", "user.email=t@t", "merge", "-q", "--no-ff", "-m", "merge", `origin/${branch}`);
    git(work, "push", "-q", "origin", "main");
    const sha = git(work, "rev-parse", "HEAD").trim();
    const pr = this.prs.get(branch)!;
    this.prs.set(branch, { ...pr, state: "merged", mergeCommit: sha });
    this.checks.set(sha, [{ name: "terragucci / check (push)", state: "success" }, { name: "terragucci / apply (push)", state: "pending" }]);
    return sha;
  }
  apply(branch: string, state: CommitCheck["state"] = "success"): void {
    const sha = this.prs.get(branch)!.mergeCommit!;
    this.checks.set(sha, [{ name: "terragucci / apply (push)", state }]);
  }
}

const changedFiles = (bare: string, branch: string) => git(bare, "diff", "--name-only", `main...${branch}`).trim().split("\n").filter(Boolean);

describe("pins", () => {
  it("names a module by its source or by the end of its path, and keeps the pin's shape", () => {
    expect(namesModule(GIT_MODULE, "modules/network")).toBe(true);
    expect(namesModule("oci://r.example.com/acme/modules/network", "modules/network")).toBe(true);
    expect(namesModule("oci://r.example.com/acme/modules/network-v2", "modules/network")).toBe(false);
    expect(namesModule("oci://r.example.com/acme/modules/network", "oci://r.example.com/acme/modules/network?tag=1.0.0")).toBe(true);
    expect(shapePin("modules/network/v1.3.0", "1.4.0")).toBe("modules/network/v1.4.0");
    expect(shapePin("v1.3.0", "1.4.0")).toBe("v1.4.0");
    expect(shapePin("1.3.0", "1.4.0")).toBe("1.4.0");
  });
});

describe("rollout of a module pin in one repo", () => {
  it("opens one pull request per wave, each moving only its roots, and never the next before the last applied", async () => {
    const { repo, bare } = checkout(pinnedRepo());
    const forge = new MemoryForge(bare);
    const opts: RolloutOptions = { kind: "module", name: "modules/network", to: "1.4.0", mode: "apply", forge: () => forge };
    const b = (n: number) => waveBranch("modules/network", "1.4.0", n);

    const dry = await rollout(repo, { ...opts, mode: "dry-run" });
    expect(dry.status).toBe("would-open");
    expect(dry.waves.map((w) => w.parts.map((p) => p.roots))).toEqual([[["envs/dev/app"]], [["envs/prod/net"]], [["envs/prod/app"]]]);
    expect(dry.waves[0]!.parts[0]!.files).toEqual(["envs/dev/app/main.tf"]);
    expect(forge.prs.size).toBe(0);
    expect(describeRollout(dry)).toContain("dry run: nothing was opened");

    let r = await rollout(repo, opts);
    expect(r.status).toBe("opened");
    expect(r.waves[0]!.parts[0]!.state).toBe("opened");
    expect(changedFiles(bare, b(1))).toEqual(["envs/dev/app/main.tf"]);
    expect(git(bare, "show", `${b(1)}:envs/dev/app/main.tf`)).toContain("?ref=modules/network/v1.4.0");
    expect(git(bare, "show", "main:envs/dev/app/main.tf")).toContain("?ref=modules/network/v1.3.0");

    // Open: wait. Merged with the apply pending: wait. Neither opens wave 2.
    r = await rollout(repo, opts);
    expect([r.status, rolloutExit(r), r.waves[0]!.parts[0]!.state]).toEqual(["waiting", 3, "open"]);
    forge.merge(b(1));
    r = await rollout(repo, opts);
    expect([r.status, r.waves[0]!.parts[0]!.state, r.waves[0]!.parts[0]!.pending]).toEqual(["waiting", "waiting-apply", ["envs/dev/app"]]);
    expect(forge.prs.has(b(2))).toBe(false);

    forge.apply(b(1));
    r = await rollout(repo, opts);
    expect([r.status, r.waves[0]!.parts[0]!.state, r.waves[1]!.parts[0]!.state]).toEqual(["opened", "applied", "opened"]);
    expect(changedFiles(bare, b(2))).toEqual(["envs/prod/net/main.tf"]);

    forge.merge(b(2));
    forge.apply(b(2));
    r = await rollout(repo, opts);
    expect(changedFiles(bare, b(3))).toEqual(["envs/prod/app/main.tf"]);
    forge.merge(b(3));
    forge.apply(b(3));
    r = await rollout(repo, opts);
    expect([r.status, rolloutExit(r)]).toEqual(["complete", 0]);
    expect(r.roots.every((s) => s.state === "to")).toBe(true);
  }, 30_000); // a dozen git commands per wave: 1.7 s alone, over 5 s beside the whole suite

  it("stops at a failed apply, naming the root, and opens nothing after it", async () => {
    const { repo, bare } = checkout(pinnedRepo());
    const forge = new MemoryForge(bare);
    const opts: RolloutOptions = { kind: "module", name: "modules/network", to: "1.4.0", mode: "apply", forge: () => forge };
    await rollout(repo, opts);
    const b1 = waveBranch("modules/network", "1.4.0", 1);
    forge.merge(b1);
    forge.apply(b1, "failure");
    const r = await rollout(repo, opts);
    expect([r.status, rolloutExit(r)]).toEqual(["stopped", 1]);
    expect(r.stop).toContain("envs/dev/app");
    expect(forge.prs.size).toBe(1);
  });

  it("refuses a floating range and a pin set from a variable, and the report tips each", async () => {
    const reg = "app.terraform.io/acme/network/aws";
    const { repo, bare } = checkout(
      write(tmp(), {
        "a/main.tf": backend("a.tfstate") + `module "n" {\n  source  = "${reg}"\n  version = "1.3.0"\n}\n`,
        "b/main.tf": backend("b.tfstate") + `module "n" {\n  source  = "${reg}"\n  version = "~> 1.3"\n}\n`,
        "c/main.tf": backend("c.tfstate") + `variable "v" {}\n\nmodule "n" {\n  source  = "${reg}"\n  version = var.v\n}\n`,
      }),
    );
    const r = await rollout(repo, { kind: "module", name: reg, to: "1.4.0", forge: () => new MemoryForge(bare) });
    expect(r.waves.flatMap((w) => w.parts.flatMap((p) => p.roots))).toEqual(["a"]);
    expect(r.roots.filter((s) => s.state === "refused").map((s) => s.root)).toEqual(["b", "c"]);
    expect(r.tips.map((t) => [t.root, t.rule])).toEqual([
      ["b", "rollout-floating-pin"],
      ["c", "rollout-literal-pin"],
    ]);
    const text = describeRollout(r);
    expect(text).toContain("tip (rollout-floating-pin): b: b/main.tf module.n");
    expect(text).toMatch(/not in the rollout: b: .*constraint/);
  });

  it("finds the newest published tag when no version is named", async () => {
    const { repo, bare } = checkout(pinnedRepo());
    for (const v of ["1.3.0", "1.4.0", "1.10.0"]) {
      git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "tag", "-a", `modules/network/v${v}`, "-m", `modules/network ${v}`);
    }
    git(repo, "push", "-q", "origin", "--tags");
    const fresh = tmp();
    git(fresh, "clone", "-q", "--no-tags", bare, ".");
    const r = await rollout(fresh, { kind: "module", name: "modules/network", forge: () => new MemoryForge(bare) });
    expect([r.to, r.from, r.discovered, r.status]).toEqual(["1.10.0", "1.3.0", "tag modules/network/v1.10.0", "would-open"]);
    expect(describeRollout(r)).toContain("newest published: tag modules/network/v1.10.0");
  });

  it("finds the newest version in the OCI repository a root pins", async () => {
    const oci = "oci://registry.example.com/acme/modules/network";
    const { repo, bare } = checkout(write(tmp(), { "a/main.tf": backend("a.tfstate") + `module "n" {\n  source = "${oci}?tag=1.3.0"\n}\n` }));
    const asked: string[] = [];
    const registryFetch = (async (url: string) => {
      asked.push(url);
      return new Response(JSON.stringify({ tags: ["1.3.0", "1.5.0", "latest"] }), { status: 200 });
    }) as never;
    const r = await rollout(repo, { kind: "module", name: "modules/network", forge: () => new MemoryForge(bare), registryFetch });
    expect(asked).toEqual(["https://registry.example.com/v2/acme/modules/network/tags/list"]);
    expect([r.to, r.waves[0]!.parts[0]!.files]).toEqual(["1.5.0", ["a/main.tf"]]);
  });
});

describe("continuing every rollout in flight", () => {
  it("finds a rollout by its pull requests and opens its next wave only once the last merged and applied", async () => {
    const { repo, bare } = checkout(pinnedRepo());
    const forge = new MemoryForge(bare);
    const b = (n: number) => waveBranch("modules/network", "1.4.0", n);
    const go = () => continueRollouts(repo, { mode: "apply", forge: () => forge });

    let c = await go();
    expect([c.rollouts, describeContinue(c), continueExit(c)]).toEqual([[], "no rollout in flight", 0]);
    // A pull request from a rollout branch without the marker is not a rollout's.
    forge.prs.set("terragucci/rollout/stray", { url: "https://forge/p/pull/9", state: "merged", body: "by hand", title: "stray" });

    await rollout(repo, { kind: "module", name: "modules/network", to: "1.4.0", mode: "apply", forge: () => forge });
    expect(forge.prs.get(b(1))!.body).toContain('"wave":1,"waves":3');
    c = await go();
    expect(c.rollouts.map((r) => [r.name, r.from, r.to, r.wave, r.waves, r.action])).toEqual([["modules/network", "1.3.0", "1.4.0", 1, 3, "waiting"]]);

    // Merged, apply pending: the rollout runs and waits; nothing opens.
    forge.merge(b(1));
    c = await go();
    expect([c.rollouts[0]!.action, c.rollouts[0]!.result?.status]).toEqual(["ran", "waiting"]);
    expect(forge.prs.has(b(2))).toBe(false);

    forge.apply(b(1));
    c = await go();
    expect([c.rollouts[0]!.action, c.rollouts[0]!.result?.status, continueExit(c)]).toEqual(["ran", "opened", 0]);
    expect(changedFiles(bare, b(2))).toEqual(["envs/prod/net/main.tf"]);
    expect(describeContinue(c)).toContain("modules/network 1.3.0 -> 1.4.0: opened");

    // Open again: nothing runs. A dry run of the same opens nothing either.
    c = await go();
    expect([c.rollouts[0]!.wave, c.rollouts[0]!.action]).toEqual([2, "waiting"]);
    forge.merge(b(2));
    forge.apply(b(2));
    c = await continueRollouts(repo, { forge: () => forge });
    expect([c.mode, c.rollouts[0]!.result?.status]).toEqual(["dry-run", "would-open"]);
    expect(forge.prs.has(b(3))).toBe(false);

    await go();
    forge.merge(b(3));
    forge.apply(b(3));
    c = await go();
    expect([c.rollouts[0]!.action, c.rollouts[0]!.reason]).toEqual(["done", "wave 3 of 3, the last, merged"]);
  }, 30_000);

  it("continues a registry version pin and an oci:// tag pin, each on its own branch and in the shape it had", async () => {
    const oci = "oci://registry.example.com/acme/modules/network";
    const reg = "acme/network/aws";
    const { repo, bare } = checkout(
      write(tmp(), {
        "terragucci.yml": 'waves:\n  canary: ["dev/*"]\n',
        "dev/oci/main.tf": backend("dev/oci.tfstate") + `module "n" {\n  source = "${oci}?tag=1.3.0"\n}\n`,
        "prod/oci/main.tf": backend("prod/oci.tfstate") + `module "n" {\n  source = "${oci}?tag=1.3.0"\n}\n`,
        "dev/reg/main.tf": backend("dev/reg.tfstate") + `module "n" {\n  source  = "${reg}"\n  version = "1.3.0"\n}\n`,
        "prod/reg/main.tf": backend("prod/reg.tfstate") + `module "n" {\n  source  = "${reg}"\n  version = "1.3.0"\n}\n`,
      }),
    );
    const forge = new MemoryForge(bare);
    for (const name of ["modules/network", reg]) await rollout(repo, { kind: "module", name, to: "1.4.0", mode: "apply", forge: () => forge });
    const ociBranch = (n: number) => waveBranch("modules/network", "1.4.0", n);
    const regBranch = (n: number) => waveBranch(reg, "1.4.0", n);
    expect([ociBranch(1), regBranch(1)]).toEqual(["terragucci/rollout/modules-network-1.4.0/wave-1", "terragucci/rollout/acme-network-aws-1.4.0/wave-1"]);
    expect([changedFiles(bare, ociBranch(1)), changedFiles(bare, regBranch(1))]).toEqual([["dev/oci/main.tf"], ["dev/reg/main.tf"]]);
    for (const b of [ociBranch(1), regBranch(1)]) {
      forge.merge(b);
      forge.apply(b);
    }
    const c = await continueRollouts(repo, { mode: "apply", forge: () => forge });
    expect(c.rollouts.map((r) => [r.name, r.from, r.to, r.action, r.result?.status]).sort()).toEqual([
      ["acme/network/aws", "1.3.0", "1.4.0", "ran", "opened"],
      ["modules/network", "1.3.0", "1.4.0", "ran", "opened"],
    ]);
    expect([changedFiles(bare, ociBranch(2)), changedFiles(bare, regBranch(2))]).toEqual([["prod/oci/main.tf"], ["prod/reg/main.tf"]]);
    expect(git(bare, "show", `${ociBranch(2)}:prod/oci/main.tf`)).toContain(`source = "${oci}?tag=1.4.0"`);
    expect(git(bare, "show", `${regBranch(2)}:prod/reg/main.tf`)).toContain('version = "1.4.0"');
  }, 30_000);

  it("reads the wave count from the title when the body predates it, and leaves a closed wave stopped", async () => {
    const { repo, bare } = checkout(pinnedRepo());
    const forge = new MemoryForge(bare);
    await rollout(repo, { kind: "module", name: "modules/network", to: "1.4.0", mode: "apply", forge: () => forge });
    const b1 = waveBranch("modules/network", "1.4.0", 1);
    const pr = forge.prs.get(b1)!;
    forge.prs.set(b1, { ...pr, state: "closed", body: pr.body.replace(',"waves":3', "") });
    const c = await continueRollouts(repo, { mode: "apply", forge: () => forge });
    expect([c.rollouts[0]!.waves, c.rollouts[0]!.action, c.rollouts[0]!.reason]).toEqual([3, "stopped", "wave 1 was closed without merging: https://forge/p/pull/1"]);
    expect(forge.prs.size).toBe(1);
  });
});

describe("rollout from a control repo", () => {
  it("opens one pull request per project per wave: canaries in both, then project order", async () => {
    const one = bareFrom(pinnedRepo({ "terragucci.yml": "" }));
    const two = bareFrom(
      write(tmp(), {
        "envs/dev/web/main.tf": backend("dev/web.tfstate") + call("modules/network/v1.3.0"),
        "envs/prod/web/main.tf": backend("prod/web.tfstate") + call("modules/network/v1.3.0"),
      }),
    );
    const control = write(tmp(), {
      "terragucci.yml": [
        "defaults:",
        "  forge: forgejo",
        '  waves: { canary: ["envs/dev/*"] }',
        "projects:",
        `  example.com/acme/one: { url: ${one} }`,
        `  example.com/acme/two: { url: ${two} }`,
        "",
      ].join("\n"),
    });
    git(control, "init", "-q");
    const forges = { "example.com/acme/one": new MemoryForge(one, "one"), "example.com/acme/two": new MemoryForge(two, "two") };
    const opts: RolloutOptions = { kind: "module", name: "modules/network", to: "1.4.0", mode: "apply", forge: ({ key }) => forges[key as keyof typeof forges] };
    let r = await rollout(control, opts);
    expect(r.waves.map((w) => w.parts.map((p) => `${p.project.split("/").pop()}:${p.roots.join("+")}`))).toEqual([
      ["one:envs/dev/app", "two:envs/dev/web"],
      ["one:envs/prod/net"],
      ["one:envs/prod/app"],
      ["two:envs/prod/web"],
    ]);
    expect(r.waves[0]!.parts.map((p) => p.state)).toEqual(["opened", "opened"]);
    const b1 = waveBranch("modules/network", "1.4.0", 1);
    expect(changedFiles(one, b1)).toEqual(["envs/dev/app/main.tf"]);
    expect(changedFiles(two, b1)).toEqual(["envs/dev/web/main.tf"]);

    // Wave 1 is done only when both projects' pull requests merged and applied.
    forges["example.com/acme/one"].merge(b1);
    forges["example.com/acme/one"].apply(b1);
    r = await rollout(control, opts);
    expect([r.status, r.waves[0]!.parts.map((p) => p.state)]).toEqual(["waiting", ["applied", "open"]]);
    forges["example.com/acme/two"].merge(b1);
    forges["example.com/acme/two"].apply(b1);
    r = await rollout(control, opts);
    expect([r.status, r.waves[1]!.parts[0]!.state]).toEqual(["opened", "opened"]);
    expect(describeRollout(r)).toContain("example.com/acme/one: pull request opened");

    // From the control repo, a continue reads every project's pull requests: wave 2 is open, so nothing runs.
    const c = await continueRollouts(control, { mode: "apply", forge: ({ key }) => forges[key as keyof typeof forges] });
    expect(c.rollouts.map((x) => [x.wave, x.waves, x.action, x.pullRequests])).toEqual([[2, 4, "waiting", ["https://forge/one/pull/2"]]]);
  });

  it("lists a project whose roots synth writes as refused, with why, and rolls the rest out", async () => {
    const one = bareFrom(pinnedRepo({ "terragucci.yml": "" }));
    const two = bareFrom(write(tmp(), { "main.js": "", "cdktf.json": "{}" }));
    const control = write(tmp(), {
      "terragucci.yml": ["defaults:", "  forge: forgejo", "projects:", `  example.com/acme/one: { url: ${one} }`, `  example.com/acme/two: { url: ${two}, synth: npx cdktn synth }`, ""].join("\n"),
    });
    git(control, "init", "-q");
    const forges = { "example.com/acme/one": new MemoryForge(one, "one"), "example.com/acme/two": new MemoryForge(two, "two") };
    const r = await rollout(control, { kind: "module", name: "modules/network", to: "1.4.0", forge: ({ key }) => forges[key as keyof typeof forges] });
    expect(r.roots.filter((x) => x.project === "example.com/acme/two")).toEqual([{ project: "example.com/acme/two", root: ".", state: "refused", reason: SYNTH_ROLLOUTS }]);
    expect(r.waves.flatMap((w) => w.parts.map((p) => p.project))).not.toContain("example.com/acme/two");
    expect(r.tips.filter((t) => t.project === "example.com/acme/two")).toEqual([]);
    expect(describeRollout(r)).toContain("with synth the command writes those files");
  });
});

describe("rollout with synth in one repo", () => {
  it("is refused, by the rollout and by its continue, naming why", async () => {
    const { repo } = checkout(write(tmp(), { "terragucci.yml": "forge: forgejo\nsynth: npx cdktn synth\n", "main.js": "" }));
    await expect(rollout(repo, { kind: "module", name: "modules/network", to: "1.4.0", forge: () => new MemoryForge(repo) })).rejects.toThrow(`terragucci rollout: ${SYNTH_ROLLOUTS}`);
    await expect(continueRollouts(repo, { forge: () => new MemoryForge(repo) })).rejects.toThrow(`terragucci respond rollout: ${SYNTH_ROLLOUTS}`);
  });
});

const LOCK = (v: string) => `# This file is maintained automatically by "tofu init".

provider "registry.opentofu.org/hashicorp/aws" {
  version     = "${v}"
  constraints = "${v}"
  hashes = [
    "h1:${v}=",
  ]
}

provider "registry.opentofu.org/hashicorp/random" {
  version = "3.7.2"
  hashes = [
    "h1:random=",
  ]
}
`;

const PROVIDERS = `terraform {\n  required_providers {\n    aws = {\n      source  = "hashicorp/aws"\n      version = "6.67.0"\n    }\n  }\n}\n`;

describe("rollout of a provider", () => {
  it("moves each wave's lock file and exact constraint, and refuses a root with no lock file", async () => {
    const { repo, bare } = checkout(
      write(tmp(), {
        "terragucci.yml": 'waves:\n  canary: ["dev"]\n',
        "dev/main.tf": backend("dev.tfstate") + PROVIDERS,
        "dev/.terraform.lock.hcl": LOCK("6.67.0"),
        "prod/main.tf": backend("prod.tfstate") + PROVIDERS,
        "prod/.terraform.lock.hcl": LOCK("6.67.0"),
        "loose/main.tf": backend("loose.tfstate") + PROVIDERS,
      }),
    );
    const forge = new MemoryForge(bare);
    const seen: string[] = [];
    const locker = () => (dir: string, address: string, to: string) => {
      seen.push(address);
      // The old entry is gone when the binary runs; it writes the provider afresh.
      const p = join(dir, ".terraform.lock.hcl");
      expect(readLock(readFileSync(p, "utf-8")).has(address)).toBe(false);
      writeFileSync(p, LOCK(to));
    };
    const opts: RolloutOptions = { kind: "provider", name: "hashicorp/aws", to: "6.68.0", mode: "apply", forge: () => forge, locker };
    const dry = await rollout(repo, { ...opts, mode: "dry-run" });
    expect(dry.waves[0]!.parts[0]!.files).toEqual(["dev/.terraform.lock.hcl"]);
    expect(dry.tips.map((t) => [t.root, t.rule])).toEqual([["loose", "rollout-lock-file"]]);

    await rollout(repo, opts);
    const b1 = waveBranch("hashicorp/aws", "6.68.0", 1);
    expect(seen).toEqual(["registry.opentofu.org/hashicorp/aws"]);
    expect(changedFiles(bare, b1)).toEqual(["dev/.terraform.lock.hcl", "dev/main.tf"]);
    expect(readLock(git(bare, "show", `${b1}:dev/.terraform.lock.hcl`)).get("registry.opentofu.org/hashicorp/aws")).toBe("6.68.0");
    expect(git(bare, "show", `${b1}:dev/main.tf`)).toContain('version = "6.68.0"');
    forge.merge(b1);
    forge.apply(b1);
    const r = await rollout(repo, opts);
    expect(changedFiles(bare, waveBranch("hashicorp/aws", "6.68.0", 2))).toEqual(["prod/.terraform.lock.hcl", "prod/main.tf"]);
    expect(r.waves[1]!.parts[0]!.state).toBe("opened");
  });

  it("refuses a lock edit that moves another provider", async () => {
    const { repo, bare } = checkout(write(tmp(), { "dev/main.tf": backend("dev.tfstate") + PROVIDERS, "dev/.terraform.lock.hcl": LOCK("6.67.0") }));
    const locker = () => (dir: string, _a: string, to: string) => {
      const p = join(dir, ".terraform.lock.hcl");
      writeFileSync(p, LOCK(to).replace("3.7.2", "3.8.0"));
    };
    const r = await rollout(repo, { kind: "provider", name: "hashicorp/aws", to: "6.68.0", mode: "apply", forge: () => new MemoryForge(bare), locker });
    expect(r.status).toBe("stopped");
    expect(r.stop).toContain("also moved registry.opentofu.org/hashicorp/random");
  });

  it("moves only an exact constraint", () => {
    expect(moveConstraint(PROVIDERS, "registry.opentofu.org/hashicorp/aws", "6.67.0", "6.68.0")).toContain('version = "6.68.0"');
    const range = PROVIDERS.replace('"6.67.0"', '"~> 6.0"');
    expect(moveConstraint(range, "registry.opentofu.org/hashicorp/aws", "6.67.0", "6.68.0")).toBe(range);
  });
});

describe("the forge", () => {
  it("reads a Forgejo pull request by branch, its merge commit, and the apply job's newest status", async () => {
    const answers: Record<string, unknown> = {
      "/api/v1/repos/acme/infra/pulls?state=all&limit=50&page=1": [
        { html_url: "u/1", number: 1, state: "closed", merged: true, merge_commit_sha: "abc", body: "b", head: { ref: "w1" } },
        { html_url: "u/2", number: 2, state: "open", body: "", head: { ref: "other" } },
      ],
      "/api/v1/repos/acme/infra/commits/abc/statuses?limit=100": [
        { id: 1, context: "terragucci / apply (push)", status: "pending" },
        { id: 2, context: "terragucci / apply (push)", status: "success" },
        { id: 3, context: "terragucci / check (push)", status: "success" },
      ],
    };
    const fetch: Fetch = async (url) => {
      const path = url.replace("https://forge.example.com", "");
      const body = answers[path];
      return { ok: body !== undefined, status: body ? 200 : 404, json: async () => body, text: async () => JSON.stringify(body) };
    };
    const f = fetchForge(fetch, { forge: "forgejo", origin: "https://forge.example.com", path: "acme/infra", token: "" });
    const pr = await f.findPullRequest("w1");
    expect(pr).toEqual({ url: "u/1", state: "merged", body: "b", mergeCommit: "abc" });
    const checks = await f.commitChecks("abc");
    expect(appliedState(checks, "envs/dev/app")).toBe("success");
    expect(appliedState([{ name: "apply/envs/dev/app", state: "failure" }, { name: "apply", state: "success" }], "envs/dev/app")).toBe("failure");
    expect(appliedState([{ name: "terragucci / check (push)", state: "success" }], "x")).toBe("pending");
  });

  it("reads an empty Forgejo repo, whose pull request list answers 404, as having none, and throws on any other 404", async () => {
    const forge = (empty: boolean) => {
      const fetch: Fetch = async (url) => {
        const repo = url.endsWith("/api/v1/repos/acme/infra");
        return { ok: repo, status: repo ? 200 : 404, json: async () => ({ empty }), text: async () => (repo ? "" : "The target couldn't be found.") };
      };
      return fetchForge(fetch, { forge: "forgejo", origin: "https://forge.example.com", path: "acme/infra", token: "" });
    };
    expect(await forge(true).findPullRequest("w1")).toBeNull();
    await expect(forge(false).findPullRequest("w1")).rejects.toThrow(/answered 404/);
  });

  it("lists the pull requests from a prefix's branches, newest update first, on GitHub and GitLab", async () => {
    const answers: Record<string, unknown> = {
      "https://api.github.com/repos/acme/infra/pulls?state=all&sort=updated&direction=desc&per_page=100&page=1": [
        { html_url: "g/2", title: "t2", state: "closed", merged_at: "2026-01-01T00:00:00Z", body: "b2", head: { ref: "terragucci/rollout/x-1.4.0/wave-1" } },
        { html_url: "g/1", title: "t1", state: "open", body: null, head: { ref: "feature" } },
      ],
      "https://gitlab.example.com/api/v4/projects/acme%2Finfra/merge_requests?state=all&order_by=updated_at&sort=desc&per_page=100&page=1": [
        { web_url: "l/1", title: "t", state: "opened", description: "d", source_branch: "terragucci/rollout/x-1.4.0/wave-2" },
        { web_url: "l/0", title: "t", state: "closed", description: "d", source_branch: "terragucci/rollout/x-1.4.0/wave-1" },
      ],
    };
    const fetch: Fetch = async (url) => ({ ok: true, status: 200, json: async () => answers[url], text: async () => "" });
    const gh = fetchForge(fetch, { forge: "github", origin: "https://github.com", path: "acme/infra", token: "" });
    expect(await gh.listPullRequests("terragucci/rollout/")).toEqual([{ branch: "terragucci/rollout/x-1.4.0/wave-1", url: "g/2", title: "t2", state: "merged", body: "b2" }]);
    const gl = fetchForge(fetch, { forge: "gitlab", origin: "https://gitlab.example.com", path: "acme/infra", token: "" });
    expect((await gl.listPullRequests("terragucci/rollout/")).map((p) => [p.url, p.state])).toEqual([["l/1", "open"], ["l/0", "closed"]]);
  });

  it("opens a pull request on a Forgejo repo whose list answers 404 just after its first push, and throws on any other 404", async () => {
    const run = async (repo: { empty: boolean } | null, listAnswers: number[]) => {
      const asked: string[] = [];
      const fetch: Fetch = async (url, init) => {
        const path = url.replace("https://forge.example.com/api/v1", "");
        asked.push(`${init?.method} ${path}`);
        if (path === "/repos/acme/infra") return { ok: !!repo, status: repo ? 200 : 404, json: async () => repo, text: async () => "" };
        if (init?.method === "GET") {
          const status = listAnswers.shift() ?? 200;
          return { ok: status === 200, status, json: async () => [], text: async () => "The target couldn't be found." };
        }
        return { ok: true, status: 201, json: async () => ({ html_url: "u/1", number: 1 }), text: async () => "" };
      };
      const f = fetchForge(fetch, { forge: "forgejo", origin: "https://forge.example.com", path: "acme/infra", token: "" });
      const url = await f.createPullRequest({ base: "main", head: "w1", title: "t", body: "b" });
      return { url, asked };
    };
    // Still empty: no pull request is open, so one is made.
    expect(await run({ empty: true }, [404])).toEqual({ url: "u/1", asked: ["GET /repos/acme/infra/pulls?state=open", "GET /repos/acme/infra", "POST /repos/acme/infra/pulls"] });
    // No longer empty by the time the repo is read: the list is asked again.
    expect((await run({ empty: false }, [404, 200])).asked).toEqual(["GET /repos/acme/infra/pulls?state=open", "GET /repos/acme/infra", "GET /repos/acme/infra/pulls?state=open", "POST /repos/acme/infra/pulls"]);
    // A list that keeps answering 404 for a repo with commits is a real failure.
    await expect(run({ empty: false }, [404, 404])).rejects.toThrow(/answered 404/);
    await expect(run(null, [404])).rejects.toThrow(/answered 404/);
  });

  it("reads one apply job per wave, and the terragucci/apply status over them", () => {
    const waves = (a: CommitCheck["state"], b: CommitCheck["state"]): CommitCheck[] => [
      { name: "terragucci / apply-wave-1 (push)", state: a },
      { name: "terragucci / apply-wave-2 (push)", state: b },
    ];
    expect(appliedState(waves("success", "success"), "x")).toBe("success");
    expect(appliedState(waves("success", "pending"), "x")).toBe("pending");
    expect(appliedState(waves("success", "failure"), "x")).toBe("failure");
    expect(appliedState([{ name: "apply-wave-1", state: "success" }], "x")).toBe("success");
    // The status the apply jobs write wins over the jobs themselves.
    expect(appliedState([...waves("success", "success"), { name: "terragucci/apply", state: "pending" }], "x")).toBe("pending");
    expect(appliedState([...waves("success", "pending"), { name: "terragucci/apply", state: "success" }], "x")).toBe("success");
  });
});

describe("the command line", () => {
  it("reads a module rollout, a provider rollout, and refuses the rest", () => {
    expect(rolloutArgs(["modules/network"], {})).toMatchObject({ kind: "module", name: "modules/network", to: undefined, mode: "dry-run" });
    expect(rolloutArgs(["6.68.0"], { provider: "hashicorp/aws", mode: "apply" })).toMatchObject({ kind: "provider", name: "hashicorp/aws", to: "6.68.0", mode: "apply" });
    expect(() => rolloutArgs([], {})).toThrow(/usage/);
    expect(() => rolloutArgs(["m"], { mode: "go" })).toThrow(/--mode/);
  });
});
