/**
 * Resuming a wave once its approval is on `chant/lifecycle`.
 *
 * A wave that waits ends its job (exit 3). An approval is a line pushed to
 * `chant/lifecycle`, and a push there starts nothing: the forges run a push's
 * workflows from the pushed branch, and that branch holds only the ledger. So
 * two things resume a wave instead.
 *
 * chant's resume job, which the pipeline runs on a schedule with
 * `apply.resume` (./render-waves.ts): it starts again each wave job that
 * waits at a gate an approval, or a passing answer to its decision point, now
 * answers, and each job whose apply under an approval stopped before it said
 * how it ended, once its run is gone.
 *
 * `terragucci approve`, after `chant approve` pushed the approval, with the
 * approver's own token (`resumeAfterApproval`): on GitHub and GitLab chant's
 * `resumeGateRun` starts the one job that waited at that gate again, from the
 * run locator on its pending fact: GitHub re-runs the failed jobs of that
 * run, GitLab retries the job, and a run still going, that succeeded or that
 * was resumed already is left alone. On Forgejo, whose API has no re-run, it
 * comments `/terragucci apply` on the pull request that made the commit.
 * Without a token it says so, and the resume job, or a re-run by hand, picks
 * it up.
 *
 * Neither approves anything: the wave's own gate decides again when it runs.
 */
import { spawnSync } from "node:child_process";
import { resumeGateRun, type GateRunLocator } from "@intentius/chant/gate-resume-run";
import { forgejoForge } from "@intentius/chant/pr-forge";
import type { Fetch } from "./forge";

export type ForgeKind = "github" | "forgejo" | "gitlab";

/** The forge's API, read from the checkout's origin and the approver's environment. */
interface Origin {
  forge: ForgeKind;
  host: string;
  /** Scheme, host and port of the forge's web address: the origin's own for http(s), https and the host for ssh. */
  web: string;
  /** owner/name, or GitLab's project path. */
  path: string;
}

/** The checkout's origin: its host and path, and the forge it is (github.com and gitlab.com by name; `forge` from the config for any other host). */
export function originOf(url: string, configured?: string): Origin | undefined {
  const m = /^(?:([a-z+]+):\/\/)?(?:[^@/]+@)?([^/:]+)(:\d+)?[/:](.+?)(?:\.git)?\/?$/.exec(url.trim());
  if (!m) return undefined;
  const scheme = m[1];
  const host = m[2]!;
  const web = scheme === "http" || scheme === "https" ? `${scheme}://${host}${m[3] ?? ""}` : `https://${host}`;
  const forge: ForgeKind | undefined = host === "github.com" ? "github" : host === "gitlab.com" ? "gitlab" : configured === "github" || configured === "gitlab" || configured === "forgejo" ? configured : undefined;
  return forge ? { forge, host, web, path: m[4]! } : undefined;
}

/** The approver's token for the forge, from the environment, else from `gh auth token` on GitHub. */
function tokenFor(forge: ForgeKind, env: NodeJS.ProcessEnv): string | undefined {
  if (forge === "gitlab") return env.GITLAB_TOKEN || undefined;
  if (forge === "forgejo") return env.FORGEJO_TOKEN || undefined;
  if (env.GH_TOKEN || env.GITHUB_TOKEN) return env.GH_TOKEN || env.GITHUB_TOKEN;
  const r = spawnSync("gh", ["auth", "token"], { encoding: "utf-8" });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : undefined;
}

const TOKEN_ENV: Record<ForgeKind, string> = { github: "GH_TOKEN (or gh auth login)", forgejo: "FORGEJO_TOKEN", gitlab: "GITLAB_TOKEN" };

/**
 * After an approval of `wave`, start its apply again with the approver's
 * token. Returns the line to print; never throws, since the approval stands
 * either way.
 */
export async function resumeAfterApproval(o: { origin: Origin; wave: { wave: number; runId?: string; commit?: string; resume?: GateRunLocator }; env?: NodeJS.ProcessEnv; fetch?: Fetch }): Promise<string> {
  const env = o.env ?? process.env;
  const doFetch: Fetch = o.fetch ?? fetch;
  const { forge, host, web, path } = o.origin;
  const later = "the pipeline's resume job applies it on its next run when apply.resume is set; otherwise run its job again, or comment /terragucci apply";
  const token = tokenFor(forge, env);
  if (!token) return `not resumed from here: no token in ${TOKEN_ENV[forge]}; ${later}`;
  try {
    if (forge === "github" || forge === "gitlab") {
      // chant starts the job that waited again, from the run locator it recorded on the pending fact, and leaves alone a run still going, that succeeded or that was resumed already.
      if (!o.wave.resume) return `not resumed from here: the pending fact names no CI job; ${later}`;
      const out = await resumeGateRun(o.wave.resume, { token, ...(o.fetch ? { fetch: o.fetch as never } : {}) });
      if (out.status !== "resumed") return `not resumed from here: ${"reason" in out ? out.reason : out.how}; ${later}`;
      return `resumed: ${out.how}, so wave ${o.wave.wave} runs again and its gate decides`;
    }
    // Forgejo's API has no re-run: the merged pull request's /terragucci apply, as the approver, runs the waves again.
    if (!o.wave.commit) return `not resumed from here: the pending fact names no commit; ${later}`;
    const client = forgejoForge({ apiBase: `${web}/api/v1`, repo: path, token, host, fetch: doFetch });
    const pr = await client.pullRequestFor(o.wave.commit).catch(() => null);
    if (pr === null) return `not resumed from here: no merged pull request made ${o.wave.commit.slice(0, 8)}; ${later}`;
    await client.addComment(pr, "/terragucci apply");
    return `resumed: commented /terragucci apply on pull request ${pr}, so its waves run again and each gate decides`;
  } catch (e) {
    return `not resumed from here (${(e as Error).message}); ${later}`;
  }
}
