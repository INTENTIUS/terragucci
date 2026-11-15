/**
 * `runtime: prow` and its `prow:` key: the stages run as ProwJobs on a
 * Prow installation in front of a GitHub repository, in place of a
 * workflow file (./render-prow.ts).
 *
 * A Prow job is one pod on a build cluster. The checks presubmit runs on
 * `cluster` and holds no credential, so it runs for a fork's pull request
 * once Prow's `/ok-to-test` lets it. The jobs that hold credentials (the
 * plan and apply postsubmits on the default branch, and the drift
 * periodic) run on `trusted_cluster` under the plan or apply service
 * account, which the cluster binds to a cloud identity (GKE Workload
 * Identity, EKS IRSA or Pod Identity, AKS Workload Identity). No job asks
 * a forge for an OIDC token, so `oidc` does not go with this runtime.
 *
 * `plan_before_merge` adds a plan presubmit on the trusted cluster, which
 * plans a pull request from this repository and posts the plan note.
 * Installations that keep presubmits off the clusters that hold
 * credentials leave it off: there the checks run before merge, and the
 * plan and the apply after it.
 */
/** A Kubernetes object name: a DNS-1123 subdomain. */
export const DNS_SUBDOMAIN = /^(?=.{1,253}$)[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/;

/** The Kubernetes Secret on the trusted cluster that holds the GitHub token the jobs there post with. */
export interface ProwTokenSecret {
  name: string;
  /** The key in the Secret. Default `token`. */
  key?: string;
}

export interface ProwSettings {
  /**
   * The repository whose job config holds these jobs, as owner/name, when
   * it is not this one (a Prow installation's central config repository).
   * init still writes the file here, at `path`, and says where it goes.
   */
  config_repo?: string;
  /** Where init writes the job config in this repository. Default `prow/terragucci.yaml`. */
  path?: string;
  /** The build cluster of the checks presubmit, which holds no credential. Default `default`, Prow's own. */
  cluster?: string;
  /** The build cluster of the plan, apply and drift jobs, whose service accounts hold the cloud identities. */
  trusted_cluster: string;
  /** The namespace the jobs' pods run in, when the installation sets one per job. */
  namespace?: string;
  /** The pods' Kubernetes service accounts on the trusted cluster: a read-only one for plan and drift, a write one for apply. */
  service_accounts: { plan: string; apply: string };
  /** The Secret on the trusted cluster with the GitHub token the plan, apply and drift jobs post with. */
  token_secret: ProwTokenSecret;
  /** A plan presubmit on the trusted cluster, which plans a pull request from this repository and posts its note. Default false. */
  plan_before_merge?: boolean;
  /** Deck's address, such as https://prow.example.com, so the report and the notes link each job. */
  deck?: string;
}

export const PROW_KEYS = ["config_repo", "path", "cluster", "trusted_cluster", "namespace", "service_accounts", "token_secret", "plan_before_merge", "deck"] as const;

/** Where init writes the job config when `prow.path` is unset. */
export const PROW_JOBS_PATH = "prow/terragucci.yaml";

/** The key of `prow.token_secret` when it names none. */
export const PROW_TOKEN_KEY = "token";

/**
 * The keys whose jobs or credentials a Prow job config does not carry, and
 * why, each refused under `runtime: prow`: a pipeline of ProwJobs renders the
 * checks, plan, apply and drift jobs, and nothing more.
 */
export const PROW_REFUSED: Record<string, string> = {
  oidc: "the jobs take their cloud identity from the pod's service account (prow.service_accounts), not from a forge's OIDC token",
  runner: "a ProwJob runs on a build cluster; set prow.cluster and prow.trusted_cluster",
  pass: "a ProwJob gets no CI secrets by name; the pod's service account reaches the cloud",
  environments: "the waves apply in one ProwJob, under one apply service account",
  secrets: "the root's secret values are read with an OIDC identity, and the jobs have the pod's",
  rollouts: "the rollout job is a scheduled forge workflow",
  templates: "the request workflow is a forge workflow",
  review: "the review workflow is a forge workflow",
  agent: "the agent jobs are forge workflows",
  ephemeral: "the ephemeral copies and their sweep are forge workflows",
  control: "the control dispatch is a forge workflow",
  comments: "the comments schedule is GitLab's",
  gitlab: "Prow serves GitHub",
  own_jobs: "own_jobs are written into a forge workflow",
  atlantis_comments: "Prow starts the jobs from its own commands, not from comments the pipeline reads",
  evidence: "the runner identity signs from a forge job's OIDC token",
  notify: "the webhook secrets are a forge's CI secrets",
  cost: "the estimator's key is a forge CI secret",
  respond: "the responses run in forge jobs of their own",
};

/** `apply.<key>` refused under runtime: prow, and why. */
export const PROW_REFUSED_APPLY: Record<string, string> = {
  when: "a pull request applies after it merges, in the apply postsubmit",
  merge: "Tide merges the pull request",
  merge_token_env: "Tide merges the pull request",
  branches: "the apply postsubmit runs on the default branch",
  resume: "the resume job is a scheduled forge workflow; rerun the apply job from Deck once the wave is approved",
};

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** Problems with `runtime: prow` and the `prow:` key in one block of settings. */
export function prowProblems(s: Record<string, unknown>, where: string): string[] {
  const out: string[] = [];
  const prow = s.runtime === "prow";
  if (s.prow !== undefined && !prow) out.push(`${where}.prow goes with runtime: prow; set runtime: prow, or drop prow`);
  if (!prow) {
    const mode = isObject(s.approval) ? s.approval.mode : s.approval;
    if (mode === "prow-labels") out.push(`${where}.approval: prow-labels reads Prow's lgtm and approved labels, which only runtime: prow has`);
    return out;
  }
  if (s.forge !== undefined && s.forge !== "github") out.push(`${where}.runtime: prow serves GitHub repositories; forge is ${JSON.stringify(s.forge)}`);
  for (const [k, why] of Object.entries(PROW_REFUSED)) if (s[k] !== undefined) out.push(`${where}.${k} does not go with runtime: prow: ${why}`);
  if (isObject(s.apply)) for (const [k, why] of Object.entries(PROW_REFUSED_APPLY)) if (s.apply[k] !== undefined) out.push(`${where}.apply.${k} does not go with runtime: prow: ${why}`);
  if (s.locks === "plan") out.push(`${where}.locks: plan does not go with runtime: prow: the pr-lock job is a forge workflow`);
  if (isObject(s.waves) && s.waves.jobs !== undefined) out.push(`${where}.waves.jobs does not go with runtime: prow: a wave applies in the one apply job`);
  if (isObject(s.modules) && (s.modules.publish !== undefined || s.modules.registry !== undefined)) out.push(`${where}.modules.publish and modules.registry do not go with runtime: prow: the publish job is a forge workflow`);
  if (isObject(s.terragrunt) && s.terragrunt.credentials !== undefined) out.push(`${where}.terragrunt.credentials does not go with runtime: prow: each unit's role is taken with an OIDC token`);
  if (isObject(s.telemetry) && s.telemetry.headers_secret !== undefined) out.push(`${where}.telemetry.headers_secret does not go with runtime: prow: it names a forge CI secret`);
  const mode = isObject(s.approval) ? s.approval.mode : s.approval;
  if (mode === "pr-review") out.push(`${where}.approval: pr-review reads GitHub reviews, which Prow's flow does not use; set approval: prow-labels, or ledger`);
  const p = s.prow;
  if (!isObject(p)) {
    out.push(`${where}.prow must be a map with trusted_cluster, service_accounts and token_secret, such as { trusted_cluster: trusted, service_accounts: { plan: tf-plan, apply: tf-apply }, token_secret: { name: github-token } }`);
    return out;
  }
  for (const k of Object.keys(p)) if (!(PROW_KEYS as readonly string[]).includes(k)) out.push(`${where}.prow.${k} is not a key of prow (keys: ${PROW_KEYS.join(", ")})`);
  const name = (v: unknown, at: string, required: boolean): void => {
    if (v === undefined) {
      if (required) out.push(`${where}.${at} is required: a Kubernetes name, such as ${at.endsWith("apply") ? "tf-apply" : at.endsWith("plan") ? "tf-plan" : "trusted"}`);
      return;
    }
    if (typeof v !== "string" || !DNS_SUBDOMAIN.test(v)) out.push(`${where}.${at} must be a Kubernetes name: lowercase letters, digits, "-" and ".", at most 253`);
  };
  if (p.config_repo !== undefined && !(typeof p.config_repo === "string" && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(p.config_repo))) out.push(`${where}.prow.config_repo must be owner/name, such as acme/test-infra`);
  if (p.path !== undefined && !(typeof p.path === "string" && /^(?!\/)(?!.*(^|\/)\.\.(\/|$)).+\.ya?ml$/.test(p.path))) out.push(`${where}.prow.path must be a .yaml path inside the repository, such as ${PROW_JOBS_PATH}`);
  if (p.cluster !== undefined && !(typeof p.cluster === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(p.cluster))) out.push(`${where}.prow.cluster must name a build cluster as Prow's config names it`);
  if (p.trusted_cluster === undefined) out.push(`${where}.prow.trusted_cluster is required: the build cluster whose service accounts hold the cloud identities`);
  else if (!(typeof p.trusted_cluster === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(p.trusted_cluster))) out.push(`${where}.prow.trusted_cluster must name a build cluster as Prow's config names it`);
  else if (p.cluster !== undefined && p.cluster === p.trusted_cluster) out.push(`${where}.prow.cluster and prow.trusted_cluster are both ${JSON.stringify(p.cluster)}; the checks presubmit runs a pull request's code, so it runs where no credential is`);
  name(p.namespace, "prow.namespace", false);
  if (!isObject(p.service_accounts)) out.push(`${where}.prow.service_accounts must be a map of plan and apply, such as { plan: tf-plan, apply: tf-apply }`);
  else {
    for (const k of Object.keys(p.service_accounts)) if (k !== "plan" && k !== "apply") out.push(`${where}.prow.service_accounts.${k} is not a key (keys: plan, apply)`);
    name(p.service_accounts.plan, "prow.service_accounts.plan", true);
    name(p.service_accounts.apply, "prow.service_accounts.apply", true);
    if (typeof p.service_accounts.plan === "string" && p.service_accounts.plan === p.service_accounts.apply) out.push(`${where}.prow.service_accounts.plan and apply are the same account; plan and drift take a read-only identity, apply a write one`);
  }
  if (!isObject(p.token_secret)) out.push(`${where}.prow.token_secret must be a map with the Secret's name, such as { name: github-token, key: token }`);
  else {
    for (const k of Object.keys(p.token_secret)) if (k !== "name" && k !== "key") out.push(`${where}.prow.token_secret.${k} is not a key (keys: name, key)`);
    name(p.token_secret.name, "prow.token_secret.name", true);
    if (p.token_secret.key !== undefined && !(typeof p.token_secret.key === "string" && /^[-._a-zA-Z0-9]+$/.test(p.token_secret.key))) out.push(`${where}.prow.token_secret.key must be a key of the Secret: letters, digits, "-", "_" and "."`);
  }
  if (p.plan_before_merge !== undefined && typeof p.plan_before_merge !== "boolean") out.push(`${where}.prow.plan_before_merge must be true or false`);
  if (p.deck !== undefined && !(typeof p.deck === "string" && /^https?:\/\/[^\s/?#]+(\/[^\s?#]*)?$/.test(p.deck))) out.push(`${where}.prow.deck must be Deck's address, such as https://prow.example.com`);
  if (mode === "prow-labels" && p.plan_before_merge !== true) {
    out.push(`${where}.approval: prow-labels binds the labels to the plan the plan presubmit posts on the head, and prow.plan_before_merge is off; set it to true, or keep approval: ledger and approve each held wave's plan with terragucci approve`);
  }
  return out;
}
