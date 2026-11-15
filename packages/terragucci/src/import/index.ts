/**
 * `terragucci import atlantis [atlantis.yaml]`, `terragucci import digger
 * [digger.yml]` and `terragucci import terragrunt-scale [.gruntwork]`: write
 * terragucci.yml from an Atlantis repo config, an OpenTaco (digger) config or
 * a Terragrunt Scale repo's Pipelines HCL (./terragrunt-scale.ts), and say what became of every setting.
 * `import spacelift` (./spacelift.ts) and `import env0` (./env0.ts) do the
 * same from a Spacelift or env zero repo, its files and its admin code, by
 * the guide "Use terragucci with Spacelift or env zero".
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
import type { OpWaveHooks } from "@intentius/chant/op";
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
import { applyLayers, detectForge, findRoots, moduleChecker, rootDependencies } from "../detect";
import { workspaceName } from "../init";
import { APPLY_TIMING_TABLE, GUIDE_URL, plain, SCALE_URL, type SettingRow } from "./guide";
import { isMap, list, Notes, rootOf, wavesAfterOf, type ImportNote, type NoteKind, type RepoShape } from "./notes";
import { readEnv0, convertEnv0, ENV0_DISCOVERY_FILES } from "./env0";
import { convertSpacelift, readSpacelift, SPACELIFT_FILES } from "./spacelift";
import { SPACELIFT_ENV0_GUIDE_URL } from "./spacelift-env0-guide";
import { readTerragruntScale } from "./terragrunt-scale";

export { rootOf, type ImportNote, type NoteKind } from "./notes";

export const IMPORT_SOURCES = ["atlantis", "digger", "terragrunt-scale", "spacelift", "env0"] as const;
export type ImportSource = (typeof IMPORT_SOURCES)[number];

/** The file each source reads when none is named, first found wins. */
export const SOURCE_FILES: Record<ImportSource, string[]> = {
  atlantis: ["atlantis.yaml", "atlantis.yml", ".atlantis.yaml", ".atlantis.yml"],
  digger: ["digger.yml", "digger.yaml"],
  "terragrunt-scale": [".gruntwork"],
  spacelift: SPACELIFT_FILES,
  env0: ENV0_DISCOVERY_FILES,
};

const SOURCE_NAMES: Record<ImportSource, string> = { atlantis: "Atlantis", digger: "OpenTaco", "terragrunt-scale": "Terragrunt Scale", spacelift: "Spacelift", env0: "env zero" };

/** The page each source's mapping is on. */
const SOURCE_URLS: Record<ImportSource, string> = { atlantis: GUIDE_URL, digger: GUIDE_URL, "terragrunt-scale": SCALE_URL, spacelift: SPACELIFT_ENV0_GUIDE_URL, env0: SPACELIFT_ENV0_GUIDE_URL };

export interface Converted {
  settings: ProjectSettings;
  notes: ImportNote[];
  /** The source's hooks, as `ci.hooks` for chant.workspace.json. */
  hooks?: OpWaveHooks;
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
  /** Atlantis: the `-backend-config` and `-var-file` files each workflow's `init` and `plan` steps pass, by workflow name, with the step that names them. */
  workflowInputs: Map<string, { backend: string[]; vars: string[]; at: string[] }>;
  /** Atlantis: each project that names a workflow, by its root and its name. */
  projectFlows: { root: string; name?: string; workflow: string; workspace: boolean }[];
  /** Atlantis: the repo as detection finds it, when the import has it. */
  repo?: RepoShape;
  /** Atlantis: `autodiscover` is on, so the file does not list the roots to plan. */
  autodiscover: boolean;
  /** Atlantis: the projects that name each workflow, by the workflow's name. */
  workflowProjects: Map<string, string[]>;
}

function gathered(): Gathered {
  return { roots: [], afterMerge: false, requirements: new Map(), projectsWithRequirements: 0, projects: 0, versions: new Map(), tofu: [], env: new Map(), envConflicts: new Set(), named: new Map(), dependsOn: [], terragrunt: false, workflowInputs: new Map(), projectFlows: [], autodiscover: false, workflowProjects: new Map() };
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

/**
 * The files an `init` step's `-backend-config` or a `plan` step's `-var-file`
 * arguments name, and the arguments left over. A `-backend-config` that is a
 * `key=value` pair, a path that is absolute, and one with a variable in it
 * name no file of the repo, so they stay with the rest.
 */
function takeFiles(args: unknown[], flag: "backend-config" | "var-file"): { files: string[]; rest: unknown[] } {
  const files: string[] = [];
  const rest: unknown[] = [];
  const own = new RegExp(`^--?${flag}(?:=(.*))?$`);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const m = typeof a === "string" ? own.exec(a) : null;
    if (!m) {
      rest.push(a);
      continue;
    }
    const value = m[1] ?? (typeof args[i + 1] === "string" ? (args[++i] as string) : undefined);
    const file = value?.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
    const pair = flag === "backend-config" && file !== undefined && file.includes("=");
    if (file && !pair && !file.startsWith("/") && !file.includes("$")) files.push(file);
    else rest.push(a);
  }
  return { files, rest };
}

/** The steps both tools write: built-in names, `extra_args`, `run`, `env`. `inputs`, for an Atlantis workflow, takes the init step's `-backend-config` files and the plan step's `-var-file` files. */
function steps(g: Gathered, notes: Notes, key: string, raw: unknown, inputs?: { backend: string[]; vars: string[]; at: string[] }): void {
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
      else if (isMap(body) && body.extra_args !== undefined) {
        const flag = name === "init" ? "backend-config" : name === "plan" ? "var-file" : undefined;
        const taken = inputs && flag ? takeFiles(list(body.extra_args), flag) : undefined;
        if (taken?.files.length) {
          inputs![flag === "backend-config" ? "backend" : "vars"].push(...taken.files);
          inputs!.at.push(`${k}.extra_args`);
        }
        if (!taken || taken.rest.length) notes.leftOut(`${k}.extra_args`, "Flags at run time");
      }
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

/**
 * `autodiscover`: with the mode `auto` (the default) or `enabled`, the file does
 * not name every directory to plan, so no `roots` is written and detection
 * decides, which is what terragucci does with no key. `disabled` plans only the
 * projects, so their directories are written as `roots`.
 */
function takeAutodiscover(raw: unknown, g: Gathered, notes: Notes): void {
  if (raw === undefined) return;
  const mode = isMap(raw) && typeof raw.mode === "string" ? raw.mode : "auto";
  if (mode === "disabled") {
    notes.covered("autodiscover", "Which directories", "mode disabled, so the projects' directories are what is planned and are written as roots");
    return;
  }
  g.autodiscover = true;
  const found = g.repo?.roots.length;
  notes.covered("autodiscover", "Which directories", `mode ${mode}, so roots is left out and terragucci plans every root detection finds${found === undefined ? "" : ` (${found} here)`}, not only the projects' directories`);
  if (isMap(raw) && raw.ignore_paths !== undefined) notes.unmapped("autodiscover.ignore_paths", "Which directories", "roots has no exclusions; narrow the roots globs instead");
}

function readAtlantis(doc: Record<string, unknown>, g: Gathered, notes: Notes): void {
  // The flag is the server's, so no atlantis.yaml shows it: the note is there whether or not the server sets it.
  notes.unmapped("--gh-team-allowlist", "Who may comment", "atlantis.yaml cannot show it. If the server sets it, write the same teams under comment_allow");
  for (const k of Object.keys(doc)) {
    if (!["version", "projects", "workflows", "automerge", "parallel_plan", "parallel_apply", "autodiscover", "abort_on_execution_order_fail", "repo_locks"].includes(k)) notes.unknown(k);
  }
  takeAutodiscover(doc.autodiscover, g, notes);
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
    else if (g.repo?.isModule?.(root)) notes.own(`${at}.dir`, "unmapped", `${root} is a module some directory calls and it keeps no state of its own, so detection leaves it out of the roots and it is not planned; name it in roots to plan it anyway`);
    else if (!g.roots.includes(root)) {
      g.roots.push(root);
      if (g.autodiscover && g.repo?.roots.length && !g.repo.roots.includes(root)) notes.own(`${at}.dir`, "unmapped", `${root} is not a root by detection (it has no backend, cloud block or provider), and with autodiscover roots is left out, so it is not planned; set roots to plan it`);
    }
    if (p.name !== undefined) notes.covered("projects[].name", "Project name");
    if (p.workspace !== undefined && p.workspace !== "default") notes.unmapped(`${at}.workspace`, "Workspace", `workspace ${String(p.workspace)} is not planned`);
    if (typeof p.terraform_version === "string") g.versions.set(p.terraform_version.replace(/^v/, ""), [...(g.versions.get(p.terraform_version.replace(/^v/, "")) ?? []), at]);
    if (isMap(p.autoplan)) {
      if (p.autoplan.when_modified !== undefined) notes.covered("projects[].autoplan.when_modified", "What triggers a plan");
      if (p.autoplan.enabled === false) {
        if (root !== undefined && g.repo?.isModule?.(root)) notes.covered(`${at}.autoplan.enabled`, "What triggers a plan", `${root} is a module and is left out of roots, so it is not planned`);
        else notes.unmapped(`${at}.autoplan.enabled`, "What triggers a plan", "no key turns the plan off for a root");
      }
    }
    takeRequirements(g, notes, `${at}.apply_requirements`, p.apply_requirements);
    if (p.plan_requirements !== undefined) notes.unmapped(`${at}.plan_requirements`, "Plan requirements");
    if (p.import_requirements !== undefined) notes.leftOut(`${at}.import_requirements`, "`import` or `state rm` from a comment");
    if (p.execution_order_group !== undefined) notes.unmapped(`${at}.execution_order_group`, "Order");
    takeName(g, p, root);
    if (p.depends_on !== undefined && root !== undefined) g.dependsOn.push({ at: `${at}.depends_on`, root, names: p.depends_on });
    if (p.repo_locks !== undefined) locks(g, notes, `${at}.repo_locks`, p.repo_locks);
    if (p.custom_policy_check !== undefined) notes.unmapped(`${at}.custom_policy_check`, "Policy");
    if (typeof p.workflow === "string") g.workflowProjects.set(p.workflow, [...(g.workflowProjects.get(p.workflow) ?? []), typeof p.name === "string" ? p.name : root ?? String(i)]);
    if (typeof p.workflow === "string" && root !== undefined) {
      g.projectFlows.push({ root, ...(typeof p.name === "string" ? { name: p.name } : {}), workflow: p.workflow, workspace: p.workspace !== undefined && p.workspace !== "default" });
    }
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
        else if (stage === "plan" || stage === "apply") {
          const inputs = g.workflowInputs.get(name) ?? { backend: [], vars: [], at: [] };
          g.workflowInputs.set(name, inputs);
          steps(g, notes, `${at}.steps`, isMap(body) ? body.steps : undefined, inputs);
        }
        else notes.unknown(at);
      }
    }
  }
  workflowNotes(doc, g, notes);
}

/**
 * `projects[].workflow`, once per workflow name. A workflow this file defines
 * is read from `workflows` (its notes are above). One it does not define is
 * the server's, from `repos.yaml`, which is not in the file the import read,
 * so what its steps pass to init and plan is unknown here.
 */
function workflowNotes(doc: Record<string, unknown>, g: Gathered, notes: Notes): void {
  const defined = isMap(doc.workflows) ? doc.workflows : {};
  for (const [name, projects] of g.workflowProjects) {
    const who = projects.length === 1 ? `project ${projects[0]}` : `${projects.length} projects (${projects.join(", ")})`;
    const key = `projects[].workflow: ${name}`;
    if (name in defined) notes.unmapped(key, "Custom steps", `${who} run workflow ${name}, defined under workflows in this file; its steps are read there`);
    else notes.unmapped(key, "Custom steps", `${who} run workflow ${name}, which this file does not define. A workflow defined in the server's repos.yaml is not in the file the import read, so any -backend-config or -var-file it passes is not written: read it there and set backend_config and var_files for these roots`);
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

/** A name an instance can carry: the project's, when it has one. */
const INSTANCE_OK = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/**
 * The files a project's workflow passes to `init` as `-backend-config` and to
 * `plan` as `-var-file`, as `backend_config` and `var_files` by root. Projects
 * that share a directory and pass different files are one directory run as
 * several roots: each is an instance named by its project, in `instances`.
 * Projects that share one and pass the same files, or that select workspaces,
 * stay one root.
 */
function inputsOf(g: Gathered, notes: Notes, s: ProjectSettings): void {
  const files = (workflow: string) => g.workflowInputs.get(workflow);
  const key = (workflow: string): string | undefined => files(workflow)?.at[0];
  const backend: Record<string, string[]> = {};
  const vars: Record<string, string[]> = {};
  const instances: Record<string, string[]> = {};
  const wrote = new Map<string, string[]>();
  const byRoot = new Map<string, Gathered["projectFlows"]>();
  for (const f of g.projectFlows) byRoot.set(f.root, [...(byRoot.get(f.root) ?? []), f]);
  const note = (workflow: string, what: string): void => {
    for (const at of files(workflow)?.at ?? []) wrote.set(at, [...(wrote.get(at) ?? []), what]);
  };
  const pairOf = (workflow: string): string => JSON.stringify([files(workflow)?.backend ?? [], files(workflow)?.vars ?? []]);
  const set = (rootKey: string, workflow: string): void => {
    const w = files(workflow);
    if (!w || (!w.backend.length && !w.vars.length)) return;
    if (w.backend.length) backend[rootKey] = [...new Set(w.backend)];
    if (w.vars.length) vars[rootKey] = [...new Set(w.vars)];
    note(workflow, rootKey);
  };
  for (const [root, flows] of byRoot) {
    const flowsWithFiles = flows.filter((f) => key(f.workflow) !== undefined);
    if (flowsWithFiles.length === 0) continue;
    const differ = new Set(flows.map((f) => pairOf(f.workflow))).size > 1;
    const named = flows.every((f) => f.name !== undefined && INSTANCE_OK.test(f.name)) && new Set(flows.map((f) => f.name)).size === flows.length;
    if (flows.length > 1 && differ && named && root !== "." && !flows.some((f) => f.workspace)) {
      instances[root] = flows.map((f) => f.name!);
      for (const f of flows) set(`${root}@${f.name}`, f.workflow);
    } else {
      // One root: the first project's files stand, and the others' are named when they differ.
      set(root, flows[0]!.workflow);
      if (flows.length > 1 && differ) for (const f of flows.slice(1)) for (const at of files(f.workflow)?.at ?? []) notes.unmapped(at, "Backend config and var files", `${root} has projects that pass different files, and they cannot be told apart here: ${flows.some((x) => x.workspace) ? "one selects a workspace" : "each needs a name"}, and the first project's files are written`);
    }
  }
  if (Object.keys(backend).length) s.backend_config = backend;
  if (Object.keys(vars).length) s.var_files = vars;
  if (Object.keys(instances).length) s.instances = instances;
  for (const [at, what] of wrote) {
    const parts = [...new Set(what)].map((r) => `${r}${backend[r] ? ` backend_config ${backend[r]!.join(", ")}` : ""}${vars[r] ? ` var_files ${vars[r]!.join(", ")}` : ""}`);
    notes.mapped(at, "Backend config and var files", `${parts.join("; ")}${Object.keys(instances).length ? `; instances: ${Object.entries(instances).map(([d, n]) => `${d}: ${n.join(", ")}`).join("; ")}` : ""}`);
  }
}

/** Turn a parsed atlantis.yaml or digger.yml into terragucci settings and a note per setting. */
export function convert(source: Exclude<ImportSource, "terragrunt-scale">, doc: unknown, o: ImportOptions = {}): Converted & { missing?: string[] } {
  if (!isMap(doc)) throw new ConfigError(`the ${SOURCE_NAMES[source]} config is not a map of settings`);
  if (source === "spacelift") return convertSpacelift(doc, [], o);
  if (source === "env0") return convertEnv0({ discovery: doc, flows: [], resources: [] }, o);
  const notes = new Notes();
  const g = gathered();
  if (o.repo) g.repo = o.repo;
  if (source === "atlantis") readAtlantis(doc, g, notes);
  else readDigger(doc, g, notes);
  const s: ProjectSettings = {};

  if (g.roots.length && !g.autodiscover) {
    s.roots = [...g.roots].sort();
    notes.mapped("projects[].dir", "Which directories", `roots: ${s.roots.join(", ")}`);
  }

  inputsOf(g, notes, s);

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
  /** The declaration the hooks were written into, relative to the repo; undefined on a dry run or with no hooks. */
  wroteHooks?: string;
  /** Roots that match no directory with Terraform files. */
  missing: string[];
}

/** The repo's roots as detection finds them, their layers and their reads; no order when the reads form a cycle. */
function repoShape(repo: string): RepoShape {
  const roots = findRoots(repo);
  const reads = rootDependencies(repo, roots);
  const isModule = moduleChecker(repo);
  try {
    return { roots, layers: applyLayers(repo, roots), reads, isModule };
  } catch {
    return { roots, layers: [roots], reads: new Map(), isModule };
  }
}

/** Read the source file in `repo` (and, for Spacelift and env zero, their admin code), convert it, and write terragucci.yml unless `dryRun`. */
export function importConfig(repo: string, source: ImportSource, o: ImportOptions & { file?: string; dryRun?: boolean; force?: boolean } = {}): ImportResult {
  if (source === "terragrunt-scale") {
    if (o.applyWhen) throw new ConfigError("import terragrunt-scale takes no --apply-when: Pipelines applies after merge, terragucci's default");
    const r = readTerragruntScale(repo, o.file ?? SOURCE_FILES[source][0]);
    return write(repo, source, r.from, r.settings, r.notes, r.missing, o);
  }
  const forge = o.forge ?? detectForge(repo)?.value;
  const opts = { ...(forge ? { forge } : {}), ...(o.applyWhen ? { applyWhen: o.applyWhen } : {}), repo: repoShape(repo) };
  if (source === "spacelift" || source === "env0") {
    // These read admin code beside their file, and run without the file.
    const file = o.file ? relative(repo, resolve(repo, o.file)) : undefined;
    const r = (source === "spacelift" ? readSpacelift : readEnv0)(repo, { ...opts, ...(file !== undefined ? { file } : {}) });
    const missing = r.missing ?? (r.settings.roots ?? []).filter((x) => findRoots(repo, [x]).length === 0);
    return write(repo, source, r.read.join(", "), r.settings, r.notes, missing, o, r.hooks);
  }
  const file = o.file ? resolve(repo, o.file) : SOURCE_FILES[source].map((f) => join(repo, f)).find((f) => existsSync(f));
  if (!file || !existsSync(file)) throw new ConfigError(`import ${source} reads ${o.file ?? SOURCE_FILES[source].join(" or ")}, and there is none in ${repo}`);
  let doc: unknown;
  try {
    doc = parseYAML(readFileSync(file, "utf-8"));
  } catch (e) {
    throw new ConfigError(`${relative(repo, file)} is not YAML: ${(e as Error).message}`);
  }
  const { settings, notes, missing: unmatched } = convert(source, doc, opts);
  const from = relative(repo, file) || file;
  const missing = unmatched ?? (settings.roots ?? []).filter((r) => findRoots(repo, [r]).length === 0);
  return write(repo, source, from, settings, notes, missing, o);
}

/** The chant release that reads `ci.hooks` in a declaration. */
export const HOOKS_READER = "0.124.41";

/** chant.workspace.json with `hooks` under `ci.hooks`: the repo's own, else a new one. */
function declarationWithHooks(repo: string, hooks: OpWaveHooks, force: boolean | undefined): { path: string; text: string } {
  const path = join(repo, "chant.workspace.json");
  let decl: Record<string, unknown> = { name: workspaceName(repo), schema: 1, minReader: HOOKS_READER, members: [] };
  if (existsSync(path)) {
    try {
      decl = JSON.parse(readFileSync(path, "utf-8"));
    } catch {
      throw new ConfigError("chant.workspace.json is not valid JSON, so import cannot add ci.hooks to it");
    }
  }
  const ci = (decl.ci ?? {}) as Record<string, unknown>;
  if (ci.hooks !== undefined && !force) throw new ConfigError("chant.workspace.json already has ci.hooks; --force replaces them, or --dry-run prints what would be written");
  const [major = 0, minor = 0, patch = 0] = String(decl.minReader ?? "0").split(".").map(Number);
  const [wantMinor, wantPatch] = [124, 41];
  if (major === 0 && (minor < wantMinor || (minor === wantMinor && patch < wantPatch))) decl.minReader = HOOKS_READER;
  decl.ci = { ...ci, hooks };
  return { path, text: `${JSON.stringify(decl, null, 2)}\n` };
}

/** Write terragucci.yml from converted settings, and the hooks into chant.workspace.json, unless `dryRun`. */
function write(repo: string, source: ImportSource, from: string, settings: ProjectSettings, notes: ImportNote[], missing: string[], o: { dryRun?: boolean; force?: boolean }, hooks?: OpWaveHooks): ImportResult {
  const yaml = `# Written by terragucci import ${source} from ${from}. What became of each setting: ${SOURCE_URLS[source]}\n${Object.keys(settings).length ? emitYAML(settings, 0).trim() : "{}"}\n`;
  const existing = findConfig(repo);
  let wrote: string | undefined;
  let wroteHooks: string | undefined;
  if (!o.dryRun) {
    if (existing && !o.force) throw new ConfigError(`${relative(repo, existing)} is already here; --force replaces it, or --dry-run prints what would be written`);
    const out = existing ?? join(repo, "terragucci.yml");
    if (existing && !/\.ya?ml$/.test(existing)) throw new ConfigError(`${relative(repo, existing)} is not YAML; move it aside first`);
    const decl = hooks ? declarationWithHooks(repo, hooks, o.force) : undefined;
    writeFileSync(out, yaml);
    wrote = relative(repo, out);
    if (decl) {
      writeFileSync(decl.path, decl.text);
      wroteHooks = relative(repo, decl.path);
    }
  }
  return { source, from, settings, notes, yaml, missing, ...(hooks ? { hooks } : {}), ...(wrote ? { wrote } : {}), ...(wroteHooks ? { wroteHooks } : {}) };
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
  if (r.hooks) {
    out.push("", r.wroteHooks ? `and wrote ci.hooks into ${r.wroteHooks}:` : "ci.hooks in chant.workspace.json would be:");
    out.push("", ...JSON.stringify(r.hooks, null, 2).split("\n").map((l) => `  ${l}`));
  }
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
  if (r.missing.length) {
    const what =
      r.source === "terragrunt-scale" ? `No unit matches ${r.missing.join(", ")}; check those filter paths.`
      : r.source === "spacelift" ? `No directory with Terraform files matches ${r.missing.join(", ")}; check those stacks' project_root.`
      : r.source === "env0" ? `No directory with Terraform files matches ${r.missing.join(", ")}; check those environments' templates.`
      : `No directory with Terraform files matches ${r.missing.join(", ")}; check those projects' dir.`;
    out.push("", what);
  }
  out.push("", `Next: \`npx terragucci init\` writes the pipeline for these settings. Every mapping: ${SOURCE_URLS[r.source]}`);
  return out.join("\n");
}
