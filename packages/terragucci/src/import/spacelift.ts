/**
 * `terragucci import spacelift [.spacelift/config.yml]`: terragucci.yml from
 * a Spacelift repo's runtime config and the admin stack's `spacelift_*`
 * resources, by the concepts table of "Coming from Spacelift or env zero"
 * (./platform-guide.ts).
 *
 * A stack comes from a `spacelift_stack` resource, a `stacks` entry of
 * `.spacelift/config.yml`, or both, matched by the stack's ID (its `slug`, or
 * its name as Spacelift makes an ID of it). Its project root becomes a root;
 * its version and workflow tool `binary` and `version`; its hooks `steps`;
 * `spacelift_stack_dependency` resources `waves.after`; a context's or a
 * stack's environment variables `env` when every stack gets the value and
 * `pass.secrets` when it is secret, the default; drift detection `drift`; and
 * stacks that wait for a confirmation `gate: always`. Policies, managed state
 * and everything else are named with what to do instead. The runtime config
 * overrides a resource's setting, as it does on Spacelift.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseYAML } from "@intentius/chant/yaml";
import { ConfigError, type StepStage } from "../config";
import { literalString, refTo, resourcesOf, shown, stringList, type HclResource, type HclValue } from "./hcl";
import { isMap, rootOf } from "./notes";
import { notePlatformOnly, noteUnknown } from "./platform-guide";
import { Build, finish, type PlatformConverted, type PlatformOptions, type Unit } from "./platform";

export const SPACELIFT_FILES = [".spacelift/config.yml", ".spacelift/config.yaml"];

/** Each hook and the moment it runs at; undefined for the hooks with no counterpart. */
const HOOKS: Record<string, { before?: StepStage; after?: StepStage } | undefined> = {
  before_init: { before: "init" },
  after_init: { after: "init" },
  before_plan: { before: "plan" },
  after_plan: { after: "plan" },
  before_apply: { before: "apply" },
  after_apply: { after: "apply" },
  before_perform: undefined,
  after_perform: undefined,
  before_destroy: undefined,
  after_destroy: undefined,
  after_run: undefined,
};

const CONFIG_STACK_KEYS = new Set([...Object.keys(HOOKS), "environment", "project_root", "runner_image", "terraform_version", "opentofu_version", "terraform_workflow_tool", "git_sparse_checkout_paths", "terragrunt"]);

/** A stack's settings with nothing to carry over. */
const STACK_PLATFORM_ONLY = new Set([
  "name", "slug", "repository", "branch", "description", "space_id", "protect_from_deletion", "enable_local_preview", "autoretry", "allow_run_promotion", "github_action_deploy",
  "enable_well_known_secret_masking", "terraform_smart_sanitization", "terraform_external_state_access", "prevent_changes_when_locked", "git_sparse_checkout_paths",
  "enable_sensitive_outputs_upload", "import_state", "import_state_file", "labels", "github_enterprise", "gitlab", "azure_devops", "bitbucket_cloud", "bitbucket_datacenter",
  "raw_git", "origin", "spacelift_repo", "showcase",
]);

/** Spacelift's ID for a stack name: lower case, runs of other characters as one dash. */
export function slugOf(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

interface Stack extends Unit {
  res?: HclResource;
  conf?: Record<string, unknown>;
  confKey?: string;
  labels: string[];
}

/** The attribute or block a resource sets: an attribute's value, `true` for a block. */
function has(r: HclResource, k: string): boolean {
  return k in r.body.attrs || r.body.blocks.some((b) => b.type === k);
}

const ADDR = (r: HclResource): string => `${r.type}.${r.name}`;

/** Read `.spacelift/config.yml` (when there is one) and the repo's `spacelift_*` resources. */
export function readSpacelift(repo: string, o: PlatformOptions & { file?: string } = {}): PlatformConverted {
  const file = o.file ?? SPACELIFT_FILES.find((f) => existsSync(join(repo, f)));
  let doc: Record<string, unknown> = {};
  const read: string[] = [];
  if (file !== undefined) {
    if (!existsSync(join(repo, file))) throw new ConfigError(`import spacelift reads ${file}, and there is none in ${repo}`);
    let parsed: unknown;
    try {
      parsed = parseYAML(readFileSync(join(repo, file), "utf-8"));
    } catch (e) {
      throw new ConfigError(`${file} is not YAML: ${(e as Error).message}`);
    }
    if (parsed !== null && parsed !== undefined && !isMap(parsed)) throw new ConfigError(`${file} is not a map of settings`);
    doc = (parsed ?? {}) as Record<string, unknown>;
    read.push(file);
  }
  const resources = resourcesOf(repo, "spacelift_");
  for (const r of resources) if (!read.includes(r.file)) read.push(r.file);
  if (file === undefined && !resources.length) {
    throw new ConfigError(`import spacelift reads ${SPACELIFT_FILES[0]} or spacelift_stack resources, and there are neither in ${repo}`);
  }
  return { ...convertSpacelift(doc, resources, o), read };
}

/** Turn a parsed `.spacelift/config.yml` and the `spacelift_*` resources into terragucci settings and a note per setting. */
export function convertSpacelift(doc: Record<string, unknown>, resources: HclResource[], o: PlatformOptions = {}): Omit<PlatformConverted, "read"> {
  const b = new Build("Spacelift");
  const { notes } = b;
  const byAddr = new Map(resources.map((r) => [ADDR(r), r]));
  const ofType = (t: string): HclResource[] => resources.filter((r) => r.type === t);

  for (const k of Object.keys(doc)) {
    if (k === "version") notes.own("version", "default", "the file's format version; terragucci.yml has none");
    else if (k === "module_version" || k === "tests") b.note("unmapped", k, "Module registry", "a module's version and tests are the module's own release");
    else if (k !== "stack_defaults" && k !== "stacks") noteUnknown(notes, k);
  }
  const defaults = isMap(doc.stack_defaults) ? doc.stack_defaults : {};
  if (doc.stack_defaults !== undefined && !isMap(doc.stack_defaults)) noteUnknown(notes, "stack_defaults");
  const confStacks = isMap(doc.stacks) ? doc.stacks : {};
  if (doc.stacks !== undefined && !isMap(doc.stacks)) noteUnknown(notes, "stacks");

  // Stacks: resources first, then config entries matched to them by ID.
  const stacks: Stack[] = [];
  const byId = new Map<string, Stack>();
  for (const r of ofType("spacelift_stack")) {
    const name = literalString(r.body.attrs.name);
    const id = literalString(r.body.attrs.slug) ?? (name ? slugOf(name) : r.name);
    const st: Stack = { id, key: ADDR(r), res: r, labels: stringList(r.body.attrs.labels) ?? [] };
    stacks.push(st);
    byId.set(id, st);
  }
  for (const [id, conf] of Object.entries(confStacks)) {
    const st = byId.get(id) ?? { id, key: `stacks.${id}`, labels: [] };
    if (!byId.has(id)) {
      stacks.push(st);
      byId.set(id, st);
    }
    st.conf = isMap(conf) ? conf : {};
    st.confKey = `stacks.${id}`;
    if (!isMap(conf) && conf !== null) noteUnknown(notes, `stacks.${id}`);
    for (const k of Object.keys(st.conf)) if (!CONFIG_STACK_KEYS.has(k)) noteUnknown(notes, `stacks.${id}.${k}`);
  }
  for (const k of Object.keys(defaults)) if (!CONFIG_STACK_KEYS.has(k)) noteUnknown(notes, `stack_defaults.${k}`);
  if (!stacks.length && isMap(doc.stack_defaults)) {
    // Defaults alone: the repo's root is the one stack's root.
    stacks.push({ id: "the repo's stack", key: "stack_defaults", labels: [] });
  }

  /** A setting as the stack runs it: its runtime config entry, the defaults, then the resource. */
  const setting = (st: Stack, k: string): { v: unknown; key: string } | undefined => {
    if (st.conf && st.conf[k] !== undefined) return { v: st.conf[k], key: `${st.confKey}.${k}` };
    if (defaults[k] !== undefined) return { v: defaults[k], key: `stack_defaults.${k}` };
    const a = st.res?.body.attrs[k];
    if (a !== undefined) return { v: a, key: `${st.key}.${k}` };
    return undefined;
  };

  // Roots.
  for (const st of stacks) {
    const pr = setting(st, "project_root");
    const raw = pr === undefined ? "." : typeof pr.v === "string" ? literalString(pr.v as HclValue) : undefined;
    st.root = raw === undefined ? undefined : rootOf(raw === "" ? "." : raw);
    if (pr && st.root === undefined) b.note("unmapped", pr.key, "Root", `${shown(pr.v as HclValue)} is not a directory inside the repo`);
    b.units.push(st);
  }

  // Binary and version.
  for (const st of stacks) {
    const tool = setting(st, "terraform_workflow_tool");
    const tofuBlock = st.res && st.res.body.blocks.some((x) => x.type === "opentofu");
    let tofu = false;
    if (tool) {
      if (tool.v === "OPEN_TOFU") {
        tofu = true;
        b.binary("tofu", tool.key);
      } else if (tool.v === "TERRAFORM_FOSS") b.binary("terraform", tool.key);
      else b.note("unmapped", tool.key, "Version", `${shown(tool.v as HclValue)} is not Terraform or OpenTofu; set binary to the one the stack runs`);
    } else if (tofuBlock) {
      tofu = true;
      b.binary("tofu", `${st.key}.opentofu`);
    }
    const v = tofu ? (setting(st, "opentofu_version") ?? setting(st, "terraform_version")) : setting(st, "terraform_version");
    if (v) b.version(st.root, v.v, v.key);
    const other = tofu ? setting(st, "terraform_version") : setting(st, "opentofu_version");
    if (other && other !== v) b.note("default", other.key, "Version", `the stack runs ${tofu ? "OpenTofu" : "Terraform"}`);
  }

  // Contexts and what they attach to.
  const contexts = ofType("spacelift_context");
  const attached = new Map<string, Set<Stack>>(contexts.map((c) => [ADDR(c), new Set<Stack>()]));
  const stackOf = (v: HclValue | undefined): Stack | undefined => {
    const ref = refTo(v);
    if (ref) return stacks.find((s) => s.res && ADDR(s.res) === ref);
    const id = literalString(v);
    return id ? byId.get(id) : undefined;
  };
  for (const a of ofType("spacelift_context_attachment")) {
    const ctx = refTo(a.body.attrs.context_id);
    const st = stackOf(a.body.attrs.stack_id);
    if (ctx && attached.has(ctx) && st) {
      attached.get(ctx)!.add(st);
      notePlatformOnly(notes, ADDR(a), "Spacelift", `attaches ${ctx} to ${st.id}`);
    } else b.note("unmapped", ADDR(a), "Variables", "the import cannot tell which context and stack it joins");
  }
  for (const c of contexts) {
    for (const label of stringList(c.body.attrs.labels) ?? []) {
      const m = /^autoattach:(.+)$/.exec(label);
      if (!m) continue;
      for (const st of stacks) if (m[1] === "*" || st.labels.includes(m[1])) attached.get(ADDR(c))!.add(st);
    }
    for (const k of Object.keys(c.body.attrs)) {
      if (!(k in HOOKS) && k !== "name" && k !== "labels" && k !== "description" && k !== "space_id") noteUnknown(notes, `${ADDR(c)}.${k}`);
    }
  }
  const everyStack = (set: Set<Stack>): boolean => stacks.every((s) => set.has(s));

  // Hooks: each stack's own list (runtime config, defaults, resource), with its contexts' around it.
  const groups = new Map<string, { stage: { before?: StepStage; after?: StepStage }; hook: string; script: string; roots: Set<string>; keys: Set<string>; stacks: Set<Stack> }>();
  for (const [hook, stage] of Object.entries(HOOKS)) {
    for (const st of stacks) {
      const own = setting(st, hook);
      const ownLines = own ? (Array.isArray(own.v) ? stringList(own.v as HclValue[]) : undefined) : [];
      if (own && ownLines === undefined) {
        b.note("unmapped", own.key, "Hooks", "it is not a list of commands");
        continue;
      }
      const ctxs = contexts.filter((c) => attached.get(ADDR(c))!.has(st) && c.body.attrs[hook] !== undefined);
      const ctxLines = ctxs.flatMap((c) => stringList(c.body.attrs[hook]) ?? []);
      const lines = hook.startsWith("before") ? [...ctxLines, ...ownLines!] : [...ownLines!, ...ctxLines];
      const keys = [...(own ? [own.key] : []), ...ctxs.map((c) => `${ADDR(c)}.${hook}`)];
      if (!lines.length) continue;
      if (!stage) {
        for (const k of keys) b.note("unmapped", k, "Hooks", hook.includes("destroy") ? "a destroy is a reviewed change that removes the code" : hook.includes("perform") ? "a task has no counterpart: state changes come from a reviewed commit" : "after_run runs whatever the run's outcome; a step after a stage runs when the stage succeeded");
        continue;
      }
      if (st.root === undefined) {
        for (const k of keys) b.note("unmapped", k, "Hooks", `${st.id} has no root`);
        continue;
      }
      const script = Build.script(lines);
      const g = groups.get(`${hook}\0${script}`) ?? { stage, hook, script, roots: new Set(), keys: new Set(), stacks: new Set() };
      g.roots.add(st.root);
      g.stacks.add(st);
      keys.forEach((k) => g.keys.add(k));
      groups.set(`${hook}\0${script}`, g);
    }
  }
  for (const g of groups.values()) {
    const all = everyStack(g.stacks);
    const roots = [...g.roots].sort();
    b.steps.push({ name: g.hook, run: g.script, ...g.stage, ...(all ? {} : { roots }) });
    const when = `${g.stage.before ? "before" : "after"}: ${g.stage.before ?? g.stage.after}`;
    for (const k of g.keys) b.note("mapped", k, "Hooks", `steps: ${when}${all ? " for every root" : ` for ${roots.join(", ")}`}`);
  }

  // Environment: the runtime config's values, and environment variables on contexts and stacks.
  if (isMap(defaults.environment)) {
    for (const [name, value] of Object.entries(defaults.environment)) {
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") b.takeEnv(`stack_defaults.environment.${name}`, name, String(value));
      else b.note("unmapped", `stack_defaults.environment.${name}`, "Variables", "its value is not a string");
    }
  }
  for (const st of stacks) {
    if (!st.conf || !isMap(st.conf.environment)) continue;
    for (const name of Object.keys(st.conf.environment)) {
      b.note("unmapped", `${st.confKey}.environment.${name}`, "Variables", `it is ${st.id}'s alone, and env is every root's; a TF_VAR_ value goes in ${st.root ?? "its root"}'s terraform.tfvars`);
    }
  }
  for (const v of ofType("spacelift_environment_variable")) {
    const key = ADDR(v);
    const name = literalString(v.body.attrs.name);
    if (!name) {
      b.note("unmapped", key, "Variables", "its name is not a plain string");
      continue;
    }
    const ctx = refTo(v.body.attrs.context_id);
    const st = v.body.attrs.stack_id !== undefined ? stackOf(v.body.attrs.stack_id) : undefined;
    if (v.body.attrs.module_id !== undefined) {
      b.note("unmapped", key, "Module registry", "a module's test variable");
      continue;
    }
    if (v.body.attrs.write_only !== false) {
      b.takeSecret(key, name);
      continue;
    }
    const value = literalString(v.body.attrs.value);
    const scope = ctx && attached.has(ctx) ? attached.get(ctx)! : st ? new Set([st]) : undefined;
    if (value === undefined) b.note("unmapped", key, "Variables", "its value is not a plain string in the code; set it by hand");
    else if (scope && everyStack(scope)) b.takeEnv(key, name, value);
    else b.note("unmapped", key, "Variables", `it is for ${scope ? [...scope].map((s) => s.id).join(", ") || "no stack" : "a stack the import cannot tell"}, and env is every root's; a TF_VAR_ value goes in the root's terraform.tfvars`);
  }
  for (const f of ofType("spacelift_mounted_file")) {
    const path = literalString(f.body.attrs.relative_path) ?? shown(f.body.attrs.relative_path);
    b.note("unmapped", ADDR(f), "Files", f.body.attrs.write_only === false ? `commit ${path} in the root` : `${path} is secret: keep it in a CI secret and write it in a step before init`);
  }

  // Dependencies.
  for (const d of ofType("spacelift_stack_dependency")) {
    const key = ADDR(d);
    const down = stackOf(d.body.attrs.stack_id);
    const up = stackOf(d.body.attrs.depends_on_stack_id);
    if (!down || !up) b.note("unmapped", key, "Order", `${!down ? shown(d.body.attrs.stack_id) : shown(d.body.attrs.depends_on_stack_id)} names no stack the import read`);
    else if (down.root === undefined || up.root === undefined) b.note("unmapped", key, "Order", `${down.root === undefined ? down.id : up.id} has no root`);
    else b.edges.push({ d: down.root, u: up.root, key });
    if (d.body.attrs.trigger_always !== undefined) b.note("default", `${key}.trigger_always`, "Triggers", "a root that reads a changed root's state plans with it");
  }
  for (const r of ofType("spacelift_stack_dependency_reference")) {
    const input = literalString(r.body.attrs.input_name) ?? shown(r.body.attrs.input_name);
    const output = literalString(r.body.attrs.output_name) ?? shown(r.body.attrs.output_name);
    b.note("unmapped", ADDR(r), "Order", `read ${output} through a terraform_remote_state block of the upstream root in place of the input ${input}`);
  }

  // Drift detection.
  for (const d of ofType("spacelift_drift_detection")) {
    const key = ADDR(d);
    const st = stackOf(d.body.attrs.stack_id);
    const crons = stringList(d.body.attrs.schedule);
    if (!crons?.length) b.note("unmapped", `${key}.schedule`, "Drift", "it is not a list of cron schedules");
    else for (const cron of crons) b.drift.push({ cron, key: crons.length > 1 ? `${key}.schedule: ${cron}` : `${key}.schedule`, unit: st?.id ?? key });
    if (d.body.attrs.reconcile === true) b.note("unmapped", `${key}.reconcile`, "Drift", "a drift run never applies; respond.drift opens a pull request for it");
    const tz = literalString(d.body.attrs.timezone);
    if (tz && tz !== "UTC") b.note("unmapped", `${key}.timezone`, "Drift", `the cron runs in UTC, not ${tz}`);
  }

  // The rest of each stack resource.
  for (const st of stacks) {
    const r = st.res;
    if (!r) continue;
    const key = st.key;
    b.approvals.push({ key: `${key}.autodeploy`, waits: r.body.attrs.autodeploy !== true });
    if (r.body.attrs.manage_state !== false) b.note("unmapped", `${key}.manage_state`, "Managed state", `${st.id}'s state is in Spacelift: pull it and move it to ${st.root ?? "its root"}'s backend before the root's backend block merges`);
    else b.note("default", `${key}.manage_state`, "Own backend");
    if (r.body.attrs.terraform_workspace !== undefined) b.note("unmapped", `${key}.terraform_workspace`, "Workspace", `workspace ${shown(r.body.attrs.terraform_workspace)} is not planned`);
    if (r.body.attrs.worker_pool_id !== undefined) b.note("unmapped", `${key}.worker_pool_id`, "Workers", "name the runner label of your own runners under runner");
    if (r.body.attrs.additional_project_globs !== undefined) b.note("default", `${key}.additional_project_globs`, "Triggers", "a root plans when a file in it, a local module it calls or its var files changed");
    if (r.body.attrs.administrative !== undefined) notes.own(`${key}.administrative`, "unmapped", "an administrative stack manages Spacelift itself", "once every stack it declares has moved, stop applying it");
    for (const blk of ["pulumi", "kubernetes", "cloudformation", "ansible"]) if (has(r, blk)) b.note("unmapped", `${key}.${blk}`, "Root", `terragucci runs Terraform, OpenTofu and Terragrunt, not ${blk}`);
    if (has(r, "terragrunt")) b.note("default", `${key}.terragrunt`, "Root", "Terragrunt is detected from the repo's root.hcl or terragrunt.hcl");
    for (const k of Object.keys(r.body.attrs)) {
      if (STACK_PLATFORM_ONLY.has(k)) notePlatformOnly(notes, `spacelift_stack.*.${k}`, "Spacelift");
      else if (!["project_root", "terraform_version", "terraform_workflow_tool", "autodeploy", "manage_state", "terraform_workspace", "worker_pool_id", "additional_project_globs", "administrative", "runner_image"].includes(k) && !(k in HOOKS)) noteUnknown(notes, `${key}.${k}`);
    }
    for (const blk of r.body.blocks) if (!STACK_PLATFORM_ONLY.has(blk.type) && !["opentofu", "terragrunt", "pulumi", "kubernetes", "cloudformation", "ansible"].includes(blk.type)) noteUnknown(notes, `${key}.${blk.type}`);
  }
  for (const st of stacks) {
    const img = setting(st, "runner_image");
    if (img) b.note("unmapped", img.key, "Runner image", "build an image FROM terragucci's with what the hooks need, and set image");
  }
  if (isMap(defaults.terragrunt) || stacks.some((s) => s.conf && s.conf.terragrunt !== undefined)) b.note("default", "terragrunt", "Root", "Terragrunt is detected from the repo's root.hcl or terragrunt.hcl, with terragrunt.version for its release");

  // Policies.
  for (const p of ofType("spacelift_policy")) {
    const key = ADDR(p);
    const type = literalString(p.body.attrs.type) ?? "";
    const body = p.body.attrs.body;
    const from = body && typeof body === "object" && "file" in body ? ` in ${body.file.replace(/^\$\{path\.module\}\//, "")}` : "";
    if (type === "PLAN") b.note("unmapped", key, "Plan policy", `copy the Rego${from} into policy with input: plan, and change input.terraform to input; input.spacelift has no counterpart`);
    else if (type === "APPROVAL") b.note("unmapped", key, "Approval", "gate decides which waves wait, and how many reviewers a change needs is the forge's branch protection");
    else if (type === "GIT_PUSH" || type === "TRIGGER") b.note("default", key, "Triggers");
    else if (type === "LOGIN" || type === "ACCESS" || type === "STACK_ACCESS") b.note("unmapped", key, "Access");
    else if (type === "NOTIFICATION") b.note("unmapped", key, "Notifications", "set notify for the channels it routed to");
    else notes.own(key, "unmapped", `a ${type || "policy"} policy has no counterpart`, "a state change comes from an import, removed or moved block, or a migration, in a reviewed commit");
  }

  // The other spacelift_* resources.
  const handled = new Set(["spacelift_stack", "spacelift_context", "spacelift_context_attachment", "spacelift_environment_variable", "spacelift_mounted_file", "spacelift_stack_dependency", "spacelift_stack_dependency_reference", "spacelift_drift_detection", "spacelift_policy"]);
  for (const r of resources) {
    if (handled.has(r.type)) continue;
    const key = ADDR(r);
    if (r.type === "spacelift_policy_attachment") notePlatformOnly(notes, key, "Spacelift", "the policy's own note says where it goes");
    else if (/_(integration|integration_attachment|aws_role)$/.test(r.type) || r.type.startsWith("spacelift_aws_") || r.type.startsWith("spacelift_gcp_") || r.type.startsWith("spacelift_azure_")) b.note("unmapped", key, "Cloud credentials", "name a read-only plan role and an apply role under oidc");
    else if (r.type === "spacelift_worker_pool") b.note("unmapped", key, "Workers");
    else if (r.type === "spacelift_module" || r.type.startsWith("spacelift_module_")) b.note("unmapped", key, "Module registry");
    else if (/^spacelift_(space|role|role_attachment|user|idp_group_mapping|api_key|team|saml_saml2|audit_trail_webhook)/.test(r.type)) b.note("unmapped", key, "Access");
    else if (r.type === "spacelift_webhook" || r.type === "spacelift_named_webhook") b.note("unmapped", key, "Notifications", "notify.webhook posts a signed body to an address");
    else noteUnknown(notes, key);
  }

  finish(b, o, "stacks");
  return { settings: b.s, notes: notes.list };
}

