import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { lockRowsPath, parseLockRows as parseRows } from "@intentius/chant/lifecycle/resource-lock";
import { applyScope, CHANT_ROWS_GATE, describeHeld, forgeLiveness, planRows, readRows, releaseRows, takeRows, type HeldRow, type Liveness, type RowHolder } from "../src/apply-rows";
import { applyWave, EXIT } from "../src/apply";
import { WAVES_SPEC, waveCallArgv, wavesSpecText, wavesStepSpec } from "../src/chant-waves";
import { git, tmp, write } from "./helpers";

const change = (address: string, actions: string[], before: Record<string, unknown> | null = null, extra: Record<string, unknown> = {}) => ({
  address,
  mode: "managed",
  type: address.split(".")[0],
  name: address.split(".")[1],
  change: { actions, before, after: {}, after_unknown: {} },
  ...extra,
});

describe("applyScope", () => {
  it("choudoufu holds what its plans change; every other binary leaves a root's applies to its backend's state lock", () => {
    expect(applyScope("choudoufu")).toBe("resource");
    expect(applyScope("/usr/local/bin/choudoufu")).toBe("resource");
    expect(applyScope("tofu")).toBe("root");
    expect(applyScope("terraform")).toBe("root");
  });
});

describe("planRows", () => {
  it("keys each change the apply acts on by estate and address, its previous address, and the live object's id for an update or a delete", () => {
    const plan = {
      resource_changes: [
        change("aws_s3_bucket.new", ["create"]),
        change("aws_s3_bucket.logs", ["update"], { id: "acme-logs" }),
        change("aws_instance.web", ["delete", "create"], { id: "i-123" }),
        change("aws_iam_role.gone", ["delete"], { id: "gone-role" }),
        change("aws_sqs_queue.renamed", ["no-op"], { id: "q" }, { previous_address: "aws_sqs_queue.old" }),
        change("aws_sqs_queue.moved", ["update"], { id: "q2" }, { previous_address: "aws_sqs_queue.was" }),
        change("aws_vpc.same", ["no-op"], { id: "vpc-1" }),
        { ...change("aws_ami.latest", ["read"]), mode: "data" },
        change("terraform_data.dropped", ["forget"], { id: "x-1" }),
      ],
    };
    expect(planRows("prod", "prod-eu", plan).map((r) => r.key)).toEqual([
      "estate prod-eu aws_iam_role.gone",
      "estate prod-eu aws_instance.web",
      "estate prod-eu aws_s3_bucket.logs",
      "estate prod-eu aws_s3_bucket.new",
      "estate prod-eu aws_sqs_queue.moved",
      "estate prod-eu aws_sqs_queue.was",
      "estate prod-eu terraform_data.dropped",
      "object acme-logs",
      "object gone-role",
      "object i-123",
      "object q2",
      "object x-1",
    ]);
    // A create has no live object yet, and a root with no estate is keyed by its path.
    expect(planRows("app", undefined, { resource_changes: [change("terraform_data.x", ["create"])] })).toEqual([{ key: "root app terraform_data.x", root: "app", address: "terraform_data.x" }]);
    expect(planRows("app", "e", {})).toEqual([]);
  });

  it("two estates that meet on one object meet on its row", () => {
    const a = planRows("a", "team-a", { resource_changes: [change("kubernetes_labels.x", ["update"], { id: "default/web" })] });
    const b = planRows("b", "team-b", { resource_changes: [change("kubernetes_annotations.y", ["update"], { id: "default/web" })] });
    expect(a.map((r) => r.key).filter((k) => b.some((x) => x.key === k))).toEqual(["object default/web"]);
  });
});

/** A bare origin and a clone of it with one commit on main. */
function repo(): { work: string; origin: string; dir: string } {
  const dir = tmp("tg-rows-");
  const origin = join(dir, "origin.git");
  git(dir, "init", "-q", "--bare", origin);
  const work = join(dir, "work");
  mkdirSync(work, { recursive: true });
  git(work, "init", "-q", "-b", "main");
  git(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "one");
  git(work, "remote", "add", "origin", origin);
  git(work, "push", "-q", "origin", "main");
  return { work, origin, dir };
}

const holder = (run: string, at = new Date().toISOString()): RowHolder => ({ run, at, url: `http://forge/runs/${run}` });
const alive: Liveness = async () => "alive";
const rows = (root: string, ...addresses: string[]) => planRows(root, "e", { resource_changes: addresses.map((a) => change(a, ["create"])) });

describe("takeRows and releaseRows", () => {
  it("takes every row in one commit, refuses the whole take while a live run holds one, and lets go of only its own", async () => {
    const { work, origin } = repo();
    expect(await takeRows(work, rows("a", "terraform_data.left"), holder("1"), alive)).toEqual({ ok: true, tookOver: [] });
    // A disjoint take lands beside it.
    expect(await takeRows(work, rows("a", "terraform_data.right"), holder("2"), alive)).toEqual({ ok: true, tookOver: [] });
    const both = rows("a", "terraform_data.left", "terraform_data.other");
    const refused = await takeRows(work, both, holder("3"), alive);
    expect(refused).toMatchObject({ ok: false, held: [{ key: "estate e terraform_data.left", holder: { run: "1" } }] });
    // Nothing of a refused take was written.
    expect((await readRows(work)).rows).toEqual({ "estate e terraform_data.left": "1", "estate e terraform_data.right": "2" });
    expect(describeHeld((refused as { held: HeldRow[] }).held, both)).toBe("run 1 (http://forge/runs/1) is applying a: terraform_data.left");
    // A run takes its own rows again as its own.
    expect((await takeRows(work, rows("a", "terraform_data.left"), holder("1"), alive)).ok).toBe(true);
    expect(await releaseRows(work, ["estate e terraform_data.left"], "1")).toBe(true);
    // Releasing a row another run holds leaves it.
    expect(await releaseRows(work, ["estate e terraform_data.right"], "1")).toBe(true);
    const file = parseRows(git(origin, "show", `chant/lifecycle:${lockRowsPath(CHANT_ROWS_GATE)}`));
    expect(file.rows).toEqual({ "estate e terraform_data.right": "2" });
    expect(Object.keys(file.holders)).toEqual(["2"]);
  });

  it("takes over every row of a run that is gone in the same commit, with nothing to unlock", async () => {
    const { work } = repo();
    await takeRows(work, rows("a", "terraform_data.left", "terraform_data.far"), holder("7"), alive);
    const dead: Liveness = async (h) => (h.run === "7" ? "dead" : "alive");
    const r = await takeRows(work, rows("a", "terraform_data.left"), holder("8"), dead);
    expect(r).toMatchObject({ ok: true, tookOver: [{ run: "7" }] });
    expect(await readRows(work)).toMatchObject({ rows: { "estate e terraform_data.left": "8" } });
    expect(Object.keys((await readRows(work)).holders)).toEqual(["8"]);
  });

  it("refuses to guess when origin cannot be read", async () => {
    const { work } = repo();
    git(work, "remote", "set-url", "origin", join(work, "nowhere.git"));
    await expect(takeRows(work, rows("a", "terraform_data.left"), holder("1"), alive)).rejects.toThrow(/cannot fetch chant\/lifecycle from origin/);
    expect(await releaseRows(work, ["k"], "1")).toBe(false);
  });
});

describe("forgeLiveness", () => {
  const now = Date.parse("2026-10-09T12:00:00Z");
  const fetchOf = (status: string, ok = true) => vi.fn(async () => ({ ok, json: async () => ({ status }) }));

  it("asks GitHub or Forgejo for the run with the job's token, and counts a finished run as gone", async () => {
    const env = { TG_TOKEN: "t", GITHUB_SERVER_URL: "http://forge", GITHUB_REPOSITORY: "acme/infra" };
    const h = holder("41", "2026-10-09T11:59:00Z");
    for (const [status, verdict] of [["running", "alive"], ["waiting", "alive"], ["in_progress", "alive"], ["completed", "dead"], ["cancelled", "dead"], ["failure", "dead"], ["success", "dead"]] as const) {
      const f = fetchOf(status);
      expect(await forgeLiveness(env, f, () => now)(h), status).toBe(verdict);
      expect(f).toHaveBeenCalledWith("http://forge/api/v1/repos/acme/infra/actions/runs/41", { headers: { authorization: "token t" } });
    }
    // An answer it cannot read, or no token at all, counts as alive.
    expect(await forgeLiveness(env, fetchOf("completed", false), () => now)(h)).toBe("alive");
    expect(await forgeLiveness({}, fetchOf("completed"), () => now)(h)).toBe("alive");
  });

  it("asks GitLab for the pipeline", async () => {
    const f = fetchOf("canceled");
    expect(await forgeLiveness({ TG_TOKEN: "t", CI_API_V4_URL: "http://gl/api/v4", CI_PROJECT_ID: "9" }, f, () => now)(holder("5", "2026-10-09T11:59:00Z"))).toBe("dead");
    expect(f).toHaveBeenCalledWith("http://gl/api/v4/projects/9/pipelines/5", { headers: { "private-token": "t" } });
  });

  it("counts a lease older than TG_LOCK_STALE as gone, whatever the forge says", async () => {
    const f = fetchOf("running");
    expect(await forgeLiveness({ TG_TOKEN: "t", GITHUB_SERVER_URL: "http://forge", GITHUB_REPOSITORY: "a/b", TG_LOCK_STALE: "60" }, f, () => now)(holder("1", "2026-10-09T11:58:00Z"))).toBe("dead");
    expect(f).not.toHaveBeenCalled();
  });

  it("a holder outside CI on this host is gone once its process is", async () => {
    const live = forgeLiveness({}, fetchOf("running"));
    expect(await live({ run: `local:${hostname()}:${process.pid}`, at: new Date().toISOString() })).toBe("alive");
    expect(await live({ run: `local:${hostname()}:999999`, at: new Date().toISOString() })).toBe("dead");
    expect(await live({ run: "local:another-host:1", at: new Date().toISOString() })).toBe("alive");
  });
});

/** The rows file a wave holds its rows in: chant's for the pull-request loop's gate. */
const rowsFile = async (): Promise<string> => lockRowsPath(CHANT_ROWS_GATE);

/**
 * A fake choudoufu, run in the root's directory as chant's step runs it:
 * plan writes the root into the plan file and counts the plans, show -json
 * prints $PLANS/<root>.json for a plan file and an empty state otherwise,
 * apply logs the root and what chant/lifecycle on origin holds while it
 * applies ($ROWS_FILE), and each call goes to $LOG.calls.
 */
const FAKE = `#!/usr/bin/env bash
root="$(basename "$PWD")"
echo "$root $*" >> "$LOG.calls"
case "$1" in
  init) ;;
  plan) for a in "$@"; do case "$a" in -out=*) echo "$root" > "\${a#-out=}" ;; esac; done; echo plan >> "$PLANNED"; echo "Plan: 1 to add" ;;
  show) f="\${@: -1}"; if [ -f "$f" ]; then cat "$PLANS/$(cat "$f").json"; else echo '{"values":{}}'; fi ;;
  apply) echo "applied $root" >> "$LOG"; git -C "$ORIGIN" show "chant/lifecycle:$ROWS_FILE" >> "$LOG" 2>/dev/null; echo "Apply complete! Resources: 1 added, 0 changed, 0 destroyed." ;;
  output) echo "{}" ;;
  version) if [ "$2" = "-json" ]; then echo '{"terraform_version":"1.8.0"}'; else echo "choudoufu v0.30.0"; fi ;;
esac
exit 0
`;

describe("a choudoufu wave holds what its plans change", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  async function setup(name = "choudoufu"): Promise<{ work: string; origin: string; bin: string; log: string; planned: string; lines: string[]; file: string }> {
    const { work, origin, dir } = repo();
    write(work, { "a/main.tf": 'terraform {\n  live {\n    estate = "shop"\n  }\n}\n' });
    git(work, "add", "-A");
    git(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "root");
    git(work, "push", "-q", "origin", "main");
    const plans = join(dir, "plans");
    mkdirSync(plans);
    writeFileSync(join(plans, "a.json"), JSON.stringify({ resource_changes: [change("terraform_data.left", ["update"], { id: "left-id" })] }));
    const bin = join(dir, name);
    writeFileSync(bin, FAKE);
    chmodSync(bin, 0o755);
    vi.stubEnv("PLANS", plans);
    vi.stubEnv("LOG", join(dir, "apply.log"));
    vi.stubEnv("PLANNED", join(dir, "planned.log"));
    vi.stubEnv("ORIGIN", origin);
    // chant's step takes the rows as the job's run, read from the job's environment.
    vi.stubEnv("GITHUB_RUN_ID", "100");
    const file = await rowsFile();
    vi.stubEnv("ROWS_FILE", file);
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((l: string) => void lines.push(String(l)));
    return { work, origin, bin, log: join(dir, "apply.log"), planned: join(dir, "planned.log"), lines, file };
  }

  const opts = (bin: string, extra: Record<string, unknown> = {}) => ({ wave: 1, layers: [["a"]], binary: bin, gate: "never" as const, env: { ...process.env, GITHUB_RUN_ID: "100", TG_LOCK_POLL: "0.05" }, ...extra });

  // The leases of a choudoufu root's resource rows are chant's step's own (leaseWaveRows, chant#4552), tested in chant against
  // choudoufu's live plan set; terragucci hands it the choudoufu binary by name (stepBinary), so the estate is found.

  // chant's step holds a stock binary's root whole (the target grain), since its state file is one lock.
  it("a stock binary holds its root's row, none of its resources, while it applies, and lets go of it after", async () => {
    const { work, origin, bin, log, file } = await setup("tofu");
    expect(await applyWave(work, opts(bin))).toBe(EXIT.applied);
    const during = readFileSync(log, "utf-8");
    expect(during).toContain("applied a");
    expect(parseRows(during.slice(during.indexOf("{"))).rows).toEqual({ "root a": "100" });
    expect(parseRows(git(origin, "show", `chant/lifecycle:${file}`)).rows).toEqual({});
  });
});
