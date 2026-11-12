/**
 * `stage tf-apply` on chant's op waves (terragucci#879): every wave runs
 * through `chant run wave`, the chant bin terragucci installs with itself.
 *
 * The wave's job renders an op-waves spec from what it was given and what
 * terragucci.yml says at base (the waves, the gate, the approval mode), and
 * a commit that is the base commit plus that spec, which chant reads the
 * policy and the hooks from (`--base`). The spec's hooks name a command, and
 * chant calls the job's own process in its place by the hook's name
 * (`inProcessHooks`, chant issue 4994), so the migrations, the progress and
 * the report stay terragucci's and keep their state between the calls. chant
 * decides the gate, records the pending fact, spends the approval and the
 * policy overrides, records the rest of a stopped apply (chant issue 5047),
 * and settles a state migration's own gate.
 *
 * chant's exit code passes through as it is (chant's one table, chant#4553):
 * 0 done, 1 failed, 2 drift, 3 waiting, 4 moved, 5 held, 6 superseded,
 * 7 denied and 8 declined. A code terragucci's own calls came to for the wave
 * takes a non-zero exit (waveExit).
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { OpWave, OpWaveDecision, OpWaveHook, OpWavesSpec } from "@intentius/chant/op";
import type { GateQuorumRule } from "@intentius/chant/gate-decision";
import { ConfigError } from "./config";

/** The op, and the spec's name: the waves' gates stay `tf-apply` / `wave-<k>`. */
export const WAVES_OP = "tf-apply";
/** Where the job writes the spec, and where the base commit chant reads it at holds it. */
export const WAVES_SPEC = `.chant/op-waves/${WAVES_OP}.spec.json`;
/** chant's decision record of wave `k`. */
export const waveRecordPath = (k: number): string => `.chant/op-waves/${WAVES_OP}/wave-${k}.json`;
/** The wave's name in the spec. */
export const waveName = (k: number): string => `wave-${k}`;

/**
 * The spend rules every spec terragucci hands chant carries (chant issue
 * 5047): an approval is spent as its wave applies, the applied line names the
 * changes so the rest of a stopped apply applies under the same approval at
 * the same commit, and a wave its gate lets through spends an approval of its
 * digest that stands.
 */
export const WAVES_APPROVALS = { spend: true, remainder: true, spendStanding: true } as const;

/** The calls chant makes back into the wave's process. */
export type WaveCall = "plan" | "apply" | "migrate-check" | "migrate" | "hold" | "gate";

export interface WavesSpecInput {
  /** Plain roots: each wave's roots. A Terragrunt repo: how many waves the pipeline has jobs for. */
  waves: string[][] | number;
  /** Terragrunt only: the last wave goes on through the waves `terragrunt find` gives. */
  rest?: boolean;
  gate: "always" | "on-destructive" | "never";
  /** Plain roots with `environments` at base: each wave's gate, by wave number from 1, in place of `gate` (the strictest of its roots', ./environments.ts). */
  gates?: ("always" | "on-destructive" | "never")[];
  /** The approval mode at base. Under `pr-review` the plan call records the review's approval, and chant counts the ledger. */
  approval: "ledger" | "pr-review" | "sealed";
  /** `waves.jobs` on wave `wave`. */
  shares?: { wave: number; shares: number };
  /** One apply job per identity (./cloud-identity.ts): wave `wave`'s job groups, each with the wave's roots it holds and, with `waves.jobs`, its shares. */
  jobs?: { wave: number; groups: { name: string; runs: string[]; shares?: number }[] };
  /** The argv that calls back into the wave's process with one call. */
  call: (what: WaveCall, ...args: string[]) => string[];
  /** Wave 1 runs the repo's state migrations first. */
  migrations: boolean;
  /** `apply.point` at base: every wave's gate asks this decision point in place of the ledger (chant#3836). */
  point?: string;
}

/** The op-waves spec of a repo's apply. */
export function wavesSpec(input: WavesSpecInput): OpWavesSpec {
  const count = typeof input.waves === "number" ? input.waves : input.waves.length;
  const hook = (name: string, what: WaveCall, onFailure: "fail" | "approve" = "fail"): OpWaveHook => ({ name, command: input.call(what, "{runs}"), ...(onFailure === "approve" ? { onFailure } : {}) });
  const waves: OpWave[] = [];
  for (let k = 1; k <= count; k++) {
    const runs = typeof input.waves === "number" ? [] : input.waves[k - 1]!.map((target) => ({ target }));
    const discover = typeof input.waves === "number";
    waves.push({
      name: waveName(k),
      runs,
      ...(discover ? { discover: true } : {}),
      ...(discover && input.rest && k === count ? { rest: true } : {}),
      gate: input.gates?.[k - 1] ?? input.gate,
      approval: input.approval === "sealed" ? "sealed" : "ledger",
      ...(input.shares?.wave === k ? { shares: input.shares.shares } : {}),
      // A deciding job plans every run and decides the gate; each group's job applies its runs (chant#3914).
      ...(input.jobs?.wave === k ? { jobs: input.jobs.groups.map((g) => ({ name: g.name, runs: g.runs, ...(g.shares !== undefined && g.shares > 1 ? { shares: g.shares } : {}) })) } : {}),
      // A state migration in the change runs before wave 1 plans, behind its own gate: proved first, then held on that gate.
      ...(k === 1 && input.migrations ? { hooks: { before: { plan: [hook("migrations", "migrate-check"), hook("migration gate", "migrate", "approve")] } } } : {}),
    });
  }
  return {
    name: WAVES_OP,
    op: WAVES_OP,
    gateName: "wave-{k}",
    digest: { over: "changing" },
    neverOverMcp: true,
    approvals: { spend: true },
    // The question goes to chant/lifecycle, so it outlives the job's checkout, and its pending fact stands 48 hours.
    ...(input.point ? { point: { name: input.point, store: "ledger", timeout: "48h" } } : {}),
    planWave: input.call("plan", "{runs}", "{plans}"),
    applyWave: input.call("apply", "{runs}"),
    hooks: {
      after: {
        // A step with on_failure: approve, or a change over cost.approve_above, holds the wave whatever its gate.
        plan: [hook("held", "hold", "approve")],
        gate: [hook("report", "gate")],
      },
    },
    waves,
  } as OpWavesSpec;
}

/** What a wave spec on chant's step contract adds to {@link WavesSpecInput} (chant#4545). */
export interface WavesStepInput extends WavesSpecInput {
  /**
   * A Terragrunt repo's step (chant#4848): every wave finds its units when it
   * plans and plans them together with one `run --all`, through the terraform
   * lexicon's `terragrunt-apply`. `layers` are the pipeline's waves, each cut
   * again by Terragrunt's graph.
   */
  terragrunt?: { layers: string[][]; exclude?: string[]; binary: string; terragrunt: string; parallelism?: number };
  /** `waves.compose`: the wave, by number from 1, whose roots plan and apply together as one composed run through `terraform-apply`'s group methods (chant#4848). */
  together?: number;
  /** Vars each root reads from another root's outputs (Atmos's `!terraform.state`), as the terraform lexicon's `reads`, each with the upstream's directory and workspace (chant#4858). */
  reads?: Record<string, { var: string; root: string; output: string[]; dir?: string; workspace?: string }[]>;
  /** The workspace each root that names one plans and applies in (an Atmos instance's), created after an init in default (chant#4855). */
  workspaces?: Record<string, string>;
  /** Who counts at the gate (chant#4859): the pull request's review lines on terragucci's own ledger, the involved people left out, and `approval_rules`. */
  approvals?: { reviewLedger?: string; involved?: { agents?: string[]; exclude: true }; quorum?: GateQuorumRule[] };
  /** A pull request's base, for a choudoufu live root's cone plan. */
  cone?: string;
  /** How long a plan or an apply waits for a state lock. Default: the lexicon's 5m. */
  lockTimeout?: string | false;
  /** `cost.approve_above` at base, as chant's cost hold (the terraform lexicon's infracost preset reads the plan JSON). */
  approveAbove?: number;
  /** `policy` at base is on: chant runs the workspace's ci.policy at base over each run's change set. */
  policy?: boolean;
  /** `--stand-down`: a wave whose roots a newer push on the branch also applies stands down with 6 (chant#4581). */
  standDown?: boolean;
  /** How many of a wave's roots chant's step plans and applies at once, their inits one at a time on the wave's provider cache (chant#4864). Over 1 only; a Terragrunt step carries its own. */
  parallelism?: number;
}

/**
 * The op-waves spec of a repo's apply on chant's step contract (chant#4545):
 * each run plans and applies through the terraform lexicon's
 * `terraform-apply` capability, with no `plan` or `apply` call back into
 * terragucci. The holds terragucci's `held` hook served become chant's
 * `holds` (policy and cost, read at base). A state migration and the gate's
 * report stay hooks that call back into the wave's process, as #4545's
 * comment rules. The op, the gate names and the approval stay
 * `tf-apply` / `wave-<k>`, so the approvals on the ledger keep counting.
 */
export function wavesStepSpec(input: WavesStepInput): OpWavesSpec {
  const own = wavesSpec(input) as OpWavesSpec & { planWave?: unknown; applyWave?: unknown; hooks?: { after?: { plan?: unknown; gate?: unknown } } };
  const { planWave: _p, applyWave: _a, hooks, ...rest } = own;
  const runInput = (root: string): Record<string, unknown> | undefined => {
    const i = { ...(input.reads?.[root]?.length ? { reads: input.reads[root] } : {}), ...(input.workspaces?.[root] ? { workspace: input.workspaces[root] } : {}) };
    return Object.keys(i).length ? i : undefined;
  };
  // approval pr-review is chant's own mode on the step: it counts the review lines terragucci records on tf-apply (chant#4859).
  const approval = input.approval === "pr-review" ? "pr-review" : undefined;
  return {
    ...rest,
    // chant records each change an approved apply makes and takes up the rest of a stopped one, and spends an approval a let-through wave leaves standing (chant issue 5047).
    approvals: { ...WAVES_APPROVALS, ...(input.approvals ?? {}) },
    // At spec level only: a together wave refuses a wave-level parallelism over 1.
    ...(!input.terragrunt && input.parallelism !== undefined && input.parallelism > 1 ? { parallelism: input.parallelism } : {}),
    step: input.terragrunt
      ? {
          kind: "terragrunt-apply",
          // Terragrunt runs in the wave's directory (chant#4856).
          unit: "{target}",
          layers: input.terragrunt.layers,
          ...(input.terragrunt.exclude?.length ? { exclude: input.terragrunt.exclude } : {}),
          binary: input.terragrunt.binary,
          terragrunt: input.terragrunt.terragrunt,
          ...(input.terragrunt.parallelism !== undefined ? { parallelism: input.terragrunt.parallelism } : {}),
        }
      : {
          kind: "terraform-apply",
          root: "{target}",
          // A root with no terraform.roots entry plans its own directory (chant#4842).
          dir: "{target}",
          ...(input.lockTimeout !== undefined ? { lockTimeout: input.lockTimeout } : {}),
          ...(input.cone ? { cone: input.cone } : {}),
        },
    ...(input.policy || input.approveAbove !== undefined
      ? { holds: { ...(input.policy ? { policy: true } : {}), ...(input.approveAbove !== undefined ? { cost: { command: ["infracost", "breakdown", "--path", "{planJson}", "--format", "json"], approveAbove: input.approveAbove, format: "infracost" } } : {}) } }
      : {}),
    // chant stands the wave down before it spends the approval, when the installed chant has the stand-down (chant#4581).
    ...(input.standDown ? { standDown: true } : {}),
    // The gate's report is terragucci's; the held hook is chant's holds now.
    hooks: { after: { gate: hooks?.after?.gate } },
    // A Terragrunt wave plans its units as one run --all, as a layer of the graph runs.
    waves: rest.waves.map((w, i) => ({ ...w, ...(approval ? { approval } : {}), ...(input.terragrunt || input.together === i + 1 ? { together: true } : {}), runs: (w.runs ?? []).map((r) => { const i = runInput(r.target); return i ? { ...r, input: i } : r; }) })),
  } as OpWavesSpec;
}

const GIT_ID = { GIT_AUTHOR_NAME: "terragucci", GIT_AUTHOR_EMAIL: "terragucci@localhost", GIT_COMMITTER_NAME: "terragucci", GIT_COMMITTER_EMAIL: "terragucci@localhost" };

/**
 * A commit whose tree is `base`'s with the spec at WAVES_SPEC, for chant to
 * read the gate policy and the hooks at: the rules terragucci read at base,
 * and everything else at base (the signers, the overriders) as it is there.
 */
export function specAtBase(repo: string, base: string, spec: string): string {
  const g = (args: string[], input?: string, env: NodeJS.ProcessEnv = process.env) => spawnSync("git", args, { cwd: repo, encoding: "utf-8", input, env });
  const sha = g(["rev-parse", "--verify", `${base}^{commit}`]).stdout.trim();
  if (!sha) throw new ConfigError(`the wave's rules are read at ${base}, which this checkout does not have`);
  const blob = g(["hash-object", "-w", "--stdin"], spec).stdout.trim();
  const scratch = mkdtempSync(join(tmpdir(), "terragucci-base-"));
  try {
    const env = { ...process.env, ...GIT_ID, GIT_INDEX_FILE: join(scratch, "index") };
    g(["read-tree", sha], undefined, env);
    g(["update-index", "--add", "--cacheinfo", `100644,${blob},${WAVES_SPEC}`], undefined, env);
    const tree = g(["write-tree"], undefined, env).stdout.trim();
    const commit = g(["commit-tree", tree, "-p", sha, "-m", `terragucci: the waves' rules at ${sha.slice(0, 12)}`], undefined, { ...env, GIT_AUTHOR_DATE: "1970-01-01T00:00:00Z", GIT_COMMITTER_DATE: "1970-01-01T00:00:00Z" }).stdout.trim();
    if (!commit) throw new ConfigError(`could not write the waves' rules at ${base}`);
    return commit;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** chant's decision record of wave `k`, or undefined when chant wrote none. */
export function readWaveRecord(repo: string, k: number): OpWaveDecision | undefined {
  try {
    return JSON.parse(readFileSync(join(repo, waveRecordPath(k)), "utf-8")) as OpWaveDecision;
  } catch {
    return undefined;
  }
}

/**
 * terragucci's exit code for chant's. `own` is the code terragucci's own
 * calls came to for the wave (a refusal it reported after the gate, a plan or
 * a migration that failed), which a non-zero exit takes. Otherwise chant's
 * code passes through, so a denial stays 7 and a declined point 8.
 */
export function waveExit(chant: number, own?: number): number {
  if (chant === 0) return 0;
  if (own !== undefined && own !== 0) return own;
  return chant;
}

/**
 * The command the spec's hooks name. chant never runs it: every job that
 * runs a hook (`stage tf-apply`, `terragucci run wave`) hands chant the hook
 * by its name in its own process (`inProcessHooks`, chant issue 4994), and
 * chant calls that in place of the command. The path stays as it is because
 * the specs committed with a repo carry this argv, and the rules at base are
 * read from them.
 */
export const WAVE_CLIENT = `.chant/op-waves/${WAVES_OP}/terragucci-call.cjs`;

/** The argv a spec hook names for one call into the wave's process. */
export const waveCallArgv = (what: WaveCall, ...args: string[]): string[] => ["node", WAVE_CLIENT, what, ...args];

/** One call of a spec hook, as the wave's process serves it. */
export interface WaveRequest {
  args: string[];
  /** chant's variables for the call: CHANT_GATE_STATUS, CHANT_HOLD, CHANT_APPLY_OUTCOME and the rest. */
  env: Record<string, string>;
  cwd: string;
}

/** The spec's text, as writeSpec writes it and init commits it. */
export const wavesSpecText = (spec: OpWavesSpec): string => JSON.stringify(spec, null, 2) + "\n";

/**
 * The spec committed at `base` (terragucci init writes it once, terragucci#1303), or
 * undefined when that commit has none. A job whose own spec reads the same
 * hands chant `base` as it is; one whose spec differs (a gate per
 * environment, a share count, a config changed since init) still gets a
 * commit with its own spec on top (specAtBase).
 */
export function committedSpecAt(repo: string, base: string): string | undefined {
  const r = spawnSync("git", ["show", `${base}:${WAVES_SPEC}`], { cwd: repo, encoding: "utf-8" });
  return r.status === 0 ? r.stdout : undefined;
}

/** Write the spec to the checkout, where chant reads its commands. */
export function writeSpec(repo: string, spec: OpWavesSpec): string {
  const text = wavesSpecText(spec);
  const path = join(repo, WAVES_SPEC);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return text;
}

/** A file chant wrote for a call, by the path it gave, relative to the job's directory. */
export function readCallFile<T>(cwd: string, path: string | undefined): T | undefined {
  if (!path) return undefined;
  const at = path.startsWith("/") ? path : join(cwd, path);
  if (!existsSync(at)) return undefined;
  try {
    return JSON.parse(readFileSync(at, "utf-8")) as T;
  } catch {
    return undefined;
  }
}
