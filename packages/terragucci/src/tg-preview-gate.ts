/**
 * The gate of a Terragrunt wave, against the preview the merged pull
 * request's plan note showed of its units (./tg-preview.ts). The wave plans
 * on the state the waves before it left; a unit whose plan differs from the
 * preview is named with each difference before the gate decides, so whoever
 * approves reads it first. The note is the pull request's, written by a job
 * that ran its code: it is read for what it says, and nothing is gated on it.
 */
import { spawnSync } from "node:child_process";
import { plannerForBinary } from "@intentius/chant-lexicon-terraform/change-set";
import { ConfigError } from "./config";
import { buildReport } from "./report/build";
import { runFacts } from "./report/stage";
import type { Fetch } from "./forge";
import type { NoteWaves } from "./report/marker";
import type { ReportChange, ReportWavePreview } from "./report/schema";
import { forgeCalls, gitlabCalls, gitlabReviews, noteWavesOf, pullOf } from "./review";
import { previewDifferences } from "./tg-preview";

/** What a wave's gate says of the preview: the report's comparison, and the lines it prints. */
export interface GatePreview {
  preview?: ReportWavePreview;
  lines: string[];
}

/**
 * Compare a wave's plans with the previews of them in the plan note of the
 * pull request that made `sha` (`TG_PR` when the job names one). Nothing to
 * say when no pull request made the commit or its note previewed none of the
 * units. Never throws: a forge it cannot read is one line.
 */
export async function gatePreview(o: {
  env: NodeJS.ProcessEnv;
  fetch?: Fetch;
  forge: "github" | "forgejo" | "gitlab";
  sha: string;
  units: readonly { unit: string; plan: string | null; changes: readonly ReportChange[] }[];
}): Promise<GatePreview> {
  let pr: number;
  let note: NoteWaves | undefined;
  try {
    if (o.forge === "gitlab") {
      const got = await gitlabReviews(gitlabCalls(o.env, o.fetch), o.sha, o.env);
      if (!got) return { lines: [] };
      pr = got.pr.number;
      note = got.note;
    } else {
      const f = forgeCalls(o.env, o.fetch);
      const pull = await pullOf(f, o.env, o.sha);
      if (!pull) return { lines: [] };
      pr = pull.number;
      note = await noteWavesOf(f, pull);
    }
  } catch (e) {
    // No forge to ask (a run on a laptop): nothing to compare with.
    if (e instanceof ConfigError) return { lines: [] };
    return { lines: [`the pull request's preview of these units could not be read (${(e as Error).message.split("\n")[0]}), so nothing is compared with it`] };
  }
  const previews = new Map((note?.previews ?? []).map((p) => [p.unit, p]));
  const units = o.units.filter((u) => previews.has(u.unit)).map((u) => {
    const differences = previewDifferences(previews.get(u.unit)!, u.plan, u.changes);
    return { unit: u.unit, ...(differences.length ? { differences } : {}) };
  });
  if (units.length === 0) return { lines: [] };
  const moved = units.filter((u) => u.differences);
  const lines = moved.length === 0
    ? [`${units.map((u) => u.unit).join(", ")} ${units.length === 1 ? "plans" : "plan"} as pull request ${pr} previewed ${units.length === 1 ? "it" : "them"}, on the planned outputs of the waves before`]
    : [
        `pull request ${pr} previewed ${units.map((u) => u.unit).join(", ")} on the planned outputs of the waves before; ${moved.length === 1 ? "this unit plans" : "these units plan"} differently now:`,
        ...moved.flatMap((u) => u.differences!.map((d) => `  ${u.unit}: ${d}`)),
      ];
  return { preview: { pull_request: pr, units }, lines };
}

/**
 * A wave's comparison with the preview, from the plans it just made: each
 * line said through `say`, before its gate decides. Read only, and never
 * fails the wave. Undefined when there is nothing to compare.
 */
export async function comparePreview(
  o: { repo: string; env: NodeJS.ProcessEnv; wave: number; binary: string; fetch?: Fetch; units: readonly { root: string; plan?: unknown }[] },
  say: (line: string) => void,
): Promise<ReportWavePreview | undefined> {
  const env = o.env;
  const forge = env.GITLAB_CI === "true" ? "gitlab" : env.GITEA_ACTIONS === "true" || env.FORGEJO_ACTIONS === "true" ? "forgejo" : "github";
  const sha = env.TG_SHA || spawnSync("git", ["-C", o.repo, "rev-parse", "HEAD"], { encoding: "utf-8" }).stdout.trim();
  const now = new Date().toISOString();
  const report = buildReport({
    run: { ...runFacts(o.repo, env), stage: "tf-apply", wave: o.wave, binary: o.binary, runtime: "forge", started: now, finished: now },
    roots: o.units.map((p) => ({ path: p.root, plan: p.plan, planner: plannerForBinary(o.binary) })),
  });
  const found = await gatePreview({ env, ...(o.fetch ? { fetch: o.fetch } : {}), forge, sha, units: report.roots.map((r) => ({ unit: r.path, plan: r.plan_digest, changes: r.changes })) });
  found.lines.forEach(say);
  return found.preview;
}
