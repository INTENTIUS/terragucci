/**
 * `stage tf-apply` on chant's op waves (terragucci#879): every wave runs
 * through `chant run wave`, the chant bin terragucci installs with itself.
 *
 * The wave's job renders an op-waves spec from what it was given and what
 * terragucci.yml says at base (the waves, the gate, the approval mode), and
 * a commit that is the base commit plus that spec, which chant reads the
 * policy and the hooks from (`--base`). The spec's `planWave`, `applyWave`
 * and hooks call back into the job's own process over a local socket, so
 * the planning, the holds, the progress and the report stay terragucci's and
 * keep their state between the calls. chant decides the gate, records the
 * pending fact, spends the approval and the policy overrides, and settles a
 * state migration's own gate.
 *
 * chant's exit codes map onto terragucci's (waveExit): an approval of other
 * plans leaves chant waiting where terragucci refuses (4), and chant's policy
 * refusal (7) is terragucci's 1, or 4 when an override stands for an earlier
 * plan.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import type { OpWave, OpWaveDecision, OpWaveHook, OpWavesSpec, RunOpWaveResult } from "@intentius/chant/op";
import { chantCommand } from "./chant-bin";
import { ConfigError } from "./config";

/** The op, and the spec's name: the waves' gates stay `tf-apply` / `wave-<k>`. */
export const WAVES_OP = "tf-apply";
/** Where the job writes the spec, and where the base commit chant reads it at holds it. */
export const WAVES_SPEC = `.chant/op-waves/${WAVES_OP}.spec.json`;
/** chant's decision record of wave `k`. */
export const waveRecordPath = (k: number): string => `.chant/op-waves/${WAVES_OP}/wave-${k}.json`;
/** The wave's name in the spec. */
export const waveName = (k: number): string => `wave-${k}`;

/** The calls chant makes back into the wave's process. */
export type WaveCall = "plan" | "apply" | "migrate-check" | "migrate" | "hold" | "gate";

export interface WavesSpecInput {
  /** Plain roots: each wave's roots. A Terragrunt repo: how many waves the pipeline has jobs for. */
  waves: string[][] | number;
  /** Terragrunt only: the last wave goes on through the waves `terragrunt find` gives. */
  rest?: boolean;
  gate: "always" | "on-destructive" | "never";
  /** The approval mode at base. Under `pr-review` the plan call records the review's approval, and chant counts the ledger. */
  approval: "ledger" | "pr-review" | "sealed";
  /** `waves.jobs` on wave `wave`. */
  shares?: { wave: number; shares: number };
  /** The argv that calls back into the wave's process with one call. */
  call: (what: WaveCall, ...args: string[]) => string[];
  /** Wave 1 runs the repo's state migrations first. */
  migrations: boolean;
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
      gate: input.gate,
      approval: input.approval === "sealed" ? "sealed" : "ledger",
      ...(input.shares?.wave === k ? { shares: input.shares.shares } : {}),
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
 * a migration that failed), which a non-zero exit takes.
 */
export function waveExit(chant: number, own?: number): number {
  if (chant === 0) return 0;
  if (own !== undefined && own !== 0) return own;
  if (chant === 7) return 1;
  return chant;
}

/**
 * The client chant runs for each call, from the job's directory: it hands
 * the call, its working directory and chant's variables to the wave's
 * process, at the socket WAVE_SOCKET names, and exits with the code that
 * process gives. The hooks chant reads at base, and a share job runs from
 * its wave's decision, name it at this fixed path, so every job runs the same
 * command whatever its own socket.
 */
export const WAVE_CLIENT = `.chant/op-waves/${WAVES_OP}/terragucci-call.cjs`;
/** The file that names the socket of this job's wave process. */
export const WAVE_SOCKET = `.chant/op-waves/${WAVES_OP}/terragucci-socket`;

/** The argv chant runs for one call back into the wave's process. */
export const waveCallArgv = (what: WaveCall, ...args: string[]): string[] => ["node", WAVE_CLIENT, what, ...args];

export const CLIENT_JS = `"use strict";
const fs = require("node:fs");
const net = require("node:net");
const args = process.argv.slice(2);
let sock;
try {
  sock = fs.readFileSync(${JSON.stringify(WAVE_SOCKET)}, "utf-8").trim();
} catch (e) {
  console.error("terragucci: no wave process to call (" + e.message + ")");
  process.exit(1);
}
const env = {};
for (const [k, v] of Object.entries(process.env)) if (k.startsWith("CHANT_")) env[k] = v;
const c = net.connect(sock, () => c.write(JSON.stringify({ args, env, cwd: process.cwd() }) + "\\n"));
let buf = "";
let code;
c.on("data", (d) => {
  buf += d;
  const i = buf.indexOf("\\n");
  if (i >= 0 && code === undefined) { code = JSON.parse(buf.slice(0, i)).code; c.end(); }
});
c.on("error", (e) => { console.error("terragucci: the wave's process cannot be reached: " + e.message); process.exit(1); });
c.on("close", () => process.exit(code === undefined ? 1 : code));
`;

export interface WaveRequest {
  args: string[];
  /** chant's variables for the call: CHANT_GATE_STATUS, CHANT_HOLD, CHANT_APPLY_OUTCOME and the rest. */
  env: Record<string, string>;
  cwd: string;
}

/** Serve the calls on a socket in `dir`, with the client and the socket's name in the checkout `repo`; `close` stops. */
export async function serveWave(repo: string, dir: string, handle: (r: WaveRequest) => Promise<number>): Promise<{ close: () => Promise<void> }> {
  const sock = join(dir, "s");
  mkdirSync(dirname(join(repo, WAVE_CLIENT)), { recursive: true });
  writeFileSync(join(repo, WAVE_CLIENT), CLIENT_JS);
  writeFileSync(join(repo, WAVE_SOCKET), sock + "\n");
  const server: Server = createServer((conn) => {
    let buf = "";
    let started = false;
    conn.on("data", (d) => {
      buf += d;
      const i = buf.indexOf("\n");
      if (i < 0 || started) return;
      started = true;
      let req: WaveRequest;
      try {
        req = JSON.parse(buf.slice(0, i)) as WaveRequest;
      } catch {
        conn.end(JSON.stringify({ code: 1 }) + "\n");
        return;
      }
      handle(req).then(
        (code) => conn.end(JSON.stringify({ code }) + "\n"),
        (e) => {
          console.log(`terragucci: ${(e as Error).message}`);
          conn.end(JSON.stringify({ code: 1 }) + "\n");
        },
      );
    });
    conn.on("error", () => {});
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(sock, () => resolve());
  });
  return { close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

/**
 * Run `chant run wave` for wave `k` and read its result. chant's log goes to
 * the job's, as the waves' own lines do; its `--json` result is read from its
 * standard output.
 */
export function runChantWave(
  repo: string,
  o: { wave: number; base: string; decide?: boolean; share?: number; env: NodeJS.ProcessEnv; chant?: string },
): Promise<{ code: number; result?: RunOpWaveResult }> {
  const args = ["run", "wave", "--spec", WAVES_SPEC, "--wave", String(o.wave), "--base", o.base, "--json", ...(o.decide ? ["--decide"] : []), ...(o.share !== undefined ? ["--share", String(o.share)] : [])];
  const env = { ...o.env, PATH: [join(repo, "node_modules", ".bin"), o.env.PATH ?? ""].join(delimiter) };
  return new Promise((resolve) => {
    const child = spawn(chantCommand(repo, o.chant ? { chant: o.chant } : {}), args, { cwd: repo, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    // chant's log is the wave's: each line goes where terragucci's own lines go.
    let err = "";
    child.stderr.on("data", (d) => {
      err += d;
      const lines = err.split("\n");
      err = lines.pop() ?? "";
      for (const line of lines) console.log(line);
    });
    child.stderr.on("end", () => {
      if (err) console.log(err);
    });
    child.on("error", (e) => {
      console.log(`chant run wave did not start (${e.message}): the @intentius/chant package that @intentius/terragucci installs with itself is missing; install terragucci again`);
      resolve({ code: 1 });
    });
    child.on("close", (code) => {
      let result: RunOpWaveResult | undefined;
      try {
        result = out.trim() ? (JSON.parse(out) as RunOpWaveResult) : undefined;
      } catch {
        if (out.trim()) process.stdout.write(out);
      }
      resolve({ code: code ?? 1, ...(result ? { result } : {}) });
    });
  });
}

/** Write the spec to the checkout, where chant reads its commands. */
export function writeSpec(repo: string, spec: OpWavesSpec): string {
  const text = JSON.stringify(spec, null, 2) + "\n";
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
