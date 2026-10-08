import { describe, expect, it } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import { validateConfig } from "../src/config";
import { notify, runUrl, slackMessage, teamsMessage, waveNotice } from "../src/notify";
import { applyScript, renderPipeline } from "../src/render";
import { tmp, write } from "./helpers";

const ENV = { GITHUB_SERVER_URL: "https://github.com", GITHUB_REPOSITORY: "acme/infra", GITHUB_RUN_ID: "42" };
const report = (): string => write(tmp(), { "report.json": JSON.stringify({ run: { project: "github.com/acme/infra" }, waves: [{ number: 2, roots: ["envs/prod/app", "envs/prod/db"] }] }) });

describe("notify: chat webhooks for a wave", () => {
  it("names the wave, its roots, the approve command and the run of a waiting wave", () => {
    const n = waveNotice("waiting", 2, { outcome: "wave 2 waits: chant approve tf-apply wave-2 --plan jcs1-sha256:ab", reportDir: report(), env: ENV });
    expect(n).toMatchObject({ project: "github.com/acme/infra", roots: ["envs/prod/app", "envs/prod/db"], run: "https://github.com/acme/infra/actions/runs/42" });
    expect(n.approve).toBe("chant approve tf-apply wave-2 --plan jcs1-sha256:ab (or npx terragucci approve wave-2)");
    const slack = slackMessage(n).text;
    for (const want of ["wave 2 of github.com/acme/infra waits for an approval", "envs/prod/app, envs/prod/db", "chant approve tf-apply wave-2", "<https://github.com/acme/infra/actions/runs/42>"]) expect(slack).toContain(want);
    const card = teamsMessage(n) as any;
    expect(card.attachments[0].contentType).toBe("application/vnd.microsoft.card.adaptive");
    expect(card.attachments[0].content.body[0].text).toContain("wave 2 of github.com/acme/infra waits");
    expect(card.attachments[0].content.actions).toEqual([{ type: "Action.OpenUrl", title: "Open the run", url: "https://github.com/acme/infra/actions/runs/42" }]);
  });

  it("says what a refused and a failed wave leave to a person", () => {
    const refused = waveNotice("refused", 3, { outcome: "wave 3 changed after approval: envs/prod/app", env: ENV });
    expect(refused.roots).toEqual(["envs/prod/app"]);
    expect(refused.approve).toContain("npx terragucci approve wave-3");
    expect(waveNotice("failed", 1, { env: ENV }).approve).toBe("nothing to approve: the apply failed; read the job log");
    expect(waveNotice("failed", 1, { outcome: "wave 1 refused by policy: envs/prod/app", env: ENV }).approve).toContain("override");
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
    expect(await notify(n, {}, post)).toEqual(["no webhook: TERRAGUCCI_SLACK_WEBHOOK and TERRAGUCCI_TEAMS_WEBHOOK are empty"]);
  });

  it("takes secret names, never an address", () => {
    expect(validateConfig({ notify: { slack: "SLACK_WEBHOOK_URL" } }, "t").notify).toEqual({ slack: "SLACK_WEBHOOK_URL" });
    expect(() => validateConfig({ notify: { slack: "https://hooks.slack.com/services/x" } }, "t")).toThrow(/never the address itself/);
    expect(() => validateConfig({ notify: { discord: "X" } }, "t")).toThrow(/notify.discord is not a setting/);
    expect(() => validateConfig({ notify: {} }, "t")).toThrow(/notify must be a map/);
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
    const script = applyScript("tofu", [["a"]], forge, undefined, { wave: 1, notify: true });
    for (const e of ["waiting", "refused", "failed"]) expect(script).toContain(`terragucci notify ${e} --wave 1 --outcome "$outcome" || true`);
    expect(applyScript("tofu", [["a"]], forge, undefined, { wave: 1 })).not.toContain("terragucci notify");
  });
});
