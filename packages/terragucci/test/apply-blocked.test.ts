/**
 * terragucci#1161: a failed root blocks only the roots that depend on it.
 * The estate is network, then cluster-a and cluster-b on it, then app-a on
 * cluster-a and app-b on cluster-b, each reading its upstream's state. Each
 * wave runs as a pipeline's job would, with --after naming the directory the
 * earlier waves' outcomes are in (here the checkout's own report directory,
 * as a comment's apply has it).
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyWave } from "../src/apply";
import { blockedRoots, earlierRun, onlyWaiting, outcomeFileName, runSummary, writeOutcomeFile } from "../src/blocked";
import { renderPipeline } from "../src/render";
import { tmp } from "./helpers";
import { setup } from "./apply-helpers";

const state = (key: string): string => `terraform {\n  backend "s3" {\n    bucket = "s"\n    key    = "${key}"\n  }\n}\n`;
const reads = (key: string): string => `data "terraform_remote_state" "up" {\n  backend = "s3"\n  config = {\n    bucket = "s"\n    key    = "${key}"\n  }\n}\n`;
const create = { resource_changes: [{ address: "terraform_data.x", mode: "managed", type: "terraform_data", name: "x", change: { actions: ["create"], before: null, after: { input: "1" }, after_unknown: {} } }] };

/** The fake tofu of ./apply-helpers.ts, whose apply fails for each root named in $FAIL. */
const FAILING = `#!/usr/bin/env bash
dir="\${1#-chdir=}"; root="$(basename "$dir")"
case "$2" in
  plan) for a in "$@"; do case "$a" in -out=*) echo "$root" > "\${a#-out=}" ;; esac; done; echo "Plan: 1 to add" ;;
  show) cat "$PLANS/$(cat "\${@: -1}").json" ;;
  apply)
    case " $FAIL " in *" $root "*) echo "Error: The name of a FIFO queue can only end with '.fifo'" >&2; exit 1 ;; esac
    echo "applied $root" >> "$LOG"; echo "Apply complete! Resources: 1 added, 0 changed, 0 destroyed." ;;
esac
exit 0
`;

const LAYERS = [["network"], ["cluster-a", "cluster-b"], ["app-a", "app-b"]];

function estate(): { work: string; log: string; bin: string; run: (wave: number, fail?: string) => Promise<number> } {
  const { work, bin, log } = setup({
    "network/main.tf": state("network.tfstate"),
    "cluster-a/main.tf": state("cluster-a.tfstate") + reads("network.tfstate"),
    "cluster-b/main.tf": state("cluster-b.tfstate") + reads("network.tfstate"),
    "app-a/main.tf": state("app-a.tfstate") + reads("cluster-a.tfstate"),
    "app-b/main.tf": state("app-b.tfstate") + reads("cluster-b.tfstate"),
  });
  writeFileSync(bin, FAILING);
  chmodSync(bin, 0o755);
  const plans = join(work, "..", "plans");
  for (const r of LAYERS.flat()) writeFileSync(join(plans, `${r}.json`), JSON.stringify(create));
  const report = join(work, "terragucci-report");
  const run = async (wave: number, fail = ""): Promise<number> => {
    vi.stubEnv("FAIL", fail);
    return applyWave(work, { wave, layers: LAYERS, binary: bin, gate: "never", env: { ...process.env, AWS_ACCESS_KEY_ID: "AK", AWS_SECRET_ACCESS_KEY: "SK" }, after: join(work, "..", "earlier") }).finally(() => {
      // The next wave's job finds this one's outcome in the artifacts it downloads.
      const name = outcomeFileName(wave);
      if (existsSync(join(report, name))) writeFileSync(join(work, "..", "earlier", name), readFileSync(join(report, name)));
    });
  };
  // The directory the pipeline downloads the artifacts into.
  mkdirSync(join(work, "..", "earlier"), { recursive: true });
  return { work, log, bin, run };
}

const applied = (log: string): string[] => (existsSync(log) ? readFileSync(log, "utf-8").split("\n").filter(Boolean).map((l) => l.replace(/^applied /, "")).sort() : []);
const outcome = (work: string, wave: number) => JSON.parse(readFileSync(join(work, "..", "earlier", outcomeFileName(wave)), "utf-8"));
const waveReport = (work: string) => JSON.parse(readFileSync(join(work, "terragucci-report", "report.json"), "utf-8")).waves[0];

describe("a failed root blocks only its dependents (#1161)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("applies the other branch's next wave and blocks the failed branch's, and the run still fails with its count", async () => {
    const { work, log, run } = estate();
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await run(1)).toBe(0);
    expect(await run(2, "cluster-a")).toBe(1);
    expect(outcome(work, 2).roots).toEqual({ "cluster-a": { status: "failed" }, "cluster-b": { status: "applied" } });
    expect(await run(3)).toBe(1);
    expect(applied(log)).toEqual(["app-b", "cluster-b", "network"]);
    expect(outcome(work, 3).roots).toEqual({ "app-a": { status: "blocked", by: "cluster-a" }, "app-b": { status: "applied" } });
    const w = waveReport(work);
    expect(w.blocked).toEqual([{ root: "app-a", blocked_by: "cluster-a" }]);
    expect(w.roots).toEqual(["app-b"]);
    expect(w.state).toBe("applied");
    expect(out.mock.calls.flat().join("\n")).toContain("app-a (blocked by cluster-a)");
    expect(out.mock.calls.flat().join("\n")).toContain("wave 3 of 3: the run: 3 applied, 1 failed, 1 blocked");
  });

  it("names the original failure through a root blocked in between, and reports a wave none of whose roots ran as blocked", async () => {
    const { work, log, run } = estate();
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await run(1, "network")).toBe(1);
    expect(await run(2)).toBe(1);
    expect(outcome(work, 2).roots).toEqual({ "cluster-a": { status: "blocked", by: "network" }, "cluster-b": { status: "blocked", by: "network" } });
    expect(waveReport(work).state).toBe("blocked");
    expect(await run(3)).toBe(1);
    expect(outcome(work, 3).roots).toEqual({ "app-a": { status: "blocked", by: "network" }, "app-b": { status: "blocked", by: "network" } });
    expect(applied(log)).toEqual([]);
  });

  it("writes no blocked field and the same outcome of every root when nothing fails", async () => {
    const { work, log, run } = estate();
    vi.spyOn(console, "log").mockImplementation(() => {});
    for (const k of [1, 2, 3]) expect(await run(k)).toBe(0);
    expect(applied(log)).toEqual(LAYERS.flat().sort());
    expect(waveReport(work).blocked).toBeUndefined();
    expect(waveReport(work).state).toBe("applied");
  });
});

describe("blockedRoots, earlierRun and the run's summary", () => {
  const ups = new Map([
    ["cluster-a", new Set(["network"])],
    ["cluster-b", new Set(["network"])],
    ["app-a", new Set(["cluster-a"])],
    ["app-b", new Set(["cluster-b"])],
  ]);
  const earlier = new Set(["network", "cluster-a", "cluster-b"]);

  it("lets through a root whose upstreams applied or planned no change, and blocks one behind a failure, a wait or no outcome", () => {
    const o = new Map([
      ["network", { status: "unchanged" as const }],
      ["cluster-a", { status: "waiting" as const }],
    ]);
    expect([...blockedRoots(["app-a", "app-b"], ups, earlier, o)]).toEqual([["app-a", "cluster-a"], ["app-b", "cluster-b"]]);
    expect([...blockedRoots(["cluster-a", "cluster-b"], ups, new Set(["network"]), o)]).toEqual([]);
  });

  it("blocks every root of the wave by the gate of a wave that holds all the rest", () => {
    expect([...blockedRoots(["app-a"], ups, earlier, new Map(), 1)]).toEqual([["app-a", "wave-1"]]);
  });

  it("reads the newest outcome of a root, a re-run's over the first attempt's", () => {
    const dir = tmp("tg-outcomes-");
    writeOutcomeFile(dir, 2, {}, { "cluster-a": { status: "failed" } }, "2026-10-18T10:00:00.000Z");
    const again = tmp("tg-outcomes-");
    writeOutcomeFile(again, 2, {}, { "cluster-a": { status: "applied" } }, "2026-10-18T11:00:00.000Z");
    expect(earlierRun([dir, again], 3).roots.get("cluster-a")?.status).toBe("applied");
    expect(earlierRun([dir, again], 2).roots.size).toBe(0);
  });

  it("counts the run, and ends as waiting only when every held root waits behind an approval", () => {
    const run = new Map([
      ["network", { status: "applied" as const }],
      ["cluster-a", { status: "failed" as const }],
      ["app-a", { status: "blocked" as const, by: "cluster-a" }],
    ]);
    expect(runSummary(run.values())).toBe("1 applied, 1 failed, 1 blocked");
    expect(runSummary([{ status: "applied" }, { status: "unchanged" }])).toBeUndefined();
    expect(onlyWaiting(run)).toBe(false);
    expect(onlyWaiting(new Map([["cluster-a", { status: "waiting" as const }], ["app-a", { status: "blocked" as const, by: "cluster-a" }]]))).toBe(true);
  });
});

describe("the pipeline hands each wave's outcome to the next (#1161)", () => {
  const render = (forge: "github" | "forgejo" | "gitlab", extra: Record<string, unknown> = {}) =>
    renderPipeline({ forge, binary: "tofu", version: "1.13.1", image: "img:1", layers: LAYERS, env: {}, ...extra } as never).content;

  it("runs a later wave once the one before it applied or failed, after fetching the earlier reports", () => {
    for (const forge of ["github", "forgejo"] as const) {
      const text = render(forge);
      expect(text).toContain("needs.apply-wave-1.result == ''success'' || needs.apply-wave-1.result == ''failure''");
      expect(text).toContain("!cancelled() && (needs.apply-wave-2.result == ''success''");
      expect(text.match(/Fetch the earlier waves' outcomes/g)).toHaveLength(2);
      expect(text.match(/--after terragucci-earlier/g)).toHaveLength(3);
    }
  });

  it("leaves GitLab's waves and a Terragrunt repo's as they were", () => {
    expect(render("gitlab")).not.toContain("--after");
    expect(render("github", { terragrunt: { version: "0.99.0", parallelism: 4, exclude: [], installs: [] } })).not.toContain("--after");
  });
});
