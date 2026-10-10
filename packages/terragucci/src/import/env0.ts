/**
 * `terragucci import env0 [env0-discovery.yml]`: terragucci.yml from an env
 * zero repo, by the concepts table of "Coming from Spacelift or env zero"
 * (./spacelift-env0-guide.ts). It reads three things, each when the repo has it:
 *
 *   env0-discovery.yml   the environments env zero creates from the repo
 *   env0.yml             a template's custom flow, in the template's directory
 *   env0_* resources     the admin code: templates (their paths and versions),
 *                        environments, variables, drift and project policies
 *
 * An environment's root is its template's path, from the `env0_template`
 * resource it names, or else the root its first variable file sits in. A
 * custom flow's steps become `steps` for the root its file is in; an
 * environment with a TTL, or in a project whose policy gives one, becomes
 * `ephemeral`; a sensitive variable's name goes under `pass.secrets`, to
 * create as a CI secret.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { parseYAML } from "@intentius/chant/yaml";
import { ConfigError, ttlMs, type StepStage } from "../config";
import { literalString, refTo, resourcesOf, shown, type HclBody, type HclResource, type HclValue } from "./hcl";
import { isMap, list, rootOf } from "./notes";
import { notePlatformOnly, noteUnknown } from "./spacelift-env0-guide";
import { Build, finish, type PlatformConverted, type PlatformOptions, type Unit } from "./platform";

export const ENV0_DISCOVERY_FILES = ["env0-discovery.yml", "env0-discovery.yaml"];
const FLOW_FILES = new Set(["env0.yml", "env0.yaml"]);

const ENV_KEYS = new Set([
  "name", "templateId", "templateName", "projectId", "projectName", "workspaceName", "revision", "variableFiles", "requiresApproval", "isRemoteBackend",
  "continuousDeployment", "autoDeployOnPathChangesOnly", "autoDeployByCustomGlob", "pullRequestPlanDeployments", "vcsPrCommentsEnabled", "vcsCommandsAlias", "driftDetectionCron",
]);

/** The custom flow's deploy steps and the moment each hook runs at. */
const FLOW_STEPS: Record<string, { before?: { before?: StepStage; after?: StepStage }; after?: { before?: StepStage; after?: StepStage } }> = {
  setupVariables: { after: { before: "init" } },
  terraformInit: { before: { before: "init" }, after: { after: "init" } },
  opentofuInit: { before: { before: "init" }, after: { after: "init" } },
  terraformPlan: { before: { before: "plan" }, after: { after: "plan" } },
  opentofuPlan: { before: { before: "plan" }, after: { after: "plan" } },
  terraformApply: { before: { before: "apply" }, after: { after: "apply" } },
  opentofuApply: { before: { before: "apply" }, after: { after: "apply" } },
  storeState: { before: { after: "apply" }, after: { after: "apply" } },
  terraformOutput: { before: { after: "apply" }, after: { after: "apply" } },
  opentofuOutput: { before: { after: "apply" }, after: { after: "apply" } },
};
const OTHER_ENGINES = /^(pulumi|cf|k8s|helm|ansible)/;

/** env zero's TTL (`12-h`, `3-d`, `1-w`, `1-M`) as terragucci's; undefined for Infinite, inherit or anything else. */
export function ttlOf(v: string): string | undefined {
  const m = /^([1-9]\d*)-([hdwM])$/.exec(v.trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  const out = m[2] === "h" ? `${n}h` : m[2] === "d" ? `${n}d` : m[2] === "w" ? `${n * 7}d` : `${n * 30}d`;
  return ttlMs(out) ? out : undefined;
}

interface Env extends Unit {
  res?: HclResource;
  conf?: Record<string, unknown>;
  /** Its template's resource address. */
  template?: string;
  /** Its project's resource address. */
  project?: string;
  /** Its entry in env0-discovery.yml. */
  confKey?: string;
}

const ADDR = (r: HclResource): string => `${r.type}.${r.name}`;

/** Every env0.yml in the repo, as paths relative to it. */
function flowFiles(repo: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const n of names) {
      if (n.startsWith(".") || n === "node_modules") continue;
      const abs = join(dir, n);
      try {
        if (statSync(abs).isDirectory()) walk(abs);
        else if (FLOW_FILES.has(n)) out.push(relative(repo, abs));
      } catch {
        continue;
      }
    }
  };
  walk(repo);
  return out;
}

function yamlOf(repo: string, file: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = parseYAML(readFileSync(join(repo, file), "utf-8"));
  } catch (e) {
    throw new ConfigError(`${file} is not YAML: ${(e as Error).message}`);
  }
  if (parsed === null || parsed === undefined) return {};
  if (!isMap(parsed)) throw new ConfigError(`${file} is not a map of settings`);
  return parsed;
}

/** Read env0-discovery.yml, every env0.yml and the repo's `env0_*` resources. */
export function readEnv0(repo: string, o: PlatformOptions & { file?: string } = {}): PlatformConverted {
  const file = o.file ?? ENV0_DISCOVERY_FILES.find((f) => existsSync(join(repo, f)));
  if (o.file !== undefined && !existsSync(join(repo, o.file))) throw new ConfigError(`import env0 reads ${o.file}, and there is none in ${repo}`);
  const discovery = file !== undefined ? yamlOf(repo, file) : undefined;
  const flows = flowFiles(repo).map((f) => ({ file: f, doc: yamlOf(repo, f) }));
  const resources = resourcesOf(repo, "env0_");
  if (discovery === undefined && !flows.length && !resources.length) {
    throw new ConfigError(`import env0 reads ${ENV0_DISCOVERY_FILES[0]}, env0.yml custom flows or env0_* resources, and there are none in ${repo}`);
  }
  const read = [...(file ? [file] : []), ...flows.map((f) => f.file)];
  for (const r of resources) if (!read.includes(r.file)) read.push(r.file);
  return { ...convertEnv0({ discovery, flows, resources }, o), read };
}

export interface Env0Input {
  discovery?: Record<string, unknown>;
  flows: { file: string; doc: Record<string, unknown> }[];
  resources: HclResource[];
}

/** The root of the repo's roots that holds `path`, the deepest. */
function rootHolding(roots: string[], path: string): string | undefined {
  return roots.filter((r) => r === "." || path === r || path.startsWith(`${r}/`)).sort((a, b) => b.length - a.length)[0];
}

/** Turn env zero's files and resources into terragucci settings and a note per setting. */
export function convertEnv0(input: Env0Input, o: PlatformOptions = {}): Omit<PlatformConverted, "read"> {
  const b = new Build("env zero");
  const { notes } = b;
  const { resources } = input;
  const ofType = (t: string): HclResource[] => resources.filter((r) => r.type === t);
  const repoRoots = o.repo?.roots;

  // Templates: their paths, types and versions.
  const templates = ofType("env0_template");
  const templatePath = new Map<string, string | undefined>();
  for (const t of templates) {
    const key = ADDR(t);
    const path = t.body.attrs.path;
    const p = path === undefined ? "." : literalString(path);
    const root = p === undefined ? undefined : rootOf(p.replace(/^\/+/, "") || ".");
    templatePath.set(key, root);
    if (root === undefined) b.note("unmapped", `${key}.path`, "Root", `${shown(path)} is not a directory inside the repo`);
  }

  // Environments: resources, then the discovery file's, matched by name.
  const envs: Env[] = [];
  for (const r of ofType("env0_environment")) {
    const id = literalString(r.body.attrs.name) ?? r.name;
    const env: Env = { id, key: ADDR(r), res: r, template: refTo(r.body.attrs.template_id), project: refTo(r.body.attrs.project_id) };
    const wt = r.body.blocks.find((x) => x.type === "without_template_settings");
    if (wt) {
      const p = wt.body.attrs.path === undefined ? "." : literalString(wt.body.attrs.path);
      env.root = p === undefined ? undefined : rootOf(p.replace(/^\/+/, "") || ".");
      readTemplate(b, `${env.key}.without_template_settings`, wt.body, [env]);
    } else if (env.template && templatePath.has(env.template)) env.root = templatePath.get(env.template);
    envs.push(env);
  }
  const discovery = input.discovery ?? {};
  for (const k of Object.keys(discovery)) if (k !== "environments") noteUnknown(notes, k);
  const declared = isMap(discovery.environments) ? discovery.environments : {};
  if (discovery.environments !== undefined && !isMap(discovery.environments)) noteUnknown(notes, "environments");
  for (const [k, raw] of Object.entries(declared)) {
    const conf = isMap(raw) ? raw : {};
    const at = `environments.${k}`;
    const id = typeof conf.name === "string" ? conf.name : k;
    const same = envs.find((e) => e.id === id);
    const env: Env = same ?? { id, key: at };
    env.conf = conf;
    env.confKey = at;
    if (!same) envs.push(env);
    for (const x of Object.keys(conf)) if (!ENV_KEYS.has(x)) noteUnknown(notes, `${at}.${x}`);
    if (env.root === undefined && typeof conf.templateName === "string") {
      const t = templates.find((t) => literalString(t.body.attrs.name) === conf.templateName);
      if (t) {
        env.template = ADDR(t);
        env.root = templatePath.get(ADDR(t));
      }
    }
    if (env.root === undefined && repoRoots) {
      const first = list(conf.variableFiles).find((f) => isMap(f) && typeof f.path === "string") as { path: string } | undefined;
      const under = first ? rootHolding(repoRoots, dirname(first.path.replace(/^\.?\//, ""))) : undefined;
      if (under) {
        env.root = under;
        b.note("mapped", `${at}.variableFiles`, "Root", `${under}, the root ${first!.path} is in`);
      }
    }
    if (env.root === undefined) {
      const named = conf.templateName ?? conf.templateId;
      b.note("unmapped", at, "Root", `its template ${named === undefined ? "" : `${JSON.stringify(named)} `}is not an env0_template in the repo and its variable files sit in no root, so the import cannot tell its directory`);
    }
  }
  b.units.push(...envs);

  // Each template's type and version, for the environments that use it.
  for (const t of templates) {
    const users = envs.filter((e) => e.template === ADDR(t));
    readTemplate(b, ADDR(t), t.body, users);
    if (!users.length) notes.own(ADDR(t), "default", "no environment the import read deploys this template, so it is not a root of its own");
  }

  // Projects and their policies: TTL, drift, approval and cost defaults.
  const policyOf = new Map<string, HclResource>();
  for (const p of ofType("env0_project_policy")) {
    const proj = refTo(p.body.attrs.project_id);
    if (proj) policyOf.set(proj, p);
    const key = ADDR(p);
    for (const [k, v] of Object.entries(p.body.attrs)) {
      const at = `${key}.${k}`;
      if (k === "project_id") continue;
      if (k === "default_ttl") {
        const ttl = typeof v === "string" ? ttlOf(v) : undefined;
        if (ttl && (!b.ttl || b.ttl.value === ttl)) b.ttl = { value: ttl, key: at };
        else if (ttl) b.note("unmapped", at, "TTL", `ephemeral.ttl is one setting, and ${b.ttl!.key} gives ${b.ttl!.value}`);
        else b.note("default", at, "TTL", `${shown(v)} is no fixed TTL, so nothing expires`);
      } else if (k === "max_ttl") b.note("default", at, "TTL", "a copy lives until its pull request closes or its TTL passes");
      else if (k === "drift_detection_cron") {
        const cron = literalString(v);
        if (cron) b.drift.push({ cron, key: at, unit: proj ?? key });
      } else if (k === "include_cost_estimation") {
        if (v === true) {
          b.s.cost = true;
          b.note("mapped", at, "Cost", "cost: true");
        } else b.note("default", at, "Cost", "off, as terragucci's default");
      } else if (k === "requires_approval_default" || k === "continuous_deployment_default" || k === "run_pull_request_plan_default" || k === "vcs_pr_comments_enabled_default") {
        notePlatformOnly(notes, at, "env zero", "a default for new environments; each environment's own setting is read");
      } else if (k === "auto_drift_remediation") {
        if (v !== "DISABLED") b.note("unmapped", at, "Drift", "a drift run never applies; respond.drift opens a pull request for it");
      } else if (k === "force_remote_backend") {
        if (v === true) b.note("unmapped", at, "Managed state", "the project's environments keep their state in env zero");
      } else notePlatformOnly(notes, at, "env zero");
    }
  }

  // Each environment's settings, from the discovery file or its resource.
  for (const env of envs) {
    const c = env.conf;
    const r = env.res;
    const get = (yamlKey: string, attr: string): { v: unknown; key: string } | undefined => {
      if (c && c[yamlKey] !== undefined) return { v: c[yamlKey], key: `${env.confKey}.${yamlKey}` };
      if (r && r.body.attrs[attr] !== undefined) return { v: r.body.attrs[attr], key: `${env.key}.${attr}` };
      return undefined;
    };
    const ws = get("workspaceName", "workspace");
    if (ws) b.note("unmapped", ws.key, "Workspace", `workspace ${shown(ws.v as HclValue)} is not planned`);
    const rev = get("revision", "revision");
    if (rev) notePlatformOnly(notes, rev.key, "env zero", "terragucci applies the default branch, and apply.branches applies roots from another");
    const approve = get("requiresApproval", "approve_plan_automatically");
    const waits = approve ? (approve.key.endsWith("requiresApproval") ? approve.v === true : approve.v === false) : undefined;
    if (approve && waits !== undefined) b.approvals.push({ key: approve.key, waits });
    const remote = get("isRemoteBackend", "is_remote_backend");
    const policy = env.project ? policyOf.get(env.project) : undefined;
    if (remote?.v === true || (!remote && policy?.body.attrs.force_remote_backend === true)) {
      b.note("unmapped", remote?.key ?? `${env.key}: ${env.id}`, "Managed state", `${env.id}'s state is in env zero's remote backend: move it to ${env.root ?? "its root"}'s backend before the root's backend block merges`);
    } else if (remote) b.note("default", remote.key, "Own backend");
    const cd = get("continuousDeployment", "deploy_on_push");
    if (cd?.v === false) b.note("unmapped", cd.key, "Triggers", "merge applies what changed; gate: always holds each wave for an approval first");
    else if (cd) b.note("default", cd.key, "Triggers");
    for (const [y, a] of [["autoDeployOnPathChangesOnly", "auto_deploy_on_path_changes_only"], ["autoDeployByCustomGlob", "auto_deploy_by_custom_glob"], ["pullRequestPlanDeployments", "run_plan_on_pull_requests"], ["vcsPrCommentsEnabled", "vcs_pr_comments_enabled"]] as const) {
      const x = get(y, a);
      if (x) b.note("default", x.key, "Triggers", y === "vcsPrCommentsEnabled" ? "a comment of /terragucci plan plans again" : undefined);
    }
    const alias = get("vcsCommandsAlias", "vcs_commands_alias");
    if (alias) b.note("unmapped", alias.key, "Triggers", "comments name a root by its path: /terragucci plan <root>");
    const drift = get("driftDetectionCron", "drift_detection_cron");
    if (drift && typeof drift.v === "string") b.drift.push({ cron: drift.v, key: drift.key, unit: env.id });
    const proj = get("projectName", "project_id") ?? get("projectId", "project_id");
    if (proj) notePlatformOnly(notes, proj.key.replace(/\.[^.]+$/, ".project"), "env zero", "a project's environments are this repo's roots");
    if (c) {
      for (const k of ["name", "templateName", "templateId"]) if (c[k] !== undefined) b.note("default", `environments.*.${k}`, "Root", "a root goes by its path from the repo root");
      list(c.variableFiles).forEach((f, i) => {
        const at = `${env.confKey}.variableFiles[${i}]`;
        const path = isMap(f) && typeof f.path === "string" ? f.path.replace(/^\.?\//, "") : undefined;
        if (path === undefined) return noteUnknown(notes, at);
        const base = path.split("/").pop()!;
        const auto = base === "terraform.tfvars" || base.endsWith(".auto.tfvars");
        if (env.root !== undefined && dirname(path) === env.root && auto) b.note("default", at, "Variables", `the binary reads ${path} in ${env.root} itself`);
        else b.note("unmapped", at, "Variables", `copy ${path} to ${env.root ?? "the root"}/terraform.tfvars (or a *.auto.tfvars there), which the binary reads`);
      });
    }
    // Expiry: a TTL of its own, or its project's.
    const ttl = r?.body.attrs.ttl;
    const projectTtl = policy && typeof policy.body.attrs.default_ttl === "string" ? ttlOf(policy.body.attrs.default_ttl) : undefined;
    if (ttl !== undefined || projectTtl) {
      const key = ttl !== undefined ? `${env.key}.ttl` : `${env.key}: ${env.id}`;
      if (env.root === undefined) b.note("unmapped", key, "TTL", `${env.id} has no root`);
      else b.ephemeral.push({ root: env.root, key });
    }
    if (r) {
      const known = new Set(["name", "template_id", "project_id", "workspace", "revision", "approve_plan_automatically", "is_remote_backend", "deploy_on_push", "auto_deploy_on_path_changes_only", "auto_deploy_by_custom_glob", "run_plan_on_pull_requests", "vcs_pr_comments_enabled", "vcs_commands_alias", "drift_detection_cron", "ttl"]);
      for (const k of Object.keys(r.body.attrs)) {
        if (known.has(k)) continue;
        if (k === "variable_sets") b.note("unmapped", `${env.key}.variable_sets`, "Variables", "set the variable sets' values by hand: env for values, pass for secrets");
        else if (k === "terragrunt_working_directory") b.note("default", `${env.key}.${k}`, "Root", "Terragrunt is detected, and each unit is a root");
        else if (k === "k8s_namespace" || k === "sub_environment_configuration") b.note("unmapped", `${env.key}.${k}`, "Root", "terragucci runs Terraform, OpenTofu and Terragrunt");
        else notePlatformOnly(notes, `env0_environment.*.${k}`, "env zero");
      }
      for (const blk of r.body.blocks) {
        if (blk.type === "configuration") variable(b, `${env.key}.configuration: ${literalString(blk.body.attrs.name) ?? "?"}`, blk.body, false, env);
        else if (blk.type === "without_template_settings") continue;
        else if (blk.type === "sub_environment_configuration") b.note("unmapped", `${env.key}.sub_environment_configuration`, "Order", "a workflow's sub environments are roots, ordered by their terraform_remote_state reads");
        else notePlatformOnly(notes, `env0_environment.*.${blk.type}`, "env zero");
      }
    }
  }

  // Variables declared on their own.
  for (const v of ofType("env0_configuration_variable")) {
    const key = ADDR(v);
    const env = refTo(v.body.attrs.environment_id);
    const tpl = refTo(v.body.attrs.template_id);
    const scoped = env ? envs.find((e) => e.res && ADDR(e.res) === env) : undefined;
    const users = tpl ? envs.filter((e) => e.template === tpl) : undefined;
    const every = !env && (!tpl || (users !== undefined && users.length === envs.length));
    variable(b, key, v.body, every, scoped ?? (users?.length === 1 ? users[0] : undefined));
  }

  // Drift detection resources.
  for (const d of ofType("env0_environment_drift_detection")) {
    const env = refTo(d.body.attrs.environment_id);
    const cron = literalString(d.body.attrs.cron);
    if (cron) b.drift.push({ cron, key: `${ADDR(d)}.cron`, unit: envs.find((e) => e.res && ADDR(e.res) === env)?.id ?? ADDR(d) });
    else b.note("unmapped", `${ADDR(d)}.cron`, "Drift", "it is not a plain cron schedule");
    const rem = d.body.attrs.auto_drift_remediation;
    if (rem !== undefined && rem !== "DISABLED") b.note("unmapped", `${ADDR(d)}.auto_drift_remediation`, "Drift", "a drift run never applies; respond.drift opens a pull request for it");
  }

  // Custom flows.
  for (const f of input.flows) readFlow(b, f.file, f.doc, envs);

  // The other env0_* resources.
  const handled = new Set(["env0_template", "env0_environment", "env0_project_policy", "env0_configuration_variable", "env0_environment_drift_detection"]);
  for (const r of resources) {
    if (handled.has(r.type)) continue;
    const key = ADDR(r);
    if (r.type === "env0_project" || r.type === "env0_template_project_assignment") notePlatformOnly(notes, key, "env zero", "a project's environments are this repo's roots");
    else if (r.type.includes("credentials")) b.note("unmapped", key, r.type.startsWith("env0_cost_") ? "Cost" : "Cloud credentials", r.type.startsWith("env0_cost_") ? "Infracost prices on your INFRACOST_API_KEY" : "name a read-only plan role and an apply role under oidc");
    else if (r.type.startsWith("env0_variable_set")) b.note("unmapped", key, "Variables", "set its values by hand: env for values, pass for secrets");
    else if (r.type.startsWith("env0_agent")) b.note("unmapped", key, "Workers");
    else if (r.type.startsWith("env0_notification")) b.note("unmapped", key, "Notifications");
    else if (r.type.startsWith("env0_approval_policy")) b.note("unmapped", key, "Plan policy", "copy its Rego into policy; a rule that asked for an approval becomes cost.approve_above or gate: always");
    else if (/^env0_(user|team|custom_role|.*role_assignment|organization)/.test(r.type)) b.note("unmapped", key, "Access");
    else if (r.type === "env0_module" || r.type.startsWith("env0_module_")) b.note("unmapped", key, "Module registry");
    else if (r.type.includes("trigger")) b.note("unmapped", key, "Order", "a root that reads another's state through terraform_remote_state applies after it");
    else noteUnknown(notes, key);
  }

  finish(b, o, "environments");
  return { settings: b.s, notes: notes.list };
}

/** A template's (or a template-less environment's) type and version, for the roots of the environments using it. */
function readTemplate(b: Build, key: string, body: HclBody, users: Env[]): void {
  const type = literalString(body.attrs.type) ?? "terraform";
  let tofu = false;
  if (type === "opentofu") {
    tofu = true;
    b.binary("tofu", `${key}.type`);
  } else if (type === "terraform") {
    if (body.attrs.type !== undefined) b.binary("terraform", `${key}.type`);
  } else if (type === "terragrunt") {
    b.note("default", `${key}.type`, "Root", "Terragrunt is detected from the repo's root.hcl or terragrunt.hcl, with terragrunt.version for its release");
    const tool = literalString(body.attrs.terragrunt_tf_binary) ?? "opentofu";
    tofu = tool === "opentofu";
    b.binary(tofu ? "tofu" : "terraform", `${key}.terragrunt_tf_binary`);
  } else {
    b.note("unmapped", `${key}.type`, "Root", `terragucci runs Terraform, OpenTofu and Terragrunt, not ${type}`);
    return;
  }
  const v = tofu ? body.attrs.opentofu_version : body.attrs.terraform_version;
  const vkey = `${key}.${tofu ? "opentofu_version" : "terraform_version"}`;
  if (v !== undefined) {
    const roots = [...new Set(users.map((u) => u.root).filter((r): r is string => r !== undefined))];
    if (!roots.length) b.version(undefined, v, vkey);
    for (const root of roots) b.version(root, v, vkey);
  }
  const other = tofu ? body.attrs.terraform_version : body.attrs.opentofu_version;
  if (other !== undefined) b.note("default", `${key}.${tofu ? "terraform_version" : "opentofu_version"}`, "Version", `the template runs ${tofu ? "OpenTofu" : "Terraform"}`);
}

/** One variable: a secret's name under pass, a value every root gets in env, or one root's value named for its terraform.tfvars. */
function variable(b: Build, key: string, body: HclBody, every: boolean, env: Env | undefined): void {
  const raw = literalString(body.attrs.name);
  if (!raw) return b.note("unmapped", key, "Variables", "its name is not a plain string");
  const name = literalString(body.attrs.type) === "terraform" ? `TF_VAR_${raw}` : raw;
  if (body.attrs.is_sensitive === true) return b.takeSecret(key, name);
  const value = literalString(body.attrs.value);
  if (value === undefined) return b.note("unmapped", key, "Variables", "its value is not a plain string in the code; set it by hand");
  if (every) return b.takeEnv(key, name, value);
  const where = env?.root;
  b.note("unmapped", key, "Variables", name.startsWith("TF_VAR_") ? `it is ${env?.id ?? "one environment"}'s alone: set ${raw} in ${where ?? "its root"}/terraform.tfvars` : `it is ${env?.id ?? "one environment"}'s alone, and env is every root's`);
}

/** A custom flow (env0.yml) as steps for the root its file is in. */
function readFlow(b: Build, file: string, doc: Record<string, unknown>, envs: Env[]): void {
  const { notes } = b;
  const dir = rootOf(dirname(file)) ?? ".";
  const roots = [...new Set(envs.map((e) => e.root).filter((r): r is string => r !== undefined))];
  const every = envs.length > 0 && envs.every((e) => e.root === dir);
  const fromRepo = dir === "." && !roots.includes(".");
  if (!fromRepo && !roots.includes(dir) && envs.length) {
    notes.own(file, "unmapped", `no environment the import read runs ${dir}`, "a custom flow runs in its template's directory");
    return;
  }
  const bash = doc.shell === "bash";
  for (const k of Object.keys(doc)) {
    if (k === "version") notes.own(`${file}: version`, "default", "the file's format version; terragucci.yml has none");
    else if (k === "shell") notes.own(`${file}: shell`, bash ? "mapped" : "default", bash ? "each step runs its commands under bash" : "a step runs under sh");
    else if (k === "destroy") b.note("unmapped", `${file}: destroy`, "Hooks", "a destroy is a reviewed change that removes the code, or an ephemeral copy's sweep");
    else if (k === "task") b.note("unmapped", `${file}: task`, "Hooks", "a task has no counterpart: state changes come from a reviewed commit");
    else if (k !== "deploy") noteUnknown(notes, `${file}: ${k}`);
  }
  const deploy = isMap(doc.deploy) ? doc.deploy : {};
  const push = (at: string, stage: { before?: StepStage; after?: StepStage }, cmds: unknown): void => {
    const lines: string[] = [];
    list(cmds).forEach((c, i) => {
      const line = typeof c === "string" ? c : isMap(c) && typeof c.run === "string" ? c.run.trimEnd() : undefined;
      if (line === undefined) return noteUnknown(notes, `${at}[${i}]`);
      const set = /^echo\s+["']?([A-Za-z_][A-Za-z0-9_]*)=([^"'$`]*)["']?\s*>>\s*"?\$\{?ENV0_ENV\}?"?\s*$/.exec(line.trim());
      if (set) {
        if (every || fromRepo) b.takeEnv(`${at}[${i}]`, set[1], set[2]);
        else b.note("unmapped", `${at}[${i}]`, "Variables", `it is ${dir}'s alone, and env is every root's`);
        return;
      }
      if (line.includes("ENV0_ENV")) b.note("unmapped", `${at}[${i}]`, "Hooks", "it sets a variable for later steps, and a step cannot set the binary's environment");
      lines.push(line);
    });
    if (!lines.length) return;
    let run = Build.script(lines);
    if (bash) run = `bash -c '${run.replace(/'/g, `'\\''`)}'`;
    if (fromRepo) run = `cd "$TG_REPO" && ${run}`;
    b.steps.push({ name: at, run, ...stage, ...(fromRepo || every ? {} : { roots: [dir] }) });
    b.note("mapped", at, "Hooks", `steps: ${stage.before ? "before" : "after"}: ${stage.before ?? stage.after}${fromRepo || every ? " for every root" : ` for ${dir}`}${fromRepo ? ", from the repo's root" : ""}`);
  };
  for (const [k, v] of Object.entries(deploy)) {
    const at = `${file}: deploy.${k}`;
    if (k === "onSuccess") push(at, { after: "apply" }, v);
    else if (k === "onFailure" || k === "onCompletion") b.note("unmapped", at, "Hooks", "a step after a stage runs when the stage succeeded");
    else if (k === "steps" && isMap(v)) {
      for (const [step, hooks] of Object.entries(v)) {
        const sat = `${file}: deploy.steps.${step}`;
        const m = FLOW_STEPS[step];
        if (!m) {
          if (OTHER_ENGINES.test(step)) b.note("unmapped", sat, "Root", "terragucci runs Terraform, OpenTofu and Terragrunt");
          else noteUnknown(notes, sat);
          continue;
        }
        if (!isMap(hooks)) {
          noteUnknown(notes, sat);
          continue;
        }
        for (const [when, cmds] of Object.entries(hooks)) {
          const stage = when === "before" ? m.before : when === "after" ? m.after : undefined;
          if (!stage) noteUnknown(notes, `${sat}.${when}`);
          else push(`${sat}.${when}`, stage, cmds);
        }
      }
    } else noteUnknown(notes, at);
  }
}
