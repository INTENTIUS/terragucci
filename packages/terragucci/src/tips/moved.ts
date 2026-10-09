/**
 * The rename tip: a resource whose block was renamed plans as a destroy of
 * the old address and a create of the new one. When the create's
 * configuration matches what the destroyed resource holds, the change is a
 * rename, and a `moved` block makes the plan move the object instead.
 *
 * A pair is a rename when, in one root's plan:
 *
 *   - one resource is deleted because its block is gone and one created, of
 *     the same type and provider, both in the root module and neither with a
 *     count or for_each key;
 *   - every value the create knows before apply equals the deleted
 *     resource's value at the same path (values known only after apply, and
 *     sensitive ones, are not compared);
 *   - the delete matches only that create and the create only that delete.
 *
 * It reads a plan, so it is known only after one. It is advice: nothing
 * here changes a plan, a digest or a gate.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** A rename one root's plan shows: the address destroyed and the address created. */
export interface Rename {
  root: string;
  type: string;
  from: string;
  to: string;
}

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

/** Whether every value `after` knows equals `before` at the same path. */
function sameKnown(after: unknown, before: unknown, unknown: unknown, sensitive: unknown): boolean {
  if (unknown === true || sensitive === true) return true;
  if (Array.isArray(after)) {
    if (!Array.isArray(before) || before.length !== after.length) return false;
    return after.every((v, i) => sameKnown(v, before[i], Array.isArray(unknown) ? unknown[i] : undefined, Array.isArray(sensitive) ? sensitive[i] : undefined));
  }
  if (isObject(after)) {
    if (!isObject(before)) return false;
    return Object.keys(after).every((k) => sameKnown(after[k], before[k], isObject(unknown) ? unknown[k] : undefined, isObject(sensitive) ? sensitive[k] : undefined));
  }
  if (after === null) return before === null || before === undefined;
  return after === before;
}

interface Candidate {
  address: string;
  type: string;
  provider: string;
  change: Json;
}

function candidates(plan: unknown, action: "create" | "delete"): Candidate[] {
  const list = isObject(plan) && Array.isArray(plan.resource_changes) ? plan.resource_changes : [];
  const out: Candidate[] = [];
  for (const rc of list) {
    if (!isObject(rc) || !isObject(rc.change)) continue;
    const actions = rc.change.actions;
    if (!Array.isArray(actions) || actions.length !== 1 || actions[0] !== action) continue;
    if (rc.mode !== "managed" || rc.module_address !== undefined || rc.index !== undefined || rc.deposed !== undefined) continue;
    if (typeof rc.address !== "string" || typeof rc.type !== "string") continue;
    // A delete for any reason but its block being gone (a count or for_each key that went away, a module) is no rename.
    if (action === "delete" && rc.action_reason !== undefined && rc.action_reason !== "delete_because_no_resource_config") continue;
    out.push({ address: rc.address, type: rc.type, provider: String(rc.provider_name ?? ""), change: rc.change });
  }
  return out;
}

/** The renames one root's plan (`show -json`) shows. */
export function renamesIn(root: string, plan: unknown): Rename[] {
  const deletes = candidates(plan, "delete");
  const creates = candidates(plan, "create");
  const pairs = (d: Candidate, c: Candidate): boolean =>
    d.type === c.type && d.provider === c.provider && sameKnown(c.change.after, d.change.before, c.change.after_unknown, c.change.after_sensitive);
  const out: Rename[] = [];
  for (const d of deletes) {
    const matched = creates.filter((c) => pairs(d, c));
    if (matched.length !== 1) continue;
    const c = matched[0]!;
    if (deletes.filter((other) => pairs(other, c)).length !== 1) continue;
    out.push({ root, type: d.type, from: d.address, to: c.address });
  }
  return out.sort((a, b) => (a.to < b.to ? -1 : a.to > b.to ? 1 : 0));
}

/** The `moved` blocks for some renames, as HCL. */
export function movedBlocks(renames: readonly Rename[]): string {
  return renames.map((r) => `moved {\n  from = ${r.from}\n  to   = ${r.to}\n}\n`).join("\n");
}

/** The `.tf` file of a root that declares `address` (`<type>.<name>`), or undefined. */
export function declaringFile(dir: string, address: string): string | undefined {
  const [type, name] = address.split(".");
  if (!type || !name || !existsSync(dir)) return undefined;
  const block = new RegExp(`^\\s*resource\\s+"${type}"\\s+"${name}"\\s*\\{`, "m");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".tf"))
    .sort()
    .find((f) => block.test(readFileSync(join(dir, f), "utf-8")));
}

/** A file's text with `blocks` after it, one blank line between. */
export function appendBlocks(text: string, blocks: string): string {
  return `${text.replace(/\n*$/, "\n")}\n${blocks}`;
}
