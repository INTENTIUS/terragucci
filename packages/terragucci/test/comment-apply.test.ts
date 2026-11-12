import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decideComment, parseComment } from "../src/comment";
import type { Fetch } from "../src/forge";
import { tmp } from "./helpers";

// The decision of `/terragucci apply` is chant's comment job; these are the parts terragucci keeps: the grammar, and the re-plan job's answer.
const layers = [["network"], ["envs/dev/app", "envs/prod/app"]];

describe("parseComment: apply", () => {
  it("reads apply, with or without one wave", () => {
    expect(parseComment("/terragucci apply")).toEqual({ kind: "apply" });
    expect(parseComment("  /terragucci\tapply  \n")).toEqual({ kind: "apply" });
    expect(parseComment("/terragucci apply wave-2")).toEqual({ kind: "apply", wave: 2 });
  });

  it("refuses anything else after apply", () => {
    for (const c of ["/terragucci apply wave-0", "/terragucci apply wave-01", "/terragucci apply 2", "/terragucci apply wave-2 wave-3", "/terragucci apply envs/dev/app", "/terragucci apply wave-$(id)", "/terragucci apply wave-2\n/terragucci approve"]) {
      expect(parseComment(c), c).toMatchObject({ kind: "refused" });
    }
  });

  it("approve and force-unlock stay refused by name", () => {
    for (const v of ["approve", "force-unlock"]) expect((parseComment(`/terragucci ${v} wave-1`) as { reason: string }).reason).toContain(`never runs \`${v}\``);
  });
});

interface Sent { method: string; path: string; body?: any }

const MERGED = (sha: string) => ({ state: "closed", merged: true, merge_commit_sha: sha, head: { sha: "a".repeat(40), repo: { full_name: "acme/infra" } }, base: { ref: "main" } });

function setup(opts: { comment: string; pr?: any }): { env: NodeJS.ProcessEnv; fetch: Fetch; sent: Sent[] } {
  const dir = tmp("tg-comment-apply-");
  const file = join(dir, "event.json");
  writeFileSync(file, JSON.stringify({
    action: "created",
    comment: { body: opts.comment, user: { login: "dev" } },
    issue: { number: 7, pull_request: {} },
    repository: { full_name: "acme/infra", default_branch: "main" },
  }));
  const sent: Sent[] = [];
  const f: Fetch = async (url, init) => {
    const path = url.replace("https://forge.test/api/v1/", "");
    sent.push({ method: init?.method ?? "GET", path, body: init?.body ? JSON.parse(init.body) : undefined });
    const answer = (status: number, json: unknown) => ({ ok: status < 300, status, json: async () => json, text: async () => JSON.stringify(json) });
    if (path.includes("/permission")) return answer(200, { permission: "write" }) as never;
    if (path.includes("/pulls/")) return answer(200, opts.pr) as never;
    return answer(201, {}) as never;
  };
  return { env: { GITHUB_EVENT_PATH: file, GITHUB_REPOSITORY: "acme/infra", GITHUB_API_URL: "https://forge.test/api/v1", TG_TOKEN: "t" }, fetch: f, sent };
}

const replies = (s: { sent: Sent[] }): string[] => s.sent.filter((x) => x.method === "POST").map((x) => x.body.body as string);

describe("decideComment and apply", () => {
  it("the re-plan job answers an apply comment it is given by saying this pipeline does not apply on a comment", async () => {
    const s = setup({ comment: "/terragucci apply", pr: MERGED("b".repeat(40)) });
    const d = await decideComment({ layers, env: s.env, fetch: s.fetch });
    expect(d.go).toBe(false);
    expect(replies(s)[0]).toContain("does not apply on a comment");
  });
});
