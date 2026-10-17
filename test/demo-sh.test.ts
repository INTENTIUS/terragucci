// stack/demo.sh runs under `set -euo pipefail`, where a pipeline whose reader
// exits early (head -1, grep -q) kills its writer with SIGPIPE and the driver
// with 141. v0.4.17's tree_bucket did that on every `up` (behold#571).
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

// #1131: the terralith scenario, five beats in one cycle. Each write names its
// beat and carries that beat's card from example-demo-terralith/scenarios.
describe("the terralith scenario", () => {
  const made: string[] = [];
  afterAll(() => {
    for (const d of made) rmSync(d, { recursive: true, force: true });
  });
  const tree = join(root, "example-demo-terralith");
  const card = (beat: string) => JSON.parse(readFileSync(join(tree, "scenarios", `terralith-${beat}`, "about.json"), "utf8")).changes as string;

  /** Run the scenario with the forge and Docker stubbed, each run ending as `outcomes` says, and read back every write. */
  function cycle(outcomes: string[]) {
    const r = run(outcomes);
    expect(r.status, r.stderr).toBe(0);
    return r.writes();
  }

  /** The scenario's run, its pushes' messages and the runs it waited for ("<before> <event> <sha>"), and its writes. */
  function run(outcomes: string[]) {
    const tmp = mkdtempSync(join(tmpdir(), "demo-terralith-"));
    made.push(tmp);
    writeFileSync(join(tmp, "outcomes"), outcomes.join("\n") + "\n");
    writeFileSync(join(tmp, "n"), "0");
    const stubs = [
      'log() { echo "$*" >&2; }',
      'fail() { echo "FAIL: $*" >&2; exit 1; }',
      "now() { date +%s; }",
      demo.split("\n").find((l) => l.startsWith("iso()"))!,
      `HERE=${join(root, "stack")} TREE=${tree} WORK=${tmp}/work RSTATE=${tmp}/rstate DEMO_STATE=${tmp}/state`,
      `mkdir -p ${tmp}/work ${tmp}/rstate ${tmp}/state`,
      `USER=admin TOKEN=t REVIEWER=demo-reviewer REVIEWER_TOKEN=r REVIEWER_KEY=${tmp}/reviewer URL=http://forge:3000`,
      `echo "ssh-ed25519 AAAA demo-reviewer" > ${tmp}/reviewer.pub`,
      "LIMIT_PLAN=1 LIMIT_RUN=1 LIMIT_START=1",
      'CYCLE=12 SCENARIO=terralith TITLE=t STARTED="" PULL="" COMMIT="" ABOUT=null HOLD=0 TOOL=terralith REPO=admin/demo-terralith',
      'INTRO="" DELIVERY="" INDEX=1 COUNT=1 INIT_PULL=1 HELD="" OUTCOME="" RUN_STATUS="" RUN_URL=u RESUMES_MAX=3 POLL=0 TERRAGUCCI=true',
      'NEXT_KEY="" NEXT_FROM="" BEAT="" MIGRATIONS_APPROVED="" PULL_FILES="" PULL_BRANCH="" PULL_TITLE=""',
      'view_follow() { :; }',
      `demo_put() { jq -c '{step, beat, repo, about: (.about.changes // null), next: (.next.action // null), from: (.next.from != null)}' "$DEMO_STATE/demo.json" >> ${tmp}/writes; }`,
      'clone_main() { mkdir -p "$1"; }',
      "overlay() { :; }",
      "tl_fill() { :; }",
      "tl_destroy_bg() { :; }",
      "tl_teams_push() { :; }",
      "tl_sync_team() { :; }",
      "lifecycle_back() { :; }",
      `push_tree() { echo "$4" >> ${tmp}/pushes; echo base; }`,
      "last_run_id() { echo 0; }",
      "push_as_author() { echo head; }",
      "pr_open() { echo 40; }",
      `run_started() { echo "$*" >> ${tmp}/started; }`,
      "runs_mark() { :; }",
      "run_ended() { RUN_STATUS=success; }",
      "on_waiting() { default_waiting; }",
      "on_failed() { exit 1; }",
      "on_refused() { exit 1; }",
      // Each run ends as the next line of outcomes says: OUTCOME, then MIGRATION, MIGRATE_DIGEST and WAVE.
      `run_outcome() { local i; i=$(( $(cat ${tmp}/n) + 1 )); echo "$i" > ${tmp}/n; set -- $(sed -n "\${i}p" ${tmp}/outcomes); OUTCOME="$1" MIGRATION="\${2:-}" MIGRATE_DIGEST="\${3:-}" WAVE="\${4:-}"; }`,
      "approve_migration() { :; }",
      "approve_wave() { :; }",
      "resume_pull() { :; }",
      "quiet() { :; }",
      "as_author() { :; }",
      "cycle_publish() { :; }",
      `api() { case "$*" in *comments*) echo '[{"body":"terragucci tf-plan"}]' ;; *) echo '{"merge_commit_sha":"merge"}' ;; esac; }`,
    ].join("\n");
    const fns = [
      "demo_where", "scenario_name", "say", "waiting_label", "demo_write", "demo_hold", "open_pull", "merge_pull", "follow", "default_waiting",
      "tool_repo", "tl_team_repo", "tl_repo", "tl_beat", "tl_stock_beat", "tl_pull_beat", "tl_migrate_waiting", "scenario_terralith", "reset_written",
    ].map(fn).join("\n");
    const body = `${stubs}\n${fns}\nTL_TEAMS=(team-a team-b team-c) TL_TEAM=team-b\nscenario_terralith\ndemo_write applied "$(say applied)" reset "$(now)"\nreset_written`;
    const r = spawnSync("bash", ["-c", `set -euo pipefail\n${body}`], { cwd: root, encoding: "utf8" });
    const lines = (f: string) => (existsSync(join(tmp, f)) ? readFileSync(join(tmp, f), "utf8").trim().split("\n") : []);
    return {
      status: r.status,
      stderr: r.stderr,
      pushes: lines("pushes"),
      started: lines("started"),
      writes: () => lines("writes").map((l) => JSON.parse(l) as { step: string; beat: string | null; repo: string; about: string | null; next: string | null; from: boolean }),
    };
  }

  // The stock push's run first, then the adopt and split merges' (each a migration that waits, then its re-run) and the team's.
  const migrate = ["applied", "migrate adopt sha256:a 1", "applied", "migrate split sha256:s 1", "applied", "applied"];

  it("writes each beat's steps, in order, each with its beat and card", () => {
    const writes = cycle([...migrate, "waiting - - 2", "applied"]);
    const gated = ["pull-request", "planned", "merged", "applying", "waiting", "approved", "resumed", "applied"];
    expect(writes.map((w) => `${w.beat} ${w.step}`)).toEqual([
      "stock applying",
      "stock applied",
      ...gated.map((s) => `adopt ${s}`),
      ...gated.map((s) => `split ${s}`),
      ...["pull-request", "planned", "merged", "applying", "applied"].map((s) => `team ${s}`),
      // The last beat's applied is the cycle's, written with reset as its next action.
      ...gated.map((s) => `cross ${s}`),
      "null reset",
    ]);
    for (const w of writes.filter((x) => x.beat)) expect(w.about, `${w.beat} ${w.step}`).toBe(card(w.beat!));
    // The reset is the cycle's, not a beat's: no beat and no card.
    expect(writes.at(-1)).toMatchObject({ beat: null, about: null, next: "start the next cycle" });
  });

  it("pushes the stock terralith to main with no [skip ci], and waits for that push's run", () => {
    const r = run([...migrate, "applied"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.pushes[0]).toBe("The terralith, stock, for cycle 12");
    // The first run the cycle waits for is the stock commit's push run.
    expect(r.started[0]).toBe("0 push base");
    expect(r.writes().slice(0, 2).map((w) => `${w.beat} ${w.step} ${w.next}`)).toEqual(["stock applying follow the stock apply", "stock applied open the adopt pull request"]);
  });

  it("stalls the stock beat when its run ends in anything but applied, before the adopt beat", () => {
    const r = run(["failed"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("FAIL: the stock terralith of cycle 12 ended failed (u)");
    expect(r.writes().map((w) => `${w.beat} ${w.step}`)).toEqual(["stock applying"]);
  });

  it("runs the team beat in team B's own repository, and the others in demo-terralith", () => {
    const writes = cycle([...migrate, "applied"]);
    for (const w of writes) expect(w.repo, `${w.beat} ${w.step}`).toBe(w.beat === "team" ? "admin/demo-terralith-team-b" : "admin/demo-terralith");
  });

  it("names the next action at every beat's step, and when the wait for it started", () => {
    const writes = cycle([...migrate, "applied"]);
    for (const w of writes) {
      expect(w.next, `${w.beat} ${w.step}`).not.toBeNull();
      expect(w.from, `${w.beat} ${w.step}`).toBe(true);
    }
    const at = (beat: string, step: string) => writes.find((w) => w.beat === beat && w.step === step)!.next;
    expect(at("stock", "applied")).toBe("open the adopt pull request");
    expect(at("adopt", "waiting")).toBe("approve migration adopt");
    expect(at("adopt", "applied")).toBe("open the split pull request");
    expect(at("split", "waiting")).toBe("approve migration split");
    expect(at("split", "applied")).toBe("push each team's root to its own repository");
    expect(at("team", "applied")).toBe("copy team B's root back to demo-terralith");
  });

  it("stalls a beat whose waves end in anything but applied", () => {
    const tmp = mkdtempSync(join(tmpdir(), "demo-terralith-stall-"));
    made.push(tmp);
    const r = spawnSync("bash", ["-c", `set -euo pipefail\nfail() { echo "FAIL: $*" >&2; exit 1; }\nOUTCOME=refused RUN_URL=u BEAT=adopt\n${fn("tl_pull_beat").replace(/^tl_pull_beat\(\) \{[^\n]*\n[\s\S]*?follow\n/, "tl_pull_beat() {\n")}\ntl_pull_beat next`], { cwd: root, encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("FAIL: the adopt beat ended refused (u)");
  });
});

// #1131: a migration in wave 1 that waits for its digest, read from the run's log.
describe("run_outcome on a waiting migration", () => {
  const outcome = (logs: string, approved = "") => {
    const body = [
      `run_logs() { printf '%s\\n' ${JSON.stringify(logs)}; }`,
      "api() { echo '[]'; }",
      `REPO=admin/demo-terralith RUN_ID=9 RUN_STATUS=failure URL=http://forge MIGRATIONS_APPROVED=${JSON.stringify(approved)}`,
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

// #1131: each cycle's names, estates and state key carry its own prefix.
describe("tl_fill", () => {
  it("writes the cycle's prefix over the generator's, once", () => {
    const tmp = mkdtempSync(join(tmpdir(), "demo-terralith-fill-"));
    try {
      const copy = spawnSync("bash", ["-c", `cp -R example-demo-terralith/terralith example-demo-terralith/scenarios ${tmp}/`], { cwd: root, encoding: "utf8" });
      expect(copy.status, copy.stderr).toBe(0);
      const body = `CYCLE=7\n${fn("tl_fill")}\ntl_fill ${tmp}\ntl_fill ${tmp}`;
      const r = spawnSync("bash", ["-c", `set -euo pipefail\n${body}`], { cwd: root, encoding: "utf8" });
      expect(r.status, r.stderr).toBe(0);
      const read = (...p: string[]) => readFileSync(join(tmp, ...p), "utf8");
      expect(read("terralith", "iam.tf")).toContain('name = "tl7-team-0000-role"');
      expect(read("terralith", "iam.tf")).not.toMatch(/"tl-/);
      expect(read("terralith", "dns.tf")).toContain('name = "tl7.terralith.test"');
      expect(read("terralith", "main.tf")).toContain('name_prefix = "tl7"');
      expect(read("terralith", "state.tf")).toContain('key            = "tl7-terralith.tfstate"');
      expect(read("terralith", "state.tf")).toContain('bucket         = "demo-terralith-state"');
      expect(read("scenarios", "terralith-split", "pull", "team-a", "state.tf")).toContain('estate = "tl7-team-a"');
      expect(read("scenarios", "terralith-adopt", "pull", "migrations", "adopt.yml")).toContain("key: tl7-terralith.tfstate");
      expect(read("scenarios", "terralith-cross", "pull", "team-b", "logs.tf")).toContain('estate = "tl7-terralith"');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
