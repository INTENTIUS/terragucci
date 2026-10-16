// stack/demo.sh runs under `set -euo pipefail`, where a pipeline whose reader
// exits early (head -1, grep -q) kills its writer with SIGPIPE and the driver
// with 141. v0.4.17's tree_bucket did that on every `up` (behold#571).
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
    const body = `log() { echo "$*" >&2; }\nVIEWS=${tmp}/views VIEW_OWNER="" REPO=admin/demo REMOTE=${tmp}/admin-remote COMMIT=${head}\n${fn("view_follow").replace(/^VIEW_AT=""\n/, "")}\nVIEW_AT=""\nview_follow`;
    const r = spawnSync("bash", ["-c", `set -euo pipefail\n${body}`], { cwd: root, encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    const dir = join(tmp, "views", "demo.change");
    expect(sh("git rev-parse HEAD", dir)).toBe(head);
    expect(existsSync(join(dir, "live", "b.tf"))).toBe(true);
    expect(existsSync(join(dir, ".git", "FETCH_HEAD"))).toBe(false);
    expect(sh("grep -rl admin-remote .git || true", dir)).toBe("");
  });

  it("does nothing without DEMO_VIEWS, and logs a missing checkout", () => {
    const body = `log() { echo "$*" >&2; }\nREPO=admin/demo REMOTE=/nowhere COMMIT=abc VIEW_OWNER=""\n${fn("view_follow")}`;
    const off = spawnSync("bash", ["-c", `set -euo pipefail\nVIEWS=""\nVIEW_AT=""\n${body}\nview_follow`], { cwd: root, encoding: "utf8" });
    expect(off.status).toBe(0);
    expect(off.stderr).toBe("");
    const missing = spawnSync("bash", ["-c", `set -euo pipefail\nVIEWS=/nowhere\nVIEW_AT=""\n${body}\nview_follow`], { cwd: root, encoding: "utf8" });
    expect(missing.status).toBe(0);
    expect(missing.stderr).toContain("view: no checkout /nowhere/demo.change");
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
