// terragucci#1282 part f: chant's forge check contract (chant#4608, called directly since the 0.124.58 pin), notify words (chant#4610;
// the relay is chant's own since #4611, ./relay.test.ts), ledger estate (chant#4612), shared policy source (chant#4613) and op-wave stand-down (chant#4581). Each
// case stands a module in for chant's, makes it missing, or runs only when the installed chant has it.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildLedgerEstate } from "@intentius/chant/ci-estate";
import { parseLedger, type ResolutionRecord } from "../src/apply";
import { newerCommitOnBranch } from "@intentius/chant/op";
import { wavesStepSpec, waveCallArgv } from "../src/chant-waves";
import { productWords, TERRAGUCCI_WORDS } from "../src/ci-words";
import { mergeLedgerEstate } from "../src/estate";
import { configIdentities, forgeCheckContract } from "../src/identities";
import { HEADER_PREFIX, NOTIFY_SOURCE } from "../src/notify";
import type { Estate } from "../src/report/estate";
import { ciPolicySource, fetchPolicySource } from "../src/report/policy";
import { gateSigners } from "./sshsig";
import { git, tmp, write } from "./helpers";


let restore: (() => void)[] = [];
afterEach(() => {
  for (const r of restore) r();
  restore = [];
});

describe("the notify slot", () => {
  it("keeps the source and header prefix terragucci's receivers filter and verify on", () => {
    expect(TERRAGUCCI_WORDS.notify).toEqual({ source: "terragucci", wave: "wave {k}", headers: "x-terragucci" });
    expect([NOTIFY_SOURCE, HEADER_PREFIX]).toEqual(["terragucci", "x-terragucci"]);
  });

  it("passes chant's words check", () => {
    expect(productWords().product).toBe("terragucci");
  });
});

// ── forge check ─────────────────────────────────────────────────────────

const FIXTURES = join(__dirname, "fixtures", "identities");
type Answer = { status: number; body: unknown };
const ok = (body: unknown): Answer => ({ status: 200, body });

const getRole = (name: string, policy: unknown): Answer =>
  ok(`<GetRoleResponse><GetRoleResult><Role><AssumeRolePolicyDocument>${encodeURIComponent(JSON.stringify(policy))}</AssumeRolePolicyDocument><RoleName>${name}</RoleName></Role></GetRoleResult></GetRoleResponse>`);

const GH = "https://api.github.com";

async function githubFixture(): Promise<{ dir: string; answers: Record<string, Answer> }> {
  const dir = tmp();
  cpSync(join(FIXTURES, "github-aws"), dir, { recursive: true });
  const c = await configIdentities(join(dir, "terragucci.yml"), "terragucci.yml", { repo: "acme/infra", defaultBranch: "main" });
  const roles: Record<string, Answer> = {};
  for (const e of c.environments) for (const st of Object.values(e.stages)) if (st?.aws?.role) roles[`role:${st.aws.role.split("/").pop()}`] = getRole(st.aws.role.split("/").pop()!, JSON.parse(st.aws.assume_role_policy));
  return {
    dir,
    answers: {
      [`${GH}/repos/acme/infra`]: ok({ id: 1, full_name: "acme/infra", default_branch: "main" }),
      [`${GH}/repos/acme/infra/environments/production`]: ok({ name: "production", deployment_branch_policy: { protected_branches: true } }),
      [`${GH}/repos/acme/infra/environments/dev`]: ok({ name: "dev", deployment_branch_policy: { protected_branches: true } }),
      [`${GH}/orgs/acme/actions/runner-groups?per_page=100`]: ok({ runner_groups: [{ name: "deployers", restricted_to_workflows: true, selected_workflows: ["acme/infra/.github/workflows/terragucci.yml@refs/heads/main"] }] }),
      ...roles,
    },
  };
}


describe("forge check", () => {
  it("maps each present stage onto a contract job, with no protected-branch rows asked on GitHub", async () => {
    const { dir } = await githubFixture();
    const c = await configIdentities(join(dir, "terragucci.yml"), "terragucci.yml", { repo: "acme/infra", defaultBranch: "main" });
    const contract = forgeCheckContract(c, {});
    expect(contract.forge).toBe("github");
    expect(contract.repository.defaultBranch).toBe("main");
    expect(contract.protectedBranches).toEqual([]);
    expect(contract.jobs.filter((j) => j.identity === "apply").every((j) => j.name.endsWith(" apply"))).toBe(true);
    expect(contract.jobs.some((j) => j.aws?.roles.length)).toBe(true);
  });

  it("asks the default branch and apply.branches to be protected off GitHub, and the apply variables on GitLab", async () => {
    const { dir } = await githubFixture();
    const c = await configIdentities(join(dir, "terragucci.yml"), "terragucci.yml", { repo: "acme/infra", defaultBranch: "main" });
    const gitlab = forgeCheckContract({ ...c, forge: "gitlab" }, { apply: { branches: { release: {} } } as never, pass: { secrets: ["DEPLOY_KEY"] } as never });
    expect(gitlab.protectedBranches).toEqual(["main", "release"]);
    expect(gitlab.gitlabVariables).toEqual(["DEPLOY_KEY"]);
  });
});

const T = (h: number): string => new Date(Date.UTC(2026, 0, 1, h)).toISOString();

// ── estate ──────────────────────────────────────────────────────────────

describe("ledger estate", () => {
  const page = (): Estate =>
    ({
      schema: "terragucci.estate/v1",
      generated: T(5),
      totals: { projects: 1, waiting: 0, drifted_projects: 0, drifted_roots: 0, failed_roots: 0, unreadable: 0, resources: 3 },
      projects: [{ project: "infra", status: "ok", waiting: [], drifted: 0, failed: 0, inventory: { resources: 3, types: [], roots: [] } }],
      recent: [],
    }) as unknown as Estate;

  it("puts the ledger's waves and overdue checks onto the bucket's project, keeping its own sections", () => {
    const p = page();
    mergeLedgerEstate(p, {
      estate: {
        schema: "terragucci.estate/v1",
        generated: T(5),
        source: "ledger",
        totals: { overdue: 1 },
        projects: [{ project: "infra", status: "ok", apply: { commit: "abc", waves: [{ project: "infra", commit: "abc", stage: "tf-apply", wave: 1, finished: T(4), roots: 1, refused: 0, approval: "waiting", status: "gated", run: "r1" }] }, waiting: [{ project: "infra", wave: 1, commit: "abc", since: T(4), age_seconds: 3600 }], drifted: 0, failed: 0, overdue: [{ op: "tf-drift" }] }],
        recent: [],
      },
      dora: { schema: "terragucci.dora/v1", generated: T(5), audit: true, source: "ledger", estate: { deployments: 0 }, projects: [] },
      overdue: [],
    } as unknown as Parameters<typeof mergeLedgerEstate>[1]);
    expect(p.source).toBe("ledger");
    expect(p.totals).toMatchObject({ waiting: 1, overdue: 1, resources: 3 });
    expect(p.projects[0]!.inventory?.resources).toBe(3);
    expect(p.projects[0]!.apply?.waves[0]).toMatchObject({ wave: 1, approval: "waiting", totals: { create: 0, update: 0, replace: 0, delete: 0 }, destroys: 0 });
    expect(p.projects[0]!.overdue).toHaveLength(1);
  });

  it("builds terragucci's schemas from an empty ledger, with no wave records to switch on", () => {
    const e = buildLedgerEstate({ load: { runs: [], gates: [], applies: [], pr_envs: [] }, words: productWords(), project: "infra", members: ["infra"] });
    expect([e.estate.schema, e.dora.schema, e.dora.audit]).toEqual(["terragucci.estate/v1", "terragucci.dora/v1", false]);
  });
});

// ── policy source ───────────────────────────────────────────────────────

describe("policy source", () => {
  it("maps git+<url>@<ref> and path onto ci.policy.source", () => {
    expect(ciPolicySource({ source: "git+https://git.example.com/acme/policy.git@v1.2.0", path: "./rego/" })).toEqual({ repo: "https://git.example.com/acme/policy.git", ref: "v1.2.0", path: "rego" });
    expect(ciPolicySource({ source: "git+file:///srv/policy@main" })).toEqual({ repo: "file:///srv/policy", ref: "main", path: "policy" });
    expect(ciPolicySource({})).toBeUndefined();
  });

  it("fetches a local source through chant into a temporary directory it removes", () => {
    const src = tmp();
    git(src, "init", "-q", "-b", "main");
    write(src, { "rego/deny.rego": "package main\ndeny[msg] { false; msg := \"x\" }\n" });
    git(src, "add", ".");
    git(src, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "rules");
    const commit = execFileSync("git", ["-C", src, "rev-parse", "HEAD"], { encoding: "utf-8" }).trim();
    const viaChant = fetchPolicySource({ source: `git+file://${src}@main`, path: "rego" }, "base");
    try {
      expect(viaChant.error).toBeUndefined();
      expect(viaChant.sourceCommit).toBe(commit);
      expect(readFileSync(join(viaChant.policy.path!, "deny.rego"), "utf-8")).toContain("package main");
    } finally {
      viaChant.cleanup();
    }
    expect(existsSync(viaChant.policy.path!)).toBe(false);
  });
});

// ── stand-down ──────────────────────────────────────────────────────────

describe("stand-down", () => {
  const input = { waves: [["network"]], gate: "always" as const, approval: "ledger" as const, call: waveCallArgv, migrations: false, standDown: true };



  it("asks chant to stand the wave down", () => {
    expect((wavesStepSpec(input) as unknown as Record<string, unknown>).standDown).toBe(true);
    expect((wavesStepSpec({ ...input, standDown: false }) as unknown as Record<string, unknown>).standDown).toBeUndefined();
  });

  it("exports the newer-commit lookup apply.ts uses", () => {
    expect(typeof newerCommitOnBranch).toBe("function");
  });
});
