import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError } from "../src/config";
import { poster } from "../src/forge";
import { writePlanNoteNotices } from "../src/plan-note";

const SHA = "a".repeat(40);
const ENV = { TG_TOKEN: "t", TG_PR: "7", TG_SHA: SHA, GITHUB_REPOSITORY: "o/r", GITHUB_API_URL: "http://api", GITHUB_SERVER_URL: "http://forge", GITHUB_RUN_ID: "5" };

function report(waits: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "plan-note-"));
  writeFileSync(join(dir, "report.json"), JSON.stringify({ waves: [{ number: 1, waits }] }));
  return dir;
}

/** A forge that records each call and answers from `answer`. */
function forge(answer: (method: string, path: string) => unknown = () => ({})) {
  const calls: { method: string; path: string }[] = [];
  const fetch = (async (url: string, init?: { method?: string }) => {
    const method = init?.method ?? "GET";
    const path = url.replace("http://api/", "");
    calls.push({ method, path });
    const data = answer(method, path);
    return { ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) };
  }) as never;
  return { calls, fetch };
}

describe("terragucci plan-note: the note's notice, for chant's note job", () => {
  it("a plan no wave of which waits asks the forge nothing and writes no notice", async () => {
    const notices = join(mkdtempSync(join(tmpdir(), "notices-")), "n");
    const { calls, fetch } = forge();
    await writePlanNoteNotices({ forge: "github", report: report(false), notices, env: ENV, fetch });
    expect(calls).toEqual([]);
    expect(existsSync(notices)).toBe(false);
  });

  it("a waiting wave names whose review does not count, one line in the file chant adds under the counts", async () => {
    const notices = join(mkdtempSync(join(tmpdir(), "notices-")), "n");
    const { fetch } = forge((_m, p) => {
      if (p === "repos/o/r/pulls/7") return { number: 7, user: { login: "alice" }, head: { sha: SHA } };
      if (p.startsWith("repos/o/r/pulls/7/commits")) return [{ sha: SHA, author: { login: "alice" }, commit: { author: { email: "a@x" }, committer: { email: "a@x" }, message: "m" } }];
      return [];
    });
    await writePlanNoteNotices({ forge: "github", report: report(true), notices, env: ENV, fetch });
    expect(readFileSync(notices, "utf-8")).toMatch(/^A review by alice doesn't count toward the gate, because they had a hand in this change: .+\.\n$/);
  });

  it("says why when the job names no pull request and head, and writes nothing", async () => {
    const notices = join(mkdtempSync(join(tmpdir(), "notices-")), "n");
    const said = await writePlanNoteNotices({ forge: "github", report: report(true), notices, env: { ...ENV, TG_SHA: "" } });
    expect(said[0]).toMatch(/TG_PR and TG_SHA/);
    expect(existsSync(notices)).toBe(false);
  });

  it("names the missing variable when the job cannot ask the forge", () => {
    expect(() => poster("github", { GITHUB_REPOSITORY: "o/r" })).toThrow(ConfigError);
    expect(() => poster("github", { GITHUB_REPOSITORY: "o/r" })).toThrow(/TG_TOKEN/);
  });
});
