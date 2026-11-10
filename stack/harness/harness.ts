/**
 * The validation stack on chant's e2e harness (chant#4587, terragucci#1295).
 *
 *   harness.ts floor               print the chant, the harness floor and floci
 *   harness.ts compose --out FILE  build floci, Forgejo and forgejo-runner (./compose/) for TG_PROJECT
 *   harness.ts lint [id...]        lint the scenarios (chant's lintScenario, and ./scenarios.ts)
 *   harness.ts record --logs DIR --binary B --forge F --engine-version V [--claims FILE] [--out FILE]
 *                                  smoke.sh --record's verdicts as harness rows
 *   harness.ts run <id> [--record] drive one scenario, plain then BREAK, on the running stack
 *
 * The harness is imported directly: the pin carries `@intentius/chant/e2e-harness`.
 *
 * A row is written only after the no-real-cloud scan said CLEAN (chant's
 * SafeRun), on a ledger of its own in the instance's state directory
 * (claims-ledger, op e2e-claim), and stack/evidence/e2e-claims.json is
 * rendered from it (renderClaims). smoke.json stays EVIDENCE.md's source.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import * as h from "@intentius/chant/e2e-harness";
import type { GatedRequestRead } from "@intentius/chant/lifecycle/gated-request";
import type { OpRunRecord } from "@intentius/chant/op";
import { TOOL_VERSIONS } from "../../packages/terragucci/src/images";
import { bareVersion, parseClaimsTable, smokeRows, smokeScenario, type ClaimRunLike } from "./rows";
import { localFindings, overlayFiles, readIndex, scenarioIds, scenarioPath } from "./scenarios";

const HERE = import.meta.dirname;
const ROOT = resolve(HERE, "..", "..");
const STATE = process.env.TG_STATE || join(ROOT, "stack", ".state");
const CLAIMS_JSON = join(ROOT, "stack", "evidence", "e2e-claims.json");

/** The exit code when the no-real-cloud scan found a public cloud answering: nothing is recorded. */
export const EXIT_REAL_CLOUD = 4;

async function runLedger(): Promise<typeof import("@intentius/chant/lifecycle/run-ledger")> {
  return import("@intentius/chant/lifecycle/run-ledger");
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
async function writeRow(row: h.ClaimRow, run: h.ClaimRun, verdict: { verdict: "CLEAN" } | { verdict: "REAL-CLOUD"; hits: string[] }, out: string): Promise<void> {
  const ledger = join(STATE, "claims-ledger");
  mkdirSync(ledger, { recursive: true });
  if (!existsSync(join(ledger, ".git"))) sh("git", ["init", "-q", "-b", "main", ledger]);
  const { appendRunRecord, readRunLedger } = await runLedger();
  await h.recordClaimRow({ row, run, verdict, append: async (input) => void (await appendRunRecord(input, { cwd: ledger })) });
  const { records } = await readRunLedger("local", h.CLAIM_OP, { cwd: ledger });
  writeFileSync(out, `${JSON.stringify(h.renderClaims("terragucci", h.claimRowsOf(records)), null, 2)}\n`);
}

/**
 * smoke.sh --record's verdicts as rows: one per claim that ran both ways.
 * The scan reads every log in the directory; one real-cloud line and no row
 * is written for any claim. Each row carries the engine its claim ran on
 * (rows.ts rowEngine): --claims is the claim table the run read, and a claim
 * that says it runs on another binary than --binary carries that binary at
 * the version its CI image is built with (TOOL_VERSIONS).
 */
async function record(args: string[]): Promise<number> {
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
  const claimsFile = flag(args, "claims");
  if (claimsFile !== undefined && !existsSync(claimsFile)) {
    console.error(`harness record: --claims names ${claimsFile}, which is not there`);
    return 2;
  }
  if (claimsFile === undefined) console.error(`harness record: no --claims, so every row carries ${binary}`);
  const claims = claimsFile === undefined ? undefined : parseClaimsTable(readFileSync(claimsFile, "utf8"));
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
  const rows = smokeRows(logs, { scenario, binary, version, claims, pins: TOOL_VERSIONS });
  for (const r of rows) {
    const row = h.claimRow({
      scenario: { id: scenario, product: "terragucci", claim: r.claim },
      productCommit: commit,
      engine: r.engine,
      verdicts: r.run.verdicts,
      at: new Date(r.run.break.ended),
      chant: chantVersion(),
    });
    await writeRow(row, r.run, verdict, out);
  }
  const engines = [...new Set(rows.map((r) => `${r.engine.binary} ${r.engine.version}`))].join(", ");
  console.error(`harness record: ${rows.length} ${scenario} row(s)${engines ? ` (${engines})` : ""} on ${join(STATE, "claims-ledger")}, rendered to ${out}`);
  return 0;
}

/** Build ./compose/ for TG_PROJECT into --out. */
async function compose(args: string[]): Promise<number> {
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
  let bad = 0;
  for (const id of ids) {
    const file = scenarioPath(id);
    if (!existsSync(file)) {
      console.error(`harness lint: no scenario ${id}`);
      bad++;
      continue;
    }
    const findings = [...localFindings(file, index), ...h.lintScenario(JSON.parse(readFileSync(file, "utf8")))];
    for (const f of findings) console.error(`${id}${f.at}: ${f.message}`);
    if (findings.length > 0) bad++;
  }
  for (const id of Object.keys(index)) {
    if (!ids.includes(id) && args.length === 0) {
      console.error(`harness lint: scenarios/index.json names ${id}, which has no scenario.json`);
      bad++;
    }
  }
  console.error(`harness lint: ${ids.length - bad} of ${ids.length} scenario(s) hold`);
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
async function ledgerRuns(env: Record<string, string>, repo: string, ledgerEnv: string, op: string): Promise<OpRunRecord[]> {
  const dir = join(STATE, "scenarios", "ledger-clones", `${repo.replace("/", "-")}-${Date.now()}`);
  const url = env.TERRAGUCCI_FORGEJO_URL!.replace(/^http:\/\//, `http://${env.TERRAGUCCI_FORGEJO_USER}:${env.TERRAGUCCI_FORGEJO_TOKEN}@`);
  const cloned = sh("git", ["clone", "-q", "--single-branch", "--branch", "chant/lifecycle", `${url}/${repo}.git`, dir]);
  if (cloned.status !== 0) return [];
  const { readRunLedger } = await runLedger();
  return (await readRunLedger(ledgerEnv, op, { cwd: dir })).records;
}

/**
 * The gated requests of `op` on the scenario repo's chant/lifecycle
 * (chant#4650's `gated` outcome), read the same way from a fresh clone.
 */
async function ledgerGated(env: Record<string, string>, repo: string, op: string): Promise<GatedRequestRead[]> {
  const dir = join(STATE, "scenarios", "ledger-clones", `${repo.replace("/", "-")}-gated-${Date.now()}`);
  const url = env.TERRAGUCCI_FORGEJO_URL!.replace(/^http:\/\//, `http://${env.TERRAGUCCI_FORGEJO_USER}:${env.TERRAGUCCI_FORGEJO_TOKEN}@`);
  const cloned = sh("git", ["clone", "-q", "--single-branch", "--branch", "chant/lifecycle", `${url}/${repo}.git`, dir]);
  if (cloned.status !== 0) return [];
  const { readGatedRequests } = await import("@intentius/chant/lifecycle/gated-request");
  return readGatedRequests(op, { cwd: dir });
}

/**
 * One scenario on the running stack: seed.sh makes its repo and base, the
 * driver plays the plain arm and the BREAK arm, the runner's log joins the
 * scan, and with --record the row goes on the claims ledger when the scan
 * said CLEAN. Exit 0 when the row holds, 1 when not, 4 on a real-cloud line.
 */
async function run(args: string[]): Promise<number> {
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
      ledger: { runs: (ledgerEnv: string, op: string) => ledgerRuns(env, seed.REPO!, ledgerEnv, op), gatedRequests: (op: string) => ledgerGated(env, seed.REPO!, op) },
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
      engine: { binary: entry.binary, version: bareVersion(seed.ENGINE_VERSION!) },
      verdicts: result.verdicts,
      at: new Date(),
      chant: chantVersion(),
    });
    await writeRow(row, result, verdict, CLAIMS_JSON);
  }
  return result.verdicts.plain === "pass" && result.verdicts.break === "caught" ? 0 : 1;
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "floor": {
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
      console.error("usage: harness.ts floor | compose --out FILE | lint [id...] | record --logs DIR --binary B --forge F --engine-version V [--claims FILE] [--out FILE] | run <id> [--record]");
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
