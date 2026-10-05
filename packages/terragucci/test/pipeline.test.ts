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
    for (const job of ["apply-wave-1", "apply-wave-2"]) {
      expect(body(render(forge)).jobs[job].concurrency).toEqual({ group: "terragucci-apply-${{ github.repository }}", "cancel-in-progress": false });
    }
    expect(body(render(forge)).jobs.check.concurrency).toBeUndefined();
  });

  it("gitlab: each wave's apply job is in the one resource group", () => {
    const doc = body(render("gitlab"));
    expect(doc["apply-wave-1"].resource_group).toBe("terragucci-apply");
    expect(doc["apply-wave-2"].resource_group).toBe("terragucci-apply");
    expect(doc.check.resource_group).toBeUndefined();
  });

  it("forgejo names a workflow-level group that does not cancel, or a later push cancels a run that is applying", () => {
    expect(body(render("forgejo")).concurrency).toEqual({ group: "terragucci-${{ github.event_name == 'issue_comment' && format('comment-{0}', github.event.issue.number) || github.ref }}", "cancel-in-progress": false });
    expect(body(render("github")).concurrency).toBeUndefined();
  });

  it("forgejo also takes a lock on the remote, because the runner ignores concurrency", () => {
    expect(render("forgejo")).toContain("refs/tags/terragucci-apply-lock");
    expect(render("github")).not.toContain("terragucci-apply-lock");
    expect(render("gitlab")).not.toContain("terragucci-apply-lock");
  });
});

describe("the comment trigger", () => {
  it.each(["github", "forgejo"] as const)("%s: issue_comment starts a re-plan job and nothing that applies", (forge) => {
    const doc = body(render(forge, OIDC));
    expect(doc.on.issue_comment).toEqual({ types: ["created"] });
    expect(doc.jobs.replan.if).toContain("github.event_name == 'issue_comment'");
    expect(doc.jobs.replan.if).toContain("startsWith(github.event.comment.body, '/terragucci')");
    // The comment-triggered run takes the plan job's read-only role, never the apply role.
    expect(JSON.stringify(doc.jobs.replan)).toContain(OIDC.plan_role);
    expect(JSON.stringify(doc.jobs.replan)).not.toContain(OIDC.apply_role);
    expect(doc.jobs.replan.permissions.contents).toBe("read");
    // The check job does not run for a comment (its fork test alone would be true for one), and the apply chain hangs off check.
    expect(doc.jobs.check.if).toContain("github.event_name == 'pull_request'");
    expect(doc.jobs["apply-wave-1"].needs).toBe("check");
  });

  it.each(["github", "forgejo"] as const)("%s: the comment never reaches a shell as an expression", (forge) => {
    const text = render(forge);
    const run = JSON.stringify(body(text).jobs.replan.steps);
    expect(run).not.toContain("github.event.comment");
    expect(run).toContain("terragucci comment --layers");
    expect(run).not.toContain("eval ");
    // The only mention of the comment body outside the script is the job's startsWith filter.
    expect(text.match(/github\.event\.comment/g)).toHaveLength(1);
  });

  it("the re-plan script checks the comment before it asks for credentials, then plans the pull request's head", () => {
    const script = planScript("tofu", layers, "github", OIDC, {}, true);
    const at = (s: string): number => script.indexOf(s);
    expect(at("terragucci comment")).toBeGreaterThan(-1);
    expect(at("terragucci comment")).toBeLessThan(at("tg oidc"));
    expect(at("git checkout --quiet --detach")).toBeLessThan(at("terragucci stage tf-plan"));
    expect(script).toContain('${TG_ROOT:+--root "$TG_ROOT"}');
    expect(planScript("tofu", layers, "github", OIDC)).not.toContain("terragucci comment");
  });

  it("gitlab: no comment trigger", () => {
    expect(render("gitlab")).not.toContain("issue_comment");
    expect(body(render("gitlab")).replan).toBeUndefined();
  });
});

describe("publish job", () => {
  const withPublish = (forge: ForgeName): string =>
    renderPipeline({ forge, binary: "tofu", version: "1.13.1", image: "img:1", layers, env: {}, publish: true }).content;

  it.each(FORGES)("%s: no publish job unless modules.publish is set", (forge) => {
    expect(render(forge)).not.toContain("terragucci publish");
    expect(render(forge)).not.toContain("TERRAGUCCI_REGISTRY");
  });

  it.each(["github", "forgejo"] as const)("%s: runs after apply on the default branch, with the registry credentials in that job only", (forge) => {
    const jobs = body(withPublish(forge)).jobs;
    expect(jobs.publish.needs).toBe("apply-wave-2");
    expect(jobs.publish.if).toContain("default_branch");
    expect(jobs.publish.env.TERRAGUCCI_REGISTRY_USER).toContain("secrets.TERRAGUCCI_REGISTRY_USER");
    expect(jobs.publish.steps[0].with["fetch-depth"]).toBe(0);
    expect(jobs.publish.steps.at(-1).run).toContain("terragucci publish");
    for (const name of ["check", "plan", "apply-wave-1", "apply-wave-2"]) expect(JSON.stringify(jobs[name])).not.toContain("REGISTRY");
  });

  it("gitlab: a publish job after apply, on the default branch, with full history", () => {
    const doc = body(withPublish("gitlab"));
    expect(doc.publish.needs).toEqual(["apply-wave-2"]);
    expect(doc.publish.rules[0].if).toContain("CI_DEFAULT_BRANCH");
    expect(doc.publish.variables.GIT_DEPTH).toBe("0");
    expect(doc.publish.script.join("\n")).toContain("terragucci publish");
    expect(JSON.stringify(doc["apply-wave-2"])).not.toContain("terragucci publish");
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
    expect(gh["apply-wave-1"].if).toContain("default_branch");
    const gl = body(render("gitlab"));
    expect(gl.plan.rules[0].if).toContain("merge_request_event");
    expect(gl["apply-wave-1"].rules[0].if).toContain("CI_DEFAULT_BRANCH");
  });
});

describe("credentials", () => {
  it.each(FORGES)("%s: the plan job holds the plan role and the apply job holds the apply role, never the other", (forge) => {
    const doc = body(render(forge, OIDC));
    const jobs = forge === "gitlab" ? doc : doc.jobs;
    const flat = (j: unknown): string => JSON.stringify(j);
    expect(flat(jobs.plan)).toContain(OIDC.plan_role);
    expect(flat(jobs.plan)).not.toContain(OIDC.apply_role);
    expect(flat(jobs["apply-wave-1"])).toContain(OIDC.apply_role);
    expect(flat(jobs["apply-wave-1"])).not.toContain(OIDC.plan_role);
    expect(flat(jobs.check)).not.toMatch(/role/);
  });

  it("github: id-token is written for plan and apply; only an apply wave that can wait writes contents, for its gate record", () => {
    const doc = body(render("github", OIDC));
    for (const j of ["plan", "apply-wave-1", "apply-wave-2"]) expect(doc.jobs[j].permissions["id-token"]).toBe("write");
    expect(doc.jobs.plan.permissions.contents).toBe("read");
    expect(doc.jobs["apply-wave-1"].permissions.contents).toBe("write");
    expect(doc.permissions).toEqual({ contents: "read" });
    const never = body(renderPipeline({ forge: "github", binary: "tofu", version: "1.13.1", image: "img:1", layers, env: {}, oidc: OIDC, gate: "never" }).content);
    expect(never.jobs["apply-wave-1"].permissions.contents).toBe("read");
  });

  it("forgejo: the jobs that assume a role set enable-openid-connect, and the token comes from the runner's OIDC endpoint", () => {
    const text = render("forgejo", OIDC);
    const doc = body(text);
    for (const j of ["plan", "apply-wave-1", "apply-wave-2"]) {
      expect(doc.jobs[j]["enable-openid-connect"]).toBe(true);
      expect(doc.jobs[j].permissions["id-token"]).toBe("write");
    }
    expect(doc.jobs.check["enable-openid-connect"]).toBeUndefined();
    expect(doc["enable-openid-connect"]).toBeUndefined();
    expect(text).toContain("tg oidc");
    // A runner that serves no token stops the job and says what Forgejo needs.
    expect(text).toContain('if [ -z "${ACTIONS_ID_TOKEN_REQUEST_URL:-}" ]; then');
    expect(text).toContain("Forgejo Runner 12.5 or later, to a job that sets enable-openid-connect: true");
    expect(text).toContain("|| exit 1");
    expect(render("forgejo")).not.toContain("enable-openid-connect");
    expect(render("github", OIDC)).not.toContain("enable-openid-connect");
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
    expect(doc["apply-wave-1"].id_tokens).toEqual({ TERRAGUCCI_OIDC: { aud: "sts.amazonaws.com" } });
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

/** A directory with fake binaries first on PATH: `tofu` by default, or others by name. */
function fakeBin(script: string, scripts: Record<string, string> = {}): { dir: string; env: Record<string, string> } {
  const dir = tmp("tg-bin-");
  const bin = join(dir, "bin");
  mkdirSync(bin);
  for (const [name, text] of Object.entries({ tofu: script, ...scripts })) {
    writeFileSync(join(bin, name), text);
    chmodSync(join(bin, name), 0o755);
  }
  return { dir, env: { PATH: `${bin}:${process.env.PATH}` } };
}

/** A `terragucci` that stands in for the apply stage and exits 0. */
const STAGE_OK = { terragucci: "#!/usr/bin/env bash\nexit 0\n" };

describe("the plugin cache", () => {
  it("roots applied together never share a cache directory, even when the env names one", async () => {
    const { dir, env } = fakeBin(
      `#!/usr/bin/env bash\ncase "$2" in init) echo "$(basename "\${1#-chdir=}") $TF_PLUGIN_CACHE_DIR" >> "\${LOG}"; sleep 0.3 ;; plan) for a in "$@"; do case "$a" in -out=*) : > "\${a#-out=}" ;; esac; done ;; show) echo '{"resource_changes":[]}' ;; esac\nexit 0\n`,
    );
    await terragucciBin(join(dir, "bin"));
    const log = join(dir, "cache.log");
    const script = join(dir, "apply.sh");
    writeFileSync(script, applyScript("tofu", [["a", "b", "c"]], "github"));
    const r = spawnSync("bash", [script], { cwd: dir, env: { ...process.env, ...env, LOG: log, TF_PLUGIN_CACHE_DIR: "/shared/cache" }, encoding: "utf-8" });
    expect(r.status, r.stdout + r.stderr).toBe(0);
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

/**
 * A fake binary for the plan stage: `plan -out=FILE` writes the root's name
 * into FILE, `show -json FILE` prints a plan for it from $PLANS/<root>.json,
 * and a root named in $FAIL fails to plan.
 */
const FAKE_TOFU = `#!/usr/bin/env bash
dir="\${1#-chdir=}"; shift; root="$(basename "$dir")"
case "$1" in
  init) exit 0 ;;
  plan)
    case " \${FAIL:-} " in *" $root "*) echo "Error: no credentials" >&2; exit 1 ;; esac
    for a in "$@"; do case "$a" in -out=*) echo "$root" > "\${a#-out=}" ;; esac; done
    echo "Plan: planned $root"; exit 0 ;;
  show)
    file="\${@: -1}"; r="$(cat "$file")"
    if [ "$2" = "-json" ]; then cat "$PLANS/$r.json"; else echo "plan text of $r"; fi ;;
esac
`;

const rc = (address: string, actions: string[], before: unknown, after: unknown) => {
  const [type, name] = address.split(".");
  return { address, mode: "managed", type, name, change: { actions, before, after, after_unknown: {}, before_sensitive: {}, after_sensitive: {} } };
};
const planOf = (changes: unknown[]) => JSON.stringify({ format_version: "1.2", resource_changes: changes, output_changes: {}, errored: false });

let CLI: string | undefined;
/** A `terragucci` on the path, bundled from this tree as the CI image carries it. */
async function terragucciBin(bin: string): Promise<void> {
  if (!CLI) {
    const { build } = await import("esbuild");
    CLI = join(tmp("tg-cli-"), "terragucci.mjs");
    await build({
      entryPoints: [join(import.meta.dirname, "../src/cli.ts")], outfile: CLI, bundle: true, platform: "node", format: "esm", target: "node22",
      external: ["@intentius/tsad-reference", "@cdktn/hcl2json", "typescript"], logLevel: "silent",
      banner: { js: "import { createRequire as __r } from 'node:module';\nconst require = __r(import.meta.url);" },
    });
  }
  writeFileSync(join(bin, "terragucci"), `#!/usr/bin/env bash\nexec node ${JSON.stringify(CLI)} "$@"\n`);
  chmodSync(join(bin, "terragucci"), 0o755);
}

async function planRepo(): Promise<{ repo: string; env: Record<string, string> }> {
  const { dir, env } = fakeBin(FAKE_TOFU);
  await terragucciBin(join(dir, "bin"));
  const repo = tmp("tg-repo-");
  const plans = join(dir, "plans");
  mkdirSync(plans);
  const queue = (r: string) => rc("aws_sqs_queue.jobs", ["update"], { name: "jobs", delay: 1 }, { name: "jobs", delay: 2 });
  writeFileSync(join(plans, "network.json"), planOf([queue("network")]));
  writeFileSync(join(plans, "app.json"), planOf([queue("app")]));
  writeFileSync(join(plans, "cache.json"), planOf([queue("cache"), rc("aws_db_instance.main", ["delete"], { id: "db" }, null), rc("aws_db_instance.old", ["delete"], { id: "old" }, null)]));
  for (const r of ["network", "app", "cache"]) mkdirSync(join(repo, r));
  return { repo, env: { ...env, PLANS: plans } };
}

describe("the plan stage", () => {
  it("runs the plan report, posts its note as the one plan note, and one status from its counts", async () => {
    const { repo, env } = await planRepo();
    const api = await stubApi(() => []);
    try {
      const r = await run(`cd ${JSON.stringify(repo)}\n${planScript("tofu", [["network"], ["app", "cache"]], "github")}`, {
        ...env, TG_TOKEN: "t", TG_SHA: "abc123", TG_PR: "7", GITHUB_API_URL: api.url, GITHUB_REPOSITORY: "acme/infra",
        GITHUB_SERVER_URL: "http://forge", GITHUB_RUN_ID: "9",
      });
      expect(r.status, r.out).toBe(0);
      const statuses = api.hits.filter((h) => h.url.includes("/statuses/"));
      expect(statuses.map((h) => [h.url, h.body.context, h.body.state])).toEqual([
        ["/repos/acme/infra/statuses/abc123", "terragucci/plan", "pending"],
        ["/repos/acme/infra/statuses/abc123", "terragucci/plan", "success"],
      ]);
      expect(statuses[1].body.description).toBe("3 roots, 2 groups, 2 destroys");
      const note = api.hits.find((h) => h.method === "POST" && h.url === "/repos/acme/infra/issues/7/comments")!;
      const lines = note.body.body.split("\n");
      expect(lines[0]).toBe("<!-- terragucci:plan roots=app,cache,network -->");
      expect(note.body.body).toBe(`${lines[0]}\n${readFileSync(join(repo, "terragucci-report/note.md"), "utf-8")}`);
      expect(note.body.body).toContain("(http://forge/acme/infra/actions/runs/9#root-cache) (destroy)");
      const report = JSON.parse(readFileSync(join(repo, "terragucci-report/report.json"), "utf-8"));
      expect(report.run).toMatchObject({ commit: "abc123", project: "forge/acme/infra", binary: "tofu" });
      expect(report.roots.map((x: { path: string }) => x.path)).toEqual(["network", "app", "cache"].sort());
      expect(readFileSync(join(repo, "terragucci-report/roots/cache/plan.txt"), "utf-8")).toBe("plan text of cache\n");
    } finally {
      api.close();
    }
  });

  it("a root that fails to plan fails the stage and its status, and the note still goes up", async () => {
    const { repo, env } = await planRepo();
    const api = await stubApi(() => []);
    try {
      const r = await run(`cd ${JSON.stringify(repo)}\n${planScript("tofu", [["network"], ["app", "cache"]], "github")}`, {
        ...env, FAIL: "app", TG_TOKEN: "t", TG_SHA: "s", TG_PR: "7", GITHUB_API_URL: api.url, GITHUB_REPOSITORY: "o/r", GITHUB_SERVER_URL: "http://forge", GITHUB_RUN_ID: "1",
      });
      expect(r.status).toBe(1);
      expect(api.hits.at(-1)!.body).toMatchObject({ context: "terragucci/plan", state: "failure", description: "1 failed: 3 roots, 2 groups, 2 destroys" });
      expect(api.hits.some((h) => h.url === "/repos/o/r/issues/7/comments" && h.body.body.includes("refused to plan"))).toBe(true);
    } finally {
      api.close();
    }
  });

  it("names the stage's roots, binary and bucket, so it plans what the pipeline names", () => {
    const s = planScript("tofu", layers, "github", undefined, { reports: { bucket: "s3://r", endpoint: "http://minio:9000", prefix: "p" }, canary: ["network"] });
    expect(s).toContain("terragucci stage tf-plan --out terragucci-report --binary tofu --layers 'network;app,cache'");
    expect(s).toContain("--canary 'network' --bucket 's3://r' --bucket-endpoint 'http://minio:9000' --bucket-prefix 'p'");
  });

  it.each(FORGES)("%s: the plan job keeps the report with the job", (forge) => {
    const doc = body(render(forge));
    if (forge === "gitlab") {
      expect(doc.plan.artifacts).toEqual({ name: "terragucci-report", when: "always", paths: ["terragucci-report/"], reports: { terraform: "terragucci-report/gitlab-terraform.json" } });
      expect(doc.plan.script.join("\n")).toContain('--report-url "$CI_JOB_URL/artifacts/file/terragucci-report/report.html"');
    } else {
      const keep = doc.jobs.plan.steps.at(-1);
      expect(keep.if).toBe("always()");
      expect(keep.uses).toMatch(forge === "forgejo" ? /upload-artifact@v3$/ : /^actions\/upload-artifact@v4$/);
      expect(keep.with).toMatchObject({ name: "terragucci-report", path: "terragucci-report/" });
    }
  });

  it.each(FORGES)("%s: each apply job keeps the wave's report with the job", (forge) => {
    const doc = body(render(forge));
    const name = Object.keys(forge === "gitlab" ? doc : doc.jobs).find((k) => k.startsWith("apply"))!;
    if (forge === "gitlab") {
      expect(doc[name].artifacts).toMatchObject({ name: `terragucci-report-${name}`, when: "always", paths: expect.arrayContaining(["terragucci-report/"]) });
    } else {
      const keep = doc.jobs[name].steps.find((s: { name?: string }) => s.name === "Keep the apply report");
      expect(keep.if).toBe("always()");
      expect(keep.uses).toMatch(forge === "forgejo" ? /upload-artifact@v3$/ : /^actions\/upload-artifact@v4$/);
      expect(keep.with).toMatchObject({ name: `terragucci-report-${name}`, path: "terragucci-report/" });
    }
  });

  it("the stage plans without taking the state lock, so a pull request never blocks an apply", () => {
    expect(readFileSync(join(import.meta.dirname, "../src/report/stage.ts"), "utf-8")).toContain('"-lock=false"');
  });
});

describe("stale plan notes", () => {
  const applyEnv = (api: string, bin: Record<string, string>): Record<string, string> => ({
    ...bin, TG_TOKEN: "t", TG_SHA: "s", TG_BRANCH: "main", GITHUB_API_URL: api, GITHUB_REPOSITORY: "acme/infra", GITHUB_SERVER_URL: "http://forge", GITHUB_RUN_ID: "1",
  });
  const noteFor = (roots: string): { id: number; body: string } => ({ id: 55, body: `<!-- terragucci:plan roots=${roots} -->\n## terragucci plan\n` });

  it("marks a note stale when main moved under one of its roots", async () => {
    const { env } = fakeBin("#!/usr/bin/env bash\nexit 0\n", STAGE_OK);
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
    const { env } = fakeBin("#!/usr/bin/env bash\nexit 0\n", STAGE_OK);
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

  it("posts apply as pending from the first wave, then success from the last, once for the whole stage", async () => {
    const { env } = fakeBin("#!/usr/bin/env bash\nexit 0\n", STAGE_OK);
    const api = await stubApi(() => []);
    try {
      await run(applyScript("tofu", layers, "github", undefined, { wave: 1 }), applyEnv(api.url, env));
      await run(applyScript("tofu", layers, "github", undefined, { wave: 2 }), applyEnv(api.url, env));
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
    const { dir, env } = fakeBin("#!/usr/bin/env bash\nexit 0\n", {
      terragucci: `#!/usr/bin/env bash\necho "start $RUN $(date +%s.%N)" >> "$LOG"; sleep 1; echo "end $RUN $(date +%s.%N)" >> "$LOG"\nexit 0\n`,
    });
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
    const { dir, env } = fakeBin("#!/usr/bin/env bash\nexit 0\n", { terragucci: `#!/usr/bin/env bash\necho applied >> "$LOG"\nexit 0\n` });
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
      const { env: bin } = fakeBin("#!/usr/bin/env bash\nexit 0\n", STAGE_OK);
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
      const { env: bin } = fakeBin("#!/usr/bin/env bash\nexit 0\n", STAGE_OK);
      const r = await run(`cd ${work} && ${applyScript("tofu", [["a"]], "forgejo")}`, env(sha, bin));
      expect(r.status).toBe(0);
      expect(r.out).toContain("taking it over");
      expect(git(origin, "tag", "--list").trim()).toBe("");
    });

    it("is respected while its run is still running", async () => {
      const { work, sha } = held(`run 99 ${Math.floor(Date.now() / 1000)}`);
      const { env: bin } = fakeBin("#!/usr/bin/env bash\nexit 0\n", STAGE_OK);
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

describe("the drift stage", () => {
  const withDrift = (forge: ForgeName, oidc?: typeof OIDC): string =>
    renderPipeline({ forge, binary: "tofu", version: "1.13.1", image: "img:1", layers, env: {}, oidc, drift: "0 6 * * *" }).content;

  it.each(FORGES)("%s: no drift job unless drift names a schedule", (forge) => {
    expect(render(forge)).not.toContain("tf-drift");
  });

  it.each(["github", "forgejo"] as const)("%s: a scheduled run, or a manual one, runs drift and neither push job", (forge) => {
    const doc = body(withDrift(forge));
    expect(doc.on.schedule).toEqual([{ cron: "0 6 * * *" }]);
    expect(doc.on.workflow_dispatch).toBeDefined();
    expect(doc.jobs.drift.if).toBe("github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'");
    expect(doc.jobs["apply-wave-1"].if).toContain("github.event_name == 'push'");
    expect(doc.jobs.check.if).toContain("github.event_name == 'push'");
    expect(doc.jobs.plan.if).toContain("pull_request");
    const run = doc.jobs.drift.steps.map((s: any) => s.run).filter(Boolean).join("\n");
    expect(run).toContain("terragucci stage tf-drift");
    expect(run).toContain("--forge " + forge);
    // It reads; nothing in it applies. The drift response's apply mode opens a pull request.
    expect(run.replace("respond drift --mode apply", "respond drift")).not.toMatch(/\bapply\b/);
  });

  it("github: drift writes its issue and its pull request, and takes the read-only role", () => {
    const text = withDrift("github", OIDC);
    const drift = body(text).jobs.drift;
    expect(drift.permissions).toEqual({ contents: "write", issues: "write", "pull-requests": "write", "id-token": "write" });
    const run = drift.steps.map((s: any) => s.run).filter(Boolean).join("\n");
    expect(run).toContain(OIDC.plan_role);
    expect(run).not.toContain(OIDC.apply_role);
  });

  it("gitlab: drift runs for scheduled pipelines only, and check and apply skip them", () => {
    const doc = body(withDrift("gitlab"));
    expect(doc.drift.rules).toEqual([{ if: '$CI_PIPELINE_SOURCE == "schedule"' }]);
    expect(doc.check.rules).toEqual([{ if: '$CI_PIPELINE_SOURCE != "schedule"' }]);
    expect(doc["apply-wave-1"].rules[0].if).toContain('$CI_PIPELINE_SOURCE != "schedule"');
    expect(doc.drift.script.join("\n")).toContain("terragucci stage tf-drift");
  });
});

describe("telemetry headers secret", () => {
  const withHeaders = (forge: ForgeName): string =>
    renderPipeline({ forge, binary: "tofu", version: "1.13.1", image: "img:1", layers, env: {}, headersSecret: "OTLP_HEADERS" }).content;

  const withDrift = (forge: ForgeName): string =>
    renderPipeline({ forge, binary: "tofu", version: "1.13.1", image: "img:1", layers, env: {}, headersSecret: "OTLP_HEADERS", drift: "0 6 * * *", publish: true }).content;
  const SENDERS = ["plan", "apply-wave-1", "apply-wave-2", "drift"];

  it.each(["github", "forgejo"] as const)("%s: the secret is on the jobs that send telemetry alone", (forge) => {
    const doc = body(withDrift(forge));
    expect(doc.env?.OTEL_EXPORTER_OTLP_HEADERS).toBeUndefined();
    for (const job of SENDERS) expect(doc.jobs[job].env.OTEL_EXPORTER_OTLP_HEADERS).toBe("${{ secrets.OTLP_HEADERS }}");
    for (const job of ["check", "publish"]) expect(doc.jobs[job].env?.OTEL_EXPORTER_OTLP_HEADERS).toBeUndefined();
  });

  it("gitlab: the CI/CD variable is on the jobs that send telemetry alone", () => {
    const doc = body(withDrift("gitlab"));
    for (const job of SENDERS) expect(doc[job].variables.OTEL_EXPORTER_OTLP_HEADERS).toBe("$OTLP_HEADERS");
    for (const job of ["check", "publish"]) expect(doc[job].variables.OTEL_EXPORTER_OTLP_HEADERS).toBeUndefined();
  });

  it.each(FORGES)("%s: no headers setting renders no header variable", (forge) => {
    expect(render(forge)).not.toContain("OTEL_EXPORTER_OTLP_HEADERS");
  });

  it("validates the setting", () => {
    expect(validateConfig({ telemetry: { headers_secret: "OTLP_HEADERS" } }, "t").telemetry).toEqual({ headers_secret: "OTLP_HEADERS" });
    expect(() => validateConfig({ telemetry: { headers_secret: "not a name" } }, "t")).toThrow(/headers_secret/);
    expect(() => validateConfig({ telemetry: {} }, "t")).toThrow(/headers_secret/);
  });
});

describe("respond steps", () => {
  const withRespond = (forge: ForgeName, respond?: Record<string, string>): string =>
    renderPipeline({ forge, binary: "tofu", version: "1.13.1", image: "img:1", layers, env: {}, drift: "0 6 * * *", ...(respond ? { respond } : {}) }).content;

  it.each(FORGES)("%s: triage, the refused wave, drift and fmt run by default", (forge) => {
    const text = withRespond(forge);
    expect(text).toContain('terragucci respond apply-failed --log "$log"');
    expect(text).toContain("terragucci respond wave-refused --wave 1");
    expect(text).toContain("terragucci respond drift --mode apply");
    expect(text).toContain("terragucci respond fmt --mode apply");
  });

  it.each(FORGES)("%s: a response set to off is not in the pipeline", (forge) => {
    const text = withRespond(forge, { "apply-failed": "off", "wave-refused": "off", drift: "off", fmt: "off", tips: "off" });
    expect(text).not.toContain("terragucci respond");
  });

  it("a wave waiting at a gate (exit 3) gets no response", () => {
    const script = applyScript("tofu", layers, "github", undefined, { wave: 1 });
    expect(script).toMatch(/3\) tg status terragucci\/apply pending "\$\(cat "\$outcome"\)"; exit 3 ;;/);
  });
});
