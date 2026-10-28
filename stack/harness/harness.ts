/**
 * The validation stack on chant's e2e harness (chant#4587, terragucci#1295).
 *
 *   harness.ts floor               exit 0 when the installed chant has the harness, 3 when not
 *   harness.ts compose --out FILE  build floci, Forgejo and forgejo-runner (./compose/) for TG_PROJECT
 *   harness.ts lint [id...]        lint the scenarios (chant's lintScenario, and ./scenarios.ts)
 *   harness.ts record --logs DIR --binary B --forge F --engine-version V [--out FILE]
 *                                  smoke.sh --record's verdicts as harness rows
 *   harness.ts run <id> [--record] drive one scenario, plain then BREAK, on the running stack
 *
 * Every chant import is lazy. On a chant without `@intentius/chant/e2e-harness`
 * each command but lint exits 3 and says which chant it needs, and the
 * stack keeps terragucci's own harness: stack/forge-fallback.yml, smoke.sh's
 * runner, and smoke.json as the only record. lint still runs ./scenarios.ts.
 *
 * A row is written only after the no-real-cloud scan said CLEAN (chant's
 * SafeRun), on a ledger of its own in the instance's state directory
 * (claims-ledger, op e2e-claim), and docs-site/src/data/e2e-claims.json is
 * rendered from it (renderClaims). smoke.json stays the page's scoreboard.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseSmokeLine, smokeClaimRun, smokeScenario, type ClaimRunLike } from "./rows";
import { localFindings, overlayFiles, readIndex, scenarioIds, scenarioPath } from "./scenarios";

const HERE = import.meta.dirname;
const ROOT = resolve(HERE, "..", "..");
const STATE = process.env.TG_STATE || join(ROOT, "stack", ".state");
const CLAIMS_JSON = join(ROOT, "docs-site", "src", "data", "e2e-claims.json");

/** What the stack needs of chant: the harness subpath, first in the release after 0.124.55. */
export const HARNESS_NEEDS = "a chant with @intentius/chant/e2e-harness (chant#4587; the release after 0.124.55)";
/** The exit code for a chant without the harness: the caller falls back. */
export const EXIT_NO_HARNESS = 3;
/** The exit code when the no-real-cloud scan found a public cloud answering: nothing is recorded. */
export const EXIT_REAL_CLOUD = 4;

// The part of the harness this file calls. Typed here, since the pinned chant has no types for it.
/* eslint-disable @typescript-eslint/no-explicit-any */
interface Harness {
  E2E_HARNESS_FLOOR: string;
  FLOCI_DIGEST: string;
  harnessStack: (...a: any[]) => any;
  lintScenario: (data: unknown) => Array<{ at: string; message: string }>;
  loadScenario: (path: string) => any;
  runClaim: (s: any, ports: any, opts: any) => Promise<ClaimRunLike>;
  claimRow: (i: any) => any;
  recordClaimRow: (i: any) => Promise<unknown>;
  claimRowsOf: (records: readonly any[]) => any[];
  renderClaims: (product: string, rows: readonly any[]) => unknown;
  realCloudHits: (text: string, where?: string) => string[];
  SafeRun: new (o: any) => { env: Record<string, string>; logFile: string; log(line: string): void; run(c: string[], extra?: Record<string, string>): Promise<number>; scan(extra?: string[]): { verdict: "CLEAN" } | { verdict: "REAL-CLOUD"; hits: string[] } };
  ForgejoForge: new (o: any) => any;
  FlociBucket: new (endpoint: string, bucket: string) => any;
  dockerJobs: (network: string) => any;
  realClock: any;
  CLAIM_OP: string;
}

/** The harness, or undefined on a chant without it. */
export async function loadHarness(): Promise<Harness | undefined> {
  try {
    // @ts-ignore chant 0.124.55 has no e2e-harness subpath (terragucci#1295)
    const m = (await import("@intentius/chant/e2e-harness")) as Record<string, unknown>;
    const fns = ["harnessStack", "lintScenario", "runClaim", "claimRow", "recordClaimRow", "renderClaims", "SafeRun", "ForgejoForge"];
    return typeof m.E2E_HARNESS_FLOOR === "string" && fns.every((f) => typeof m[f] === "function") ? (m as unknown as Harness) : undefined;
  } catch {
    return undefined;
  }
}

async function needHarness(what: string): Promise<Harness> {
  const h = await loadHarness();
  if (!h) {
    console.error(`harness: ${what} needs ${HARNESS_NEEDS}; the installed chant has none, so the stack keeps its own harness`);
    process.exit(EXIT_NO_HARNESS);
  }
  return h;
}

async function runLedger(): Promise<{ appendRunRecord: (input: unknown, o: { cwd: string }) => Promise<unknown>; readRunLedger: (env: string, op: string, o: { cwd: string }) => Promise<{ records: unknown[] }> }> {
  return (await import("@intentius/chant/lifecycle/run-ledger")) as never;
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

function sh(cmd: string, args: string[], env: Record<string, string | undefined> = process.env): { status: number; stdout: string } {
  const r = spawnSync(cmd, args, { cwd: ROOT, env, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  return { status: r.status ?? 1, stdout: r.stdout ?? "" };
}

const productCommit = (): string => sh("git", ["rev-parse", "HEAD"]).stdout.trim();

function chantVersion(): string {
  return (JSON.parse(readFileSync(join(ROOT, "node_modules", "@intentius", "chant", "package.json"), "utf8")) as { version: string }).version;
}

/** The claims ledger (a git repo of its own, as chant's run ledger is read) and the render beside it. */
async function writeRow(h: Harness, row: unknown, run: ClaimRunLike, verdict: { verdict: "CLEAN" } | { verdict: "REAL-CLOUD"; hits: string[] }, out: string): Promise<void> {
  const ledger = join(STATE, "claims-ledger");
  mkdirSync(ledger, { recursive: true });
  if (!existsSync(join(ledger, ".git"))) sh("git", ["init", "-q", "-b", "main", ledger]);
  const { appendRunRecord, readRunLedger } = await runLedger();
  await h.recordClaimRow({ row, run, verdict, append: async (input: unknown) => void (await appendRunRecord(input, { cwd: ledger })) });
  const { records } = await readRunLedger("local", h.CLAIM_OP, { cwd: ledger });
  writeFileSync(out, `${JSON.stringify(h.renderClaims("terragucci", h.claimRowsOf(records)), null, 2)}\n`);
}

const iso = (ms: number) => new Date(ms).toISOString();

/** When a log was written: its birth and its last change, as the file system has them. */
function timesOf(file: string): { started: string; ended: string } {
  if (!existsSync(file)) {
    const now = iso(Date.now());
    return { started: now, ended: now };
  }
  const s = statSync(file);
  return { started: iso(s.birthtimeMs || s.ctimeMs), ended: iso(s.mtimeMs) };
}

/**
 * smoke.sh --record's verdicts as rows: one per claim that ran both ways.
 * The scan reads every log in the directory; one real-cloud line and no row
 * is written for any claim.
 */
async function record(args: string[]): Promise<number> {
  const h = await needHarness("writing the harness rows of a smoke record");
  const logs = flag(args, "logs");
  if (!logs || !existsSync(logs)) {
    console.error("harness record: --logs names no directory");
    return 2;
  }
  const binary = flag(args, "binary") ?? "tofu";
  const forge = flag(args, "forge") ?? "forgejo";
  const version = flag(args, "engine-version");
  if (!version) {
    console.error("harness record: --engine-version is the version the claims' binary reported, and a row needs it");
    return 2;
  }
  const out = flag(args, "out") ?? CLAIMS_JSON;
  const scratch = join(STATE, "claims-scan");
  mkdirSync(scratch, { recursive: true });
  const safe = new h.SafeRun({ scratch, scan: [logs] });
  const verdict = safe.scan();
  if (verdict.verdict !== "CLEAN") {
    console.error(`harness record: the no-real-cloud scan of ${logs} found ${verdict.hits.length} real-cloud line(s); no row is written`);
    for (const hit of verdict.hits.slice(0, 20)) console.error(`  ${hit}`);
    return EXIT_REAL_CLOUD;
  }
  const scenario = smokeScenario({ binary, forge });
  const commit = productCommit();
  let written = 0;
  for (const f of readdirSync(logs).filter((n) => n.endsWith(".plain.verdict")).sort()) {
    const base = f.slice(0, -".plain.verdict".length);
    const plain = parseSmokeLine(readFileSync(join(logs, f), "utf8"));
    if (!plain || plain.verdict === "pending") continue;
    const brkFile = join(logs, `${base}.break.verdict`);
    if (!existsSync(brkFile)) continue;
    const brk = parseSmokeLine(readFileSync(brkFile, "utf8"));
    const run = smokeClaimRun({
      scenario,
      claim: plain.claim,
      plain,
      break: brk,
      times: { plain: timesOf(join(logs, `${base}.plain.log`)), break: timesOf(join(logs, `${base}.break.log`)) },
    });
    const row = h.claimRow({
      scenario: { id: scenario, product: "terragucci", claim: plain.claim },
      productCommit: commit,
      engine: { binary, version },
      verdicts: run.verdicts,
      at: new Date(run.break.ended),
      chant: chantVersion(),
    });
    await writeRow(h, row, run, verdict, out);
    written++;
  }
  console.error(`harness record: ${written} ${scenario} row(s) on ${join(STATE, "claims-ledger")}, rendered to ${out}`);
  return 0;
}

/** Build ./compose/ for TG_PROJECT into --out. */
async function compose(args: string[]): Promise<number> {
  await needHarness("building floci, Forgejo and forgejo-runner from the harness");
  const out = flag(args, "out");
  if (!out) {
    console.error("harness compose: --out names the file to write");
    return 2;
  }
  mkdirSync(dirname(out), { recursive: true });
  const r = sh(join(ROOT, "node_modules", ".bin", "chant"), ["build", join(HERE, "compose"), "-o", out, "--format", "yaml"], {
    ...process.env,
    TG_PROJECT: process.env.TG_PROJECT || "terragucci",
  });
  if (r.status !== 0 || !existsSync(out)) {
    console.error(`harness compose: chant build of stack/harness/compose exited ${r.status}`);
    return 1;
  }
  return 0;
}

async function lint(args: string[]): Promise<number> {
  const index = readIndex();
  const ids = args.length > 0 ? args : scenarioIds();
  const h = await loadHarness();
  let bad = 0;
  for (const id of ids) {
    const file = scenarioPath(id);
    if (!existsSync(file)) {
      console.error(`harness lint: no scenario ${id}`);
      bad++;
      continue;
    }
    const findings = [...localFindings(file, index), ...(h ? h.lintScenario(JSON.parse(readFileSync(file, "utf8"))) : [])];
    for (const f of findings) console.error(`${id}${f.at}: ${f.message}`);
    if (findings.length > 0) bad++;
  }
  for (const id of Object.keys(index)) {
    if (!ids.includes(id) && args.length === 0) {
      console.error(`harness lint: scenarios/index.json names ${id}, which has no scenario.json`);
      bad++;
    }
  }
  console.error(`harness lint: ${ids.length - bad} of ${ids.length} scenario(s) hold${h ? "" : ` (chant's lintScenario skipped: needs ${HARNESS_NEEDS})`}`);
  return bad === 0 ? 0 : 1;
}

/** forgejo.env as bootstrap.sh wrote it. */
function forgejoEnv(): Record<string, string> {
  const file = join(STATE, "forgejo.env");
  if (!existsSync(file)) throw new Error(`no ${file}; run 'just stack-up forgejo' first`);
  const env: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^export ([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m) env[m[1]!] = m[2]!.replace(/^"(.*)"$/, "$1");
  }
  return env;
}

/**
 * The run records of `op` on the scenario repo's chant/lifecycle, read from
 * a fresh clone of that branch (none yet is no records).
 */
async function ledgerRuns(env: Record<string, string>, repo: string, ledgerEnv: string, op: string): Promise<unknown[]> {
  const dir = join(STATE, "scenarios", "ledger-clones", `${repo.replace("/", "-")}-${Date.now()}`);
  const url = env.TERRAGUCCI_FORGEJO_URL!.replace(/^http:\/\//, `http://${env.TERRAGUCCI_FORGEJO_USER}:${env.TERRAGUCCI_FORGEJO_TOKEN}@`);
  const cloned = sh("git", ["clone", "-q", "--single-branch", "--branch", "chant/lifecycle", `${url}/${repo}.git`, dir]);
  if (cloned.status !== 0) return [];
  const { readRunLedger } = await runLedger();
  return (await readRunLedger(ledgerEnv, op, { cwd: dir })).records;
}

/**
 * One scenario on the running stack: seed.sh makes its repo and base, the
 * driver plays the plain arm and the BREAK arm, the runner's log joins the
 * scan, and with --record the row goes on the claims ledger when the scan
 * said CLEAN. Exit 0 when the row holds, 1 when not, 4 on a real-cloud line.
 */
async function run(args: string[]): Promise<number> {
  const h = await needHarness("driving a scenario");
  const id = args[0];
  if (!id) {
    console.error("harness run: name a scenario");
    return 2;
  }
  const file = scenarioPath(id);
  const scenario = h.loadScenario(file);
  const local = localFindings(file, readIndex());
  if (local.length > 0) {
    for (const f of local) console.error(`${id}${f.at}: ${f.message}`);
    return 2;
  }
  const entry = readIndex()[id]!;
  const env = forgejoEnv();
  const seeded = sh("bash", [join(HERE, "seed.sh"), id], { ...process.env, ...env });
  if (seeded.status !== 0) {
    console.error(`harness run: seed.sh ${id} exited ${seeded.status}`);
    return 1;
  }
  const seed = Object.fromEntries(seeded.stdout.split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
  const scratch = join(STATE, "scenarios", id, "claim");
  mkdirSync(scratch, { recursive: true });
  const safe = new h.SafeRun({ scratch, logFile: join(scratch, "safe-run.log") });
  const person = (login: string, token: string) => ({ login, token });
  const admin = person(env.TERRAGUCCI_FORGEJO_USER!, env.TERRAGUCCI_FORGEJO_TOKEN!);
  const forge = new h.ForgejoForge({
    url: env.TERRAGUCCI_FORGEJO_URL,
    repo: seed.REPO,
    admin,
    author: person(env.TERRAGUCCI_FORGEJO_AUTHOR!, env.TERRAGUCCI_FORGEJO_AUTHOR_TOKEN!),
    reviewer: person(env.TERRAGUCCI_FORGEJO_REVIEWER!, env.TERRAGUCCI_FORGEJO_REVIEWER_TOKEN!),
    baseTree: seed.BASE_DIR,
    clock: h.realClock,
    checkout: ROOT,
    emailDomain: "terragucci.local",
  });
  const bucket = /^s3:\/\/([^/]+)/.exec(scenario.reportUrl)![1]!;
  let armEnv: Record<string, string> = {};
  const checkEnv = () => ({ ...env, ...armEnv, TG_SCENARIO: id, TG_SCENARIO_REPO: seed.REPO!, TG_STATE: STATE, TG_PROJECT: process.env.TG_PROJECT || "terragucci" });
  const result = await h.runClaim(
    scenario,
    {
      forge,
      bucket: new h.FlociBucket(env.TERRAGUCCI_FLOCI_URL!, bucket),
      chant: {
        approve: async () => {
          throw new Error("a terragucci scenario approves out of band (terragucci approve), not through chant approve");
        },
      },
      clock: h.realClock,
      overlay: (name: string) => overlayFiles(file, name, seed.BASE_DIR),
      ledger: { runs: (ledgerEnv: string, op: string) => ledgerRuns(env, seed.REPO!, ledgerEnv, op) },
      jobs: h.dockerJobs(process.env.TG_NETWORK || "terragucci"),
      outOfBand: { run: (command: string[]) => safe.run(command[0]!.startsWith("stack/") ? [join(ROOT, command[0]!), ...command.slice(1)] : command, checkEnv()) },
      reset: async () => {
        for (const pull of await forge.openPulls()) await forge.closePull(pull);
        for (const b of await forge.branches()) if (b !== "main") await forge.deleteBranch(b);
        await forge.forceMain(seed.BASE_SHA);
        const settled = sh("bash", [join(HERE, "check.sh"), "settle"], { ...process.env, ...checkEnv() });
        if (settled.status !== 0) throw new Error(`the base of ${seed.REPO} did not settle`);
      },
      arm: async (_arm: string, e: Record<string, string>) => {
        armEnv = e;
      },
      log: (line: string) => {
        console.error(`[harness ${id}] ${line}`);
        safe.log(line);
      },
    },
    { approver: `forgejo@forgejo:3000:${env.TERRAGUCCI_FORGEJO_REVIEWER}` },
  );
  const runnerLog = spawnSync("docker", ["logs", `${process.env.TG_PROJECT || "terragucci"}-forgejo-runner`], { encoding: "utf8" });
  safe.log(`${runnerLog.stdout ?? ""}${runnerLog.stderr ?? ""}`);
  const verdict = safe.scan();
  console.error(`[harness ${id}] plain ${result.verdicts.plain}, break ${result.verdicts.break}, scan ${verdict.verdict}`);
  if (verdict.verdict !== "CLEAN") return EXIT_REAL_CLOUD;
  if (args.includes("--record")) {
    const row = h.claimRow({
      scenario,
      productCommit: productCommit(),
      engine: { binary: entry.binary, version: seed.ENGINE_VERSION },
      verdicts: result.verdicts,
      at: new Date(),
      chant: chantVersion(),
    });
    await writeRow(h, row, result, verdict, CLAIMS_JSON);
  }
  return result.verdicts.plain === "pass" && result.verdicts.break === "caught" ? 0 : 1;
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "floor": {
      const h = await loadHarness();
      if (!h) {
        console.error(`harness: the installed chant ${chantVersion()} has no e2e harness; the stack needs ${HARNESS_NEEDS}`);
        return EXIT_NO_HARNESS;
      }
      console.log(`chant ${chantVersion()}, e2e harness floor ${h.E2E_HARNESS_FLOOR}, floci ${h.FLOCI_DIGEST}`);
      return 0;
    }
    case "compose":
      return compose(rest);
    case "lint":
      return lint(rest);
    case "record":
      return record(rest);
    case "run":
      return run(rest);
    default:
      console.error("usage: harness.ts floor | compose --out FILE | lint [id...] | record --logs DIR --binary B --forge F --engine-version V [--out FILE] | run <id> [--record]");
      return 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(`harness: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    },
  );
}
