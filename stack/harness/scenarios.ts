/**
 * terragucci's harness scenarios (terragucci#1295, #1296): each is an
 * e2e-scenario/v1 file (chant#4587) at stack/harness/scenarios/<id>/scenario.json,
 * with its overlays under overlays/<name>/ beside it, and a line in
 * scenarios/index.json saying what the driver seeds before its first step.
 *
 * terragucci's pipeline writes report.json, not chant's pr-plan.json, so a
 * terragucci scenario's steps are open, open-concurrent, merge, kill-job,
 * out-of-band, and chant#4650's await-pull and comment, and its outcomes come
 * from the forge (comment, issue, pull), the gated requests on the ledger
 * (gated) and out-of-band checks (stack/harness/check.sh, exit). The plan, approve and
 * apply steps wait for chant's pr-report, which no terragucci job writes.
 *
 * A scenario whose product opens the pull request (a request, a rollout, an
 * MCP call, behold's form) starts it with an out-of-band check.sh helper and
 * binds it with await-pull; merge then names that step. harness.ts's reset
 * closes every open pull request and deletes every branch but main before
 * each arm, so the BREAK arm's await-pull never finds the plain arm's pull
 * request on the same branch (chant#4650).
 *
 * chant's lintScenario is the lint (./harness.ts lint). `localFindings` here
 * is the part of it a chant without the harness can still run, so the
 * scenarios are checked on every chant, and the steps chant's driver could
 * never complete for terragucci are refused too.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";

export const SCENARIOS_DIR = join(import.meta.dirname, "scenarios");
export const SCENARIO_SCHEMA = "https://intentius.io/chant/schemas/e2e-harness/e2e-scenario/v1/e2e-scenario.schema.json";

/** The steps a terragucci scenario may take: the ones that need no chant pr-report. */
export const TERRAGUCCI_STEPS = new Set(["open", "open-concurrent", "merge", "kill-job", "out-of-band", "await-pull", "comment"]);

export interface ScenarioIndexEntry {
  /** The engine binary its pipeline runs: tofu, terraform or choudoufu. */
  binary: "tofu" | "terraform" | "choudoufu";
  /** What seed.sh starts or builds before the first step, in order. */
  needs: string[];
  /** The engine claims and issues its row is cited for. */
  cites: string[];
  /**
   * Where the base tree comes from, when it is not in this repo:
   * `<repo>:<path>` of an INTENTIUS repo (as stack/demo.sh reads choudoufu's
   * demo trees), or `<owner>/<repo>@<commit>:<path>` on github.com.
   */
  source?: string;
  /** The directory of the base the sourced tree goes in. */
  into?: string;
  /** Moves inside the base before init, `from:to` (a tree's forgejo/.forgejo to .forgejo). */
  lift?: string[];
  /**
   * A choudoufu sidecar in the base (`terraform/estate.chdf.hcl`) whose s3
   * record store seed.sh makes in floci with the settings choudoufu asserts
   * (versioning, a noncurrent-version lifecycle rule, the public access
   * block), and whose bucket_owner it points at floci's account, as the
   * tree's own smoke does in its scratch copy.
   */
  recordStore?: string;
  /**
   * Directories of stack/harness/fixtures/ seed.sh copies into the base before
   * the scenario's own seed/, with @REPO@ read as the repo: `templates`, the
   * fixture module registry the template scenarios read.
   */
  fixtures?: string[];
  /** The repo's Actions secrets and variables, by name. */
  secrets?: Record<string, string>;
  vars?: Record<string, string>;
}

/** An overlay named `tree:<path>` is that directory of the seeded base, a sourced tree's own pull request files. */
export const TREE_OVERLAY = "tree:";

/** A source that names a tree in another repo. */
export const SOURCE_PATTERN = /^([a-z0-9-]+|[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[0-9a-f]{40}):[^:]+$/;

export type ScenarioIndex = Record<string, ScenarioIndexEntry>;

export function readIndex(dir = SCENARIOS_DIR): ScenarioIndex {
  return JSON.parse(readFileSync(join(dir, "index.json"), "utf8")) as ScenarioIndex;
}

export function scenarioPath(id: string, dir = SCENARIOS_DIR): string {
  return join(dir, id, "scenario.json");
}

/** Every scenario directory's id, sorted. */
export function scenarioIds(dir = SCENARIOS_DIR): string[] {
  return readdirSync(dir)
    .filter((d) => existsSync(join(dir, d, "scenario.json")))
    .sort();
}

/**
 * An overlay's files, repo-relative path to content, read from
 * overlays/<name>/ beside the scenario file, or for `tree:<path>` from that
 * directory of the seeded base (`baseDir`).
 */
export function overlayFiles(scenarioFile: string, name: string, baseDir?: string): Record<string, string> {
  if (name.startsWith(TREE_OVERLAY) && !baseDir) throw new Error(`overlay ${name} is read from the seeded base, and there is none yet`);
  const root = name.startsWith(TREE_OVERLAY) ? join(baseDir!, name.slice(TREE_OVERLAY.length)) : join(dirname(scenarioFile), "overlays", name);
  if (!existsSync(root)) throw new Error(`${relative(process.cwd(), scenarioFile)} names overlay ${name}, which has no directory ${relative(process.cwd(), root)}`);
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(root, p).split("\\").join("/")] = readFileSync(p, "utf8");
    }
  };
  walk(root);
  return out;
}

interface Finding {
  at: string;
  message: string;
}

type Step = { id?: unknown; do?: unknown; overlay?: unknown; pull?: unknown; command?: unknown; expect?: unknown[] };

/**
 * What a chant without the harness can check of a scenario: the protocol's
 * two refusals (a claim id, a BREAK arm with BREAK "1"), terragucci as the
 * product, the steps terragucci's pipeline can complete, each overlay on
 * disk, each out-of-band command naming a script that exists, and something
 * to expect. Empty when it holds.
 */
export function localFindings(file: string, index: ScenarioIndex): Finding[] {
  const out: Finding[] = [];
  const doc = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  const id = doc.id;
  if (doc.$schema !== SCENARIO_SCHEMA) out.push({ at: "/$schema", message: `not ${SCENARIO_SCHEMA}` });
  if (doc.contract !== 1) out.push({ at: "/contract", message: "contract is not 1" });
  if (typeof id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(id)) out.push({ at: "/id", message: "no scenario id" });
  else if (id !== dirname(file).split(/[\\/]/).pop()) out.push({ at: "/id", message: `${id} is not the name of its directory` });
  else if (!index[id]) out.push({ at: "/id", message: `${id} has no line in scenarios/index.json` });
  if (doc.product !== "terragucci") out.push({ at: "/product", message: "the product is not terragucci" });
  if (typeof doc.claim !== "string" || doc.claim.trim() === "") out.push({ at: "/claim", message: "the scenario has no claim id, so its run would record a row for nothing" });
  const brk = doc.break as { env?: Record<string, unknown>; overlay?: unknown } | undefined;
  if (!brk) out.push({ at: "/break", message: "the scenario has no BREAK arm, so nothing shows its outcomes can fail" });
  else if (brk.env?.BREAK !== "1") out.push({ at: "/break/env/BREAK", message: 'the BREAK arm must set BREAK to "1"' });
  const tree = doc.tree as { base?: unknown } | undefined;
  if (typeof tree?.base !== "string") out.push({ at: "/tree/base", message: "no base tree" });
  else if (typeof id === "string" && index[id]?.source) {
    if (!SOURCE_PATTERN.test(index[id]!.source!)) out.push({ at: "/tree/base", message: `index.json's source ${index[id]!.source} is not <repo>:<path> or <owner>/<repo>@<commit>:<path>` });
  } else if (!existsSync(join(dirname(file), tree.base))) out.push({ at: "/tree/base", message: `${tree.base} is not there` });
  for (const f of (typeof id === "string" ? index[id]?.fixtures : undefined) ?? []) {
    if (!existsSync(join(SCENARIOS_DIR, "..", "fixtures", f))) out.push({ at: "/tree/base", message: `index.json's fixture ${f} is not a directory of stack/harness/fixtures` });
  }
  if (typeof doc.reportUrl !== "string" || !/^s3:\/\/[^/]+\/.+/.test(doc.reportUrl)) out.push({ at: "/reportUrl", message: "no s3:// report URL" });

  const overlay = (at: string, name: unknown) => {
    if (typeof name !== "string") return;
    if (name.startsWith(TREE_OVERLAY)) {
      if (typeof id !== "string" || !index[id]?.source) out.push({ at, message: `overlay ${name} reads a sourced tree, and the scenario has no source` });
      return;
    }
    if (!existsSync(join(dirname(file), "overlays", name))) out.push({ at, message: `overlay ${name} has no directory overlays/${name}` });
  };
  if (brk) overlay("/break/overlay", brk.overlay);
  const steps = (Array.isArray(doc.steps) ? doc.steps : []) as Step[];
  if (steps.length === 0) out.push({ at: "/steps", message: "no steps" });
  let expectations = 0;
  const seen = new Map<string, Step>();
  steps.forEach((s, i) => {
    const at = `/steps/${i}`;
    if (typeof s.id !== "string") out.push({ at: `${at}/id`, message: "a step with no id" });
    else if (seen.has(s.id)) out.push({ at: `${at}/id`, message: `step id ${s.id} is used twice` });
    if (typeof s.do !== "string" || !TERRAGUCCI_STEPS.has(s.do)) {
      out.push({ at: `${at}/do`, message: `${String(s.do)} is not a step a terragucci pipeline completes (${[...TERRAGUCCI_STEPS].join(", ")}): plan, approve and apply wait for chant's pr-report` });
    }
    if (s.do === "open" || s.do === "open-concurrent") overlay(`${at}/overlay`, s.overlay);
    if (s.do === "merge") {
      const o = typeof s.pull === "string" ? seen.get(s.pull) : undefined;
      if (!o || (o.do !== "open" && o.do !== "open-concurrent" && o.do !== "await-pull")) out.push({ at: `${at}/pull`, message: `merge names ${String(s.pull)}, which is not an earlier open or await-pull step` });
    }
    if (s.do === "out-of-band") {
      const cmd = s.command as unknown[] | undefined;
      const script = Array.isArray(cmd) && typeof cmd[0] === "string" ? cmd[0] : undefined;
      if (!script) out.push({ at: `${at}/command`, message: "an out-of-band step with no command" });
      else if (script.startsWith("stack/") && !existsSync(join(SCENARIOS_DIR, "..", "..", "..", script))) out.push({ at: `${at}/command/0`, message: `${script} is not in the repo` });
    }
    expectations += Array.isArray(s.expect) ? s.expect.length : 0;
    if (typeof s.id === "string") seen.set(s.id, s);
  });
  if (expectations === 0) out.push({ at: "/steps", message: "no step expects anything, so the plain run would pass and the BREAK run could never be caught" });
  return out;
}
