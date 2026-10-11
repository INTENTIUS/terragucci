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
 * Delivery, signing and the generic webhook's event are chant's
 * (`@intentius/chant/notify`); terragucci decides when to send, renders its
 * own Slack and Teams messages and keeps the relay's buttons. The generic
 * webhook gets one `chant.notify/v1` event, with the stage's outcome
 * (`terragucci.outcome/v1`) in `detail`, signed with HMAC-SHA256 over
 * `<timestamp>.<body>` (`X-Terragucci-Signature: sha256=<hex>` beside
 * `X-Terragucci-Timestamp`). It is never posted unsigned.
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
import { ciRun, makeNotifyEvent, sendNotify, type NotifyConfig, type NotifyDelivery, type NotifyEvent, type SendNotifyOptions } from "@intentius/chant/notify";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { OUTCOME_SCHEMA, type WaveOutcome } from "./apply";

/** What the wave did. */
export const NOTIFY_EVENTS = ["waiting", "refused", "failed"] as const;
export type WaveEvent = (typeof NOTIFY_EVENTS)[number];

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

export interface WaveNotice {
  event: WaveEvent;
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
export function waveNotice(event: WaveEvent, wave: number, opts: { outcome?: string; result?: WaveOutcome; reportDir?: string; env?: NodeJS.ProcessEnv } = {}): WaveNotice {
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
function approveText(event: WaveEvent, wave: number, result?: WaveOutcome): string {
  // The pinned form: terragucci approve refuses when the plans moved past the digest the message names.
  const pinned = result?.set_digest ? `npx terragucci approve wave-${wave} --plan ${result.set_digest}` : `npx terragucci approve wave-${wave}`;
  // The stage's command is terragucci approve; an outcome from an older stage, which printed another command, gets the pinned form.
  if (event === "waiting") return result?.approve_command?.startsWith("terragucci approve ") ? `npx ${result.approve_command}` : pinned;
  if (event === "refused" && result?.refused?.reason === "override") return "nothing to approve: the plans changed after the policy override; read the job log";
  if (event === "refused") return `read the plans that moved, then ${pinned}, or revert`;
  if (result?.policy_denied?.length) return "nothing to approve: the policy denied it; an override command is in the job log";
  return "nothing to approve: the apply failed; read the job log";
}

/** The run's page, as chant reads it: GitHub and Forgejo name the run, GitLab the job. */
export const runUrl = (env: NodeJS.ProcessEnv): string | undefined => ciRun(env).url;

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

const HEADLINE: Record<WaveEvent, string> = {
  waiting: "waits for an approval",
  refused: "was refused: its plans changed after approval, so nothing in it was applied",
  failed: "failed",
};

/** What happened to the wave: the first line, after `terragucci: `. */
const summary = (n: WaveNotice): string => `wave ${n.wave} of ${n.project} ${HEADLINE[n.event]}`;

/** The first line of every message. */
export function headline(n: WaveNotice): string {
  return `${NOTIFY_SOURCE}: ${summary(n)}`;
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

/** The product name chant's event carries as its `source`. */
export const NOTIFY_SOURCE = "terragucci";
/** The webhook headers' prefix: `x-terragucci-signature`, `-timestamp`, `-event` and `-delivery`. */
export const HEADER_PREFIX = "x-terragucci";

/**
 * The generic webhook's event, chant's `chant.notify/v1`, for a notice: the
 * wave, its roots, the digest, how to approve a waiting wave, and the
 * stage's outcome whole in `detail`.
 */
export function webhookEvent(n: WaveNotice, env: NodeJS.ProcessEnv = process.env, now: Date = new Date()): NotifyEvent {
  const commit = env.TG_SHA?.trim() || undefined;
  const pr = /^\d+$/.test((env.TG_PR ?? "").trim()) ? Number(env.TG_PR) : undefined;
  const digest = n.result?.set_digest;
  return makeNotifyEvent(
    {
      source: NOTIFY_SOURCE,
      event: n.event,
      summary: summary(n),
      project: n.project,
      wave: { number: n.wave },
      targets: n.roots,
      ...(digest ? { digest } : {}),
      ...(n.event === "waiting" ? { approve: { command: n.approve, ...(n.review ? { review: n.review } : {}) } } : {}),
      ...(n.result?.status ? { status: n.result.status } : {}),
      ...(n.outcome ? { reason: n.outcome } : {}),
      ...(typeof n.result?.exit === "number" ? { exitCode: n.result.exit } : {}),
      run: { ...(n.run ? { url: n.run } : {}), ...(commit ? { commit } : {}), ...(pr !== undefined ? { pr } : {}) },
      ...(n.report ? { reportUrl: n.report } : {}),
      ...(n.result ? { detail: n.result as unknown as Record<string, unknown> } : {}),
    },
    { env, now },
  );
}

/** What {@link notify} and {@link notifyDrift} pass on to chant's sendNotify: tests set the fetch, the wait between tries and the clock (seconds). */
export type SendOptions = Pick<SendNotifyOptions, "fetch" | "sleep" | "now" | "attempts">;

const LABEL: Record<NotifyDelivery["target"], string> = { webhook: "the webhook", slack: "Slack", teams: "Teams" };

/** The targets the job holds a secret for. chant's config names the variables; the webhook goes with its key. */
function targets(env: NodeJS.ProcessEnv, webhook: boolean): NotifyConfig {
  return {
    ...(webhook && env[WEBHOOK_ENV] ? { webhook: WEBHOOK_ENV, key: WEBHOOK_KEY_ENV } : {}),
    ...(env[SLACK_WEBHOOK_ENV] ? { slack: SLACK_WEBHOOK_ENV } : {}),
    ...(env[TEAMS_WEBHOOK_ENV] ? { teams: TEAMS_WEBHOOK_ENV } : {}),
  };
}

/** Send through chant, with terragucci's own Slack and Teams bodies, and make each delivery a log line. */
async function send(config: NotifyConfig, event: NotifyEvent, render: SendNotifyOptions["render"], line: string, env: NodeJS.ProcessEnv, opts: SendOptions): Promise<string[]> {
  const deliveries = await sendNotify(config, event, { ...opts, env, ...(render ? { render } : {}), prefix: HEADER_PREFIX, userAgent: NOTIFY_SOURCE, log: () => {} });
  return deliveries.map((d) => (d.ok ? `posted to ${LABEL[d.target]}: ${line}` : `${LABEL[d.target]}: ${d.detail}; nothing was posted`));
}

/**
 * Post the notice to every webhook the job holds, through chant's notify.
 * Slack and Teams get terragucci's messages (with the relay's buttons); the
 * generic webhook gets {@link webhookEvent}, signed over
 * `<timestamp>.<body>`, and nothing without its key. Returns one line per
 * webhook for the log; never throws.
 */
export async function notify(n: WaveNotice, env: NodeJS.ProcessEnv = process.env, opts: SendOptions = {}): Promise<string[]> {
  const config = targets(env, true);
  if (!config.webhook && !config.slack && !config.teams) return [`no webhook: ${SLACK_WEBHOOK_ENV}, ${TEAMS_WEBHOOK_ENV} and ${WEBHOOK_ENV} are empty`];
  const event = webhookEvent(n, env, opts.now !== undefined ? new Date(opts.now * 1000) : new Date());
  return send(config, event, { slack: () => slackMessage(n), teams: () => teamsMessage(n) }, headline(n), env, opts);
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

/** chant's `drift` event for a drift notice. Only Slack and Teams get it, in terragucci's own messages. */
function driftEvent(n: DriftNotice, env: NodeJS.ProcessEnv): NotifyEvent {
  return makeNotifyEvent(
    { source: NOTIFY_SOURCE, event: "drift", summary: driftHeadline(n).slice(`${NOTIFY_SOURCE}: `.length), project: n.project, targets: n.roots, drift: { changed: n.roots, ...(n.failed.length > 0 ? { failed: n.failed } : {}) }, run: n.run ? { url: n.run } : {}, ...(n.report ? { reportUrl: n.report } : {}) },
    { env },
  );
}

/** Post a drift notice to the Slack and Teams webhooks the job holds, through chant's notify. The generic webhook's event is a wave's, so it gets none. Never throws. */
export async function notifyDrift(n: DriftNotice | undefined, env: NodeJS.ProcessEnv = process.env, opts: SendOptions = {}): Promise<string[]> {
  if (!n) return ["no drift found and every root refreshed; nothing posted"];
  const config = targets(env, false);
  if (!config.slack && !config.teams) return [`no chat webhook: ${SLACK_WEBHOOK_ENV} and ${TEAMS_WEBHOOK_ENV} are empty`];
  return send(config, driftEvent(n, env), { slack: () => slackDrift(n), teams: () => teamsDrift(n) }, driftHeadline(n), env, opts);
}
