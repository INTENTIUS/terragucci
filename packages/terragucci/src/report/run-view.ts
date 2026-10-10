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
import { progressCounts, type ProgressStatus, type WaveProgress } from "../apply-progress";
import { blastRadius, GRAPH_CSS, phaseTotals, renderGraphSvg, renderTimelineSvg, span, type Span } from "./graph";
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
  /** The roots whose plan in this wave changes something: where a blast radius starts. */
  changed?: string[];
  /** Its time: each plan, each wait at the gate (no `end` while it waits) and each apply, oldest first. */
  spans?: Span[];
  /** A choudoufu wave's resources, done, in flight or waiting, as its estates' records stood at the last read (../apply-progress.ts). */
  progress?: WaveProgress;
  updated?: string;
}

/** A state as a backend block or a `terraform_remote_state` block names it. */
export interface RunState {
  bucket?: string;
  key: string;
}

/** A root in the run view. */
export interface RunRoot {
  root: string;
  wave: number;
  /** The roots of the project whose state it reads. */
  reads: string[];
  /** The state its backend block names, which a root of another project may read; under choudoufu its estate's records (estateRecords in ../detect.ts). */
  state?: RunState;
  /** Its `terraform_remote_state` reads (under choudoufu, `terraform_estate_outputs` reads) of a state no root of the project holds: another project's, when the estate page finds it. */
  external?: (RunState & { data: string })[];
}

/** How many spans a wave keeps, newest last. */
export const SPANS_KEPT = 24;

export interface RunView {
  schema: typeof RUN_SCHEMA;
  project: string;
  commit: string;
  updated: string;
  /** Each root, its wave, and the roots whose state it reads. */
  roots: RunRoot[];
  waves: RunWave[];
}

/** The run view's key: `<prefix>/<project>/runs/<commit>/`. */
export const runViewKey = (project: string, commit: string, prefix = ""): string =>
  [prefix, project, "runs", commit].map((p) => p.replace(/^\/+|\/+$/g, "")).filter(Boolean).join("/");

/** The view as the waves and their reads stand, every wave not started. `states`: each root's own state and its reads of states outside the project. */
export function runSkeleton(
  project: string,
  commit: string,
  waves: readonly string[][],
  reads: ReadonlyMap<string, ReadonlySet<string>>,
  states: ReadonlyMap<string, { state?: RunState; external: (RunState & { data: string })[] }> = new Map(),
): RunView {
  const waveOf = new Map(waves.flatMap((w, i) => w.map((r) => [r, i + 1] as const)));
  return {
    schema: RUN_SCHEMA,
    project,
    commit,
    updated: "",
    roots: waves.flatMap((w, i) =>
      [...w].sort().map((root) => {
        const s = states.get(root);
        return {
          root,
          wave: i + 1,
          reads: [...(reads.get(root) ?? [])].filter((u) => waveOf.has(u)).sort(),
          ...(s?.state ? { state: s.state } : {}),
          ...(s?.external.length ? { external: s.external } : {}),
        };
      }),
    ),
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
    if (wave.spans || kept?.spans) next.spans = mergeSpans(kept?.spans ?? [], wave.spans ?? []);
    if (wave.changed || kept?.changed) next.changed = [...new Set([...(kept?.changed ?? []), ...(wave.changed ?? [])])].sort();
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

/**
 * A wave's spans with a job's added: a span of the same phase, start and
 * share is the same span, written again as it moved on (an apply that ended,
 * a wait that an approval closed), so the new one replaces it.
 */
export function mergeSpans(kept: readonly Span[], added: readonly Span[]): Span[] {
  const id = (s: Span): string => `${s.phase}|${s.start}|${s.share ?? ""}`;
  const out = new Map(kept.map((s) => [id(s), s]));
  for (const s of added) out.set(id(s), s);
  return [...out.values()].sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0)).slice(-SPANS_KEPT);
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

/** The run's blast radius: the roots its waves' plans change, and every root of the project that reads their state, followed through. */
export function runBlast(view: RunView): ReturnType<typeof blastRadius> {
  const changed = view.waves.flatMap((w) => w.changed ?? []);
  return blastRadius(new Map(view.roots.map((r) => [r.root, r.reads])), changed, { waveOf: new Map(view.roots.map((r) => [r.root, r.wave])) });
}

/** The blast radius section: what changes, and what reads it. */
function blastSection(view: RunView): string {
  if (!view.waves.some((w) => w.changed !== undefined)) return `<p class="none">No wave has planned yet, so the roots this apply changes are not known.</p>`;
  const b = runBlast(view);
  if (b.roots.length === 0) return `<p id="blast" data-roots="0" data-downstream="0">No plan of this apply changes a root.</p>`;
  const changed = b.roots.map((r) => `<li class="changed" data-root="${esc(r)}"><code>${esc(r)}</code></li>`).join("");
  const down = b.downstream
    .map((d) => `<li class="downstream" data-root="${esc(d.root)}" data-depth="${d.depth}"><code>${esc(d.root)}</code>${d.wave !== undefined ? `, wave ${d.wave}` : ""}: reads ${d.reads.map((u) => `<code>${esc(u)}</code>`).join(", ")}</li>`)
    .join("");
  return `<div id="blast" data-roots="${b.roots.length}" data-downstream="${b.downstream.length}"><p>${b.roots.length} ${b.roots.length === 1 ? "root changes" : "roots change"}; ${b.downstream.length === 0 ? "no other root reads their state." : `${b.downstream.length} downstream ${b.downstream.length === 1 ? "root reads" : "roots read"} their state, and plan on what they apply.`}</p><ul>${changed}</ul>${down ? `<p>Downstream:</p><ul>${down}</ul>` : ""}</div>`;
}

/** The timeline section: the picture, and each wave's time in each phase as text. */
function timelineSection(view: RunView): string {
  const svg = renderTimelineSvg(view.waves, view.updated);
  if (!svg) return `<p class="none">No wave has a recorded time yet.</p>`;
  const rows = view.waves.map((w) => {
    const t = phaseTotals(w.spans ?? [], view.updated);
    const cell = (n: number | undefined): string => (n === undefined ? "" : esc(span(n)));
    return `<tr data-wave="${w.number}"><td>${w.number}</td><td>${cell(t.plan)}</td><td>${cell(t.gate)}${t.waiting ? " (waiting)" : ""}</td><td>${cell(t.apply)}</td></tr>`;
  });
  return `<p class="legend"><span class="plan"></span>plan<span class="gate"></span>gate wait<span class="apply"></span>apply</p><div class="graphwrap">${svg}</div>
<table class="times"><tr><th>Wave</th><th>Plan</th><th>Gate wait</th><th>Apply</th></tr>${rows.join("")}</table>`;
}

const PROGRESS_TEXT: Record<ProgressStatus, string> = { done: "done", "in-flight": "in flight", waiting: "waiting", "not-applied": "not applied" };
const PROGRESS_ORDER: ProgressStatus[] = ["done", "in-flight", "waiting", "not-applied"];

/** A wave's resources: a bar of done, in flight and waiting, then each resource with its status. */
export function progressSection(p: WaveProgress): string {
  const c = progressCounts(p);
  const total = p.resources.length;
  const bar = PROGRESS_ORDER.filter((s) => c[s] > 0)
    .map((s) => `<span class="p-${s}" style="flex:${c[s]}" title="${c[s]} ${PROGRESS_TEXT[s]}"></span>`)
    .join("");
  const counts = PROGRESS_ORDER.filter((s) => c[s] > 0 || s !== "not-applied").map((s) => `${c[s]} ${PROGRESS_TEXT[s]}`).join(", ");
  const roots = new Set(p.resources.map((r) => r.root)).size;
  const items = p.resources
    .map((r) => `<li data-status="${r.status}" data-address="${esc(r.address)}"><span class="dot p-${r.status}"></span><code>${esc(roots > 1 ? `${r.root}: ${r.address}` : r.address)}</code> ${esc(PROGRESS_TEXT[r.status])}${r.action !== "update" ? ` <small>${esc(r.action)}</small>` : ""}</li>`)
    .join("");
  return `<div class="progress" data-done="${c.done}" data-in-flight="${c["in-flight"]}" data-waiting="${c.waiting}" data-total="${total}"><div class="pbar">${bar}</div><p>${c.done} of ${total} resources done: ${esc(counts)}. Read <time datetime="${esc(p.read)}">${esc(p.read)}</time>.</p><ul class="res">${items}</ul></div>`;
}

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
    return `<section class="wave" data-wave="${w.number}" data-state="${esc(w.state)}"><h2>Wave ${w.number}</h2><p class="state s-${esc(w.state)}">${esc(STATE_TEXT[w.state] ?? w.state)}</p><p>${gate}</p>${w.reads.length ? `<p>after wave ${w.reads.join(", ")}</p>` : ""}${digest}${command}${report}${w.progress ? progressSection(w.progress) : ""}<ul>${list}</ul></section>`;
  });
  const title = `${view.project}: apply of ${view.commit.slice(0, 12)}`;
  const blast = runBlast(view);
  const changed = new Set(blast.roots);
  const downstream = new Set(blast.downstream.map((d) => d.root));
  const graph = renderGraphSvg(
    [{ project: view.project, roots: view.roots.map((r) => ({ root: r.root, wave: r.wave })) }],
    view.roots.flatMap((r) => r.reads.map((u) => ({ from: { project: view.project, root: u }, to: { project: view.project, root: r.root } }))),
    (_, root) => (changed.has(root) ? "changed" : downstream.has(root) ? "downstream" : undefined),
  );
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark">
<title>${esc(title)}</title>${view.waves.some((w) => w.state === "applying") ? `\n<meta http-equiv="refresh" content="15">` : ""}
${TACO_ICON}
<style>${TACO_CSS}${GRAPH_CSS}:root{--bg:#fbfbfa;--fg:#1d1d1b;--line:#deded8;--link:#1f5fbf;--ok:#2e7d32;--wait:#9a6700;--bad:#c62828}@media (prefers-color-scheme:dark){:root{--bg:#141413;--fg:#ecece8;--line:#34342f;--link:#8ab4ff;--ok:#81c784;--wait:#e3b341;--bad:#ef9a9a}}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,sans-serif}main{max-width:1100px;margin:0 auto;padding:16px}a{color:var(--link)}code{font:12.5px ui-monospace,Menlo,monospace;overflow-wrap:anywhere}h2.part{font-size:16px;margin:24px 0 8px}
.waves{display:flex;flex-wrap:wrap;gap:12px;align-items:flex-start}.wave{flex:1 1 220px;border:1px solid var(--line);border-radius:6px;padding:8px 12px}.wave h2{font-size:15px;margin:0}.wave p{margin:4px 0}.wave ul{padding-left:18px;margin:6px 0}.reads{font-size:12.5px;opacity:.85}
.state{font-weight:600}.s-applied{color:var(--ok)}.s-waiting,.s-applying{color:var(--wait)}.s-refused,.s-failed{color:var(--bad)}.digest{font-size:12px}.none{opacity:.7}
.pbar{display:flex;height:8px;border-radius:4px;overflow:hidden;background:var(--line);margin:6px 0}.p-done{background:var(--ok)}.p-in-flight{background:var(--wait)}.p-waiting{background:var(--line)}.p-not-applied{background:var(--bad)}
ul.res{list-style:none;padding-left:0}ul.res li{margin:2px 0}.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;outline:1px solid var(--line)}
table.times{border-collapse:collapse}table.times td,table.times th{border-bottom:1px solid var(--line);padding:4px 16px 4px 0;text-align:left}</style>
</head><body><main><h1 class="brand">${TACO_IMG}${esc(title)}</h1><p>Each wave applies after the waves it reads, behind its own gate. Updated ${esc(view.updated)}.</p>
<div class="waves">
${columns.join("\n")}
</div>
<h2 class="part" id="blast-radius">Blast radius</h2>
${blastSection(view)}
${graph ? `<p class="legend"><span class="changed"></span>changes<span class="downstream"></span>reads a changed root's state</p><div class="graphwrap">${graph}</div>` : ""}
<h2 class="part" id="timeline">Timeline</h2>
${timelineSection(view)}
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
