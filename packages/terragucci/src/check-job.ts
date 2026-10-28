/**
 * `terragucci check-job`: the first lines of an environment's apply job
 * (./cloud-identity.ts) check that the job runs where the environment's apply is set
 * to run, before any token is traded with a cloud, and stop it otherwise.
 *
 * What the job is expected to see comes from the flags init renders into the
 * job, not from terragucci.yml in the job's checkout: the flags are what the
 * pipeline was rendered from, and the check reads no file of the commit it
 * runs on. What it sees comes from the forge:
 *
 *   forge environment  GitHub: the `environment` claim of an OIDC token the
 *                      check requests for chant's audience (`chant-check-job`),
 *                      decodes and drops; GitHub sets no variable with the
 *                      job's environment. GitLab: CI_ENVIRONMENT_NAME.
 *                      Forgejo has no deployment environments: not checked.
 *   ref                GitHub and Forgejo: GITHUB_REF is refs/heads/<branch>
 *                      for one of the branches the job may apply from.
 *                      GitLab: CI_COMMIT_REF_NAME is one of them, and
 *                      CI_COMMIT_REF_PROTECTED is "true".
 *   runner             GitLab: CI_RUNNER_TAGS holds each of the job's tags.
 *                      GitHub and Forgejo expose no labels, only whether the
 *                      runner is self-hosted: with `--self-hosted`, the
 *                      token's runner_environment claim, else RUNNER_ENVIRONMENT,
 *                      is `self-hosted`. Neither set: not checked.
 *
 * The check catches a hand edit, a dropped `environment:` or a mistyped
 * label. Someone who can edit the workflow can delete it too: the forge's
 * environment and runner settings and the cloud role's trust are what keep a
 * job out.
 *
 * The check is chant core's apply-job guard (`@intentius/chant/ci-job-guard`,
 * chant#4624), run with terragucci's words.
 */
import { checkJob, describeJobGuard, jobSeen, type JobGuardSpec } from "@intentius/chant/ci-job-guard";
import type { ForgeName } from "./config";

/** Where an environment's apply job is expected to run. */
export interface JobExpectation {
  forge: ForgeName;
  /** The terragucci environment the job applies. */
  environment: string;
  /** The forge environment the job runs in (GitHub and GitLab). Unset: not checked. */
  forgeEnvironment?: string;
  /** The branches the job may apply from. */
  branches: string[];
  /** GitLab: the tags the job's runner must carry. */
  runnerTags?: string[];
  /** GitHub and Forgejo: the runner must be self-hosted. */
  selfHosted?: boolean;
}

/** chant's guard spec for an environment's apply job: named for the environment, in terragucci's words. */
export function jobGuardSpecFor(expect: JobExpectation): JobGuardSpec {
  return {
    forge: expect.forge,
    job: `environment ${expect.environment}`,
    product: "terragucci",
    branches: expect.branches,
    ...(expect.forgeEnvironment !== undefined ? { forgeEnvironment: expect.forgeEnvironment } : {}),
    ...(expect.runnerTags ? { runnerTags: expect.runnerTags } : {}),
    ...(expect.selfHosted ? { selfHosted: true } : {}),
  };
}

/** What a run of the check prints, and whether the job may go on: chant's guard (chant#4624). */
export async function runCheckJob(expect: JobExpectation, env: NodeJS.ProcessEnv = process.env, fetchFn: typeof fetch = fetch): Promise<{ ok: boolean; out: string[]; err: string[] }> {
  const spec = jobGuardSpecFor(expect);
  return describeJobGuard(spec, checkJob(spec, await jobSeen(spec, env, fetchFn)));
}
