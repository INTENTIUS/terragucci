import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli";
import type { Fetch } from "../src/forge";
import { assertReadOnly, celNarrowerOrEqual, compareTrust, forgeCheck, readOnly, ReadOnlyError, trustJobs, type CheckRow, type ForgeCheckDeps } from "../src/forge-check";
import { configIdentities } from "../src/identities";
import { tmp } from "./helpers";

const FIXTURES = join(__dirname, "fixtures", "identities");
/** The provider's goldens for terragucci_forge_check, written from this file's --json runs. */
const GOLDENS = join(__dirname, "..", "..", "..", "terraform-provider-terragucci", "internal", "provider", "testdata", "forge-check");

function fixture(name: string): string {
  const dir = tmp();
  cpSync(join(FIXTURES, name), dir, { recursive: true });
  return dir;
}

type Answer = { status: number; body: unknown };
const ok = (body: unknown): Answer => ({ status: 200, body });
const status = (n: number, body: unknown = { message: "nope" }): Answer => ({ status: n, body });

/** A fetch answering from `answers` by URL (a GetRole by its role name), recording each call's method and URL. */
function recorded(answers: Record<string, Answer>): { fetch: Fetch; calls: string[] } {
  const calls: string[] = [];
  const fetch: Fetch = async (url, init) => {
    calls.push(`${init?.method ?? "GET"} ${url}${init?.body ? ` ${init.body}` : ""}`);
    const role = /Action=GetRole&RoleName=([^&]+)/.exec(`${url}?${init?.body ?? ""}`)?.[1];
    const a = answers[role ? `role:${decodeURIComponent(role)}` : url] ?? status(404, { message: "Not Found" });
    const text = typeof a.body === "string" ? a.body : JSON.stringify(a.body);
    return { ok: a.status >= 200 && a.status < 300, status: a.status, json: async () => JSON.parse(text), text: async () => text };
  };
  return { fetch, calls };
}

/** GetRole's answer, as IAM's Query API sends it: the trust policy URL-encoded. */
const getRole = (name: string, policy: unknown): Answer =>
  ok(`<GetRoleResponse xmlns="https://iam.amazonaws.com/doc/2010-05-08/"><GetRoleResult><Role><Path>/</Path><AssumeRolePolicyDocument>${encodeURIComponent(typeof policy === "string" ? policy : JSON.stringify(policy))}</AssumeRolePolicyDocument><RoleName>${name}</RoleName></Role></GetRoleResult></GetRoleResponse>`);
const iamError = (n: number, code: string): Answer => status(n, `<ErrorResponse><Error><Type>Sender</Type><Code>${code}</Code><Message>${code}</Message></Error></ErrorResponse>`);

const AWS_ENV = { AWS_ACCESS_KEY_ID: "AKIAEXAMPLE", AWS_SECRET_ACCESS_KEY: "secret", AWS_SHARED_CREDENTIALS_FILE: "/nonexistent" };
const NO_AWS = { AWS_SHARED_CREDENTIALS_FILE: "/nonexistent", HOME: "/nonexistent" };

const deps = (fetch: Fetch, env: NodeJS.ProcessEnv): ForgeCheckDeps => ({ fetch, env, readFile: () => undefined });
const row = (rows: CheckRow[], where: string, check: string, subject: string): CheckRow => {
  const r = rows.find((x) => x.where === where && x.check === check && x.subject === subject);
  if (!r) throw new Error(`no row ${where} ${check} ${subject} in ${JSON.stringify(rows, null, 2)}`);
  return r;
};

/** Each role's trust policy in the contract, by role name: what a matching setup holds. */
async function contractPolicies(dir: string, flags: Parameters<typeof configIdentities>[2]): Promise<Record<string, unknown>> {
  const c = await configIdentities(join(dir, "terragucci.yml"), "terragucci.yml", flags);
  const out: Record<string, unknown> = {};
  for (const e of c.environments) {
    for (const st of Object.values(e.stages)) {
      if (!st?.aws?.role) continue;
      out[st.aws.role.split("/").pop()!] = JSON.parse(st.aws.assume_role_policy);
    }
  }
  return out;
}

const GH = "https://api.github.com";

/** github-aws, every setting as the contract wants it. */
async function githubSetup(dir: string): Promise<Record<string, Answer>> {
  const policies = await contractPolicies(dir, { repo: "acme/infra", defaultBranch: "main" });
  return {
    [`${GH}/repos/acme/infra`]: ok({ id: 1, full_name: "acme/infra", default_branch: "main" }),
    [`${GH}/repos/acme/infra/environments/production`]: ok({ name: "production", deployment_branch_policy: { protected_branches: true, custom_branch_policies: false } }),
    [`${GH}/repos/acme/infra/environments/dev`]: ok({ name: "dev", deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } }),
    [`${GH}/repos/acme/infra/environments/dev/deployment-branch-policies?per_page=100`]: ok({ total_count: 1, branch_policies: [{ id: 1, node_id: "x", name: "main", type: "branch" }] }),
    [`${GH}/orgs/acme/actions/runner-groups?per_page=100`]: ok({ total_count: 2, runner_groups: [{ id: 1, name: "Default", visibility: "all", restricted_to_workflows: false, selected_workflows: [] }, { id: 2, name: "deployers", visibility: "selected", restricted_to_workflows: true, selected_workflows: ["acme/infra/.github/workflows/terragucci.yml@refs/heads/main"] }] }),
    ...Object.fromEntries(Object.entries(policies).map(([name, p]) => [`role:${name}`, getRole(name, p)])),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("read-only", () => {
  it("lets GET and HEAD through and refuses every other method", () => {
    expect(() => assertReadOnly("https://api.github.com/repos/a/b", "GET")).not.toThrow();
    expect(() => assertReadOnly("https://api.github.com/repos/a/b", "HEAD")).not.toThrow();
    for (const m of ["PUT", "PATCH", "DELETE", "POST"]) expect(() => assertReadOnly("https://api.github.com/repos/a/b/environments/prod", m, "{}")).toThrow(ReadOnlyError);
  });

  it("allows an AWS Query action only when it is a named read, as GET or POST", () => {
    expect(() => assertReadOnly("https://iam.amazonaws.com/?Action=GetRole&RoleName=x&Version=2010-05-08", "GET")).not.toThrow();
    expect(() => assertReadOnly("https://iam.amazonaws.com/", "POST", "Action=GetRole&RoleName=x&Version=2010-05-08")).not.toThrow();
    expect(() => assertReadOnly("https://iam.amazonaws.com/?Action=UpdateAssumeRolePolicy&RoleName=x", "GET")).toThrow(ReadOnlyError);
    expect(() => assertReadOnly("https://iam.amazonaws.com/", "POST", "Action=UpdateAssumeRolePolicy&RoleName=x&PolicyDocument=%7B%7D")).toThrow(ReadOnlyError);
    expect(() => assertReadOnly("https://iam.amazonaws.com/?Action=DeleteRole", "POST", "Action=GetRole")).toThrow(ReadOnlyError);
    expect(() => assertReadOnly("https://api.github.com/graphql", "POST", JSON.stringify({ query: "mutation" }))).toThrow(ReadOnlyError);
  });

  it("never sends a refused request", async () => {
    const inner = vi.fn<Fetch>();
    await expect(readOnly(inner)("https://gitlab.com/api/v4/projects/1/variables", { method: "POST", body: "{}" })).rejects.toThrow(ReadOnlyError);
    expect(inner).not.toHaveBeenCalled();
  });

  it("checks a whole setup with GET requests to the forge and a GetRole form POST to IAM alone", async () => {
    const dir = fixture("github-aws");
    const { fetch, calls } = recorded(await githubSetup(dir));
    await forgeCheck(join(dir, "terragucci.yml"), "terragucci.yml", { repo: "acme/infra" }, deps(fetch, { GITHUB_TOKEN: "t", ...AWS_ENV }));
    expect(calls.length).toBeGreaterThan(5);
    expect(calls.some((c) => c.startsWith("POST "))).toBe(true);
    expect(calls.every((c) => c.startsWith("GET ") || /^POST https:\/\/iam\.amazonaws\.com\/ Action=GetRole&RoleName=[^&]+&Version=2010-05-08$/.test(c))).toBe(true);
  });
});

describe("forge check on GitHub and AWS", () => {
  const run = async (dir: string, answers: Record<string, Answer>, env: NodeJS.ProcessEnv, flags = {}) =>
    forgeCheck(join(dir, "terragucci.yml"), "terragucci.yml", { repo: "acme/infra", ...flags }, deps(recorded(answers).fetch, env));

  it("matches a setup that is as the contract says, and exits 0", async () => {
    const dir = fixture("github-aws");
    const r = await run(dir, await githubSetup(dir), { GITHUB_TOKEN: "t", ...AWS_ENV });
    expect(r.rows.filter((x) => x.status !== "match")).toEqual([]);
    expect(r.ok).toBe(true);
    expect(row(r.rows, "github", "environment", "production").found).toBe("exists");
    expect(row(r.rows, "github", "deployment-branches", "production").found).toBe("protected branches");
    expect(row(r.rows, "github", "deployment-branches", "dev").found).toBe("custom: main");
    expect(row(r.rows, "github", "runner-group", "deployers").status).toBe("match");
    expect(row(r.rows, "aws", "trust", "arn:aws:iam::222222222222:role/prod-apply").expected).toBe("sub repo:acme/infra:environment:production aud terragucci-prod-apply");
    expect(r.rows.filter((x) => x.where === "aws")).toHaveLength(6);
  });

  it("reports a missing environment, a branch rule wider than the default branch and a runner group open to every workflow", async () => {
    const dir = fixture("github-aws");
    const a = await githubSetup(dir);
    a[`${GH}/repos/acme/infra/environments/production`] = status(404, { message: "Not Found" });
    a[`${GH}/repos/acme/infra/environments/dev/deployment-branch-policies?per_page=100`] = ok({ total_count: 2, branch_policies: [{ name: "main", type: "branch" }, { name: "feature/*", type: "branch" }] });
    a[`${GH}/orgs/acme/actions/runner-groups?per_page=100`] = ok({ runner_groups: [{ name: "deployers", visibility: "all", restricted_to_workflows: false, selected_workflows: [] }] });
    const r = await run(dir, a, { GITHUB_TOKEN: "t", ...AWS_ENV });
    expect(row(r.rows, "github", "environment", "production")).toMatchObject({ expected: "exists", found: "missing", status: "mismatch" });
    expect(row(r.rows, "github", "deployment-branches", "dev")).toMatchObject({ expected: "deploys from main only", found: "custom: main, feature/*", status: "mismatch" });
    expect(row(r.rows, "github", "runner-group", "deployers")).toMatchObject({ found: "every workflow", status: "mismatch" });
    expect(r.ok).toBe(false);
  });

  it("reports an environment with no deployment branch rule", async () => {
    const dir = fixture("github-aws");
    const a = await githubSetup(dir);
    a[`${GH}/repos/acme/infra/environments/dev`] = ok({ name: "dev", deployment_branch_policy: null });
    const r = await run(dir, a, { GITHUB_TOKEN: "t", ...AWS_ENV });
    expect(row(r.rows, "github", "deployment-branches", "dev")).toMatchObject({ found: "any branch: no deployment branch rule", status: "mismatch" });
  });

  it("says what scope it needs when the org's runner groups answer 403, and does not fail on that alone", async () => {
    const dir = fixture("github-aws");
    const a = await githubSetup(dir);
    a[`${GH}/orgs/acme/actions/runner-groups?per_page=100`] = status(403, { message: "Resource not accessible by personal access token" });
    const r = await run(dir, a, { GITHUB_TOKEN: "t", ...AWS_ENV });
    const g = row(r.rows, "github", "runner-group", "deployers");
    expect(g.status).toBe("unknown");
    expect(g.found).toContain("could not read (403)");
    expect(g.found).toContain("Self-hosted runners: read");
    expect(r.ok).toBe(true);
  });

  it("calls a trust wider than the contract's a mismatch: a wildcard subject, a missing aud condition, another provider", async () => {
    const dir = fixture("github-aws");
    const a = await githubSetup(dir);
    const key = "token.actions.githubusercontent.com";
    const fed = `arn:aws:iam::222222222222:oidc-provider/${key}`;
    const wide = (cond: Record<string, Record<string, string>>, principal = fed) => ({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Federated: principal }, Action: "sts:AssumeRoleWithWebIdentity", Condition: cond }] });
    a["role:prod-apply"] = getRole("prod-apply", wide({ StringEquals: { [`${key}:aud`]: "terragucci-prod-apply" }, StringLike: { [`${key}:sub`]: "repo:acme/infra:*" } }));
    a["role:prod-plan"] = getRole("prod-plan", wide({ StringLike: { [`${key}:sub`]: "repo:acme/infra:pull_request" } }));
    const r = await run(dir, a, { GITHUB_TOKEN: "t", ...AWS_ENV });
    const apply = row(r.rows, "aws", "trust", "arn:aws:iam::222222222222:role/prod-apply");
    expect(apply.status).toBe("mismatch");
    expect(apply.found).toContain("admits sub repo:acme/infra:* (like) with aud terragucci-prod-apply, which no job of this role presents");
    const plan = row(r.rows, "aws", "trust", "arn:aws:iam::222222222222:role/prod-plan");
    expect(plan.status).toBe("mismatch");
    expect(plan.found).toContain("has no aud condition");
    expect(plan.found).toContain("does not admit sub repo:acme/infra:ref:refs/heads/main aud terragucci-plan");
  });

  it("reports a role that is gone, and one it may not read", async () => {
    const dir = fixture("github-aws");
    const a = await githubSetup(dir);
    a["role:dev-apply"] = iamError(404, "NoSuchEntity");
    a["role:dev-plan"] = iamError(403, "AccessDenied");
    const r = await run(dir, a, { GITHUB_TOKEN: "t", ...AWS_ENV });
    expect(row(r.rows, "aws", "trust", "arn:aws:iam::333333333333:role/dev-apply")).toMatchObject({ found: "no such role", status: "mismatch" });
    const denied = row(r.rows, "aws", "trust", "arn:aws:iam::333333333333:role/dev-plan");
    expect(denied.status).toBe("unknown");
    expect(denied.found).toContain("iam:GetRole");
  });

  it("leaves AWS not checked without credentials, which fails only with --require-clouds", async () => {
    const dir = fixture("github-aws");
    const a = await githubSetup(dir);
    const r = await run(dir, a, { GITHUB_TOKEN: "t", ...NO_AWS });
    expect(r.rows.filter((x) => x.where === "aws").every((x) => x.status === "not-checked")).toBe(true);
    expect(r.ok).toBe(true);
    const strict = await run(dir, a, { GITHUB_TOKEN: "t", ...NO_AWS }, { requireClouds: true });
    expect(strict.ok).toBe(false);
  });

  it("reads static keys from the shared credentials file's profile", async () => {
    const dir = fixture("github-aws");
    const { fetch, calls } = recorded(await githubSetup(dir));
    const file = "[default]\naws_access_key_id = A\n[ci]\naws_access_key_id = AKIACI\naws_secret_access_key = s\n";
    const r = await forgeCheck(join(dir, "terragucci.yml"), "terragucci.yml", { repo: "acme/infra" }, { fetch, env: { GITHUB_TOKEN: "t", AWS_PROFILE: "ci" }, readFile: () => file });
    expect(r.rows.filter((x) => x.where === "aws").every((x) => x.status === "match")).toBe(true);
    expect(calls.some((c) => c.includes("Action=GetRole"))).toBe(true);
  });

  it("reports the repository as unreadable, and nothing more of the forge, when the token cannot read it", async () => {
    const dir = fixture("github-aws");
    const r = await run(dir, { [`${GH}/repos/acme/infra`]: status(404) }, { ...NO_AWS });
    const f = r.rows.filter((x) => x.where === "github");
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ check: "repository", status: "unknown" });
    expect(f[0]!.found).toContain("GITHUB_TOKEN");
  });
});

describe("forge check on GitLab and GCP", () => {
  const GL = "https://gitlab.example.com/api/v4/projects/acme%2Fplatform%2Finfra";
  const PROVIDER = "projects/123456789/locations/global/workloadIdentityPools/terragucci/providers/gitlab";
  const config = (dir: string): string => {
    const yml = readFileSync(join(dir, "terragucci.yml"), "utf-8");
    writeFileSync(join(dir, "terragucci.yml"), `${yml}pass:\n  secrets: [DEPLOY_KEY]\nnotify:\n  slack: SLACK_HOOK\n`);
    return dir;
  };
  const condition = async (dir: string): Promise<string> => {
    const c = await configIdentities(join(dir, "terragucci.yml"), "terragucci.yml", { repo: "acme/platform/infra", defaultBranch: "trunk" });
    const all = [...new Set(c.environments.flatMap((e) => Object.values(e.stages).flatMap((s) => (s?.gcp ? [s.gcp.attribute_condition] : []))))];
    return all.map((x) => `(${x})`).join(" || ");
  };
  const setup = async (dir: string): Promise<Record<string, Answer>> => ({
    [GL]: ok({ id: 9, path_with_namespace: "acme/platform/infra", default_branch: "trunk" }),
    [`${GL}/protected_environments?per_page=100`]: ok([{ name: "production", deploy_access_levels: [{ access_level: 40 }] }, { name: "staging", deploy_access_levels: [] }]),
    [`${GL}/runners?tag_list=docker%2Cprod&per_page=100`]: ok([{ id: 11, description: "prod runner" }]),
    [`${GL}/runners?tag_list=docker%2Clinux&per_page=100`]: ok([{ id: 12, description: "shared" }]),
    ["https://gitlab.example.com/api/v4/runners/11"]: ok({ id: 11, access_level: "ref_protected" }),
    ["https://gitlab.example.com/api/v4/runners/12"]: ok({ id: 12, access_level: "ref_protected" }),
    [`${GL}/variables?per_page=100&page=1`]: ok([
      { key: "DEPLOY_KEY", protected: true, environment_scope: "production" },
      { key: "DEPLOY_KEY", protected: true, environment_scope: "staging" },
      { key: "DEPLOY_KEY", protected: false, environment_scope: "*" },
      { key: "SLACK_HOOK", protected: true, environment_scope: "production" },
      { key: "SLACK_HOOK", protected: true, environment_scope: "staging" },
    ]),
    [`https://iam.googleapis.com/v1/${PROVIDER}`]: ok({ name: PROVIDER, state: "ACTIVE", attributeCondition: await condition(dir), oidc: { issuerUri: "https://gitlab.example.com" } }),
  });
  const run = (dir: string, a: Record<string, Answer>, env: NodeJS.ProcessEnv = { GITLAB_TOKEN: "t", GOOGLE_OAUTH_ACCESS_TOKEN: "g" }) =>
    forgeCheck(join(dir, "terragucci.yml"), "terragucci.yml", { repo: "acme/platform/infra" }, deps(recorded(a).fetch, env));

  it("matches protected environments, protected runners, scoped variables and the provider's condition", async () => {
    const dir = config(fixture("gitlab-gcp"));
    const r = await run(dir, await setup(dir));
    expect(r.rows.filter((x) => x.status !== "match")).toEqual([]);
    expect(row(r.rows, "gitlab", "protected-runners", "tags docker, prod").found).toBe("1 runner(s), each ref_protected");
    expect(row(r.rows, "gitlab", "variable", "DEPLOY_KEY in production")).toMatchObject({ expected: "scoped to production, protected", status: "match" });
    expect(r.repository.default_branch).toBe("trunk");
  });

  it("reports an unprotected environment, a runner open to any ref, and a variable scoped to every environment", async () => {
    const dir = config(fixture("gitlab-gcp"));
    const a = await setup(dir);
    a[`${GL}/protected_environments?per_page=100`] = ok([{ name: "production" }]);
    a["https://gitlab.example.com/api/v4/runners/11"] = ok({ id: 11, access_level: "not_protected" });
    a[`${GL}/variables?per_page=100&page=1`] = ok([{ key: "DEPLOY_KEY", protected: false, environment_scope: "*" }, { key: "SLACK_HOOK", protected: false, environment_scope: "production" }]);
    const r = await run(dir, a);
    expect(row(r.rows, "gitlab", "protected-environment", "staging")).toMatchObject({ found: "not protected", status: "mismatch" });
    expect(row(r.rows, "gitlab", "protected-runners", "tags docker, prod")).toMatchObject({ found: "#11 (prod runner) not_protected", status: "mismatch" });
    expect(row(r.rows, "gitlab", "variable", "DEPLOY_KEY in production")).toMatchObject({ found: "scope *, not protected", status: "mismatch" });
    expect(row(r.rows, "gitlab", "variable", "SLACK_HOOK in production")).toMatchObject({ found: "scope production, not protected", status: "mismatch" });
    expect(r.ok).toBe(false);
  });

  it("calls protected environments unknown on an edition without them, and does not fail on that alone", async () => {
    const dir = config(fixture("gitlab-gcp"));
    const a = await setup(dir);
    a[`${GL}/protected_environments?per_page=100`] = status(404, { message: "404 Not Found" });
    const r = await run(dir, a);
    const p = row(r.rows, "gitlab", "protected-environment", "production");
    expect(p.status).toBe("unknown");
    expect(p.found).toContain("GitLab Premium");
    expect(r.ok).toBe(true);
  });

  it("accepts a narrower condition and refuses a wider one", async () => {
    const dir = config(fixture("gitlab-gcp"));
    const a = await setup(dir);
    const exact = await condition(dir);
    a[`https://iam.googleapis.com/v1/${PROVIDER}`] = ok({ attributeCondition: `(${exact}) && assertion.namespace_path == 'acme'` });
    const narrower = await run(dir, a);
    expect(row(narrower.rows, "gcp", "trust", PROVIDER)).toMatchObject({ status: "match" });
    expect(row(narrower.rows, "gcp", "trust", PROVIDER).found).toContain("(narrower)");
    a[`https://iam.googleapis.com/v1/${PROVIDER}`] = ok({ attributeCondition: "assertion.sub.startsWith('project_path:acme/')" });
    const wider = await run(dir, a);
    expect(row(wider.rows, "gcp", "trust", PROVIDER)).toMatchObject({ status: "mismatch" });
    a[`https://iam.googleapis.com/v1/${PROVIDER}`] = ok({});
    expect(row((await run(dir, a)).rows, "gcp", "trust", PROVIDER)).toMatchObject({ found: "no attribute condition: any token of the issuer", status: "mismatch" });
    a[`https://iam.googleapis.com/v1/${PROVIDER}`] = status(403);
    const denied = row((await run(dir, a)).rows, "gcp", "trust", PROVIDER);
    expect(denied.status).toBe("unknown");
    expect(denied.found).toContain("iam.workloadIdentityPoolProviders.get");
  });

  it("leaves GCP not checked without a token", async () => {
    const dir = config(fixture("gitlab-gcp"));
    const r = await run(dir, await setup(dir), { GITLAB_TOKEN: "t" });
    expect(row(r.rows, "gcp", "trust", PROVIDER).status).toBe("not-checked");
  });
});

describe("forge check on Forgejo", () => {
  const FJ = "https://git.example.com/api/v1/repos/acme/infra";
  it("checks the default branch and each apply.branches branch is protected, and takes the token's ids from the repository", async () => {
    const dir = fixture("forgejo-aws");
    const yml = readFileSync(join(dir, "terragucci.yml"), "utf-8").replace('  dev:\n    roots: ["envs/dev/**"]\n', '  dev:\n    roots: ["envs/dev/**"]\napply:\n  branches:\n    release: ["envs/prod/**"]\n');
    writeFileSync(join(dir, "terragucci.yml"), yml);
    const answers: Record<string, Answer> = {
      [FJ]: ok({ id: 17, owner: { id: 3, login: "acme" }, default_branch: "main" }),
      [`${FJ}/branch_protections`]: ok([{ rule_name: "main", branch_name: "main" }]),
    };
    const r = await forgeCheck(join(dir, "terragucci.yml"), "terragucci.yml", { repo: "acme/infra" }, deps(recorded(answers).fetch, { FORGEJO_TOKEN: "t", ...AWS_ENV }));
    expect(row(r.rows, "forgejo", "protected-branch", "main")).toMatchObject({ found: "protected by rule main", status: "match" });
    expect(row(r.rows, "forgejo", "protected-branch", "release")).toMatchObject({ found: "not protected", status: "mismatch" });
    expect(row(r.rows, "aws", "trust", "arn:aws:iam::444444444444:role/prod-apply").expected).toContain("repo:acme-3/infra-17:ref:refs/heads/main");
  });

  it("names the scope when branch protections cannot be read", async () => {
    const dir = fixture("forgejo-aws");
    const answers: Record<string, Answer> = { [FJ]: ok({ id: 17, owner: { id: 3 }, default_branch: "main" }), [`${FJ}/branch_protections`]: status(403) };
    const r = await forgeCheck(join(dir, "terragucci.yml"), "terragucci.yml", { repo: "acme/infra" }, deps(recorded(answers).fetch, { ...NO_AWS }));
    expect(row(r.rows, "forgejo", "protected-branch", "main").found).toContain("read:repository");
  });
});

describe("forge check on Azure", () => {
  const graph = (id: string) => `https://graph.microsoft.com/v1.0/applications(appId='${id}')/federatedIdentityCredentials`;
  const credentials = async (dir: string) => {
    const c = await configIdentities(join(dir, "terragucci.yml"), "terragucci.yml", { repo: "acme/infra", defaultBranch: "main" });
    const by: Record<string, unknown[]> = {};
    for (const e of c.environments) {
      for (const s of Object.values(e.stages)) {
        if (!s?.azure) continue;
        (by[s.azure.client_id] ??= []).push({ name: `c${(by[s.azure.client_id] ?? []).length}`, issuer: s.azure.issuer, subject: s.azure.subject, audiences: s.azure.audiences });
      }
    }
    // One credential per distinct subject.
    return Object.fromEntries(Object.entries(by).map(([id, cs]) => [graph(id), ok({ value: cs.filter((x, i) => cs.findIndex((y) => JSON.stringify({ ...(y as object), name: "" }) === JSON.stringify({ ...(x as object), name: "" })) === i) })]));
  };
  const run = async (dir: string, a: Record<string, Answer>) =>
    forgeCheck(join(dir, "terragucci.yml"), "terragucci.yml", { repo: "acme/infra" }, deps(recorded({ "https://api.github.com/repos/acme/infra": ok({ default_branch: "main" }), ...a }).fetch, { AZURE_GRAPH_TOKEN: "z" }));

  it("matches each app's federated credentials, and reports one wider and one missing", async () => {
    const dir = fixture("azure");
    const a = await credentials(dir);
    const good = await run(dir, a);
    expect(good.rows.filter((x) => x.where === "azure" && x.status !== "match")).toEqual([]);
    const prodApply = "00000000-0000-0000-0000-0000000000b2";
    a[graph(prodApply)] = ok({ value: [{ name: "any-branch", issuer: "https://token.actions.githubusercontent.com", subject: "repo:acme/infra:ref:refs/heads/feature", audiences: ["api://AzureADTokenExchangeUSGov"] }] });
    const bad = row((await run(dir, a)).rows, "azure", "trust", prodApply);
    expect(bad.status).toBe("mismatch");
    expect(bad.found).toContain("missing issuer https://token.actions.githubusercontent.com subject repo:acme/infra:environment:prod");
    expect(bad.found).toContain("wider: any-branch: issuer https://token.actions.githubusercontent.com subject repo:acme/infra:ref:refs/heads/feature");
    a[graph(prodApply)] = status(403);
    expect(row((await run(dir, a)).rows, "azure", "trust", prodApply).found).toContain("Application.Read.All");
  });
});

describe("conditions and trust, in parts", () => {
  it("compares CEL conditions as terms of conjuncts", () => {
    expect(celNarrowerOrEqual("a == 'x' && b == 'y'", "a == 'x'")).toBe(true);
    expect(celNarrowerOrEqual("a=='x'", "a == 'x' && b == 'y'")).toBe(false);
    expect(celNarrowerOrEqual("(a == 'x' || c == 'z') && b == 'y'", "(a == 'x') || (c == 'z')")).toBe(true);
    expect(celNarrowerOrEqual("a == 'x' || d == 'w'", "a == 'x'")).toBe(false);
    expect(celNarrowerOrEqual("a == 'x && y'", "a == 'x && y'")).toBe(true);
  });

  it("finds a statement's jobs and compares them with a live document", () => {
    const policy = JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Federated: "arn:aws:iam::111111111111:oidc-provider/gitlab.com" }, Action: "sts:AssumeRoleWithWebIdentity", Condition: { StringEquals: { "gitlab.com:aud": "plan" }, StringLike: { "gitlab.com:sub": "project_path:a/b:ref_type:branch:ref:*" } } }] });
    const jobs = trustJobs(policy);
    expect(jobs).toEqual([{ provider: "gitlab.com", sub: "project_path:a/b:ref_type:branch:ref:*", like: true, aud: "plan" }]);
    expect(compareTrust(JSON.parse(policy), jobs, "111111111111").problems).toEqual([]);
    const narrower = JSON.parse(policy);
    narrower.Statement[0].Condition.StringLike["gitlab.com:sub"] = "project_path:a/b:ref_type:branch:ref:feature-*";
    // Narrower than the pattern, so nothing wider; but the pull request jobs' pattern is not admitted.
    expect(compareTrust(narrower, jobs, "111111111111").problems).toEqual(["does not admit sub project_path:a/b:ref_type:branch:ref:* (like) aud plan"]);
    const other = JSON.parse(policy);
    other.Statement[0].Principal.Federated = "arn:aws:iam::222222222222:oidc-provider/gitlab.com";
    expect(compareTrust(other, jobs, "111111111111").problems[0]).toContain("in account 222222222222");
  });
});

describe("forge check --json", () => {
  async function cli(dir: string, answers: Record<string, Answer>, env: Record<string, string>, ...argv: string[]): Promise<{ code: number; out: string }> {
    for (const k of ["GITHUB_TOKEN", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_PROFILE", "GOOGLE_OAUTH_ACCESS_TOKEN", "AZURE_GRAPH_TOKEN"]) vi.stubEnv(k, "");
    vi.stubEnv("AWS_SHARED_CREDENTIALS_FILE", join(dir, "no-credentials"));
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    vi.stubGlobal("fetch", recorded(answers).fetch);
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void lines.push(a.join(" ")));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      return { code: await main(argv), out: lines.join("\n") };
    } finally {
      process.chdir(cwd);
    }
  }

  /** The provider's golden testdata/forge-check/<name>.json; UPDATE_GOLDEN=1 rewrites it. */
  function golden(name: string, out: string): void {
    mkdirSync(GOLDENS, { recursive: true });
    const path = join(GOLDENS, `${name}.json`);
    const text = `${JSON.stringify(JSON.parse(out), null, 2)}\n`;
    if (process.env.UPDATE_GOLDEN || !existsSync(path)) writeFileSync(path, text);
    expect(text).toBe(readFileSync(path, "utf-8"));
  }

  it("prints the rows in the envelope and exits 1 on a mismatch", async () => {
    const dir = fixture("github-aws");
    const a = await githubSetup(dir);
    a[`${GH}/repos/acme/infra/environments/dev`] = ok({ name: "dev", deployment_branch_policy: null });
    a[`${GH}/orgs/acme/actions/runner-groups?per_page=100`] = status(403);
    const { code, out } = await cli(dir, a, { GITHUB_TOKEN: "t" }, "forge", "check", "--json", "--config", "terragucci.yml", "--repo", "acme/infra");
    expect(code).toBe(1);
    const e = JSON.parse(out);
    expect(e).toMatchObject({ schema: 1, command: "forge check", exit: 1, status: "failed" });
    expect(e.results.schema).toBe("terragucci.forge-check/v1");
    expect(e.results.counts).toEqual({ match: 3, mismatch: 1, unknown: 1, "not-checked": 6 });
    golden("github-aws", out);
  });

  it("exits 0 when every row matches", async () => {
    const dir = fixture("github-aws");
    const { code, out } = await cli(dir, await githubSetup(dir), { GITHUB_TOKEN: "t", AWS_ACCESS_KEY_ID: "A", AWS_SECRET_ACCESS_KEY: "s" }, "forge", "check", "--json", "--config", "terragucci.yml", "--repo", "acme/infra");
    expect(code).toBe(0);
    const e = JSON.parse(out);
    expect(e.results.ok).toBe(true);
    golden("github-aws-match", out);
  });

  it("prints a table without --json", async () => {
    const dir = fixture("github-aws");
    const { code, out } = await cli(dir, await githubSetup(dir), { GITHUB_TOKEN: "t" }, "forge", "check", "--config", "terragucci.yml", "--repo", "acme/infra");
    expect(code).toBe(0);
    expect(out).toMatch(/^WHERE +CHECK +SUBJECT +EXPECTED +FOUND +MATCH$/m);
    expect(out).toMatch(/^github +environment +production +exists +exists +yes$/m);
    expect(out).toContain("5 match, 0 mismatch, 0 could not be read, 6 not checked");
  });

  it("refuses an unknown forge subcommand with exit 2", async () => {
    const dir = fixture("github-aws");
    const { code, out } = await cli(dir, {}, {}, "forge", "push", "--json", "--config", "terragucci.yml");
    expect(code).toBe(2);
    expect(JSON.parse(out)).toMatchObject({ command: "forge check", exit: 2, status: "usage", results: null });
  });
});
