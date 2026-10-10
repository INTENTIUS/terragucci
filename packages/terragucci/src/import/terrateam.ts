/**
 * `terragucci import terrateam [.terrateam/config.yml]`: terragucci.yml from
 * a Terrateam (now Stategraph) repo config, by the guide's Terrateam table
 * (TERRATEAM_TABLE in ./guide.ts). Every key the file carries ends up as one
 * note, as for the other sources (./index.ts); a key the table has no row for
 * is named as unmapped.
 *
 * Terrateam plans every directory with Terraform files, and `dirs` only
 * configures them, so the import writes no `roots`: terragucci's detection
 * finds the roots, and a `dirs` key that matches none is named.
 *
 * `depends_on` is the one setting that needs the repo. terragucci orders
 * roots by their `terraform_remote_state` reads, so a dependency the reads
 * already give needs nothing. One they do not give goes into `waves.canary`,
 * which puts the roots it names before the rest. That is one step of order:
 * a dependency between two roots that would both have to go first stays
 * unmapped, and the note names it.
 */
import { applyWaves } from "../apply";
import {
  APPLY_REQUIRES,
  PR_APPLY_NEEDS_ON_GITLAB,
  validateConfig,
  type ApplyRequire,
  type ApplyWhen,
  type Binary,
  type ForgeName,
  type ProjectSettings,
  type StepSettings,
  type StepStage,
} from "../config";
import { globMatch } from "../detect";
import { isMap, list, Notes, rootOf, type ImportNote } from "./notes";

/** The repo as terragucci finds it: its roots, their dependency layers, and which roots each one reads. */
export interface RepoShape {
  roots: string[];
  layers: string[][];
  reads: Map<string, Set<string>>;
}

export interface TerrateamOptions {
  forge?: ForgeName;
  applyWhen?: ApplyWhen;
  /** The repo's roots; without it, the `dirs` keys that name one directory stand in for them. */
  repo?: RepoShape;
}

export interface TerrateamConverted {
  settings: ProjectSettings;
  notes: ImportNote[];
  /** `dirs` keys that match no root. */
  missing: string[];
}

const TOP_KEYS = new Set([
  "version", "enabled", "dirs", "when_modified", "apply_requirements", "automerge", "engine", "default_tf_version", "hooks", "workflows",
  "lock_policy", "parallel_runs", "access_control", "cost_estimation", "drift", "create_and_select_workspace",
]);
const WHEN_MODIFIED_KEYS = new Set(["file_patterns", "autoplan", "autoplan_draft_pr", "autoapply", "depends_on", "prechecks"]);
const DIR_KEYS = new Set(["tags", "workspaces", "stacks", "when_modified", "create_and_select_workspace", "lock_branch_target", "create_if_missing"]);
const WORKFLOW_KEYS = new Set(["tag_query", "plan", "apply", "engine", "terraform_version", "lock_policy", "cdktf", "terragrunt", "environment", "runs_on", "integrations", "storage"]);
/** One release, as terragucci installs it. */
const RELEASE = /^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.]+)?$/;
/** Terrateam's drift schedules as cron, at a minute off the hour. */
const DRIFT_CRON: Record<string, string> = { hourly: "17 * * * *", daily: "17 4 * * *", weekly: "17 4 * * 1", monthly: "17 4 1 * *" };

/** A `dirs` key as a root glob: a glob down to a file (`**\/terragrunt.hcl`) names its directory. */
export function dirGlob(key: string): string | undefined {
  const parts = key.split("/");
  if (parts.length && /\.(tf|hcl|tfvars|json)$/.test(parts[parts.length - 1])) parts.pop();
  return rootOf(parts.join("/") || ".");
}

/** A path relative to `from`, normalised; undefined when it leaves the repo. */
function relativeTo(from: string, rel: string): string | undefined {
  const out: string[] = from === "." ? [] : from.split("/");
  for (const p of rel.split("/")) {
    if (p === "" || p === ".") continue;
    if (p === "..") {
      if (!out.length) return undefined;
      out.pop();
    } else out.push(p);
  }
  return out.length ? out.join("/") : ".";
}

export type Query = { all: true } | { globs: string[] };

/**
 * A tag query as root globs. `""` is every root; `dir:a or dir:b` is those
 * directories; `relative_dir:` is from `from`; `x in outputs:dir` names dir.
 * Anything else (tags, `and`, `not`, parentheses) is undefined: the import
 * cannot tell which roots it picks.
 */
export function queryGlobs(q: unknown, from?: string): Query | undefined {
  if (q === undefined || q === null) return { all: true };
  if (typeof q !== "string") return undefined;
  if (q.trim() === "") return { all: true };
  const globs: string[] = [];
  for (const term of q.trim().split(/\s+or\s+/)) {
    const t = term.trim();
    let m: RegExpMatchArray | null;
    let path: string | undefined;
    if ((m = t.match(/^dir:(\S+)$/))) path = dirGlob(m[1]);
    else if ((m = t.match(/^relative_dir:(\S+)$/)) && from !== undefined) path = relativeTo(from, m[1]);
    else if ((m = t.match(/^\S+\s+in\s+outputs:(\S+)$/))) path = dirGlob(m[1]);
    if (path === undefined) return undefined;
    globs.push(path);
  }
  return { globs };
}

const matches = (glob: string, root: string): boolean => glob === root || globMatch(glob, root);

/** One argument of a command as the shell reads it. */
function shellWord(w: string): string {
  return /^[A-Za-z0-9_@%+=:,./${}-]+$/.test(w) ? w : `'${w.replace(/'/g, `'\\''`)}'`;
}

/** A `run` hook or workflow step's command as one shell line, with its `env`. */
function commandLine(cmd: unknown, env: unknown): string | undefined {
  const words = list(cmd);
  if (!words.length || words.some((w) => typeof w !== "string")) return undefined;
  const vars = isMap(env) ? Object.entries(env).filter(([k, v]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && typeof v === "string") : [];
  return [...vars.map(([k, v]) => `${k}=${shellWord(v as string)}`), ...(words as string[]).map(shellWord)].join(" ");
}

/** An env hook's value when its command only prints a fixed string: `['echo', 'value']`. */
function echoed(cmd: unknown): string | undefined {
  const w = list(cmd);
  if (w.length === 2 && w[0] === "echo" && typeof w[1] === "string" && !/[$`]/.test(w[1])) return w[1];
  return undefined;
}

class Reader {
  readonly notes = new Notes();
  readonly s: ProjectSettings = {};
  readonly steps: StepSettings[] = [];
  readonly env = new Map<string, { value: string; key: string }>();
  readonly envConflicts = new Set<string>();
  readonly missing: string[] = [];
  /** Requirements named, with the keys that named them. */
  readonly requires = new Map<ApplyRequire, string[]>();
  requirementsSet = false;
  /** Entries of apply_requirements.checks that differ from the first. */
  requirementsDiffer = false;
  afterMerge: string[] = [];
  autoMerge?: string;
  terragrunt = false;
  binaries = new Map<string, string[]>();
  versions = new Map<string, string[]>();
  /** dependent root -> its upstreams, with the key that named each. */
  readonly edges = new Map<string, Map<string, string>>();
  constructor(readonly roots: string[], readonly o: TerrateamOptions) {}

  binary(name: string, key: string): void {
    this.binaries.set(name, [...(this.binaries.get(name) ?? []), key]);
  }
  version(v: unknown, key: string): void {
    if (v === undefined) return;
    const clean = String(v).trim().replace(/^v/, "");
    if (!RELEASE.test(clean)) return this.notes.terrateam("unmapped", key, "Engine", `${JSON.stringify(v)} is not one release, so the roots' required_version pins decide`);
    this.versions.set(clean, [...(this.versions.get(clean) ?? []), key]);
  }

  takeEnv(key: string, name: unknown, value: string): void {
    if (typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return this.notes.terrateam("unmapped", key, "Hooks", "its name is not a variable name");
    const had = this.env.get(name);
    if (had && had.value !== value) {
      this.envConflicts.add(name);
      return this.notes.terrateam("unmapped", key, "Hooks", `${name} is set to two values (in ${had.key} too), and \`env\` holds one`);
    }
    if (!had) this.env.set(name, { value, key });
  }

  /**
   * One hook or workflow step that is not init, plan or apply. `stages` are
   * the moments it runs at; `roots` the globs of the roots it runs for;
   * `fromRepo` when it runs from the repo's root, as a hook does.
   */
  op(at: string, op: unknown, stages: { before?: StepStage; after?: StepStage }[], roots: string[] | undefined, fromRepo: boolean, row: "Hooks" | "Workflow steps"): void {
    if (!isMap(op)) return this.notes.unknown(at);
    const type = op.type;
    if (type === "run") {
      const line = commandLine(op.cmd, op.env);
      if (line === undefined) return this.notes.terrateam("unmapped", at, row, "its cmd is not a list of words");
      let run = fromRepo ? `cd "$TG_REPO" && ${line}` : line;
      if (op.ignore_errors === true) run = `${run} || true`;
      const gate = list(op.on_error).some((e) => isMap(e) && e.type === "gate");
      const done: string[] = [];
      for (const st of stages) {
        const stage = st.before ?? st.after!;
        const step: StepSettings = { name: at, run, ...st, ...(roots ? { roots } : {}) };
        if (gate && (stage === "init" || stage === "plan")) step.on_failure = "approve";
        this.steps.push(step);
        done.push(`${st.before ? "before" : "after"}: ${stage}`);
      }
      this.notes.terrateam("mapped", at, row, `steps: ${done.join(" and ")}${roots ? ` for ${roots.join(", ")}` : ""}${fromRepo ? ", from the repo's root" : ""}, once per root`);
      if (op.run_on !== undefined && op.run_on !== "success") this.notes.terrateam("unmapped", `${at}.run_on`, row, `a step after a stage runs when the stage succeeded, so run_on: ${String(op.run_on)} is not kept`);
      if (gate && stages.some((st) => (st.before ?? st.after) === "apply")) this.notes.terrateam("unmapped", `${at}.on_error`, row, "on_failure: approve holds a wave before it applies, so a step at apply cannot open a gate");
      else if (gate) this.notes.terrateam("mapped", `${at}.on_error`, row, "on_failure: approve: a failure holds the root's wave for an approval, which `approval` decides, not the gate's own approvers");
      for (const k of ["capture_output", "visible_on", "format"]) if (op[k] !== undefined) this.notes.terrateam("unmapped", `${at}.${k}`, row, "a step's output goes to the job log");
      for (const k of Object.keys(op)) if (!["type", "cmd", "env", "ignore_errors", "on_error", "run_on", "capture_output", "visible_on", "format"].includes(k)) this.notes.unknown(`${at}.${k}`);
      return;
    }
    if (type === "env") {
      if (op.method === "source") return this.notes.terrateam("unmapped", at, row, "it sources a script, and `env` holds fixed values; a step cannot set the binary's environment");
      if (op.sensitive === true) return this.notes.terrateam("unmapped", at, row, "it is sensitive, and `env` holds no secrets; keep it in a CI secret");
      const value = echoed(op.cmd);
      if (value === undefined) return this.notes.terrateam("unmapped", at, row, "it runs a command for its value, and `env` holds fixed values; a step cannot set the binary's environment");
      if (roots) return this.notes.terrateam("unmapped", at, row, "it is for some roots only, and `env` is every job's");
      return this.takeEnv(at, op.name, value);
    }
    if (type === "oidc") {
      const role = typeof op.role_arn === "string" ? ` Terrateam assumed ${op.role_arn} for plan and apply alike` : "";
      return this.notes.terrateam("unmapped", at, "Cloud credentials", `name a read-only plan role and an apply role under \`oidc\`.${role}`);
    }
    if (type === "conftest" || type === "opa" || type === "checkov") return this.notes.terrateam("unmapped", at, "Policy", type === "checkov" ? "terragucci runs no checkov; run it as a step" : "set `policy:` and keep the Rego in the repo");
    if (type === "drift_create_issue") return this.notes.terrateam("default", at, "Drift");
    if (type === "slack") return this.notes.unknown(at, "`notify` sends the pipeline's events to Slack, Teams or a webhook");
    return this.notes.unknown(at);
  }
}

/** Effective when_modified of a dir entry, over the global one. */
function whenModified(global: unknown, dir: unknown): Record<string, unknown> {
  return { ...(isMap(global) ? global : {}), ...(isMap(dir) ? dir : {}) };
}

/** Turn a parsed `.terrateam/config.yml` into terragucci settings and a note per setting. */
export function convertTerrateam(doc: Record<string, unknown>, o: TerrateamOptions = {}): TerrateamConverted {
  const dirs = isMap(doc.dirs) ? doc.dirs : {};
  const literal = Object.keys(dirs).map((k) => (/[*?[]/.test(k) ? undefined : dirGlob(k))).filter((r): r is string => r !== undefined);
  const roots = o.repo?.roots ?? [...new Set(literal)].sort();
  const r = new Reader(roots, o);
  const { notes, s } = r;

  for (const k of Object.keys(doc)) if (!TOP_KEYS.has(k)) notes.unknown(k);
  if (doc.version !== undefined) notes.own("version", "default", "the file's format version; terragucci.yml has none");
  if (doc.enabled === false) notes.own("enabled", "unmapped", "Terrateam is off for this repo; terragucci runs once init writes its pipeline, and no key turns it off");
  else if (doc.enabled !== undefined) notes.own("enabled", "default", "terragucci runs once init writes its pipeline");
  if (doc.create_and_select_workspace !== undefined) notes.terrateam("default", "create_and_select_workspace", "Workspace");

  // Engine and versions.
  readEngine(r, "engine", doc.engine);
  if (doc.default_tf_version !== undefined) {
    if (doc.engine === undefined) r.binary("terraform", "default_tf_version");
    r.version(doc.default_tf_version, "default_tf_version");
  }

  // Directories: Terrateam's every directory with Terraform files, which detection matches.
  const entryOf = (root: string): [string, Record<string, unknown>] | undefined => {
    let best: [string, Record<string, unknown>] | undefined;
    for (const [key, entry] of Object.entries(dirs)) {
      const glob = dirGlob(key);
      if (glob === undefined || !matches(glob, root)) continue;
      if (glob === root) return [key, isMap(entry) ? entry : {}];
      if (!best || key.length > best[0].length) best = [key, isMap(entry) ? entry : {}];
    }
    return best;
  };
  if (doc.dirs !== undefined) {
    const n = Object.keys(dirs).length;
    notes.terrateam("default", "dirs", "Which directories", `${n} ${n === 1 ? "entry" : "entries"}; terragucci detects the roots, so no roots are written`);
  }
  for (const [key, entry] of Object.entries(dirs)) {
    const at = `dirs.${key}`;
    const glob = dirGlob(key);
    if (glob === undefined) {
      notes.terrateam("unmapped", at, "Which directories", `${JSON.stringify(key)} is not a directory inside the repo`);
      continue;
    }
    const hit = roots.filter((x) => matches(glob, x));
    if (!isMap(entry)) {
      if (entry !== null && entry !== undefined) notes.unknown(at);
      if (!hit.length) r.missing.push(key);
      continue;
    }
    for (const k of Object.keys(entry)) if (!DIR_KEYS.has(k)) notes.unknown(`${at}.${k}`);
    if (entry.tags !== undefined) notes.terrateam("default", `${at}.tags`, "Tags");
    if (entry.create_and_select_workspace !== undefined) notes.terrateam("default", `${at}.create_and_select_workspace`, "Workspace");
    if (entry.stacks !== undefined) notes.terrateam("unmapped", `${at}.stacks`, "Engine", "CDKTF stacks are roots once `synth` writes them");
    if (isMap(entry.workspaces)) {
      for (const [ws, body] of Object.entries(entry.workspaces)) {
        if (ws === "default") {
          if (isMap(body) && body.when_modified !== undefined) readWhenModified(r, `${at}.workspaces.default.when_modified`, body.when_modified, hit, glob);
          continue;
        }
        notes.terrateam("unmapped", `${at}.workspaces.${ws}`, "Workspace", `workspace ${ws} is not planned`);
      }
    }
    const disabled = isMap(entry.when_modified) && Array.isArray(entry.when_modified.file_patterns) && entry.when_modified.file_patterns.length === 0;
    if (disabled) {
      if (hit.length) notes.terrateam("unmapped", `${at}.when_modified.file_patterns`, "Which directories", `${hit.join(", ")} ${hit.length === 1 ? "is a root" : "are roots"} detection finds and plans`);
      else notes.terrateam("default", `${at}.when_modified.file_patterns`, "Which directories", "no root here: detection already leaves it out");
    } else if (!hit.length) r.missing.push(key);
    if (isMap(entry.when_modified) && disabled) {
      const { file_patterns: _, ...rest } = entry.when_modified;
      readWhenModified(r, `${at}.when_modified`, rest, hit, glob);
    } else if (entry.when_modified !== undefined) readWhenModified(r, `${at}.when_modified`, entry.when_modified, hit, glob);
  }
  if (doc.when_modified !== undefined) readWhenModified(r, "when_modified", doc.when_modified, roots, undefined);

  // Dependencies: each root's effective depends_on.
  for (const root of roots) {
    const e = entryOf(root);
    const wm = whenModified(doc.when_modified, e?.[1].when_modified);
    if (wm.depends_on === undefined) continue;
    const key = e && isMap(e[1].when_modified) && e[1].when_modified.depends_on !== undefined ? `dirs.${e[0]}.when_modified.depends_on` : "when_modified.depends_on";
    const raw = isMap(wm.depends_on) ? wm.depends_on.tag_query : wm.depends_on;
    const q = queryGlobs(raw, root);
    if (q === undefined || "all" in q) {
      notes.terrateam("unmapped", key, "Order", `the import reads depends_on made of dir:, relative_dir: or outputs: terms joined by or, not ${JSON.stringify(raw)}`);
      continue;
    }
    const ups = roots.filter((x) => x !== root && q.globs.some((g) => matches(g, x)));
    const none = q.globs.filter((g) => !roots.some((x) => matches(g, x)));
    if (none.length) notes.terrateam("unmapped", `${key}: ${none.join(", ")}`, "Order", `${none.join(", ")} ${none.length === 1 ? "matches" : "match"} no root`);
    if (!r.edges.has(root)) r.edges.set(root, new Map());
    for (const u of ups) r.edges.get(root)!.set(u, key);
    if (isMap(wm.depends_on) && wm.depends_on.prune_on_no_change !== undefined) notes.terrateam("unmapped", `${key}.prune_on_no_change`, "What triggers a plan", "a root that reads a changed root's state plans with it");
  }
  order(r);

  // Hooks.
  if (doc.hooks !== undefined) {
    if (!isMap(doc.hooks)) notes.unknown("hooks");
    else {
      for (const [phase, hook] of Object.entries(doc.hooks)) {
        if (!["all", "plan", "apply"].includes(phase) || !isMap(hook)) {
          notes.unknown(`hooks.${phase}`);
          continue;
        }
        for (const [when, ops] of Object.entries(hook)) {
          if (when !== "pre" && when !== "post") {
            notes.unknown(`hooks.${phase}.${when}`);
            continue;
          }
          const stages: { before?: StepStage; after?: StepStage }[] =
            when === "pre" ? [{ before: phase === "all" ? "init" : (phase as StepStage) }] : phase === "all" ? [{ after: "plan" }, { after: "apply" }] : [{ after: phase as StepStage }];
          list(ops).forEach((op, i) => r.op(`hooks.${phase}.${when}[${i}]`, op, stages, undefined, true, "Hooks"));
        }
      }
    }
  }

  // Workflows.
  list(doc.workflows).forEach((wf, i) => readWorkflow(r, i, wf));

  // Apply requirements.
  readRequirements(r, doc.apply_requirements);

  // Merge after apply.
  if (doc.automerge !== undefined) {
    if (!isMap(doc.automerge)) notes.unknown("automerge");
    else {
      if (doc.automerge.enabled === true) r.autoMerge = "automerge.enabled";
      else notes.terrateam("default", "automerge.enabled", "Merge after apply", "off, as terragucci's default");
      for (const k of Object.keys(doc.automerge)) if (k !== "enabled") notes.terrateam("unmapped", `automerge.${k}`, "Merge after apply", "apply.merge: auto merges with a merge commit and leaves the branch");
    }
  }

  // Locks.
  if (doc.lock_policy !== undefined) {
    if (doc.lock_policy === "none") notes.terrateam("unmapped", "lock_policy", "Locks", "lock_policy: none takes no lock");
    else notes.terrateam("default", "lock_policy", "Locks");
  }

  // Concurrency.
  if (doc.parallel_runs !== undefined) {
    if (doc.parallel_runs === 1) {
      s.parallelism = 1;
      notes.terrateam("mapped", "parallel_runs", "Concurrency", "parallelism: 1");
    } else notes.terrateam("default", "parallel_runs", "Concurrency", "read from the state backend");
  }

  // Access control.
  if (doc.access_control !== undefined) {
    const keys = isMap(doc.access_control) ? Object.keys(doc.access_control) : [];
    if (!keys.length) notes.terrateam("unmapped", "access_control", "Access control");
    for (const k of keys) notes.terrateam(k === "enabled" && doc.access_control !== null && (doc.access_control as Record<string, unknown>).enabled === false ? "default" : "unmapped", `access_control.${k}`, "Access control");
  }

  // Cost.
  if (doc.cost_estimation !== undefined) {
    const c = isMap(doc.cost_estimation) ? doc.cost_estimation : {};
    if (c.enabled === false) notes.terrateam("default", "cost_estimation", "Cost", "off, as terragucci's default");
    else if (c.provider !== undefined && c.provider !== "infracost") notes.terrateam("unmapped", "cost_estimation.provider", "Cost", `terragucci prices with Infracost, not ${String(c.provider)}`);
    else {
      s.cost = true;
      notes.terrateam("mapped", "cost_estimation", "Cost", "cost: true");
    }
    if (c.currency !== undefined && c.currency !== "USD") notes.terrateam("unmapped", "cost_estimation.currency", "Cost", "Infracost prices in USD here");
    for (const k of Object.keys(c)) if (!["enabled", "provider", "currency"].includes(k)) notes.unknown(`cost_estimation.${k}`);
  }

  // Drift.
  readDrift(r, doc.drift);

  finish(r);
  validateConfig(s, "terragucci.yml");
  return { settings: s, notes: notes.list, missing: r.missing };
}

function readEngine(r: Reader, at: string, e: unknown, scoped = false): void {
  const { notes } = r;
  if (e === undefined) return;
  if (!isMap(e) || typeof e.name !== "string") return notes.unknown(at);
  const n = e.name;
  for (const k of Object.keys(e)) {
    if (!["name", "version", "tf_version", "tf_cmd", "override_tf_cmd", "outputs"].includes(k)) notes.unknown(`${at}.${k}`);
  }
  if (e.override_tf_cmd !== undefined) notes.terrateam("unmapped", `${at}.override_tf_cmd`, "Engine", "the pipeline runs the binary its image carries");
  if (e.outputs !== undefined) notes.unknown(`${at}.outputs`);
  if (n === "terraform" || n === "tofu") {
    r.binary(n, `${at}.name`);
    r.version(e.version, `${at}.version`);
  } else if (n === "terragrunt") {
    if (scoped) {
      notes.terrateam("unmapped", `${at}.name`, "Engine", "Terragrunt is detected for the whole repo, from its root.hcl or terragrunt.hcl");
      return;
    }
    r.terragrunt = true;
    if (e.version !== undefined) {
      const v = String(e.version).trim().replace(/^v/, "");
      const m = RELEASE.exec(v);
      if (m && (Number(m[1]) > 1 || (Number(m[1]) === 1 && Number(m[2]) >= 1))) {
        r.s.terragrunt = { version: v };
        notes.terrateam("mapped", `${at}.version`, "Engine", `terragrunt.version: ${v}`);
      } else notes.terrateam("unmapped", `${at}.version`, "Engine", `terragucci runs Terragrunt 1.1 or later, a release such as 1.1.6, not ${JSON.stringify(e.version)}`);
    }
    if (e.tf_cmd === "tofu" || e.tf_cmd === "terraform") r.binary(e.tf_cmd, `${at}.tf_cmd`);
    else if (e.tf_cmd !== undefined) notes.terrateam("unmapped", `${at}.tf_cmd`, "Engine", `${String(e.tf_cmd)} is not a binary the pipeline runs`);
    r.version(e.tf_version, `${at}.tf_version`);
    notes.terrateam("default", `${at}.name`, "Engine", "Terragrunt is detected from the repo's root.hcl or terragrunt.hcl");
  } else if (n === "cdktf") {
    notes.terrateam("unmapped", at, "Engine", "set `synth` to the command that writes the stacks, such as npx cdktf synth");
  } else {
    notes.terrateam("unmapped", at, "Engine", `terragucci runs Terraform, OpenTofu and Terragrunt, not ${n}`);
  }
}

function readWhenModified(r: Reader, at: string, wm: unknown, hit: string[], glob: string | undefined): void {
  const { notes } = r;
  if (!isMap(wm)) {
    if (wm !== null) notes.unknown(at);
    return;
  }
  for (const k of Object.keys(wm)) if (!WHEN_MODIFIED_KEYS.has(k)) notes.unknown(`${at}.${k}`);
  if (wm.file_patterns !== undefined) notes.terrateam("default", `${at}.file_patterns`, "What triggers a plan");
  if (wm.autoplan === false) notes.terrateam("unmapped", `${at}.autoplan`, "What triggers a plan", "no key turns the plan off for a root");
  else if (wm.autoplan !== undefined) notes.terrateam("default", `${at}.autoplan`, "What triggers a plan");
  if (wm.autoplan_draft_pr !== undefined) notes.terrateam(wm.autoplan_draft_pr === false ? "unmapped" : "default", `${at}.autoplan_draft_pr`, "What triggers a plan", wm.autoplan_draft_pr === false ? "a draft pull request plans as any other does" : undefined);
  if (wm.prechecks !== undefined) notes.unknown(`${at}.prechecks`);
  if (wm.depends_on !== undefined && glob !== undefined && !hit.length) notes.terrateam("unmapped", `${at}.depends_on`, "Order", "it matches no root");
  if (wm.autoapply !== undefined) {
    if (glob === undefined) {
      if (wm.autoapply === true) r.afterMerge.push(at);
      notes.terrateam("default", `${at}.autoapply`, "When it applies");
    } else if (!hit.length) {
      notes.terrateam("unmapped", `${at}.autoapply`, "When it applies", "it matches no root");
    } else {
      // A directory's own autoapply that differs from the repo's: one apply.when covers every root.
      notes.terrateam("unmapped", `${at}.autoapply`, "When it applies", `apply.when is one setting for every root, so ${hit.join(", ")} ${wm.autoapply === true ? "apply" : "do not apply"} after merge as the rest do`);
    }
  }
}

function readWorkflow(r: Reader, i: number, wf: unknown): void {
  const { notes } = r;
  const at = `workflows[${i}]`;
  if (!isMap(wf)) return notes.unknown(at);
  for (const k of Object.keys(wf)) if (!WORKFLOW_KEYS.has(k)) notes.unknown(`${at}.${k}`);
  const q = queryGlobs(wf.tag_query);
  const roots = q && "globs" in q ? q.globs : undefined;
  if (wf.engine !== undefined) readEngine(r, `${at}.engine`, wf.engine, true);
  if (wf.terraform_version !== undefined) r.version(wf.terraform_version, `${at}.terraform_version`);
  if (wf.terragrunt === true) notes.terrateam("unmapped", `${at}.terragrunt`, "Engine", "Terragrunt is detected for the whole repo, from its root.hcl or terragrunt.hcl");
  if (wf.cdktf === true) notes.terrateam("unmapped", `${at}.cdktf`, "Engine", "set `synth` to the command that writes the stacks, such as npx cdktf synth");
  if (wf.lock_policy !== undefined) notes.terrateam(wf.lock_policy === "none" ? "unmapped" : "default", `${at}.lock_policy`, "Locks", wf.lock_policy === "none" ? "lock_policy: none takes no lock" : undefined);
  for (const part of ["plan", "apply"] as const) {
    if (wf[part] === undefined) continue;
    let seenInit = false;
    let seenMain = false;
    list(wf[part]).forEach((op, j) => {
      const k = `${at}.${part}[${j}]`;
      if (!isMap(op)) return notes.unknown(k);
      const type = op.type;
      if (type === "init" || type === "plan" || type === "apply") {
        if (type === "init") seenInit = true;
        else seenMain = true;
        if (op.extra_args !== undefined) notes.leftOut(`${k}.extra_args`, "Flags at run time");
        if (op.env !== undefined) {
          const vars = isMap(op.env) ? Object.entries(op.env) : [];
          if (q && "all" in q && vars.every(([, v]) => typeof v === "string" && !/[$`]/.test(v))) for (const [name, v] of vars) r.takeEnv(`${k}.env.${name}`, name, v as string);
          else notes.terrateam("unmapped", `${k}.env`, "Workflow steps", "`env` holds fixed values every job gets");
        }
        if (op.mode === "fast-and-loose") notes.terrateam("unmapped", `${k}.mode`, "What triggers a plan", "a plan reads what the change reaches");
        for (const x of Object.keys(op)) if (!["type", "extra_args", "env", "mode"].includes(x)) notes.unknown(`${k}.${x}`);
        return;
      }
      if (type === "run" && !roots && !(q && "all" in q)) {
        return notes.terrateam("unmapped", k, "Workflow steps", `the import cannot tell which roots tag_query ${JSON.stringify(wf.tag_query)} picks; write the step with roots globs`);
      }
      const stage: { before?: StepStage; after?: StepStage } =
        part === "plan" ? (seenMain ? { after: "plan" } : seenInit ? { before: "plan" } : { before: "init" }) : seenMain ? { after: "apply" } : { before: "apply" };
      r.op(k, op, [stage], roots, false, "Workflow steps");
    });
  }
}

function readRequirements(r: Reader, ar: unknown): void {
  const { notes } = r;
  if (ar === undefined) return;
  if (!isMap(ar)) return notes.unknown("apply_requirements");
  r.requirementsSet = ar.checks !== undefined;
  for (const k of Object.keys(ar)) if (k !== "checks") notes.unknown(`apply_requirements.${k}`, "terragucci posts terragucci/plan and terragucci/apply statuses from its own jobs");
  if (ar.checks === undefined) return;
  const entries = isMap(ar.checks) ? [{ at: "apply_requirements.checks", e: ar.checks as Record<string, unknown> }] : list(ar.checks).map((e, i) => ({ at: `apply_requirements.checks[${i}]`, e }));
  let first: string | undefined;
  let afterMerge = 0;
  for (const { at, e } of entries) {
    if (!isMap(e)) {
      notes.unknown(at);
      continue;
    }
    for (const k of Object.keys(e)) if (!["tag_query", "approved", "merge_conflicts", "status_checks", "apply_after_merge", "require_ready_for_review_pr"].includes(k)) notes.unknown(`${at}.${k}`);
    const q = queryGlobs(e.tag_query);
    if (!(q && "all" in q)) notes.terrateam("unmapped", `${at}.tag_query`, "Required approval", `apply.requires covers every root, not only ${JSON.stringify(e.tag_query)}`);
    const these: ApplyRequire[] = [];
    const approved = isMap(e.approved) ? e.approved : undefined;
    if (approved?.enabled === true) {
      these.push("approved");
      const extra = Object.keys(approved).filter((k) => k !== "enabled" && !(k === "count" && approved.count === 1) && !(k === "any_of_count" && approved.any_of_count === 1));
      if (extra.length) notes.terrateam("unmapped", `${at}.approved.${extra.join(", ")}`, "Required approval", "apply.requires: [approved] needs one reviewer other than the author; require more, or particular reviewers, with branch protection");
    }
    const mc = isMap(e.merge_conflicts) ? e.merge_conflicts : {};
    if (mc.enabled !== false) these.push("mergeable");
    const sc = isMap(e.status_checks) ? e.status_checks : {};
    if (sc.enabled !== false) these.push("checks");
    if (sc.ignore_matching !== undefined && list(sc.ignore_matching).length) notes.terrateam("unmapped", `${at}.status_checks.ignore_matching`, "Checks green", "checks waits on every status but its own");
    if (isMap(e.apply_after_merge) && e.apply_after_merge.enabled === true) {
      afterMerge++;
      r.afterMerge.push(`${at}.apply_after_merge`);
    }
    if (e.require_ready_for_review_pr !== undefined) notes.unknown(`${at}.require_ready_for_review_pr`);
    for (const req of these) r.requires.set(req, [...(r.requires.get(req) ?? []), at]);
    const sig = [...these].sort().join(",");
    if (first === undefined) first = sig;
    else if (sig !== first) r.requirementsDiffer = true;
  }
  if (afterMerge && afterMerge < entries.length) notes.terrateam("unmapped", "apply_requirements.checks[].apply_after_merge", "When it applies", "apply.when is one setting for every root");
}

function readDrift(r: Reader, d: unknown): void {
  const { notes, s } = r;
  if (d === undefined) return;
  if (!isMap(d)) return notes.unknown("drift");
  if (d.enabled !== true) {
    notes.terrateam("default", "drift", "Drift", "off, as terragucci's default");
    return;
  }
  const schedules: { at: string; e: Record<string, unknown> }[] = isMap(d.schedules)
    ? Object.entries(d.schedules).map(([name, e]) => ({ at: `drift.schedules.${name}`, e: isMap(e) ? e : {} }))
    : [{ at: "drift", e: d }];
  for (const k of Object.keys(d)) if (!["enabled", "schedule", "schedules", "tag_query", "reconcile"].includes(k)) notes.unknown(`drift.${k}`);
  for (const { at, e } of schedules) {
    const q = queryGlobs(e.tag_query);
    const cron = typeof e.schedule === "string" ? DRIFT_CRON[e.schedule] : undefined;
    if (!cron) notes.terrateam("unmapped", `${at}.schedule`, "Drift", `${JSON.stringify(e.schedule)} is not hourly, daily, weekly or monthly`);
    else if (s.drift !== undefined) notes.terrateam("unmapped", at, "Drift", `drift is one schedule, and ${s.drift} is written`);
    else {
      s.drift = cron;
      notes.terrateam("mapped", `${at}.schedule`, "Drift", `drift: "${cron}", ${e.schedule}`);
      if (!(q && "all" in q)) notes.terrateam("unmapped", `${at}.tag_query`, "Drift", `drift runs over every root, not only ${JSON.stringify(e.tag_query)}`);
    }
    if (e.reconcile === true) notes.terrateam("unmapped", `${at}.reconcile`, "Drift", "a drift run never applies; respond.drift opens a pull request for it instead");
    if (e.window !== undefined) notes.terrateam("unmapped", `${at}.window`, "Drift", "the cron schedule is the window");
  }
}

/**
 * The order depends_on asks for, in the waves terragucci makes: dependencies
 * the reads already give need nothing; the rest go into waves.canary as far
 * as one canary set can carry them.
 */
function order(r: Reader): void {
  const { notes } = r;
  if (!r.edges.size) return;
  if (r.terragrunt) {
    for (const key of new Set([...r.edges.values()].flatMap((m) => [...m.values()]))) notes.terrateam("unmapped", key, "Order", "in a Terragrunt repo the units' dependency blocks order them");
    return;
  }
  const layers = r.o.repo?.layers ?? [r.roots];
  const reads = r.o.repo?.reads ?? new Map<string, Set<string>>();
  const waveOf = (canary: Set<string>): Map<string, number> => {
    const m = new Map<string, number>();
    applyWaves(layers, [...canary]).forEach((w, i) => w.forEach((x) => m.set(x, i)));
    return m;
  };
  const edges = [...r.edges].flatMap(([d, ups]) => [...ups].map(([u, key]) => ({ d, u, key })));
  const ok = (w: Map<string, number>, e: { d: string; u: string }): boolean => (w.get(e.u) ?? 0) < (w.get(e.d) ?? 0);
  const plain = waveOf(new Set());
  const canary = new Set(edges.filter((e) => !ok(plain, e)).map((e) => e.u));
  // A canary root's upstreams go first with it.
  const upstreams = (x: string, into: Set<string>): void => {
    for (const u of reads.get(x) ?? []) if (!into.has(u)) {
      into.add(u);
      upstreams(u, into);
    }
  };
  for (const x of [...canary]) upstreams(x, canary);
  // A canary root that must wait for another root cannot go first: drop it, and every canary root that reads it.
  for (;;) {
    const w = waveOf(canary);
    const bad = edges.find((e) => canary.has(e.d) && !ok(w, e));
    if (!bad) break;
    const drop = new Set([bad.d]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const x of canary) if (!drop.has(x) && [...(reads.get(x) ?? [])].some((u) => drop.has(u))) {
        drop.add(x);
        grew = true;
      }
    }
    for (const x of drop) canary.delete(x);
  }
  const final = waveOf(canary);
  if (canary.size) r.s.waves = { canary: [...canary].sort() };
  const byKey = new Map<string, typeof edges>();
  for (const e of edges) byKey.set(e.key, [...(byKey.get(e.key) ?? []), e]);
  for (const [key, es] of byKey) {
    const late = es.filter((e) => !ok(final, e));
    const fromReads = es.filter((e) => ok(plain, e));
    const fmt = (xs: typeof es) => xs.map((e) => `${e.d} after ${e.u}`).join(", ");
    if (late.length) {
      notes.terrateam("unmapped", key, "Order", `${fmt(late)} ${late.length === 1 ? "is" : "are"} not kept: waves.canary puts one set of roots first, and ${late.length === 1 ? "this needs" : "these need"} a second; read the upstream's outputs with terraform_remote_state to order ${late.length === 1 ? "it" : "them"}`);
    } else if (fromReads.length === es.length) {
      notes.terrateam("default", key, "Order", `the terraform_remote_state reads already order ${fmt(es)}`);
    } else {
      notes.terrateam("mapped", key, "Order", `waves.canary: ${[...canary].sort().join(", ")}, which apply before every other root`);
    }
  }
}

/** Binary, version, when it applies, requirements, merge, locks, env and steps, once every key is read. */
function finish(r: Reader): void {
  const { notes, s, o } = r;
  // Binary and version.
  const bins = [...r.binaries.keys()];
  if (bins.length === 1) {
    s.binary = bins[0] as Binary;
    notes.terrateam("mapped", r.binaries.get(bins[0])![0], "Engine", `binary: ${bins[0]}`);
  } else if (bins.length > 1) {
    notes.terrateam("unmapped", [...r.binaries.values()].flat().join(", "), "Engine", `the config runs ${bins.join(" and ")}, and the pipeline runs one binary`);
  }
  const versions = [...r.versions.keys()];
  if (versions.length === 1) {
    s.version = versions[0];
    for (const key of r.versions.get(versions[0])!) notes.terrateam("mapped", key, "Engine", `version: ${versions[0]}`);
  } else if (versions.length > 1) {
    notes.terrateam("unmapped", [...r.versions.values()].flat().join(", "), "Engine", `the config pins ${versions.join(", ")}, and the pipeline runs one; each root's required_version pin is read instead`);
  }

  // When the change applies.
  const forced = o.applyWhen !== undefined;
  let when: ApplyWhen = o.applyWhen ?? (r.afterMerge.length ? "merge" : "pull-request");
  const why = r.afterMerge.length ? `${r.afterMerge.join(", ")} applies after merge` : "Terrateam applies before merge, on terrateam apply";
  if (when === "pull-request" && o.forge === "gitlab") {
    when = "merge";
    notes.terrateam("unmapped", "when it applies", "When it applies", `left at apply.when: merge: ${PR_APPLY_NEEDS_ON_GITLAB.comments}; and ${PR_APPLY_NEEDS_ON_GITLAB.token}`);
  } else if (when === "pull-request") {
    s.apply = { when };
    notes.terrateam("mapped", "when it applies", "When it applies", forced ? "apply.when: pull-request, from --apply-when" : `apply.when: pull-request, as ${why}; --apply-when merge applies after merge instead`);
  } else {
    notes.terrateam("default", "when it applies", "When it applies", forced ? "apply.when: merge, from --apply-when" : `apply.when: merge, as ${why}`);
  }

  // Requirements.
  const rows: Record<ApplyRequire, "Required approval" | "Checks green"> = { approved: "Required approval", mergeable: "Checks green", checks: "Checks green", undiverged: "Checks green" };
  for (const [req, keys] of r.requires) {
    const key = keys.length === 1 ? keys[0] : `apply_requirements.checks[]: ${req}`;
    if (when === "pull-request") notes.terrateam("mapped", `${key} (${req})`, rows[req], `apply.requires: ${req}`);
    else notes.terrateam("unmapped", `${key} (${req})`, rows[req], "applying after merge, a branch protection rule on the default branch does this job");
  }
  if (when === "pull-request" && s.apply) {
    if (r.requirementsSet) {
      s.apply.requires = APPLY_REQUIRES.filter((x) => r.requires.has(x));
      if (r.requirementsDiffer) notes.own("apply_requirements.checks", "unmapped", `apply.requires covers every root: ${s.apply.requires.join(", ") || "none"}`, "the entries name different requirements, and terragucci keeps one list");
    } else {
      notes.own("apply_requirements", "default", `the config sets no apply_requirements.checks, so apply.requires is left unset and every requirement applies: ${APPLY_REQUIRES.join(", ")}`, "Terrateam's own default asks for no conflicts and green checks only");
    }
  }

  // Merge after apply.
  if (r.autoMerge) {
    const key = r.autoMerge;
    if (when !== "pull-request" || !s.apply) notes.terrateam("unmapped", key, "Merge after apply", "apply.when is merge here, so a person merges");
    else if (o.forge === "forgejo") notes.terrateam("unmapped", key, "Merge after apply", "on Forgejo apply.merge: auto also needs apply.merge_token_env, the secret holding a token that may merge, which this command cannot name; add both");
    else if (s.apply.requires && !s.apply.requires.includes("approved")) notes.terrateam("unmapped", key, "Merge after apply", "apply.merge: auto merges only an approved head, and apply.requires leaves out approved");
    else {
      s.apply.merge = "auto";
      notes.terrateam("mapped", key, "Merge after apply", "apply.merge: auto");
    }
  }
  // Variables every job gets, and steps.
  const env = [...r.env].filter(([name]) => !r.envConflicts.has(name));
  if (env.length) {
    s.env = Object.fromEntries(env.map(([name, v]) => [name, v.value]));
    for (const [name, v] of env) notes.terrateam("mapped", v.key, v.key.startsWith("hooks") ? "Hooks" : "Workflow steps", `env: ${name}`);
  }
  if (r.steps.length) s.steps = r.steps;
}

