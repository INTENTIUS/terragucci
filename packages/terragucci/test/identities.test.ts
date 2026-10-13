import { cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli";
import type { ProjectSettings } from "../src/config";
import { awsTrustPolicy, gcpCondition, identities, pathOfRemote, tokenOf, type Identities, type Repository } from "../src/identities";
import { tmp } from "./helpers";

const FIXTURES = join(__dirname, "fixtures", "identities");
/** The provider's goldens: its data sources are tested against the core's own output. */
const GOLDENS = join(__dirname, "..", "..", "..", "terraform-provider-terragucci", "internal", "provider", "testdata", "identities");

async function run(dir: string, ...argv: string[]): Promise<{ code: number; out: string }> {
  const cwd = process.cwd();
  const lines: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void lines.push(a.join(" ")));
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  process.chdir(dir);
  try {
    return { code: await main(argv), out: lines.join("\n") };
  } finally {
    process.chdir(cwd);
    log.mockRestore();
    err.mockRestore();
  }
}

/** Compare to the provider's testdata/identities/<name>.json; UPDATE_GOLDEN=1 rewrites it. */
function golden(name: string, out: string): void {
  const path = join(GOLDENS, `${name}.json`);
  const text = `${JSON.stringify(JSON.parse(out), null, 2)}\n`;
  if (process.env.UPDATE_GOLDEN || !existsSync(path)) writeFileSync(path, text);
  expect(text).toBe(readFileSync(path, "utf-8"));
}

/** The fixture copied out of this repo, so no git remote is read. */
function fixture(name: string): string {
  const dir = tmp();
  cpSync(join(FIXTURES, name), dir, { recursive: true });
  return dir;
}

/** Each fixture and the flags it runs with. */
const CASES: [string, string[]][] = [
  ["github-aws", ["--repo", "acme/infra"]],
  ["gitlab-gcp", ["--repo", "acme/platform/infra", "--default-branch", "trunk"]],
  ["gitlab-aws", ["--repo", "acme/infra"]],
  ["forgejo-aws", ["--repo", "acme/infra"]],
  ["forgejo-aws-ids", ["--repo", "acme/infra", "--owner-id", "3", "--repo-id", "17"]],
  ["azure", ["--repo", "acme/infra"]],
  ["no-environments", ["--repo", "acme/infra"]],
  ["pr-apply", ["--repo", "acme/infra"]],
  ["control", ["--project", "gitlab.com/acme/platform/infra"]],
];

afterEach(() => vi.restoreAllMocks());

describe("config identities --json", () => {
  for (const [name, flags] of CASES) {
    it(`prints the contract for ${name}`, async () => {
      const dir = fixture(name.replace(/-ids$/, ""));
      const { code, out } = await run(dir, "config", "identities", "--json", "--config", "terragucci.yml", ...flags);
      expect(code).toBe(0);
      const e = JSON.parse(out);
      expect(e.command).toBe("config identities");
      expect(e.results.schema).toBe("terragucci.identities/v1");
      golden(name, out);
    });
  }

  it("gives each GitHub environment's apply job its forge environment's subject, runner and audience, and the roots in none the default branch's", async () => {
    const { out } = await run(fixture("github-aws"), "config", "identities", "--json", "--repo", "acme/infra");
    const c = JSON.parse(out).results as Identities;
    expect(c.environments.map((e) => [e.name, e.roots])).toEqual([
      ["prod", ["envs/prod/app", "envs/prod/net"]],
      ["dev", ["envs/dev/app"]],
      ["default", ["shared/dns"]],
    ]);
    const [prod, dev, rest] = c.environments;
    expect(prod!.stages.apply!.token.subject).toBe("repo:acme/infra:environment:production");
    expect(prod!.stages.apply!.forge_environment).toBe("production");
    expect(dev!.stages.apply!.forge_environment).toBe("dev");
    expect(prod!.stages.plan!.token.subject).toBe("repo:acme/infra:pull_request");
    expect(prod!.stages.decide!.token.subject).toBe("repo:acme/infra:ref:refs/heads/main");
    expect(prod!.stages.decide!.forge_environment).toBeNull();
    expect(prod!.stages.drift!.token.subject).toBe("repo:acme/infra:ref:refs/heads/main");
    expect(prod!.stages.apply!.aws!.role).toBe("arn:aws:iam::222222222222:role/prod-apply");
    // prod's own audience is its apply jobs'; dev keeps the stage map's; the deciding job plans on the plan audience.
    expect(prod!.stages.apply!.aws!.audience).toBe("terragucci-prod-apply");
    expect(dev!.stages.apply!.aws!.audience).toBe("terragucci-apply");
    expect(prod!.stages.plan!.aws!.audience).toBe("terragucci-plan");
    expect(prod!.stages.decide!.aws!.audience).toBe("terragucci-plan");
    expect(prod!.stages.drift!.aws!.audience).toBe("sts.amazonaws.com");
    expect(prod!.stages.apply!.runner).toEqual({ labels: ["self-hosted", "prod"], group: null });
    expect(dev!.stages.apply!.runner).toEqual({ labels: ["self-hosted", "linux"], group: "deployers" });
    expect(prod!.stages.decide!.runner).toEqual({ labels: ["self-hosted", "linux"], group: "deployers" });
    expect(prod!.stages.plan!.runner).toEqual({ labels: ["ubuntu-latest"], group: null });
    const key = "token.actions.githubusercontent.com";
    const statement = (aud: string, sub: string, account = "222222222222") => ({
      Effect: "Allow",
      Principal: { Federated: `arn:aws:iam::${account}:oidc-provider/${key}` },
      Action: "sts:AssumeRoleWithWebIdentity",
      Condition: { StringEquals: { [`${key}:aud`]: aud, [`${key}:sub`]: sub } },
    });
    expect(JSON.parse(prod!.stages.apply!.aws!.assume_role_policy)).toEqual({ Version: "2012-10-17", Statement: [statement("terragucci-prod-apply", "repo:acme/infra:environment:production")] });
    expect(prod!.stages.apply!.aws!.trusts).toEqual(["apply"]);
    // The plan role serves the pull request's plan job, each wave's deciding job and drift: its trust names each.
    expect(prod!.stages.plan!.aws!.trusts).toEqual(["plan", "decide", "drift"]);
    expect(JSON.parse(prod!.stages.plan!.aws!.assume_role_policy).Statement).toEqual([
      statement("terragucci-plan", "repo:acme/infra:pull_request"),
      statement("terragucci-plan", "repo:acme/infra:ref:refs/heads/main"),
      statement("sts.amazonaws.com", "repo:acme/infra:ref:refs/heads/main"),
    ]);
    expect(prod!.stages.drift!.aws!.assume_role_policy).toBe(prod!.stages.plan!.aws!.assume_role_policy);
    expect(rest!.environment).toBe(false);
    expect(rest!.stages.apply!.forge_environment).toBeNull();
    expect(rest!.stages.apply!.token.subject).toBe("repo:acme/infra:ref:refs/heads/main");
    expect(rest!.stages.apply!.aws!.role).toBe("arn:aws:iam::111111111111:role/shared-apply");
  });

  it("gives GitLab's plan a subject pattern over every branch, and its apply the environment's claims and a condition on them", async () => {
    const { out } = await run(fixture("gitlab-gcp"), "config", "identities", "--json", "--repo", "acme/platform/infra");
    const c = JSON.parse(out).results as Identities;
    const prod = c.environments.find((e) => e.name === "prod")!;
    expect(c.repository.host).toBe("gitlab.example.com");
    expect(prod.stages.plan!.token).toMatchObject({ issuer: "https://gitlab.example.com", subject: "project_path:acme/platform/infra:ref_type:branch:ref:*", subject_pattern: true });
    const main = "project_path:acme/platform/infra:ref_type:branch:ref:main";
    expect(prod.stages.plan!.gcp!.attribute_condition).toBe(`(assertion.sub.startsWith('project_path:acme/platform/infra:ref_type:branch:ref:')) || (assertion.sub == '${main}')`);
    expect(prod.stages.apply!.token.claims).toEqual({ environment: "production", environment_protected: "true", ref_protected: "true" });
    expect(prod.stages.apply!.gcp!.attribute_condition).toBe(`assertion.sub == '${main}' && assertion.environment == 'production' && assertion.environment_protected == 'true' && assertion.ref_protected == 'true'`);
    expect(prod.stages.apply!.gcp!.service_account).toBe("prod-apply@infra.iam.gserviceaccount.com");
    expect(prod.stages.apply!.gcp!.audience).toBe("https://iam.googleapis.com/projects/123456789/locations/global/workloadIdentityPools/terragucci/providers/gitlab");
    expect(prod.stages.apply!.runner).toEqual({ labels: ["docker", "prod"], group: null });
    expect(c.environments.find((e) => e.name === "staging")!.stages.apply!.runner).toEqual({ labels: ["docker", "linux"], group: null });
    expect(c.environments.map((e) => e.name)).toEqual(["prod", "staging"]);
  });

  it("gives each GitLab environment's AWS apply role its own audience, the one claim beside sub that AWS reads", async () => {
    const c = JSON.parse((await run(fixture("gitlab-aws"), "config", "identities", "--json", "--repo", "acme/infra")).out).results as Identities;
    const [prod, dev] = c.environments;
    expect(c.environments.map((e) => e.name)).toEqual(["prod", "dev", "default"]);
    const policy = (e: typeof prod) => JSON.parse(e!.stages.apply!.aws!.assume_role_policy).Statement[0].Condition.StringEquals;
    expect(policy(prod)).toEqual({ "gitlab.com:aud": "terragucci-prod-apply", "gitlab.com:sub": "project_path:acme/infra:ref_type:branch:ref:main" });
    expect(policy(dev)).toEqual({ "gitlab.com:aud": "terragucci-dev-apply", "gitlab.com:sub": "project_path:acme/infra:ref_type:branch:ref:main" });
    expect(prod!.stages.apply!.runner).toEqual({ labels: ["prod-runner"], group: null });
  });


  it("names a Forgejo repo by its ids, with placeholders until they are given, and no forge environment", async () => {
    const without = JSON.parse((await run(fixture("forgejo-aws"), "config", "identities", "--json", "--repo", "acme/infra")).out).results as Identities;
    const prod = without.environments[0]!;
    expect(prod.stages.apply!.token).toEqual({ issuer: "https://git.example.com/api/actions", subject: "repo:acme-<owner-id>/infra-<repo-id>:ref:refs/heads/main", subject_pattern: false, claims: {}, placeholders: ["owner-id", "repo-id"] });
    expect(prod.stages.apply!.forge_environment).toBeNull();
    expect(prod.stages.drift).toBeNull();
    const withIds = JSON.parse((await run(fixture("forgejo-aws"), "config", "identities", "--json", "--repo", "acme/infra", "--owner-id", "3", "--repo-id", "17")).out).results as Identities;
    expect(withIds.environments[0]!.stages.plan!.token.subject).toBe("repo:acme-3/infra-17:pull_request");
    expect(withIds.environments[0]!.stages.plan!.token.placeholders).toEqual([]);
    expect(JSON.parse(withIds.environments[0]!.stages.apply!.aws!.assume_role_policy).Statement[0].Principal.Federated).toBe("arn:aws:iam::444444444444:oidc-provider/git.example.com/api/actions");
    // dev sets no identities of its own: the project's pair.
    expect(withIds.environments[1]!.stages.apply!.aws!.role).toBe("arn:aws:iam::444444444444:role/apply");
  });

  it("gives Azure a federated credential per environment and stage, with the configured audience", async () => {
    const c = JSON.parse((await run(fixture("azure"), "config", "identities", "--json", "--repo", "acme/infra")).out).results as Identities;
    expect(c.environments.map((e) => e.name)).toEqual(["prod", "dev"]);
    expect(c.environments[0]!.stages.apply!.azure).toEqual({
      client_id: "00000000-0000-0000-0000-0000000000b2",
      root_client_ids: {},
      tenant_id: "00000000-0000-0000-0000-000000000001",
      issuer: "https://token.actions.githubusercontent.com",
      subject: "repo:acme/infra:environment:prod",
      audiences: ["api://AzureADTokenExchangeUSGov"],
      claims_matching_expression: null,
    });
    expect(c.environments[0]!.stages.apply!.aws).toBeNull();
  });

  it("with no environments, has one default entry with each root's own role", async () => {
    const c = JSON.parse((await run(fixture("no-environments"), "config", "identities", "--json", "--repo", "acme/infra")).out).results as Identities;
    expect(c.environments).toHaveLength(1);
    const d = c.environments[0]!;
    expect(d).toMatchObject({ name: "default", environment: false, root_globs: null, roots: ["app", "network"] });
    expect(d.stages.apply!.aws!.root_roles).toEqual({ network: "arn:aws:iam::555555555555:role/network-apply" });
    expect(d.stages.apply!.token.subject).toBe("repo:acme/infra:ref:refs/heads/main");
  });

  it("reads a control repo's project, its roots unread, and names the projects when none is given", async () => {
    const dir = fixture("control");
    const c = JSON.parse((await run(dir, "config", "identities", "--json", "--project", "gitlab.com/acme/platform/infra")).out).results as Identities;
    expect(c.forge).toBe("gitlab");
    expect(c.repository).toEqual({ host: "gitlab.com", path: "acme/platform/infra", default_branch: "main" });
    expect(c.environments.map((e) => [e.name, e.roots])).toEqual([["prod", null], ["dev", null], ["default", null]]);
    expect(c.environments[0]!.stages.drift!.aws!.audience).toBe("terragucci-drift");
    const bad = await run(dir, "config", "identities", "--json");
    expect(bad.code).toBe(2);
    expect(JSON.parse(bad.out)).toMatchObject({ command: "config identities", results: null });
    expect(JSON.parse(bad.out).error).toContain("gitlab.com/acme/platform/infra");
  });

  it("leaves roots unread with --no-roots, and asks for the forge when nothing names it", async () => {
    const dir = fixture("no-environments");
    const c = JSON.parse((await run(dir, "config", "identities", "--json", "--no-roots", "--repo", "acme/infra")).out).results as Identities;
    expect(c.environments[0]!.roots).toBeNull();
    writeFileSync(join(dir, "terragucci.yml"), "binary: tofu\n");
    const bad = await run(dir, "config", "identities", "--json");
    expect(bad.code).toBe(2);
    expect(JSON.parse(bad.out).error).toContain("--forge");
  });

  it("prints text without --json", async () => {
    const { code, out } = await run(fixture("github-aws"), "config", "identities", "--repo", "acme/infra");
    expect(code).toBe(0);
    expect(out).toContain("environment prod: envs/prod/app, envs/prod/net");
    expect(out).toContain("apply: sub repo:acme/infra:environment:production");
  });
});

describe("identities", () => {
  const repo: Repository = { host: "github.com", path: "acme/infra", default_branch: "main" };

  it("takes an environment's forge_environment, runner and apply audience over the top-level ones", () => {
    const settings = {
      forge: "github",
      drift: "0 4 * * *",
      runner: { default: "ubuntu-latest", apply: "deployer" },
      oidc: { plan_role: "arn:aws:iam::111111111111:role/plan", apply_role: "arn:aws:iam::111111111111:role/apply", audience: { plan: "p", apply: "a", drift: "d" } },
      environments: {
        prod: { roots: ["envs/prod/**"], forge_environment: "production", runner: { apply: ["self-hosted", "prod"] }, oidc: { plan_role: "arn:aws:iam::222222222222:role/prod-plan", apply_role: "arn:aws:iam::222222222222:role/prod-apply", audience: "prod-aud" } },
        dev: { roots: ["envs/dev/**"], runner: "dev-runner" },
      },
    } as unknown as ProjectSettings;
    const c = identities(settings, ["envs/prod/app", "envs/dev/app"], { file: "terragucci.yml", repo: repo.path });
    const [prod, dev] = c.environments;
    expect(c.environments).toHaveLength(2);
    expect(prod!.stages.apply!.forge_environment).toBe("production");
    expect(prod!.stages.apply!.token.subject).toBe("repo:acme/infra:environment:production");
    expect(prod!.stages.apply!.runner).toEqual({ labels: ["self-hosted", "prod"], group: null });
    expect(prod!.stages.plan!.runner).toEqual({ labels: ["ubuntu-latest"], group: null });
    expect(prod!.stages.apply!.aws!.audience).toBe("prod-aud");
    expect(prod!.stages.plan!.aws!.audience).toBe("p");
    expect(prod!.stages.decide!.aws!.audience).toBe("p");
    expect(prod!.stages.drift!.aws!.audience).toBe("d");
    expect(dev!.stages.apply!.forge_environment).toBe("dev");
    expect(dev!.stages.apply!.runner).toEqual({ labels: ["dev-runner"], group: null });
    expect(dev!.stages.apply!.aws!.audience).toBe("a");
    expect(dev!.stages.apply!.aws!.role).toBe("arn:aws:iam::111111111111:role/apply");
  });

  it("in a Terragrunt repo, whose waves apply in one job, gives no forge environment, deciding job or environment's runner and audience", () => {
    const settings = {
      forge: "github",
      oidc: { plan_role: "arn:aws:iam::111111111111:role/plan", apply_role: "arn:aws:iam::111111111111:role/apply" },
      environments: { prod: { roots: ["live/prod/**"], runner: "prod-runner", oidc: { audience: "prod-aud" } } },
    } as unknown as ProjectSettings;
    const [prod] = identities(settings, ["live/prod/app"], { file: "terragucci.yml", repo: repo.path, terragrunt: true }).environments;
    expect(prod!.stages.apply!.forge_environment).toBeNull();
    expect(prod!.stages.apply!.token.subject).toBe("repo:acme/infra:ref:refs/heads/main");
    expect(prod!.stages.apply!.runner).toBeNull();
    expect(prod!.stages.apply!.aws!.audience).toBe("sts.amazonaws.com");
    expect(prod!.stages.decide).toBeNull();
  });

  it("with roles by glob that split the roots and no environments, has a deciding job and no forge environment", () => {
    const settings = {
      forge: "github",
      oidc: { plan_role: "arn:aws:iam::1:role/plan", apply_role: "arn:aws:iam::1:role/apply", roles: { network: { plan: "arn:aws:iam::1:role/np", apply: "arn:aws:iam::1:role/na" } } },
    } as unknown as ProjectSettings;
    const [d] = identities(settings, ["app", "network"], { file: "terragucci.yml", repo: repo.path }).environments;
    expect(d!.stages.decide!.token.subject).toBe("repo:acme/infra:ref:refs/heads/main");
    expect(d!.stages.apply!.forge_environment).toBeNull();
  });

  it("with apply.when: pull-request, has a confirm job that takes the plan identities on the apply audience, which the plan role's trust admits", async () => {
    const c = JSON.parse((await run(fixture("pr-apply"), "config", "identities", "--json", "--repo", "acme/infra")).out).results as Identities;
    const [d] = c.environments;
    expect(c.environments).toHaveLength(1);
    expect(d!.stages.confirm!.token.subject).toBe("repo:acme/infra:ref:refs/heads/main");
    expect(d!.stages.confirm!.aws!.role).toBe("arn:aws:iam::121212121212:role/plan");
    expect(d!.stages.confirm!.aws!.audience).toBe("terragucci-apply");
    expect(d!.stages.plan!.aws!.trusts).toEqual(["plan", "confirm"]);
    expect(d!.stages.apply!.aws!.trusts).toEqual(["apply"]);
    const key = "token.actions.githubusercontent.com";
    expect(JSON.parse(d!.stages.plan!.aws!.assume_role_policy).Statement.map((x: { Condition: { StringEquals: Record<string, string> } }) => x.Condition.StringEquals)).toEqual([
      { [`${key}:aud`]: "terragucci-plan", [`${key}:sub`]: "repo:acme/infra:pull_request" },
      { [`${key}:aud`]: "terragucci-apply", [`${key}:sub`]: "repo:acme/infra:ref:refs/heads/main" },
    ]);
    // Without it, no confirm job.
    const other = JSON.parse((await run(fixture("no-environments"), "config", "identities", "--json", "--repo", "acme/infra")).out).results as Identities;
    expect(other.environments[0]!.stages.confirm).toBeNull();
  });

  it("writes a StringLike subject for a pattern, and a placeholder account when no role names one", () => {
    const token = tokenOf("gitlab", { host: "gitlab.com", path: "g/p", default_branch: "main" }, "plan", null);
    expect(JSON.parse(awsTrustPolicy([{ token, audience: "aud" }], null))).toEqual({
      Version: "2012-10-17",
      Statement: [{
        Effect: "Allow",
        Principal: { Federated: "arn:aws:iam::<account-id>:oidc-provider/gitlab.com" },
        Action: "sts:AssumeRoleWithWebIdentity",
        Condition: { StringEquals: { "gitlab.com:aud": "aud" }, StringLike: { "gitlab.com:sub": "project_path:g/p:ref_type:branch:ref:*" } },
      }],
    });
    expect(JSON.parse(awsTrustPolicy([{ token, audience: "aud" }, { token, audience: "aud" }], "arn:aws-us-gov:iam::123456789012:role/x")).Statement).toHaveLength(1);
    expect(JSON.parse(awsTrustPolicy([{ token, audience: "aud" }], "arn:aws-us-gov:iam::123456789012:role/x")).Statement[0].Principal.Federated).toBe("arn:aws-us-gov:iam::123456789012:oidc-provider/gitlab.com");
  });

  it("quotes CEL strings", () => {
    expect(gcpCondition([{ issuer: "i", subject: "a'b", subject_pattern: false, claims: {}, placeholders: [] }])).toBe("assertion.sub == 'a\\'b'");
  });

  it("uses GitHub Enterprise Server's own issuer", () => {
    expect(tokenOf("github", { ...repo, host: "github.example.com" }, "drift", null).issuer).toBe("https://github.example.com/_services/token");
  });

  it("reads a repository's path from its remote", () => {
    expect(pathOfRemote("https://github.com/acme/infra.git")).toBe("acme/infra");
    expect(pathOfRemote("git@gitlab.com:acme/platform/infra.git")).toBe("acme/platform/infra");
    expect(pathOfRemote("ssh://git@git.example.com:2222/acme/infra.git")).toBe("acme/infra");
    expect(pathOfRemote("")).toBeUndefined();
  });
});
