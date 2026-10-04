import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import { validateConfig } from "../src/config";
import { applyScript, planScript, renderPipeline } from "../src/render";
import type { ForgeName } from "../src/config";
import { git, tmp } from "./helpers";

const OIDC = { plan_role: "arn:aws:iam::111:role/plan-ro", apply_role: "arn:aws:iam::111:role/apply-rw" };
const layers = [["network"], ["app", "cache"]];
const FORGES: ForgeName[] = ["github", "forgejo", "gitlab"];

const render = (forge: ForgeName, oidc?: typeof OIDC): string =>
  renderPipeline({ forge, binary: "tofu", version: "1.13.1", image: "img:1", layers, env: {}, oidc }).content;

const body = (text: string): Record<string, any> => parseYAML(text.split("\n").filter((l) => !l.startsWith("#")).join("\n")) as Record<string, any>;

describe("apply concurrency", () => {
  it.each(["github", "forgejo"] as const)("%s: one apply per project, a waiting push is not cancelled", (forge) => {
    const apply = body(render(forge)).jobs.apply;
    expect(apply.concurrency).toEqual({ group: "terragucci-apply-${{ github.repository }}", "cancel-in-progress": false });
    expect(body(render(forge)).jobs.check.concurrency).toBeUndefined();
  });

  it("gitlab: the apply job is a resource group", () => {
    const doc = body(render("gitlab"));
    expect(doc.apply.resource_group).toBe("terragucci-apply");
    expect(doc.check.resource_group).toBeUndefined();
  });

  it("forgejo names a workflow-level group that does not cancel, or a later push cancels a run that is applying", () => {
    expect(body(render("forgejo")).concurrency).toEqual({ group: "terragucci-${{ github.ref }}", "cancel-in-progress": false });
    expect(body(render("github")).concurrency).toBeUndefined();
  });

  it("forgejo also takes a lock on the remote, because the runner ignores concurrency", () => {
    expect(render("forgejo")).toContain("refs/tags/terragucci-apply-lock");
    expect(render("github")).not.toContain("terragucci-apply-lock");
    expect(render("gitlab")).not.toContain("terragucci-apply-lock");
  });
});

describe("statuses", () => {
  it.each(FORGES)("%s: one status per stage, never one per root", (forge) => {
    const text = render(forge);
    const contexts = [...text.matchAll(/tg status (terragucci\/[a-z]+) /g)].map((m) => m[1]);
    expect([...new Set(contexts)].sort()).toEqual(["terragucci/apply", "terragucci/plan"]);
    expect(planScript("tofu", layers, forge)).not.toMatch(/tg status [^\n]*\$dir/);
    expect(applyScript("tofu", layers, forge)).not.toMatch(/tg status [^\n]*\$dir/);
  });

  it("plan runs on pull requests only and apply on the default branch only", () => {
    const gh = body(render("github")).jobs;
    expect(gh.plan.if).toContain("github.event_name == 'pull_request'");
    expect(gh.apply.if).toContain("default_branch");
    const gl = body(render("gitlab"));
    expect(gl.plan.rules[0].if).toContain("merge_request_event");
    expect(gl.apply.rules[0].if).toContain("CI_DEFAULT_BRANCH");
  });
});

describe("credentials", () => {
  it.each(FORGES)("%s: the plan job holds the plan role and the apply job holds the apply role, never the other", (forge) => {
    const doc = body(render(forge, OIDC));
    const jobs = forge === "gitlab" ? doc : doc.jobs;
    const flat = (j: unknown): string => JSON.stringify(j);
    expect(flat(jobs.plan)).toContain(OIDC.plan_role);
    expect(flat(jobs.plan)).not.toContain(OIDC.apply_role);
    expect(flat(jobs.apply)).toContain(OIDC.apply_role);
    expect(flat(jobs.apply)).not.toContain(OIDC.plan_role);
    expect(flat(jobs.check)).not.toMatch(/role/);
  });

  it("github: id-token is written for plan and apply, and neither job gets contents: write", () => {
    const doc = body(render("github", OIDC));
    for (const j of ["plan", "apply"]) {
      expect(doc.jobs[j].permissions["id-token"]).toBe("write");
      expect(doc.jobs[j].permissions.contents).toBe("read");
    }
    expect(doc.permissions).toEqual({ contents: "read" });
  });

  it("forgejo: the runner ignores permissions, so the dialect drops them and the token comes from the runner's own OIDC endpoint", () => {
    const text = render("forgejo", OIDC);
    expect(text).not.toMatch(/permissions:/);
    expect(text).toContain("tg oidc");
  });

  it.each(["github", "forgejo"] as const)("%s: a fork's pull request runs no plan, so no token or OIDC reaches it", (forge) => {
    const jobs = body(render(forge, OIDC)).jobs;
    expect(jobs.plan.if).toContain("github.event.pull_request.head.repo.full_name == github.repository");
    expect(jobs.check.if).toContain("!= github.repository");
    expect(render(forge)).not.toContain("pull_request_target");
    expect(render(forge)).not.toContain("secrets.");
  });

  it("gitlab: id_tokens on plan and apply, and plan skips a fork's merge request", () => {
    const doc = body(render("gitlab", OIDC));
    expect(doc.plan.id_tokens).toEqual({ TERRAGUCCI_OIDC: { aud: "sts.amazonaws.com" } });
    expect(doc.apply.id_tokens).toEqual({ TERRAGUCCI_OIDC: { aud: "sts.amazonaws.com" } });
    expect(doc.check.id_tokens).toBeUndefined();
    expect(doc.plan.rules[0].if).toContain("$CI_MERGE_REQUEST_SOURCE_PROJECT_PATH == $CI_PROJECT_PATH");
  });

  it.each(FORGES)("%s: with no oidc setting there is no id-token and no role", (forge) => {
    const text = render(forge);
    expect(text).not.toMatch(/id-token|id_tokens|AWS_ROLE_ARN/);
  });

  it("the config refuses one role for both stages, and a half-set pair", () => {
    expect(() => validateConfig({ oidc: { plan_role: "r", apply_role: "r" } }, "t")).toThrow(/same role/);
    expect(() => validateConfig({ oidc: { plan_role: "r" } }, "t")).toThrow(/apply_role must name a role/);
    expect(validateConfig({ oidc: OIDC }, "t").oidc).toEqual(OIDC);
  });
});

// ── running the generated scripts ────────────────────────────────────────────

/** A directory with fake binaries first on PATH. */
function fakeBin(script: string): { dir: string; env: Record<string, string> } {
  const dir = tmp("tg-bin-");
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "tofu"), script);
  chmodSync(join(bin, "tofu"), 0o755);
  return { dir, env: { PATH: `${bin}:${process.env.PATH}` } };
}

describe("the plugin cache", () => {
  it("roots applied together never share a cache directory, even when the env names one", () => {
    const { dir, env } = fakeBin(
      `#!/usr/bin/env bash\ncase " $* " in *" init "*) echo "$(basename "$2") $TF_PLUGIN_CACHE_DIR" >> "${"$"}{LOG}"; sleep 0.3 ;; esac\nmkdir -p "$TF_PLUGIN_CACHE_DIR"; exit 0\n`,
    );
    const log = join(dir, "cache.log");
    const script = join(dir, "apply.sh");
    writeFileSync(script, applyScript("tofu", [["a", "b", "c"]], "github"));
    const r = spawnSync("bash", [script], { env: { ...process.env, ...env, LOG: log, TF_PLUGIN_CACHE_DIR: "/shared/cache" }, encoding: "utf-8" });
    expect(r.status).toBe(0);
    const dirs = readFileSync(log, "utf-8").trim().split("\n").map((l) => l.split(" ")[1]);
    expect(dirs).toHaveLength(3);
    expect(new Set(dirs).size).toBe(3);
    expect(dirs).not.toContain("/shared/cache");
    for (const d of dirs) expect(existsSync(d)).toBe(false);
  });
});

interface Hit { method: string; url: string; body: any }

/** A stand-in forge API: records requests, answers from `routes`. */
async function stubApi(routes: (hit: Hit) => unknown): Promise<{ url: string; hits: Hit[]; close: () => void }> {
  const hits: Hit[] = [];
  const server = createServer((req: IncomingMessage, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const hit = { method: req.method!, url: req.url!, body: raw ? JSON.parse(raw) : undefined };
      hits.push(hit);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(routes(hit) ?? {}));
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, hits, close: () => server.close() };
}

function run(script: string, env: Record<string, string>): Promise<{ status: number | null; out: string }> {
  return new Promise((ok) => {
    const p = spawn("bash", ["-c", script], { env: { ...process.env, ...env } });
    let out = "";
    p.stdout.on("data", (c) => (out += c));
    p.stderr.on("data", (c) => (out += c));
    p.on("close", (status) => ok({ status, out }));
  });
}

const PLAN_TEXT = (add: number, destroy: number): string => `Plan: ${add} to add, 0 to change, ${destroy} to destroy.`;

describe("the plan stage", () => {
  it("posts one status with root, group and destroy counts, and one note", async () => {
    const { env } = fakeBin(`#!/usr/bin/env bash\ncase "$*" in *" plan "*) case "$*" in *network*|*app*) echo "${PLAN_TEXT(1, 0)}" ;; *) echo "${PLAN_TEXT(0, 2)}" ;; esac ;; esac\nexit 0\n`);
    const api = await stubApi(() => []);
    try {
      const r = await run(planScript("tofu", [["network"], ["app", "cache"]], "github"), {
        ...env, TG_TOKEN: "t", TG_SHA: "abc123", TG_PR: "7", GITHUB_API_URL: api.url, GITHUB_REPOSITORY: "acme/infra",
        GITHUB_SERVER_URL: "http://forge", GITHUB_RUN_ID: "9",
      });
      expect(r.status).toBe(0);
      const statuses = api.hits.filter((h) => h.url.includes("/statuses/"));
      expect(statuses.map((h) => [h.url, h.body.context, h.body.state])).toEqual([
        ["/repos/acme/infra/statuses/abc123", "terragucci/plan", "pending"],
        ["/repos/acme/infra/statuses/abc123", "terragucci/plan", "success"],
      ]);
      expect(statuses[1].body.description).toBe("3 roots, 2 groups, 2 destroys");
      const note = api.hits.find((h) => h.method === "POST" && h.url === "/repos/acme/infra/issues/7/comments")!;
      expect(note.body.body.split("\n")[0]).toBe("<!-- terragucci:plan roots=network,app,cache -->");
      expect(note.body.body).toContain("| cache | Plan: 0 to add, 0 to change, 2 to destroy. |");
    } finally {
      api.close();
    }
  });

  it("a root that fails to plan fails the stage and its status", async () => {
    const { env } = fakeBin(`#!/usr/bin/env bash\ncase "$*" in *" plan "*) exit 1 ;; esac\nexit 0\n`);
    const api = await stubApi(() => []);
    try {
      const r = await run(planScript("tofu", [["a"]], "github"), { ...env, TG_TOKEN: "t", TG_SHA: "s", GITHUB_API_URL: api.url, GITHUB_REPOSITORY: "o/r" });
      expect(r.status).toBe(1);
      expect(api.hits.at(-1)!.body).toMatchObject({ context: "terragucci/plan", state: "failure" });
    } finally {
      api.close();
    }
  });

  it("plans without taking the state lock, so a pull request never blocks an apply", () => {
    expect(planScript("tofu", layers, "github")).toContain("-lock=false");
  });
});

describe("stale plan notes", () => {
  const applyEnv = (api: string, bin: Record<string, string>): Record<string, string> => ({
    ...bin, TG_TOKEN: "t", TG_SHA: "s", TG_BRANCH: "main", GITHUB_API_URL: api, GITHUB_REPOSITORY: "acme/infra", GITHUB_SERVER_URL: "http://forge", GITHUB_RUN_ID: "1",
  });
  const noteFor = (roots: string): { id: number; body: string } => ({ id: 55, body: `<!-- terragucci:plan roots=${roots} -->\n## terragucci plan\n` });

  it("marks a note stale when main moved under one of its roots", async () => {
    const { env } = fakeBin("#!/usr/bin/env bash\nexit 0\n");
    const api = await stubApi((h) => (h.url.startsWith("/repos/acme/infra/pulls") ? [{ number: 7 }] : h.url.includes("/issues/7/comments") && h.method === "GET" ? [noteFor("network,other")] : {}));
    try {
      const r = await run(applyScript("tofu", [["network"], ["app"]], "github"), applyEnv(api.url, env));
      expect(r.status).toBe(0);
      const edit = api.hits.find((h) => h.method === "PATCH")!;
      expect(edit.url).toBe("/repos/acme/infra/issues/comments/55");
      const lines = edit.body.body.split("\n");
      expect(lines[0]).toBe("<!-- terragucci:plan roots=network,other -->");
      expect(lines[1]).toBe("> This plan is stale: main moved under network. Push to this pull request to plan again. <!-- terragucci:stale -->");
    } finally {
      api.close();
    }
  });

  it("leaves a note alone when none of its roots moved, or when it is already stale", async () => {
    const { env } = fakeBin("#!/usr/bin/env bash\nexit 0\n");
    const stale = { id: 55, body: "<!-- terragucci:plan roots=app -->\n> stale <!-- terragucci:stale -->\n" };
    for (const note of [noteFor("elsewhere"), stale]) {
      const api = await stubApi((h) => (h.url.startsWith("/repos/acme/infra/pulls") ? [{ number: 7 }] : h.method === "GET" ? [note] : {}));
      try {
        await run(applyScript("tofu", [["app"]], "github"), applyEnv(api.url, env));
        expect(api.hits.some((h) => h.method === "PATCH")).toBe(false);
      } finally {
        api.close();
      }
    }
  });

  it("posts apply as pending, then success, once for the whole stage", async () => {
    const { env } = fakeBin("#!/usr/bin/env bash\nexit 0\n");
    const api = await stubApi(() => []);
    try {
      await run(applyScript("tofu", layers, "github"), applyEnv(api.url, env));
      const s = api.hits.filter((h) => h.url.includes("/statuses/")).map((h) => [h.body.context, h.body.state, h.body.description]);
      expect(s).toEqual([
        ["terragucci/apply", "pending", "applying"],
        ["terragucci/apply", "success", "3 roots in 2 groups applied"],
      ]);
    } finally {
      api.close();
    }
  });
});

describe("two concurrent pushes to main on forgejo", () => {
  it("apply one after the other", async () => {
    const origin = tmp("tg-origin-");
    git(origin, "init", "-q", "--bare");
    const work = tmp("tg-work-");
    git(work, "init", "-q", "-b", "main");
    git(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "one");
    git(work, "remote", "add", "origin", origin);
    git(work, "push", "-q", "origin", "main");
    const sha = git(work, "rev-parse", "HEAD").trim();
    const { dir, env } = fakeBin(
      `#!/usr/bin/env bash\ncase " $* " in *" apply "*) echo "start $RUN $(date +%s.%N)" >> "$LOG"; sleep 1; echo "end $RUN $(date +%s.%N)" >> "$LOG" ;; esac\nexit 0\n`,
    );
    const log = join(dir, "apply.log");
    const script = applyScript("tofu", [["a"]], "forgejo");
    const base = { ...env, LOG: log, TG_BRANCH: "main", GITHUB_REF_NAME: "main", GITHUB_SHA: sha, TG_SHA: sha, TG_LOCK_POLL: "0.2" };
    const go = (id: string) => spawnSync("true") && new Promise<{ status: number | null; out: string }>((ok) => {
      const p = spawn("bash", ["-c", script], { cwd: work, env: { ...process.env, ...base, RUN: id, GITHUB_RUN_ID: id } });
      let out = "";
      p.stdout.on("data", (c) => (out += c));
      p.stderr.on("data", (c) => (out += c));
      p.on("close", (status) => ok({ status, out }));
    });
    const results = await Promise.all([go("1"), go("2")]);
    expect(results.map((r) => r.status)).toEqual([0, 0]);
    const events = readFileSync(log, "utf-8").trim().split("\n").map((l) => l.split(" "));
    expect(events.map((e) => e[0])).toEqual(["start", "end", "start", "end"]);
    expect(events[0][1]).toBe(events[1][1]);
    expect(Number(events[1][2])).toBeLessThanOrEqual(Number(events[2][2]));
    expect(git(origin, "tag", "--list").trim()).toBe("");
  }, 30_000);

  it("a run whose commit is no longer the branch tip stands down", async () => {
    const origin = tmp("tg-origin-");
    git(origin, "init", "-q", "--bare");
    const work = tmp("tg-work-");
    git(work, "init", "-q", "-b", "main");
    git(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "one");
    git(work, "remote", "add", "origin", origin);
    git(work, "push", "-q", "origin", "main");
    const { dir, env } = fakeBin(`#!/usr/bin/env bash\ncase " $* " in *" apply "*) echo applied >> "$LOG" ;; esac\nexit 0\n`);
    const log = join(dir, "apply.log");
    const r = await run(`cd ${work} && ${applyScript("tofu", [["a"]], "forgejo")}`, {
      ...env, LOG: log, TG_BRANCH: "main", GITHUB_REF_NAME: "main", GITHUB_SHA: "0".repeat(40), TG_SHA: "0".repeat(40), GITHUB_RUN_ID: "1",
    });
    expect(r.status).toBe(0);
    expect(r.out).toContain("standing down");
    expect(existsSync(log)).toBe(false);
  });

  describe("a holder that died without releasing the lock", () => {
    function held(lease: string): { origin: string; work: string; sha: string } {
      const origin = tmp("tg-origin-");
      git(origin, "init", "-q", "--bare");
      const work = tmp("tg-work-");
      git(work, "init", "-q", "-b", "main");
      git(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "one");
      git(work, "remote", "add", "origin", origin);
      git(work, "push", "-q", "origin", "main");
      const sha = git(work, "rev-parse", "HEAD").trim();
      const tree = git(work, "mktree").trim();
      const dead = git(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit-tree", tree, "-m", lease).trim();
      git(work, "push", "-q", "origin", `${dead}:refs/tags/terragucci-apply-lock`);
      return { origin, work, sha };
    }
    const env = (sha: string, extra: Record<string, string> = {}): Record<string, string> => ({
      TG_BRANCH: "main", GITHUB_REF_NAME: "main", GITHUB_SHA: sha, TG_SHA: sha, GITHUB_RUN_ID: "5", TG_LOCK_POLL: "0.2", ...extra,
    });

    it("is taken over when its run is no longer running, per the forge API", async () => {
      const { origin, work, sha } = held(`run 99 ${Math.floor(Date.now() / 1000)}`);
      const { env: bin } = fakeBin("#!/usr/bin/env bash\nexit 0\n");
      const api = await stubApi((h) => (h.url === "/repos/acme/infra/actions/runs/99" ? { status: "cancelled" } : {}));
      try {
        const r = await run(`cd ${work} && ${applyScript("tofu", [["a"]], "forgejo")}`, env(sha, { ...bin, TG_TOKEN: "t", GITHUB_API_URL: api.url, GITHUB_REPOSITORY: "acme/infra" }));
        expect(r.status).toBe(0);
        expect(r.out).toContain("run 99, which is gone; taking it over");
        expect(r.out).toContain("all roots applied");
        expect(git(origin, "tag", "--list").trim()).toBe("");
      } finally {
        api.close();
      }
    });

    it("is taken over when its lease is stale, with no forge API to ask", async () => {
      const { origin, work, sha } = held("run 99 1000");
      const { env: bin } = fakeBin("#!/usr/bin/env bash\nexit 0\n");
      const r = await run(`cd ${work} && ${applyScript("tofu", [["a"]], "forgejo")}`, env(sha, bin));
      expect(r.status).toBe(0);
      expect(r.out).toContain("taking it over");
      expect(git(origin, "tag", "--list").trim()).toBe("");
    });

    it("is respected while its run is still running", async () => {
      const { work, sha } = held(`run 99 ${Math.floor(Date.now() / 1000)}`);
      const { env: bin } = fakeBin("#!/usr/bin/env bash\nexit 0\n");
      const api = await stubApi((h) => (h.url === "/repos/acme/infra/actions/runs/99" ? { status: "running" } : {}));
      try {
        const p = spawn("bash", ["-c", `cd ${work} && ${applyScript("tofu", [["a"]], "forgejo")}`], { env: { ...process.env, ...env(sha, { ...bin, TG_TOKEN: "t", GITHUB_API_URL: api.url, GITHUB_REPOSITORY: "acme/infra" }) } });
        let out = "";
        p.stdout.on("data", (c) => (out += c));
        await new Promise((ok) => setTimeout(ok, 2500));
        p.kill();
        expect(out).not.toContain("all roots applied");
        expect(out).not.toContain("taking it over");
      } finally {
        api.close();
      }
    });
  });
});
