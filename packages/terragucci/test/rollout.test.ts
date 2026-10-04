import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { describeRollout, rollout, rolloutArgs, rolloutExit, waveBranch, type RolloutOptions } from "../src/rollout";
import { appliedState, fetchForge, type CommitCheck, type RolloutForge, type WavePullRequest } from "../src/rollout/forge";
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
  });

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
});

describe("the command line", () => {
  it("reads a module rollout, a provider rollout, and refuses the rest", () => {
    expect(rolloutArgs(["modules/network"], {})).toMatchObject({ kind: "module", name: "modules/network", to: undefined, mode: "dry-run" });
    expect(rolloutArgs(["6.68.0"], { provider: "hashicorp/aws", mode: "apply" })).toMatchObject({ kind: "provider", name: "hashicorp/aws", to: "6.68.0", mode: "apply" });
    expect(() => rolloutArgs([], {})).toThrow(/usage/);
    expect(() => rolloutArgs(["m"], { mode: "go" })).toThrow(/--mode/);
  });
});
