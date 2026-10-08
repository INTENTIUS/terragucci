/**
 * Chat notifications: `notify:` in terragucci.yml names the secrets that hold
 * a Slack or Microsoft Teams incoming webhook, and an apply job whose wave
 * waits for an approval (exit 3), is refused (exit 4) or fails posts one
 * message to each: the project, the wave, its roots, the command that
 * approves it and the run's link. Under `approval: pr-review`, a waiting
 * wave that a review of its pull request would approve links that pull
 * request's review page.
 *
 * It only tells people. Nothing here approves, applies or merges, and a chat
 * message carries no button that does: approvals stay records on
 * chant/lifecycle. A webhook that does not answer is logged and never fails
 * the job; its address, a secret, is never printed.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { OUTCOME_SCHEMA, type WaveOutcome } from "./apply";

/** What the wave did. */
export const NOTIFY_EVENTS = ["waiting", "refused", "failed"] as const;
export type NotifyEvent = (typeof NOTIFY_EVENTS)[number];

/** The variables the jobs map the webhook secrets into. */
export const SLACK_WEBHOOK_ENV = "TERRAGUCCI_SLACK_WEBHOOK";
export const TEAMS_WEBHOOK_ENV = "TERRAGUCCI_TEAMS_WEBHOOK";

export interface WaveNotice {
  event: NotifyEvent;
  wave: number;
  project: string;
  roots: string[];
  /** What to run to approve the wave, or why there is nothing to approve. */
  approve: string;
  /** The set digest a waiting wave asks an approval of. */
  digest?: string;
  /** Under `approval: pr-review`: the pull request whose approving review of its head approves the waiting wave, and its review page. */
  review?: { pr: number; url: string };
  /** The stage's one-line outcome, when it wrote one. */
  outcome?: string;
  run?: string;
  report?: string;
}

/** The stage's outcome as JSON (`TG_OUTCOME_JSON`), or undefined when the file is missing, empty or another schema. */
export function readOutcome(file: string): WaveOutcome | undefined {
  if (!existsSync(file)) return undefined;
  try {
    const o = JSON.parse(readFileSync(file, "utf-8")) as WaveOutcome;
    return o?.schema === OUTCOME_SCHEMA ? o : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The pieces of a notice, from the stage's outcome (`result`, its JSON, and
 * `outcome`, the line its status carries), the wave's report and the job's
 * environment.
 */
export function waveNotice(event: NotifyEvent, wave: number, opts: { outcome?: string; result?: WaveOutcome; reportDir?: string; env?: NodeJS.ProcessEnv } = {}): WaveNotice {
  const env = opts.env ?? process.env;
  const result = opts.result?.wave === wave ? opts.result : undefined;
  const outcome = opts.outcome?.trim() || result?.line || undefined;
  const report = readReport(opts.reportDir);
  // A refused wave names the roots that moved or were denied; otherwise the wave's roots.
  const named = event !== "waiting" ? (result?.refused?.roots ?? result?.failed_roots) : undefined;
  const roots = named?.length ? named : result?.roots?.length ? result.roots : (report?.waves?.find((w) => w.number === wave)?.roots ?? report?.roots?.map((r) => r.path) ?? []);
  const project = report?.run?.project ?? env.GITHUB_REPOSITORY ?? env.CI_PROJECT_PATH ?? "this project";
  const digest = event === "waiting" ? result?.set_digest : undefined;
  const review = event === "waiting" && result?.review ? { pr: result.review.pull_request, url: result.review.url } : undefined;
  // A waiting wave's outcome is its approve command, said once.
  return { event, wave, project, roots, approve: approveText(event, wave, result), ...(digest ? { digest } : {}), ...(review ? { review } : {}), ...(outcome && event !== "waiting" ? { outcome } : {}), ...(runUrl(env) ? { run: runUrl(env) } : {}), ...(report?.run?.report_url ? { report: report.run.report_url } : {}) };
}

/** The approval a person gives: the stage's own command for a waiting wave, `terragucci approve` for a refused one (it finds the new digest). */
function approveText(event: NotifyEvent, wave: number, result?: WaveOutcome): string {
  if (event === "waiting") return result?.approve_command ? `${result.approve_command} (or npx terragucci approve wave-${wave})` : `npx terragucci approve wave-${wave}`;
  if (event === "refused" && result?.refused?.reason === "override") return "nothing to approve: the plans changed after the policy override; read the job log";
  if (event === "refused") return `read the plans that moved, then npx terragucci approve wave-${wave}, or revert`;
  if (result?.policy_denied?.length) return "nothing to approve: the policy denied it; an override command is in the job log";
  return "nothing to approve: the apply failed; read the job log";
}

/** The run's page: GitHub and Forgejo name the run, GitLab the job. */
export function runUrl(env: NodeJS.ProcessEnv): string | undefined {
  if (env.CI_JOB_URL) return env.CI_JOB_URL;
  if (env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID) return `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`;
  return undefined;
}

interface ReportShape {
  run?: { project?: string; report_url?: string };
  waves?: { number: number; roots: string[] }[];
  roots?: { path: string }[];
}

function readReport(dir?: string): ReportShape | undefined {
  const file = join(dir ?? "terragucci-report", "report.json");
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, "utf-8")) as ReportShape;
  } catch {
    return undefined;
  }
}

const HEADLINE: Record<NotifyEvent, string> = {
  waiting: "waits for an approval",
  refused: "was refused: its plans changed after approval, so nothing in it was applied",
  failed: "failed",
};

/** The first line of every message. */
export function headline(n: WaveNotice): string {
  return `terragucci: wave ${n.wave} of ${n.project} ${HEADLINE[n.event]}`;
}

const rootsText = (n: WaveNotice): string => (n.roots.length > 0 ? n.roots.join(", ") : "see the run");

/** A Slack incoming webhook's body: one mrkdwn text. */
export function slackMessage(n: WaveNotice): { text: string } {
  return {
    text: [
      `*${headline(n)}*`,
      ...(n.review ? [`Review and approve: <${n.review.url}|pull request ${n.review.pr}>, then run the wave again`] : []),
      `Roots: ${rootsText(n)}`,
      ...(n.digest ? [`Digest: \`${n.digest}\``] : []),
      `${n.review ? "Or approve" : "Approve"}: \`${n.approve}\``,
      ...(n.outcome ? [`Outcome: ${n.outcome}`] : []),
      ...(n.run ? [`Run: <${n.run}>`] : []),
      ...(n.report ? [`Report: <${n.report}>`] : []),
    ].join("\n"),
  };
}

/** A Teams incoming webhook's body (a Workflows webhook): one Adaptive Card. Its actions open the pull request's review page, under pr-review, and the run. */
export function teamsMessage(n: WaveNotice): Record<string, unknown> {
  const facts = [
    { title: "Wave", value: String(n.wave) },
    ...(n.review ? [{ title: "Review and approve", value: `pull request ${n.review.pr}, then run the wave again: ${n.review.url}` }] : []),
    { title: "Roots", value: rootsText(n) },
    ...(n.digest ? [{ title: "Digest", value: n.digest }] : []),
    { title: n.review ? "Or approve" : "Approve", value: n.approve },
    ...(n.outcome ? [{ title: "Outcome", value: n.outcome }] : []),
    ...(n.run ? [{ title: "Run", value: n.run }] : []),
  ];
  return {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        contentUrl: null,
        content: {
          $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
          type: "AdaptiveCard",
          version: "1.4",
          body: [
            { type: "TextBlock", text: headline(n), weight: "Bolder", wrap: true },
            { type: "FactSet", facts },
          ],
          ...(n.review || n.run ? { actions: [...(n.review ? [{ type: "Action.OpenUrl", title: "Review and approve", url: n.review.url }] : []), ...(n.run ? [{ type: "Action.OpenUrl", title: "Open the run", url: n.run }] : [])] } : {}),
        },
      },
    ],
  };
}

/** Post the notice to every webhook the job holds. Returns one line per webhook for the log; never throws. */
export async function notify(n: WaveNotice, env: NodeJS.ProcessEnv = process.env, post: typeof fetch = fetch): Promise<string[]> {
  const targets = [
    { name: "Slack", url: env[SLACK_WEBHOOK_ENV], body: slackMessage(n) },
    { name: "Teams", url: env[TEAMS_WEBHOOK_ENV], body: teamsMessage(n) },
  ].filter((t) => t.url);
  if (targets.length === 0) return [`no webhook: ${SLACK_WEBHOOK_ENV} and ${TEAMS_WEBHOOK_ENV} are empty`];
  const lines: string[] = [];
  for (const t of targets) {
    try {
      const r = await post(t.url!, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(t.body), signal: AbortSignal.timeout(10_000) });
      lines.push(r.ok ? `posted to ${t.name}: ${headline(n)}` : `${t.name} answered ${r.status}; nothing was posted`);
    } catch (e) {
      lines.push(`${t.name} did not answer (${(e as Error).message}); nothing was posted`);
    }
  }
  return lines;
}
