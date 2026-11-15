import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { describePins, groupPins, pinExit, pinModules, pinModulesArgs, satisfies } from "../src/pin-modules";
import { continueRollouts, waveBranch } from "../src/rollout";
import type { CommitCheck, RolloutForge, WavePullRequest } from "../src/rollout/forge";
import { loadHclParser } from "../src/rollout/parser";
import { pinProviderRange, pinRange, UNVERSIONED } from "../src/rollout/range";
import { backend, bareFrom, git, remoteState, tmp, write } from "./helpers";

const SRC = "acme/vpc/aws";
const call = (version?: string, extra = "") => `module "vpc" {\n  source  = "${SRC}"\n${version ? `  version = "${version}"  # held\n` : ""}${extra}  name    = "x"\n}\n`;

/** Records what init left in a root: the module calls it resolved, as `.terraform/modules/modules.json`. */
function initState(repo: string, root: string, resolved: Record<string, string>): void {
  const dir = join(repo, root, ".terraform/modules");
  mkdirSync(dir, { recursive: true });
  const modules = Object.entries(resolved).map(([key, Version]) => ({ Key: key, Source: `registry.terraform.io/${SRC}`, Version, Dir: `.terraform/modules/${key}` }));
  writeFileSync(join(dir, "modules.json"), JSON.stringify({ Modules: [{ Key: "", Source: "", Dir: "." }, ...modules] }));
}

class MemoryForge implements RolloutForge {
  prs = new Map<string, WavePullRequest & { title: string }>();
  checks = new Map<string, CommitCheck[]>();
  asked = 0;
  constructor(readonly bare: string) {}
  async defaultBranch() {
    this.asked++;
    return "main";
  }
  async findPullRequest(branch: string) {
    return this.prs.get(branch) ?? null;
  }
  async createPullRequest(pr: { base: string; head: string; title: string; body: string }) {
    const url = `https://forge/pull/${this.prs.size + 1}`;
    this.prs.set(pr.head, { url, state: "open", body: pr.body, title: pr.title });
    return url;
  }
  async commitChecks(sha: string) {
    return this.checks.get(sha) ?? [];
  }
  async listPullRequests(prefix: string) {
    return [...this.prs].filter(([b]) => b.startsWith(prefix)).reverse().map(([branch, pr]) => ({ branch, url: pr.url, title: pr.title, state: pr.state, body: pr.body }));
  }
  mergeAndApply(branch: string): void {
    const work = tmp();
    git(work, "clone", "-q", this.bare, ".");
    git(work, "-c", "user.name=t", "-c", "user.email=t@t", "merge", "-q", "--no-ff", "-m", "merge", `origin/${branch}`);
    git(work, "push", "-q", "origin", "main");
    const sha = git(work, "rev-parse", "HEAD").trim();
    this.prs.set(branch, { ...this.prs.get(branch)!, state: "merged", mergeCommit: sha });
    this.checks.set(sha, [{ name: "terragucci / apply (push)", state: "success" }]);
  }
}

/** Roots a1 and a2 (a2 reads a1's state) and b, all under `~> 5.0`; a library module with its own constraint; a root with an exact pin. */
function estate(): { repo: string; bare: string } {
  const dir = write(tmp(), {
    "a1/main.tf": backend("a1.tfstate") + call("~> 5.0"),
    "a2/main.tf": backend("a2.tfstate") + remoteState("a1.tfstate") + call("~> 5.0"),
    "b/main.tf": backend("b.tfstate") + call("~> 5.0"),
    "exact/main.tf": backend("exact.tfstate") + call("5.1.0"),
    "modules/lib/main.tf": call(">= 4.0"),
  });
  const bare = bareFrom(dir);
  const repo = tmp();
  git(repo, "clone", "-q", bare, ".");
  initState(repo, "a1", { vpc: "5.3.1" });
  initState(repo, "a2", { vpc: "5.3.1" });
  initState(repo, "b", { vpc: "5.4.0" });
  initState(repo, "exact", { vpc: "5.1.0" });
  return { repo, bare };
}

describe("satisfies", () => {
  it("reads Terraform's constraint operators", () => {
    expect(satisfies("5.3.1", "~> 5.0")).toBe(true);
    expect(satisfies("6.0.0", "~> 5.0")).toBe(false);
    expect(satisfies("5.3.9", "~> 5.3.1")).toBe(true);
    expect(satisfies("5.4.0", "~> 5.3.1")).toBe(false);
    expect(satisfies("5.0.0", ">= 4.0, < 5.0")).toBe(false);
    expect(satisfies("4.9.0", ">= 4.0, < 5.0")).toBe(true);
    expect(satisfies("1.2.3", "!= 1.2.3")).toBe(false);
    expect(satisfies("1.2.3", "1.2.3")).toBe(true);
    expect(satisfies("1.2.3", "latest")).toBeUndefined();
  });
});

describe("pinRange", () => {
  it("rewrites the constraint literal and no other byte", async () => {
    const parser = await loadHclParser();
    const text = `# vpc\nmodule "vpc" {\n  source  = "${SRC}"\n  version = "~> 5.0"  # held\n  name    = "x"\n}\nmodule "other" {\n  source  = "acme/dns/aws"\n  version = "~> 5.0"\n}\n`;
    const out = await pinRange(text, "main.tf", { module: SRC, from: "~> 5.0", to: "5.3.1" }, parser);
    expect(out.calls).toEqual([{ call: "module.vpc", outcome: "moved" }]);
    expect(out.content).toBe(text.replace(`version = "~> 5.0"  # held`, `version = "5.3.1"  # held`));
  });
  it("leaves a call at another constraint alone", async () => {
    const parser = await loadHclParser();
    const text = call(">= 5.0");
    const out = await pinRange(text, "main.tf", { module: SRC, from: "~> 5.0", to: "5.3.1" }, parser);
    expect(out).toEqual({ content: text, calls: [] });
  });
});

describe("terragucci pin modules", () => {
  it("lists each constraint with the version its root runs, and leaves the rest out", async () => {
    const { repo } = estate();
    const forge = new MemoryForge("unused");
    const r = await pinModules(repo, { tableOnly: true, rollout: { forge: () => forge } });
    expect(forge.asked).toBe(0);
    expect(r.rollouts).toEqual([]);
    expect(r.rows.map((x) => [x.root, x.range, x.version, x.state])).toEqual([
      ["a1", "~> 5.0", "5.3.1", "pin"],
      ["a2", "~> 5.0", "5.3.1", "pin"],
      ["b", "~> 5.0", "5.4.0", "pin"],
    ]);
    const text = describePins(r);
    expect(text).toContain("root");
    expect(text).toContain("3 of 3 pinned");
    expect(groupPins(r.rows).groups.map((g) => [g.version, g.roots])).toEqual([["5.3.1", ["a1", "a2"]], ["5.4.0", ["b"]]]);
  });

  it("adds a version to a call that has none, and reports a version the constraint does not allow, and a root with no init state", async () => {
    const { repo } = estate();
    write(repo, { "c/main.tf": backend("c.tfstate") + call(), "d/main.tf": backend("d.tfstate") + call("~> 5.0"), "e/main.tf": backend("e.tfstate") + call("~> 5.0") });
    initState(repo, "c", { vpc: "2.0.0" });
    initState(repo, "d", { vpc: "4.0.0" });
    const r = await pinModules(repo, { tableOnly: true, init: false });
    const row = (root: string) => r.rows.find((x) => x.root === root)!;
    expect([row("c").state, row("c").version, row("c").range]).toEqual(["pin", "2.0.0", UNVERSIONED]);
    expect(row("d").state).toBe("unresolved");
    expect(row("d").reason).toContain("does not allow");
    expect(row("e").state).toBe("unresolved");
    expect(row("e").reason).toContain("run init there");
  });

  it("runs init for a root with no init state, and asks the lookup only for what init did not answer", async () => {
    const { repo } = estate();
    write(repo, { "e/main.tf": backend("e.tfstate") + call("~> 5.0"), "f/main.tf": backend("f.tfstate") + call("~> 5.0") });
    const inits: string[] = [];
    const asked: string[] = [];
    const r = await pinModules(repo, {
      tableOnly: true,
      runInit: (dir, binary) => {
        inits.push(`${dir.split("/").pop()} ${binary}`);
        if (dir.endsWith("/e")) initState(repo, "e", { vpc: "5.2.0" });
      },
      lookup: async (source, constraint) => {
        asked.push(`${source} ${constraint}`);
        return "5.9.9";
      },
    });
    expect(inits.map((i) => i.split(" ")[0])).toEqual(["e", "f"]);
    expect(asked).toEqual([`${SRC} ~> 5.0`]);
    const by = (root: string) => r.rows.find((x) => x.root === root)!;
    expect([by("e").version, by("e").from]).toEqual(["5.2.0", "init"]);
    expect([by("f").version, by("f").from]).toEqual(["5.9.9", "lookup"]);
    expect(by("a1").from).toBe("init state");
  });

  it("opens one rollout per resolved version, each moving only its roots, and continues without moving the others", async () => {
    const { repo, bare } = estate();
    const forge = new MemoryForge(bare);
    const opts = { mode: "apply" as const, rollout: { forge: () => forge } };

    const dry = await pinModules(repo, { rollout: { forge: () => forge } });
    expect(dry.rollouts.map((x) => [x.from, x.to, x.status])).toEqual([["~> 5.0", "5.3.1", "would-open"], ["~> 5.0", "5.4.0", "would-open"]]);
    expect(forge.prs.size).toBe(0);

    const r = await pinModules(repo, opts);
    expect(pinExit(r)).toBe(0);
    const b531 = waveBranch(SRC, "5.3.1", 1, "~> 5.0");
    const b540 = waveBranch(SRC, "5.4.0", 1, "~> 5.0");
    expect(b531).not.toBe(b540);
    const changed = (branch: string) => git(bare, "diff", "--name-only", `main...${branch}`).trim().split("\n");
    expect(changed(b531)).toEqual(["a1/main.tf"]);
    expect(changed(b540)).toEqual(["b/main.tf"]);
    expect(git(bare, "show", `${b531}:a1/main.tf`)).toContain(`version = "5.3.1"  # held`);
    expect(git(bare, "show", `${b540}:b/main.tf`)).toContain(`version = "5.4.0"`);
    expect(forge.prs.get(b531)!.body).toContain("should show no changes");
    expect(forge.prs.get(b531)!.title).toContain("~> 5.0 -> 5.3.1");

    // Wave 1 of the 5.3.1 rollout applies. The next step moves a2 to 5.3.1 and not b, which ran 5.4.0.
    forge.mergeAndApply(b531);
    const next = await continueRollouts(repo, { mode: "apply", forge: () => forge });
    const b531w2 = waveBranch(SRC, "5.3.1", 2, "~> 5.0");
    expect(next.rollouts.map((x) => x.action).sort()).toEqual(["ran", "waiting"]);
    expect(changed(b531w2)).toEqual(["a2/main.tf"]);
    expect(git(bare, "show", `${b531w2}:a2/main.tf`)).toContain(`version = "5.3.1"`);
    expect(git(bare, "show", `${b531w2}:b/main.tf`)).toContain(`version = "~> 5.0"`);
    expect(readFileSync(join(repo, "a1/main.tf"), "utf-8")).toContain("~> 5.0");
  }, 60_000);

  it("leaves reusable modules and a repository's control repository alone", async () => {
    const { repo } = estate();
    const r = await pinModules(repo, { tableOnly: true });
    expect(r.rows.some((x) => x.root.startsWith("modules"))).toBe(false);
    write(repo, { "terragucci.yml": "projects:\n  github.com/acme/infra: {}\n" });
    await expect(pinModules(repo, { tableOnly: true })).rejects.toThrow(/control repository/);
  });

  it("parses its arguments", () => {
    expect(pinModulesArgs(["modules"], { "dry-run": true, root: "envs" })).toMatchObject({ mode: "dry-run", tableOnly: true, root: "envs" });
    expect(pinModulesArgs(["modules"], { mode: "apply", "no-init": true })).toMatchObject({ mode: "apply", tableOnly: false, init: false });
    expect(() => pinModulesArgs(["bogus"], {})).toThrow(/usage/);
  });
});

const PROVIDERS = `terraform {
  required_providers {
    # the cloud
    aws = {
      source  = "hashicorp/aws" # registry
      version = "~> 5.0"
    }
    random = {
      source = "hashicorp/random"
    }
    null = "~> 3.0"
    tls = { source = "hashicorp/tls", version = ">= 4.0" }
    google = {
      source  = "hashicorp/google"
      version = "${"$"}{var.v}"
    }
  }
}
`;

describe("pinProviderRange", () => {
  it("rewrites a constraint inside required_providers and no other byte", async () => {
    const parser = await loadHclParser();
    const out = await pinProviderRange(PROVIDERS, "versions.tf", { provider: "registry.opentofu.org/hashicorp/aws", from: "~> 5.0", to: "5.31.0" }, parser);
    expect(out.calls).toEqual([{ call: "provider.aws", outcome: "moved" }]);
    expect(out.content).toBe(PROVIDERS.replace(`version = "~> 5.0"`, `version = "5.31.0"`));
  });
  it("moves the legacy string form and a one-line object", async () => {
    const parser = await loadHclParser();
    const legacy = await pinProviderRange(PROVIDERS, "versions.tf", { provider: "hashicorp/null", from: "~> 3.0", to: "3.2.2" }, parser);
    expect(legacy.content).toBe(PROVIDERS.replace(`null = "~> 3.0"`, `null = "3.2.2"`));
    const one = await pinProviderRange(PROVIDERS, "versions.tf", { provider: "hashicorp/tls", from: ">= 4.0", to: "4.0.6" }, parser);
    expect(one.content).toBe(PROVIDERS.replace(`version = ">= 4.0"`, `version = "4.0.6"`));
  });
  it("adds a version beside the source of an entry that has none, and refuses where there is no line for it", async () => {
    const parser = await loadHclParser();
    const added = await pinProviderRange(PROVIDERS, "versions.tf", { provider: "hashicorp/random", from: UNVERSIONED, to: "3.6.0" }, parser);
    expect(added.calls).toEqual([{ call: "provider.random", outcome: "moved" }]);
    expect(added.content).toBe(PROVIDERS.replace(`      source = "hashicorp/random"\n`, `      source = "hashicorp/random"\n      version = "3.6.0"\n`));
    const oneLine = `terraform {\n  required_providers {\n    tls = { source = "hashicorp/tls" }\n  }\n}\n`;
    const refused = await pinProviderRange(oneLine, "versions.tf", { provider: "hashicorp/tls", from: UNVERSIONED, to: "4.0.6" }, parser);
    expect(refused.calls[0]!.outcome).toBe("refused");
    expect(refused.content).toBe(oneLine);
  });
  it("leaves a version written as an expression alone", async () => {
    const parser = await loadHclParser();
    const out = await pinProviderRange(PROVIDERS, "versions.tf", { provider: "hashicorp/google", from: "${var.v}", to: "6.0.0" }, parser);
    expect(out.calls[0]!.outcome).toBe("refused");
    expect(out.content).toBe(PROVIDERS);
  });
  it("adds a version to a registry module call with none, beside its source", async () => {
    const parser = await loadHclParser();
    const text = `module "vpc" {\n  source = "${SRC}" # registry\n  name   = "x"\n}\nmodule "one" { source = "${SRC}" }\n`;
    const out = await pinRange(text, "main.tf", { module: SRC, from: UNVERSIONED, to: "2.0.0" }, parser);
    expect(out.calls.map((c) => [c.call, c.outcome]).sort()).toEqual([["module.one", "refused"], ["module.vpc", "moved"]]);
    const only = await pinRange(text.split("module \"one\"")[0]!, "main.tf", { module: SRC, from: UNVERSIONED, to: "2.0.0" }, parser);
    expect(only.content).toBe(`module "vpc" {\n  source = "${SRC}" # registry\n  version = "2.0.0"\n  name   = "x"\n}\n`);
  });
});

const LOCK = (address: string, version: string, constraints: string) => `provider "registry.opentofu.org/${address}" {\n  version     = "${version}"\n  constraints = "${constraints}"\n  hashes = [\n    "h1:abc",\n  ]\n}\n`;

describe("terragucci pin providers", () => {
  function providerEstate(): { repo: string; bare: string } {
    const dir = write(tmp(), {
      "p1/main.tf": backend("p1.tfstate"),
      "p1/versions.tf": PROVIDERS.replace('version = "${var.v}"', 'version = "6.1.0"'),
      "p2/main.tf": backend("p2.tfstate"),
      "p2/versions.tf": `terraform {\n  required_providers {\n    aws = {\n      source  = "hashicorp/aws"\n      version = "~> 5.0"\n    }\n  }\n}\n`,
    });
    const bare = bareFrom(dir);
    const repo = tmp();
    git(repo, "clone", "-q", bare, ".");
    write(repo, { "p1/.terraform.lock.hcl": LOCK("hashicorp/aws", "5.31.0", "~> 5.0") + LOCK("hashicorp/random", "3.6.0", "") + LOCK("hashicorp/null", "3.2.2", "~> 3.0") + LOCK("hashicorp/tls", "4.0.6", ">= 4.0") + LOCK("hashicorp/google", "6.1.0", "6.1.0") });
    write(repo, { "p2/.terraform.lock.hcl": LOCK("hashicorp/aws", "5.40.0", "~> 5.0") });
    return { repo, bare };
  }

  it("lists each entry with the version its lock file holds, and what it adds a version to", async () => {
    const { repo } = providerEstate();
    const r = await pinModules(repo, { kinds: ["provider"], tableOnly: true, init: false });
    expect(r.rows.map((x) => [x.root, x.call, x.range, x.version, x.state])).toEqual([
      ["p1", "provider.aws", "~> 5.0", "5.31.0", "pin"],
      ["p1", "provider.null", "~> 3.0", "3.2.2", "pin"],
      ["p1", "provider.random", UNVERSIONED, "3.6.0", "pin"],
      ["p1", "provider.tls", ">= 4.0", "4.0.6", "pin"],
      ["p2", "provider.aws", "~> 5.0", "5.40.0", "pin"],
    ]);
    expect(describePins(r)).toContain("module or provider");
  });

  it("opens a rollout per resolved version that rewrites only required_providers, and passes the check where a call cannot be edited", async () => {
    const { repo, bare } = providerEstate();
    const forge = new MemoryForge(bare);
    const r = await pinModules(repo, { kinds: ["provider"], mode: "apply", init: false, rollout: { forge: () => forge } });
    expect(r.rollouts.map((x) => [x.kind, x.name, x.from, x.to, x.status])).toEqual([
      ["provider", "hashicorp/aws", "~> 5.0", "5.31.0", "opened"],
      ["provider", "hashicorp/aws", "~> 5.0", "5.40.0", "opened"],
      ["provider", "hashicorp/null", "~> 3.0", "3.2.2", "opened"],
      ["provider", "hashicorp/random", UNVERSIONED, "3.6.0", "opened"],
      ["provider", "hashicorp/tls", ">= 4.0", "4.0.6", "opened"],
    ]);
    const b = waveBranch("hashicorp/aws", "5.31.0", 1, "~> 5.0");
    expect(git(bare, "diff", "--name-only", `main...${b}`).trim()).toBe("p1/versions.tf");
    expect(git(bare, "show", `${b}:p1/versions.tf`)).toBe(git(bare, "show", "main:p1/versions.tf").replace(`version = "~> 5.0"`, `version = "5.31.0"`));
    expect(forge.prs.get(b)!.body).toContain("should show no changes");
    expect(forge.prs.get(waveBranch("hashicorp/random", "3.6.0", 1, UNVERSIONED))!.body).toContain("declares no `version` here");
  }, 60_000);

  it("runs init for a root with no lock file, and takes the lookup for what init leaves", async () => {
    const { repo } = providerEstate();
    write(repo, { "p3/main.tf": backend("p3.tfstate"), "p3/versions.tf": `terraform {\n  required_providers {\n    aws = {\n      source  = "hashicorp/aws"\n      version = "~> 5.0"\n    }\n  }\n}\n` });
    const asked: string[] = [];
    let inits = 0;
    const r = await pinModules(repo, {
      kinds: ["provider"],
      tableOnly: true,
      runInit: () => void inits++,
      lookup: async (source, constraint, kind) => {
        asked.push(`${kind} ${source} ${constraint}`);
        return "5.99.0";
      },
    });
    expect(inits).toBe(1);
    expect(asked).toEqual(["provider hashicorp/aws ~> 5.0"]);
    const p3 = r.rows.find((x) => x.root === "p3")!;
    expect([p3.version, p3.from]).toEqual(["5.99.0", "lookup"]);
  });

  it("lists an entry it cannot add a version to as unpinned, with the reason, and leaves its root out of the rollout", async () => {
    const { repo } = providerEstate();
    write(repo, { "p4/main.tf": backend("p4.tfstate"), "p4/versions.tf": `terraform {\n  required_providers {\n    tls = { source = "hashicorp/tls" }\n  }\n}\n` });
    write(repo, { "p4/.terraform.lock.hcl": LOCK("hashicorp/tls", "4.0.6", "") });
    const r = await pinModules(repo, { kinds: ["provider"], tableOnly: true, init: false });
    const row = r.rows.find((x) => x.root === "p4")!;
    expect([row.state, row.version, row.reason]).toEqual(["unpinned", "4.0.6", expect.stringContaining("shares a line")]);
    expect(groupPins(r.rows).groups.some((g) => g.roots.includes("p4"))).toBe(false);
  });

  it("pins modules and providers together with --providers", () => {
    expect(pinModulesArgs(["modules"], { providers: true }).kinds).toEqual(["module", "provider"]);
    expect(pinModulesArgs(["providers"], {}).kinds).toEqual(["provider"]);
    expect(pinModulesArgs(["modules"], {}).kinds).toEqual(["module"]);
  });
});
