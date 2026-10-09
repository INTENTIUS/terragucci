/**
 * Wave-refused diff: an approval binds a wave's set digest, so when the plans
 * move after it the wave applies nothing. This says which roots moved and
 * what moved in them, from the approved plan's report and the current one.
 */
import type { Report, ReportChange } from "../report/schema";

export interface ChangeDiff {
  address: string;
  /** The action in the approved plan; absent when the change is new. */
  was?: string;
  /** The action now; absent when the change is gone. */
  now?: string;
  /** Attributes whose planned value differs. */
  attributes: string[];
}

export interface RootDiff {
  root: string;
  approved: string | null;
  current: string | null;
  changes: ChangeDiff[];
}

export interface RefusedDiff {
  wave?: number;
  approved_set: string | null;
  current_set: string | null;
  roots: RootDiff[];
}

const value = (a: { after?: unknown; unknown?: true; sensitive?: true }): string =>
  a.sensitive ? "(sensitive)" : a.unknown ? "(known after apply)" : JSON.stringify(a.after ?? null);

function changeDiffs(was: ReportChange[], now: ReportChange[]): ChangeDiff[] {
  const before = new Map(was.map((c) => [c.address + (c.deposed ?? ""), c]));
  const after = new Map(now.map((c) => [c.address + (c.deposed ?? ""), c]));
  const out: ChangeDiff[] = [];
  for (const key of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const b = before.get(key);
    const a = after.get(key);
    const attrs = new Map<string, [string?, string?]>();
    for (const x of b?.attributes ?? []) attrs.set(x.path, [value(x), undefined]);
    for (const x of a?.attributes ?? []) attrs.set(x.path, [attrs.get(x.path)?.[0], value(x)]);
    const moved = [...attrs].filter(([, [p, q]]) => p !== q).map(([path]) => path);
    if (b?.action === a?.action && moved.length === 0) continue;
    out.push({ address: (a ?? b)!.address, ...(b ? { was: b.action } : {}), ...(a ? { now: a.action } : {}), attributes: moved });
  }
  return out;
}

/** The roots whose plan digest moved between the approved report and the current one, in a wave or across the run. */
export function refusedDiff(approved: Report, current: Report, wave?: number): RefusedDiff {
  const inWave = (r: Report) => (wave === undefined ? undefined : r.waves.find((w) => w.number === wave));
  const roots = [...new Set([...(inWave(approved)?.roots ?? approved.roots.map((r) => r.path)), ...(inWave(current)?.roots ?? current.roots.map((r) => r.path))])].sort();
  const out: RefusedDiff = {
    ...(wave !== undefined ? { wave } : {}),
    approved_set: wave === undefined ? approved.change_set : (inWave(approved)?.set_digest ?? null),
    current_set: wave === undefined ? current.change_set : (inWave(current)?.set_digest ?? null),
    roots: [],
  };
  for (const root of roots) {
    const a = approved.roots.find((r) => r.path === root);
    const c = current.roots.find((r) => r.path === root);
    const was = a?.plan_digest ?? null;
    const now = c?.plan_digest ?? null;
    if (was === now && was !== null) continue;
    out.roots.push({ root, approved: was, current: now, changes: changeDiffs(a?.changes ?? [], c?.changes ?? []) });
  }
  return out;
}

/** A digest's first 12 hex characters, past its scheme ("sha256:", "jcs1-sha256:"); "none" when there is none. */
export const short = (d: string | null): string => (d ? d.slice(d.lastIndexOf(":") + 1).slice(0, 12) : "none");

export function describeRefused(d: RefusedDiff): string {
  const what = d.wave === undefined ? "The change set" : `Wave ${d.wave}`;
  if (d.roots.length === 0) return `${what}: every root's plan matches the approved one (${short(d.approved_set)}).`;
  const lines = [`${what} applies nothing: its plans changed after the approval (approved ${short(d.approved_set)}, now ${short(d.current_set)}).`, ""];
  for (const r of d.roots) {
    lines.push(`- \`${r.root}\`: plan ${short(r.approved)} -> ${short(r.current)}`);
    for (const c of r.changes) {
      const action = c.was === c.now ? c.now : `${c.was ?? "none"} -> ${c.now ?? "none"}`;
      lines.push(`  - \`${c.address}\` ${action}${c.attributes.length ? `: ${c.attributes.join(", ")}` : ""}`);
    }
    if (r.current === null) lines.push("  - it did not plan this time");
  }
  lines.push("", "Approve the wave again only once the new plan is what you want.");
  return lines.join("\n");
}
