/**
 * The apps a repo made from templates, read from their roots:
 * `terragucci templates apps`, and the app root an add-on request adds to.
 *
 * An app is a root under `templates.apps` whose `module "app"` calls a
 * template (chant's renderAppRoot writes it so). Each add-on is one more
 * module call in that root, `module "<name>"` in `addon-<name>.tf` (ruling C
 * of chant#4642), so the app and its add-ons plan and apply together. The
 * template and version of each call are read from its `source` and
 * `version`; the day-2 actions come from the release catalog, which lists
 * the `action` blocks each published module version declares.
 *
 * Roots are read from the checkout, or from a commit (`git ls-tree` and
 * `git show`) when the default branch's tip is what counts.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import type { Hcl2Json } from "@intentius/chant/terraform/parse";
import type { ChantCatalogComponent, ChantCatalogVersion, ChantReleaseCatalogDoc } from "./chant-next";
import { findComponent } from "./publish/catalog";
import { compareSemver, parseSemver } from "./publish/semver";

/** The module block an app root calls its template through (chant's `APP_MODULE_NAME`). */
export const APP_MODULE = "app";

/** The file in an app's root an add-on's module call is written to (chant's `addonFile`). */
export const addonFile = (name: string): string => `addon-${name}.tf`;

const ADDON_FILE = /^addon-([a-z][a-z0-9-]{0,39})\.tf$/;
const APP_NAME = "[a-z][a-z0-9-]{0,39}";

// ── reading roots ────────────────────────────────────────────────────────────

/** The files of a tree: the checkout, or one commit. Paths are relative to the repository. */
export interface TreeFiles {
  /** Where the files come from, for a message: `the checkout` or a short commit. */
  label: string;
  /** The names in a directory, with a trailing `/` on each directory; empty when there is none. */
  list(dir: string): string[];
  read(path: string): string | undefined;
}

/** The checkout's own files. */
export function checkoutFiles(cwd: string): TreeFiles {
  return {
    label: "the checkout",
    list(dir) {
      const abs = join(cwd, dir);
      if (!existsSync(abs) || !statSync(abs).isDirectory()) return [];
      return readdirSync(abs, { withFileTypes: true }).map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).sort();
    },
    read(path) {
      const abs = join(cwd, path);
      return existsSync(abs) && statSync(abs).isFile() ? readFileSync(abs, "utf-8") : undefined;
    },
  };
}

/** The files at one commit, read with git and never checked out. */
export function commitFiles(cwd: string, commit: string, env?: NodeJS.ProcessEnv): TreeFiles {
  const run = (args: string[]): string | undefined => {
    try {
      return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], env: { ...(env ?? process.env), GIT_TERMINAL_PROMPT: "0" } });
    } catch {
      return undefined;
    }
  };
  return {
    label: commit.slice(0, 12),
    list(dir) {
      const out = run(["ls-tree", `${commit}:${dir === "." ? "" : dir}`]);
      if (out === undefined) return [];
      return out
        .split("\n")
        .filter(Boolean)
        .map((l) => {
          const [meta, name] = l.split("\t") as [string, string];
          return meta.split(" ")[1] === "tree" ? `${name}/` : name;
        })
        .sort();
    },
    read(path) {
      return run(["cat-file", "blob", `${commit}:${path}`]);
    },
  };
}

/** One module call in an app's root. */
export interface ModuleCallRow {
  /** The module block's name: `app`, or the add-on's. */
  name: string;
  /** The file it is in, relative to the repository. */
  file: string;
  source: string;
  /** The call's `version`, or null when it has none. */
  version: string | null;
}

/** An app's root, as its files stand. */
export interface AppRoot {
  app: string;
  /** The root's path in the repository: `apps/orders`. */
  root: string;
  /** Its `module "app"` call. */
  call: ModuleCallRow;
  /** Each add-on: a `module "<name>"` in `addon-<name>.tf`. */
  addons: ModuleCallRow[];
  /** The name of every module block in the root, the app's and its add-ons' included. */
  modules: string[];
  /** Every file in the root's directory. */
  files: string[];
}

/** An app's root path: `templates.apps` with the name in it. */
export const appRootPath = (apps: string, name: string): string => apps.split("{name}").join(name);

/** The app a root is, by `templates.apps`: `orders` for `apps/orders`; undefined for a root the pattern does not name. */
export function appNameOf(apps: string, root: string): string | undefined {
  const [pre, post] = apps.split("{name}") as [string, string | undefined];
  if (post === undefined) return undefined;
  return new RegExp(`^${escape(pre)}(${APP_NAME})${escape(post)}$`).exec(root)?.[1];
}

/**
 * Read the root at `root` as an app's: undefined when it holds no
 * `module "app"` call, so it is no app made from a template.
 */
export async function readAppRoot(tree: TreeFiles, root: string, app: string, parser: Hcl2Json): Promise<AppRoot | undefined> {
  const files = tree.list(root).filter((f) => !f.endsWith("/"));
  const calls: ModuleCallRow[] = [];
  for (const f of files.filter((x) => x.endsWith(".tf"))) {
    const file = posix.join(root, f);
    const text = tree.read(file);
    if (text === undefined) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = (await parser.parse(file, text)) as Record<string, unknown>;
    } catch {
      continue;
    }
    for (const [name, list] of Object.entries((parsed.module as Record<string, Record<string, unknown>[]> | undefined) ?? {})) {
      const body = list[0] ?? {};
      calls.push({ name, file, source: typeof body.source === "string" ? body.source : "", version: typeof body.version === "string" ? body.version : null });
    }
  }
  const call = calls.find((c) => c.name === APP_MODULE);
  if (!call) return undefined;
  const addons = calls.filter((c) => c.name !== APP_MODULE && ADDON_FILE.exec(posix.basename(c.file))?.[1] === c.name).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { app, root, call, addons, modules: calls.map((c) => c.name), files };
}

/**
 * Every app under `templates.apps`: each directory the pattern names whose
 * root holds a `module "app"` call, in name order.
 */
export async function findApps(tree: TreeFiles, apps: string, parser: Hcl2Json): Promise<AppRoot[]> {
  const segments = apps.split("/");
  const at = segments.findIndex((s) => s.includes("{name}"));
  const parent = segments.slice(0, at).join("/") || ".";
  const [pre, post] = segments[at]!.split("{name}") as [string, string];
  const match = new RegExp(`^${escape(pre)}(${APP_NAME})${escape(post)}$`);
  const out: AppRoot[] = [];
  for (const entry of tree.list(parent)) {
    if (!entry.endsWith("/")) continue;
    const name = match.exec(entry.slice(0, -1))?.[1];
    if (!name) continue;
    const found = await readAppRoot(tree, appRootPath(apps, name), name, parser);
    if (found) out.push(found);
  }
  return out;
}

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ── the catalog's view of a call ─────────────────────────────────────────────

/** A registry address without its host: `acme/bucket/aws` for `modules.example.com/acme/bucket/aws`. */
export function addressWithoutHost(address: string): string {
  const parts = address.split("/");
  return parts.length >= 4 ? parts.slice(1).join("/") : address;
}

/** The catalog's component and version a module call pins, when the catalog lists them. */
export function catalogVersionOf(catalog: ChantReleaseCatalogDoc | undefined, call: Pick<ModuleCallRow, "source" | "version">): { component?: ChantCatalogComponent; version?: ChantCatalogVersion } {
  if (!catalog || !call.source) return {};
  const component = findComponent(catalog, call.source);
  if (!component) return {};
  const v = pinnedVersion(call.version);
  const version = v ? component.versions.find((x) => x.version === v) : undefined;
  return { component, ...(version ? { version } : {}) };
}

/** The version a call pins, without a leading `=`: `1.2.0` for `= 1.2.0`; null for none. */
export function pinnedVersion(version: string | null): string | null {
  const v = version?.trim().replace(/^=\s*/, "");
  return v ? v : null;
}

/** Whether `templates.require` lets a version be requested or offered: `any` takes every version, `signed` refuses an unsigned one. */
export function attestedFor(v: ChantCatalogVersion, require: "signed" | "any"): boolean {
  return require === "any" || v.attestation.state !== "unsigned";
}

/**
 * The newest active version of a component above `pin`, or null: none is
 * newer, or the pin is no plain version. Under `templates.require: signed`
 * (the default) an unsigned version is never the upgrade, as a request
 * refuses it.
 */
export function upgradeOf(component: ChantCatalogComponent | undefined, pin: string | null, require: "signed" | "any" = "signed"): string | null {
  const at = pin ? parseSemver(pin) : undefined;
  if (!component || !at) return null;
  let best: { v: NonNullable<ReturnType<typeof parseSemver>>; text: string } | undefined;
  for (const x of component.versions) {
    const v = x.status.state === "active" && x.version && attestedFor(x, require) ? parseSemver(x.version) : undefined;
    if (v && compareSemver(v, at) > 0 && (!best || compareSemver(v, best.v) > 0)) best = { v, text: x.version! };
  }
  return best?.text ?? null;
}

/** Whether the catalog marks the version a call pins as yanked. */
export function isYanked(version: ChantCatalogVersion | undefined): boolean {
  return version?.status.state === "yanked";
}

/** One version's changelog entries, as the catalog keeps them. */
export interface VersionChangelog {
  version: string;
  entries: ChantCatalogVersion["changelog"]["entries"];
}

/** The changelog of each version above `from` up to and including `to`, newest first. */
export function changelogBetween(component: ChantCatalogComponent, from: string, to: string): VersionChangelog[] {
  const lo = parseSemver(from);
  const hi = parseSemver(to);
  if (!lo || !hi) return [];
  return component.versions
    .map((x) => ({ x, v: x.version ? parseSemver(x.version) : undefined }))
    .filter((e): e is { x: ChantCatalogVersion; v: NonNullable<ReturnType<typeof parseSemver>> } => !!e.v && compareSemver(e.v, lo) > 0 && compareSemver(e.v, hi) <= 0)
    .sort((a, b) => compareSemver(b.v, a.v))
    .map((e) => ({ version: e.x.version!, entries: e.x.changelog.entries }));
}

/** The names of a module version's outputs, as the catalog lists them. */
export function versionOutputs(version: ChantCatalogVersion | undefined): string[] {
  const outputs = (version?.fields.terraform as { outputs?: { name?: unknown }[] } | undefined)?.outputs ?? [];
  return outputs.map((o) => o.name).filter((n): n is string => typeof n === "string");
}

/** The `action` blocks a module version declares, as publish lists them in the catalog (`fields.terraform.actions`). */
export function versionActions(version: ChantCatalogVersion | undefined): { type: string; name: string }[] {
  const actions = (version?.fields.terraform as { actions?: unknown } | undefined)?.actions;
  if (!Array.isArray(actions)) return [];
  return actions.filter((a): a is { type: string; name: string } => typeof a?.type === "string" && typeof a?.name === "string").map((a) => ({ type: a.type, name: a.name }));
}

// ── terragucci templates apps ────────────────────────────────────────────────

/** A day-2 action an app's root can run: an `action` block of the app's module or of an add-on's. */
export interface AppAction {
  /** The module block it is in: `app`, or the add-on's name. */
  module: string;
  type: string;
  name: string;
  /** The address `terragucci action <root> <address>` takes: `module.app.action.aws_lambda_invoke.rotate`. */
  address: string;
}

/** One add-on of an app. */
export interface AppAddonRow {
  name: string;
  template: string;
  version: string | null;
  /** The newest active version above `version` the catalog lists, or null. */
  upgrade: string | null;
  /** Whether the catalog marks `version` as yanked. */
  yanked: boolean;
}

/** One app, as `terragucci templates apps` lists it. */
export interface AppRow {
  app: string;
  root: string;
  template: string;
  version: string | null;
  /**
   * The newest active version of the template above `version`, or null: none
   * is newer, the pin is no plain version, or the catalog cannot be read.
   * `terragucci rollout <template> <upgrade>` moves the app to it.
   */
  upgrade: string | null;
  /** Whether the catalog marks `version` as yanked. Such an app moves in the first wave after the canaries. */
  yanked: boolean;
  addons: AppAddonRow[];
  /** The action blocks the app's module and its add-ons' declare; empty when the catalog does not say. */
  actions: AppAction[];
}

/** A call's template: the catalog component's address without its host, else the call's source without it. */
function templateOf(catalog: ChantReleaseCatalogDoc | undefined, call: ModuleCallRow): string {
  const { component } = catalogVersionOf(catalog, call);
  const address = (component?.fields.terraform as { address?: unknown } | undefined)?.address;
  return addressWithoutHost(typeof address === "string" ? address : call.source);
}

/** The rows `terragucci templates apps` prints; the catalog, when there is one, names each call's template and its actions. */
export function appRows(roots: readonly AppRoot[], catalog: ChantReleaseCatalogDoc | undefined, require: "signed" | "any" = "signed"): AppRow[] {
  return roots.map((r) => {
    const actions: AppAction[] = [];
    for (const call of [r.call, ...r.addons]) {
      for (const a of versionActions(catalogVersionOf(catalog, call).version)) actions.push({ module: call.name, ...a, address: `module.${call.name}.action.${a.type}.${a.name}` });
    }
    const marks = (call: ModuleCallRow) => {
      const { component, version } = catalogVersionOf(catalog, call);
      return { upgrade: upgradeOf(component, pinnedVersion(call.version), require), yanked: isYanked(version) };
    };
    return {
      app: r.app,
      root: r.root,
      template: templateOf(catalog, r.call),
      version: r.call.version,
      ...marks(r.call),
      addons: r.addons.map((a) => ({ name: a.name, template: templateOf(catalog, a), version: a.version, ...marks(a) })),
      actions,
    };
  });
}

/** Whether an app row is on a template, as its own or one of its add-ons'. */
export function onTemplate(row: AppRow, template: string): boolean {
  const want = addressWithoutHost(template.replace(/\/+$/, ""));
  return [row.template, ...row.addons.map((a) => a.template)].some((t) => t === want);
}

/** One line per app: its root, template and version, then its add-ons. */
export function describeApps(rows: readonly AppRow[]): string {
  if (rows.length === 0) return "no app under templates.apps holds a module \"app\" call";
  return rows
    .map((r) => {
      const marks = (m: { upgrade: string | null; yanked: boolean }) => `${m.yanked ? " (yanked)" : ""}${m.upgrade ? `, upgrade to ${m.upgrade}` : ""}`;
      const addons = r.addons.map((a) => `\n    + ${a.name}  ${a.template} ${a.version ?? "(no version)"}${marks(a)}`).join("");
      const actions = r.actions.length > 0 ? `\n    actions: ${r.actions.map((a) => a.address).join(", ")}` : "";
      return `${r.app}  ${r.root}  ${r.template} ${r.version ?? "(no version)"}${marks(r)}${addons}${actions}`;
    })
    .join("\n");
}
