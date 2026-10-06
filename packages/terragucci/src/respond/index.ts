/**
 * `terragucci respond <event>`: the response to a pipeline event. Each event
 * has a deterministic response, the default, which needs no model. A project
 * sets `respond.<event>: agent` to add an agent on top: the deterministic
 * response still runs, and its result is written as the agent's input, with
 * what the agent may do. The agent comments or proposes; it never approves,
 * applies, merges or resolves a gate, and nothing here gives it the means to.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, posix, resolve } from "node:path";
import { checkMode, ConfigError, findConfig, loadConfig, resolveProject, resolveRepo, responseTo, RESPONSES, type RespondEvent, type ResolvedSettings } from "../config";
import { detectBinary, findRoots, globMatch } from "../detect";
import { defaultBranch, type Fetch } from "../forge";
import { findModules } from "../publish";
import type { Report } from "../report/schema";
import { S3Client, s3FromEnv, type S3Fetch } from "../report/s3";
import { copyToRun } from "../report/store";
import { forgeOf, git, propose, worktree, type Proposed } from "./change";
import { IDENTITY } from "../reconcile";
import { attribute, awsAuditLog, route, withoutLeft, type Attribution, type AuditLog } from "./attribute";
import type { DecideOptions } from "../decide";
import { codify, driftOf, hasQuery, importBlocks, type Codified, type Left } from "./drift";
import { checkDescription } from "./intent";
import { moduleNotes } from "./notes";
import { describeRefused, refusedDiff } from "./refused";
import { tipProposals } from "./tips";
import { versionBumps } from "./version-bump";
import type { DecideFetch } from "../decide";
import { describeTriage, triage } from "./triage";

export const EVENTS = Object.keys(RESPONSES) as RespondEvent[];

/** What an agent response may do, and what it never does, written into its input. */
export const AGENT_MAY = ["comment", "open a pull request for a person to review"];
export const AGENT_NEVER = ["approve", "apply", "resolve or re-approve a gate", "merge", "push to the default branch", "state rm, import or force-unlock"];

export interface RespondOptions {
  config?: string;
  project?: string;
  mode?: "dry-run" | "apply";
  /** Where the response writes its files. Default `terragucci-respond`. */
  out?: string;
  /** plan: the report directory. */
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
  /** fmt: the pull request's branch. */
  branch?: string;
  /** publish: one module's path, and a version of it. */
  module?: string;
  version?: string;
  /** version-bump: the ref to count changes from when a module has no release tag. */
  since?: string;
  question?: string;
  /** version-bump and description: the decision service's HTTP client, for tests. */
  decideFetch?: DecideFetch;
  /** description: the pull request's title and description; by default read from the job's event. */
  title?: string;
  description?: string;
  /** description: the S3 client's HTTP calls, for tests. */
  s3Fetch?: S3Fetch;
  /** drift, with respond.drift set to attribute: the audit log to read (default CloudTrail through the aws CLI). */
  audit?: AuditLog;
  /** drift, with respond.drift set to attribute: how the decision client reaches its service. */
  decideOptions?: DecideOptions;
  env?: NodeJS.ProcessEnv;
  fetch?: Fetch;
}

export interface RespondResult {
  event: RespondEvent;
  /** The response the project takes to the event. */
  response: string;
  skipped?: string;
  text: string;
  data?: unknown;
  proposals?: Proposed[];
  /** The agent's input file, when the response is `agent`. */
  agent_input?: string;
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
  const config = path ? await loadConfig(resolve(path)) : {};
  const settings = o.project ? resolveProject(config, o.project) : resolveRepo(config);
  const response = responseTo(settings, ev);
  if (response === "off") return { event: ev, response, skipped: `respond.${ev} is off`, text: `respond.${ev} is off` };
  const mode = o.mode ?? "dry-run";
  const out = resolve(repo, o.out ?? "terragucci-respond");
  const agent = response === "agent";
  const roots = () => findRoots(repo, settings.roots).filter((r) => !o.root || globMatch(o.root, r));
  const binary = () => o.binary ?? settings.binary ?? detectBinary(repo, roots()).value;
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
    r = { text: describeTriage(t, agent), data: t };
  } else if (ev === "drift") {
    const attributing = response === "attribute" ? { audit: o.audit ?? awsAuditLog({ region: settings.audit_region }), decide: settings.decide, options: o.decideOptions } : undefined;
    const d = await drift(repo, roots(), binary(), o.imports ?? [], env, attributing);
    const body = [
      ...d.routed,
      ...d.notes.map((n) => `- ${n}`),
      ...d.codified.map((c) => `- \`${c.file}\`: \`${c.address}\` \`${c.path}\` ${c.from} -> ${c.to}`),
      ...d.imports.map((i) => `- import ${i}`),
      ...d.left.map((l) => `- not codified${agent ? " (an agent may propose it)" : ""}: \`${l.address}\`${l.path ? ` \`${l.path}\`` : ""}: ${l.reason}`),
    ].join("\n");
    const proposed = await propose(repo, settings, d.files.size ? [{ branch: "terragucci/drift", title: "Codify drift", body: `A refresh-only plan found drift. Merging this accepts the change made outside Terraform.\n\n${body}`, files: d.files }] : [], { mode, env, fetch: o.fetch });
    r = { text: [body || "no drift", ...proposed.map(said)].join("\n"), data: { codified: d.codified, imports: d.imports, left: d.left, ...(attributing ? { attributions: d.attributions, notes: d.notes } : {}) }, proposals: proposed };
  } else if (ev === "tips") {
    const proposed = await propose(repo, settings, tipProposals(repo, roots(), binary(), { canary: settings.waves?.canary, platforms: o.platforms }), { mode, env, fetch: o.fetch });
    r = { text: proposed.map(said).join("\n") || "no tip to fix", proposals: proposed };
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
        const put = await copyToRun(new S3Client(s3FromEnv(settings.reports, env), o.s3Fetch), dir, report, c.files, settings.reports.prefix);
        copied = `\ncopied ${c.files.join(", ")} to the bucket under ${put[0].slice(0, put[0].lastIndexOf("/"))}`;
      } catch (e) {
        copied = `\nthe bucket's copy was not updated: ${(e as Error).message}`;
      }
    }
    r = { text: c.text + copied, data: c.record };
  } else if (ev === "question") {
    need(o.question, "--question");
    r = { text: "an agent answers from the report and the code", data: { question: o.question } };
  } else throw new ConfigError("respond rollout runs terragucci rollout; pass its arguments");

  if (agent) {
    mkdirSync(out, { recursive: true });
    const file = join(out, `${ev}.json`);
    const a = settings.agent!;
    const input = { schema: "terragucci.respond/v1", event: ev, deterministic: { text: r.text, data: r.data ?? null, proposals: r.proposals ?? [] }, agent: { ...a, may: AGENT_MAY, never: AGENT_NEVER } };
    writeFileSync(file, JSON.stringify(input, null, 2) + "\n");
    r.agent_input = file;
  }
  return { event: ev, response, ...r };
}

// ── drift ────────────────────────────────────────────────────────────────────

const IMPORTS = "terragucci_imports.tf";
const GENERATED = "terragucci_generated.tf";

async function drift(repo: string, roots: string[], binary: string, imports: { address: string; id: string }[], env: NodeJS.ProcessEnv, attributing?: { audit: AuditLog; decide?: ResolvedSettings["decide"]; options?: DecideOptions }) {
  if (roots.length === 0) throw new ConfigError("no root matches");
  if (imports.length && roots.length !== 1) throw new ConfigError(`--import needs --root to name one root; ${roots.length} match`);
  const d = { codified: [] as Codified[], left: [] as Left[], files: new Map<string, string>(), imports: [] as string[], attributions: [] as Attribution[], routed: [] as string[], notes: [] as string[] };
  for (const root of roots) {
    const dir = join(repo, root);
    const run = (...args: string[]) => {
      const p = spawnSync(binary, [`-chdir=${dir}`, args[0]!, "-no-color", ...args.slice(1)], { encoding: "utf-8", maxBuffer: 1 << 29, env });
      if (p.status !== 0 && args[0] !== "query" && !args.some((a) => a.startsWith("-generate"))) throw new ConfigError(`${root}: ${binary} ${args[0]} failed:\n${tail(p.stderr || p.stdout)}`);
      return p;
    };
    const planFile = join(dir, ".terragucci-drift.tfplan");
    try {
      run("init", "-input=false");
      run("plan", "-refresh-only", "-input=false", "-lock=false", `-out=${planFile}`);
      let found = driftOf(JSON.parse(run("show", "-json", planFile).stdout));
      if (attributing) {
        const at = await attribute(root, found, attributing);
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
    const f = spawnSync(binary, ["fmt", "-recursive", "-list=true", ...(mode === "apply" ? [] : ["-check"])], { cwd: tree.dir, encoding: "utf-8", env });
    const files = f.stdout.split("\n").filter(Boolean).sort();
    const data = { branch, files };
    if (files.length === 0) return { text: `${branch}: already formatted`, data };
    if (mode !== "apply") return { text: `${branch}: would commit ${binary} fmt on ${files.join(", ")}`, data };
    git(tree.dir, ["add", "-A"]);
    git(tree.dir, [...IDENTITY, "commit", "-q", "--no-verify", "-m", `style: ${binary} fmt`]);
    git(tree.dir, ["push", "-q", "origin", `HEAD:refs/heads/${branch}`]);
    return { text: `${branch}: committed ${binary} fmt on ${files.join(", ")}`, data };
  } finally {
    tree.done();
  }
}
