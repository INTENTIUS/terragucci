/**
 * A rollout of a template: the module rollout, told in apps.
 *
 * When `templates` is set and the release catalog lists the module as a
 * template, the rollout reads three things from the catalog. The apps each
 * wave moves are named by `templates.apps` (`apps/orders` is `orders`), so a
 * wave's pull request says which apps it upgrades. The changelog entries of
 * every version between the old pin and the new one go in its body. And an
 * app pinned to a version the catalog marks yanked joins the rollout from
 * that version, in the first wave after the canaries.
 *
 * The waves, branches, gates and schedule stay the module rollout's: a person
 * starts it (`terragucci rollout <template> <version>`, or the rollout
 * workflow's dispatch with `module` and `version`), and the rollouts schedule
 * opens each later wave once the one before it merged and applied.
 */
import type { ChantCatalogComponent } from "../chant-next";
import { ConfigError, type ResolvedSettings } from "../config";
import { findComponent } from "../publish/catalog";
import { compareSemver, parseSemver } from "../publish/semver";
import { appNameOf, attestedFor, changelogBetween, type VersionChangelog } from "../template-apps";
import { readTemplatesCatalog, templateAddress, templatesSettings, templateName, versionTemplate } from "../templates";

export interface RolloutTemplate {
  /** The template's address without its host: `acme/bucket/aws`. */
  template: string;
  /** Its short name: `bucket`. */
  name: string;
}

export interface TemplateContext extends RolloutTemplate {
  component: ChantCatalogComponent;
  /** `templates.apps`. */
  apps: string;
  /** Each version the catalog marks yanked, with its reason. */
  yanked: Map<string, string | null>;
  /** `templates.require`: under `signed`, an unsigned version is no target. */
  require: "signed" | "any";
}

/**
 * The template a rollout's module is, read from the release catalog; nothing
 * when `templates` is unset or the catalog lists no template by that name. A
 * catalog that cannot be read gives a note, and the rollout goes on as a
 * module's.
 */
export async function templateContext(dir: string, settings: ResolvedSettings, module: string): Promise<{ context?: TemplateContext; note?: string }> {
  if (!settings.templates) return {};
  let catalog;
  try {
    catalog = await readTemplatesCatalog(dir, settings);
  } catch (e) {
    return { note: `the release catalog could not be read (${(e as Error).message.split("\n", 1)[0]}), so this rollout names roots, not apps, and moves no yanked pin` };
  }
  const component = findComponent(catalog, module);
  if (!component || !component.versions.some((v) => versionTemplate(v))) return {};
  const template = templateAddress(component);
  const yanked = new Map(component.versions.filter((v) => v.status.state === "yanked" && v.version).map((v) => [v.version!, v.status.reason]));
  const t = templatesSettings(settings);
  return { context: { template, name: templateName(template), component, apps: t.apps, yanked, require: t.require } };
}

/**
 * The version a template rollout moves its apps to, checked as a request is
 * under `templates.require`: a named version the catalog lists unsigned is
 * refused under `signed`, and with none named it is the newest active version
 * that `require` lets a request name. So an unsigned version is never a
 * rollout's target, nor the upgrade `templates apps` offers.
 */
export function templateTarget(context: TemplateContext, named: string | undefined): { version: string; from?: string } {
  if (named !== undefined) {
    const v = context.component.versions.find((x) => x.version === named);
    if (v && !attestedFor(v, context.require)) {
      throw new ConfigError(`${context.template} ${named} is unsigned, and templates.require: signed lets no app move to an unsigned version; sign and publish it again, or roll out a signed version`);
    }
    return { version: named };
  }
  let best: { v: NonNullable<ReturnType<typeof parseSemver>>; text: string } | undefined;
  for (const x of context.component.versions) {
    const v = x.status.state === "active" && x.version && attestedFor(x, context.require) ? parseSemver(x.version) : undefined;
    if (v && (!best || compareSemver(v, best.v) > 0)) best = { v, text: x.version! };
  }
  if (!best) throw new ConfigError(`the release catalog lists no active version of ${context.template} that templates.require: ${context.require} lets an app move to; name the version to roll out`);
  return { version: best.text, from: "the release catalog" };
}

/** Whether `version` is yanked and below `to`, so a root pinned to it moves in the rollout. */
export function movesYanked(context: TemplateContext | undefined, version: string | null, to: string): boolean {
  if (!context || !version || !context.yanked.has(version)) return false;
  const v = parseSemver(version);
  const t = parseSemver(to);
  return !!v && !!t && compareSemver(v, t) < 0;
}

/** The name a root goes by in a template rollout: its app's, else its path. */
export function appOf(context: TemplateContext, root: string): string {
  return appNameOf(context.apps, root) ?? root;
}

const LISTED = 5;

/** A wave's pull request title: `Upgrade bucket to 1.3.0: orders (wave 1 of 2)`. */
export function templateTitle(context: TemplateContext, to: string, roots: readonly string[], wave: number, waves: number): string {
  const names = roots.map((r) => appOf(context, r));
  const shown = names.length > LISTED + 1 ? [...names.slice(0, LISTED), `${names.length - LISTED} more`] : names;
  return `Upgrade ${context.name} to ${to}: ${shown.join(", ")} (wave ${wave} of ${waves})`;
}

/** The changelog section of a wave's pull request body: each version's entries, newest first. */
export function changelogLines(context: TemplateContext, from: string, to: string): string[] {
  const versions: VersionChangelog[] = changelogBetween(context.component, from, to);
  const head = `Changes to ${context.template} after ${from}, up to ${to}, from the release catalog:`;
  if (versions.length === 0 || versions.every((v) => v.entries.length === 0)) return [`The release catalog lists no changelog entries for ${context.template} after ${from}, up to ${to}.`];
  const lines = [head];
  for (const v of versions) {
    lines.push("", `${v.version}:`, "");
    if (v.entries.length === 0) lines.push("- no entries");
    for (const e of v.entries) lines.push(`- ${e.kind}${e.scope ? `(${e.scope})` : ""}: ${e.subject} (${e.sha.slice(0, 7)})`);
  }
  return lines;
}
