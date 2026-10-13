/**
 * `terragucci forge check`: the identities contract (./identities.ts) next to
 * the live forge and cloud setup, one row per expected setting, with what was
 * found and whether it matches.
 *
 *   GitHub   each apply job's forge environment exists and deploys from the
 *            default branch alone (protected branches, or one custom policy
 *            naming the default branch); each apply runner group is limited
 *            to selected workflows (org-level, so a token without
 *            Self-hosted runners: read gets `unknown`)
 *   GitLab   each forge environment is protected (Premium: on another edition
 *            the row is `unknown`); every runner carrying an apply runner's
 *            tags takes protected refs only; each variable the apply jobs read
 *            (pass, the cost key, the notify secrets) has a definition scoped
 *            to the environment and protected
 *   Forgejo  the default branch and each apply.branches branch is protected
 *   AWS      each role's trust admits each job the contract names and no
 *            other subject or audience (iam GetRole, Signature Version 4)
 *   GCP      the workload identity provider's attribute condition is the
 *            contract's or narrower
 *   Azure    each app's federated credentials are the contract's, and no other
 *
 * Statuses: `match`, `mismatch`, `unknown` (the setting could not be read: a
 * scope the token lacks, an edition without the feature) and `not-checked`
 * (no credentials for that cloud). Only a mismatch fails the command, and
 * with --require-clouds a cloud left unchecked.
 *
 * Every call goes through readOnly(): GET and HEAD, and no AWS Query action
 * but GetRole. Nothing here can write to a forge or a cloud.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { COST_KEY_SECRET, loadConfig, resolveProject, resolveRepo, type ForgeName, type ProjectSettings } from "./config";
import { globMatch } from "./detect";
import { call, DEFAULT_TOKEN_ENV, ForgeError, type Fetch, type ForgeTarget } from "./forge";
import { configIdentities, IDENTITY_STAGES, type ConfigIdentitiesFlags, type Identities, type StageIdentities } from "./identities";
import { encodeStrict, xmlText } from "./report/object-store";
import { sign } from "./report/s3";

/** The result's name and version, in `results.schema`. */
export const FORGE_CHECK_SCHEMA = "terragucci.forge-check/v1";

export const CHECK_STATUSES = ["match", "mismatch", "unknown", "not-checked"] as const;
export type CheckStatus = (typeof CHECK_STATUSES)[number];
export type CheckWhere = ForgeName | "aws" | "gcp" | "azure";

export interface CheckRow {
  where: CheckWhere;
  /** What is checked: environment, deployment-branches, runner-group, protected-environment, protected-runners, variable, protected-branch, trust. */
  check: string;
  /** The thing checked: an environment, a runner group or tag set, a variable, a branch, a role, a provider, an app. */
  subject: string;
  expected: string;
  found: string;
  status: CheckStatus;
}

export interface ForgeCheck {
  schema: typeof FORGE_CHECK_SCHEMA;
  file: string;
  forge: ForgeName;
  repository: Identities["repository"];
  rows: CheckRow[];
  counts: Record<CheckStatus, number>;
  /** No mismatch (and with --require-clouds, no cloud left unchecked). */
  ok: boolean;
}

export interface ForgeCheckFlags extends ConfigIdentitiesFlags {
  requireClouds?: boolean;
}

export interface ForgeCheckDeps {
  fetch: Fetch;
  env: NodeJS.ProcessEnv;
  /** Reads the AWS shared credentials file; undefined when there is none. */
  readFile?: (path: string) => string | undefined;
  now?: () => Date;
}

// ── read-only ────────────────────────────────────────────────────────────────

/** The AWS Query API actions a request may name: reads alone. */
export const READ_ACTIONS: readonly string[] = ["GetRole"];

export class ReadOnlyError extends Error {}

/**
 * Refuse any request that could write: a method other than GET or HEAD, or an
 * AWS Query action (`Action=` in the query or a form body) not in
 * READ_ACTIONS. A POST passes only as such a read action, which the Query API
 * takes as GET or POST alike.
 */
export function assertReadOnly(url: string, method: string, body?: string): void {
  const m = method.toUpperCase();
  let queryAction: string | null = null;
  try {
    queryAction = new URL(url).searchParams.get("Action");
  } catch {
    throw new ReadOnlyError(`forge check refuses ${m} ${url}: not a URL`);
  }
  const named = (a: string | null): boolean => a === null || READ_ACTIONS.includes(a);
  if (m === "GET" || m === "HEAD") {
    if (named(queryAction)) return;
    throw new ReadOnlyError(`forge check is read-only: it refuses the action ${queryAction} (${m} ${url}); it may call ${READ_ACTIONS.join(", ")}`);
  }
  if (m === "POST" && typeof body === "string") {
    const bodyAction = new URLSearchParams(body).get("Action");
    if (bodyAction !== null && READ_ACTIONS.includes(bodyAction) && named(queryAction)) return;
  }
  throw new ReadOnlyError(`forge check is read-only: it refuses ${m} ${url}`);
}

/** `fetch`, refusing every request assertReadOnly refuses before it is sent. */
export function readOnly(fetch: Fetch): Fetch {
  return async (url, init) => {
    assertReadOnly(url, init?.method ?? "GET", init?.body);
    return fetch(url, init);
  };
}

// ── forge reads ──────────────────────────────────────────────────────────────

type Read<T> = { ok: true; value: T } | { ok: false; status: number | undefined; why: string };

async function read<T>(fetch: Fetch, t: ForgeTarget, path: string): Promise<Read<T>> {
  try {
    return { ok: true, value: (await call(fetch, t, "GET", path)) as T };
  } catch (e) {
    if (e instanceof ReadOnlyError) throw e;
    if (e instanceof ForgeError) return { ok: false, status: e.status, why: e.message };
    return { ok: false, status: undefined, why: (e as Error).message };
  }
}

const couldNot = (r: { status: number | undefined }, need: string): string => `could not read (${r.status ?? "no answer"}); ${need}`;

/** The scopes each read needs, as the rows and the docs name them. */
export const SCOPES = {
  github: "the token needs Metadata: read and Actions: read on the repository (classic: repo)",
  githubOrg: "the token needs Self-hosted runners: read on the organization (classic: admin:org)",
  gitlab: "the token needs the read_api scope and the Maintainer role",
  gitlabEdition: "protected environments are GitLab Premium; on another edition, or without read_api and the Maintainer role, they cannot be read",
  forgejo: "the token needs read:repository, and its user admin on the repository",
  aws: "the credentials need iam:GetRole on the role",
  gcp: "the token needs iam.workloadIdentityPoolProviders.get on the provider",
  azure: "the token needs Application.Read.All (Microsoft Graph)",
};

interface Repo {
  defaultBranch?: string;
  ownerId?: string;
  repoId?: string;
}

async function readRepo(fetch: Fetch, t: ForgeTarget): Promise<Read<Repo>> {
  const r = await read<{ default_branch?: string; id?: number; owner?: { id?: number } }>(fetch, t, t.forge === "gitlab" ? `/projects/${encodeURIComponent(t.path)}` : `/repos/${t.path}`);
  if (!r.ok) return r;
  const v = r.value;
  return {
    ok: true,
    value: {
      ...(v.default_branch ? { defaultBranch: v.default_branch } : {}),
      ...(t.forge === "forgejo" && v.owner?.id !== undefined ? { ownerId: String(v.owner.id) } : {}),
      ...(t.forge === "forgejo" && v.id !== undefined ? { repoId: String(v.id) } : {}),
    },
  };
}

/** Every stage of every entry that is present, with its entry's name. */
function stagesOf(c: Identities): { entry: string; stage: string; st: StageIdentities }[] {
  return c.environments.flatMap((e) => IDENTITY_STAGES.flatMap((s) => (e.stages[s] ? [{ entry: e.name, stage: s, st: e.stages[s]! }] : [])));
}

const unique = <T>(xs: T[]): T[] => [...new Set(xs)];
const forgeEnvironments = (c: Identities): string[] => unique(c.environments.flatMap((e) => (e.stages.apply?.forge_environment ? [e.stages.apply.forge_environment] : [])));

export async function githubRows(fetch: Fetch, t: ForgeTarget, c: Identities): Promise<CheckRow[]> {
  const rows: CheckRow[] = [];
  const branch = c.repository.default_branch;
  for (const env of forgeEnvironments(c)) {
    const row = (check: string, expected: string, found: string, status: CheckStatus): number => rows.push({ where: "github", check, subject: env, expected, found, status });
    const r = await read<{ deployment_branch_policy?: { protected_branches?: boolean; custom_branch_policies?: boolean } | null }>(fetch, t, `/repos/${t.path}/environments/${encodeURIComponent(env)}`);
    if (!r.ok) {
      if (r.status === 404) row("environment", "exists", "missing", "mismatch");
      else row("environment", "exists", couldNot(r, SCOPES.github), "unknown");
      continue;
    }
    row("environment", "exists", "exists", "match");
    const expected = `deploys from ${branch} only`;
    const p = r.value.deployment_branch_policy;
    if (!p) {
      row("deployment-branches", expected, "any branch: no deployment branch rule", "mismatch");
    } else if (p.protected_branches) {
      row("deployment-branches", expected, "protected branches", "match");
    } else {
      const b = await read<{ branch_policies?: { name: string; type?: string }[] }>(fetch, t, `/repos/${t.path}/environments/${encodeURIComponent(env)}/deployment-branch-policies?per_page=100`);
      if (!b.ok) {
        row("deployment-branches", expected, couldNot(b, SCOPES.github), "unknown");
        continue;
      }
      const list = b.value.branch_policies ?? [];
      const ok = list.length === 1 && list[0]!.name === branch && list[0]!.type !== "tag";
      row("deployment-branches", expected, `custom: ${list.map((x) => `${x.name}${x.type === "tag" ? " (tag)" : ""}`).join(", ") || "none"}`, ok ? "match" : "mismatch");
    }
  }
  const groups = unique(stagesOf(c).flatMap(({ stage, st }) => (stage === "apply" && st.runner?.group ? [st.runner.group] : [])));
  if (groups.length) {
    const owner = t.path.split("/")[0]!;
    const r = await read<{ runner_groups?: { name: string; restricted_to_workflows?: boolean; selected_workflows?: string[]; visibility?: string }[] }>(fetch, t, `/orgs/${owner}/actions/runner-groups?per_page=100`);
    for (const g of groups) {
      const expected = "limited to selected workflows";
      if (!r.ok) {
        rows.push({ where: "github", check: "runner-group", subject: g, expected, found: couldNot(r, SCOPES.githubOrg), status: "unknown" });
        continue;
      }
      const found = (r.value.runner_groups ?? []).find((x) => x.name === g);
      if (!found) rows.push({ where: "github", check: "runner-group", subject: g, expected, found: `no runner group ${g} in ${owner}`, status: "mismatch" });
      else if (found.restricted_to_workflows) rows.push({ where: "github", check: "runner-group", subject: g, expected, found: `selected workflows: ${(found.selected_workflows ?? []).join(", ") || "none"}`, status: "match" });
      else rows.push({ where: "github", check: "runner-group", subject: g, expected, found: "every workflow", status: "mismatch" });
    }
  }
  return rows;
}

/** The variables the apply jobs read: pass, the cost key and the notify secrets. */
export function applyVariables(s: ProjectSettings): string[] {
  const cost = s.cost === undefined ? [] : [s.cost === true ? COST_KEY_SECRET : (s.cost.key_secret ?? COST_KEY_SECRET)];
  const notify = s.notify ? [s.notify.slack, s.notify.teams, s.notify.webhook, s.notify.webhook_key].filter((x): x is string => typeof x === "string") : [];
  return unique([...(s.pass?.secrets ?? []), ...(s.pass?.vars ?? []), ...cost, ...notify]);
}

export async function gitlabRows(fetch: Fetch, t: ForgeTarget, c: Identities, s: ProjectSettings): Promise<CheckRow[]> {
  const rows: CheckRow[] = [];
  const pid = encodeURIComponent(t.path);
  const envs = forgeEnvironments(c);
  if (envs.length) {
    const r = await read<{ name: string }[]>(fetch, t, `/projects/${pid}/protected_environments?per_page=100`);
    for (const env of envs) {
      if (!r.ok) {
        const why = r.status === 404 || r.status === 403 ? `could not read (${r.status}); ${SCOPES.gitlabEdition}` : couldNot(r, SCOPES.gitlab);
        rows.push({ where: "gitlab", check: "protected-environment", subject: env, expected: "protected", found: why, status: "unknown" });
        continue;
      }
      const ok = r.value.some((p) => p.name === env);
      rows.push({ where: "gitlab", check: "protected-environment", subject: env, expected: "protected", found: ok ? "protected" : "not protected", status: ok ? "match" : "mismatch" });
    }
  }
  const tagSets = new Map<string, string[]>();
  for (const { stage, st } of stagesOf(c)) if (stage === "apply" && st.runner?.labels.length) tagSets.set([...st.runner.labels].sort().join(","), st.runner.labels);
  for (const tags of tagSets.values()) {
    const subject = `tags ${tags.join(", ")}`;
    const expected = "every runner with these tags runs protected refs only (ref_protected)";
    const r = await read<{ id: number; description?: string }[]>(fetch, t, `/projects/${pid}/runners?tag_list=${encodeURIComponent(tags.join(","))}&per_page=100`);
    if (!r.ok) {
      rows.push({ where: "gitlab", check: "protected-runners", subject, expected, found: couldNot(r, SCOPES.gitlab), status: "unknown" });
      continue;
    }
    if (r.value.length === 0) {
      rows.push({ where: "gitlab", check: "protected-runners", subject, expected, found: "no runner of the project carries these tags", status: "mismatch" });
      continue;
    }
    const open: string[] = [];
    let unread: string | undefined;
    for (const runner of r.value) {
      const d = await read<{ access_level?: string }>(fetch, t, `/runners/${runner.id}`);
      if (!d.ok) unread = couldNot(d, SCOPES.gitlab);
      else if (d.value.access_level !== "ref_protected") open.push(`#${runner.id}${runner.description ? ` (${runner.description})` : ""} ${d.value.access_level ?? "no access level"}`);
    }
    if (open.length) rows.push({ where: "gitlab", check: "protected-runners", subject, expected, found: open.join("; "), status: "mismatch" });
    else if (unread) rows.push({ where: "gitlab", check: "protected-runners", subject, expected, found: unread, status: "unknown" });
    else rows.push({ where: "gitlab", check: "protected-runners", subject, expected, found: `${r.value.length} runner(s), each ref_protected`, status: "match" });
  }
  const names = applyVariables(s);
  if (envs.length && names.length) {
    const vars: { key: string; protected?: boolean; environment_scope?: string }[] = [];
    let failed: Read<unknown> | undefined;
    for (let page = 1; page <= 50; page++) {
      const r = await read<typeof vars>(fetch, t, `/projects/${pid}/variables?per_page=100&page=${page}`);
      if (!r.ok) {
        failed = r;
        break;
      }
      vars.push(...r.value);
      if (r.value.length < 100) break;
    }
    for (const env of envs) {
      for (const name of names) {
        const subject = `${name} in ${env}`;
        const expected = `scoped to ${env}, protected`;
        if (failed && !failed.ok) {
          rows.push({ where: "gitlab", check: "variable", subject, expected, found: couldNot(failed, SCOPES.gitlab), status: "unknown" });
          continue;
        }
        const defs = vars.filter((v) => v.key === name);
        if (defs.length === 0) {
          rows.push({ where: "gitlab", check: "variable", subject, expected, found: "no project variable of this name (group and instance variables are not read)", status: "unknown" });
          continue;
        }
        const own = defs.find((v) => v.environment_scope === env);
        const found = defs.map((v) => `scope ${v.environment_scope ?? "*"}, ${v.protected ? "protected" : "not protected"}`).join("; ");
        rows.push({ where: "gitlab", check: "variable", subject, expected, found, status: own?.protected ? "match" : "mismatch" });
      }
    }
  }
  return rows;
}

export async function forgejoRows(fetch: Fetch, t: ForgeTarget, c: Identities, s: ProjectSettings): Promise<CheckRow[]> {
  const branches = unique([c.repository.default_branch, ...Object.keys(s.apply?.branches ?? {})]);
  const r = await read<{ rule_name?: string; branch_name?: string }[]>(fetch, t, `/repos/${t.path}/branch_protections`);
  return branches.map((b): CheckRow => {
    if (!r.ok) return { where: "forgejo", check: "protected-branch", subject: b, expected: "protected", found: couldNot(r, SCOPES.forgejo), status: "unknown" };
    const rule = r.value.map((p) => p.rule_name || p.branch_name || "").find((n) => n === b || (n !== "" && globMatch(n, b)));
    return { where: "forgejo", check: "protected-branch", subject: b, expected: "protected", found: rule ? `protected by rule ${rule}` : "not protected", status: rule ? "match" : "mismatch" };
  });
}

// ── AWS ──────────────────────────────────────────────────────────────────────

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

/** Static credentials from the environment, or from the shared credentials file's profile (AWS_PROFILE, else default). */
export function awsCredentials(env: NodeJS.ProcessEnv, readFile: (path: string) => string | undefined): AwsCredentials | undefined {
  if (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) return { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY, ...(env.AWS_SESSION_TOKEN ? { sessionToken: env.AWS_SESSION_TOKEN } : {}) };
  const file = env.AWS_SHARED_CREDENTIALS_FILE || join(env.HOME || homedir(), ".aws", "credentials");
  const text = readFile(file);
  if (!text) return undefined;
  const profile = env.AWS_PROFILE || env.AWS_DEFAULT_PROFILE || "default";
  let section = "";
  const kv: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const head = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (head) section = head[1]!.trim();
    else if (section === profile) {
      const m = /^\s*([A-Za-z_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (m) kv[m[1]!.toLowerCase()] = m[2]!;
    }
  }
  if (!kv.aws_access_key_id || !kv.aws_secret_access_key) return undefined;
  return { accessKeyId: kv.aws_access_key_id, secretAccessKey: kv.aws_secret_access_key, ...(kv.aws_session_token ? { sessionToken: kv.aws_session_token } : {}) };
}

/** IAM's endpoint and signing region for a role's partition. */
function iamEndpoint(partition: string, env: NodeJS.ProcessEnv): { url: string; region: string } {
  const region = partition === "aws-cn" ? "cn-north-1" : partition === "aws-us-gov" ? "us-gov-west-1" : "us-east-1";
  const url = env.AWS_ENDPOINT_URL_IAM || (partition === "aws-cn" ? "https://iam.cn-north-1.amazonaws.com.cn" : partition === "aws-us-gov" ? "https://iam.us-gov.amazonaws.com" : "https://iam.amazonaws.com");
  return { url: url.replace(/\/+$/, ""), region };
}

/** One job a trust must admit: the token's provider (the issuer without https://), `sub` (a pattern with `like`) and `aud`. */
export interface TrustJob {
  provider: string;
  sub: string;
  like: boolean;
  aud: string;
}

const asList = (v: unknown): string[] => (typeof v === "string" ? [v] : Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const providerOf = (federated: string): string => (federated === "*" ? "*" : (federated.split(":oidc-provider/")[1] ?? federated));

/** The jobs a contract's assume_role_policy names. */
export function trustJobs(policy: string): TrustJob[] {
  const doc = JSON.parse(policy) as { Statement?: { Principal?: { Federated?: string }; Condition?: Record<string, Record<string, string>> }[] };
  return (doc.Statement ?? []).flatMap((st) => {
    const provider = providerOf(st.Principal?.Federated ?? "");
    const eq = st.Condition?.StringEquals ?? {};
    const like = st.Condition?.StringLike ?? {};
    const sub = eq[`${provider}:sub`] ?? like[`${provider}:sub`];
    const aud = eq[`${provider}:aud`];
    return sub === undefined || aud === undefined ? [] : [{ provider, sub, like: eq[`${provider}:sub`] === undefined, aud }];
  });
}

/** IAM's StringLike: `*` any run of characters, `?` one. */
const likeMatch = (pattern: string, s: string): boolean => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`).test(s);
const hasWildcard = (s: string): boolean => /[*?]/.test(s);

interface LiveValue {
  value: string;
  like: boolean;
}

/** A live statement's values for `<provider>:<claim>` under StringEquals and StringLike (with ForAnyValue/ForAllValues and IfExists); null when no such condition constrains it. */
function conditionValues(cond: Record<string, Record<string, unknown>> | undefined, provider: string, claim: string): LiveValue[] | null {
  const out: LiveValue[] = [];
  let constrained = false;
  for (const [op, keys] of Object.entries(cond ?? {})) {
    const base = op.replace(/^(ForAnyValue|ForAllValues):/, "");
    if (base !== "StringEquals" && base !== "StringLike") continue;
    for (const [k, v] of Object.entries(keys ?? {})) {
      if (k.toLowerCase() !== `${provider}:${claim}`.toLowerCase()) continue;
      constrained = true;
      for (const value of asList(v)) out.push({ value, like: base === "StringLike" && hasWildcard(value) });
    }
  }
  return constrained ? out : null;
}

/** Whether a live value admits no token the job's own does not: the same value, a literal the job's pattern matches, or a narrower pattern. */
function within(v: LiveValue, expected: string, expectedLike: boolean): boolean {
  if (!v.like) return expectedLike ? likeMatch(expected, v.value) : v.value === expected;
  if (!expectedLike) return false;
  if (v.value === expected) return true;
  const prefix = expected.endsWith("*") && !hasWildcard(expected.slice(0, -1)) ? expected.slice(0, -1) : undefined;
  return prefix !== undefined && v.value.startsWith(prefix);
}

/** Whether a live value admits the job's token. */
function admits(v: LiveValue, expected: string, expectedLike: boolean): boolean {
  if (expectedLike) return v.like && v.value === expected;
  return v.like ? likeMatch(v.value, expected) : v.value === expected;
}

const describeJob = (j: TrustJob): string => `sub ${j.sub}${j.like ? " (like)" : ""} aud ${j.aud}`;

/**
 * Compare a role's live trust document with the jobs it must admit: each job
 * admitted, and every web identity statement no wider than some job (its
 * provider, each sub and aud pair). Returns the problems and a summary of
 * what the live document admits.
 */
export function compareTrust(doc: unknown, jobs: readonly TrustJob[], account: string | undefined): { problems: string[]; found: string } {
  const problems: string[] = [];
  const seen: string[] = [];
  const statements = asStatements(doc);
  const live = statements.filter((st) => st.Effect === "Allow" && asList(st.Action).some((a) => a === "sts:AssumeRoleWithWebIdentity" || a === "sts:*" || a === "*"));
  type Grant = { provider: string; account?: string; subs: LiveValue[] | null; auds: LiveValue[] | null };
  const grants: Grant[] = live.flatMap((st) => {
    const principal = st.Principal === "*" ? ["*"] : asList((st.Principal as { Federated?: unknown } | undefined)?.Federated);
    if (principal.length === 0) return [];
    return principal.map((f) => {
      const provider = providerOf(f);
      const acct = /^arn:[^:]+:iam::(\d{12}):/.exec(f)?.[1];
      return { provider, ...(acct ? { account: acct } : {}), subs: conditionValues(st.Condition, provider, "sub"), auds: conditionValues(st.Condition, provider, "aud") };
    });
  });
  for (const g of grants) {
    const fmt = (vs: LiveValue[] | null): string => (vs === null ? "any" : vs.map((v) => v.value).join(" | ") || "none");
    seen.push(`${g.provider}: sub ${fmt(g.subs)} aud ${fmt(g.auds)}`);
    const mine = jobs.filter((j) => j.provider === g.provider);
    if (g.provider === "*" || mine.length === 0) {
      problems.push(`trusts ${g.provider === "*" ? "any principal" : `the provider ${g.provider}`}, which no job of this role presents`);
      continue;
    }
    if (account && g.account && g.account !== account) problems.push(`trusts ${g.provider} in account ${g.account}, not the role's ${account}`);
    if (g.subs === null) problems.push(`a statement for ${g.provider} has no sub condition, so it admits any subject`);
    if (g.auds === null) problems.push(`a statement for ${g.provider} has no aud condition, so it admits any audience`);
    if (g.subs === null || g.auds === null) continue;
    for (const s of g.subs) {
      for (const a of g.auds) {
        if (!mine.some((j) => within(s, j.sub, j.like) && within(a, j.aud, false))) problems.push(`admits sub ${s.value}${s.like ? " (like)" : ""} with aud ${a.value}, which no job of this role presents`);
      }
    }
  }
  for (const j of jobs) {
    const ok = grants.some((g) => g.provider === j.provider && (!account || !g.account || g.account === account) && (g.subs === null || g.subs.some((s) => admits(s, j.sub, j.like))) && (g.auds === null || g.auds.some((a) => admits(a, j.aud, false))));
    if (!ok) problems.push(`does not admit ${describeJob(j)}`);
  }
  return { problems: unique(problems), found: seen.length ? seen.join("; ") : "no web identity statement" };
}

function asStatements(doc: unknown): { Effect?: string; Action?: unknown; Principal?: unknown; Condition?: Record<string, Record<string, unknown>> }[] {
  const s = (doc as { Statement?: unknown } | null)?.Statement;
  return (Array.isArray(s) ? s : s ? [s] : []) as ReturnType<typeof asStatements>;
}

const sha256 = (b: string): string => createHash("sha256").update(b).digest("hex");

export async function awsRows(c: Identities, deps: ForgeCheckDeps): Promise<CheckRow[]> {
  const roles = new Map<string, TrustJob[]>();
  for (const { st } of stagesOf(c)) {
    if (!st.aws) continue;
    const jobs = trustJobs(st.aws.assume_role_policy);
    for (const arn of [st.aws.role, ...Object.values(st.aws.root_roles)]) {
      if (!arn) continue;
      const have = roles.get(arn) ?? [];
      for (const j of jobs) if (!have.some((h) => JSON.stringify(h) === JSON.stringify(j))) have.push(j);
      roles.set(arn, have);
    }
  }
  if (roles.size === 0) return [];
  const creds = awsCredentials(deps.env, deps.readFile ?? readIfThere);
  const rows: CheckRow[] = [];
  for (const [arn, jobs] of roles) {
    const expected = jobs.map(describeJob).join("; ");
    const row = (found: string, status: CheckStatus): number => rows.push({ where: "aws", check: "trust", subject: arn, expected, found, status });
    if (!creds) {
      row("not checked: no AWS credentials (AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY, or a profile with static keys)", "not-checked");
      continue;
    }
    const m = /^arn:([^:]+):iam::(\d{12}):role\/(?:.*\/)?([^/]+)$/.exec(arn);
    if (!m) {
      row(`not a role ARN, so it cannot be read`, "unknown");
      continue;
    }
    const [, partition, account, name] = m;
    const { url: base, region } = iamEndpoint(partition!, deps.env);
    const url = `${base}/?Action=GetRole&RoleName=${encodeStrict(name!)}&Version=2010-05-08`;
    const headers = sign({ region, ...creds }, "GET", url, {}, sha256(""), (deps.now ?? (() => new Date()))(), "iam");
    let res: Awaited<ReturnType<Fetch>>;
    try {
      res = await deps.fetch(url, { method: "GET", headers });
    } catch (e) {
      if (e instanceof ReadOnlyError) throw e;
      row(`could not read: ${(e as Error).message}`, "unknown");
      continue;
    }
    const xml = await res.text();
    if (!res.ok) {
      const code = xmlText(xml, "Code") ?? String(res.status);
      if (code === "NoSuchEntity") row("no such role", "mismatch");
      else row(`could not read (${res.status} ${code}); ${SCOPES.aws}`, "unknown");
      continue;
    }
    const raw = xmlText(xml, "AssumeRolePolicyDocument");
    let doc: unknown;
    try {
      doc = JSON.parse(decodeURIComponent(raw ?? ""));
    } catch {
      row("GetRole answered without a trust policy terragucci could read", "unknown");
      continue;
    }
    const { problems, found } = compareTrust(doc, jobs, account);
    row(problems.length ? `${found}; ${problems.join("; ")}` : found, problems.length ? "mismatch" : "match");
  }
  return rows;
}

function readIfThere(path: string): string | undefined {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return undefined;
  }
}

// ── GCP ──────────────────────────────────────────────────────────────────────

/** A CEL expression in disjunctive normal form: each term a set of conjuncts, compared as text without spaces outside quotes. Undefined past `limit` terms. */
export function celTerms(expr: string, limit = 256): string[][] | undefined {
  const norm = (s: string): string => {
    let out = "";
    let q: string | undefined;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i]!;
      if (q) {
        out += ch;
        if (ch === "\\") out += s[++i] ?? "";
        else if (ch === q) q = undefined;
      } else if (ch === "'" || ch === '"') {
        q = ch;
        out += "'";
      } else if (!/\s/.test(ch)) out += ch;
    }
    return out.replace(/"/g, "'");
  };
  const split = (s: string, op: "&&" | "||"): string[] => {
    const parts: string[] = [];
    let depth = 0;
    let q: string | undefined;
    let start = 0;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i]!;
      if (q) {
        if (ch === "\\") i++;
        else if (ch === q) q = undefined;
      } else if (ch === "'" || ch === '"') q = ch;
      else if (ch === "(") depth++;
      else if (ch === ")") depth--;
      else if (depth === 0 && s.startsWith(op, i)) {
        parts.push(s.slice(start, i));
        start = i + 2;
        i++;
      }
    }
    parts.push(s.slice(start));
    return parts.map((p) => p.trim());
  };
  const strip = (s: string): string => {
    let t = s.trim();
    while (t.startsWith("(") && t.endsWith(")")) {
      // Only when the outer parentheses wrap the whole expression.
      let depth = 0;
      let whole = true;
      for (let i = 0; i < t.length; i++) {
        if (t[i] === "(") depth++;
        else if (t[i] === ")") depth--;
        if (depth === 0 && i < t.length - 1) {
          whole = false;
          break;
        }
      }
      if (!whole) break;
      t = t.slice(1, -1).trim();
    }
    return t;
  };
  const dnf = (s: string): string[][] | undefined => {
    const e = strip(s);
    const ors = split(e, "||");
    if (ors.length > 1) {
      const out: string[][] = [];
      for (const o of ors) {
        const d = dnf(o);
        if (!d) return undefined;
        out.push(...d);
      }
      return out.length > limit ? undefined : out;
    }
    const ands = split(e, "&&");
    if (ands.length === 1) return [[norm(e)]];
    let out: string[][] = [[]];
    for (const a of ands) {
      const d = dnf(a);
      if (!d) return undefined;
      out = out.flatMap((t) => d.map((u) => [...t, ...u]));
      if (out.length > limit) return undefined;
    }
    return out;
  };
  return dnf(expr);
}

/** Whether `live` admits no token `expected` refuses: each of its terms holds every conjunct of some term of `expected`. */
export function celNarrowerOrEqual(live: string, expected: string): boolean {
  const l = celTerms(live);
  const e = celTerms(expected);
  if (!l || !e) return false;
  return l.every((lt) => e.some((et) => et.every((c) => lt.includes(c))));
}

export async function gcpRows(c: Identities, deps: ForgeCheckDeps): Promise<CheckRow[]> {
  const providers = new Map<string, string[]>();
  for (const { st } of stagesOf(c)) {
    if (!st.gcp) continue;
    const have = providers.get(st.gcp.workload_identity_provider) ?? [];
    if (!have.includes(st.gcp.attribute_condition)) have.push(st.gcp.attribute_condition);
    providers.set(st.gcp.workload_identity_provider, have);
  }
  const token = deps.env.GOOGLE_OAUTH_ACCESS_TOKEN;
  const rows: CheckRow[] = [];
  for (const [name, conditions] of providers) {
    const expected = conditions.length === 1 ? conditions[0]! : conditions.map((x) => `(${x})`).join(" || ");
    const row = (found: string, status: CheckStatus): number => rows.push({ where: "gcp", check: "trust", subject: name, expected: `${expected}, or narrower`, found, status });
    if (!token) {
      row("not checked: no GCP credentials (GOOGLE_OAUTH_ACCESS_TOKEN)", "not-checked");
      continue;
    }
    if (!/^projects\/[^/]+\/locations\/[^/]+\/workloadIdentityPools\/[^/]+\/providers\/[^/]+$/.test(name)) {
      row("not a provider's full resource name, so it cannot be read", "unknown");
      continue;
    }
    const url = `https://iam.googleapis.com/v1/${name}`;
    let res: Awaited<ReturnType<Fetch>>;
    try {
      res = await deps.fetch(url, { method: "GET", headers: { authorization: `Bearer ${token}`, accept: "application/json" } });
    } catch (e) {
      if (e instanceof ReadOnlyError) throw e;
      row(`could not read: ${(e as Error).message}`, "unknown");
      continue;
    }
    if (!res.ok) {
      if (res.status === 404) row("no such provider", "mismatch");
      else row(`could not read (${res.status}); ${SCOPES.gcp}`, "unknown");
      continue;
    }
    const live = ((await res.json()) as { attributeCondition?: string }).attributeCondition;
    if (!live) row("no attribute condition: any token of the issuer", "mismatch");
    else if (celNarrowerOrEqual(live, expected)) row(celNarrowerOrEqual(expected, live) ? live : `${live} (narrower)`, "match");
    else row(`${live} (wider, or not provably narrower)`, "mismatch");
  }
  return rows;
}

// ── Azure ────────────────────────────────────────────────────────────────────

/** The variable holding a Microsoft Graph access token. */
export const azureTokenVariable = "AZURE_GRAPH_TOKEN";

interface Credential {
  issuer: string;
  subject: string | null;
  expression: string | null;
  audiences: string[];
}

const credentialText = (x: Credential): string => `issuer ${x.issuer} ${x.subject !== null ? `subject ${x.subject}` : `claims ${x.expression}`} aud ${x.audiences.join(", ")}`;
const sameCredential = (a: Credential, b: Credential): boolean =>
  a.issuer === b.issuer && a.subject === b.subject && a.expression === b.expression && [...a.audiences].sort().join("\n") === [...b.audiences].sort().join("\n");

export async function azureRows(c: Identities, deps: ForgeCheckDeps): Promise<CheckRow[]> {
  const apps = new Map<string, Credential[]>();
  for (const { st } of stagesOf(c)) {
    const z = st.azure;
    if (!z) continue;
    const cred: Credential = { issuer: z.issuer, subject: z.subject, expression: z.claims_matching_expression, audiences: z.audiences };
    for (const id of unique([z.client_id, ...Object.values(z.root_client_ids)])) {
      const have = apps.get(id) ?? [];
      if (!have.some((h) => sameCredential(h, cred))) have.push(cred);
      apps.set(id, have);
    }
  }
  const token = deps.env[azureTokenVariable];
  const rows: CheckRow[] = [];
  for (const [id, creds] of apps) {
    const row = (found: string, status: CheckStatus): number => rows.push({ where: "azure", check: "trust", subject: id, expected: creds.map(credentialText).join("; "), found, status });
    if (!token) {
      row(`not checked: no Azure credentials (${azureTokenVariable})`, "not-checked");
      continue;
    }
    const url = `https://graph.microsoft.com/v1.0/applications(appId='${encodeURIComponent(id)}')/federatedIdentityCredentials`;
    let res: Awaited<ReturnType<Fetch>>;
    try {
      res = await deps.fetch(url, { method: "GET", headers: { authorization: `Bearer ${token}`, accept: "application/json" } });
    } catch (e) {
      if (e instanceof ReadOnlyError) throw e;
      row(`could not read: ${(e as Error).message}`, "unknown");
      continue;
    }
    if (!res.ok) {
      if (res.status === 404) row("no application with this appId (a managed identity's credentials are not read)", "unknown");
      else row(`could not read (${res.status}); ${SCOPES.azure}`, "unknown");
      continue;
    }
    const value = ((await res.json()) as { value?: { name?: string; issuer?: string; subject?: string | null; audiences?: string[]; claimsMatchingExpression?: string | { value?: string } | null }[] }).value ?? [];
    const live = value.map((v) => ({
      name: v.name ?? "",
      cred: {
        issuer: v.issuer ?? "",
        subject: v.subject ?? null,
        expression: typeof v.claimsMatchingExpression === "string" ? v.claimsMatchingExpression : (v.claimsMatchingExpression?.value ?? null),
        audiences: v.audiences ?? [],
      },
    }));
    const missing = creds.filter((e) => !live.some((l) => sameCredential(l.cred, e)));
    const extra = live.filter((l) => !creds.some((e) => sameCredential(l.cred, e)));
    const problems = [...missing.map((m) => `missing ${credentialText(m)}`), ...extra.map((x) => `wider: ${x.name ? `${x.name}: ` : ""}${credentialText(x.cred)}`)];
    const found = live.length ? live.map((l) => credentialText(l.cred)).join("; ") : "no federated credential";
    row(problems.length ? `${found}; ${problems.join("; ")}` : found, problems.length ? "mismatch" : "match");
  }
  return rows;
}

// ── the command ──────────────────────────────────────────────────────────────

const CLOUDS: readonly CheckWhere[] = ["aws", "gcp", "azure"];

/** The forge's address: the config's url, or https://<host>. */
function originOf(settings: ProjectSettings, host: string): string {
  if (settings.url) {
    try {
      return new URL(settings.url).origin;
    } catch {
      // Not a URL: the host it names.
    }
  }
  return `https://${host}`;
}

export function countRows(rows: readonly CheckRow[]): Record<CheckStatus, number> {
  const counts = Object.fromEntries(CHECK_STATUSES.map((s) => [s, 0])) as Record<CheckStatus, number>;
  for (const r of rows) counts[r.status]++;
  return counts;
}

/**
 * `forge check` over the config at `path`: the contract, with the live
 * default branch (and on Forgejo the numeric ids the token's subject holds),
 * next to what the forge and each configured cloud answer.
 */
export async function forgeCheck(path: string, file: string, flags: ForgeCheckFlags, deps: ForgeCheckDeps): Promise<ForgeCheck> {
  const fetch = readOnly(deps.fetch);
  const d: ForgeCheckDeps = { ...deps, fetch };
  const { requireClouds, ...idFlags } = flags;
  const first = await configIdentities(path, file, idFlags);
  const config = await loadConfig(path);
  const settings: ProjectSettings = config.projects ? resolveProject(config, idFlags.project!) : resolveRepo(config);
  const forge = first.forge;
  const target: ForgeTarget = { forge, origin: originOf(settings, first.repository.host), path: first.repository.path, token: deps.env[settings.token_env ?? DEFAULT_TOKEN_ENV[forge]] ?? "" };
  const rows: CheckRow[] = [];
  const repo = await readRepo(fetch, target);
  const live = repo.ok ? repo.value : {};
  const contract = await configIdentities(path, file, {
    ...idFlags,
    ...(idFlags.defaultBranch ?? live.defaultBranch ? { defaultBranch: idFlags.defaultBranch ?? live.defaultBranch } : {}),
    ...(idFlags.ownerId ?? live.ownerId ? { ownerId: idFlags.ownerId ?? live.ownerId } : {}),
    ...(idFlags.repoId ?? live.repoId ? { repoId: idFlags.repoId ?? live.repoId } : {}),
  });
  if (!repo.ok) {
    const need = forge === "github" ? SCOPES.github : forge === "gitlab" ? SCOPES.gitlab : SCOPES.forgejo;
    rows.push({ where: forge, check: "repository", subject: target.path, expected: "readable", found: `${couldNot(repo, `${need}, in ${settings.token_env ?? DEFAULT_TOKEN_ENV[forge]}`)}`, status: "unknown" });
  } else if (forge === "github") rows.push(...(await githubRows(fetch, target, contract)));
  else if (forge === "gitlab") rows.push(...(await gitlabRows(fetch, target, contract, settings)));
  else rows.push(...(await forgejoRows(fetch, target, contract, settings)));
  rows.push(...(await awsRows(contract, d)), ...(await gcpRows(contract, d)), ...(await azureRows(contract, d)));
  const counts = countRows(rows);
  const unchecked = rows.some((r) => r.status === "not-checked" && CLOUDS.includes(r.where));
  return { schema: FORGE_CHECK_SCHEMA, file: contract.file, forge, repository: contract.repository, rows, counts, ok: counts.mismatch === 0 && !(requireClouds && unchecked) };
}

/** The exit code: 1 on a mismatch, or a cloud left unchecked with --require-clouds; 0 otherwise. */
export const forgeCheckExit = (r: ForgeCheck): number => (r.ok ? 0 : 1);

const MATCH_WORD: Record<CheckStatus, string> = { match: "yes", mismatch: "no", unknown: "unknown", "not-checked": "not checked" };

/** The table `forge check` prints without --json, and a line of counts. */
export function describeForgeCheck(r: ForgeCheck): string {
  const head = ["WHERE", "CHECK", "SUBJECT", "EXPECTED", "FOUND", "MATCH"];
  const body = r.rows.map((x) => [x.where, x.check, x.subject, x.expected, x.found, MATCH_WORD[x.status]]);
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i]!.length)));
  const line = (cells: string[]): string => cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i]!))).join("  ");
  const c = r.counts;
  const out = [`${r.file}: ${r.forge} ${r.repository.host}/${r.repository.path} (default branch ${r.repository.default_branch})`, ""];
  if (body.length) out.push(line(head), ...body.map(line), "");
  else out.push("nothing to check: no forge environment, apply runner, protected branch or cloud identity in the config", "");
  out.push(`${c.match} match, ${c.mismatch} mismatch, ${c.unknown} could not be read, ${c["not-checked"]} not checked`);
  return out.join("\n");
}
