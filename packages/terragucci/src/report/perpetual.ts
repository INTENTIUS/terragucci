/**
 * Changes on every run: a planned update or replacement that the root's last
 * applied waves each made too, to the same address, with the same action and
 * the same attributes. An archive hash a build rebuilds each time, a value
 * the provider normalises differently from config, a timestamp in a tag.
 *
 * The applied waves come from the project's `changes.json` in the reports
 * bucket (./history.ts), whose rows a `tf-apply` wave writes, one per
 * resource it changed, newest first. A root's waves there are the run
 * directories with a row of it, so a wave that applied the root and changed
 * nothing has none.
 *
 * The marking only changes how the note shows the change: `perpetual` and
 * `streak` on the report's change. The plan, its digests and the gate's
 * decision are made before it and read none of it.
 */
import type { ChangeRow } from "./history";
import type { Report, ReportChange } from "./schema";

/** How many applied waves in a row make a change one on every run. */
export const PERPETUAL_WAVES = 3;

/** The top-level attribute names a planned change writes, sorted, as changes.json names them. */
const topNames = (c: ReportChange): string[] => [...new Set(c.attributes.map((a) => a.path.split(/[.[]/)[0]))].sort();

const same = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/** Whether an applied row made the planned change: its address, its action alone, its attributes. */
function made(row: ChangeRow, c: ReportChange, names: readonly string[]): boolean {
  return row.address === c.address && same(row.actions, [c.action]) && same([...row.attributes].sort(), names);
}

/**
 * Mark each planned update or replacement of the report whose root's newest
 * applied waves, `waves` or more in a row, each made the same change:
 * `perpetual: true` and `streak`, the waves in a row. Returns how many it marked.
 */
export function markPerpetual(report: Report, rows: readonly ChangeRow[], waves = PERPETUAL_WAVES): number {
  const byRoot = new Map<string, Map<string, { finished: number; rows: ChangeRow[] }>>();
  for (const row of rows) {
    const runs = byRoot.get(row.root) ?? new Map<string, { finished: number; rows: ChangeRow[] }>();
    byRoot.set(row.root, runs);
    const run = runs.get(row.path) ?? { finished: Date.parse(row.finished) || 0, rows: [] };
    runs.set(row.path, run);
    run.rows.push(row);
  }
  let marked = 0;
  for (const root of report.roots) {
    const runs = [...(byRoot.get(root.path)?.values() ?? [])].sort((a, b) => b.finished - a.finished);
    if (runs.length < waves) continue;
    for (const c of root.changes) {
      if ((c.action !== "update" && c.action !== "replace") || c.deposed !== undefined) continue;
      const names = topNames(c);
      if (names.length === 0) continue;
      let streak = 0;
      while (streak < runs.length && runs[streak].rows.some((r) => made(r, c, names))) streak++;
      if (streak < waves) continue;
      c.perpetual = true;
      c.streak = streak;
      marked++;
    }
  }
  return marked;
}

/** Each change on every run, by root, with its top-level attribute names. */
export function perpetualChanges(report: Pick<Report, "roots">): { root: string; change: ReportChange; attributes: string[] }[] {
  return report.roots.flatMap((r) => r.changes.filter((c) => c.perpetual).map((change) => ({ root: r.path, change, attributes: topNames(change) })));
}
