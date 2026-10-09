/**
 * The resource inventory: which resources each root holds, by address, type
 * and provider, and never a value. A `tf-apply` wave reads it from each root's
 * plan once the root applied (or had nothing to apply): the plan's
 * `planned_values` are the state the apply leaves. The report carries it as
 * `roots[].resources`, and the upload keeps the newest list of every root in
 * `<prefix>/<project>/inventory.json`, which `terragucci estate` reads.
 *
 * Only the address, `type` and `provider_name` of a managed resource are
 * read. Nothing under `values` is ever touched, so a sensitive value in the
 * plan cannot reach the list.
 */
import { isObject } from "./redact";
import type { Report, ReportResource } from "./schema";

export const INVENTORY_SCHEMA = "terragucci.inventory/v1";

/** One root's resources, as its newest applied wave left them. */
export interface InventoryRoot {
  root: string;
  commit: string;
  /** When the wave that recorded them finished. */
  finished: string;
  wave?: number;
  /** The run's directory, relative to the project's index. */
  path: string;
  resources: ReportResource[];
}

export interface Inventory {
  schema: typeof INVENTORY_SCHEMA;
  /** By root path. */
  roots: InventoryRoot[];
}

const byAddress = (a: ReportResource, b: ReportResource): number => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0);

/** Every managed resource the plan's planned values hold, child modules included, sorted by address. */
export function planResources(plan: unknown): ReportResource[] {
  const out: ReportResource[] = [];
  const walk = (module: unknown): void => {
    if (!isObject(module)) return;
    for (const r of Array.isArray(module.resources) ? module.resources : []) {
      if (!isObject(r) || r.mode !== "managed" || typeof r.address !== "string" || typeof r.type !== "string") continue;
      out.push({ address: r.address, type: r.type, provider: typeof r.provider_name === "string" ? r.provider_name : "" });
    }
    for (const child of Array.isArray(module.child_modules) ? module.child_modules : []) walk(child);
  };
  const values = isObject(plan) ? plan.planned_values : undefined;
  walk(isObject(values) ? values.root_module : undefined);
  return out.sort(byAddress);
}

/** The roots of a report that recorded their resources: a `tf-apply` wave's roots that applied. */
export function inventoryRoots(report: Report, path: string): InventoryRoot[] {
  if (report.run.stage !== "tf-apply") return [];
  return report.roots
    .filter((r) => r.resources !== undefined)
    .map((r) => ({
      root: r.path,
      commit: report.run.commit,
      finished: report.run.finished,
      ...(report.run.wave !== undefined ? { wave: report.run.wave } : {}),
      path,
      resources: r.resources!,
    }));
}

/** Read an inventory; anything unreadable is an empty one, rebuilt from the next apply on. */
export function readInventory(text: string | undefined): Inventory {
  if (text) {
    try {
      const parsed = JSON.parse(text) as Partial<Inventory>;
      if (Array.isArray(parsed.roots)) return { schema: INVENTORY_SCHEMA, roots: parsed.roots };
    } catch {
      // An unreadable inventory is rebuilt.
    }
  }
  return { schema: INVENTORY_SCHEMA, roots: [] };
}

/** The inventory with each root's list replaced by the one given, unless the inventory holds a newer one for that root. */
export function addToInventory(existing: string | undefined, roots: InventoryRoot[]): Inventory {
  const held = new Map(readInventory(existing).roots.map((r) => [r.root, r]));
  for (const r of roots) {
    const old = held.get(r.root);
    if (!old || !(Date.parse(old.finished) > Date.parse(r.finished))) held.set(r.root, r);
  }
  return { schema: INVENTORY_SCHEMA, roots: [...held.values()].sort((a, b) => (a.root < b.root ? -1 : a.root > b.root ? 1 : 0)) };
}

/** How many resources of each type, most first, then by type. */
export function countTypes(resources: ReportResource[]): { type: string; count: number }[] {
  const n = new Map<string, number>();
  for (const r of resources) n.set(r.type, (n.get(r.type) ?? 0) + 1);
  return [...n].map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count || (a.type < b.type ? -1 : 1));
}
