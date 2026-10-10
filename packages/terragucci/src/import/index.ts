/**
 * `terragucci import atlantis [atlantis.yaml]`, `terragucci import digger
 * [digger.yml]` and `terragucci import terrateam [.terrateam/config.yml]`:
 * write terragucci.yml from an Atlantis repo config, an OpenTaco (digger)
 * config or a Terrateam config (./terrateam.ts), and say what became of
 * every setting.
 *
 * The mapping is the guide's (./guide.ts holds its tables, which a test holds
 * equal to the page). Each setting the file carries ends up as one note:
 *
 *   mapped     written into terragucci.yml
 *   default    terragucci does that job with no key
 *   unmapped   nothing written, and the page's cell says why
 *   left-out   terragucci leaves it out on purpose; the page's rule and what
 *              to do instead
 *
 * A key the guide has no row for is unmapped and named as such.
 *
 * The source tools apply before merge by default, so the import writes
 * `apply.when: pull-request` unless the file applies after merge
 * (`on_commit_to_default: [digger apply]`), `--apply-when merge` says so, or
 * the forge is GitLab, where applying before merge needs a schedule and a
 * token this command cannot name.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { emitYAML, parseYAML } from "@intentius/chant/yaml";
import {
  APPLY_REQUIRES,
  ConfigError,
  findConfig,
  NO_GITLAB_PLAN_LOCKS,
  PR_APPLY_NEEDS_ON_GITLAB,
  validateConfig,
  type ApplyRequire,
  type ApplyWhen,
  type ForgeName,
  type ProjectSettings,
} from "../config";
import { applyLayers, detectForge, findRoots, rootDependencies } from "../detect";
import { APPLY_TIMING_TABLE, GUIDE_URL, plain, TERRATEAM_URL, type SettingRow } from "./guide";
import { isMap, list, Notes, rootOf, wavesAfterOf, type ImportNote, type NoteKind } from "./notes";
import { convertTerrateam, type RepoShape } from "./terrateam";

export { rootOf, type ImportNote, type NoteKind } from "./notes";

export const IMPORT_SOURCES = ["atlantis", "digger", "terrateam"] as const;
export type ImportSource = (typeof IMPORT_SOURCES)[number];

/** The file each source reads when none is named, first found wins. */
export const SOURCE_FILES: Record<ImportSource, string[]> = {
  atlantis: ["atlantis.yaml", "atlantis.yml"],
  digger: ["digger.yml", "digger.yaml"],
  terrateam: [".terrateam/config.yml", ".terrateam/config.yaml"],
};

const SOURCE_NAMES: Record<ImportSource, string> = { atlantis: "Atlantis", digger: "OpenTaco", terrateam: "Terrateam" };

export interface Converted {
  settings: ProjectSettings;
  notes: ImportNote[];
}

export interface ImportOptions {
  /** The forge the repo runs on; GitLab changes what can be written. */
  forge?: ForgeName;
  /** Overrides when the change applies; otherwise the source tool's own timing. */
  applyWhen?: ApplyWhen;
  /** The repo's roots and their order, which depends_on is read against. */
  repo?: RepoShape;
}

/** A source requirement as terragucci's: the guide's Required approval, Checks green and Up to date rows. */
const REQUIREMENTS: Record<string, { row: SettingRow; to: ApplyRequire[] }> = {
  approved: { row: "Required approval", to: ["approved"] },
  mergeable: { row: "Checks green", to: ["mergeable", "checks"] },
  undiverged: { row: "Up to date", to: ["undiverged"] },
};

/** The guide's row for when a tool applies, as one line: Atlantis's or OpenTaco's default against terragucci's. */
function timingText(source: "atlantis" | "digger"): string {
  const [def, other] = APPLY_TIMING_TABLE;
  const col = source === "atlantis" ? 1 : 2;
  return `${source === "atlantis" ? "Atlantis" : "OpenTaco"} applies ${plain(def[col])} by default, terragucci ${plain(def[3])}; the other way is ${plain(other[3])}`;
}

/** The settings both tools share once their files are read: roots, timing, requirements, merge, locks, versions, env. */
interface Gathered {
  roots: string[];
  /** True when the file says it applies after merge. */
  afterMerge: boolean;
  /** Each requirement named, with the keys that named it. */
  requirements: Map<string, string[]>;
  /** How many projects named any requirement, of how many. */
  projectsWithRequirements: number;
  projects: number;
  autoMerge?: string;
  planLocks?: string;
  versions: Map<string, string[]>;
  tofu: string[];
  env: Map<string, { value: string; key: string }>;
  envConflicts: Set<string>;
  /** Each project's root by its name, which depends_on names. */
  named: Map<string, string>;
  /** Each project's depends_on, with its key and root. */
  dependsOn: { at: string; root: string; names: unknown }[];
  /** Projects Terragrunt runs (OpenTaco's `terragrunt`). */
  terragrunt: boolean;
}

function gathered(): Gathered {
  return { roots: [], afterMerge: false, requirements: new Map(), projectsWithRequirements: 0, projects: 0, versions: new Map(), tofu: [], env: new Map(), envConflicts: new Set(), named: new Map(), dependsOn: [], terragrunt: false };
}

/** An env step's variable with a fixed value; anything else is a custom step. */
function takeEnv(g: Gathered, notes: Notes, key: string, name: unknown, value: unknown): void {
  if (typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || typeof value !== "string") {
    notes.unmapped(key, "Custom steps", "it sets no fixed value, so it stays out of `env`");
    return;
  }
  const had = g.env.get(name);
  if (had && had.value !== value) {
    g.envConflicts.add(name);
    notes.unmapped(key, "Custom steps", `${name} is set to two values (in ${had.key} too), and \`env\` holds one`);
    return;
  }
  if (!had) g.env.set(name, { value, key });
}

/** The steps both tools write: built-in names, `extra_args`, `run`, `env`. */
function steps(g: Gathered, notes: Notes, key: string, raw: unknown): void {
  list(raw).forEach((step, i) => {
    const at = `${key}[${i}]`;
    if (typeof step === "string") {
      if (step === "policy_check") notes.unmapped(at, "Policy", "set `policy:` and keep the Rego in the repo");
      else if (step === "import" || step === "state_rm") notes.leftOut(at, "`import` or `state rm` from a comment");
      return;
    }
    if (!isMap(step)) return notes.unknown(at);
    for (const [name, body] of Object.entries(step)) {
      const k = `${at}.${name}`;
      if (name === "env") {
        if (isMap(body)) takeEnv(g, notes, k, body.name, body.value);
        else notes.unmapped(k, "Custom steps");
      } else if (name === "run" || name === "multienv") notes.unmapped(k, "Custom steps");
      else if (isMap(body) && body.extra_args !== undefined) notes.leftOut(`${k}.extra_args`, "Flags at run time");
      else if (name === "policy_check") notes.unmapped(k, "Policy", "set `policy:` and keep the Rego in the repo");
      else if (name === "import" || name === "state_rm") notes.leftOut(k, "`import` or `state rm` from a comment");
      else if (!["init", "plan", "apply", "show"].includes(name)) notes.unknown(k);
    }
  });
}

/** A project's name, for depends_on to name it by. */
function takeName(g: Gathered, p: Record<string, unknown>, root: string | undefined): void {
  if (typeof p.name === "string" && root !== undefined && !g.named.has(p.name)) g.named.set(p.name, root);
}

/**
 * depends_on as `waves.after`: each project after the projects it names, by
 * their roots. A dependency the reads already give needs nothing; a name no
 * project has, and a cycle, are named and not written.
 */
function dependsOnOrder(g: Gathered, notes: Notes, s: ProjectSettings, reads?: ReadonlyMap<string, ReadonlySet<string>>): void {
  if (!g.dependsOn.length) return;
  if (g.terragrunt) {
    for (const d of g.dependsOn) notes.unmapped(d.at, "Order", "in a Terragrunt repo the units' dependency blocks order them");
    return;
  }
  const edges: { at: string; d: string; u: string }[] = [];
  for (const d of g.dependsOn) {
    const names = list(d.names);
    const unknown = names.filter((n) => typeof n !== "string" || !g.named.has(n));
    if (unknown.length) notes.unmapped(`${d.at}: ${unknown.map(String).join(", ")}`, "Order", `${unknown.map((n) => JSON.stringify(n)).join(", ")} ${unknown.length === 1 ? "names" : "name"} no project`);
    for (const n of names) if (typeof n === "string" && g.named.has(n) && g.named.get(n) !== d.root) edges.push({ at: d.at, d: d.root, u: g.named.get(n)! });
  }
  const { after, fromReads, cycle } = wavesAfterOf(edges.map((e) => [e.d, e.u] as const), reads);
  if (Object.keys(after).length) s.waves = { ...s.waves, after };
  const byKey = new Map<string, typeof edges>();
  for (const e of edges) byKey.set(e.at, [...(byKey.get(e.at) ?? []), e]);
  for (const [key, es] of byKey) {
    const fmt = (xs: typeof es) => xs.map((e) => `${e.d} after ${e.u}`).join(", ");
    const written = es.filter((e) => !fromReads.has(`${e.d}\0${e.u}`));
    if (cycle && written.length) notes.unmapped(key, "Order", `${fmt(written)} ${written.length === 1 ? "is" : "are"} not kept: with the terraform_remote_state reads they make a cycle, ${cycle.join(" after ")}`);
    else if (!written.length) notes.covered(key, "Order", `the terraform_remote_state reads already order ${fmt(es)}`);
    else notes.mapped(key, "Order", `waves.after: ${fmt(written)}`);
  }
}

/** One project's apply requirements. */
function takeRequirements(g: Gathered, notes: Notes, key: string, raw: unknown): void {
  const reqs = list(raw);
  if (reqs.length) g.projectsWithRequirements++;
  for (const r of reqs) {
    if (typeof r === "string" && REQUIREMENTS[r]) g.requirements.set(r, [...(g.requirements.get(r) ?? []), key]);
    else notes.unknown(`${key}: ${String(r)}`);
  }
}

// ── Atlantis ────────────────────────────────────────────────────────────────

const ATLANTIS_PROJECT_KEYS = new Set([
  "name", "dir", "workspace", "terraform_version", "autoplan", "apply_requirements", "plan_requirements", "import_requirements",
  "execution_order_group", "depends_on", "workflow", "repo_locks", "custom_policy_check",
]);

function readAtlantis(doc: Record<string, unknown>, g: Gathered, notes: Notes): void {
  for (const k of Object.keys(doc)) {
    if (!["version", "projects", "workflows", "automerge", "parallel_plan", "parallel_apply", "autodiscover", "abort_on_execution_order_fail", "repo_locks"].includes(k)) notes.unknown(k);
  }
  if (doc.autodiscover !== undefined) notes.covered("autodiscover", "Which directories");
  if (doc.abort_on_execution_order_fail !== undefined) notes.unmapped("abort_on_execution_order_fail", "Order");
  if (doc.automerge === true) g.autoMerge = "automerge";
  if (doc.repo_locks !== undefined) locks(g, notes, "repo_locks", doc.repo_locks);
  const projects = list(doc.projects);
  g.projects = projects.length;
  projects.forEach((p, i) => {
    if (!isMap(p)) return notes.unknown(`projects[${i}]`);
    const root = rootOf(p.dir ?? ".");
    const at = `projects[${typeof p.name === "string" ? p.name : root ?? i}]`;
    for (const k of Object.keys(p)) if (!ATLANTIS_PROJECT_KEYS.has(k)) notes.unknown(`${at}.${k}`);
    if (root === undefined) notes.unmapped(`${at}.dir`, "Which directories", `${JSON.stringify(p.dir)} is not a directory inside the repo`);
    else if (!g.roots.includes(root)) g.roots.push(root);
    if (p.name !== undefined) notes.covered("projects[].name", "Project name");
    if (p.workspace !== undefined && p.workspace !== "default") notes.unmapped(`${at}.workspace`, "Workspace", `workspace ${String(p.workspace)} is not planned`);
    if (typeof p.terraform_version === "string") g.versions.set(p.terraform_version.replace(/^v/, ""), [...(g.versions.get(p.terraform_version.replace(/^v/, "")) ?? []), at]);
    if (isMap(p.autoplan)) {
      if (p.autoplan.when_modified !== undefined) notes.covered("projects[].autoplan.when_modified", "What triggers a plan");
      if (p.autoplan.enabled === false) notes.unmapped(`${at}.autoplan.enabled`, "What triggers a plan", "no key turns the plan off for a root");
    }
    takeRequirements(g, notes, `${at}.apply_requirements`, p.apply_requirements);
    if (p.plan_requirements !== undefined) notes.unmapped(`${at}.plan_requirements`, "Plan requirements");
    if (p.import_requirements !== undefined) notes.leftOut(`${at}.import_requirements`, "`import` or `state rm` from a comment");
    if (p.execution_order_group !== undefined) notes.unmapped(`${at}.execution_order_group`, "Order");
    takeName(g, p, root);
    if (p.depends_on !== undefined && root !== undefined) g.dependsOn.push({ at: `${at}.depends_on`, root, names: p.depends_on });
    if (p.repo_locks !== undefined) locks(g, notes, `${at}.repo_locks`, p.repo_locks);
    if (p.custom_policy_check !== undefined) notes.unmapped(`${at}.custom_policy_check`, "Policy");
  });
  for (const k of ["parallel_plan", "parallel_apply"] as const) {
    if (doc[k] === false) notes.mapped(k, "Concurrency", "parallelism: 1");
    else if (doc[k] !== undefined) notes.covered(k, "Concurrency");
  }
  if (isMap(doc.workflows)) {
    for (const [name, wf] of Object.entries(doc.workflows)) {
      if (!isMap(wf)) continue;
      notes.unmapped(`workflows.${name}`, "Custom steps");
      for (const [stage, body] of Object.entries(wf)) {
        const at = `workflows.${name}.${stage}`;
        if (stage === "import" || stage === "state_rm") notes.leftOut(at, "`import` or `state rm` from a comment");
        else if (stage === "policy_check") notes.unmapped(at, "Policy", "set `policy:` and keep the Rego in the repo");
        else if (stage === "plan" || stage === "apply") steps(g, notes, `${at}.steps`, isMap(body) ? body.steps : undefined);
        else notes.unknown(at);
      }
    }
  }
}

/** `repo_locks.mode` (Atlantis) or `pr_locks` (OpenTaco): `locks: plan` when it locks at plan time. */
function locks(g: Gathered, notes: Notes, key: string, raw: unknown): void {
  const atPlan = raw === true || (isMap(raw) && raw.mode === "on_plan");
  if (atPlan) g.planLocks = key;
  else notes.covered(key, "Lock at plan time");
}

// ── OpenTaco (digger) ───────────────────────────────────────────────────────

const DIGGER_PROJECT_KEYS = new Set([
  "name", "dir", "workspace", "terragrunt", "opentofu", "workflow", "include_patterns", "exclude_patterns", "depends_on", "aws_role_to_assume", "apply_requirements",
]);

function readDigger(doc: Record<string, unknown>, g: Gathered, notes: Notes): void {
  for (const k of Object.keys(doc)) {
    if (!["projects", "generate_projects", "workflows", "auto_merge", "pr_locks"].includes(k)) notes.unknown(k);
  }
  if (doc.auto_merge === true) g.autoMerge = "auto_merge";
  if (doc.pr_locks !== undefined) locks(g, notes, "pr_locks", doc.pr_locks);
  const projects = list(doc.projects);
  g.projects = projects.length;
  projects.forEach((p, i) => {
    if (!isMap(p)) return notes.unknown(`projects[${i}]`);
    const root = rootOf(p.dir ?? ".");
    const at = `projects[${typeof p.name === "string" ? p.name : root ?? i}]`;
    for (const k of Object.keys(p)) if (!DIGGER_PROJECT_KEYS.has(k)) notes.unknown(`${at}.${k}`);
    if (root === undefined) notes.unmapped(`${at}.dir`, "Which directories", `${JSON.stringify(p.dir)} is not a directory inside the repo`);
    else if (!g.roots.includes(root)) g.roots.push(root);
    if (p.name !== undefined) notes.covered("projects[].name", "Project name");
    if (p.workspace !== undefined && p.workspace !== "default") notes.unmapped(`${at}.workspace`, "Workspace", `workspace ${String(p.workspace)} is not planned`);
    if (p.opentofu === true) g.tofu.push(at);
    if (p.terragrunt !== undefined) notes.covered("projects[].terragrunt", "Terragrunt");
    if (p.include_patterns !== undefined) notes.covered("projects[].include_patterns", "What triggers a plan");
    if (p.exclude_patterns !== undefined) notes.covered("projects[].exclude_patterns", "What triggers a plan");
    if (p.terragrunt === true) g.terragrunt = true;
    takeName(g, p, root);
    if (p.depends_on !== undefined && root !== undefined) g.dependsOn.push({ at: `${at}.depends_on`, root, names: p.depends_on });
    if (p.aws_role_to_assume !== undefined) notes.unmapped(`${at}.aws_role_to_assume`, "Cloud credentials", "name a read-only plan role and an apply role under `oidc`");
    takeRequirements(g, notes, `${at}.apply_requirements`, p.apply_requirements);
  });
  if (isMap(doc.generate_projects)) {
    const gp = doc.generate_projects;
    const blocks = gp.blocks !== undefined ? list(gp.blocks).map((b, i) => ({ b, at: `generate_projects.blocks[${i}]` })) : [{ b: gp as unknown, at: "generate_projects" }];
    for (const { b, at } of blocks) {
      if (!isMap(b)) continue;
      for (const inc of list(b.include)) {
        const root = rootOf(inc);
        if (root === undefined) notes.unmapped(`${at}.include`, "Which directories", `${JSON.stringify(inc)} is not a glob inside the repo`);
        else if (!g.roots.includes(root)) {
          g.roots.push(root);
          notes.mapped(`${at}.include`, "Which directories", `roots glob ${root}`);
        }
      }
      if (b.exclude !== undefined) notes.unmapped(`${at}.exclude`, "Which directories", "roots lists what to plan; narrow the globs instead");
      if (b.terragrunt_parsing !== undefined || b.terragrunt === true) notes.covered(`${at}.terragrunt_parsing`, "Terragrunt");
      for (const k of Object.keys(b)) if (!["include", "exclude", "terragrunt_parsing", "terragrunt", "blocks"].includes(k)) notes.unknown(`${at}.${k}`);
    }
  }
  if (isMap(doc.workflows)) {
    for (const [name, wf] of Object.entries(doc.workflows)) {
      if (!isMap(wf)) continue;
      for (const [part, body] of Object.entries(wf)) {
        const at = `workflows.${name}.${part}`;
        if (part === "plan" || part === "apply") {
          notes.unmapped(at, "Custom steps");
          steps(g, notes, `${at}.steps`, isMap(body) ? body.steps : undefined);
        } else if (part === "env_vars" && isMap(body)) {
          for (const [phase, vars] of Object.entries(body)) {
            list(vars).forEach((v, i) => {
              const k = `${at}.${phase}[${i}]`;
              if (isMap(v)) takeEnv(g, notes, k, v.name, v.value);
              else notes.unknown(k);
            });
          }
        } else if (part === "workflow_configuration" && isMap(body)) {
          for (const [event, cmds] of Object.entries(body)) {
            const k = `${at}.${event}`;
            const has = (c: string) => list(cmds).some((x) => typeof x === "string" && x.trim() === c);
            if (event === "on_pull_request_pushed") notes.covered(k, "What triggers a plan");
            else if (event === "on_pull_request_closed") notes.covered(k, "Release locks on close");
            else if (event === "on_commit_to_default") {
              if (has("digger apply")) {
                g.afterMerge = true;
                notes.covered(k, "Apply on merge");
              } else notes.covered(k, "Release locks on close");
            } else notes.unknown(k);
          }
        } else notes.unknown(at);
      }
    }
  }
}

// ── both ────────────────────────────────────────────────────────────────────

/** Turn a parsed atlantis.yaml, digger.yml or .terrateam/config.yml into terragucci settings and a note per setting. */
export function convert(source: ImportSource, doc: unknown, o: ImportOptions = {}): Converted & { missing?: string[] } {
  if (!isMap(doc)) throw new ConfigError(`the ${SOURCE_NAMES[source]} config is not a map of settings`);
  if (source === "terrateam") return convertTerrateam(doc, o);
  const notes = new Notes();
  const g = gathered();
  if (source === "atlantis") readAtlantis(doc, g, notes);
  else readDigger(doc, g, notes);
  const s: ProjectSettings = {};

  if (g.roots.length) {
    s.roots = [...g.roots].sort();
    notes.mapped("projects[].dir", "Which directories", `roots: ${s.roots.join(", ")}`);
  }

  // Which binary and version.
  const versions = [...g.versions.keys()];
  if (versions.length === 1) {
    s.binary = "terraform";
    s.version = versions[0];
    notes.mapped("projects[].terraform_version", "Binary version", `binary: terraform, version: ${versions[0]}`);
  } else if (versions.length > 1) {
    notes.unmapped("projects[].terraform_version", "Binary version", `the projects pin ${versions.join(", ")}, and the pipeline runs one; each root's required_version pin is read instead`);
  }
  if (g.tofu.length) {
    if (g.tofu.length === g.projects) {
      s.binary = "tofu";
      notes.mapped("projects[].opentofu", "Binary version", "binary: tofu");
    } else notes.unmapped("projects[].opentofu", "Binary version", `only ${g.tofu.join(", ")} run OpenTofu, and the pipeline runs one binary`);
  }

  // Order: depends_on.
  dependsOnOrder(g, notes, s, o.repo?.reads);

  // Concurrency.
  if (source === "atlantis" && (doc.parallel_plan === false || doc.parallel_apply === false)) s.parallelism = 1;

  // When the change applies, and what it needs first.
  const forced = o.applyWhen !== undefined;
  let when: ApplyWhen = o.applyWhen ?? (g.afterMerge ? "merge" : "pull-request");
  const timing = timingText(source);
  if (when === "pull-request" && o.forge === "gitlab") {
    when = "merge";
    notes.own("when it applies", "unmapped", timing, `left at apply.when: merge: ${PR_APPLY_NEEDS_ON_GITLAB.comments}; and ${PR_APPLY_NEEDS_ON_GITLAB.token}`);
  } else if (when === "pull-request") {
    s.apply = { when };
    notes.own("when it applies", "mapped", timing, forced ? "apply.when: pull-request, from --apply-when" : "apply.when: pull-request, to keep applying before merge; --apply-when merge applies after merge instead");
  } else {
    notes.own("when it applies", "default", timing, forced ? "apply.when: merge, from --apply-when" : "apply.when: merge, terragucci's default");
  }
  const requires = APPLY_REQUIRES.filter((r) => [...g.requirements.keys()].some((k) => REQUIREMENTS[k].to.includes(r)));
  for (const [req, keys] of g.requirements) {
    const { row, to } = REQUIREMENTS[req];
    const key = keys.length === 1 ? keys[0] : `projects[].apply_requirements: ${req}`;
    if (when === "pull-request") notes.mapped(key, row, `apply.requires: ${to.join(", ")}`);
    else notes.unmapped(key, row, "applying after merge, a branch protection rule on the default branch does this job");
  }
  if (when === "pull-request" && s.apply) {
    if (requires.length) {
      s.apply.requires = requires;
      if (g.projectsWithRequirements < g.projects) notes.own("projects[].apply_requirements", "mapped", `apply.requires covers every root: ${requires.join(", ")}`, `${g.projectsWithRequirements} of ${g.projects} projects set apply_requirements, and terragucci keeps one list`);
    } else {
      notes.own("projects[].apply_requirements", "default", `no project sets apply_requirements, so apply.requires is left unset and every requirement applies: ${APPLY_REQUIRES.join(", ")}`);
    }
  }
  if (g.autoMerge) {
    const key = g.autoMerge;
    if (when !== "pull-request" || !s.apply) notes.unmapped(key, "Merge after apply", "apply.when is merge here, so a person merges");
    else if (o.forge === "forgejo") notes.unmapped(key, "Merge after apply", "on Forgejo apply.merge: auto also needs apply.merge_token_env, the secret holding a token that may merge, which this command cannot name; add both");
    else if (s.apply.requires && !s.apply.requires.includes("approved")) notes.unmapped(key, "Merge after apply", "apply.merge: auto merges only an approved head, and apply.requires leaves out approved");
    else {
      s.apply.merge = "auto";
      notes.mapped(key, "Merge after apply", "apply.merge: auto");
    }
  }

  // Locks.
  if (g.planLocks) {
    if (o.forge === "gitlab") notes.unmapped(g.planLocks, "Lock at plan time", NO_GITLAB_PLAN_LOCKS);
    else {
      s.locks = "plan";
      notes.mapped(g.planLocks, "Lock at plan time", "locks: plan");
    }
  }

  // Variables every job gets.
  const env = [...g.env].filter(([name]) => !g.envConflicts.has(name));
  if (env.length) {
    s.env = Object.fromEntries(env.map(([name, v]) => [name, v.value]));
    for (const [name, v] of env) notes.mapped(v.key, "Custom steps", `env: ${name}`);
  }

  // What is written must pass config check.
  validateConfig(s, "terragucci.yml");
  return { settings: s, notes: notes.list };
}

export interface ImportResult extends Converted {
  source: ImportSource;
  /** The file read, relative to the repo. */
  from: string;
  /** The file written, relative to the repo; undefined on a dry run. */
  wrote?: string;
  /** The YAML written, or that would be. */
  yaml: string;
  /** Roots that match no directory with Terraform files. */
  missing: string[];
}

/** The repo's roots as detection finds them, their layers and their reads; no order when the reads form a cycle. */
function repoShape(repo: string): RepoShape {
  const roots = findRoots(repo);
  const reads = rootDependencies(repo, roots);
  try {
    return { roots, layers: applyLayers(repo, roots), reads };
  } catch {
    return { roots, layers: [roots], reads: new Map() };
  }
}

/** Read the source file in `repo`, convert it, and write terragucci.yml unless `dryRun`. */
export function importConfig(repo: string, source: ImportSource, o: ImportOptions & { file?: string; dryRun?: boolean; force?: boolean } = {}): ImportResult {
  const file = o.file ? resolve(repo, o.file) : SOURCE_FILES[source].map((f) => join(repo, f)).find((f) => existsSync(f));
  if (!file || !existsSync(file)) throw new ConfigError(`import ${source} reads ${o.file ?? SOURCE_FILES[source].join(" or ")}, and there is none in ${repo}`);
  let doc: unknown;
  try {
    doc = parseYAML(readFileSync(file, "utf-8"));
  } catch (e) {
    throw new ConfigError(`${relative(repo, file)} is not YAML: ${(e as Error).message}`);
  }
  const forge = o.forge ?? detectForge(repo)?.value;
  const { settings, notes, missing: unmatched } = convert(source, doc, { ...(forge ? { forge } : {}), ...(o.applyWhen ? { applyWhen: o.applyWhen } : {}), repo: repoShape(repo) });
  const from = relative(repo, file) || file;
  const yaml = `# Written by terragucci import ${source} from ${from}. What became of each setting: ${source === "terrateam" ? TERRATEAM_URL : GUIDE_URL}\n${Object.keys(settings).length ? emitYAML(settings, 0).trim() : "{}"}\n`;
  const missing = unmatched ?? (settings.roots ?? []).filter((r) => findRoots(repo, [r]).length === 0);
  const existing = findConfig(repo);
  let wrote: string | undefined;
  if (!o.dryRun) {
    if (existing && !o.force) throw new ConfigError(`${relative(repo, existing)} is already here; --force replaces it, or --dry-run prints what would be written`);
    const out = existing ?? join(repo, "terragucci.yml");
    if (existing && !/\.ya?ml$/.test(existing)) throw new ConfigError(`${relative(repo, existing)} is not YAML; move it aside first`);
    writeFileSync(out, yaml);
    wrote = relative(repo, out);
  }
  return { source, from, settings, notes, yaml, missing, ...(wrote ? { wrote } : {}) };
}

const HEADINGS: Record<NoteKind, string> = {
  mapped: "Written to terragucci.yml",
  default: "Done by terragucci with no key",
  unmapped: "Not mapped",
  "left-out": "Left out on purpose",
};

/** The text `terragucci import` prints. */
export function describeImport(r: ImportResult): string {
  const out: string[] = [];
  out.push(r.wrote ? `read ${r.from}, wrote ${r.wrote}:` : `read ${r.from}; dry run, nothing written. terragucci.yml would be:`);
  out.push("", ...r.yaml.trimEnd().split("\n").map((l) => `  ${l}`));
  for (const kind of ["mapped", "default", "unmapped", "left-out"] as const) {
    const notes = r.notes.filter((n) => n.kind === kind);
    if (!notes.length) continue;
    out.push("", `${HEADINGS[kind]}:`);
    for (const n of notes) {
      const detail = n.detail ? `${n.detail}. ` : "";
      // A row's cell is quoted as the guide's; a note with no row carries its own text.
      const quoted = n.row ? `The guide: ${n.text}` : n.text;
      out.push(`  ${n.key}${n.row ? ` (${n.row})` : ""}: ${detail}${quoted}`);
    }
  }
  if (r.missing.length) out.push("", r.source === "terrateam" ? `No root matches the dirs ${r.missing.join(", ")}; check those keys.` : `No directory with Terraform files matches ${r.missing.join(", ")}; check those projects' dir.`);
  out.push("", `Next: \`npx terragucci init\` writes the pipeline for these settings. Every mapping: ${r.source === "terrateam" ? TERRATEAM_URL : GUIDE_URL}`);
  return out.join("\n");
}
