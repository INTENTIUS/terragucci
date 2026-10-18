// stack/demo.sh runs under `set -euo pipefail`, where a pipeline whose reader
// exits early (head -1, grep -q) kills its writer with SIGPIPE and the driver
// with 141. v0.4.17's tree_bucket did that on every `up` (behold#571).
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const root = join(__dirname, "..");
const demo = readFileSync(join(root, "stack", "demo.sh"), "utf8");

/** One function of demo.sh, from its `name() {` line to the `}` that closes it. */
function fn(name: string): string {
  const start = demo.indexOf(`\n${name}() {`);
  expect(start, `${name} in stack/demo.sh`).toBeGreaterThan(-1);
  const end = demo.indexOf("\n}\n", start);
  return demo.slice(start + 1, end + 2);
}

/** Run `body` after demo.sh's tree functions, with the driver's shell options. */
function run(body: string) {
  const script = `set -euo pipefail\n${fn("tree_keys")}\n${fn("tree_bucket")}\n${body}`;
  return spawnSync("bash", ["-c", script], { cwd: root, encoding: "utf8" });
}

describe("stack/demo.sh under pipefail", () => {
  it("reads the terraform tree's state bucket without dying of SIGPIPE", () => {
    // Several roots each name the bucket: the old head -1 died on this every time.
    for (let i = 0; i < 5; i++) {
      const r = run(`b="$(tree_bucket example-demo)"; echo "$b"`);
      expect(r.stderr).toBe("");
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe("demo-terraform-state");
    }
  });

  it("reads the terragrunt tree's state bucket and unit keys", () => {
    const r = run(`tree_bucket example-demo-terragrunt; tree_keys example-demo-terragrunt terragrunt`);
    expect(r.status).toBe(0);
    const lines = r.stdout.trim().split("\n");
    expect(lines[0]).toBe("demo-terraform-state");
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines.slice(1)) expect(l).toMatch(/^\S+ \S+$/);
  });

  it("reads the terraform tree's root keys", () => {
    const r = run(`tree_keys example-demo terraform`);
    expect(r.status).toBe(0);
    expect(r.stdout.trim().split("\n").map((l) => l.split(" ")[0])).toEqual(["app", "edge", "network", "other"]);
  });

  it("reads the chant tree's state bucket and root keys, its components' Terraform roots", () => {
    const r = run(`tree_bucket example-demo-chant; tree_keys example-demo-chant chant`);
    expect(r.status).toBe(0);
    expect(r.stdout.trim().split("\n")).toEqual(["demo-chant-state", "app app.tfstate", "edge edge.tfstate", "network network.tfstate"]);
  });

  it("runs the chant repo's jobs in the image up builds, with full history and no install step", () => {
    const image = /^CHANT_JOB_IMAGE=(\S+)$/m.exec(demo)?.[1];
    expect(image).toBe("terragucci-demo-chant:local");
    const pipeline = readFileSync(join(root, "example-demo-chant", ".forgejo", "workflows", "chant-pr.yml"), "utf8");
    // Both jobs, plan and apply.
    expect(pipeline.match(new RegExp(`container: ${image}$`, "gm"))).toHaveLength(2);
    // chant measures the change from a base commit, so each checkout has the whole history.
    expect(pipeline.match(/^ *fetch-depth: 0$/gm)).toHaveLength(2);
    // Every run step is chant's own command: nothing installs OpenTofu, chant or packages at job time.
    const runs = [...pipeline.matchAll(/^ *run: (.*)$/gm)].map((m) => m[1]);
    expect(runs.map((r) => r.split(" ").slice(0, 3).join(" "))).toEqual(["chant components pr-plan", "chant components pr-apply"]);
    expect(pipeline).not.toMatch(/opentofu|npm |curl /);
    // A Forgejo runner reads as GitHub Enterprise Server, where upload-artifact and download-artifact v4 refuse to run (chant#4008).
    expect(pipeline).not.toMatch(/(upload|download)-artifact@v[4-9]/);
    expect(pipeline.match(/uses: \S+\/upload-artifact@v3$/gm)).toHaveLength(2);
    // The image carries chant and OpenTofu, at the version the tree's lockfile pins.
    const dockerfile = readFileSync(join(root, "stack", "demo-chant.Dockerfile"), "utf8");
    expect(dockerfile).toMatch(/npm ci --omit=dev/);
    expect(demo).toContain(`-f "$HERE/demo-chant.Dockerfile" "$HERE/../$(tool_tree chant)"`);
  });

  it("has no pipeline whose reader exits before its writer is done", () => {
    for (const f of ["demo.sh", "bootstrap.sh", "lib.sh"]) {
      const text = readFileSync(join(root, "stack", f), "utf8");
      const bad = text
        .split("\n")
        .map((l, i) => [i + 1, l] as const)
        .filter(([, l]) => !l.trimStart().startsWith("#"))
        .filter(([, l]) => /\|\s*(head\b|grep\s+-[A-Za-z]*[qm]|sed\s+(-n\s+)?'?\d*q)|\byes\s*\|/.test(l));
      expect(bad, `stack/${f}`).toEqual([]);
    }
  });
});

// behold#571: the driver checks out each step's commit in <DEMO_VIEWS>/<repo>.change
// before it writes the step, so the kiosk's graph draws the change.
describe("view_follow", () => {
  const made: string[] = [];
  afterAll(() => {
    for (const d of made) rmSync(d, { recursive: true, force: true });
  });
  const sh = (cmd: string, cwd: string) => {
    const r = spawnSync("bash", ["-c", cmd], { cwd, encoding: "utf8" });
    expect(r.status, `${cmd}: ${r.stderr}`).toBe(0);
    return r.stdout.trim();
  };

  it("checks out the step's commit, and writes no FETCH_HEAD or reflog with the remote in it", () => {
    const tmp = mkdtempSync(join(tmpdir(), "demo-view-"));
    made.push(tmp);
    const git = "git -c user.name=t -c user.email=t@t -c init.defaultBranch=main";
    sh(`${git} init -q origin && cd origin && echo a > a.tf && ${git} add . && ${git} commit -qm base`, tmp);
    sh(`git clone -q origin views/demo.change`, tmp);
    const head = sh(`cd origin && ${git} checkout -qb pull && mkdir live && echo b > live/b.tf && ${git} add . && ${git} commit -qm pull && git rev-parse HEAD`, tmp);
    // The admin's remote, by another path than the checkout's origin: nothing in .git may name it.
    sh(`ln -s origin admin-remote`, tmp);
    const body = `log() { echo "$*" >&2; }\nVIEWS=${tmp}/views VIEW_OWNER="" VIEW_TRIES=1 REPO=admin/demo REMOTE=${tmp}/admin-remote COMMIT=${head}\n${fn("view_follow").replace(/^VIEW_AT=""\n/, "")}\nVIEW_AT=""\nview_follow`;
    const r = spawnSync("bash", ["-c", `set -euo pipefail\n${body}`], { cwd: root, encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    const dir = join(tmp, "views", "demo.change");
    expect(sh("git rev-parse HEAD", dir)).toBe(head);
    expect(existsSync(join(dir, "live", "b.tf"))).toBe(true);
    expect(existsSync(join(dir, ".git", "FETCH_HEAD"))).toBe(false);
    expect(sh("grep -rl admin-remote .git || true", dir)).toBe("");
  });

  it("does nothing without DEMO_VIEWS, and logs a missing checkout", () => {
    const body = `log() { echo "$*" >&2; }\nREPO=admin/demo REMOTE=/nowhere COMMIT=abc VIEW_OWNER="" VIEW_TRIES=1\n${fn("view_follow")}`;
    const off = spawnSync("bash", ["-c", `set -euo pipefail\nVIEWS=""\nVIEW_AT=""\n${body}\nview_follow`], { cwd: root, encoding: "utf8" });
    expect(off.status).toBe(0);
    expect(off.stderr).toBe("");
    const missing = spawnSync("bash", ["-c", `set -euo pipefail\nVIEWS=/nowhere\nVIEW_AT=""\n${body}\nview_follow`], { cwd: root, encoding: "utf8" });
    expect(missing.status).toBe(0);
    expect(missing.stderr).toContain("view: no checkout /nowhere/demo.change");
  });
});

// behold#571: the chant scenario writes its steps through demo_write like the
// others, so its .change checkout follows the pull request's head, then the
// merge. A checkout that fails is not remembered as done: the next step on the
// same commit tries again.
describe("view_follow in the chant scenario", () => {
  const made: string[] = [];
  afterAll(() => {
    for (const d of made) rmSync(d, { recursive: true, force: true });
  });
  const sh = (cmd: string, cwd: string) => {
    const r = spawnSync("bash", ["-c", cmd], { cwd, encoding: "utf8" });
    expect(r.status, `${cmd}: ${r.stderr}`).toBe(0);
    return r.stdout.trim();
  };

  /** A demo-chant remote with a base, a pull request's head and its merge, and a .change checkout at the base. */
  function fixture() {
    const tmp = mkdtempSync(join(tmpdir(), "demo-view-chant-"));
    made.push(tmp);
    const git = "git -c user.name=t -c user.email=t@t -c init.defaultBranch=main";
    const base = sh(`${git} init -q origin && cd origin && mkdir app && echo a > app/main.tf && ${git} add . && ${git} commit -qm 'base [skip ci]' && git rev-parse HEAD`, tmp);
    sh(`cd origin && ${git} branch chant/lifecycle`, tmp);
    sh(`git clone -q origin views/demo-chant.change`, tmp);
    const head = sh(`cd origin && ${git} checkout -qb demo-chant-pr-loop && echo b >> app/main.tf && ${git} commit -qam pull && git rev-parse HEAD`, tmp);
    const merge = sh(`cd origin && ${git} checkout -q main && ${git} merge -q --no-ff demo-chant-pr-loop -m merge && git rev-parse HEAD`, tmp);
    return { tmp, base, head, merge };
  }

  /** Run scenario_chant_pr_loop and the applied step with the forge stubbed, and list "<step> <.change HEAD>" as each step was written. */
  function cycle(tmp: string, merge: string, head: string, afterPlan = "") {
    const stubs = [
      'log() { echo "$*" >&2; }',
      `VIEWS=${tmp}/views VIEW_OWNER="" VIEW_TRIES=1 REPO=admin/demo-chant REMOTE=${tmp}/origin TOKEN=""`,
      `DEMO_STATE=${tmp}/state CYCLE=797 SCENARIO=chant-pr-loop TITLE=t STARTED="" PULL="" COMMIT="" ABOUT=null HOLD=0 TOOL=chant`,
      `TREE=${tmp} WORK=${tmp}/work INIT_PULL="" HELD="" VIEW_AT="" RUN_STATUS="" RUN_URL="" OUTCOME="" LIMIT_PLAN=1 LIMIT_RUN=1 URL=http://forge POLL=0`,
      `mkdir -p ${tmp}/state`,
      "now() { date +%s; }",
      'iso() { date -u -r "$1" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d "@$1" +%Y-%m-%dT%H:%M:%SZ; }',
      "demo_where() { echo '{}'; }",
      `demo_put() { echo "$(jq -r .step "$DEMO_STATE/demo.json") $(git -C ${tmp}/views/demo-chant.change rev-parse HEAD)" >> ${tmp}/steps; }`,
      'say() { echo "$1"; }',
      'clone_main() { mkdir -p "$1"; }',
      "overlay() { :; }",
      "last_run_id() { echo 0; }",
      `push_as_author() { echo ${head}; }`,
      "pr_open() { echo 20; }",
      "run_started() { :; }",
      "runs_mark() { :; }",
      `run_ended() { RUN_STATUS=success; ${afterPlan} }`,
      "chant_note() { :; }",
      "chant_approve() { :; }",
      "quiet() { :; }",
      "as_author() { :; }",
      `api() { echo '{"merge_commit_sha":"${merge}"}'; }`,
    ].join("\n");
    const fns = ["view_follow", "demo_write", "demo_hold", "open_pull", "merge_pull", "scenario_chant_pr_loop"].map(fn).join("\n");
    const r = spawnSync("bash", ["-c", `set -euo pipefail\n${stubs}\n${fns}\nscenario_chant_pr_loop\ndemo_write applied done reset`], { cwd: root, encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    return { steps: readFileSync(join(tmp, "steps"), "utf8").trim().split("\n"), log: r.stderr };
  }

  it("moves demo-chant.change to the pull request's head, then to the merge", () => {
    const { tmp, head, merge } = fixture();
    const { steps } = cycle(tmp, merge, head);
    expect(steps).toEqual([
      `pull-request ${head}`,
      `planned ${head}`,
      `waiting ${head}`,
      `approved ${head}`,
      `merged ${merge}`,
      `applying ${merge}`,
      `applied ${merge}`,
    ]);
  });

  it("tries again at the next step when a checkout fails, rather than leaving the base through every step", () => {
    const { tmp, base, head, merge } = fixture();
    // git's lock is held at the first step, as when something else is in the checkout, and let go before the second.
    const lock = join(tmp, "views", "demo-chant.change", ".git", "index.lock");
    sh(`touch ${lock}`, tmp);
    const { steps, log } = cycle(tmp, merge, head, `[ ! -e ${lock} ] || mv ${lock} ${lock}.gone;`);
    expect(steps).toEqual([
      `pull-request ${base}`,
      `planned ${head}`,
      `waiting ${head}`,
      `approved ${head}`,
      `merged ${merge}`,
      `applying ${merge}`,
      `applied ${merge}`,
    ]);
    expect(log).toMatch(/view: could not check out \w+ in \S+ after 1 tries; the next step tries again: .*index\.lock/);
  });
});

// behold#571: the delivery (DORA) numbers. After each cycle's audit the driver
// runs terragucci estate on the reports prefix, in the background while the
// reset works; a failed or slow one is logged and the cycle goes on.
describe("audit_trail and estate_page", () => {
  const made: string[] = [];
  afterAll(() => {
    for (const d of made) rmSync(d, { recursive: true, force: true });
  });
  /** A scratch WORK and a fake terragucci whose body is `script`; it records its arguments and environment. */
  const setup = (script: string) => {
    const tmp = mkdtempSync(join(tmpdir(), "demo-estate-"));
    made.push(tmp);
    const bin = join(tmp, "terragucci");
    writeFileSync(bin, `#!/usr/bin/env bash\necho "$*" > "${tmp}/args"\nenv > "${tmp}/env"\n${script}\n`);
    chmodSync(bin, 0o755);
    return { tmp, bin };
  };
  const driver = (tmp: string, bin: string, body: string, extra = "") =>
    spawnSync(
      "bash",
      ["-c", `set -euo pipefail\nlog() { echo "[demo] $*" >&2; }\nnow() { date +%s; }\nWORK=${tmp}/work CYCLE=7 TOOL=terraform TERRAGUCCI=${bin} REPORT_BUCKET=demo-reports REPORT_PREFIX=demo FLOCI=http://127.0.0.1:4580 LIMIT_ESTATE=60 REPO=admin/demo ${extra}\n${fn("audit_trail")}\nESTATE_PID=""\n${fn("estate_page")}\n${fn("estate_wait")}\n${body}`],
      { cwd: root, encoding: "utf8", timeout: 30_000 },
    );

  it("runs terragucci estate on the reports prefix, sends the gauges to the collector's host port, and logs the DORA line", () => {
    const { tmp, bin } = setup(`echo "estate: 2 projects"\necho "dora: 3.5 deployments per week, lead time 2m, change failure rate 25%, time to restore 1m"\necho "sent 18 DORA gauges"`);
    const r = driver(tmp, bin, "estate_page\nestate_wait\necho carried-on");
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("carried-on");
    expect(r.stderr).toContain("[demo] estate: dora: 3.5 deployments per week, lead time 2m, change failure rate 25%, time to restore 1m sent 18 DORA gauges");
    expect(readFileSync(join(tmp, "args"), "utf8").trim()).toBe(`estate --bucket s3://demo-reports --bucket-endpoint http://127.0.0.1:4580 --bucket-prefix demo --out ${tmp}/work/c7/estate/page --link-hours 1`);
    const env = readFileSync(join(tmp, "env"), "utf8");
    expect(env).toContain("OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4328\n");
    expect(env).toContain("OTEL_TRACES_EXPORTER=none\n");
  });

  it("logs a failed estate and carries on", () => {
    const { tmp, bin } = setup(`echo "the index could not be read" >&2\nexit 1`);
    const r = driver(tmp, bin, "estate_page\nestate_wait\necho carried-on");
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("carried-on");
    expect(r.stderr).toContain("estate: terragucci estate failed; the delivery numbers stay as they were");
    expect(r.stderr).toContain("the index could not be read");
  });

  it("stops an estate past its limit and carries on", () => {
    const { tmp, bin } = setup("exec sleep 30");
    const started = Date.now();
    const r = driver(tmp, bin, "estate_page\nestate_wait\necho carried-on", "LIMIT_ESTATE=1");
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("carried-on");
    expect(r.stderr).toContain("estate: terragucci estate ran past 1s and was stopped");
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("runs no estate for the chant repo, whose pipeline writes no terragucci reports", () => {
    const { tmp, bin } = setup("echo ran");
    const r = driver(tmp, bin, "estate_page\nestate_wait\necho carried-on", "TOOL=chant");
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(join(tmp, "args"))).toBe(false);
  });

  it("audits twice in one cycle, as the failure scenario does, each in a clone of its own", () => {
    const { tmp, bin } = setup(`echo "audit: 3 entries, 1 added"`);
    const git = "git -c user.name=t -c user.email=t@t -c init.defaultBranch=main";
    const init = spawnSync("bash", ["-c", `${git} init -q origin && cd origin && echo a > a && ${git} add . && ${git} commit -qm base`], { cwd: tmp, encoding: "utf8" });
    expect(init.status, init.stderr).toBe(0);
    const r = driver(tmp, bin, "audit_trail\naudit_trail", `REMOTE=${tmp}/origin`);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).not.toContain("could not clone");
    expect(r.stderr.match(/\[demo\] audit: audit: 3 entries, 1 added/g)).toHaveLength(2);
  });
});

// A rollback to the release before SQL Yodeler's migrations (0.4.22) runs that
// release's loop, or its up, on what this one's up left (behold#571).
describe("up, for a rollback", () => {
  it("replaces base-tree and base.sha only once the base applied, after the last step that can fail", () => {
    const up = fn("up_repo");
    const swap = up.indexOf('mv "$bt" "$RSTATE/base-tree"');
    expect(swap).toBeGreaterThan(-1);
    // Before the swap, the base is built and pushed from base-tree.new alone.
    expect(up.slice(0, swap).match(/"\$RSTATE\/base-tree"/g)).toEqual(['"$RSTATE/base-tree"']);
    expect(up).toContain('rm -rf "$RSTATE/base-tree"\n  mv "$bt" "$RSTATE/base-tree"');
    expect(up.indexOf('echo "$sha" > "$RSTATE/base.sha"')).toBeGreaterThan(swap);
    for (const step of ["wait_run", "db_snapshot", "has no state in floci after the base applied"]) expect(up.indexOf(step)).toBeLessThan(swap);
  });

  it("writes its snapshots to <state>/snapshots and leaves the older release's <state>/base as it was", () => {
    expect(fn("snapshot")).toContain('"$RSTATE/snapshots/');
    const writes = demo.split("\n").filter((l) => /RSTATE\/base\//.test(l));
    expect(writes).toEqual([expect.stringContaining('cp -p "$RSTATE/base/"*.tfstate "$RSTATE/snapshots/"')]);
  });
});

// behold#571: next.from is when the driver started waiting for next's action,
// so the kiosk can draw how far the wait has gone. It stays put while the
// driver writes the same action and deadline again.
describe("demo_write's next.from", () => {
  const made: string[] = [];
  afterAll(() => {
    for (const d of made) rmSync(d, { recursive: true, force: true });
  });

  /** Run demo_write's calls with the clock at each T, and read back each write's next. */
  function writes(calls: string[]): Array<{ action: string; from?: string; at: string | null } | null> {
    const state = mkdtempSync(join(tmpdir(), "demo-next-"));
    made.push(state);
    const stubs = [
      `log() { :; }`,
      `view_follow() { :; }`,
      `demo_where() { echo '{}'; }`,
      `now() { echo "$T"; }`,
      `demo_put() { jq -c .next "$DEMO_STATE/demo.json" >> "$DEMO_STATE/nexts"; }`,
      demo.split("\n").find((l) => l.startsWith("iso()"))!,
    ].join("\n");
    const setup = `DEMO_STATE=${state} CYCLE=1 SCENARIO=s TITLE=t STARTED=1792000000 PULL="" COMMIT="" ABOUT=null`;
    const body = `${stubs}\n${setup}\nNEXT_KEY="" NEXT_FROM=""\n${fn("demo_write")}\n${calls.join("\n")}`;
    const r = spawnSync("bash", ["-c", `set -euo pipefail\n${body}`], { cwd: root, encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    return readFileSync(join(state, "nexts"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  }

  it("writes from as the time the wait started, and keeps it while the action and deadline repeat", () => {
    const n = writes([
      `T=1792000000; demo_write waiting "w" "approve wave-2" 1792000020`,
      `T=1792000005; demo_write waiting "w" "approve wave-2" 1792000020`,
      `T=1792000020; demo_write approved "a" "follow the waves"`,
      `T=1792000030; demo_write applying "b" "follow the waves"`,
      `T=1792000040; demo_write applied "c"`,
      `T=1792000050; demo_write reset "r" "follow the waves"`,
    ]);
    expect(n[0]).toEqual({ action: "approve wave-2", from: "2026-10-14T17:46:40Z", at: "2026-10-14T17:47:00Z" });
    expect(n[1]).toEqual(n[0]);
    expect(n[2]).toEqual({ action: "follow the waves", from: "2026-10-14T17:47:00Z", at: null });
    expect(n[3]).toEqual(n[2]);
    expect(n[4]).toBeNull();
    // A write with no next ends the wait: the same action after it starts a new one.
    expect(n[5]).toEqual({ action: "follow the waves", from: "2026-10-14T17:47:30Z", at: null });
  });

  it("starts a new wait when the deadline moves", () => {
    const n = writes([
      `T=1792000000; demo_write applied "c" reset 1792000020`,
      `T=1792000010; demo_write applied "c" reset 1792000030`,
    ]);
    expect(n.map((x) => x?.from)).toEqual(["2026-10-14T17:46:40Z", "2026-10-14T17:46:50Z"]);
  });
});

// #1131: a migration in wave 1 that waits for its digest, read from the run's log.
describe("run_outcome on a waiting migration", () => {
  const outcome = (logs: string, approved = "") => {
    const body = [
      `run_logs() { printf '%s\\n' ${JSON.stringify(logs)}; }`,
      "api() { echo '[]'; }",
      `REPO=admin/demo RUN_ID=9 RUN_STATUS=failure URL=http://forge MIGRATIONS_APPROVED=${JSON.stringify(approved)}`,
      fn("run_outcome"),
      'run_outcome; echo "$OUTCOME ${MIGRATION:-} ${MIGRATE_DIGEST:-} ${WAVE:-}"',
    ].join("\n");
    const r = spawnSync("bash", ["-c", `set -euo pipefail\n${body}`], { cwd: root, encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    return r.stdout.trim();
  };

  it("names the migration and the digest it waits for", () => {
    expect(outcome("2026-10-16T10:00:00Z migration adopt waits for an approval of digest sha256:4e1f. Read the proof above, then approve it with:")).toBe("migrate adopt sha256:4e1f 1");
  });

  it("reads past a migration this cycle approved at that digest, to the wave that waits after it", () => {
    const logs = "migration split waits for an approval of digest sha256:77. Read the proof above\nterragucci approve wave-2 --plan x";
    expect(outcome(logs, " split@sha256:77")).toBe("waiting   2");
  });
});

// cone-plan: three choudoufu estates in one repository and one live backend.
// Each cycle's pull request flips one action in service-b's policy, and the
// planned label states the cone the plan's report.json gives.
describe("the cone-plan scenario", () => {
  const made: string[] = [];
  afterAll(() => {
    for (const d of made) rmSync(d, { recursive: true, force: true });
  });
  const tree = join(root, "example-demo-choudoufu");
  const base = readFileSync(join(tree, "service-b", "iam.tf"), "utf8");
  const pulled = readFileSync(join(tree, "scenarios", "cone-plan", "pull", "service-b", "iam.tf"), "utf8");
  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]));
  const listed = (name: string) => (new RegExp(`^${name}=\\(([^)]*)\\)`, "m").exec(demo)?.[1] ?? "").split(/\s+/).filter(Boolean);

  it("is in ALL_SCENARIOS on the choudoufu tool, and not in the default list", () => {
    expect(listed("ALL_SCENARIOS")).toContain("cone-plan");
    expect(listed("SCENARIOS")).not.toContain("cone-plan");
    expect(listed("TOOLS")).toContain("choudoufu");
    const r = spawnSync("bash", ["-c", `${fn("scenario_tool")}\n${fn("tool_repo")}\n${fn("tool_tree")}\nt="$(scenario_tool cone-plan)"; echo "$t $(tool_repo "$t") $(tool_tree "$t")"`], { cwd: root, encoding: "utf8" });
    expect(r.stdout.trim()).toBe("choudoufu demo-choudoufu example-demo-choudoufu");
  });

  it("reads each estate from its live block, and the record store as the tree's bucket", () => {
    const r = run(`tree_bucket example-demo-choudoufu; tree_keys example-demo-choudoufu choudoufu; tree_keys example-demo-choudoufu/scenarios/cone-plan/pull choudoufu`);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim().split("\n")).toEqual(["demo-live-records", "network demo-network", "service-a demo-service-a", "service-b demo-service-b"]);
    expect(/^RECORDS_BUCKET=(\S+)$/m.exec(demo)?.[1]).toBe("demo-live-records");
    expect(readFileSync(join(tree, "terragucci.yml"), "utf8")).toMatch(/^binary: choudoufu$/m);
  });

  it("keeps no state file: no backend block, no remote state and no tfstate in the tree", () => {
    for (const f of files(tree)) {
      expect(f).not.toMatch(/\.tfstate/);
      expect(readFileSync(f, "utf8"), f).not.toMatch(/backend\s+"|terraform_remote_state/);
    }
  });

  // choudoufu's cone (internal/live/cone): the changed blocks, their readers,
  // and every block of a type paired with one of them (a role and its
  // policies); the guard plans in full over 30% of the estate's resource, data
  // and module blocks, or on a terraform, live or provider block change.
  it("changes one policy action, whose cone of a role and a policy stays under choudoufu's 30% guard", () => {
    const changed = base.split("\n").filter((l, i) => l !== pulled.split("\n")[i]);
    expect(base.split("\n").length).toBe(pulled.split("\n").length);
    expect(changed).toEqual(['      Action   = ["s3:GetObject", "s3:ListBucket"]']);
    expect(files(join(tree, "scenarios", "cone-plan", "pull"))).toEqual([join(tree, "scenarios", "cone-plan", "pull", "service-b", "iam.tf")]);
    const text = files(join(tree, "service-b")).filter((f) => f.endsWith(".tf")).map((f) => readFileSync(f, "utf8")).join("\n");
    const blocks = [...text.matchAll(/^(resource|data|module) "([^"]+)"/gm)];
    const roles = blocks.filter((m) => m[1] === "resource" && /^aws_iam_role(_policy|_policy_attachment|_policies_exclusive)?$/.test(m[2]!));
    expect(roles.map((m) => m[2])).toEqual(["aws_iam_role", "aws_iam_role_policy"]);
    expect(roles.length / blocks.length).toBeLessThanOrEqual(0.3);
    expect(blocks.length).toBe(8);
  });

  it("links the services to network through terraform_estate_outputs", () => {
    for (const svc of ["service-a", "service-b"]) {
      expect(readFileSync(join(tree, svc, "network.tf"), "utf8")).toMatch(/data "terraform_estate_outputs" "network" \{\n\s+estate = "demo-network"/);
    }
    expect(readFileSync(join(tree, "network", "outputs.tf"), "utf8")).toMatch(/output "log_retention_days"/);
  });

  const report = (roots: unknown[]) => JSON.stringify({ roots });
  const cone = { path: "service-b", status: "planned", cone: { base: "origin/main", blocks: 2, of: 8, targets: 2 } };

  /** One cycle with the forge, floci and the runs stubbed: main's service-b/iam.tf is `main`, and the plan's report is `rep`. */
  function cycle(main: string, rep: string, waves = true) {
    const tmp = mkdtempSync(join(tmpdir(), "demo-cone-"));
    made.push(tmp);
    writeFileSync(join(tmp, "main.tf"), main);
    writeFileSync(join(tmp, "report.json"), rep);
    const git = "git -c user.name=t -c user.email=t@t -c init.defaultBranch=main -c commit.gpgsign=false";
    const sh = spawnSync("bash", ["-c", `${git} init -q origin && cd origin && echo a > f && ${git} add f && ${git} commit -qm merge && git rev-parse HEAD && cd .. && ${git} init -q rstate/base-tree`], { cwd: tmp, encoding: "utf8" });
    expect(sh.status, sh.stderr).toBe(0);
    const merge = sh.stdout.trim();
    // The merge's run: wave 1 planned network in full and found nothing, wave 2 the services, with service-b's one update.
    const applies = waves
      ? [
          { stage: "tf-apply", wave: 2, commit: merge, finished: "2026-10-17T10:02:00Z", path: `2026/10/${merge}/tf-apply-wave-2` },
          { stage: "tf-apply", wave: 1, commit: merge, finished: "2026-10-17T10:01:00Z", path: `2026/10/${merge}/tf-apply-wave-1` },
        ]
      : [];
    const index = JSON.stringify({ schema: "terragucci.report-index/v1", reports: [...applies, { stage: "tf-plan", pull_request: "40", commit: "head", path: "2026/10/head/tf-plan" }] });
    writeFileSync(join(tmp, "wave-1.json"), JSON.stringify({ roots: [{ path: "network", changes: [] }] }));
    writeFileSync(join(tmp, "wave-2.json"), JSON.stringify({ roots: [{ path: "service-a", changes: [] }, { path: "service-b", changes: [{ address: "aws_iam_role_policy.service" }] }] }));
    const stubs = [
      'log() { echo "$*" >&2; }',
      'fail() { echo "FAIL: $*" >&2; exit 1; }',
      "now() { date +%s; }",
      demo.split("\n").find((l) => l.startsWith("iso()"))!,
      `TREE=${tree} WORK=${tmp}/work RSTATE=${tmp}/rstate DEMO_STATE=${tmp}/state REMOTE=${tmp}/origin`,
      `mkdir -p ${tmp}/work ${tmp}/state`,
      "URL=http://forge:3000 FLOCI=http://floci REPORT_BUCKET=demo-reports REPORT_PREFIX=demo POLL=0 LIMIT_PLAN=1 LIMIT_RUN=1 RESUMES_MAX=3",
      'CYCLE=12 SCENARIO=cone-plan TITLE=t STARTED="" PULL="" COMMIT="" ABOUT=null HOLD=0 TOOL=choudoufu REPO=admin/demo-choudoufu',
      'INTRO="" DELIVERY="" INDEX=1 COUNT=1 INIT_PULL="" LIVE=1 HELD="" OUTCOME="" RUN_STATUS="" RUN_URL=u TERRAGUCCI=true',
      'NEXT_KEY="" NEXT_FROM="" BEAT="" MIGRATIONS_APPROVED="" PULL_FILES="" PULL_BRANCH="" PULL_TITLE="" RESET_MOVED=""',
      "ROOTS=(network service-a service-b)",
      ...["CONE_ROOT", "CONE_FILE", "CONE_ACTION"].map((v) => demo.split("\n").find((l) => l.startsWith(`${v}=`))!),
      'CONE_CHANGE="" CONE_RESULT="" CONE_BLOCKS="" CONE_OF="" CONE_UNPLANNED="" CONE_WAVES="" CONE_APPLIED="" CONE_IDLE=""',
      "view_follow() { :; }",
      `demo_put() { jq -c '{step, label, next: (.next.action // null)}' "$DEMO_STATE/demo.json" >> ${tmp}/writes; }`,
      'clone_main() { mkdir -p "$1"; }',
      "last_run_id() { echo 0; }",
      `push_as_author() { echo "$4" >> ${tmp}/pushes; echo head; }`,
      `pr_open() { echo "$2" >> ${tmp}/titles; echo 40; }`,
      "run_started() { :; }",
      "runs_mark() { :; }",
      "run_ended() { RUN_STATUS=success; }",
      "quiet() { :; }",
      "as_author() { :; }",
      "cycle_publish() { :; }",
      "housekeeping_start() { :; }",
      `api() { case "$*" in *raw/service-b/iam.tf*) cat ${tmp}/main.tf ;; *comments*) echo '[{"body":"terragucci tf-plan"}]' ;; *) echo '{"merge_commit_sha":"${merge}"}' ;; esac; }`,
      `curl() { case "$*" in *forgejo:3000/admin/demo-choudoufu/index.json*) echo '${index}' ;; *forgejo:3000/admin/demo-choudoufu/2026/10/head/tf-plan/report.json*) cat ${tmp}/report.json ;; *tf-apply-wave-1/report.json*) cat ${tmp}/wave-1.json ;; *tf-apply-wave-2/report.json*) cat ${tmp}/wave-2.json ;; *) return 22 ;; esac; }`,
    ].join("\n");
    const fns = [
      "demo_where", "scenario_name", "say", "demo_write", "demo_hold", "open_pull", "overlay", "merge_pull", "follow", "run_outcome",
      "cone_flip", "cone_planned", "cone_read", "cone_waves", "cone_applied", "scenario_cone_plan", "reset_written",
    ].map(fn).join("\n");
    const body = `${stubs}\n${fns}\nscenario_cone_plan\ndemo_write applied "$(say applied)" reset "$(now)"\nreset_written`;
    const r = spawnSync("bash", ["-c", `set -euo pipefail\n${body}`], { cwd: root, encoding: "utf8" });
    const lines = (f: string) => (existsSync(join(tmp, f)) ? readFileSync(join(tmp, f), "utf8").trim().split("\n") : []);
    const pr = join(tmp, "work", "c12", "pull", "service-b", "iam.tf");
    return {
      status: r.status,
      stderr: r.stderr,
      merge,
      titles: lines("titles"),
      pull: existsSync(pr) ? readFileSync(pr, "utf8") : "",
      baseSha: existsSync(join(tmp, "rstate", "base.sha")) ? readFileSync(join(tmp, "rstate", "base.sha"), "utf8").trim() : "",
      writes: lines("writes").map((l) => JSON.parse(l) as { step: string; label: string; next: string | null }),
    };
  }

  it("adds the action when main lacks it, and states the report's cone at planned", () => {
    const c = cycle(base, report([cone]));
    expect(c.status, c.stderr).toBe(0);
    expect(c.writes.map((w) => w.step)).toEqual(["pull-request", "planned", "merged", "applying", "applied", "reset"]);
    expect(c.pull).toBe(pulled);
    expect(c.titles).toEqual(["service-b: add s3:PutObject to its inline policy"]);
    const at = (step: string) => c.writes.find((w) => w.step === step)!;
    expect(at("pull-request").label).toContain("It adds s3:PutObject to service-b's inline policy");
    expect(at("planned").label).toBe("The plan covers 2 of service-b's 8 blocks as a cone: its role and the policy the change touches. Network and service-a are not planned.");
    expect(at("planned").next).toBe("merge pull request 40");
    expect(at("applying").label).toBe("The merge's run plans each estate in full, in waves: network first, then the two services that read it.");
    // The merge's real waves, from their reports.
    expect(at("applied").label).toBe("Done in 2 waves. Service-b's policy now allows s3:PutObject, 1 change in its estate. Full plans of network and service-a found nothing to apply.");
    // The merge that applied is the base now, and the reset leaves main there.
    expect(c.baseSha).toBe(c.merge);
    expect(at("reset").label).toContain(`Main stays at ${c.merge.slice(0, 8)} as applied`);
  });

  it("removes the action when main has it, and takes the counts from the report, not the tree", () => {
    const c = cycle(pulled, report([{ ...cone, cone: { base: "origin/main", blocks: 3, of: 11, targets: 3 } }]));
    expect(c.status, c.stderr).toBe(0);
    expect(c.pull).toBe(base);
    expect(c.titles).toEqual(["service-b: remove s3:PutObject from its inline policy"]);
    const planned = c.writes.find((w) => w.step === "planned")!.label;
    expect(planned).toBe("The plan covers 3 of service-b's 11 blocks as a cone. Network and service-a are not planned.");
    expect(c.writes.find((w) => w.step === "applied")!.label).toContain("no longer allows s3:PutObject");
  });

  it("says less at applied when the merge's wave reports cannot be read, and goes on", () => {
    const c = cycle(base, report([cone]), false);
    expect(c.status, c.stderr).toBe(0);
    expect(c.writes.find((w) => w.step === "applied")!.label).toBe("Done. Service-b's policy now allows s3:PutObject, and no state file was written.");
  });

  it("stalls at the plan when choudoufu's guard planned the whole estate, naming the guard", () => {
    const c = cycle(base, report([{ path: "service-b", status: "planned", cone: { base: "origin/main", fallback: { kind: "terraform-block-changed", reason: "the terraform block changed" } } }]));
    expect(c.status).toBe(1);
    expect(c.stderr).toContain("FAIL: service-b planned its whole estate: the terraform block changed (guard terraform-block-changed)");
    expect(c.writes.map((w) => w.step)).toEqual(["pull-request"]);
  });

  it("stalls at the plan when the change reached another estate, or none was planned as a cone", () => {
    const more = cycle(base, report([cone, { path: "network", status: "planned" }]));
    expect(more.status).toBe(1);
    expect(more.stderr).toContain("FAIL: pull request 40 planned network, service-b, not service-b alone");
    const full = cycle(base, report([{ path: "service-b", status: "planned" }]));
    expect(full.status).toBe(1);
    expect(full.stderr).toContain("FAIL: service-b was not planned with -cone");
  });

  it("says no word a viewer should not see", () => {
    const about = readFileSync(join(tree, "scenarios", "cone-plan", "about.json"), "utf8");
    const labels = demo.split("\n").filter((l) => /cone-plan|CONE_|choudoufu\)/.test(l)).join("\n");
    for (const t of [about, labels, ...files(tree).map((f) => readFileSync(f, "utf8"))]) expect(t.toLowerCase()).not.toContain("terralith");
  });
});

// cone-plan holds each step DEMO_HOLD_CONE (8 s), every other scenario
// DEMO_HOLD (20 s), and the loop sets HOLD from the scenario before each cycle.
describe("scenario_hold", () => {
  const hold = (scenario: string, env = "") => {
    const r = spawnSync("bash", ["-c", `set -euo pipefail\n${env}\nHOLD_DEFAULT="\${DEMO_HOLD:-20}"\n${fn("scenario_hold")}\nscenario_hold ${scenario}`], { cwd: root, encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    return r.stdout.trim();
  };

  it("is 8 s for cone-plan and DEMO_HOLD's 20 s for the rest", () => {
    expect(hold("cone-plan")).toBe("8");
    for (const s of ["b-waves", "failure", "tg-planned-outputs", "chant-pr-loop"]) expect(hold(s)).toBe("20");
  });

  it("takes DEMO_HOLD_CONE for cone-plan and DEMO_HOLD for the rest, each without moving the other", () => {
    expect(hold("cone-plan", "DEMO_HOLD_CONE=5 DEMO_HOLD=30")).toBe("5");
    expect(hold("b-waves", "DEMO_HOLD_CONE=5")).toBe("20");
    expect(hold("b-waves", "DEMO_HOLD=30")).toBe("30");
  });

  it("is what the loop holds each cycle for", () => {
    expect(demo).toMatch(/^HOLD_DEFAULT="\$\{DEMO_HOLD:-20\}"$/m);
    expect(demo).toContain('        HOLD="$(scenario_hold "$s")"\n');
  });
});

// The cycle's publish, audit and DORA numbers run in the background once its
// reset is written, so the next cycle's pull request does not wait for them.
describe("housekeeping", () => {
  const made: string[] = [];
  afterAll(() => {
    for (const d of made) rmSync(d, { recursive: true, force: true });
  });
  const go = (body: string) => {
    const tmp = mkdtempSync(join(tmpdir(), "demo-hk-"));
    made.push(tmp);
    const stubs = [
      'log() { echo "[demo] $*" >&2; }',
      "now() { date +%s; }",
      `WORK=${tmp}/work DEMO_STATE=${tmp}/state CYCLE=7 LIMIT_HOUSEKEEPING=20`,
      `mkdir -p ${tmp}/work ${tmp}/state`,
      `HK_PID_FILE=${tmp}/state/housekeeping.pid HK_AUDIT=""`,
      `printf '{"step":"applied"}\\n{"step":"reset"}\\n' > ${tmp}/state/timeline.jsonl`,
      // The publish reads the timeline it is given a second after it starts, as a slow one would.
      `cycle_publish() { sleep 1; cp "$1" ${tmp}/published; echo "$WORK" > ${tmp}/publish-work; }`,
      `audit_trail() { echo audit >> ${tmp}/order; }`,
      `estate_page() { echo estate >> ${tmp}/order; }`,
      "estate_wait() { :; }",
      fn("housekeeping_start"),
      fn("housekeeping_wait"),
    ].join("\n");
    const r = spawnSync("bash", ["-c", `set -euo pipefail\n${stubs}\n${body}`], { cwd: root, encoding: "utf8", timeout: 30_000 });
    const read = (f: string) => (existsSync(join(tmp, f)) ? readFileSync(join(tmp, f), "utf8") : "");
    return { r, tmp, read };
  };

  it("returns at once, and publishes the timeline as the reset left it, though the next cycle empties it", () => {
    const { r, read, tmp } = go(`s=$(date +%s)\nhousekeeping_start\necho "took $(( $(date +%s) - s ))"\n: > "$DEMO_STATE/timeline.jsonl"\nhousekeeping_wait`);
    expect(r.status, r.stderr).toBe(0);
    expect(Number(/took (\d+)/.exec(r.stdout)![1])).toBeLessThanOrEqual(0);
    expect(read("published")).toBe('{"step":"applied"}\n{"step":"reset"}\n');
    expect(read("publish-work").trim()).toBe(`${tmp}/work/hk`);
    expect(read("order")).toBe("");
  });

  it("runs the audit and then the DORA numbers after cycle_end, and only then", () => {
    const { r, read } = go("HK_AUDIT=1\nhousekeeping_start\nhousekeeping_wait\nhousekeeping_start\nhousekeeping_wait");
    expect(r.status, r.stderr).toBe(0);
    expect(read("order")).toBe("audit\nestate\n");
  });

  it("is waited for by the next housekeeping, the reports prune, putting chant/lifecycle back, and the audits outside it", () => {
    expect(fn("housekeeping_start").indexOf("housekeeping_wait")).toBeLessThan(fn("housekeeping_start").indexOf("&\n"));
    expect(fn("reports_prune")).toContain("housekeeping_wait");
    const back = fn("lifecycle_back");
    expect(back.indexOf("housekeeping_wait")).toBeGreaterThan(back.indexOf('remote_head "$REPO" chant/lifecycle'));
    expect(fn("failure_failed").indexOf("housekeeping_wait")).toBeLessThan(fn("failure_failed").indexOf("audit_trail"));
    const cycle = fn("run_cycle");
    expect(cycle.indexOf("housekeeping_wait")).toBeLessThan(cycle.indexOf("audit_trail"));
  });

  it("leaves the audit out of cycle_end, which resets, holds and writes reset, and starts the housekeeping from reset_written", () => {
    const end = fn("cycle_end");
    expect(end).not.toContain("audit_trail");
    expect(end).not.toContain("estate_page");
    expect(end.indexOf("reset_work")).toBeLessThan(end.indexOf("reset_written"));
    expect(fn("reset_written")).toContain("housekeeping_start");
    expect(fn("reset_written")).not.toContain("cycle_publish");
  });
});

// The reset prunes Forgejo and the bucket every DEMO_PRUNE_EVERY-th cycle (10).
describe("prune_due", () => {
  const due = (cycle: number, every = 10) => {
    const r = spawnSync("bash", ["-c", `PRUNE_EVERY=${every} CYCLE=${cycle}\n${demo.split("\n").find((l) => l.startsWith("prune_due()"))}\nif prune_due; then echo yes; else echo no; fi`], { cwd: root, encoding: "utf8" });
    return r.stdout.trim();
  };

  it("is due every 10th cycle by default, and every cycle at 1", () => {
    expect([9, 10, 11, 20].map((c) => due(c))).toEqual(["no", "yes", "no", "yes"]);
    expect([9, 10, 11].map((c) => due(c, 1))).toEqual(["yes", "yes", "yes"]);
    expect(demo).toMatch(/^PRUNE_EVERY="\$\{DEMO_PRUNE_EVERY:-10\}"/m);
  });

  it("gates every prune in the reset, and still copies the runs when none is due", () => {
    const work = fn("reset_work");
    for (const p of ["pulls_prune", "reports_prune", 'runs_export force "$FORGE_RUNS"']) {
      for (let i = work.indexOf(p); i >= 0; i = work.indexOf(p, i + 1)) {
        const before = work.slice(0, i);
        expect(before.lastIndexOf("prune_due"), p).toBeGreaterThan(-1);
      }
    }
    expect(work).toMatch(/else\n\s+runs_export\n/);
  });
});

// quiet holds a push only for a run with a wave still to end: a run whose
// tips job alone is left does not hold the reset or the next pull request.
describe("quiet", () => {
  const made: string[] = [];
  afterAll(() => {
    for (const d of made) rmSync(d, { recursive: true, force: true });
  });
  /** quiet with Forgejo stubbed: `runs` lists the runs, and run <id>'s jobs are jobs[id] until the poll `until`, then all success. */
  const go = (runs: unknown[], jobs: Record<string, unknown[]>, until = 1000) => {
    const tmp = mkdtempSync(join(tmpdir(), "demo-quiet-"));
    made.push(tmp);
    writeFileSync(join(tmp, "n"), "0");
    for (const [id, j] of Object.entries(jobs)) writeFileSync(join(tmp, `jobs-${id}`), JSON.stringify(j));
    writeFileSync(join(tmp, "runs"), JSON.stringify(runs));
    const stubs = [
      'log() { echo "[demo] $*" >&2; }',
      'fail() { echo "FAIL: $*" >&2; exit 1; }',
      "now() { date +%s; }",
      'URL=http://forge REPO=admin/demo-choudoufu HELD="" LIMIT_QUIET=5 POLL=0 DEMO_STEP=applied DEMO_LABEL=done',
      "runner_watch() { :; }",
      "runs_export() { :; }",
      // Each poll counts; from poll `until` on, every run has ended.
      `runs() { n=$(( $(cat ${tmp}/n) + 1 )); echo $n > ${tmp}/n; if [ "$n" -ge ${until} ]; then echo '[]'; else cat ${tmp}/runs; fi; }`,
      `api() { id="\${1##*/runs/}"; id="\${id%/jobs}"; cat ${tmp}/jobs-$id; }`,
      `demo_write() { echo "$1|$3" >> ${tmp}/writes; }`,
      fn("only_tips_left"),
      fn("quiet"),
    ].join("\n");
    const r = spawnSync("bash", ["-c", `set -euo pipefail\n${stubs}\nquiet\necho quiet`], { cwd: root, encoding: "utf8", timeout: 30_000 });
    const writes = existsSync(join(tmp, "writes")) ? readFileSync(join(tmp, "writes"), "utf8").trim().split("\n") : [];
    return { r, polls: Number(readFileSync(join(tmp, "n"), "utf8")), writes };
  };
  const waves = [{ name: "wave-1", status: "success" }, { name: "wave-2", status: "success" }];

  it("goes on at once past a run whose waves ended and whose tips job alone runs", () => {
    const { r, polls, writes } = go([{ id: 7, status: "running" }], { 7: [...waves, { name: "tips", status: "running" }] });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe("quiet");
    expect(polls).toBe(1);
    expect(r.stderr).not.toContain("waiting for run");
    expect(writes).toEqual([]);
  });

  it("waits for a run with a wave still running, says so once in the log and the next action, then goes on", () => {
    const { r, polls, writes } = go([{ id: 7, status: "running" }], { 7: [...waves.slice(0, 1), { name: "wave-2", status: "running" }, { name: "tips", status: "waiting" }] }, 4);
    expect(r.status, r.stderr).toBe(0);
    expect(polls).toBe(4);
    expect(r.stderr.match(/\[demo\] quiet: waiting for run 7 of admin\/demo-choudoufu to end before the next push/g)).toHaveLength(1);
    expect(writes).toEqual(["applied|wait for run 7 to end"]);
  });
});

// The driver goes on once a run's waves have ended and only its tips job is
// left: that job opens advice pull requests and writes nothing behold reads.
describe("only_tips_left", () => {
  const left = (jobs: unknown) => {
    const r = spawnSync("bash", ["-c", `set -euo pipefail\n${fn("only_tips_left")}\nif only_tips_left "$1"; then echo yes; else echo no; fi`, "x", JSON.stringify(jobs)], { cwd: root, encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    return r.stdout.trim();
  };
  const job = (name: string, status: string) => ({ id: 1, name, status, needs: null, task_id: 1 });

  it("passes a run whose waves succeeded while tips waits or runs", () => {
    expect(left([job("check", "success"), job("apply-wave-1", "success"), job("apply-wave-2", "success"), job("tips", "running")])).toBe("yes");
    expect(left([job("check", "success"), job("apply-wave-1", "success"), job("tips", "waiting")])).toBe("yes");
    expect(left([job("check", "success"), job("apply-comment", "success"), job("apply-wave-1", "skipped"), job("tips", "blocked")])).toBe("yes");
  });

  it("waits while a wave runs or waits, and for a run with no tips job or tips ended", () => {
    expect(left([job("check", "success"), job("apply-wave-1", "running"), job("tips", "waiting")])).toBe("no");
    expect(left([job("check", "success"), job("apply-wave-1", "success"), job("apply-wave-2", "waiting"), job("tips", "blocked")])).toBe("no");
    expect(left([job("check", "success"), job("apply-wave-1", "success")])).toBe("no");
    expect(left([job("apply-wave-1", "success"), job("tips", "success")])).toBe("no");
    expect(left([job("tips", "running")])).toBe("no");
  });

  it("never passes a wave that failed or was cancelled, nor a reply that is not a job list", () => {
    expect(left([job("check", "success"), job("apply-wave-1", "failure"), job("tips", "waiting")])).toBe("no");
    expect(left([job("check", "success"), job("apply-wave-1", "cancelled"), job("tips", "waiting")])).toBe("no");
    expect(left({ message: "not found" })).toBe("no");
    expect(left("")).toBe("no");
  });

  it("is checked by run_ended, which counts it as success", () => {
    const body = fn("run_ended");
    expect(body).toContain("only_tips_left");
    expect(body.indexOf("only_tips_left")).toBeGreaterThan(body.indexOf("success|failure|cancelled|skipped) break"));
    expect(body).toMatch(/only_tips_left[\s\S]*status=success/);
  });
});
