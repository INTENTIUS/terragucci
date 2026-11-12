/**
 * terragucci's plan, re-plan and note jobs on chant's product plan
 * (terragucci issue 1411; chant issues 4799, 4963, 4972, 4979, 5003, 5004).
 *
 * chant writes the jobs: the plan job (the pending status, the trade, the
 * checkout, the control read, the installs, the plan verb, the hand-off of
 * its report), the note job (`pr-post`, with the drift watch and the note
 * words), and on GitHub and Forgejo the comment re-plan and its note job.
 * terragucci gives its words and its names, so the workflow file, the jobs
 * (`plan`, `plan-note`, `replan`, `replan-note`), the required check
 * `terragucci/plan` and the `terragucci-report` artifacts stay as they were.
 *
 * The plan verb is terragucci's: `terragucci stage tf-plan` writes the
 * report, and `terragucci plan-handoff` turns it into the plan note hand-off
 * (`pr-plan-note.json`), which `pr-post` renders with terragucci's note
 * words, the waves marker among them, and the `terragucci:plan roots=` line
 * under chant's marker.
 *
 * On GitLab the plan job keeps its report and the merge request widget's
 * terraform report, and the note job runs in a pipeline of the default
 * branch started with CHANT_PLAN_NOTES=1: the plan notes schedule that
 * `terragucci init` names.
 */
import { buildProductPlanGithubDoc } from "@intentius/chant-lexicon-github/components/product-plan-pipeline";
import { generateGitlabProductPlanPipeline } from "@intentius/chant-lexicon-gitlab/components/product-plan-pipeline";
import type { ProductPlanOptions, ProductPlanSetupStep } from "@intentius/chant/components/product-plan";
import { resolveCloudIdentity, type CloudIdentityDeclaration, type CloudIdentityRule, type CloudTradeSpec } from "@intentius/chant/ci-identity";
import type { CloudLoginSpec } from "@intentius/chant/ci-login";
import type { ScheduledWatch } from "@intentius/chant/op/schedule-overdue";
import type { PipelineEvidence } from "@intentius/chant/ci-evidence-jobs";
import type { ForgeName, OidcSettings, RolePair } from "./config";
import { TERRAGUCCI_WORDS } from "./ci-words";
import { rootRoles } from "./cloud-identity";
import type { ResolvedControl } from "./control-repo";
import { chantControlTarget } from "./control-repo";
import { NOTE_WORDS } from "./report/views";

/** The workflow file, the jobs and the status context branch protection already names. */
export const PLAN_NAMES = {
  workflow: "terragucci",
  jobNames: { plan: "plan", note: "plan-note", replan: "replan", replanNote: "replan-note" },
  statusContext: "terragucci/plan",
} as const;

/** The plan note's own line under chant's marker: `<!-- terragucci:plan roots=a,b -->`, which a stale mark and the MCP note read. */
export const PLAN_PRODUCT_MARKER = "terragucci:plan";

/** The environment the plan jobs and `pr-post` name: chant's note marker is `<!-- chant-pr:default -->`. */
export const PLAN_ENV = "default";

/** The variable a GitLab plan notes schedule sets, as chant's plan-note job's rule reads it. */
export const PLAN_NOTES_VAR = "CHANT_PLAN_NOTES";

/** The value of TERRAGUCCI_SCHEDULE on the plan notes schedule, so no other scheduled job of terragucci's runs in it. */
export const PLAN_NOTES_SCHEDULE = "plan-notes";

/** The cron `terragucci init` names for GitLab's plan notes schedule: every five minutes. */
export const PLAN_NOTES_CRON = "*/5 * * * *";

/** What the product plan is given from the pipeline. */
export interface PlanJobsInput {
  forge: ForgeName;
  image: string;
  /** The plan verb's shell (render.ts planVerbScript), the step's last line. */
  command: string;
  /** Variables of the whole plan job, every step's (GitHub, Forgejo: secrets as expressions). */
  env: Record<string, string>;
  /** The plan identities: traded before the checkout, or with `login` (oidc.azure) logged in to in the plan step's job. */
  trade?: CloudTradeSpec;
  login?: CloudLoginSpec;
  /** Steps after the checkout and the control read: the installs and, on GitHub and Forgejo, the Terragrunt cache's restore. */
  setup: ProductPlanSetupStep[];
  /** GitLab's cache of the plan job. */
  cache?: unknown;
  control?: ResolvedControl;
  /** `drift:`'s schedule, which the note job checks for having stopped. */
  watches?: ScheduledWatch[];
  /** GitHub and Forgejo: the comments other jobs answer, which the re-plan leaves alone. */
  others: string[];
  /** `atlantis_comments`: `atlantis plan` re-plans too, read with TG_ATLANTIS_COMMENTS set. */
  atlantis?: boolean;
  /** GitHub and Forgejo: the note job's lines before `pr-post` (notices) and after it (terragucci/approval). */
  noteSteps?: { before: string[]; after: string[] };
  /**
   * `evidence`: chant's runner identity (terragucci issue 1413). The note
   * job signs the plan job's `plan` and `policy` checks before it posts; on
   * GitLab a `plan-evidence` job of the plan notes pipeline signs them.
   */
  evidence?: PipelineEvidence;
}

/** The product plan's options for terragucci, on every forge. */
export function planOptions(input: PlanJobsInput, o: { noReply?: boolean; reach?: string } = {}): ProductPlanOptions {
  const github = input.forge !== "gitlab";
  return {
    command: input.command,
    forks: "skip",
    ...PLAN_NAMES,
    jobNames: { ...PLAN_NAMES.jobNames },
    workflowFile: input.forge === "github" ? ".github/workflows/terragucci.yml" : input.forge === "forgejo" ? ".forgejo/workflows/terragucci.yml" : ".gitlab/terragucci.yml",
    artifact: "terragucci-report",
    reportDir: "terragucci-report",
    noteWords: { ...NOTE_WORDS, productMarker: PLAN_PRODUCT_MARKER },
    ...(Object.keys(input.env).length > 0 ? { env: input.env } : {}),
    ...(input.trade ? { trade: input.trade } : {}),
    ...(input.login && Object.keys(input.login).length > 0 ? { login: input.login } : {}),
    ...(github ? { pending: true } : {}),
    ...(input.control ? { controlRead: chantControlTarget(input.control) as never } : {}),
    ...(input.setup.length > 0 ? { setup: input.setup } : {}),
    ...(input.watches?.length ? { watches: input.watches } : {}),
    // GitLab's re-plan stays the comments poll's, which plans the merge request again in its own pipeline.
    // `noReply`: for chant's comment job, which answers `/terragucci apply` alone in terragucci's workflow (githubCommentJob).
    ...(github ? { replan: { dispatch: { argument: "root" }, ...(o.noReply ? {} : { reply: { others: input.others } }), notAffected: true } } : {}),
    ...(github && input.noteSteps && (input.noteSteps.before.length > 0 || input.noteSteps.after.length > 0) ? { noteSteps: { ...input.noteSteps, pullRequest: true } } : {}),
    // GitLab's merge request widget reads the plan's counts from the terraform report.
    ...(github ? {} : { artifacts: { reports: { terraform: "{output}/gitlab-terraform.json" } } }),
    // Before merge: what the change reaches, whose locks chant takes as it decides a head, beside terragucci's own (gate tf-apply).
    ...(o.reach ? { reach: { command: o.reach, gate: "tf-apply" } } : {}),
  };
}

/** The words the plan is written with: the plan command alone, since the plan's jobs answer no other, and with atlantis_comments its alias. */
function planWords(atlantis: boolean): typeof TERRAGUCCI_WORDS {
  return { ...TERRAGUCCI_WORDS, commands: { plan: "plan" }, aliases: atlantis ? TERRAGUCCI_WORDS.aliases.filter((a) => a.command === "plan") : [] };
}

/** GitHub and Forgejo: chant's plan, plan-note, replan and replan-note jobs, as the workflow's jobs. */
export function githubPlanJobs(input: PlanJobsInput): Array<[string, Record<string, unknown>]> {
  const forge = input.forge as "github" | "forgejo";
  const { doc } = buildProductPlanGithubDoc(forge, PLAN_ENV, { words: planWords(input.atlantis === true), image: input.image, productPlan: planOptions(input), ...(input.evidence ? { evidence: input.evidence } : {}) });
  const jobs = doc.jobsDoc as Record<string, Record<string, unknown>>;
  const names = PLAN_NAMES.jobNames;
  const out: Array<[string, Record<string, unknown>]> = [];
  for (const name of [names.plan, names.note, names.replan, names.replanNote]) {
    const job = jobs[name];
    if (!job) throw new Error(`chant's product plan wrote no ${name} job`);
    const container = typeof job.container === "string" ? { image: job.container } : job.container;
    out.push([name, { ...job, container }]);
  }
  return out;
}

/**
 * GitHub and Forgejo: chant's comment job, `apply-comment` (chant issues 4984,
 * 5022, 5027). `/terragucci apply` on a merged pull request re-runs the
 * waves' jobs of its merge commit that did not succeed; before merge it
 * decides the open pull request's head and dispatches the waves for it.
 * `waves` are the product pipeline's options for them: the waves' shape,
 * the spec file, the job names and the before-merge settings.
 */
export function githubCommentJob(input: PlanJobsInput, waves: Record<string, unknown>, cond: string, reach?: string): Record<string, unknown> {
  const forge = input.forge as "github" | "forgejo";
  // Before merge (`reach`) it answers lock and unlock too (chant issue 5061).
  const words = { ...TERRAGUCCI_WORDS, commands: { plan: "plan", apply: "apply", ...(reach ? { lock: "lock", unlock: "unlock" } : {}) }, aliases: input.atlantis ? TERRAGUCCI_WORDS.aliases.filter((a) => a.command === "plan" || a.command === "apply") : [] };
  const { doc } = buildProductPlanGithubDoc(forge, PLAN_ENV, { words, image: input.image, productPlan: planOptions(input, { noReply: true, ...(reach ? { reach } : {}) }), ...waves } as never);
  const job = (doc.jobsDoc as Record<string, Record<string, unknown>>)["apply-comment"];
  if (!job) throw new Error("chant's product pipeline wrote no apply-comment job");
  const container = typeof job.container === "string" ? { image: job.container } : job.container;
  // The re-plan answers every other comment (its reply), and terragucci's other jobs their own: this job starts on `/terragucci apply`.
  return { ...job, container, if: cond };
}

/** GitLab: the job of the plan notes pipeline that signs the plan job's checks, with `evidence`. */
export const PLAN_EVIDENCE_JOB = `${PLAN_NAMES.jobNames.plan}-evidence`;

/**
 * GitLab: chant's plan job and its note job, which runs in the plan notes
 * pipeline, and with `evidence` the `plan-evidence` job before the note.
 */
export function gitlabPlanJobs(input: PlanJobsInput): { plan: Record<string, unknown>; note: Record<string, unknown>; evidence?: Record<string, unknown> } {
  const { entries } = generateGitlabProductPlanPipeline(PLAN_ENV, { words: planWords(input.atlantis === true), image: input.image, productPlan: planOptions(input), ...(input.cache !== undefined ? { cache: input.cache } : {}), ...(input.evidence ? { evidence: input.evidence } : {}) });
  const found = new Map(entries);
  const plan = found.get(PLAN_NAMES.jobNames.plan) as Record<string, unknown> | undefined;
  const note = found.get(PLAN_NAMES.jobNames.note) as Record<string, unknown> | undefined;
  if (!plan || !note) throw new Error("chant's GitLab product plan wrote no plan or plan-note job");
  if (!input.evidence) return { plan, note };
  const evidence = found.get(PLAN_EVIDENCE_JOB) as Record<string, unknown> | undefined;
  if (!evidence) throw new Error(`chant's GitLab product plan wrote no ${PLAN_EVIDENCE_JOB} job`);
  return { plan, note, evidence };
}

/** The rules of one cloud: a rule with `targets` per root glob, then the job's own identity. */
const rules = (pairs: [string, string][], own: string | undefined): CloudIdentityRule[] => [
  ...pairs.map(([g, id]): CloudIdentityRule => ({ targets: [g], plan: id, apply: id })),
  ...(own ? [{ plan: own, apply: own }] : []),
];

/** `spec`'s targets, with each of `ids` that none names yet as a target with no glob, so the trade trades it too. */
function withEvery<T extends { targets?: Array<Record<string, unknown>> }>(spec: T, key: string, ids: readonly string[]): T {
  const targets = [...(spec.targets ?? [])];
  for (const id of ids) if (!targets.some((t) => t[key] === id)) targets.push({ targets: [], [key]: id });
  return { ...spec, targets };
}

/**
 * The plan identities as chant's trade (`@intentius/chant/ci-identity`): the
 * plan role, each root glob's plan role, a Terragrunt repo's unit roles and
 * `reports.role`, and GCP's plan service accounts. The trade runs before the
 * change is checked out, and the plan step holds the traded credentials and
 * no OIDC token. Undefined when no identity is named, and for oidc.azure,
 * whose provider takes only the token itself.
 */
export function planTrade(oidc: OidcSettings | undefined, credentials: Record<string, RolePair> | undefined, reportsRole: string | undefined, env: Record<string, string>, audience: string): CloudTradeSpec | undefined {
  return stageTrade("plan", oidc, credentials, reportsRole, env, audience);
}

/**
 * The apply identities as chant's trade, for a wave job of chant's Op waves
 * (the wave's or a job group's `cloud`): the apply role, each root glob's
 * apply role, a Terragrunt repo's unit roles and `reports.role` (the report
 * upload), and GCP's apply service accounts. chant trades before the
 * checkout, so the wave's command holds the credentials and no OIDC token.
 * Undefined when no identity is named, and for oidc.azure.
 */
export function applyTrade(oidc: OidcSettings | undefined, credentials: Record<string, RolePair> | undefined, reportsRole: string | undefined, env: Record<string, string>, audience: string): CloudTradeSpec | undefined {
  return stageTrade("apply", oidc, credentials, reportsRole, env, audience);
}

function stageTrade(stage: "plan" | "apply", oidc: OidcSettings | undefined, credentials: Record<string, RolePair> | undefined, reportsRole: string | undefined, env: Record<string, string>, audience: string): CloudTradeSpec | undefined {
  if (oidc?.azure) return undefined;
  const decl: CloudIdentityDeclaration = {};
  const byGlob = oidc?.roles && Object.keys(oidc.roles).length > 0 ? rootRoles(oidc.roles, stage) : [];
  const units = credentials ? rootRoles(credentials, stage) : [];
  const own = oidc?.plan_role && oidc.apply_role ? (stage === "plan" ? oidc.plan_role : oidc.apply_role) : undefined;
  const roles = [...new Set([own, ...byGlob.map(([, r]) => r), ...units.map(([, r]) => r), reportsRole].filter((r): r is string => Boolean(r)))];
  const endpoint = env.AWS_ENDPOINT_URL_STS || env.AWS_ENDPOINT_URL;
  if (roles.length > 0) decl.aws = { region: env.AWS_REGION || env.AWS_DEFAULT_REGION || "us-east-1", audience, ...(endpoint ? { endpoint: endpoint.replace(/\/+$/, "") } : {}), rules: rules(byGlob, own) };
  const gcp = oidc?.gcp;
  const gcpByGlob = gcp?.roles && Object.keys(gcp.roles).length > 0 ? rootRoles(gcp.roles, stage) : [];
  const ownSa = stage === "plan" ? gcp?.plan_service_account : gcp?.apply_service_account;
  const sas = [...new Set([ownSa, ...gcpByGlob.map(([, s]) => s)].filter((s): s is string => Boolean(s)))];
  if (gcp && sas.length > 0) {
    decl.gcp = { provider: gcp.workload_identity_provider, ...(gcp.token_url ? { stsEndpoint: gcp.token_url } : {}), rules: rules(gcpByGlob, ownSa) };
  }
  const plan = resolveCloudIdentity(decl, PLAN_ENV)?.plan ?? {};
  // Roles no root's glob takes (a Terragrunt unit's, reports.role) are traded as targets with no glob.
  const aws = plan.aws
    ? withEvery(plan.aws, "role", roles)
    : roles.length > 0
      ? { targets: roles.map((role) => ({ targets: [], role })), region: decl.aws!.region!, audience, ...(decl.aws!.endpoint ? { endpoint: decl.aws!.endpoint } : {}) }
      : undefined;
  const spec: CloudTradeSpec = { ...(aws ? { aws } : {}), ...(plan.gcp ? { gcp: withEvery(plan.gcp, "serviceAccount", sas) } : {}) };
  return Object.keys(spec).length > 0 ? spec : undefined;
}
