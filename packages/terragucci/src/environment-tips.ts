/**
 * config check's tips for the apply jobs of environments and identity groups
 * (./groups.ts): runners, apply identities and token audiences that two of
 * them share, so neither the forge nor the cloud can keep one's apply apart
 * from the other's. Tips only: none is a problem or a warning, and none fails
 * the check.
 *
 *   PERSISTENT_RUNNER_TIP    an environment's apply runner and the plan jobs'
 *                            runner, or another environment's apply runner,
 *                            are such that a runner taking one's jobs takes
 *                            the other's (one label set holds the other);
 *                            and without environments, `runner.apply` (or
 *                            the one runner) and `runner.plan` the same way
 *   ENVIRONMENT_ROLE_TIP     two groups' apply jobs take the project's own
 *                            apply identity, at least one of them an
 *                            environment, so no trust condition separates them
 *                            (an identity two globs or environments name
 *                            explicitly is config check's state-access
 *                            warning already)
 *   SHARED_AUDIENCE_TIP      GitLab with AWS: two groups' apply jobs carry the
 *                            same AWS audience, at least one an environment
 *                            with no `oidc.audience`; AWS cannot read GitLab's
 *                            environment claims, so the audience is the only
 *                            separation
 *
 * Forgejo's case (environments that apply from one ref) is the shared-subject
 * tip's (./groups.ts sharedSubjectTip).
 */
import { DEFAULT_GROUP, type ApplyGroup } from "./groups";
import { runnerOf, stageAudience } from "./render";
import type { ForgeName, OidcSettings, ProjectSettings, RunnerSpec } from "./config";
import { SHARED_AUDIENCE_TIP, PERSISTENT_RUNNER_TIP, ENVIRONMENT_ROLE_TIP } from "./tips";

export interface EnvironmentTip {
  rule: string;
  message: string;
}

/** `a`, `a and b`, `a, b and c`. */
const listed = (names: readonly string[]): string => (names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`);

interface Placed {
  group?: string;
  labels: string[];
}

/**
 * Where a runner spec places a job, for comparing two: its group and labels.
 * Undefined for a runner that starts clean for each job or that the config
 * does not name: no spec, on GitHub labels without `self-hosted` and no
 * group (GitHub's hosted runners), and on GitLab tags that are all `saas-`
 * (GitLab.com's hosted runners).
 */
function placed(spec: RunnerSpec | undefined, forge: ForgeName | undefined): Placed | undefined {
  if (spec === undefined) return undefined;
  const p: Placed = typeof spec === "string" ? { labels: [spec] } : Array.isArray(spec) ? { labels: [...spec] } : { group: spec.group, labels: [...(spec.labels ?? [])] };
  if ((forge === "github" || forge === undefined) && p.group === undefined && !p.labels.includes("self-hosted")) return undefined;
  if (forge === "gitlab" && p.labels.length > 0 && p.labels.every((l) => l.startsWith("saas-"))) return undefined;
  return p;
}

/** Whether a runner that takes one's jobs can take the other's: the same group (or none), and one's labels all among the other's. */
function overlaps(a: Placed, b: Placed): boolean {
  if (a.group !== undefined && b.group !== undefined && a.group !== b.group) return false;
  const within = (x: string[], y: string[]): boolean => x.every((l) => y.includes(l));
  return within(a.labels, b.labels) || within(b.labels, a.labels);
}

const described = (p: Placed): string => [...(p.group !== undefined ? [`group ${p.group}`] : []), ...(p.labels.length ? [`labels ${p.labels.join(", ")}`] : [])].join(" and ");

/**
 * What keeps other jobs off the apply runners, by forge: labels keep
 * terragucci's own jobs apart, but `runs-on` and `tags` are in the pipeline
 * file, so a job on any branch can name the apply runners' labels.
 */
const otherJobs = (forge: ForgeName | undefined): string =>
  forge === "gitlab" ? "; labels keep terragucci's own jobs apart, but any branch's job can name the same tags, and only protected runners, which take jobs of protected refs alone, keep those off"
    : forge === "forgejo" ? "; labels keep terragucci's own jobs apart, but any branch's job can name the same labels, and Forgejo has no per-workflow limit on a runner"
      : "; labels keep terragucci's own jobs apart, but any branch's job can name the same labels, and only a runner group limited to selected workflows keeps those off";

/** The persistent-runner tips: each environment whose apply runner overlaps the plan jobs' runner or another environment's apply runner. */
export function sharedRunnerTips(groups: readonly ApplyGroup[] | undefined, runner: ProjectSettings["runner"], forge: ForgeName | undefined): EnvironmentTip[] {
  const envs = (groups ?? []).filter((g) => g.environment !== undefined);
  if (envs.length === 0) return [];
  const plan = placed(runnerOf(runner, "plan"), forge);
  const apply = envs.map((g) => ({ name: g.name, at: placed(g.runner ?? runnerOf(runner, "apply"), forge) }));
  const out: EnvironmentTip[] = [];
  for (const [i, e] of apply.entries()) {
    if (!e.at) continue;
    if (plan && overlaps(e.at, plan)) {
      out.push({
        rule: PERSISTENT_RUNNER_TIP,
        message: `the apply jobs of environment ${e.name} (${described(e.at)}) and the plan jobs (${described(plan)}) can run on the same runner, so a pull request's code planned there can leave files or processes for ${e.name}'s apply; give ${e.name}'s apply runners a label no plan job uses, and use runners that start clean for each job${otherJobs(forge)}`,
      });
    }
    for (const other of apply.slice(i + 1)) {
      if (!other.at || !overlaps(e.at, other.at)) continue;
      out.push({
        rule: PERSISTENT_RUNNER_TIP,
        message: `the apply jobs of environments ${e.name} (${described(e.at)}) and ${other.name} (${described(other.at)}) can run on the same runner, so one environment's apply can leave files or processes for the other's; give each environment's apply runners a label of its own`,
      });
    }
  }
  return out;
}

/**
 * The persistent-runner tip for the project's own apply jobs: `runner.apply`
 * (or the default, or the one runner) and `runner.plan` such that one runner
 * takes both stages' jobs. Silent with an environment that names no runner
 * of its own, whose apply jobs take `runner.apply` and whose tip
 * (sharedRunnerTips) names the same runner already.
 */
export function planApplyRunnerTip(settings: Pick<ProjectSettings, "runner" | "environments">, forge: ForgeName | undefined): EnvironmentTip | undefined {
  if (Object.values(settings.environments ?? {}).some((e) => e.runner === undefined)) return undefined;
  const plan = placed(runnerOf(settings.runner, "plan"), forge);
  const apply = placed(runnerOf(settings.runner, "apply"), forge);
  if (!plan || !apply || !overlaps(plan, apply)) return undefined;
  const at = described(plan) === described(apply) ? `both on ${described(plan)}` : `plan on ${described(plan)}, apply on ${described(apply)}`;
  return {
    rule: PERSISTENT_RUNNER_TIP,
    message: `the plan jobs and the apply jobs can run on the same runner (${at}), so a pull request's code planned there can leave files, caches or processes for an apply; give runner.apply labels no plan job uses, and use runners that start clean for each job${otherJobs(forge)}`,
  };
}

/** The project's own apply identity of each cloud, as a group's job takes it: `apply_role`, the GCP `apply_service_account`, the Azure `apply_client_id`. */
function ownApplyIdentities(g: ApplyGroup, top: OidcSettings | undefined): { what: string; id: string }[] {
  const o = g.oidc;
  if (!o || !top) return [];
  return [
    ...(o.apply_role !== undefined && o.apply_role === top.apply_role ? [{ what: "oidc.apply_role", id: o.apply_role }] : []),
    ...(o.gcp?.apply_service_account !== undefined && o.gcp.apply_service_account === top.gcp?.apply_service_account ? [{ what: "oidc.gcp.apply_service_account", id: o.gcp.apply_service_account }] : []),
    ...(o.azure?.apply_client_id !== undefined && o.azure.apply_client_id === top.azure?.apply_client_id ? [{ what: "oidc.azure.apply_client_id", id: o.azure.apply_client_id }] : []),
  ];
}

/**
 * The environment-role tip (terragucci-environment-role): groups whose apply jobs take the project's own
 * apply identity, two or more, at least one an environment. `top` is the
 * project's `oidc` (before the environments' pairs are folded in).
 */
export function sharedApplyRoleTips(groups: readonly ApplyGroup[] | undefined, top: OidcSettings | undefined): EnvironmentTip[] {
  if (!groups || groups.length < 2) return [];
  const by = new Map<string, { what: string; names: string[]; envs: string[] }>();
  for (const g of groups) {
    for (const { what, id } of ownApplyIdentities(g, top)) {
      const at = by.get(id) ?? { what, names: [], envs: [] };
      at.names.push(g.name);
      if (g.environment !== undefined) at.envs.push(g.name);
      by.set(id, at);
    }
  }
  const out: EnvironmentTip[] = [];
  for (const [id, { what, names, envs }] of by) {
    if (names.length < 2 || envs.length === 0) continue;
    const key = what === "oidc.apply_role" ? "apply_role" : what === "oidc.gcp.apply_service_account" ? "gcp.apply_service_account" : "azure.apply_client_id";
    out.push({
      rule: ENVIRONMENT_ROLE_TIP,
      message: `the apply jobs of ${names.length === envs.length ? "environments" : "the groups"} ${listed(names)} all apply as ${id} (${what}), so its trust must accept each of their jobs and no condition keeps one environment's job from another's role; set environments.<name>.oidc.${key} for ${listed(envs)}`,
    });
  }
  return out;
}

/** Whether a group's job takes an AWS role. */
const takesAws = (o: OidcSettings | undefined): boolean => Boolean(o && (o.apply_role || (o.roles && Object.keys(o.roles).length > 0)));

/**
 * The GitLab audience tip (terragucci-gitlab-audience): groups taking AWS roles whose apply
 * jobs carry the same audience, at least one an environment that sets no
 * `oidc.audience`.
 */
export function environmentAudienceTips(groups: readonly ApplyGroup[] | undefined, top: OidcSettings | undefined, forge: ForgeName | undefined): EnvironmentTip[] {
  if (forge !== "gitlab" || !groups || !groups.some((g) => g.environment !== undefined)) return [];
  const by = new Map<string, ApplyGroup[]>();
  for (const g of groups) {
    if (!takesAws(g.oidc)) continue;
    const aud = g.audience ?? stageAudience(top, "apply");
    by.set(aud, [...(by.get(aud) ?? []), g]);
  }
  const out: EnvironmentTip[] = [];
  for (const [aud, gs] of by) {
    const unset = gs.filter((g) => g.environment !== undefined && g.audience === undefined).map((g) => g.name);
    if (gs.length < 2 || unset.length === 0) continue;
    const names = gs.map((g) => g.name);
    out.push({
      rule: SHARED_AUDIENCE_TIP,
      message: `on GitLab the apply jobs of ${names.every((n) => n !== DEFAULT_GROUP) && gs.every((g) => g.environment !== undefined) ? "environments" : "the groups"} ${listed(names)} carry the same AWS token audience ${aud}, and AWS cannot read GitLab's environment claims, so an apply role's trust cannot tell their jobs apart; set environments.<name>.oidc.audience for ${listed(unset)} and have each apply role trust its environment's audience alone`,
    });
  }
  return out;
}

/** Every tip of this file for a repo's apply groups. */
export function environmentTips(groups: readonly ApplyGroup[] | undefined, settings: Pick<ProjectSettings, "runner" | "oidc">, forge: ForgeName | undefined): EnvironmentTip[] {
  return [...sharedRunnerTips(groups, settings.runner, forge), ...sharedApplyRoleTips(groups, settings.oidc), ...environmentAudienceTips(groups, settings.oidc, forge)];
}
