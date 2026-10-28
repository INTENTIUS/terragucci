/**
 * terragucci#1282 (unit h), #1290 and #1289: agent runs on chant's run
 * ledger (chant#4616, #4619), the GitLab token of a GitHub or Forgejo publish
 * job, and the consumers check in the check job of a repo with `control`.
 */
import { describe, expect, test } from "vitest";
import { AGENT_OPS, agentRunRecord, chantAgentRunInput } from "../src/agent-record";
import { gitlabPublishToken } from "../src/config";
import { withConsumersCheck } from "../src/render";
import { ledgerEntries } from "../src/report/audit";

describe("agent runs as chant's run records", () => {
  const record = { ...agentRunRecord({ feature: "agent.comment", change: "/nowhere", result: "pushed", reason: "pushed abc", requestedBy: "ana", env: {} }, "2026-10-27T12:00:00Z"), model: "m", cost: { usd: 0.42, input_tokens: 10, output_tokens: 20 } };

  test("the op is the feature's, under local, with the cost where chant's money limit sums it", () => {
    const input = chantAgentRunInput(record, "2026-10-27T11:59:00Z", "abc123");
    expect(input.settings).toEqual({ name: AGENT_OPS["agent.comment"], on: "comment", env: "local" });
    expect(input.usage).toEqual({ model: "m", usd: 0.42, inputTokens: 10, outputTokens: 20 });
    expect(input.result).toBe("pushed");
    expect(input.gitSha).toBe("abc123");
  });

  test("a review's posted note, which pushes nothing, keeps its word in the reason", () => {
    const input = chantAgentRunInput({ ...record, feature: "review.agent", result: "posted", reason: "note 7" }, "2026-10-27T11:59:00Z");
    expect(input.result).toBe("opened");
    expect(input.reason).toBe("posted: note 7");
  });

  test("the audit lists a run record on the agent's run ledger", () => {
    const line = JSON.stringify({ version: 1, id: "r1", op: "terragucci-agent", env: "local", started: "a", ended: "2026-10-27T12:00:00Z", outcomes: { agent: { result: "pushed", reason: "pushed abc", requestedBy: "ana", usage: { usd: 0.42 } } } });
    const [entry] = ledgerEntries("p", "local/runs__terragucci-agent.jsonl", [{ commit: "c1", text: line, kind: "added" } as never]);
    expect(entry).toMatchObject({ kind: "agent-run", who: "ana", what: "agent.comment", result: "pushed" });
  });
});

describe("the publish job's GitLab token", () => {
  test("named only when a gitlab:// project is a target, GITLAB_TOKEN unless set", () => {
    expect(gitlabPublishToken({ publish: "git-tags" })).toBeUndefined();
    expect(gitlabPublishToken({ publish: "gitlab" })).toBeUndefined();
    expect(gitlabPublishToken({ publish: ["git-tags", "gitlab://gitlab.com/acme/modules"] })).toBe("GITLAB_TOKEN");
    expect(gitlabPublishToken({ publish: "gitlab://gitlab.com/acme/modules", gitlab_token: "GL_PUBLISH" })).toBe("GL_PUBLISH");
  });
});

describe("the consumers check", () => {
  test("runs before the check's last line with control, and not without", () => {
    const body = 'failed=0\nterraform fmt -check || failed=1\nexit "$failed"';
    expect(withConsumersCheck(body, false, false)).toBe(body);
    expect(withConsumersCheck(body, true, false).split("\n").slice(-2)).toEqual(["terragucci modules consumers --check || failed=1", 'exit "$failed"']);
  });
});
