/**
 * The run view: one page per applied commit that shows every wave of its
 * apply, the roots in each, which roots' state each root reads, and where
 * each wave stands at its gate.
 *
 * With `reports.bucket`, each `tf-apply` wave job writes it at
 * `<prefix>/<project>/runs/<commit>/run.json` and `run.html`: when it starts
 * applying, and once its report is written. A wave no job reached yet is
 * `not-started`. The write is conditional on the copy read, as the index's
 * is, so the waves' jobs never lose each other's rows. A run view that cannot
 * be written is logged; it never fails the wave.
 */
import { esc } from "./html";
import type { ObjectStore } from "./object-store";
import type { ReportWave, WaveState } from "./schema";
import { updateJson, type Wait } from "./store";
import { TACO_CSS, TACO_ICON, TACO_IMG } from "./taco";

export const RUN_SCHEMA = "terragucci.run/v1";

/** A wave in the run view: its state, or `not-started` when no job of it ran on this commit yet. */
export interface RunWave {
  number: number;
  roots: string[];
  /** The waves whose roots' state its roots read. */
  reads: number[];
  state: WaveState | "not-started";
  /** Its gate on the ledger: `wave-<k>`. */
  gate: string;
  /** The gate policy it ran under. */
  policy?: string;
  approval?: ReportWave["approval"];
  /** The set digest its gate decided on. */
  digest?: string | null;
  /** The command that approves it, while it waits. */
  command?: string;
  /** Its report's directory under the project (`<yyyy>/<mm>/<commit>/tf-apply-wave-<k>`). */
  report?: string;
  /** A wave split across jobs (`waves.jobs`): how many shares apply it, and the ones that applied. It is applied once every share has. */
  shares?: number;
  shares_applied?: number[];
  updated?: string;
}

export interface RunView {
  schema: typeof RUN_SCHEMA;
  project: string;
  commit: string;
  updated: string;
  /** Each root, its wave, and the roots whose state it reads. */
  roots: { root: string; wave: number; reads: string[] }[];
  waves: RunWave[];
}

/** The run view's key: `<prefix>/<project>/runs/<commit>/`. */
export const runViewKey = (project: string, commit: string, prefix = ""): string =>
  [prefix, project, "runs", commit].map((p) => p.replace(/^\/+|\/+$/g, "")).filter(Boolean).join("/");

/** The view as the waves and their reads stand, every wave not started. */
export function runSkeleton(project: string, commit: string, waves: readonly string[][], reads: ReadonlyMap<string, ReadonlySet<string>>): RunView {
  const waveOf = new Map(waves.flatMap((w, i) => w.map((r) => [r, i + 1] as const)));
  return {
    schema: RUN_SCHEMA,
    project,
    commit,
    updated: "",
    roots: waves.flatMap((w, i) => [...w].sort().map((root) => ({ root, wave: i + 1, reads: [...(reads.get(root) ?? [])].filter((u) => waveOf.has(u)).sort() }))),
    waves: waves.map((roots, i) => {
      const number = i + 1;
      const from = [...new Set(roots.flatMap((r) => [...(reads.get(r) ?? [])]).map((u) => waveOf.get(u)).filter((n): n is number => n !== undefined && n !== number))].sort((a, b) => a - b);
      return { number, roots: [...roots].sort(), reads: from, state: "not-started", gate: `wave-${number}` };
    }),
  };
}

/**
 * The view with one wave's row replaced. The skeleton gives the waves and
 * roots as this job knows them; every other wave keeps the row a job wrote,
 * read from `existing`.
 */
export function withWave(existing: string | undefined, skeleton: RunView, wave: Partial<RunWave> & { number: number }, now: string): RunView {
  let before: RunView | undefined;
  try {
    const parsed = existing ? (JSON.parse(existing) as RunView) : undefined;
    if (parsed?.schema === RUN_SCHEMA && Array.isArray(parsed.waves)) before = parsed;
  } catch {
    before = undefined;
  }
  const rows = new Map((before?.waves ?? []).map((w) => [w.number, w]));
  const merge = (w: RunWave, kept: RunWave | undefined): RunWave => {
    const next: RunWave = { ...w, ...(kept ?? {}), ...wave, roots: w.roots, reads: w.reads, updated: now };
    if (wave.shares_applied) {
      // A share that applied adds itself; the wave is applied once every share has, and a failed or refused share keeps that state.
      next.shares_applied = [...new Set([...(kept?.shares_applied ?? []), ...wave.shares_applied])].sort((a, b) => a - b);
      const shares = next.shares ?? kept?.shares;
      const settled = kept?.state === "failed" || kept?.state === "refused";
      next.state = settled ? kept!.state : shares !== undefined && next.shares_applied.length >= shares ? "applied" : "applying";
    }
    return next;
  };
  const waves = skeleton.waves.map((w) => {
    if (w.number === wave.number) return merge(w, rows.get(w.number));
    const kept = rows.get(w.number);
    return kept ? { ...w, ...kept, roots: w.roots, reads: w.reads } : w;
  });
  // A wave past the ones this job knows (a Terragrunt repo that grew a layer) keeps its row.
  for (const [n, w] of rows) if (!waves.some((x) => x.number === n)) waves.push(w);
  if (!waves.some((w) => w.number === wave.number)) waves.push({ roots: [], reads: [], state: "not-started", gate: `wave-${wave.number}`, ...wave, updated: now });
  waves.sort((a, b) => a.number - b.number);
  return { ...skeleton, roots: skeleton.roots.length ? skeleton.roots : before?.roots ?? [], waves, updated: now };
}

const STATE_TEXT: Record<RunWave["state"], string> = {
  "not-started": "not started",
  planned: "planned",
  waiting: "waiting for an approval",
  applying: "applying",
  applied: "applied",
  refused: "refused",
  failed: "failed",
};

/** The run view as one self-contained page: the waves left to right, each root with the roots it reads. */
export function renderRunHtml(view: RunView): string {
  const rootsOf = new Map<number, RunView["roots"]>();
  for (const r of view.roots) rootsOf.set(r.wave, [...(rootsOf.get(r.wave) ?? []), r]);
  const columns = view.waves.map((w) => {
    const roots = rootsOf.get(w.number) ?? w.roots.map((root) => ({ root, wave: w.number, reads: [] }));
    const gate = [`gate <code>${esc(w.gate)}</code>`, w.policy ? esc(w.policy) : "", w.approval && w.approval !== "not-requested" ? esc(w.approval) : ""].filter(Boolean).join(", ");
    const digest = w.digest ? `<div class="digest"><code>${esc(w.digest)}</code></div>` : "";
    const command = w.command && w.state === "waiting" ? `<div><code>${esc(w.command)}</code></div>` : "";
    const report = w.report ? `<div><a href="../../${esc(w.report)}/report.html">report</a></div>` : "";
    const list = roots.map((r) => `<li><code>${esc(r.root)}</code>${r.reads.length ? `<div class="reads">reads ${r.reads.map((u) => `<code>${esc(u)}</code>`).join(", ")}</div>` : ""}</li>`).join("");
    return `<section class="wave" data-wave="${w.number}" data-state="${esc(w.state)}"><h2>Wave ${w.number}</h2><p class="state s-${esc(w.state)}">${esc(STATE_TEXT[w.state] ?? w.state)}</p><p>${gate}</p>${w.reads.length ? `<p>after wave ${w.reads.join(", ")}</p>` : ""}${digest}${command}${report}<ul>${list}</ul></section>`;
  });
  const title = `${view.project}: apply of ${view.commit.slice(0, 12)}`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark">
<title>${esc(title)}</title>
${TACO_ICON}
<style>${TACO_CSS}:root{--bg:#fbfbfa;--fg:#1d1d1b;--line:#deded8;--link:#1f5fbf;--ok:#2e7d32;--wait:#9a6700;--bad:#c62828}@media (prefers-color-scheme:dark){:root{--bg:#141413;--fg:#ecece8;--line:#34342f;--link:#8ab4ff;--ok:#81c784;--wait:#e3b341;--bad:#ef9a9a}}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,sans-serif}main{max-width:1100px;margin:0 auto;padding:16px}a{color:var(--link)}code{font:12.5px ui-monospace,Menlo,monospace;overflow-wrap:anywhere}
.waves{display:flex;flex-wrap:wrap;gap:12px;align-items:flex-start}.wave{flex:1 1 220px;border:1px solid var(--line);border-radius:6px;padding:8px 12px}.wave h2{font-size:15px;margin:0}.wave p{margin:4px 0}.wave ul{padding-left:18px;margin:6px 0}.reads{font-size:12.5px;opacity:.85}
.state{font-weight:600}.s-applied{color:var(--ok)}.s-waiting,.s-applying{color:var(--wait)}.s-refused,.s-failed{color:var(--bad)}.digest{font-size:12px}</style>
</head><body><main><h1 class="brand">${TACO_IMG}${esc(title)}</h1><p>Each wave applies after the waves it reads, behind its own gate. Updated ${esc(view.updated)}.</p>
<div class="waves">
${columns.join("\n")}
</div>
<script type="application/json" id="terragucci-run">
${JSON.stringify(view).replace(/<\//g, "<\\/").replace(/<!--/g, "<\\u0021--")}
</script>
</main></body></html>
`;
}

/** Replace one wave's row in the bucket's run view and rewrite its page. Returns the key written. */
export async function updateRunView(store: ObjectStore, prefix: string | undefined, skeleton: RunView, wave: Partial<RunWave> & { number: number }, now = new Date().toISOString(), wait?: Wait): Promise<string> {
  const at = runViewKey(skeleton.project, skeleton.commit, prefix);
  const { value } = await updateJson(store, `${at}/run.json`, (body) => withWave(body, skeleton, wave, now), `wave ${wave.number}'s row`, wait);
  await store.put(`${at}/run.html`, renderRunHtml(value), "text/html; charset=utf-8");
  return `${at}/run.html`;
}
