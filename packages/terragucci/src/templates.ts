/**
 * Apps from templates: `terragucci templates` and `terragucci request`.
 *
 * A template is a module whose release carries a `template.yml`
 * (template.yml/v1, chant#4651) beside its code. The file is in the signed
 * release, and publish copies it into the version's catalog entry under
 * `fields.terraform.template` (./publish/catalog.ts), so the catalog answers
 * which versions are templates, their attestation and their form fields.
 *
 * `terragucci templates` reads the catalog alone and works on any chant.
 * `terragucci request` builds chant's template request
 * (`@intentius/chant/template-request`), checks it against the catalog and
 * the version's template.yml, renders the app's root with the terraform
 * lexicon (`@intentius/chant-lexicon-terraform/template`, chant#4652), adds
 * the files `generate` writes for the new root, and opens one pull request
 * on `request/<template>/<app>` from the default branch, pushed without
 * force. On a chant without either module it refuses and names them.
 *
 * With `--app`, the request is for an add-on: one module call, rendered with
 * the lexicon's renderAddonCall into `addon-<name>.tf` in the existing app's
 * root (ruling C of chant#4642), so the app and its add-ons plan and apply
 * together. Its branch is `request/<template>/<app>/<addon>`. The app's root
 * is read by ./template-apps.ts, which also lists the apps.
 *
 * Nothing here plans, approves, applies or merges: the pull request is an
 * ordinary one, which the pipeline plans and a person reviews and merges.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Hcl2Json } from "@intentius/chant/terraform/parse";
import { ConfigError, TEMPLATES_APPS, type ResolvedSettings } from "./config";
import { chantTemplateRender, chantTemplateRequests, type ChantCatalogComponent, type ChantCatalogVersion, type ChantReleaseCatalogDoc, type ChantTemplateInput, type ChantTemplateRender, type ChantTemplateRequest, type ChantTemplateRequestRefusal, type ChantTemplateSpec } from "./chant-next";
import { productWords } from "./ci-words";
import { globMatch } from "./detect";
import { defaultBranch, DEFAULT_TOKEN_ENV, openPullRequest, prForgeOf, type Fetch, type ForgeTarget } from "./forge";
import { GENERATED_FILES, renderRoot, rootSettings } from "./generate";
import { findComponent, readCatalog } from "./publish/catalog";
import { IDENTITY } from "./reconcile";
import { REQUESTS_FILE } from "./report/audit";
import { forgeOf, worktree } from "./respond/change";
import { loadHclParser } from "./rollout/parser";
import { detectShape } from "./shape";
import { addonFile, addressWithoutHost, appRootPath, attestedFor, catalogVersionOf, checkoutFiles, commitFiles, readAppRoot, versionOutputs, type TreeFiles } from "./template-apps";

export { REQUESTS_FILE };

/** The chant `terragucci request` needs, named in its refusal on an older one. */
export const REQUEST_NEEDS_CHANT =
  "terragucci request builds chant's template request (@intentius/chant/template-request) and renders the app's root with the terraform lexicon (@intentius/chant-lexicon-terraform/template), which the installed chant does not carry; it needs a chant release newer than 0.124.58 that has both";

/** The chant an add-on request needs, named in its refusal on a chant whose template module renders app roots only. */
export const ADDON_NEEDS_CHANT =
  "terragucci request --app renders the add-on's module call with the terraform lexicon's renderAddonCall (@intentius/chant-lexicon-terraform/template), which the installed chant does not carry; it needs a chant release newer than 0.124.58 that has it";

/** Where a request comes from. */
export const REQUEST_VIA = ["form", "mcp", "cli"] as const;
export type RequestVia = (typeof REQUEST_VIA)[number];

/** One version of a template, as `terragucci templates` lists it. */
export interface TemplateVersionRow {
  version: string;
  attestation: "verified" | "signed" | "unsigned";
  time: string;
  commit: string;
}

/** One form field: a template input, with the Terraform type the module declares when the catalog has it. */
export interface TemplateField {
  name: string;
  kind: ChantTemplateInput["kind"];
  of?: ChantTemplateInput["of"];
  label: string;
  description?: string;
  default?: unknown;
  required: boolean;
  sensitive: boolean;
  /** The module variable's type constraint, as the catalog's `terraform.inputs` lists it. */
  type?: string;
}

/** One template, with the versions a request may name. */
export interface TemplateRow {
  /** The registry address without its host, which a request names: `acme/bucket/aws`. */
  template: string;
  /** The template's short name, as its branch uses it: `bucket`. */
  name: string;
  /** The catalog component: the module's path in the publishing repo. */
  component: string;
  /** The full registry address, the module call's `source`. */
  address: string;
  kind: "app" | "addon";
  description: string;
  /** Newest first. */
  versions: TemplateVersionRow[];
  /** The newest listed version: the one a request without `--version` takes. */
  latest: string;
  /** The newest listed version's inputs, in the order its template.yml lists them. */
  fields: TemplateField[];
}

/** `templates`, its defaults filled in. */
export function templatesSettings(settings: ResolvedSettings): { registry?: string; apps: string; require: "signed" | "any" } {
  const t = settings.templates ?? {};
  return { ...(t.registry ? { registry: t.registry } : {}), apps: t.apps ?? TEMPLATES_APPS, require: t.require ?? "signed" };
}

/** The catalog the templates are read from: `templates.registry`'s, else `modules.registry`'s. */
export async function readTemplatesCatalog(cwd: string, settings: ResolvedSettings, o: { registry?: string; fetch?: (url: string, init?: RequestInit) => Promise<Response> } = {}): Promise<ChantReleaseCatalogDoc> {
  const registry = o.registry ?? settings.templates?.registry;
  const reg = registry ? undefined : settings.modules?.registry;
  if (!registry && !reg) throw new ConfigError("terragucci templates reads the release catalog of templates.registry or modules.registry, and neither is set; or name one with --registry <url>");
  return readCatalog({ ...(registry ? { registry } : {}), ...(reg ? { settings: reg } : {}), repo: cwd, ...(o.fetch ? { fetch: o.fetch } : {}) });
}

/** A template's short name: the second-to-last segment of an address with three or more, else the last (chant's `templateName`). */
export function templateName(template: string): string {
  const parts = template.split("/").filter(Boolean);
  return (parts.length >= 3 ? parts[parts.length - 2] : parts[parts.length - 1]) ?? template;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const addressOf = (c: ChantCatalogComponent): string => {
  const a = (c.fields.terraform as { address?: unknown } | undefined)?.address;
  return typeof a === "string" ? a : c.name;
};

/** The address a request names: the registry address without its host. */
export const templateAddress = (c: ChantCatalogComponent): string => addressWithoutHost(addressOf(c));

/** The template.yml a version's catalog entry carries, or undefined when the version is no template. */
export function versionTemplate(v: ChantCatalogVersion): ChantTemplateSpec | undefined {
  const t = (v.fields.terraform as { template?: unknown } | undefined)?.template;
  return isRecord(t) && Array.isArray(t.inputs) && typeof t.description === "string" ? (t as unknown as ChantTemplateSpec) : undefined;
}

/** Whether a version may be requested: active, a template, and attested as `require` asks. */
export function requestable(v: ChantCatalogVersion, require: "signed" | "any"): boolean {
  return v.status.state === "active" && v.version !== null && versionTemplate(v) !== undefined && attestedFor(v, require);
}

function fieldsOf(v: ChantCatalogVersion, spec: ChantTemplateSpec): TemplateField[] {
  const declared = new Map(((v.fields.terraform as { inputs?: { name?: string; type?: string | null }[] } | undefined)?.inputs ?? []).map((i) => [i.name, i.type]));
  return spec.inputs.map((i) => {
    const type = declared.get(i.name);
    return {
      name: i.name,
      kind: i.kind,
      ...(i.of ? { of: i.of } : {}),
      label: i.label ?? i.name,
      ...(i.description ? { description: i.description } : {}),
      ...("default" in i ? { default: i.default } : {}),
      required: i.required ?? !("default" in i),
      sensitive: i.sensitive === true,
      ...(typeof type === "string" ? { type } : {}),
    };
  });
}

/** Each template in the catalog with a version a request may name, by its address. */
export function listTemplates(catalog: ChantReleaseCatalogDoc, require: "signed" | "any"): TemplateRow[] {
  const out: TemplateRow[] = [];
  for (const c of catalog.components) {
    const versions = c.versions.filter((v) => requestable(v, require));
    if (versions.length === 0) continue;
    const spec = versionTemplate(versions[0]!)!;
    const template = templateAddress(c);
    out.push({
      template,
      name: templateName(template),
      component: c.name,
      address: addressOf(c),
      kind: spec.kind ?? "app",
      description: spec.description,
      versions: versions.map((v) => ({ version: v.version!, attestation: v.attestation.state, time: v.time, commit: v.commit })),
      latest: versions[0]!.version!,
      fields: fieldsOf(versions[0]!, spec),
    });
  }
  return out.sort((a, b) => (a.template < b.template ? -1 : a.template > b.template ? 1 : 0));
}

/** The template a name names: its address (with or without the host), its path or its last path segment. */
export function findTemplate(rows: readonly TemplateRow[], name: string): TemplateRow | undefined {
  const want = name.replace(/\/+$/, "");
  return rows.find((r) => r.template === want || r.address === want || r.component === want) ?? rows.find((r) => r.component.split("/").pop() === want);
}

/** One line per template: its address, kind, newest version and how many may be requested. */
export function describeTemplates(rows: readonly TemplateRow[]): string {
  if (rows.length === 0) return "the catalog lists no template with a version a request may name";
  return rows.map((r) => `${r.template}  ${r.kind}  latest ${r.latest}  (${r.versions.length} version${r.versions.length === 1 ? "" : "s"})  ${r.description}`).join("\n");
}

/** A template's versions and its form fields. */
export function describeTemplate(r: TemplateRow): string {
  const lines = [`${r.template} (${r.address}), ${r.kind}, latest ${r.latest}`, `  ${r.description}`, "  versions:"];
  for (const v of r.versions) lines.push(`    ${v.version}  ${v.attestation}  ${v.time.slice(0, 10)}  ${v.commit.slice(0, 12)}`);
  lines.push("  inputs:");
  for (const f of r.fields) {
    const kind = f.of ? `${f.kind} of ${f.of}` : f.kind;
    const how = f.sensitive ? "sensitive, from the app's secret store" : f.required ? "required" : `default ${JSON.stringify(f.default ?? null)}`;
    lines.push(`    ${f.name}  ${kind}  ${how}${f.label !== f.name ? `  "${f.label}"` : ""}`);
  }
  return lines.join("\n");
}

// ── request ──────────────────────────────────────────────────────────────────

export interface RequestOptions {
  cwd: string;
  settings: ResolvedSettings;
  /** The template, as `findComponent` takes it: `acme/bucket/aws`, its full address or its path. */
  template: string;
  /** The app's name, or with `app` the add-on's. */
  name: string;
  /** An add-on request: the existing app the add-on's module call goes into. */
  app?: string;
  /** Default: the template's newest version a request may name. */
  version?: string;
  /** Values as JSON, from `--inputs-file`. */
  inputs?: Record<string, unknown>;
  /** Values as typed on the command line (`--input k=v`), read by the input's kind; over `inputs`. */
  rawInputs?: Record<string, string>;
  via: RequestVia;
  /** Who asked, as the forge vouches for it: the run's actor. */
  requestedBy: string;
  /** Who the client says asked (a form's signed-in person); the forge does not vouch for it, so it is shown as claimed. */
  claimedBy?: string;
  dryRun: boolean;
  /** `--registry`: another registry's catalog. */
  registry?: string;
  env?: NodeJS.ProcessEnv;
  /** The forge API's fetch. */
  fetch?: Fetch;
  /** The catalog's fetch, for a registry read over HTTP. */
  catalogFetch?: (url: string, init?: RequestInit) => Promise<Response>;
  /** The HCL parser an add-on request reads the app's root with; default `@cdktn/hcl2json`. */
  parser?: Hcl2Json;
  /** Where a note goes; stdout carries `--json`'s envelope, so stderr by default. */
  log?: (line: string) => void;
  /** A paragraph after chant's request body, such as the footer of a pull request opened over MCP. */
  footer?: string;
}

export type RequestResult =
  | { ok: true; dryRun: true; branch: string; files: string[] }
  | { ok: true; dryRun: false; branch: string; files: string[]; title: string; pull_request: number; url: string; existing: boolean; request: ChantTemplateRequest }
  | { ok: false; code: string; refusals: ChantTemplateRequestRefusal[] };

/** A value typed on the command line, read by its input's kind: a string input takes it as it is, any other as JSON. */
function typed(value: string, input: ChantTemplateInput | undefined): unknown {
  if (!input || input.kind === "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/** An add-on input's reference to the app module's output: `app.<output>`, which the render turns into `module.app.<output>`. */
const APP_REF = /^app\.[A-Za-z_][A-Za-z0-9_-]*$/;

function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], env: { ...(env ?? process.env), GIT_TERMINAL_PROMPT: "0" } }).trim();
}

const refused = (code: string, field: string, reason: string): Extract<RequestResult, { ok: false }> => ({ ok: false, code, refusals: [{ code, field, reason }] });

/** Where a request's files are written from: the checkout for a dry run, else the default branch's tip, with the forge that opens the pull request. */
type RequestBase = { files: TreeFiles } & ({ dryRun: true } | { dryRun: false; tip: string; base: string; target: ForgeTarget; fetch: Fetch });

async function requestBase(o: RequestOptions, env: NodeJS.ProcessEnv): Promise<RequestBase> {
  if (o.dryRun) return { dryRun: true, files: checkoutFiles(o.cwd) };
  const forge = forgeOf(o.cwd, o.settings, env);
  const token = env.TG_TOKEN || forge.token;
  if (!token) throw new ConfigError(`${o.settings.token_env ?? DEFAULT_TOKEN_ENV[forge.forge]} (or TG_TOKEN) is not set; it holds the forge token the pull request is opened with`);
  const target = { ...forge, token };
  const fetch = o.fetch ?? (globalThis.fetch as unknown as Fetch);
  const base = await defaultBranch(fetch, target);
  git(o.cwd, ["fetch", "-q", "origin", base], env);
  const tip = git(o.cwd, ["rev-parse", "FETCH_HEAD"], env);
  return { dryRun: false, files: commitFiles(o.cwd, tip, env), tip, base, target, fetch };
}

/** What a checked request becomes: the files to add, by path from the repository, and the pull request's title. */
type Planned = { ok: true; files: Map<string, string>; title: string } | Extract<RequestResult, { ok: false }>;

/**
 * Turn a request into a pull request, or into the list of its files with
 * `dryRun`. Without `app`, the pull request adds a new app's root; with it,
 * one add-on's module call in that app's root (`addon-<name>.tf`). A
 * refusal pushes nothing.
 */
export async function request(o: RequestOptions): Promise<RequestResult> {
  const [core, render] = [await chantTemplateRequests(), await chantTemplateRender()];
  if (!core || !render) throw new ConfigError(REQUEST_NEEDS_CHANT);
  const addon = o.app !== undefined;
  if (addon && !render.renderAddonCall) throw new ConfigError(ADDON_NEEDS_CHANT);
  const env = o.env ?? process.env;
  const log = o.log ?? ((l: string) => console.error(l));
  const shape = detectShape(o.cwd, o.settings);
  if (shape.kind !== "roots") throw new ConfigError(`terragucci request writes a plain root, and this repo is a ${shape.kind} repo, whose roots it does not write`);
  const t = templatesSettings(o.settings);

  const catalog = await readTemplatesCatalog(o.cwd, o.settings, { ...(o.registry ? { registry: o.registry } : {}), ...(o.catalogFetch ? { fetch: o.catalogFetch } : {}) });
  const component = findComponent(catalog, o.template);
  const listed = component ? component.versions.filter((v) => requestable(v, t.require)) : [];
  const versionKey = o.version ?? listed[0]?.version ?? component?.latest ?? component?.versions[0]?.version ?? "";
  const version = component?.versions.find((v) => v.version === versionKey || v.digest === versionKey);
  let spec: ChantTemplateSpec = { contract: 1, description: "none", inputs: [] };
  if (component && version) {
    const held = versionTemplate(version);
    if (!held) return refused("not-a-template", "version", `version ${versionKey} of ${templateAddress(component)} has no template.yml in its release, so it is no template`);
    spec = core.parseTemplateSpec(held);
    // chant's check reads the inputs and the version, never the template's kind, so the kinds are matched here.
    const kind = spec.kind ?? "app";
    if (kind === "addon" && !addon) return refused("wrong-kind", "template", `${templateAddress(component)} is an add-on template; name the app it goes into with --app`);
    if (kind === "app" && addon) return refused("wrong-kind", "template", `${templateAddress(component)} is an app template; --app adds an add-on to an app, which takes an add-on template`);
  }

  const byName = new Map(spec.inputs.map((i) => [i.name, i]));
  const inputs: Record<string, unknown> = { ...(o.inputs ?? {}) };
  for (const [k, v] of Object.entries(o.rawInputs ?? {})) inputs[k] = typed(v, byName.get(k));
  const claimedBy = o.claimedBy?.trim();
  const req = core.makeTemplateRequest({
    kind: addon ? "addon" : "app",
    template: component ? templateAddress(component) : o.template,
    version: versionKey,
    app: o.app ?? o.name,
    ...(addon ? { addon: o.name } : {}),
    inputs,
    requestedBy: o.requestedBy,
    ...(claimedBy ? { claimedBy } : {}),
    via: o.via,
  });
  // A chant whose request has no claimedBy drops it from the document; the ledger line still carries it.
  if (claimedBy && req.claimedBy === undefined) log(`terragucci: the installed chant's template request has no claimedBy, so the pull request does not name ${claimedBy}`);
  const check = core.checkTemplateRequest(req, catalog, spec, { ...(component ? { component: component.name } : {}), require: t.require === "any" ? "unsigned" : "signed" });
  // An add-on's `app.<output>` is a reference of any kind; the render checks the output exists.
  const refusals = check.ok ? [] : check.refusals.filter((r) => !(addon && r.code === "input-type" && r.field.startsWith("inputs.") && typeof inputs[r.field.slice(7)] === "string" && APP_REF.test(inputs[r.field.slice(7)] as string)));
  if (refusals.length > 0) return { ok: false, code: refusals[0]!.code, refusals };
  const checked = check.ok ? check.request : req;

  if (!addon) {
    const appDir = appRootPath(t.apps, o.name);
    if (o.settings.roots && !o.settings.roots.some((g) => globMatch(g, appDir))) {
      return refused("not-a-root", "app", `${appDir} matches none of roots (${o.settings.roots.join(", ")}), so the pipeline would never plan it; add a glob for templates.apps to roots`);
    }
  }
  const at = await requestBase(o, env);
  const planned = addon ? await planAddon(o, at.files, checked, catalog, component!, spec, render) : planApp(o, at.files, checked, version!, component!, spec, render);
  if (!planned.ok) return planned;
  const branch = core.requestBranch(checked);
  const paths = [...planned.files.keys()];
  if (at.dryRun) return { ok: true, dryRun: true, branch, files: paths };

  const { title, files } = planned;
  const body = [core.requestBody(checked, productWords()), o.footer?.trim()].filter(Boolean).join("\n\n");
  const open = await prForgeOf(at.target, at.fetch).findPullRequest(branch);
  if (open) return { ok: true, dryRun: false, branch, files: paths, title, pull_request: open.number, url: open.url ?? "", existing: true, request: checked };

  const tree = worktree(o.cwd, at.tip);
  try {
    for (const [file, text] of files) {
      mkdirSync(dirname(join(tree.dir, file)), { recursive: true });
      writeFileSync(join(tree.dir, file), text);
    }
    git(tree.dir, ["add", "-A"], env);
    const trailers = [`Requested-by: ${checked.requestedBy}`, ...(claimedBy ? [`Claimed-by: ${claimedBy}`] : [])].join("\n");
    git(tree.dir, [...IDENTITY, "commit", "-q", "--no-verify", "-m", `${title}\n\n${trailers}\n`], env);
    try {
      // Never a force push: a branch already there from another request keeps what it has.
      git(tree.dir, ["push", "-q", "origin", `HEAD:refs/heads/${branch}`], env);
    } catch (e) {
      const why = String((e as { stderr?: string }).stderr || (e as Error).message).trim().split("\n").filter(Boolean).pop() ?? "";
      throw new ConfigError(`could not push ${branch} (${why}); a branch of that name with no open pull request is in the way: remove it, or pick another ${addon ? "add-on" : "app"} name`);
    }
  } finally {
    tree.done();
  }
  const pr = await openPullRequest(at.fetch, at.target, { head: branch, base: at.base, title, body });
  const result: RequestResult = { ok: true, dryRun: false, branch, files: paths, title, pull_request: pr.number, url: pr.url, existing: pr.existing, request: checked };
  await recordRequest(o.cwd, result, claimedBy, log);
  return result;
}

/** A new app's root: chant's `main.tf`, plus the files `generate` writes for it. Refused when the root is there. */
function planApp(o: RequestOptions, files: TreeFiles, request: ChantTemplateRequest, version: ChantCatalogVersion, component: ChantCatalogComponent, spec: ChantTemplateSpec, render: ChantTemplateRender): Planned {
  const appDir = appRootPath(templatesSettings(o.settings).apps, o.name);
  if (files.list(appDir).length > 0) return refused("app-exists", "app", `${appDir}/ exists on ${files.label === "the checkout" ? "the checkout" : "the default branch"}; pick another name, or change that app in a pull request of its own`);
  let rendered;
  try {
    const outputs = ((version.fields.terraform as { outputs?: { name: string; description?: string | null; sensitive?: boolean }[] } | undefined)?.outputs ?? []).map((x) => ({ name: x.name, ...(x.description ? { description: x.description } : {}), ...(x.sensitive ? { sensitive: true } : {}) }));
    rendered = render.renderAppRoot({ request, source: addressOf(component), inputs: spec.inputs, outputs });
  } catch (e) {
    if (e instanceof render.TemplateRenderError) return refused(e.code, e.subject, e.message);
    throw e;
  }
  const out = new Map<string, string>(rendered.map((f) => [`${appDir}/${f.path}`, f.text]));
  if (o.settings.generate) {
    const made = renderRoot(rootSettings(o.settings.generate, appDir, o.settings));
    for (const [kind, name] of Object.entries(GENERATED_FILES) as [keyof typeof GENERATED_FILES, string][]) {
      const text = made[kind];
      if (text !== undefined) out.set(`${appDir}/${name}`, text);
    }
  }
  return { ok: true, files: out, title: `Request: ${o.name} from ${templateName(request.template)} ${request.version}` };
}

/**
 * One add-on's module call in an existing app's root, `addon-<name>.tf`,
 * rendered with chant's renderAddonCall from the app module's outputs as the
 * catalog lists them for the version the app pins. Refused with
 * `not-an-app` when the root holds no `module "app"`, and `addon-exists`
 * when the file or a module of that name is there.
 */
async function planAddon(o: RequestOptions, files: TreeFiles, request: ChantTemplateRequest, catalog: ChantReleaseCatalogDoc, component: ChantCatalogComponent, spec: ChantTemplateSpec, render: ChantTemplateRender): Promise<Planned> {
  const app = o.app!;
  const appDir = appRootPath(templatesSettings(o.settings).apps, app);
  const where = files.label === "the checkout" ? "the checkout" : "the default branch";
  const root = await readAppRoot(files, appDir, app, o.parser ?? (await loadHclParser("terragucci request --app reads the app's root")));
  if (!root) return refused("not-an-app", "app", `${appDir} on ${where} holds no app made from a template (no module "app" call there); terragucci templates apps lists the apps`);
  const file = `${appDir}/${addonFile(o.name)}`;
  if (root.files.includes(addonFile(o.name)) || root.modules.includes(o.name)) {
    return refused("addon-exists", "addon", `${app} already has ${root.files.includes(addonFile(o.name)) ? file : `a module "${o.name}"`} on ${where}; pick another add-on name, or change that add-on in a pull request of its own`);
  }
  const pinned = catalogVersionOf(catalog, root.call);
  let rendered;
  try {
    rendered = render.renderAddonCall!({ request, source: addressOf(component), inputs: spec.inputs, appOutputs: versionOutputs(pinned.version) });
  } catch (e) {
    if (!(e instanceof render.TemplateRenderError)) throw e;
    const unlisted = e.code === "unknown-output" && !pinned.version ? `; the catalog lists no outputs for ${root.call.source} ${root.call.version ?? "(no version)"}, the module the app calls` : "";
    return refused(e.code, e.subject, `${e.message}${unlisted}`);
  }
  return { ok: true, files: new Map([[`${appDir}/${rendered.path}`, rendered.text]]), title: `Request: ${o.name} for ${app} from ${templateName(request.template)} ${request.version}` };
}

/** The request's line on chant/lifecycle (`_gates/template-requests.jsonl`), which the audit trail reads. Never fails the request. */
async function recordRequest(cwd: string, r: Extract<RequestResult, { dryRun: false }>, claimedBy: string | undefined, log: (l: string) => void): Promise<void> {
  const line = {
    version: 1,
    kind: "request",
    timestamp: new Date().toISOString(),
    template: r.request.template,
    templateVersion: r.request.version,
    app: r.request.app,
    ...(r.request.addon !== undefined ? { addon: r.request.addon } : {}),
    requestedBy: r.request.requestedBy,
    ...(claimedBy ? { claimedBy } : {}),
    via: r.request.via,
    branch: r.branch,
    pullRequest: r.pull_request,
    ...(r.url ? { url: r.url } : {}),
  };
  const what = r.request.addon !== undefined ? `the add-on ${r.request.addon} for ${r.request.app}` : r.request.app;
  try {
    (await import("./apply")).appendLifecycle(cwd, REQUESTS_FILE, [JSON.stringify(line)], {}, `Request ${what} from ${r.request.template} ${r.request.version}`);
  } catch (e) {
    log(`terragucci: could not record the request on chant/lifecycle (${(e as Error).message})`);
  }
}
