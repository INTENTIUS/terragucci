/**
 * Notifications: `notify:` in terragucci.yml names the secrets that hold a
 * Slack or Microsoft Teams incoming webhook, or a generic webhook and the key
 * that signs what it is sent, and an apply job whose wave
 * waits for an approval (exit 3), is refused (exit 4) or fails posts one
 * message to each: the project, the wave, its roots, the command that
 * approves it and the run's link. Under `approval: pr-review`, a waiting
 * wave that a review of its pull request would approve links that pull
 * request's review page.
 *
 * The generic webhook gets one JSON event, `terragucci.notify/v1`, for a
 * program to read: the wave's context and the stage's outcome
 * (`terragucci.outcome/v1`), signed with HMAC-SHA256 over the raw body
 * (`X-Terragucci-Signature: sha256=<hex>`). It is never posted unsigned.
 *
 * It only tells people. Nothing here approves, applies or merges. With
 * `notify.relay` set, a waiting wave's Slack message carries Approve and
 * Decline buttons, and its Teams card the reply that does the same; a click
 * reaches the customer's own relay (./relay.ts), which checks who clicked
 * and records the approval on chant/lifecycle. A webhook that does not
 * answer is logged and never fails the job; its address, a secret, is never
 * printed.
 *
 * The drift job posts a drift notice (`notify drift`) to Slack and Teams
 * when the refresh-only plans found drift, with a Re-plan button that opens
 * the page where a person runs the drift check again with their own forge
 * login.
 */
import { createHash, createHmac } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { OUTCOME_SCHEMA, type WaveOutcome } from "./apply";

/** What the wave did. */
export const NOTIFY_EVENTS = ["waiting", "refused", "failed"] as const;
export type NotifyEvent = (typeof NOTIFY_EVENTS)[number];

/** The variables the jobs map the webhook secrets into. */
export const SLACK_WEBHOOK_ENV = "TERRAGUCCI_SLACK_WEBHOOK";
export const TEAMS_WEBHOOK_ENV = "TERRAGUCCI_TEAMS_WEBHOOK";
export const WEBHOOK_ENV = "TERRAGUCCI_WEBHOOK";
export const WEBHOOK_KEY_ENV = "TERRAGUCCI_WEBHOOK_KEY";
/** `notify.relay`: the relay's name, which a waiting wave's message offers buttons (Slack) or a reply (Teams) for. */
export const RELAY_NAME_ENV = "TERRAGUCCI_RELAY";

/** The Slack buttons' action ids, which the relay reads. */
export const APPROVE_ACTION = "terragucci-approve";
export const DECLINE_ACTION = "terragucci-decline";
export const REPLAN_ACTION = "terragucci-replan";

/** The generic webhook's body. */
export const NOTIFY_SCHEMA = "terragucci.notify/v1";

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
  /** The stage's outcome as it wrote it, which the generic webhook carries whole. */
  result?: WaveOutcome;
  /** `notify.relay`: the relay a waiting wave's buttons (Slack) and reply (Teams) reach. */
  relay?: string;
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
  const relay = event === "waiting" && digest ? env[RELAY_NAME_ENV]?.trim() || undefined : undefined;
  // A waiting wave's outcome is its approve command, said once.
  return { event, wave, project, roots, approve: approveText(event, wave, result), ...(digest ? { digest } : {}), ...(relay ? { relay } : {}), ...(review ? { review } : {}), ...(result ? { result } : {}), ...(outcome && event !== "waiting" ? { outcome } : {}), ...(runUrl(env) ? { run: runUrl(env) } : {}), ...(report?.run?.report_url ? { report: report.run.report_url } : {}) };
}

/** The approval a person gives: the stage's own command for a waiting wave, `terragucci approve` for a refused one (it finds the new digest). */
function approveText(event: NotifyEvent, wave: number, result?: WaveOutcome): string {
  // The pinned form: terragucci approve refuses when the plans moved past the digest the message names.
  const pinned = result?.set_digest ? `npx terragucci approve wave-${wave} --plan ${result.set_digest}` : `npx terragucci approve wave-${wave}`;
  if (event === "waiting") return result?.approve_command ? `${result.approve_command} (or ${pinned})` : pinned;
  if (event === "refused" && result?.refused?.reason === "override") return "nothing to approve: the plans changed after the policy override; read the job log";
  if (event === "refused") return `read the plans that moved, then ${pinned}, or revert`;
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

/** What a relay button carries: the wave and the digest it approves, and nothing else. */
export interface ButtonValue {
  wave: number;
  plan: string;
}

/** A Slack button. `value` is what the relay reads back; `url` makes it a link that opens a page. */
function slackButton(text: string, action: string, o: { value?: string; url?: string; style?: "primary" | "danger" }): Record<string, unknown> {
  return { type: "button", action_id: action, text: { type: "plain_text", text }, ...(o.value ? { value: o.value } : {}), ...(o.url ? { url: o.url } : {}), ...(o.style ? { style: o.style } : {}) };
}

/**
 * A Slack incoming webhook's body: one mrkdwn text. With a relay, a waiting
 * wave's message also carries the text as a block and Approve and Decline
 * buttons, whose value names the wave and the digest the message showed.
 */
export function slackMessage(n: WaveNotice): { text: string; blocks?: Record<string, unknown>[] } {
  const text = slackText(n);
  if (!n.relay || !n.digest || n.event !== "waiting") return { text };
  const value = JSON.stringify({ wave: n.wave, plan: n.digest } satisfies ButtonValue);
  return {
    text,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text } },
      { type: "actions", block_id: "terragucci", elements: [slackButton("Approve", APPROVE_ACTION, { value, style: "primary" }), slackButton("Decline", DECLINE_ACTION, { value, style: "danger" })] },
    ],
  };
}

function slackText(n: WaveNotice): string {
  return [
      `*${headline(n)}*`,
      ...(n.review ? [`Review and approve: <${n.review.url}|pull request ${n.review.pr}>, then run the wave again`] : []),
      `Roots: ${rootsText(n)}`,
      ...(n.digest ? [`Digest: \`${n.digest}\``] : []),
      `${n.review ? "Or approve" : "Approve"}: \`${n.approve}\``,
      ...(n.outcome ? [`Outcome: ${n.outcome}`] : []),
      ...(n.run ? [`Run: <${n.run}>`] : []),
      ...(n.report ? [`Report: <${n.report}>`] : []),
    ].join("\n");
}

/** The Teams reply that approves or declines a waiting wave through the relay's outgoing webhook. */
export const teamsReply = (n: Pick<WaveNotice, "relay" | "wave" | "digest">, action: "approve" | "decline"): string => `@${n.relay} ${action} wave-${n.wave} ${n.digest}`;

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
            // Teams has no button that reaches a relay without a registered bot, so the card gives the reply its outgoing webhook reads.
            ...(n.relay && n.digest && n.event === "waiting"
              ? [{ type: "TextBlock", wrap: true, text: `Approve here: reply ${teamsReply(n, "approve")}. Decline: reply ${teamsReply(n, "decline")}.` }]
              : []),
          ],
          ...(n.review || n.run ? { actions: [...(n.review ? [{ type: "Action.OpenUrl", title: "Review and approve", url: n.review.url }] : []), ...(n.run ? [{ type: "Action.OpenUrl", title: "Open the run", url: n.run }] : [])] } : {}),
        },
      },
    ],
  };
}

/** `terragucci.notify/v1`: the generic webhook's event. */
export interface NotifyEventBody {
  schema: typeof NOTIFY_SCHEMA;
  /** The same for every post of one wave's event about one digest, so a receiver can drop a repeat (a re-run). */
  id: string;
  event: NotifyEvent;
  sent_at: string;
  project: string;
  forge?: "github" | "gitlab" | "forgejo";
  repo?: string;
  sha?: string;
  /** The pull request the job applied for (a comment's apply). */
  pr?: number;
  wave: number;
  roots: string[];
  run_url?: string;
  report_url?: string;
  /** The stage's outcome, `terragucci.outcome/v1`, when it wrote one. */
  outcome?: WaveOutcome;
}

/** The forge the job runs on, from its environment. */
function forgeOf(env: NodeJS.ProcessEnv): NotifyEventBody["forge"] {
  if (env.GITLAB_CI === "true") return "gitlab";
  if (env.GITEA_ACTIONS === "true" || env.FORGEJO_ACTIONS === "true") return "forgejo";
  if (env.GITHUB_REPOSITORY) return "github";
  return undefined;
}

/** The generic webhook's event for a notice. */
export function webhookEvent(n: WaveNotice, env: NodeJS.ProcessEnv = process.env, now: Date = new Date()): NotifyEventBody {
  const forge = forgeOf(env);
  const repo = env.GITHUB_REPOSITORY || env.CI_PROJECT_PATH || undefined;
  const sha = env.TG_SHA || env.GITHUB_SHA || env.CI_COMMIT_SHA || undefined;
  const pr = /^\d+$/.test((env.TG_PR ?? "").trim()) ? Number(env.TG_PR) : undefined;
  const id = createHash("sha256").update(JSON.stringify([n.project, n.wave, n.event, n.result?.set_digest ?? sha ?? ""])).digest("hex");
  return {
    schema: NOTIFY_SCHEMA,
    id,
    event: n.event,
    sent_at: now.toISOString(),
    project: n.project,
    ...(forge ? { forge } : {}),
    ...(repo ? { repo } : {}),
    ...(sha ? { sha } : {}),
    ...(pr !== undefined ? { pr } : {}),
    wave: n.wave,
    roots: n.roots,
    ...(n.run ? { run_url: n.run } : {}),
    ...(n.report ? { report_url: n.report } : {}),
    ...(n.result ? { outcome: n.result } : {}),
  };
}

/** `sha256=<hex>`: HMAC-SHA256 of the raw body with the webhook's key. */
export function signature(body: string, key: string): string {
  return `sha256=${createHmac("sha256", key).update(body).digest("hex")}`;
}

/** Post the notice to every webhook the job holds. Returns one line per webhook for the log; never throws. */
export async function notify(n: WaveNotice, env: NodeJS.ProcessEnv = process.env, post: typeof fetch = fetch): Promise<string[]> {
  const json = { "content-type": "application/json" };
  const lines: string[] = [];
  const targets: { name: string; url: string; body: string; headers: Record<string, string> }[] = [
    { name: "Slack", url: env[SLACK_WEBHOOK_ENV] ?? "", body: JSON.stringify(slackMessage(n)), headers: json },
    { name: "Teams", url: env[TEAMS_WEBHOOK_ENV] ?? "", body: JSON.stringify(teamsMessage(n)), headers: json },
  ].filter((t) => t.url);
  if (env[WEBHOOK_ENV]) {
    const key = env[WEBHOOK_KEY_ENV];
    if (!key) lines.push(`the webhook was not posted to: ${WEBHOOK_KEY_ENV} is empty, and an event is never sent unsigned`);
    else {
      const event = webhookEvent(n, env);
      const body = JSON.stringify(event);
      targets.push({ name: "the webhook", url: env[WEBHOOK_ENV]!, body, headers: { ...json, "x-terragucci-event": n.event, "x-terragucci-delivery": event.id, "x-terragucci-signature": signature(body, key) } });
    }
  }
  if (targets.length === 0 && lines.length === 0) return [`no webhook: ${SLACK_WEBHOOK_ENV}, ${TEAMS_WEBHOOK_ENV} and ${WEBHOOK_ENV} are empty`];
  for (const t of targets) {
    try {
      const r = await post(t.url, { method: "POST", headers: t.headers, body: t.body, signal: AbortSignal.timeout(10_000) });
      lines.push(r.ok ? `posted to ${t.name}: ${headline(n)}` : `${t.name} answered ${r.status}; nothing was posted`);
    } catch (e) {
      lines.push(`${t.name} did not answer (${(e as Error).message}); nothing was posted`);
    }
  }
  return lines;
}

// ── drift ────────────────────────────────────────────────────────────────

/** What the drift job tells the channel: the roots whose real state moved, and where to run the check again. */
export interface DriftNotice {
  project: string;
  /** The roots the refresh-only plans found drifted. */
  roots: string[];
  /** The roots that could not be refreshed. */
  failed: string[];
  run?: string;
  report?: string;
  /** The page where a person runs the drift check again: the workflow's page (GitHub, Forgejo), the pipeline schedules (GitLab). */
  replan?: string;
}

interface DriftReportShape {
  run?: { project?: string; report_url?: string };
  roots?: { path: string; status?: string; changes?: unknown[] }[];
}

/** The workflow file the job runs, from GITHUB_WORKFLOW_REF (`owner/repo/.github/workflows/<file>@<ref>`), else the pipeline's own name. */
const workflowFile = (env: NodeJS.ProcessEnv): string => /\/workflows\/([^/@]+)@/.exec(env.GITHUB_WORKFLOW_REF ?? "")?.[1] ?? "terragucci.yml";

/** Where a person starts the drift check again with their own login. */
export function replanUrl(env: NodeJS.ProcessEnv): string | undefined {
  if (env.GITLAB_CI === "true") return env.CI_PROJECT_URL ? `${env.CI_PROJECT_URL}/-/pipeline_schedules` : undefined;
  if (!env.GITHUB_SERVER_URL || !env.GITHUB_REPOSITORY) return undefined;
  const repo = `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}`;
  // Forgejo lists a workflow's runs, with its Run workflow button, under ?workflow=; GitHub under /actions/workflows/.
  return env.GITEA_ACTIONS === "true" || env.FORGEJO_ACTIONS === "true" ? `${repo}/actions?workflow=${workflowFile(env)}` : `${repo}/actions/workflows/${workflowFile(env)}`;
}

/** The drift notice from the drift job's report, or undefined when it found no drift and no root failed. */
export function driftNotice(reportDir: string, env: NodeJS.ProcessEnv = process.env): DriftNotice | undefined {
  const file = join(reportDir, "report.json");
  if (!existsSync(file)) return undefined;
  let r: DriftReportShape;
  try {
    r = JSON.parse(readFileSync(file, "utf-8")) as DriftReportShape;
  } catch {
    return undefined;
  }
  const roots = (r.roots ?? []).filter((x) => x.status === "planned" && (x.changes?.length ?? 0) > 0).map((x) => x.path);
  const failed = (r.roots ?? []).filter((x) => x.status === "failed").map((x) => x.path);
  if (roots.length === 0 && failed.length === 0) return undefined;
  const project = r.run?.project ?? env.GITHUB_REPOSITORY ?? env.CI_PROJECT_PATH ?? "this project";
  const run = runUrl(env);
  const replan = replanUrl(env);
  return { project, roots, failed, ...(run ? { run } : {}), ...(r.run?.report_url ? { report: r.run.report_url } : {}), ...(replan ? { replan } : {}) };
}

export const driftHeadline = (n: DriftNotice): string =>
  `terragucci: drift in ${n.project}: ${n.roots.length > 0 ? `${n.roots.length} root${n.roots.length === 1 ? "" : "s"} changed outside Terraform` : "no drift found"}${n.failed.length > 0 ? `, ${n.failed.length} could not be refreshed` : ""}`;

/** The drift notice for Slack: the text, and a Re-plan button that opens the page where the check runs again. */
export function slackDrift(n: DriftNotice): { text: string; blocks?: Record<string, unknown>[] } {
  const text = [
    `*${driftHeadline(n)}*`,
    ...(n.roots.length > 0 ? [`Drifted: ${n.roots.join(", ")}`] : []),
    ...(n.failed.length > 0 ? [`Not refreshed: ${n.failed.join(", ")}`] : []),
    ...(n.run ? [`Run: <${n.run}>`] : []),
    ...(n.report ? [`Report: <${n.report}>`] : []),
  ].join("\n");
  if (!n.replan) return { text };
  return { text, blocks: [{ type: "section", text: { type: "mrkdwn", text } }, { type: "actions", block_id: "terragucci-drift", elements: [slackButton("Re-plan", REPLAN_ACTION, { url: n.replan })] }] };
}

/** The drift notice for Teams: an Adaptive Card whose Re-plan button opens the page where the check runs again. */
export function teamsDrift(n: DriftNotice): Record<string, unknown> {
  const facts = [
    ...(n.roots.length > 0 ? [{ title: "Drifted", value: n.roots.join(", ") }] : []),
    ...(n.failed.length > 0 ? [{ title: "Not refreshed", value: n.failed.join(", ") }] : []),
    ...(n.run ? [{ title: "Run", value: n.run }] : []),
  ];
  const actions = [...(n.replan ? [{ type: "Action.OpenUrl", title: "Re-plan", url: n.replan }] : []), ...(n.run ? [{ type: "Action.OpenUrl", title: "Open the run", url: n.run }] : [])];
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
            { type: "TextBlock", text: driftHeadline(n), weight: "Bolder", wrap: true },
            { type: "FactSet", facts },
          ],
          ...(actions.length > 0 ? { actions } : {}),
        },
      },
    ],
  };
}

/** Post a drift notice to the Slack and Teams webhooks the job holds. The generic webhook's event is a wave's, so it gets none. Never throws. */
export async function notifyDrift(n: DriftNotice | undefined, env: NodeJS.ProcessEnv = process.env, post: typeof fetch = fetch): Promise<string[]> {
  if (!n) return ["no drift found and every root refreshed; nothing posted"];
  const targets = [
    { name: "Slack", url: env[SLACK_WEBHOOK_ENV] ?? "", body: JSON.stringify(slackDrift(n)) },
    { name: "Teams", url: env[TEAMS_WEBHOOK_ENV] ?? "", body: JSON.stringify(teamsDrift(n)) },
  ].filter((t) => t.url);
  if (targets.length === 0) return [`no chat webhook: ${SLACK_WEBHOOK_ENV} and ${TEAMS_WEBHOOK_ENV} are empty`];
  const lines: string[] = [];
  for (const t of targets) {
    try {
      const r = await post(t.url, { method: "POST", headers: { "content-type": "application/json" }, body: t.body, signal: AbortSignal.timeout(10_000) });
      lines.push(r.ok ? `posted to ${t.name}: ${driftHeadline(n)}` : `${t.name} answered ${r.status}; nothing was posted`);
    } catch (e) {
      lines.push(`${t.name} did not answer (${(e as Error).message}); nothing was posted`);
    }
  }
  return lines;
}
