// terragucci#1282 part f: the switches onto chant's forge check (chant#4608), notify words and relay (chant#4610,
// #4611), ledger estate (chant#4612), shared policy source (chant#4613) and op-wave stand-down (chant#4581). Each
// case stands a module in for chant's, makes it missing, or runs only when the installed chant has it.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseLedger, type ResolutionRecord } from "../src/apply";
import { chantCiEstate, chantForgeCheck, chantNotifyRelay, chantOpStandDown, chantPolicySource, overrideChantNext } from "../src/chant-next";
import { wavesStepSpec, waveCallArgv } from "../src/chant-waves";
import { productWords, TERRAGUCCI_WORDS } from "../src/ci-words";
import { mergeLedgerEstate } from "../src/estate";
import type { Fetch } from "../src/forge";
import { forgeCheck, forgeCheckContract, type CheckRow } from "../src/forge-check";
import { configIdentities } from "../src/identities";
import { HEADER_PREFIX, NOTIFY_SOURCE } from "../src/notify";
import { chantRelayDeps, type RelayDeps } from "../src/relay";
import type { Estate } from "../src/report/estate";
import { ciPolicySource, fetchPolicySource } from "../src/report/policy";
import { gateSigners } from "./sshsig";
import { git, tmp, write } from "./helpers";

const forgeChecker = await chantForgeCheck();
const relay = await chantNotifyRelay();
const ciEstate = await chantCiEstate();
const policySource = await chantPolicySource();
const standDown = await chantOpStandDown();

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

function recorded(answers: Record<string, Answer>): Fetch {
  return async (url, init) => {
    const role = /Action=GetRole&RoleName=([^&]+)/.exec(`${url}?${init?.body ?? ""}`)?.[1];
    const a = answers[role ? `role:${decodeURIComponent(role)}` : url] ?? { status: 404, body: { message: "Not Found" } };
    const text = typeof a.body === "string" ? a.body : JSON.stringify(a.body);
    return { ok: a.status >= 200 && a.status < 300, status: a.status, json: async () => JSON.parse(text), text: async () => text };
  };
}

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

const ENV = { GITHUB_TOKEN: "t", AWS_ACCESS_KEY_ID: "AKIAEXAMPLE", AWS_SECRET_ACCESS_KEY: "secret", AWS_SHARED_CREDENTIALS_FILE: "/nonexistent" };
const key = (r: CheckRow) => `${r.where} ${r.check} ${r.subject} ${r.status}`;

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

  it.runIf(forgeChecker)("gives the rows terragucci's own check gives, under terragucci's schema, with defaultBranch", async () => {
    const { dir, answers } = await githubFixture();
    const run = () => forgeCheck(join(dir, "terragucci.yml"), "terragucci.yml", { repo: "acme/infra" }, { fetch: recorded(answers), env: ENV, readFile: () => undefined });
    const viaChant = await run();
    restore.push(overrideChantNext("forgeCheck", null));
    const own = await run();
    expect(viaChant.schema).toBe("terragucci.forge-check/v1");
    expect((viaChant.repository as { defaultBranch?: string }).defaultBranch).toBe("main");
    expect(viaChant.rows.map(key).sort()).toEqual(own.rows.map(key).sort());
    expect(viaChant.ok).toBe(own.ok);
  });
});

// ── relay ───────────────────────────────────────────────────────────────

const KEY = "AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";
const SIGNERS = `alice@acme.com,slack:T1/U1 ssh-ed25519 ${KEY}\n`;
const D = "jcs1-sha256:" + "a".repeat(64);
const T = (h: number): string => new Date(Date.UTC(2026, 0, 1, h)).toISOString();
const pendingLine = (extra: object = {}) => JSON.stringify({ version: 1, kind: "pending", op: "tf-apply", gate: "wave-1", timestamp: T(1), expiresAt: T(49), planDigest: D, ...extra }) + "\n";

function relayDeps(o: { mode?: "ledger" | "sealed"; question?: boolean } = {}): RelayDeps & { recorded: ResolutionRecord[]; answered: string[] } {
  const recorded: ResolutionRecord[] = [];
  const answered: string[] = [];
  return {
    recorded,
    answered,
    principal: "terragucci-relay",
    rule: async () => ({ mode: o.mode ?? "ledger", signers: gateSigners(SIGNERS), signersPath: ".chant/allowed_signers" }),
    ledger: () => parseLedger(pendingLine(o.question ? { answer: { id: "q-1" } } : {})),
    record: (r) => void recorded.push(r),
    answer: async (id) => {
      answered.push(id);
      return { answered: true };
    },
    now: () => new Date(T(5)),
  };
}

describe("relay deps for chant's buttons", () => {
  const words = TERRAGUCCI_WORDS as never;

  it("names the waiting wave for its digest, and records the approval as terragucci's own relay does", async () => {
    const deps = relayDeps();
    const d = chantRelayDeps(deps, "slack", words);
    expect(await d.pending(D)).toEqual([{ op: "tf-apply", gate: "wave-1", digest: D }]);
    expect((await d.signers()).path).toBe(".chant/allowed_signers");
    expect(await d.approve({ op: "tf-apply", gate: "wave-1", digest: D, actor: "alice@acme.com", relayedBy: "terragucci-relay" })).toEqual({ ok: true });
    expect(deps.recorded[0]).toMatchObject({ gate: "wave-1", resolvedBy: "alice@acme.com", relayedBy: "terragucci-relay", planDigest: D, via: "slack" });
  });

  it("answers a decision point's question, which chant's relay would refuse", async () => {
    const deps = relayDeps({ question: true });
    expect(await chantRelayDeps(deps, "teams", words).approve({ op: "tf-apply", gate: "wave-1", digest: D, actor: "alice@acme.com", relayedBy: "terragucci-relay" })).toEqual({ ok: true });
    expect(deps.answered).toEqual(["q-1"]);
    expect(deps.recorded).toEqual([]);
  });

  it("refuses under sealed approval", async () => {
    const r = await chantRelayDeps(relayDeps({ mode: "sealed" }), "slack", words).approve({ op: "tf-apply", gate: "wave-1", digest: D, actor: "alice@acme.com", relayedBy: "terragucci-relay" });
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/sealed/) });
  });

  it.runIf(relay)("maps a chat user to the same principal as terragucci's own mapping", () => {
    expect(relay!.relayPrincipalFor(gateSigners(SIGNERS).signers, "slack:T1/U1")).toBe("alice@acme.com");
  });
});

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
    });
    expect(p.source).toBe("ledger");
    expect(p.totals).toMatchObject({ waiting: 1, overdue: 1, resources: 3 });
    expect(p.projects[0]!.inventory?.resources).toBe(3);
    expect(p.projects[0]!.apply?.waves[0]).toMatchObject({ wave: 1, approval: "waiting", totals: { create: 0, update: 0, replace: 0, delete: 0 }, destroys: 0 });
    expect(p.projects[0]!.overdue).toHaveLength(1);
  });

  it.runIf(ciEstate)("builds terragucci's schemas from an empty ledger, with no wave records to switch on", () => {
    const e = ciEstate!.buildLedgerEstate({ load: { runs: [], gates: [], applies: [], pr_envs: [] }, words: productWords(), project: "infra", members: ["infra"] });
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

  it.runIf(policySource)("fetches a local source through chant into the same shape as terragucci's own fetch", () => {
    const src = tmp();
    git(src, "init", "-q", "-b", "main");
    write(src, { "rego/deny.rego": "package main\ndeny[msg] { false; msg := \"x\" }\n" });
    git(src, "add", ".");
    git(src, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "rules");
    const commit = execFileSync("git", ["-C", src, "rev-parse", "HEAD"], { encoding: "utf-8" }).trim();
    const policy = { source: `git+file://${src}@main`, path: "rego" };
    const viaChant = fetchPolicySource(policy, "base");
    restore.push(overrideChantNext("policySource", null));
    const own = fetchPolicySource(policy, "base");
    try {
      expect(viaChant.error).toBeUndefined();
      expect(viaChant.sourceCommit).toBe(commit);
      expect(own.sourceCommit).toBe(commit);
      expect(readFileSync(join(viaChant.policy.path!, "deny.rego"), "utf-8")).toBe(readFileSync(join(own.policy.path!, "deny.rego"), "utf-8"));
    } finally {
      viaChant.cleanup();
      own.cleanup();
    }
    expect(existsSync(viaChant.policy.path!)).toBe(false);
  });
});

// ── stand-down ──────────────────────────────────────────────────────────

describe("stand-down", () => {
  const input = { waves: [["network"]], gate: "always" as const, approval: "ledger" as const, call: waveCallArgv, migrations: false, standDown: true };

  it("leaves the step spec without standDown on a chant without chant's stand-down", () => {
    restore.push(overrideChantNext("opStandDown", null));
    expect((wavesStepSpec(input) as unknown as Record<string, unknown>).standDown).toBeUndefined();
  });

  it("asks chant to stand the wave down when chant has it", () => {
    restore.push(overrideChantNext("opStandDown", { newerCommitOnBranch: async () => undefined, tipAppliesTargets: () => false, OP_WAVE_STAND_DOWN_FLOOR: "next" }));
    expect((wavesStepSpec(input) as unknown as Record<string, unknown>).standDown).toBe(true);
    expect((wavesStepSpec({ ...input, standDown: false }) as unknown as Record<string, unknown>).standDown).toBeUndefined();
  });

  it.runIf(standDown)("exports the newer-commit lookup apply.ts uses", () => {
    expect(typeof standDown!.newerCommitOnBranch).toBe("function");
  });
});
