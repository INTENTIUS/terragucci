/**
 * `terragucci approve [wave-<k>]`: approve a waiting wave from a checkout,
 * without copying its digest by hand.
 *
 * It fetches `chant/lifecycle`, finds the waves waiting (each gate's newest
 * pending fact with no approval of its digest after it), prints what the
 * chosen wave will do from the report it kept beside the ledger, and runs
 * `chant approve tf-apply wave-<k> --plan <digest>`, with `--sign` under
 * `approval: sealed`. With one wave waiting it needs no argument. It binds
 * the digest the wave planned, so it approves those plans and no others.
 * `--dry-run` prints the command and runs nothing.
 *
 * A person runs it, at a shell: chant refuses a gate approval made over MCP
 * or ACP, whatever wraps it.
 */
import { spawnSync } from "node:child_process";
import { delimiter, join } from "node:path";
import { readLedger, storedReport, waveGate, type GateLedger } from "./apply";
import { checkoutApproval } from "./approval";
import { ConfigError, findConfig, loadConfig, type Approval } from "./config";

export interface WaitingWave {
  wave: number;
  digest: string;
  since: string;
  expiresAt: string;
  description?: string;
}

const at = (iso: string): number => new Date(iso).getTime();

/** The waves waiting: each gate's newest pending fact whose digest no approval at or after it names. Lowest wave first. */
export function waitingWaves(ledger: GateLedger): WaitingWave[] {
  const newest = new Map<string, GateLedger["pending"][number]>();
  for (const p of ledger.pending) {
    const before = newest.get(p.gate);
    if (/^wave-\d+$/.test(p.gate) && p.planDigest && (!before || at(p.timestamp) >= at(before.timestamp))) newest.set(p.gate, p);
  }
  const out: WaitingWave[] = [];
  for (const [gate, p] of newest) {
    const answered = ledger.resolutions.some((r) => r.gate === gate && r.planDigest === p.planDigest && at(r.timestamp) >= at(p.timestamp));
    if (answered) continue;
    out.push({ wave: Number(gate.slice(5)), digest: p.planDigest!, since: p.timestamp, expiresAt: p.expiresAt, ...(p.description ? { description: p.description } : {}) });
  }
  return out.sort((a, b) => a.wave - b.wave);
}

/** What the wave's kept report says it will do: its roots, and every destroy and replacement by name. */
export function describeStored(text: string | undefined): string[] {
  if (!text) return ["  (the wave kept no report of its plans; read them in its job's log or report)"];
  try {
    const r = JSON.parse(text) as { roots?: { path: string }[]; named?: { root: string; address?: string; action: string }[]; totals?: Record<string, number> };
    const lines = [`  roots: ${(r.roots ?? []).map((x) => x.path).join(", ") || "none"}`];
    const named = (r.named ?? []).filter((n) => n.action === "delete" || n.action === "replace");
    for (const n of named) lines.push(`  ${n.action === "delete" ? "destroys" : "replaces"} ${n.root}${n.address ? `: ${n.address}` : ""}`);
    if (named.length === 0) lines.push("  destroys and replaces nothing");
    return lines;
  } catch {
    return ["  (the wave's kept report could not be read)"];
  }
}

export interface ApproveOptions {
  /** `wave-<k>` or `<k>`. Default: the one wave waiting. */
  wave?: string;
  /** `--sign [key]`: true for chant's own key lookup. Default: `--sign` under approval: sealed. */
  sign?: string | true;
  actor?: string;
  dryRun?: boolean;
  /** The chant executable. Default: chant from node_modules/.bin, then the path. */
  chant?: string;
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
}

/** Find the wave, say what it does, and run chant approve for its digest. Returns chant's exit code (0 for a dry run). */
export async function approve(repo: string, o: ApproveOptions = {}): Promise<{ code: number; command: string; wave: WaitingWave }> {
  const log = o.log ?? ((l: string) => console.log(l));
  const waiting = waitingWaves(readLedger(repo));
  let chosen: WaitingWave | undefined;
  if (o.wave !== undefined) {
    const k = Number(/^(?:wave-)?(\d+)$/.exec(o.wave)?.[1]);
    if (!Number.isInteger(k) || k < 1) throw new ConfigError(`approve takes a wave as wave-<k> or <k>, not ${JSON.stringify(o.wave)}`);
    chosen = waiting.find((w) => w.wave === k);
    if (!chosen) throw new ConfigError(`${waveGate(k)} is not waiting${waiting.length ? `; waiting: ${waiting.map((w) => waveGate(w.wave)).join(", ")}` : ": no wave waits for an approval"}`);
  } else if (waiting.length === 1) {
    chosen = waiting[0];
  } else if (waiting.length === 0) {
    throw new ConfigError("no wave waits for an approval on chant/lifecycle");
  } else {
    throw new ConfigError(`${waiting.length} waves wait (${waiting.map((w) => waveGate(w.wave)).join(", ")}); name one: terragucci approve wave-<k>`);
  }
  const wave = chosen!;
  const configPath = findConfig(repo);
  const mode: Approval = checkoutApproval(repo, configPath ? await loadConfig(configPath) : {})?.mode ?? "ledger";
  log(`${waveGate(wave.wave)} waits for an approval of ${wave.digest}${wave.description ? ` (${wave.description})` : ""}, since ${wave.since}`);
  for (const l of describeStored(storedReport(repo, wave.wave, wave.digest))) log(l);
  if (at(wave.expiresAt) < Date.now()) log(`  its pending fact expired at ${wave.expiresAt}; the approval still counts if the next run plans the same digest`);
  const sign = o.sign ?? (mode === "sealed" ? true : undefined);
  const args = ["approve", "tf-apply", waveGate(wave.wave), "--plan", wave.digest, ...(o.actor ? ["--actor", o.actor] : []), ...(sign === undefined ? [] : sign === true ? ["--sign"] : ["--sign", sign])];
  const command = `chant ${args.join(" ")}`;
  if (o.dryRun) {
    log(`would run: ${command}`);
    return { code: 0, command, wave };
  }
  log(`running: ${command}`);
  const env = o.env ?? process.env;
  const chant = o.chant ?? "chant";
  const r = spawnSync(chant, args, { cwd: repo, stdio: "inherit", env: { ...env, PATH: [join(repo, "node_modules", ".bin"), env.PATH ?? ""].join(delimiter) } });
  if (r.error) throw new ConfigError(`could not run chant (${r.error.message}); install it with npm i -D @intentius/chant, or run: ${command}`);
  if (r.status === 0) log(`approved ${waveGate(wave.wave)}; run its job again, or comment /terragucci apply, and it applies these plans`);
  return { code: r.status ?? 1, command, wave };
}
