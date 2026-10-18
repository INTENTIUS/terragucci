// stack/demo.sh runs under `set -euo pipefail`, where a pipeline whose reader
// exits early (head -1, grep -q) kills its writer with SIGPIPE and the driver
// with 141. v0.4.17's tree_bucket did that on every `up` (behold#571).
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

  it("reads the fan-out tree's state bucket and its fifteen roots' keys", () => {
    const r = run(`tree_bucket example-demo-fanout; tree_keys example-demo-fanout tofu-fanout`);
    expect(r.status, r.stderr).toBe(0);
    const [bucket, ...keys] = r.stdout.trim().split("\n");
    expect(bucket).toBe("demo-fanout-state");
    const apps = Array.from({ length: 12 }, (_, i) => `app-${String(i + 1).padStart(2, "0")}`);
    expect(keys).toEqual([...apps, "cluster-a", "cluster-b", "network"].map((root) => `${root} ${root}.tfstate`));
  });

  it("installs the fan-out tree's hashicorp/aws from the demo image's mirror, checked against the release's sums", () => {
    const config = readFileSync(join(root, "example-demo-fanout", "terragucci.yml"), "utf8");
    expect(config).toContain("image: terragucci-demo-tofu:local\n");
    expect(config).toContain("TF_CLI_CONFIG_FILE: /etc/terragucci-demo/tofu-mirror.tfrc");
    const tfrc = readFileSync(join(root, "stack", "demo-yodel", "tofu-mirror.tfrc"), "utf8");
    expect(tfrc).toContain('path    = "/opt/terragucci-demo/providers"');
    expect(tfrc.match(/registry\.opentofu\.org\/hashicorp\/aws/g)).toHaveLength(2);
    const dockerfile = readFileSync(join(root, "stack", "demo-yodel", "Dockerfile"), "utf8");
    expect(dockerfile).toContain("COPY tofu-mirror.tfrc /etc/terragucci-demo/tofu-mirror.tfrc");
    expect(dockerfile).toContain("COPY --from=awsprovider /providers /opt/terragucci-demo/providers");
    expect(dockerfile).toMatch(/sha256sum -c -; \\\n.*SHA256SUMS \| sha256sum -c -/);
    const sums = readFileSync(join(root, "stack", "demo-yodel", "aws-provider.sha256"), "utf8").split("\n").filter((l) => /^\d/.test(l));
    expect(sums.map((l) => l.split(" ").slice(0, 2).join(" "))).toEqual(["6.67.0 amd64", "6.67.0 arm64"]);
    // Every root pins the version the image mirrors.
    for (const r of ["network", "cluster-a", "app-12"]) expect(readFileSync(join(root, "example-demo-fanout", r, "main.tf"), "utf8")).toContain('version = "6.67.0"');
  });

  it("has a pull request and a fix that differ only in cluster-a's queue name", () => {
    const at = (d: string) => readFileSync(join(root, "example-demo-fanout", "scenarios", "fan-out-tofu", d, "cluster-a", "main.tf"), "utf8");
    expect(at("pull").replace('name                       = "fan-out-network-events"', 'name                       = "fan-out-cluster-a-events"')).toBe(at("fix"));
    // The name network's queue has, with another visibility timeout: SQS refuses it at apply.
    expect(readFileSync(join(root, "example-demo-fanout", "network", "main.tf"), "utf8")).toContain('name                       = "fan-out-network-events"');
  });

  it("reads the choudoufu fan-out tree's fifteen roots, which name estates and no state file", () => {
    const tree = join(root, "example-demo-choudoufu-fanout");
    const r = spawnSync("bash", ["-c", `set -euo pipefail\n${fn("tree_roots")}\ntree_roots example-demo-choudoufu-fanout`], { cwd: root, encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    const apps = Array.from({ length: 12 }, (_, i) => `app-${String(i + 1).padStart(2, "0")}`);
    expect(r.stdout.trim().split("\n")).toEqual([...apps, "cluster-a", "cluster-b", "network"]);
    for (const root of ["network", "cluster-a", "app-07"]) {
      const tf = readFileSync(join(tree, root, "main.tf"), "utf8");
      expect(tf).toContain(`estate = "fo-${root}"`);
      expect(tf).toContain('bucket = "demo-live-records"');
      expect(tf).not.toMatch(/backend "/);
    }
    expect(readFileSync(join(tree, "terragucci.yml"), "utf8")).toMatch(/^binary: choudoufu$/m);
  });

  it("keeps an undeclared resource in app-01's estate alone, so the operator's queue and the pipeline's apply both land", () => {
    const tree = join(root, "example-demo-choudoufu-fanout");
    expect(readFileSync(join(tree, "app-01", "main.tf"), "utf8")).toContain('undeclared_tagged = "keep"');
    for (const root of ["app-02", "cluster-a", "network"]) expect(readFileSync(join(tree, root, "main.tf"), "utf8")).not.toContain("undeclared_tagged");
    // The operator adds one queue, applied with -target on it alone, and the reset destroys that one.
    const operator = readFileSync(join(tree, "scenarios", "fan-out-choudoufu", "operator", "app-01", "operator.tf"), "utf8");
    expect(operator.match(/^resource "/gm)).toHaveLength(1);
    expect(operator).toContain('resource "aws_sqs_queue" "alarms"');
    expect(demo).toContain('OPERATOR_TARGET="aws_sqs_queue.alarms"');
    expect(fn("operator_beat")).toContain("-target=$OPERATOR_TARGET");
    expect(fn("operator_back")).toContain("choudoufu destroy -auto-approve -input=false -no-color -target=$OPERATOR_TARGET");
    // The operator starts only once wave 3 has planned, so the pipeline's plan of app-01 never sees its queue.
    expect(fn("operator_beat")).toContain("wave 3 of 3: set digest");
  });

  it("writes the operator's apply as demo.json's outside", () => {
    const script = [fn("outside_json"), demo.split("\n").find((l) => l.startsWith("iso()"))!, 'OPERATOR_TARGET="aws_sqs_queue.alarms"', 'outside_json applied 1792000000 1792000009 "$(printf "a\\nb\\n\\nApply complete!")"'].join("\n");
    const r = spawnSync("bash", ["-c", `set -euo pipefail\n${script}`], { cwd: root, encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    const o = JSON.parse(r.stdout);
    expect(o).toMatchObject({ who: "an operator", estate: "fo-app-01", state: "applied", resources: ["aws_sqs_queue.alarms"], log: ["a", "b", "Apply complete!"] });
    expect(o.ended_at).not.toBeNull();
  });

  it("numbers the fan-out steps in four chapters, and gives every other scenario's steps none", () => {
    const cases = [
      ["fan-out-tofu", "", "pull-request"],
      ["fan-out-tofu", "", "applying"],
      ["fan-out-tofu", "", "failed"],
      ["fan-out-tofu", "1", "pull-request"],
      ["fan-out-tofu", "1", "merged"],
      ["fan-out-tofu", "1", "applied"],
      ["fan-out-tofu", "1", "reset"],
      ["fan-out-tofu", "", "reset"],
      ["b-waves", "", "applying"],
      ["base", "", "reset"],
    ];
    const lines = cases.map(([s, f, step]) => `SCENARIO=${s} FIX="${f}"; echo "$(demo_chapter ${step})"`).join("\n");
    const r = spawnSync("bash", ["-c", `set -euo pipefail\n${fn("demo_chapter")}\n${fn("chapter_headline")}\n${fn("chapter_short")}\n${lines}`], { cwd: root, encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    const got = r.stdout.trim().split("\n").map((l) => JSON.parse(l));
    expect(got.map((c) => c?.n ?? null)).toEqual([1, 1, 2, 3, 3, 4, 4, null, null, null]);
    expect(got.filter(Boolean).map((c) => c.short)).toEqual(["The change goes out", "The change goes out", "cluster-a breaks", "The fix", "The fix", "Done", "Done"]);
    expect(got[2].headline).toBe("cluster-a breaks. Only its 6 apps stop; the other 8 stacks ship anyway");
  });

  it("gives the choudoufu fan-out its own chapter 3, two applies on one estate", () => {
    const steps = [["", "pull-request"], ["", "failed"], ["1", "applying"], ["1", "reset"]];
    const lines = steps.map(([f, step]) => `SCENARIO=fan-out-choudoufu FIX="${f}"; echo "$(demo_chapter ${step})"`).join("\n");
    const r = spawnSync("bash", ["-c", `set -euo pipefail\n${fn("demo_chapter")}\n${fn("chapter_headline")}\n${fn("chapter_short")}\n${lines}`], { cwd: root, encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    const got = r.stdout.trim().split("\n").map((l) => JSON.parse(l));
    expect(got.map((c) => [c.n, c.short])).toEqual([[1, "The change goes out"], [2, "cluster-a breaks"], [3, "Two applies, one estate"], [4, "Done"]]);
    expect(got[2].headline).toBe("Same estate, two applies, both land");
    expect(got[3].headline).toBe("All 15 are in, and no state file was locked or restored");
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

// The driver goes on once a run's waves have ended and only its tips job is
// left: that job opens advice pull requests and writes nothing behold reads.
// terragucci#1161: Forgejo marks a run failed once one wave failed, while a later wave, which starts after a failure, still runs.
describe("jobs_ended", () => {
  const ended = (jobs: unknown) => {
    const r = spawnSync("bash", ["-c", `set -euo pipefail\n${fn("jobs_ended")}\nif jobs_ended "$1"; then echo yes; else echo no; fi`, "x", typeof jobs === "string" ? jobs : JSON.stringify(jobs)], { cwd: root, encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    return r.stdout.trim();
  };
  const job = (name: string, status: string) => ({ id: 1, name, status });

  it("waits for a later wave of a run Forgejo already marked failed", () => {
    expect(ended([job("apply-wave-1", "success"), job("apply-wave-2", "failure"), job("apply-wave-3", "running")])).toBe("no");
    expect(ended([job("apply-wave-2", "failure"), job("apply-wave-3", "waiting")])).toBe("no");
    expect(ended([job("apply-wave-2", "failure"), job("apply-wave-3", "failure"), job("tips", "skipped")])).toBe("yes");
  });

  it("takes a reply that is no job list as ended, as before the check", () => {
    expect(ended("")).toBe("yes");
    expect(ended({ message: "not found" })).toBe("yes");
  });

  it("is checked by run_ended before it takes a run as over, and by quiet for the newest failed runs", () => {
    expect(fn("run_ended")).toMatch(/success\|failure\|cancelled\|skipped\)\n\s+jobs_ended "\$\(api [^\n]*\/jobs[^\n]*\)" && break/);
    expect(fn("quiet")).toContain('jobs_ended "$(api "$URL/api/v1/repos/$REPO/actions/runs/$id/jobs"');
  });
});

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
