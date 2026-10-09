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
 * `--plan <digest>` pins the digest a person read (in a chat message, a plan
 * note or a report): approve runs only when a wave waits for exactly that
 * digest, and otherwise exits 1 naming the digest waiting, so plans that
 * moved since are never approved in their place. `--dry-run` prints the
 * command and runs nothing.
 *
 * `terragucci override <root> --rule <id>... --reason <text>` does the same
 * for a root the policy denied in a `tf-apply` wave (./override.ts): it finds
 * the denial the wave recorded, checks the rules named are exactly the rules
 * that denied the plan, and runs `chant approve policy-override <root> --plan
 * <digest> --note <reason>`, with `--sign` under `approval: sealed`.
 *
 * `terragucci approve <migration>` approves a state migration that wave 1
 * waits on (./migrate.ts): `chant approve tf-migrate <name> --plan <digest>`,
 * with what the migration moves from the plan record it kept. With one gate
 * waiting, wave or migration, it needs no argument, and `--plan` finds a
 * migration by its digest as it finds a wave. Then it resumes wave 1.
 *
 * A person runs either, at a shell: chant refuses a gate approval made over
 * MCP or ACP, whatever wraps it.
 */
import { spawnSync } from "node:child_process";
import { delimiter, join } from "node:path";
import { samePlanDigest } from "@intentius/chant/lifecycle/plan-digest";
import { readLedger, storedReport, waveGate, type GateLedger } from "./apply";
import { OVERRIDE_LEDGER, OVERRIDE_OP, recordedDenials, sortedRules } from "./override";
import { checkoutApproval } from "./approval";
import { ConfigError, findConfig, loadConfig, type Approval } from "./config";
import type { Fetch } from "./forge";
import { originOf, resumeAfterApproval } from "./resume";
import { keptPath, MIGRATE_LEDGER, MIGRATE_OP } from "./migrate";

export interface WaitingWave {
  wave: number;
  digest: string;
  since: string;
  expiresAt: string;
  description?: string;
  /** The run or pipeline that waited, and the commit it planned, when the pending fact names them. */
  runId?: string;
  commit?: string;
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
    out.push({ wave: Number(gate.slice(5)), digest: p.planDigest!, since: p.timestamp, expiresAt: p.expiresAt, ...(p.description ? { description: p.description } : {}), ...(p.runId ? { runId: p.runId } : {}), ...(p.commit ? { commit: p.commit } : {}) });
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
  /** `wave-<k>` or `<k>`. Default: the one wave waiting, or with `plan` the one waiting for that digest. */
  wave?: string;
  /** `--plan <digest>`: approve only a wave waiting for this digest. */
  plan?: string;
  /** `--sign [key]`: true for chant's own key lookup. Default: `--sign` under approval: sealed. */
  sign?: string | true;
  actor?: string;
  dryRun?: boolean;
  /** The chant executable. Default: chant from node_modules/.bin, then the path. */
  chant?: string;
  /** `--no-resume`: approve only, and leave the wave to the resume job or a re-run. Default: resume it with the approver's token. */
  resume?: boolean;
  /** The forge calls of the resume. Default: fetch. */
  fetch?: Fetch;
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
}

/**
 * Find the wave, say what it does, and run chant approve for its digest.
 * Returns chant's exit code (0 for a dry run), or 1 with no command when
 * `plan` names a digest no wave waits for.
 */
export async function approve(repo: string, o: ApproveOptions = {}): Promise<{ code: number; command: string; wave?: WaitingWave; migration?: WaitingMigration }> {
  const log = o.log ?? ((l: string) => console.log(l));
  const waiting = waitingWaves(readLedger(repo));
  // A state migration waits inside wave 1 on a gate of its own; it is approved the same way, by name or by digest.
  const migrations = waitingMigrations(readLedger(repo, MIGRATE_LEDGER));
  const named = o.wave !== undefined && !/^(?:wave-)?\d+$/.test(o.wave) ? o.wave : undefined;
  if (named !== undefined) {
    const m = migrations.find((x) => x.migration === named);
    if (!m) throw new ConfigError(`no migration ${named} waits for an approval${migrations.length ? `; waiting: ${migrations.map((x) => x.migration).join(", ")}` : ""}`);
    if (o.plan !== undefined && !samePlanDigest(m.digest, o.plan.trim())) {
      log(`not approved: migration ${named} waits for ${m.digest}, not ${o.plan.trim()}. The states moved since that digest; read the new proof, then approve its digest`);
      return { code: 1, command: "" };
    }
    return approveMigration(repo, m, o, log);
  }
  if (o.plan !== undefined && o.wave === undefined) {
    const m = migrations.find((x) => samePlanDigest(x.digest, o.plan!.trim()));
    if (m) return approveMigration(repo, m, o, log);
  }
  if (o.plan === undefined && o.wave === undefined && waiting.length + migrations.length === 1 && migrations.length === 1) return approveMigration(repo, migrations[0]!, o, log);
  if (o.plan === undefined && o.wave === undefined && waiting.length + migrations.length > 1 && migrations.length > 0) {
    throw new ConfigError(`${waiting.length + migrations.length} gates wait (${[...waiting.map((w) => waveGate(w.wave)), ...migrations.map((m) => `migration ${m.migration}`)].join(", ")}); name one: terragucci approve wave-<k> or terragucci approve <migration>`);
  }
  let chosen: WaitingWave | undefined;
  if (o.plan !== undefined) {
    const plan = o.plan.trim();
    if (!/^\S+$/.test(plan)) throw new ConfigError("--plan takes the digest to approve, such as jcs1-sha256:...");
    const k = o.wave === undefined ? undefined : Number(/^(?:wave-)?(\d+)$/.exec(o.wave)?.[1]);
    if (k !== undefined && (!Number.isInteger(k) || k < 1)) throw new ConfigError(`approve takes a wave as wave-<k> or <k>, not ${JSON.stringify(o.wave)}`);
    const candidates = k === undefined ? waiting : waiting.filter((w) => w.wave === k);
    chosen = candidates.find((w) => samePlanDigest(w.digest, plan));
    if (!chosen) {
      const what = k === undefined ? "no wave" : waveGate(k);
      const now = candidates.length > 0 ? `; waiting: ${candidates.map((w) => `${waveGate(w.wave)} for ${w.digest}`).join(", ")}` : k === undefined ? ": no wave waits for an approval" : " is not waiting";
      log(`not approved: ${what} waits for ${plan}${now}. The plans moved since that digest, or were approved and applied; read the waiting plans, then approve their digest`);
      return { code: 1, command: "" };
    }
  } else if (o.wave !== undefined) {
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
  const code = runChant(repo, args, command, o, log);
  if (code === 0) {
    log(`approved ${waveGate(wave.wave)}`);
    const config = configPath ? await loadConfig(configPath) : {};
    const url = spawnSync("git", ["remote", "get-url", "origin"], { cwd: repo, encoding: "utf-8" }).stdout?.trim() ?? "";
    const origin = originOf(url, typeof (config as { forge?: unknown }).forge === "string" ? (config as { forge: string }).forge : undefined);
    if (o.resume === false) log("not resumed (--no-resume): run its job again, comment /terragucci apply, or let the resume job apply it");
    else if (!origin) log("not resumed from here: the origin is not on github.com or gitlab.com and terragucci.yml names no forge; run its job again, or comment /terragucci apply");
    else log(await resumeAfterApproval({ origin, wave, ...(o.env ? { env: o.env } : {}), ...(o.fetch ? { fetch: o.fetch } : {}) }));
  }
  return { code, command, wave };
}

/** A state migration waiting for an approval of its digest. */
export interface WaitingMigration {
  migration: string;
  digest: string;
  since: string;
  expiresAt: string;
  description?: string;
  runId?: string;
  commit?: string;
}

/** The migrations waiting: each migration gate's newest pending fact whose digest no approval at or after it names. By name. */
export function waitingMigrations(ledger: GateLedger): WaitingMigration[] {
  const newest = new Map<string, GateLedger["pending"][number]>();
  for (const p of ledger.pending) {
    const before = newest.get(p.gate);
    if (p.planDigest && (!before || at(p.timestamp) >= at(before.timestamp))) newest.set(p.gate, p);
  }
  const out: WaitingMigration[] = [];
  for (const [gate, p] of newest) {
    if (ledger.resolutions.some((r) => r.gate === gate && samePlanDigest(r.planDigest, p.planDigest) && at(r.timestamp) >= at(p.timestamp))) continue;
    out.push({ migration: gate, digest: p.planDigest!, since: p.timestamp, expiresAt: p.expiresAt, ...(p.description ? { description: p.description } : {}), ...(p.runId ? { runId: p.runId } : {}), ...(p.commit ? { commit: p.commit } : {}) });
  }
  return out.sort((a, b) => (a.migration < b.migration ? -1 : 1));
}

/** What a waiting migration's kept plan record says it does: its moves, and each root's state before. */
export function describeMigration(text: string | undefined): string[] {
  if (!text) return ["  (the migration kept no plan record; read its proof in wave 1's log)"];
  try {
    const r = JSON.parse(text) as { moves?: { from: string; to: string; addresses: string[] }[]; roots?: { root: string; location?: string; before?: { version_id?: string; digest?: string | null } }[] };
    const lines = (r.moves ?? []).map((m) => `  moves ${m.addresses.join(", ")} from ${m.from} to ${m.to}`);
    for (const x of r.roots ?? []) lines.push(`  ${x.root}: ${x.location ?? "state"}${x.before?.version_id ? ` at version ${x.before.version_id}` : ""}${x.before?.digest ? "" : ", no state yet"}`);
    lines.push("  every root planned with no change against its new state");
    return lines;
  } catch {
    return ["  (the migration's plan record could not be read)"];
  }
}

/** Approve a waiting migration's digest with chant, then resume wave 1, which runs it. */
async function approveMigration(repo: string, m: WaitingMigration, o: ApproveOptions, log: (line: string) => void): Promise<{ code: number; command: string; migration: WaitingMigration }> {
  const configPath = findConfig(repo);
  const config = configPath ? await loadConfig(configPath) : {};
  const mode: Approval = checkoutApproval(repo, config)?.mode ?? "ledger";
  log(`migration ${m.migration} waits for an approval of ${m.digest}${m.description ? ` (${m.description})` : ""}, since ${m.since}`);
  const kept = spawnSync("git", ["show", `refs/remotes/origin/chant/lifecycle:${keptPath(m.migration, m.digest)}`], { cwd: repo, encoding: "utf-8" });
  for (const l of describeMigration(kept.status === 0 ? kept.stdout : undefined)) log(l);
  if (at(m.expiresAt) < Date.now()) log(`  its pending fact expired at ${m.expiresAt}; the approval still counts if wave 1 proves the same digest`);
  const sign = o.sign ?? (mode === "sealed" ? true : undefined);
  const args = ["approve", MIGRATE_OP, m.migration, "--plan", m.digest, ...(o.actor ? ["--actor", o.actor] : []), ...(sign === undefined ? [] : sign === true ? ["--sign"] : ["--sign", sign])];
  const command = `chant ${args.join(" ")}`;
  if (o.dryRun) {
    log(`would run: ${command}`);
    return { code: 0, command, migration: m };
  }
  const code = runChant(repo, args, command, o, log);
  if (code === 0) {
    log(`approved migration ${m.migration}`);
    const url = spawnSync("git", ["remote", "get-url", "origin"], { cwd: repo, encoding: "utf-8" }).stdout?.trim() ?? "";
    const origin = originOf(url, typeof (config as { forge?: unknown }).forge === "string" ? (config as { forge: string }).forge : undefined);
    if (o.resume === false) log("not resumed (--no-resume): run wave 1 again, comment /terragucci apply, or let the resume job run it");
    else if (!origin) log("not resumed from here: the origin is not on github.com or gitlab.com and terragucci.yml names no forge; run wave 1 again, or comment /terragucci apply");
    else log(await resumeAfterApproval({ origin, wave: { wave: 1, ...(m.runId ? { runId: m.runId } : {}), ...(m.commit ? { commit: m.commit } : {}) }, ...(o.env ? { env: o.env } : {}), ...(o.fetch ? { fetch: o.fetch } : {}) }));
  }
  return { code, command, migration: m };
}

/** Run chant with `args` from the repo, node_modules/.bin first on the path. Returns its exit code. */
function runChant(repo: string, args: string[], command: string, o: { chant?: string; env?: NodeJS.ProcessEnv }, log: (line: string) => void): number {
  log(`running: ${command}`);
  const env = o.env ?? process.env;
  const r = spawnSync(o.chant ?? "chant", args, { cwd: repo, stdio: "inherit", env: { ...env, PATH: [join(repo, "node_modules", ".bin"), env.PATH ?? ""].join(delimiter) } });
  if (r.error) throw new ConfigError(`could not run chant (${r.error.message}); install it with npm i -D @intentius/chant, or run: ${command}`);
  return r.status ?? 1;
}

/** Shell quoting for the command line printed. */
const quote = (s: string): string => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

export interface OverrideOptions extends Omit<ApproveOptions, "wave"> {
  /** The root the policy denied. */
  root: string;
  /** The ids of the rules overridden: exactly the rules that denied its plan. */
  rules: string[];
  /** Why, kept on the ledger beside the override. */
  reason: string;
}

/** Find the root's recorded denial, check the rules, and run chant approve for its override digest. Returns chant's exit code (0 for a dry run). */
export async function overrideDenial(repo: string, o: OverrideOptions): Promise<{ code: number; command: string }> {
  const log = o.log ?? ((l: string) => console.log(l));
  if (!o.root) throw new ConfigError("override takes the root the policy denied: terragucci override <root> --rule <id> --reason <text>");
  const rules = sortedRules(o.rules);
  if (rules.length === 0) throw new ConfigError("override names each rule it overrides with --rule <id>");
  if (!o.reason.trim()) throw new ConfigError("override needs --reason <text>: why this plan goes out although the policy denies it");
  const denials = recordedDenials(readLedger(repo, OVERRIDE_LEDGER));
  const denial = denials.find((d) => d.gate === o.root);
  if (!denial) {
    throw new ConfigError(`no denial of ${o.root} is recorded on chant/lifecycle${denials.length ? `; denied: ${denials.map((d) => d.gate).join(", ")}` : ""}. A tf-apply wave records one when the policy denies the root and policy.override in the config at base names who may override it`);
  }
  const denied = sortedRules(denial.rules ?? []);
  if (denied.join("\n") !== rules.join("\n")) {
    throw new ConfigError(`${o.root} was denied by ${denied.join(", ") || "no rule it named"}; an override names exactly those rules, and --rule gave ${rules.join(", ")}`);
  }
  const configPath = findConfig(repo);
  const mode: Approval = checkoutApproval(repo, configPath ? await loadConfig(configPath) : {})?.mode ?? "ledger";
  const plan = denial.members?.[0]?.planDigest;
  log(`${o.root}: its plan${plan ? ` ${plan}` : ""} was denied by ${denied.join(", ")}, since ${denial.timestamp}`);
  log(`  the override binds the root, that plan and those rules: ${denial.planDigest}`);
  if (at(denial.expiresAt) < Date.now()) log(`  the denial's pending fact expired at ${denial.expiresAt}; the override still counts if the next run plans the same digest`);
  const sign = o.sign ?? (mode === "sealed" ? true : undefined);
  const args = ["approve", OVERRIDE_OP, o.root, "--plan", denial.planDigest!, "--note", o.reason.trim(), ...(o.actor ? ["--actor", o.actor] : []), ...(sign === undefined ? [] : sign === true ? ["--sign"] : ["--sign", sign])];
  const command = `chant ${args.map(quote).join(" ")}`;
  if (o.dryRun) {
    log(`would run: ${command}`);
    return { code: 0, command };
  }
  const code = runChant(repo, args, command, o, log);
  if (code === 0) log(`overrode the denial of ${o.root}; run its wave again and it applies this plan, if policy.override at base lists you`);
  return { code, command };
}
