/**
 * `terragucci config identities`: per environment and stage, the roots, the
 * runner, the forge environment, the cloud identities, and the exact OIDC
 * subject, claims and audience each forge's job presents, with the trust each
 * cloud needs to accept that job and no other. The provider's data sources
 * (terraform-provider-terragucci) run this command and pass its values
 * through, so the provider, the docs and the pipeline read one computation.
 *
 * Each environment of `environments:` is one entry, and the roots in no
 * environment are one more, `default`, when there are any. Each entry has a
 * stage per kind of job:
 *
 *   plan   the pull request's plan job: the plan identities
 *   apply  the default branch's apply jobs: the apply identities, in the
 *          environment's forge environment on GitHub and GitLab
 *   drift  the scheduled drift job, on the default branch: the plan
 *          identities. Null when `drift` is off.
 *
 * Subjects, by forge:
 *
 *   GitHub   https://docs.github.com/en/actions/reference/security/oidc
 *            ("Example subject claims"):
 *              repo:ORG/REPO:pull_request
 *              repo:ORG/REPO:environment:ENVIRONMENT-NAME
 *              repo:ORG/REPO:ref:refs/heads/BRANCH-NAME
 *            issuer https://token.actions.githubusercontent.com
 *            (https://<host>/_services/token on GitHub Enterprise Server).
 *   GitLab   https://docs.gitlab.com/ci/secrets/id_token_authentication/:
 *            sub "defaults to project_path:{group}/{project}:ref_type:{type}:ref:{branch_name}";
 *            in a merge request pipeline project_path and ref are the source
 *            project's and branch's, so the plan job's subject is a pattern
 *            over every branch. `environment`, `environment_protected` and
 *            `ref_protected` are claims of their own, sent as the strings
 *            "true" and "false"; iss is the instance's URL.
 *   Forgejo  sub repo:<owner>-<owner id>/<repo>-<repo id>:ref:refs/heads/<branch>,
 *            and :pull_request for a pull request: Forgejo 16 names a repo
 *            by its owner's and its own numeric ids (claim oidc/forgejo).
 *            iss is <origin>/api/actions. Forgejo has no deployment
 *            environments, so no claim tells environments apart.
 */
import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
import { atmosInstances, describeStacks } from "./atmos";
import { globMatch, findRoots, hostOfRemote } from "./detect";
import { settingsForRoot, withEnvironmentRoles, type RootSettings } from "./environments";
import { ConfigError, FORGES, forgeFromHost, loadConfig, parseProjectKey, resolveProject, resolveRepo, type EnvironmentSettings, type ForgeName, type OidcSettings, type ProjectSettings, type RolePair, type RunnerSettings, type RunnerSpec } from "./config";
import { AZURE_AUDIENCE, gcpAudience, runnerOf, stageAudience } from "./render";
import { detectShape } from "./shape";
import { walkUnits } from "./terragrunt";

/** The contract's name and version, in `results.schema`. It changes only when a field is removed or changes meaning. */
export const IDENTITIES_SCHEMA = "terragucci.identities/v1";

export const IDENTITY_STAGES = ["plan", "apply", "drift"] as const;
export type IdentityStage = (typeof IDENTITY_STAGES)[number];
export const CLOUDS = ["aws", "gcp", "azure"] as const;
export type Cloud = (typeof CLOUDS)[number];

/** The name of the entry for the roots in no environment. */
export const DEFAULT_ENTRY = "default";

export interface Runner {
  labels: string[];
  /** A GitHub runner group, or null. */
  group: string | null;
}

/** What the forge's OIDC token says about the job. */
export interface Token {
  issuer: string;
  /** The `sub` claim. With `subject_pattern`, a pattern where `*` stands for any text. */
  subject: string;
  subject_pattern: boolean;
  /** Claims besides `sub` and `aud` that the job's token carries and a trust can check: GitLab's environment claims on an apply job with a forge environment. */
  claims: Record<string, string>;
  /** Parts of `subject` this command could not know, written as `<name>` (Forgejo's numeric ids without --owner-id and --repo-id, a repository it found no name for). */
  placeholders: string[];
}

export interface AwsIdentity {
  /** The role the stage's jobs take for the entry's roots; null when only `oidc.roles` names roles. */
  role: string | null;
  /** Roots whose role is not `role`, from `oidc.roles`. */
  root_roles: Record<string, string>;
  audience: string;
  /** The trust policy each of the stage's roles needs, as a JSON string, for `aws_iam_role.assume_role_policy`. */
  assume_role_policy: string;
}

export interface GcpIdentity {
  service_account: string;
  root_service_accounts: Record<string, string>;
  workload_identity_provider: string;
  audience: string;
  /** A CEL condition for the provider's `attribute_condition` that holds for this stage's job alone. */
  attribute_condition: string;
}

export interface AzureIdentity {
  client_id: string;
  root_client_ids: Record<string, string>;
  tenant_id: string;
  /** A federated identity credential's issuer, subject and audiences. `subject` is null when the job's subject is a pattern; `claims_matching_expression` then holds it. */
  issuer: string;
  subject: string | null;
  audiences: string[];
  claims_matching_expression: string | null;
}

export interface StageIdentities {
  runner: Runner | null;
  /** The forge environment the apply jobs run in (GitHub and GitLab); null for plan and drift, on Forgejo, and for roots in no environment. */
  forge_environment: string | null;
  token: Token;
  aws: AwsIdentity | null;
  gcp: GcpIdentity | null;
  azure: AzureIdentity | null;
}

export interface EnvironmentIdentities {
  name: string;
  /** False for `default`, the roots in no environment. */
  environment: boolean;
  /** The environment's `roots` globs; for `default`, the top-level `roots`, or null when they are detected. */
  root_globs: string[] | null;
  /** The repo's roots in the entry; null when the repo's roots were not read (a control repo's project, or --no-roots). */
  roots: string[] | null;
  stages: Record<IdentityStage, StageIdentities | null>;
}

export interface Repository {
  host: string;
  /** owner/name, or a GitLab project's full path. */
  path: string;
  default_branch: string;
  /** Forgejo's numeric ids, when given. */
  owner_id?: string;
  repo_id?: string;
}

export interface Identities {
  schema: typeof IDENTITIES_SCHEMA;
  file: string;
  forge: ForgeName;
  repository: Repository;
  environments: EnvironmentIdentities[];
}

export interface IdentitiesOptions {
  /** The config file, as the envelope names it. */
  file: string;
  /** The repo's directory, whose roots are read; undefined to leave roots null. */
  repoDir?: string;
  forge?: ForgeName;
  /** owner/name, or a GitLab project's full path. */
  repo?: string;
  defaultBranch?: string;
  /** The project's key, for a control repo's project: it names the host and path. */
  projectKey?: string;
  ownerId?: string;
  repoId?: string;
}

// ── the repository ───────────────────────────────────────────────────────────

/** The origin remote's URL in `dir`, or "" when there is none. */
function originUrl(dir: string): string {
  try {
    return execFileSync("git", ["-C", dir, "remote", "get-url", "origin"], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

/** The repository path of a git remote URL, in https, ssh or scp form: owner/name, or a GitLab project's full path. */
export function pathOfRemote(remote: string): string | undefined {
  const url = remote.match(/^[a-z+]+:\/\/(?:[^@/]+@)?[^/]+\/(.+)$/i);
  const scp = url ? undefined : remote.match(/^(?:[^@]+@)?[^:/]+:(.+)$/);
  const p = (url?.[1] ?? scp?.[1])?.replace(/\.git$/, "").replace(/\/+$/, "");
  return p && p.includes("/") ? p : undefined;
}

const DEFAULT_HOST: Record<ForgeName, string> = { github: "github.com", gitlab: "gitlab.com", forgejo: "codeberg.org" };

/** The host of `url`, a forge origin such as https://git.example.com:8443. */
const hostOfUrl = (url: string): string | undefined => url.match(/^[a-z+]+:\/\/(?:[^@/]+@)?([^/]+)/i)?.[1];

/** The token's issuer: GitHub's service for github.com and Enterprise Server's own, GitLab's instance, Forgejo's /api/actions. */
export function issuerOf(forge: ForgeName, host: string): string {
  if (forge === "github") return host.toLowerCase() === "github.com" ? "https://token.actions.githubusercontent.com" : `https://${host}/_services/token`;
  if (forge === "gitlab") return `https://${host}`;
  return `https://${host}/api/actions`;
}

// ── subjects ─────────────────────────────────────────────────────────────────

/** The subject (and claims) the job of `stage` presents, on `forge`, for an entry whose apply jobs run in `forgeEnvironment`. */
export function tokenOf(forge: ForgeName, repo: Repository, stage: IdentityStage, forgeEnvironment: string | null): Token {
  const issuer = issuerOf(forge, repo.host);
  const branch = repo.default_branch;
  const placeholders = [...repo.path.matchAll(/<([^>]+)>/g)].map((m) => m[1]);
  if (forge === "github") {
    const base = `repo:${repo.path}`;
    const subject = stage === "plan" ? `${base}:pull_request` : stage === "apply" && forgeEnvironment ? `${base}:environment:${forgeEnvironment}` : `${base}:ref:refs/heads/${branch}`;
    return { issuer, subject, subject_pattern: false, claims: {}, placeholders };
  }
  if (forge === "gitlab") {
    const base = `project_path:${repo.path}:ref_type:branch:ref:`;
    if (stage === "plan") return { issuer, subject: `${base}*`, subject_pattern: true, claims: {}, placeholders };
    const claims: Record<string, string> = stage === "apply" && forgeEnvironment ? { environment: forgeEnvironment, environment_protected: "true", ref_protected: "true" } : {};
    return { issuer, subject: `${base}${branch}`, subject_pattern: false, claims, placeholders };
  }
  // Forgejo 16: repo:<owner>-<owner id>/<repo>-<repo id>.
  const slash = repo.path.lastIndexOf("/");
  const owner = repo.path.slice(0, slash);
  const name = repo.path.slice(slash + 1);
  const ownerId = repo.owner_id ?? "<owner-id>";
  const repoId = repo.repo_id ?? "<repo-id>";
  const ids = [...(repo.owner_id ? [] : ["owner-id"]), ...(repo.repo_id ? [] : ["repo-id"])];
  const base = `repo:${owner}-${ownerId}/${name}-${repoId}`;
  const subject = stage === "plan" ? `${base}:pull_request` : `${base}:ref:refs/heads/${branch}`;
  return { issuer, subject, subject_pattern: false, claims: {}, placeholders: [...placeholders, ...ids] };
}

// ── trust ────────────────────────────────────────────────────────────────────

/** The issuer as AWS names its OIDC provider and condition keys: the URL without its scheme. */
const issuerKey = (issuer: string): string => issuer.replace(/^https?:\/\//, "").replace(/\/+$/, "");

/** The partition and account of an IAM role ARN; placeholders when `arn` is not one. */
function arnParts(arn: string | null): { partition: string; account: string } {
  const m = arn?.match(/^arn:([^:]+):iam::(\d{12}):/);
  return m ? { partition: m[1], account: m[2] } : { partition: "aws", account: "<account-id>" };
}

/**
 * An IAM role's trust policy for the job: AssumeRoleWithWebIdentity from the
 * forge's OIDC provider in the role's account, when the token's `aud` and
 * `sub` are the job's (StringLike for a subject pattern). AWS reads no other
 * claim of a GitLab token, so an environment's apply role tells its jobs
 * apart by the audience.
 */
export function awsTrustPolicy(token: Token, audience: string, role: string | null): string {
  const key = issuerKey(token.issuer);
  const { partition, account } = arnParts(role);
  const condition: Record<string, Record<string, string>> = token.subject_pattern
    ? { StringEquals: { [`${key}:aud`]: audience }, StringLike: { [`${key}:sub`]: token.subject } }
    : { StringEquals: { [`${key}:aud`]: audience, [`${key}:sub`]: token.subject } };
  return JSON.stringify({
    Version: "2012-10-17",
    Statement: [{
      Effect: "Allow",
      Principal: { Federated: `arn:${partition}:iam::${account}:oidc-provider/${key}` },
      Action: "sts:AssumeRoleWithWebIdentity",
      Condition: condition,
    }],
  });
}

const cel = (s: string): string => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

/**
 * A Workload Identity Federation provider's attribute condition (CEL over
 * `assertion`, the token's claims) for the job: its subject, or the
 * subject's prefix for a pattern, and on GitLab its environment, which must
 * be protected.
 */
export function gcpCondition(token: Token): string {
  const sub = token.subject_pattern ? `assertion.sub.startsWith(${cel(token.subject.replace(/\*$/, ""))})` : `assertion.sub == ${cel(token.subject)}`;
  const env = token.claims.environment;
  return env === undefined ? sub : `${sub} && assertion.environment == ${cel(env)} && assertion.environment_protected == 'true'`;
}

/** An Entra flexible federated credential's expression for a subject pattern. */
const claimsMatching = (token: Token): string | null => (token.subject_pattern ? `claims['sub'] matches ${cel(token.subject)}` : null);

// ── settings ─────────────────────────────────────────────────────────────────

/** Not a root path: a glob only it matches stands for "a root of this environment". */
const SENTINEL = "\u0000terragucci-environment";

/** What a root of environment `name` runs with (settingsForRoot), whether or not the repo has one; `name` undefined for a root in none. */
function environmentSettings(name: string | undefined, settings: ProjectSettings): RootSettings {
  if (name === undefined) return settingsForRoot(SENTINEL, { ...settings, environments: undefined });
  const e = settings.environments![name]!;
  return settingsForRoot(SENTINEL, { ...settings, environments: { [name]: { ...e, roots: [SENTINEL] } } });
}

const runnerValue = (spec: RunnerSpec | undefined): Runner | null => {
  if (spec === undefined) return null;
  if (typeof spec === "string") return { labels: [spec], group: null };
  if (Array.isArray(spec)) return { labels: [...spec], group: null };
  return { labels: [...(spec.labels ?? [])], group: spec.group };
};

/**
 * The runner a job of `stage` takes: the top-level `runner` (runnerOf), and
 * for apply an environment's `runner.apply` (or its one runner) over it.
 */
function runnerFor(stage: IdentityStage, top: RunnerSettings | undefined, e: EnvironmentSettings | undefined): RunnerSpec | undefined {
  if (stage === "apply" && e?.runner !== undefined) {
    const r = e.runner;
    const own = typeof r === "object" && !Array.isArray(r) && !("group" in r) ? (r as { apply?: RunnerSpec }).apply : (r as RunnerSpec);
    if (own !== undefined) return own;
  }
  return runnerOf(top, stage);
}

/** The roots that take an identity other than `own` for `stage`, by the first glob of `roles` each matches. */
function rootIdentities(roots: readonly string[] | null, roles: Record<string, RolePair> | undefined, stage: "plan" | "apply", own: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!roots || !roles) return out;
  for (const r of roots) {
    const glob = Object.keys(roles).find((g) => globMatch(g, r));
    const id = glob === undefined ? undefined : roles[glob]![stage];
    if (id !== undefined && id !== own) out[r] = id;
  }
  return out;
}

/** The repo's roots, found as config check finds them: Terragrunt units, Atmos instances, or plain roots. */
export async function foundRoots(repoDir: string, settings: ProjectSettings & { gate?: unknown }): Promise<string[]> {
  const shape = detectShape(repoDir, settings as Parameters<typeof detectShape>[1]);
  if (shape.kind === "terragrunt") return walkUnits(repoDir, settings.terragrunt?.exclude).map((u) => u.path);
  if (shape.kind === "atmos") return atmosInstances(await describeStacks(repoDir)).map((i) => i.path);
  return findRoots(repoDir, settings.roots);
}

// ── the contract ─────────────────────────────────────────────────────────────

/** Where the repository's forge, host, path and branch come from: the flags, the project's key, the config, the origin remote. */
export function repositoryOf(settings: ProjectSettings, opts: IdentitiesOptions): { forge: ForgeName; repository: Repository } {
  const key = opts.projectKey ? parseProjectKey(opts.projectKey) : undefined;
  const remote = opts.repoDir ? originUrl(opts.repoDir) : "";
  const configHost = settings.url ? hostOfUrl(settings.url) : undefined;
  const remoteHost = hostOfRemote(remote);
  const forge = opts.forge ?? settings.forge ?? (key ? forgeFromHost(key.host) : undefined) ?? (configHost ? forgeFromHost(configHost) : undefined) ?? (remoteHost ? forgeFromHost(remoteHost) : undefined);
  if (!forge) throw new ConfigError("config identities cannot tell the forge: set forge in the config, or pass --forge github|gitlab|forgejo");
  // The origin remote names the repository only when it is on the forge's kind of host (or a host that names none).
  const fromRemote = remoteHost !== undefined && (forgeFromHost(remoteHost) ?? forge) === forge;
  const host = configHost ?? key?.host ?? (fromRemote ? remoteHost : undefined) ?? DEFAULT_HOST[forge];
  const path = opts.repo ?? key?.path ?? (fromRemote ? pathOfRemote(remote) : undefined) ?? "<owner>/<repo>";
  if (!/^[^/\s]+(\/[^/\s]+)+$/.test(path)) throw new ConfigError(`--repo is ${JSON.stringify(path)}; give owner/name, or a GitLab project's full path`);
  return {
    forge,
    repository: {
      host,
      path,
      default_branch: opts.defaultBranch ?? "main",
      ...(forge === "forgejo" && opts.ownerId ? { owner_id: opts.ownerId } : {}),
      ...(forge === "forgejo" && opts.repoId ? { repo_id: opts.repoId } : {}),
    },
  };
}

/** One stage of one entry. */
function stageOf(stage: IdentityStage, forge: ForgeName, repository: Repository, settings: ProjectSettings & { drift?: string | false }, name: string | undefined, roots: string[] | null): StageIdentities | null {
  if (stage === "drift" && !settings.drift) return null;
  const e = name === undefined ? undefined : settings.environments![name]!;
  const own = environmentSettings(name, settings);
  const oidc: OidcSettings | undefined = own.oidc;
  const folded = withEnvironmentRoles(settings.oidc, settings.environments);
  const forgeEnvironment = stage === "apply" && forge !== "forgejo" ? (own.forge_environment ?? null) : null;
  const token = tokenOf(forge, repository, stage, forgeEnvironment);
  const idStage: "plan" | "apply" = stage === "apply" ? "apply" : "plan";

  let aws: AwsIdentity | null = null;
  const roles = folded?.roles;
  if ((oidc?.plan_role && oidc.apply_role) || (roles && Object.keys(roles).length > 0)) {
    const role = (idStage === "plan" ? oidc?.plan_role : oidc?.apply_role) ?? null;
    // An environment's own audience wins over the stage map for its plan and apply jobs.
    const audience = stage !== "drift" && e?.oidc?.audience ? e.oidc.audience : stageAudience(settings.oidc, stage);
    const root_roles = rootIdentities(roots, roles, idStage, role);
    aws = { role, root_roles, audience, assume_role_policy: awsTrustPolicy(token, audience, role ?? Object.values(root_roles)[0] ?? null) };
  }

  let gcp: GcpIdentity | null = null;
  if (oidc?.gcp) {
    const sa = idStage === "plan" ? oidc.gcp.plan_service_account : oidc.gcp.apply_service_account;
    gcp = {
      service_account: sa,
      root_service_accounts: rootIdentities(roots, folded?.gcp?.roles, idStage, sa),
      workload_identity_provider: oidc.gcp.workload_identity_provider,
      audience: gcpAudience(oidc.gcp.workload_identity_provider),
      attribute_condition: gcpCondition(token),
    };
  }

  let azure: AzureIdentity | null = null;
  if (oidc?.azure) {
    const id = idStage === "plan" ? oidc.azure.plan_client_id : oidc.azure.apply_client_id;
    // GitLab's id_tokens declare the public cloud's audience for Azure (render.ts); GitHub and Forgejo ask for oidc.azure.audience.
    const audience = forge === "gitlab" ? AZURE_AUDIENCE : (oidc.azure.audience ?? AZURE_AUDIENCE);
    azure = {
      client_id: id,
      root_client_ids: rootIdentities(roots, folded?.azure?.roles, idStage, id),
      tenant_id: oidc.azure.tenant_id,
      issuer: token.issuer,
      subject: token.subject_pattern ? null : token.subject,
      audiences: [audience],
      claims_matching_expression: claimsMatching(token),
    };
  }

  return { runner: runnerValue(runnerFor(stage, settings.runner, e)), forge_environment: forgeEnvironment, token, aws, gcp, azure };
}

/** The contract for one repo's (or one control-repo project's) settings. `roots` null when the repo's roots were not read. */
export function identities(settings: ProjectSettings & { drift?: string | false }, roots: string[] | null, opts: IdentitiesOptions): Identities {
  const { forge, repository } = repositoryOf(settings, opts);
  const names = Object.keys(settings.environments ?? {});
  const inEnv = (r: string, name: string): boolean => (settings.environments![name]!.roots ?? []).some((g) => globMatch(g, r));
  const entries: EnvironmentIdentities[] = names.map((name) => {
    // A root belongs to the first environment whose glob it matches (environmentOf).
    const mine = roots === null ? null : roots.filter((r) => names.find((n) => inEnv(r, n)) === name);
    return entry(name, true, [...(settings.environments![name]!.roots ?? [])], mine);
  });
  const rest = roots === null ? null : roots.filter((r) => !names.some((n) => inEnv(r, n)));
  if (rest === null || rest.length > 0 || names.length === 0) entries.push(entry(DEFAULT_ENTRY, false, settings.roots ? [...settings.roots] : null, rest));
  return { schema: IDENTITIES_SCHEMA, file: opts.file, forge, repository, environments: entries };

  function entry(name: string, environment: boolean, root_globs: string[] | null, mine: string[] | null): EnvironmentIdentities {
    const env = environment ? name : undefined;
    const stages = Object.fromEntries(IDENTITY_STAGES.map((s) => [s, stageOf(s, forge, repository, settings, env, mine)])) as Record<IdentityStage, StageIdentities | null>;
    return { name, environment, root_globs, roots: mine, stages };
  }
}

/** The text `config identities` prints without --json: a block per entry and stage. */
export function describeIdentities(c: Identities): string {
  const out: string[] = [`${c.file}: ${c.forge} ${c.repository.host}/${c.repository.path} (default branch ${c.repository.default_branch})`];
  for (const e of c.environments) {
    out.push("", `${e.environment ? "environment" : "no environment"} ${e.name}: ${e.roots === null ? "roots not read" : e.roots.length ? e.roots.join(", ") : "no roots"}`);
    for (const s of IDENTITY_STAGES) {
      const st = e.stages[s];
      if (!st) continue;
      out.push(`  ${s}: sub ${st.token.subject}${st.token.subject_pattern ? " (pattern)" : ""}`);
      for (const [k, v] of Object.entries(st.token.claims)) out.push(`    ${k} ${v}`);
      if (st.forge_environment) out.push(`    forge environment ${st.forge_environment}`);
      if (st.runner) out.push(`    runner ${st.runner.group ? `group ${st.runner.group} ` : ""}${st.runner.labels.join(", ")}`);
      if (st.aws) out.push(`    aws ${st.aws.role ?? "(by root)"} aud ${st.aws.audience}`);
      if (st.gcp) out.push(`    gcp ${st.gcp.service_account} aud ${st.gcp.audience}`);
      if (st.azure) out.push(`    azure ${st.azure.client_id} aud ${st.azure.audiences.join(", ")}`);
    }
  }
  const ph = new Set(c.environments.flatMap((e) => IDENTITY_STAGES.flatMap((s) => e.stages[s]?.token.placeholders ?? [])));
  if (ph.size) out.push("", `placeholders: ${[...ph].map((p) => `<${p}>`).join(", ")}`);
  return out.join("\n");
}

export interface ConfigIdentitiesFlags {
  project?: string;
  forge?: string;
  repo?: string;
  defaultBranch?: string;
  ownerId?: string;
  repoId?: string;
  /** Leave the repo's roots unread: a config read away from its repo. */
  noRoots?: boolean;
}

/**
 * `config identities` over the config at `path` (`file` as the output names
 * it): a repo's own config, whose roots are read beside it, or with
 * `project` one project of a control repo's, whose roots are elsewhere.
 */
export async function configIdentities(path: string, file: string, flags: ConfigIdentitiesFlags): Promise<Identities> {
  if (flags.forge !== undefined && !FORGES.includes(flags.forge as ForgeName)) throw new ConfigError(`--forge must be one of ${FORGES.join(", ")}`);
  const config = await loadConfig(path);
  const opts: IdentitiesOptions = {
    file,
    ...(flags.forge ? { forge: flags.forge as ForgeName } : {}),
    ...(flags.repo ? { repo: flags.repo } : {}),
    ...(flags.defaultBranch ? { defaultBranch: flags.defaultBranch } : {}),
    ...(flags.ownerId ? { ownerId: flags.ownerId } : {}),
    ...(flags.repoId ? { repoId: flags.repoId } : {}),
  };
  if (config.projects) {
    const keys = Object.keys(config.projects);
    if (!flags.project) throw new ConfigError(`this config lists projects, so it belongs to a control repo; pass --project with one of ${keys.join(", ")}`);
    return identities(resolveProject(config, flags.project), null, { ...opts, projectKey: flags.project });
  }
  if (flags.project) throw new ConfigError("--project names a control repo's project, and this config lists none");
  const settings = resolveRepo(config);
  const roots = flags.noRoots ? null : await foundRoots(dirname(path), settings);
  return identities(settings, roots, { ...opts, repoDir: dirname(path) });
}
