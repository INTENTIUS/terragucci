/**
 * `terragucci run wave ...`: the line each job of chant's Op waves pipeline
 * runs through terragucci's bin (`bin: "terragucci"` on the generator).
 *
 * The line is chant's `run wave` as it is, run in this process with
 * terragucci's words (`runChantInProcess`). A wave job's line (`--spec` and
 * `--wave`, with `--phase` in a split wave) also hands chant terragucci's
 * wave hook (runWaveJob in ./apply.ts), so the wave plans and applies each
 * root as `stage tf-apply` did. Under `--render-spec` with
 * `CHANT_WAVES_SPEC_RUNS=head` (chant issue 5046) the job's spec is the one
 * `terragucci waves-spec` renders at HEAD with the base, as chant renders
 * it, and the wave takes what the change reaches with it: the composed run,
 * and the roots a pending estate migration plans. The lines that run no wave job (`--merge`,
 * `--apply-status`, `--waves-outcome`, `--record-plans`, `--approval-status`)
 * and a split wave's record job take the words alone.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { OpWavesSpec, ProductWaveHook } from "@intentius/chant/op";
import { runWaveJob, type RunWaveJob } from "./apply";
import { TERRAGUCCI_WORDS } from "./ci-words";
import { SPEC_RUNS_ENV, wavesSpecAt, wavesSpecReach } from "./waves-spec";

/** The flags of chant's `run wave` lines that run no wave job. */
const NO_WAVE_JOB = ["--merge", "--apply-status", "--waves-outcome", "--record-plans", "--approval-status"];

/** A flag's value in chant's argv: `--name value` or `--name=value`. */
export function flagValue(argv: readonly string[], name: string): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === name) return argv[i + 1];
    if (a.startsWith(`${name}=`)) return a.slice(name.length + 1);
  }
  return undefined;
}

const whole = (v: string | undefined): number | undefined => (v !== undefined && /^[1-9][0-9]*$/.test(v) ? Number(v) : undefined);

export interface RunWaveOptions extends Omit<RunWaveJob, "wave" | "spec" | "phase" | "share" | "group" | "base" | "composition" | "migrationMembers" | "nothing"> {
  /** chant's `run wave` in this process. Default: `runChantInProcess(["run", "wave", ...argv], TERRAGUCCI_WORDS, { wave })`. */
  chant?: (argv: string[], hook: ProductWaveHook | undefined) => Promise<number>;
}

/** `terragucci run wave <chant's argv>`. Returns chant's exit code, or terragucci's own for a wave it refused. */
export async function runWave(repo: string, argv: string[], o: RunWaveOptions = {}): Promise<number> {
  const chant = o.chant ?? (async (a: string[], hook: ProductWaveHook | undefined) => (await import("@intentius/chant/ci-product")).runChantInProcess(["run", "wave", ...a], TERRAGUCCI_WORDS, hook ? { wave: hook } : {}));
  const plain = () => chant(argv, undefined);
  if (argv.some((a) => NO_WAVE_JOB.includes(a.split("=")[0]!))) return plain();
  const specFile = flagValue(argv, "--spec");
  const wave = whole(flagValue(argv, "--wave"));
  // chant says what such a line lacks.
  if (!specFile || wave === undefined) return plain();
  const phase = flagValue(argv, "--phase");
  // A record job writes chant's run records and plans nothing: it takes terragucci's words alone.
  if (phase === "record" || (phase !== undefined && !["plan", "gate", "apply"].includes(phase))) return plain();
  const base = flagValue(argv, "--base");
  const env = o.env ?? process.env;
  // The spec this job runs. With --render-spec, chant renders it through `terragucci waves-spec` at base, as this does;
  // with CHANT_WAVES_SPEC_RUNS=head at the applied commit with the base beside it (chant issue 5046), and the
  // job's wave takes what the change reaches: its composed run, and the roots a pending estate migration plans.
  let spec: OpWavesSpec | undefined;
  let reach: Pick<RunWaveJob, "composition" | "migrationMembers" | "nothing"> = {};
  if (argv.includes("--render-spec")) {
    const runsAtHead = env[SPEC_RUNS_ENV] === "head" && phase !== "gate" && phase !== "record";
    const at = { specFile, ...(o.config ? { config: o.config } : {}), env, ...(o.fetch ? { fetch: o.fetch } : {}) };
    if (runsAtHead) {
      const baseSha = spawnSync("git", ["rev-parse", "--verify", "--quiet", `${base ?? "HEAD^1"}^{commit}`], { cwd: repo, encoding: "utf-8" }).stdout.trim();
      const rendered = await wavesSpecReach(repo, { ...at, at: "HEAD", ...(baseSha ? { base: baseSha } : {}) });
      spec = rendered?.spec;
      if (rendered) {
        const members = rendered.migrationMembers.get(wave);
        const nothing = rendered.nothing.get(wave);
        reach = { ...(rendered.composition ? { composition: rendered.composition } : {}), ...(members?.length ? { migrationMembers: members } : {}), ...(nothing ? { nothing } : {}) };
      }
    } else {
      spec = await wavesSpecAt(repo, { ...at, at: base ?? "HEAD^1" });
    }
  } else {
    try {
      spec = JSON.parse(readFileSync(isAbsolute(specFile) ? specFile : join(repo, specFile), "utf-8")) as OpWavesSpec;
    } catch {
      spec = undefined;
    }
  }
  // chant says why it has no spec to run.
  if (!spec || !Array.isArray(spec.waves)) return plain();
  const share = whole(flagValue(argv, "--share"));
  const group = flagValue(argv, "--group");
  const { chant: _chant, ...rest } = o;
  return runWaveJob(repo, {
    ...rest,
    ...reach,
    wave,
    spec,
    env,
    ...(phase ? { phase: phase as RunWaveJob["phase"] } : {}),
    ...(share !== undefined ? { share } : {}),
    ...(group !== undefined ? { group } : {}),
    ...(base !== undefined ? { base } : {}),
  }, (hook) => chant(argv, hook));
}
