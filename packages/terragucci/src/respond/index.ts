/**
 * `terragucci respond <event>`: the response to a pipeline event. Each event
 * has a deterministic response, the default, which needs no model. Nothing
 * here approves, merges or resolves a gate.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, posix, resolve } from "node:path";
import { binaryEnv } from "../binary-env";
import { checkMode, ConfigError, findConfig, loadConfig, resolveProject, resolveRepo, responseTo, RESPONSES, SYNTH_DRIFT_PR, type RespondEvent, type ResolvedSettings, type TerragucciConfig } from "../config";
import { detectBinary, findRoots, globMatch } from "../detect";
import { detectTerragrunt } from "../terragrunt";
import { defaultBranch, type Fetch } from "../forge";
import { findModules } from "../publish";
import { configAtBase } from "../report/policy";
import type { Report } from "../report/schema";
import { storeFromEnv } from "../report/bucket";
import type { S3Fetch } from "../report/s3";
import { copyToRun } from "../report/store";
import { forgeOf, git, propose, worktree, type Proposed } from "./change";
import { IDENTITY } from "../reconcile";
import { ATTRIBUTIONS_FILE, attribute, awsAuditLog, route, withoutLeft, type Attributed, type Attribution, type AuditLog } from "./attribute";
import type { DecideOptions } from "../decide";
import { codify, driftOf, hasQuery, importBlocks, type Codified, type Left } from "./drift";
import { codifyUnitDrift, driftedUnits, unitDrift, unitRunner } from "./drift-units";
import type { TerragruntExec } from "@intentius/chant-lexicon-terraform/terragrunt/run";
import { checkDescription } from "./intent";
import { moduleNotes } from "./notes";
import { describeRefused, refusedDiff } from "./refused";
import { movedProposals, reportRenames, tipProposals } from "./tips";
import { versionBumps } from "./version-bump";
import type { DecideFetch } from "../decide";
import { describeTriage, triage } from "./triage";
import { continueExit, continueRollouts, describeContinue } from "../rollout";

export const EVENTS = Object.keys(RESPONSES) as RespondEvent[];

export interface RespondOptions {
  config?: string;
  project?: string;
  /** A ref (`origin/main`): read the settings from the config there, not from the checkout. A base that cannot be read gives no response. For a job running an open pull request's head. */
  base?: string;
  mode?: "dry-run" | "apply";
  /** Where the response writes its files. Default `terragucci-respond`. */
  out?: string;
  /** plan and description: the report directory. tips: a `stage tf-plan` report, whose plans' renames get a moved block each. */
  report?: string;
  /** wave-refused: the approved plan's report and the current one, each report.json or its directory. */
  approved?: string;
  current?: string;
  wave?: number;
  /** apply-failed: the apply's log. */
  log?: string;
  root?: string;
  binary?: string;
  /** drift: resources to import. */
  imports?: { address: string; id: string }[];
  /** tips: the platforms a new lock file holds hashes for. */
  platforms?: string[];
  /** fmt: the pull request's branch. tips with --report: the branch the moved blocks' pull request goes into (default the default branch). */
  branch?: string;
  /** publish: one module's path, and a version of it. */
  module?: string;
  version?: string;
  /** version-bump: the ref to count changes from when a module has no release tag. */
  since?: string;
  /** version-bump and description: the decision service's HTTP client, for tests. */
  decideFetch?: DecideFetch;
  /** description: the pull request's title and description; by default read from the job's event. */
  title?: string;
  description?: string;
  /** description: the S3 client's HTTP calls, for tests. */
  s3Fetch?: S3Fetch;
  /** drift, with respond.drift set to attribute: the audit log to read (default CloudTrail through the aws CLI). */
  audit?: AuditLog;
  /** drift, with respond.drift set to attribute: the attributions `tf-drift` already made, per root, or the file that holds them. Default `terragucci-report/attributions.json`. A root without one is attributed here. */
  attributions?: Record<string, Attributed> | string;
  /** drift, with respond.drift set to attribute: how the decision client reaches its service. */
  decideOptions?: DecideOptions;
  env?: NodeJS.ProcessEnv;
  fetch?: Fetch;
  /** drift in a Terragrunt repo: how Terragrunt runs. Default `TERRAGUCCI_TERRAGRUNT`, then `terragrunt` on the path. */
  terragrunt?: string;
  terragruntExec?: TerragruntExec;
}

export interface RespondResult {
  event: RespondEvent;
  /** The response the project takes to the event. */
  response: string;
  skipped?: string;
  text: string;
  data?: unknown;
  proposals?: Proposed[];
  /** The command's exit code when it is not 0. */
  exit?: number;
}

function readReport(path: string): Report {
  const file = existsSync(path) && statSync(path).isDirectory() ? join(path, "report.json") : path;
  if (!existsSync(file)) throw new ConfigError(`no report at ${file}`);
  return JSON.parse(readFileSync(file, "utf-8")) as Report;
}

/** The pull request's title and description from the job's event: GitHub and Forgejo's event file, or GitLab's merge request variables. */
function pullRequestText(env: NodeJS.ProcessEnv): { title: string; description: string } | undefined {
  if (env.CI_MERGE_REQUEST_TITLE !== undefined || env.CI_MERGE_REQUEST_DESCRIPTION !== undefined) {
    return { title: env.CI_MERGE_REQUEST_TITLE ?? "", description: env.CI_MERGE_REQUEST_DESCRIPTION ?? "" };
  }
  const file = env.GITHUB_EVENT_PATH;
  if (!file || !existsSync(file)) return undefined;
  try {
    const event = JSON.parse(readFileSync(file, "utf-8")) as { pull_request?: { title?: string | null; body?: string | null }; comment?: unknown; issue?: { title?: string | null; body?: string | null; pull_request?: unknown; is_pull?: boolean } };
    // A comment's event carries the pull request's title and body on its issue; Forgejo marks a pull with is_pull.
    const issue = event.comment && (event.issue?.pull_request || event.issue?.is_pull === true) ? event.issue : undefined;
    const pr = event.pull_request ?? issue;
    return pr ? { title: pr.title ?? "", description: pr.body ?? "" } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The pull request's title and description from the forge's API, for a job the
 * event file does not describe (a comment's event carries the title and body
 * itself, read above, so this is the fallback). The job's TG_PR, TG_FORGE and TG_TOKEN name the request and
 * carry the token; a failed call says nothing, so the check is skipped.
 */
async function pullRequestFromForge(env: NodeJS.ProcessEnv, fetchFn: Fetch): Promise<{ title: string; description: string } | undefined> {
  const number = env.TG_PR;
  const token = env.TG_TOKEN;
  if (!number || !/^\d+$/.test(number) || !token) return undefined;
  const gitlab = env.TG_FORGE === "gitlab";
  const api = gitlab ? env.CI_API_V4_URL : env.GITHUB_API_URL || (env.GITHUB_SERVER_URL ? `${env.GITHUB_SERVER_URL}/api/v1` : undefined);
  const project = gitlab ? (env.CI_PROJECT_ID ? `projects/${env.CI_PROJECT_ID}` : undefined) : env.GITHUB_REPOSITORY ? `repos/${env.GITHUB_REPOSITORY}` : undefined;
  if (!api || !project) return undefined;
  const url = `${api.replace(/\/+$/, "")}/${project}/${gitlab ? "merge_requests" : "pulls"}/${number}`;
  try {
    const res = await fetchFn(url, { method: "GET", headers: { accept: "application/json", ...(gitlab ? { "private-token": token } : { authorization: `token ${token}` }) } });
    if (!res.ok) return undefined;
    const pr = (await res.json()) as { title?: string | null; body?: string | null; description?: string | null };
    return { title: pr.title ?? "", description: (gitlab ? pr.description : pr.body) ?? "" };
  } catch {
    return undefined;
  }
}

const tail = (s: string): string => s.trim().split("\n").slice(-20).join("\n");

const said = (p: Proposed): string => `${p.title}: ${p.state}${p.pullRequest ? ` ${p.pullRequest}` : ""} (${p.branch}: ${p.files.join(", ") || "no files"})`;

export async function respond(event: string, repo: string, o: RespondOptions = {}): Promise<RespondResult> {
  if (o.mode) checkMode(o.mode);
  if (!(event in RESPONSES)) throw new ConfigError(`terragucci respond ${event}: the events are ${EVENTS.join(", ")}`);
  const ev = event as RespondEvent;
  const env = o.env ?? process.env;
  const path = o.config ?? findConfig(repo);
  let config: TerragucciConfig = {};
  if (o.base) {
    // An open pull request's head is checked out: its own terragucci.yml is not trusted to say how to respond. Fail closed when the base cannot be read.
    const read = await configAtBase(repo, o.base, path ? { config: path } : {});
    if ("error" in read) {
      const why = `respond ${ev} reads its settings from ${o.base} and that config could not be read (${read.error}), so there is no response`;
      return { event: ev, response: "off", skipped: why, text: why };
    }
    config = read.config;
  } else if (path) config = await loadConfig(resolve(path));
  // A control repo continues its rollouts from its own checkout, under its defaults' respond keys.
  const settings = o.project ? resolveProject(config, o.project) : ev === "rollout" && config.projects ? resolveRepo(config.defaults ?? {}) : resolveRepo(config);
  const response = responseTo(settings, ev);
  if (response === "off") return { event: ev, response, skipped: `respond.${ev} is off`, text: `respond.${ev} is off` };
  const mode = o.mode ?? "dry-run";
  const out = resolve(repo, o.out ?? "terragucci-respond");
  const roots = () => findRoots(repo, settings.roots).filter((r) => !o.root || globMatch(o.root, r));
  const binary = () => o.binary ?? settings.binary ?? (detectTerragrunt(repo) ? detectBinary(repo, []).value : detectBinary(repo, roots()).value);
  const need = (v: unknown, flag: string) => {
    if (!v) throw new ConfigError(`respond ${ev} needs ${flag}`);
  };
  let r: Omit<RespondResult, "event" | "response">;

  if (ev === "plan") {
    const dir = resolve(repo, o.report ?? "terragucci-report");
    need(existsSync(join(dir, "note.md")), "--report, the directory terragucci stage tf-plan wrote");
    r = { text: readFileSync(join(dir, "note.md"), "utf-8"), data: { report: join(dir, "report.json") } };
  } else if (ev === "wave-refused") {
    need(o.approved && o.current, "--approved and --current, each a report.json or its directory");
    const diff = refusedDiff(readReport(resolve(repo, o.approved!)), readReport(resolve(repo, o.current!)), o.wave);
    r = { text: describeRefused(diff), data: diff };
  } else if (ev === "apply-failed") {
    need(o.log !== undefined, "--log, the failed apply's output");
    const t = triage(o.log!);
    r = { text: describeTriage(t), data: t };
  } else if (ev === "drift") {
    if (settings.synth) throw new ConfigError(`respond drift: ${SYNTH_DRIFT_PR}`);
    const attributing = response === "attribute" ? { audit: o.audit ?? awsAuditLog({ region: settings.audit_region }), decide: settings.decide, options: o.decideOptions, known: knownAttributions(repo, o.attributions) } : undefined;
    const tg = detectTerragrunt(repo) !== undefined;
    const d = tg
      ? await driftUnits(repo, binary(), o, env, settings, attributing)
      : await drift(repo, roots(), binary(), o.imports ?? [], env, attributing);
    const body = [
      ...d.routed,
      ...d.notes.map((n) => `- ${n}`),
      ...d.codified.map((c) => `- \`${c.file}\`: \`${c.address}\` \`${c.path}\` ${c.from} -> ${c.to}`),
      ...d.imports.map((i) => `- import ${i}`),
      ...d.left.map((l) => `- not codified: \`${l.address}\`${l.path ? ` \`${l.path}\`` : ""}: ${l.reason}`),
    ].join("\n");
    const proposed = await propose(repo, settings, d.files.size ? [{ branch: "terragucci/drift", title: "Codify drift", body: `A refresh-only plan found drift. Merging this accepts the change made outside Terraform.\n\n${body}`, files: d.files }] : [], { mode, env, fetch: o.fetch });
    r = { text: [body || "no drift", ...proposed.map(said)].join("\n"), data: { codified: d.codified, imports: d.imports, left: d.left, ...(attributing ? { attributions: d.attributions, notes: d.notes } : {}) }, proposals: proposed };
  } else if (ev === "tips") {
    // With a plan's report, the tips its plans show (a rename's moved block), into --branch; otherwise the repo's own.
    // With synth the roots are on disk only once the command has run, as the tips job runs it.
    if (!o.report && settings.synth && roots().length === 0) throw new ConfigError(`respond tips found no roots: synth writes them, so run ${settings.synth} first`);
    const tips = o.report
      ? { proposals: movedProposals(repo, reportRenames(resolve(repo, o.report)).filter((x) => !o.root || globMatch(o.root, x.root)), o.branch), left: [] as string[] }
      : tipProposals(repo, roots(), binary(), { canary: settings.waves?.canary, platforms: o.platforms, synth: Boolean(settings.synth) });
    const proposed = await propose(repo, settings, tips.proposals, { mode, env, fetch: o.fetch });
    r = { text: [...tips.left, ...proposed.map(said)].join("\n") || "no tip to fix", proposals: proposed };
  } else if (ev === "fmt") {
    r = await fmt(repo, settings, binary(), mode, o, env);
  } else if (ev === "publish") {
    const notes = findModules(repo, settings.modules?.path ?? "modules/*")
      .filter((m) => !o.module || m.rel === o.module.replace(/\/+$/, ""))
      .flatMap((m) => moduleNotes(repo, m.rel, o.version) ?? []);
    const text = notes.map((n) => `## ${n.module} ${n.version}\n\n${n.notes}`).join("\n\n");
    if (text) {
      mkdirSync(out, { recursive: true });
      writeFileSync(join(out, "notes.md"), `${text}\n`);
    }
    r = { text: text || "no published module", data: notes };
  } else if (ev === "version-bump") {
    const { suggestions, proposals } = await versionBumps(repo, settings, { module: o.module, since: o.since, env, fetch: o.decideFetch });
    const proposed = await propose(repo, settings, proposals, { mode, env, fetch: o.fetch });
    const lines = suggestions.map((s) => `${s.module} ${s.last}${s.version ? ` -> ${s.version}` : ""}: ${s.note}`);
    r = { text: [...lines, ...proposed.map(said)].join("\n") || "no module", data: suggestions, proposals: proposed };
  } else if (ev === "description") {
    const dir = resolve(repo, o.report ?? "terragucci-report");
    need(existsSync(join(dir, "report.json")), "--report, the directory terragucci stage tf-plan wrote");
    const pr = o.title !== undefined || o.description !== undefined ? { title: o.title ?? "", description: o.description ?? "" } : (pullRequestText(env) ?? (await pullRequestFromForge(env, o.fetch ?? (globalThis.fetch as unknown as Fetch))));
    if (!pr || (!pr.title && !pr.description)) return { event: ev, response, skipped: "no pull request title or description to read", text: "no pull request title or description to read; the note is unchanged" };
    const c = await checkDescription({ dir, ...pr, decide: settings.decide, write: mode === "apply", env, fetch: o.decideFetch });
    // The stage copied the report to the bucket before this ran: copy what the check changed over it.
    let copied = "";
    if (c.files.length > 0 && settings.reports?.bucket) {
      try {
        const report = JSON.parse(readFileSync(join(dir, "report.json"), "utf-8")) as Report;
        const put = await copyToRun(storeFromEnv(settings.reports, env, o.s3Fetch), dir, report, c.files, settings.reports.prefix);
        copied = `\ncopied ${c.files.join(", ")} to the bucket under ${put[0].slice(0, put[0].lastIndexOf("/"))}`;
      } catch (e) {
        copied = `\nthe bucket's copy was not updated: ${(e as Error).message}`;
      }
    }
    r = { text: c.text + copied, data: c.record };
  } else {
    // rollout with no module named: continue every rollout in flight. `respond rollout <module> [<version>]` runs `terragucci rollout` itself (cli.ts).
    const c = await continueRollouts(repo, { mode, config: o.config, env, ...(o.fetch ? { fetch: o.fetch } : {}) });
    r = { text: describeContinue(c), data: c, ...(continueExit(c) ? { exit: continueExit(c) } : {}) };
  }

  return { event: ev, response, ...r };
}

// ── drift ────────────────────────────────────────────────────────────────────

const IMPORTS = "terragucci_imports.tf";
const GENERATED = "terragucci_generated.tf";

/** The attributions the stage made, from the given map or file, or the stage's default file when it is there. */
function knownAttributions(repo: string, given: RespondOptions["attributions"]): Record<string, Attributed> | undefined {
  if (given && typeof given !== "string") return given;
  const file = resolve(repo, given ?? join("terragucci-report", ATTRIBUTIONS_FILE));
  if (!existsSync(file)) {
    if (given) throw new ConfigError(`--attributions ${given}: no such file`);
    return undefined;
  }
  return JSON.parse(readFileSync(file, "utf-8")) as Record<string, Attributed>;
}

async function drift(repo: string, roots: string[], binary: string, imports: { address: string; id: string }[], env: NodeJS.ProcessEnv, attributing?: { audit: AuditLog; decide?: ResolvedSettings["decide"]; options?: DecideOptions; known?: Record<string, Attributed> }) {
  if (roots.length === 0) throw new ConfigError("no root matches");
  if (imports.length && roots.length !== 1) throw new ConfigError(`--import needs --root to name one root; ${roots.length} match`);
  const d = { codified: [] as Codified[], left: [] as Left[], files: new Map<string, string>(), imports: [] as string[], attributions: [] as Attribution[], routed: [] as string[], notes: [] as string[] };
  for (const root of roots) {
    const dir = join(repo, root);
    const run = (...args: string[]) => {
      const p = spawnSync(binary, [`-chdir=${dir}`, args[0]!, "-no-color", ...args.slice(1)], { encoding: "utf-8", maxBuffer: 1 << 29, env: binaryEnv(env) });
      if (p.status !== 0 && args[0] !== "query" && !args.some((a) => a.startsWith("-generate"))) throw new ConfigError(`${root}: ${binary} ${args[0]} failed:\n${tail(p.stderr || p.stdout)}`);
      return p;
    };
    const planFile = join(dir, ".terragucci-drift.tfplan");
    try {
      run("init", "-input=false");
      run("plan", "-refresh-only", "-input=false", "-lock=false", `-out=${planFile}`);
      let found = driftOf(JSON.parse(run("show", "-json", planFile).stdout));
      if (attributing) {
        const at = attributing.known?.[root] ?? (await attribute(root, found, attributing));
        const routed = route(at.attributions);
        found = withoutLeft(found, routed.leave);
        d.attributions.push(...at.attributions);
        d.routed.push(...routed.lines.map((l) => `${root}: ${l.slice(2)}`).map((l) => `- ${l}`));
        d.notes.push(...at.notes.filter((n) => !d.notes.includes(n)));
      }
      const c = codify(root, dir, found);
      d.codified.push(...c.codified);
      d.left.push(...c.left);
      for (const [f, text] of c.files) d.files.set(posix.join(root, f), text);
    } finally {
      rmSync(planFile, { force: true });
    }
    const query = binary === "terraform" && hasQuery(dir);
    if (!imports.length && !query) continue;
    for (const f of [IMPORTS, GENERATED]) if (existsSync(join(dir, f))) throw new ConfigError(`${root}/${f} exists; merge or remove it first`);
    try {
      if (imports.length) writeFileSync(join(dir, IMPORTS), importBlocks(imports));
      // Both write the file even when the config they generate still needs a hand.
      const g = query ? run("query", `-generate-config-out=${GENERATED}`) : run("plan", "-input=false", "-lock=false", `-generate-config-out=${GENERATED}`);
      if (!existsSync(join(dir, GENERATED))) throw new ConfigError(`${root}: ${binary} generated no config:\n${tail(g.stderr || g.stdout)}`);
      for (const f of [IMPORTS, GENERATED]) if (existsSync(join(dir, f))) d.files.set(posix.join(root, f), readFileSync(join(dir, f), "utf-8"));
      d.imports.push(...(imports.length ? imports.map((i) => `${root}: ${i.address} (${i.id})`) : [`${root}: what terraform query lists`]));
    } finally {
      for (const f of [IMPORTS, GENERATED]) rmSync(join(dir, f), { force: true });
    }
  }
  return d;
}

/**
 * Drift in a Terragrunt repo's units (./drift-units.ts): each drifted unit
 * planned again through Terragrunt, attributed as a root is, and brought in
 * line in its own terragrunt.hcl where its inputs set the value.
 */
async function driftUnits(repo: string, binary: string, o: RespondOptions, env: NodeJS.ProcessEnv, settings: ResolvedSettings, attributing?: { audit: AuditLog; decide?: ResolvedSettings["decide"]; options?: DecideOptions; known?: Record<string, Attributed> }) {
  if (o.imports?.length) throw new ConfigError("--import writes import blocks into a root's own files, and a Terragrunt unit's resources are in its module; import into a unit with an import block in its module, through a reviewed change");
  const r = unitRunner(binary, env, { ...(o.terragrunt ? { terragrunt: o.terragrunt } : {}), ...(o.terragruntExec ? { exec: o.terragruntExec } : {}) });
  const { units, from } = await driftedUnits(repo, r, { ...(o.report ? { report: o.report } : {}), ...(o.root ? { root: o.root } : {}), ...(settings.terragrunt?.exclude ? { exclude: settings.terragrunt.exclude } : {}) });
  const d = { codified: [] as Codified[], left: [] as Left[], files: new Map<string, string>(), imports: [] as string[], attributions: [] as Attribution[], routed: [] as string[], notes: [] as string[] };
  if (units.length === 0) return d;
  d.notes.push(`${units.length} unit${units.length === 1 ? "" : "s"} from ${from}: ${units.join(", ")}`);
  for (const unit of units) {
    let found = await unitDrift(repo, unit, r);
    if (found.length === 0) continue;
    if (attributing) {
      const at = attributing.known?.[unit] ?? (await attribute(unit, found, attributing));
      const routed = route(at.attributions);
      found = withoutLeft(found, routed.leave);
      d.attributions.push(...at.attributions);
      d.routed.push(...routed.lines.map((l) => `${unit}: ${l.slice(2)}`).map((l) => `- ${l}`));
      d.notes.push(...at.notes.filter((n) => !d.notes.includes(n)));
    }
    const c = await codifyUnitDrift(repo, unit, found, r, d.files);
    d.codified.push(...c.codified);
    d.left.push(...c.left);
  }
  return d;
}

// ── fmt ──────────────────────────────────────────────────────────────────────

async function fmt(repo: string, settings: ResolvedSettings, binary: string, mode: string, o: RespondOptions, env: NodeJS.ProcessEnv) {
  const branch = o.branch ?? env.GITHUB_HEAD_REF ?? env.CI_MERGE_REQUEST_SOURCE_BRANCH_NAME;
  if (!branch) throw new ConfigError("respond fmt needs --branch, the pull request's branch");
  if (mode === "apply" && branch === (await defaultBranch(o.fetch ?? (globalThis.fetch as unknown as Fetch), forgeOf(repo, settings, env)))) {
    throw new ConfigError(`${branch} is the default branch; fmt commits only to a pull request's branch`);
  }
  git(repo, ["fetch", "-q", "origin", branch]);
  const tree = worktree(repo, "FETCH_HEAD");
  try {
    const f = spawnSync(binary, ["fmt", "-recursive", "-list=true", ...(mode === "apply" ? [] : ["-check"])], { cwd: tree.dir, encoding: "utf-8", env: binaryEnv(env) });
    if (f.error) throw new ConfigError(`respond fmt could not run ${binary}: ${f.error.message}`);
    const listed = f.stdout.split("\n").filter(Boolean);
    // -check exits non-zero when it lists a file; non-zero with nothing listed
    // is a file fmt could not parse, which is not "already formatted".
    if (f.status !== 0 && listed.length === 0) throw new ConfigError(`${branch}: ${binary} fmt failed:\n${tail(f.stderr || f.stdout)}`);
    const tools = listed.length ? [`${binary} fmt`] : [];
    let files = listed;
    // A Terragrunt repo's own files are HCL the binary does not read: terragrunt hcl fmt formats them, in this
    // throwaway checkout, and git names what it changed.
    if (detectTerragrunt(tree.dir)) {
      const terragrunt = env.TERRAGUCCI_TERRAGRUNT ?? "terragrunt";
      const h = spawnSync(terragrunt, ["hcl", "fmt", "--no-color"], { cwd: tree.dir, encoding: "utf-8", env: binaryEnv({ ...env, TG_NON_INTERACTIVE: "true" }) });
      if (h.error) throw new ConfigError(`respond fmt could not run ${terragrunt}: ${h.error.message}`);
      if (h.status !== 0) throw new ConfigError(`${branch}: terragrunt hcl fmt failed:\n${tail(h.stderr || h.stdout)}`);
      const changed = git(tree.dir, ["diff", "--name-only"]).split("\n").filter((p) => p.endsWith(".hcl"));
      if (changed.length) tools.push("terragrunt hcl fmt");
      files = [...new Set([...files, ...changed])];
    }
    files.sort();
    const data = { branch, files };
    const what = tools.join(" and ");
    if (files.length === 0) return { text: `${branch}: already formatted`, data };
    if (mode !== "apply") return { text: `${branch}: would commit ${what} on ${files.join(", ")}`, data };
    git(tree.dir, ["add", "-A"]);
    git(tree.dir, [...IDENTITY, "commit", "-q", "--no-verify", "-m", `style: ${what}`]);
    git(tree.dir, ["push", "-q", "origin", `HEAD:refs/heads/${branch}`]);
    return { text: `${branch}: committed ${what} on ${files.join(", ")}`, data };
  } finally {
    tree.done();
  }
}
