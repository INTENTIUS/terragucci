import { describe, expect, it } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import { validateConfig } from "../src/config";
import type { WaveOutcome } from "../src/apply";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { driftNotice, notify, notifyDrift, readOutcome, replanUrl, runUrl, signature, slackDrift, slackMessage, teamsDrift, teamsMessage, waveNotice, webhookEvent } from "../src/notify";
import { applyScript, renderPipeline } from "../src/render";
import { tmp, validate, write } from "./helpers";

const NOTIFY_SCHEMA = JSON.parse(readFileSync(join(import.meta.dirname, "../src/notify.schema.json"), "utf-8"));

const ENV = { GITHUB_SERVER_URL: "https://github.com", GITHUB_REPOSITORY: "acme/infra", GITHUB_RUN_ID: "42" };
const waiting: WaveOutcome = { schema: "terragucci.outcome/v1", status: "waiting", exit: 3, wave: 2, roots: ["envs/prod/app", "envs/prod/db"], line: "wave 2 waits: terragucci approve wave-2 --plan jcs1-sha256:ab", set_digest: "jcs1-sha256:ab", approval: "waiting", approval_mode: "ledger", approve_command: "terragucci approve wave-2 --plan jcs1-sha256:ab" };
const report = (): string => write(tmp(), { "report.json": JSON.stringify({ run: { project: "github.com/acme/infra" }, waves: [{ number: 2, roots: ["envs/prod/app", "envs/prod/db"] }] }) });

describe("notify: chat webhooks for a wave", () => {
  it("names the wave, its roots, the approve command and the run of a waiting wave", () => {
    const n = waveNotice("waiting", 2, { outcome: waiting.line, result: waiting, reportDir: report(), env: ENV });
    expect(n).toMatchObject({ project: "github.com/acme/infra", roots: ["envs/prod/app", "envs/prod/db"], digest: "jcs1-sha256:ab", run: "https://github.com/acme/infra/actions/runs/42" });
    expect(n.approve).toBe("npx terragucci approve wave-2 --plan jcs1-sha256:ab");
    const slack = slackMessage(n).text;
    for (const want of ["wave 2 of github.com/acme/infra waits for an approval", "envs/prod/app, envs/prod/db", "npx terragucci approve wave-2", "<https://github.com/acme/infra/actions/runs/42>"]) expect(slack).toContain(want);
    const card = teamsMessage(n) as any;
    expect(card.attachments[0].contentType).toBe("application/vnd.microsoft.card.adaptive");
    expect(card.attachments[0].content.body[0].text).toContain("wave 2 of github.com/acme/infra waits");
    expect(card.attachments[0].content.actions).toEqual([{ type: "Action.OpenUrl", title: "Open the run", url: "https://github.com/acme/infra/actions/runs/42" }]);
  });

  it("under pr-review, a waiting wave a review would approve links the pull request's review page first", () => {
    const result: WaveOutcome = { ...waiting, approval_mode: "pr-review", review: { pull_request: 7, url: "https://github.com/acme/infra/pull/7/files" } };
    const n = waveNotice("waiting", 2, { outcome: waiting.line, result, reportDir: report(), env: ENV });
    expect(n).toMatchObject({ digest: "jcs1-sha256:ab", review: { pr: 7, url: "https://github.com/acme/infra/pull/7/files" } });
    const lines = slackMessage(n).text.split("\n");
    expect(lines[1]).toBe("Review and approve: <https://github.com/acme/infra/pull/7/files|pull request 7>, then run the wave again");
    expect(lines).toContain("Digest: `jcs1-sha256:ab`");
    expect(lines.some((l) => l.startsWith("Or approve: `npx terragucci approve wave-2"))).toBe(true);
    const card = (teamsMessage(n) as any).attachments[0].content;
    expect(card.actions[0]).toEqual({ type: "Action.OpenUrl", title: "Review and approve", url: "https://github.com/acme/infra/pull/7/files" });
    expect(card.body[1].facts).toContainEqual({ title: "Digest", value: "jcs1-sha256:ab" });
    // A refused wave is never linked: a new review of the merged head cannot approve plans it never saw.
    expect(waveNotice("refused", 2, { result: { ...result, status: "refused", exit: 4 }, env: ENV }).review).toBeUndefined();
    // Without a review (ledger, sealed, or a wave no review covers) the message is as before.
    expect(slackMessage(waveNotice("waiting", 2, { result: waiting, reportDir: report(), env: ENV })).text).not.toContain("Review and approve");
  });

  it("says what a refused and a failed wave leave to a person", () => {
    const refusal = { schema: "terragucci.outcome/v1", status: "refused", exit: 4, wave: 3, roots: ["envs/prod/app", "envs/prod/db"], line: "wave 3 changed after approval: envs/prod/app", set_digest: "jcs1-sha256:dd", refused: { reason: "approval", approved: "jcs1-sha256:aa", by: "alice", roots: ["envs/prod/app"] } } as WaveOutcome;
    const refused = waveNotice("refused", 3, { result: refusal, env: ENV });
    expect(refused.roots).toEqual(["envs/prod/app"]);
    expect(refused.outcome).toBe("wave 3 changed after approval: envs/prod/app");
    expect(refused.approve).toBe("read the plans that moved, then npx terragucci approve wave-3 --plan jcs1-sha256:dd, or revert");
    expect(waveNotice("refused", 3, { result: { ...refusal, refused: { reason: "override", roots: ["envs/prod/app"] } }, env: ENV }).approve).toContain("policy override");
    expect(waveNotice("failed", 1, { env: ENV }).approve).toBe("nothing to approve: the apply failed; read the job log");
    const denied = { schema: "terragucci.outcome/v1", status: "failed", exit: 1, wave: 1, roots: ["envs/prod/app", "envs/prod/db"], refused: { reason: "policy", roots: ["envs/prod/app"] }, policy_denied: ["envs/prod/app"] } as WaveOutcome;
    expect(waveNotice("failed", 1, { result: denied, env: ENV })).toMatchObject({ roots: ["envs/prod/app"], approve: expect.stringContaining("override") });
    // An outcome of another wave, or another schema, is not read.
    expect(waveNotice("failed", 2, { result: denied, env: ENV }).roots).toEqual([]);
    expect(readOutcome(write(tmp(), { "o.json": JSON.stringify({ schema: "other" }) }) + "/o.json")).toBeUndefined();
    expect(readOutcome(write(tmp(), { "o.json": JSON.stringify(denied) }) + "/o.json")).toEqual(denied);
    expect(runUrl({ CI_JOB_URL: "https://gitlab.com/acme/infra/-/jobs/9" })).toBe("https://gitlab.com/acme/infra/-/jobs/9");
  });

  it("posts to each webhook set, and a webhook that fails is a line, not an error", async () => {
    const posted: string[] = [];
    const post = (async (url: string) => {
      posted.push(url);
      return new Response("no", { status: url.includes("teams") ? 500 : 200 });
    }) as unknown as typeof fetch;
    const n = waveNotice("waiting", 1, { env: ENV });
    const lines = await notify(n, { TERRAGUCCI_SLACK_WEBHOOK: "https://hooks.slack.test/a", TERRAGUCCI_TEAMS_WEBHOOK: "https://teams.test/b" }, post);
    expect(posted).toEqual(["https://hooks.slack.test/a", "https://teams.test/b"]);
    expect(lines[0]).toMatch(/^posted to Slack/);
    expect(lines[1]).toBe("Teams answered 500; nothing was posted");
    expect(lines.join("\n")).not.toContain("teams.test");
    expect(await notify(n, {}, post)).toEqual(["no webhook: TERRAGUCCI_SLACK_WEBHOOK, TERRAGUCCI_TEAMS_WEBHOOK and TERRAGUCCI_WEBHOOK are empty"]);
  });

  it("posts terragucci.notify/v1 to the generic webhook, signed over the raw body, and never unsigned", async () => {
    const env = { ...ENV, GITHUB_SHA: "c".repeat(40), TG_PR: "12", TERRAGUCCI_WEBHOOK: "https://hooks.test/tg", TERRAGUCCI_WEBHOOK_KEY: "k3y" };
    const n = waveNotice("waiting", 2, { outcome: waiting.line, result: waiting, reportDir: report(), env });
    const event = webhookEvent(n, env, new Date("2026-10-08T12:00:00Z"));
    expect(event).toMatchObject({ schema: "terragucci.notify/v1", event: "waiting", sent_at: "2026-10-08T12:00:00.000Z", project: "github.com/acme/infra", forge: "github", repo: "acme/infra", sha: "c".repeat(40), pr: 12, wave: 2, roots: ["envs/prod/app", "envs/prod/db"], run_url: "https://github.com/acme/infra/actions/runs/42", outcome: waiting });
    expect(validate(NOTIFY_SCHEMA, JSON.parse(JSON.stringify(event)))).toEqual([]);
    // One id per wave, event and digest: a re-run's post repeats it; another digest does not.
    expect(webhookEvent(n, env).id).toBe(event.id);
    expect(webhookEvent(waveNotice("waiting", 2, { result: { ...waiting, set_digest: "jcs1-sha256:ef" }, env }), env).id).not.toBe(event.id);
    const sent: { url: string; headers: Record<string, string>; body: string }[] = [];
    const post = (async (url: string, init: RequestInit) => {
      sent.push({ url, headers: init.headers as Record<string, string>, body: init.body as string });
      return new Response("", { status: 202 });
    }) as unknown as typeof fetch;
    expect(await notify(n, env, post)).toEqual(["posted to the webhook: terragucci: wave 2 of github.com/acme/infra waits for an approval"]);
    const [hook] = sent;
    expect(hook!.headers["x-terragucci-event"]).toBe("waiting");
    expect(hook!.headers["x-terragucci-signature"]).toBe(`sha256=${createHmac("sha256", "k3y").update(hook!.body).digest("hex")}`);
    expect(hook!.headers["x-terragucci-signature"]).toBe(signature(hook!.body, "k3y"));
    expect(JSON.parse(hook!.body).id).toBe(hook!.headers["x-terragucci-delivery"]);
    // No key: nothing is posted, and the log says why.
    sent.length = 0;
    expect(await notify(n, { ...env, TERRAGUCCI_WEBHOOK_KEY: "" }, post)).toEqual(["the webhook was not posted to: TERRAGUCCI_WEBHOOK_KEY is empty, and an event is never sent unsigned"]);
    expect(sent).toEqual([]);
    // A refused and a failed wave validate too, with the roots that moved or failed.
    const refused = webhookEvent(waveNotice("refused", 2, { result: { ...waiting, status: "refused", exit: 4, refused: { reason: "approval", approved: "jcs1-sha256:aa", by: "alice", roots: ["envs/prod/app"] } }, env }), env);
    expect(refused.roots).toEqual(["envs/prod/app"]);
    expect(validate(NOTIFY_SCHEMA, JSON.parse(JSON.stringify(refused)))).toEqual([]);
    expect(validate(NOTIFY_SCHEMA, JSON.parse(JSON.stringify(webhookEvent(waveNotice("failed", 1, { env: {} }), {}))))).toEqual([]);
  });

  it("takes secret names, never an address", () => {
    expect(validateConfig({ notify: { slack: "SLACK_WEBHOOK_URL" } }, "t").notify).toEqual({ slack: "SLACK_WEBHOOK_URL" });
    expect(() => validateConfig({ notify: { slack: "https://hooks.slack.com/services/x" } }, "t")).toThrow(/never the address itself/);
    expect(() => validateConfig({ notify: { discord: "X" } }, "t")).toThrow(/notify.discord is not a setting/);
    expect(() => validateConfig({ notify: {} }, "t")).toThrow(/notify must be a map/);
    expect(validateConfig({ notify: { webhook: "TG_HOOK_URL", webhook_key: "TG_HOOK_KEY" } }, "t").notify).toEqual({ webhook: "TG_HOOK_URL", webhook_key: "TG_HOOK_KEY" });
    expect(() => validateConfig({ notify: { webhook: "TG_HOOK_URL" } }, "t")).toThrow(/notify.webhook and notify.webhook_key go together/);
    expect(() => validateConfig({ notify: { webhook: "TG_HOOK_URL", webhook_key: "s3cr3t-key!" } }, "t")).toThrow(/never the key itself/);
  });

  it.each(["github", "forgejo", "gitlab"] as const)("%s: the apply jobs map the secrets and post on 3, 4 and any failure", (forge) => {
    const text = renderPipeline({ forge, binary: "tofu", version: "1.13.1", image: "img:1", layers: [["a"], ["b"]], env: {}, notify: { slack: "CHAT_SLACK", teams: "CHAT_TEAMS" } }).content;
    const doc = parseYAML(text.split("\n").filter((l) => !l.startsWith("#")).join("\n")) as Record<string, any>;
    const job = forge === "gitlab" ? doc["apply-wave-1"] : doc.jobs["apply-wave-1"];
    const env = forge === "gitlab" ? job.variables : job.env;
    expect(env.TERRAGUCCI_SLACK_WEBHOOK).toBe(forge === "gitlab" ? "$CHAT_SLACK" : "${{ secrets.CHAT_SLACK }}");
    expect(env.TERRAGUCCI_TEAMS_WEBHOOK).toBe(forge === "gitlab" ? "$CHAT_TEAMS" : "${{ secrets.CHAT_TEAMS }}");
    const plan = forge === "gitlab" ? doc.plan.variables : doc.jobs.plan.env;
    expect(plan.TERRAGUCCI_SLACK_WEBHOOK).toBeUndefined();
    const hooked = renderPipeline({ forge, binary: "tofu", version: "1.13.1", image: "img:1", layers: [["a"]], env: {}, notify: { webhook: "HOOK_URL", webhook_key: "HOOK_KEY" } }).content;
    const hookedDoc = parseYAML(hooked.split("\n").filter((l) => !l.startsWith("#")).join("\n")) as Record<string, any>;
    const hookedEnv = forge === "gitlab" ? hookedDoc["apply-wave-1"].variables : hookedDoc.jobs["apply-wave-1"].env;
    expect(hookedEnv.TERRAGUCCI_WEBHOOK).toBe(forge === "gitlab" ? "$HOOK_URL" : "${{ secrets.HOOK_URL }}");
    expect(hookedEnv.TERRAGUCCI_WEBHOOK_KEY).toBe(forge === "gitlab" ? "$HOOK_KEY" : "${{ secrets.HOOK_KEY }}");
    const script = applyScript("tofu", [["a"]], forge, undefined, { wave: 1, notify: true });
    for (const e of ["waiting", "refused", "failed"]) expect(script).toContain(`terragucci notify ${e} --wave 1 --outcome "$outcome" --outcome-json "$outcome_json" || true`);
    expect(script).toContain('TG_OUTCOME="$outcome" TG_OUTCOME_JSON="$outcome_json" terragucci stage tf-apply');
    expect(applyScript("tofu", [["a"]], forge, undefined, { wave: 1 })).not.toContain("terragucci notify");
  });
});

describe("notify: the relay's buttons", () => {
  it("with notify.relay, a waiting wave's Slack message carries Approve and Decline, each naming the wave and digest", () => {
    const n = waveNotice("waiting", 2, { result: waiting, reportDir: report(), env: { ...ENV, TERRAGUCCI_RELAY: "terragucci" } });
    expect(n.relay).toBe("terragucci");
    const m = slackMessage(n);
    expect(m.text).toBe(slackMessage({ ...n, relay: undefined }).text);
    const actions = m.blocks?.[1] as any;
    expect(actions.elements.map((e: any) => [e.action_id, e.text.text, JSON.parse(e.value)])).toEqual([
      ["terragucci-approve", "Approve", { wave: 2, plan: "jcs1-sha256:ab" }],
      ["terragucci-decline", "Decline", { wave: 2, plan: "jcs1-sha256:ab" }],
    ]);
    const card = (teamsMessage(n) as any).attachments[0].content;
    expect(card.body.at(-1).text).toBe("Approve here: reply @terragucci approve wave-2 jcs1-sha256:ab. Decline: reply @terragucci decline wave-2 jcs1-sha256:ab.");
  });

  it("a refused or failed wave, or one with no relay, gets no buttons", () => {
    expect(slackMessage(waveNotice("waiting", 2, { result: waiting, reportDir: report(), env: ENV })).blocks).toBeUndefined();
    const refused: WaveOutcome = { ...waiting, status: "refused", exit: 4 };
    expect(slackMessage(waveNotice("refused", 2, { result: refused, reportDir: report(), env: { ...ENV, TERRAGUCCI_RELAY: "terragucci" } })).blocks).toBeUndefined();
  });

  it("takes notify.relay as a name beside slack or teams", () => {
    expect(validateConfig({ notify: { slack: "S", relay: "terragucci" } }, "t").notify).toEqual({ slack: "S", relay: "terragucci" });
    expect(() => validateConfig({ notify: { webhook: "H", webhook_key: "K", relay: "terragucci" } }, "t")).toThrow(/notify.relay needs notify.slack or notify.teams/);
    expect(() => validateConfig({ notify: { slack: "S", relay: "<at>x</at>" } }, "t")).toThrow(/notify.relay must name your relay/);
  });

  it.each(["github", "forgejo", "gitlab"] as const)("%s: the apply jobs get the relay's name as a plain value", (forge) => {
    const text = renderPipeline({ forge, binary: "tofu", version: "1.13.1", image: "img:1", layers: [["a"]], env: {}, notify: { slack: "CHAT_SLACK", relay: "terragucci" } }).content;
    const doc = parseYAML(text.split("\n").filter((l) => !l.startsWith("#")).join("\n")) as Record<string, any>;
    const job = forge === "gitlab" ? doc["apply-wave-1"] : doc.jobs["apply-wave-1"];
    expect((forge === "gitlab" ? job.variables : job.env).TERRAGUCCI_RELAY).toBe("terragucci");
  });
});

describe("notify: drift", () => {
  const driftReport = (roots: { path: string; status: string; changes: unknown[] }[]): string => write(tmp(), { "report.json": JSON.stringify({ run: { project: "github.com/acme/infra" }, roots }) });

  it("names the drifted roots, and a Re-plan button opens the page where the check runs again", () => {
    const n = driftNotice(driftReport([{ path: "app", status: "planned", changes: [{}] }, { path: "net", status: "planned", changes: [] }, { path: "db", status: "failed", changes: [] }]), { ...ENV, GITHUB_WORKFLOW_REF: "acme/infra/.github/workflows/terragucci.yml@refs/heads/main" })!;
    expect(n).toEqual({ project: "github.com/acme/infra", roots: ["app"], failed: ["db"], run: "https://github.com/acme/infra/actions/runs/42", replan: "https://github.com/acme/infra/actions/workflows/terragucci.yml" });
    const slack = slackDrift(n);
    expect(slack.text.split("\n")).toEqual(["*terragucci: drift in github.com/acme/infra: 1 root changed outside Terraform, 1 could not be refreshed*", "Drifted: app", "Not refreshed: db", "Run: <https://github.com/acme/infra/actions/runs/42>"]);
    expect((slack.blocks?.[1] as any).elements).toEqual([{ type: "button", action_id: "terragucci-replan", text: { type: "plain_text", text: "Re-plan" }, url: n.replan }]);
    const card = (teamsDrift(n) as any).attachments[0].content;
    expect(card.actions[0]).toEqual({ type: "Action.OpenUrl", title: "Re-plan", url: n.replan });
  });

  it("opens the Run workflow page on Forgejo and the pipeline schedules on GitLab", () => {
    expect(replanUrl({ GITHUB_SERVER_URL: "http://forgejo:3000", GITHUB_REPOSITORY: "acme/infra", GITEA_ACTIONS: "true" })).toBe("http://forgejo:3000/acme/infra/actions?workflow=terragucci.yml");
    expect(replanUrl({ GITLAB_CI: "true", CI_PROJECT_URL: "https://gitlab.com/acme/infra" })).toBe("https://gitlab.com/acme/infra/-/pipeline_schedules");
  });

  it("posts nothing when there is no drift, and only to Slack and Teams", async () => {
    expect(driftNotice(driftReport([{ path: "app", status: "planned", changes: [] }]), ENV)).toBeUndefined();
    const posted: string[] = [];
    const post = (async (url: string) => (posted.push(url), { ok: true, status: 200 })) as any;
    const n = driftNotice(driftReport([{ path: "app", status: "planned", changes: [{}] }]), ENV);
    const lines = await notifyDrift(n, { TERRAGUCCI_SLACK_WEBHOOK: "https://s", TERRAGUCCI_WEBHOOK: "https://w", TERRAGUCCI_WEBHOOK_KEY: "k" }, post);
    expect(posted).toEqual(["https://s"]);
    expect(lines).toEqual(["posted to Slack: terragucci: drift in github.com/acme/infra: 1 root changed outside Terraform"]);
  });

  it.each(["github", "forgejo", "gitlab"] as const)("%s: the drift job gets the chat secrets, never the webhook's, and posts after the stage", (forge) => {
    const text = renderPipeline({ forge, binary: "tofu", version: "1.13.1", image: "img:1", layers: [["a"]], env: {}, drift: "0 6 * * *", notify: { slack: "CHAT_SLACK", webhook: "HOOK_URL", webhook_key: "HOOK_KEY" } }).content;
    const doc = parseYAML(text.split("\n").filter((l) => !l.startsWith("#")).join("\n")) as Record<string, any>;
    const job = forge === "gitlab" ? doc.drift : doc.jobs.drift;
    const env = forge === "gitlab" ? job.variables : job.env;
    expect(env.TERRAGUCCI_SLACK_WEBHOOK).toBe(forge === "gitlab" ? "$CHAT_SLACK" : "${{ secrets.CHAT_SLACK }}");
    expect(env.TERRAGUCCI_WEBHOOK).toBeUndefined();
    expect(text).toContain("terragucci notify drift --report terragucci-report || true");
    const quiet = renderPipeline({ forge, binary: "tofu", version: "1.13.1", image: "img:1", layers: [["a"]], env: {}, drift: "0 6 * * *", notify: { webhook: "HOOK_URL", webhook_key: "HOOK_KEY" } }).content;
    expect(quiet).not.toContain("terragucci notify drift");
  });
});
