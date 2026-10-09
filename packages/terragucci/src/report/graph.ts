/**
 * The pictures the static pages draw, as inline SVG with no script: the
 * dependency graph of roots and waves (the estate page and the run view), a
 * change's blast radius, and a run's timeline of each wave's plan, gate wait
 * and apply. Colors come from the page's CSS variables, so light and dark
 * both read.
 */
import { esc } from "./html";

/** A change's blast radius: the roots whose plan changes something, and every root that reads their state, followed through. */
export interface Blast {
  roots: string[];
  /** Nearest first. `reads`: the roots in the radius whose state it reads. `depth`: 1 when it reads a changed root itself. */
  downstream: { root: string; reads: string[]; depth: number; wave?: number; planned?: boolean }[];
}

/**
 * The blast radius of `changed` over `reads` (each root, the roots whose
 * state it reads). With `waveOf` each downstream root carries its wave; with
 * `planned`, whether this run planned it.
 */
export function blastRadius(reads: ReadonlyMap<string, Iterable<string>>, changed: Iterable<string>, opts: { waveOf?: ReadonlyMap<string, number>; planned?: ReadonlySet<string> } = {}): Blast {
  const roots = [...new Set(changed)].sort();
  const depth = new Map<string, number>(roots.map((r) => [r, 0]));
  const upstreams = new Map([...reads].map(([r, ups]) => [r, [...ups]]));
  for (let d = 1, grew = true; grew; d++) {
    grew = false;
    for (const [root, ups] of upstreams) {
      if (depth.has(root)) continue;
      if (ups.some((u) => (depth.get(u) ?? Infinity) < d)) {
        depth.set(root, d);
        grew = true;
      }
    }
  }
  const downstream = [...depth]
    .filter(([, d]) => d > 0)
    .sort(([a, x], [b, y]) => x - y || (a < b ? -1 : a > b ? 1 : 0))
    .map(([root, d]) => {
      const wave = opts.waveOf?.get(root);
      return {
        root,
        reads: (upstreams.get(root) ?? []).filter((u) => depth.has(u)).sort(),
        depth: d,
        ...(wave !== undefined ? { wave } : {}),
        ...(opts.planned ? { planned: opts.planned.has(root) } : {}),
      };
    });
  return { roots, downstream };
}

/** One project's roots for the graph, by wave. */
export interface GraphProject {
  project: string;
  /** Where the project's page is, when the picture links it. */
  href?: string;
  roots: { root: string; wave: number }[];
}

/** An edge: `to` reads the state of `from`. */
export interface GraphEdge {
  from: { project: string; root: string };
  to: { project: string; root: string };
}

const NODE_W = 200;
const NODE_H = 24;
const GAP_X = 72;
const GAP_Y = 8;
const BAND_HEAD = 30;
const BAND_GAP = 18;
const PAD = 12;

/** A label that fits its box: the end of a long root path, which tells roots apart better than its start. */
function fit(text: string, max = 28): string {
  return text.length <= max ? text : `...${text.slice(text.length - max + 3)}`;
}

const nodeId = (project: string, root: string): string => `${project}\u0000${root}`;

/**
 * The dependency graph: a band per project, its waves left to right and each
 * wave's roots top to bottom, an arrow from each root to the roots that read
 * its state. An arrow between projects is dashed. `mark` classes a node (the
 * run view marks a blast radius with it).
 */
export function renderGraphSvg(projects: readonly GraphProject[], edges: readonly GraphEdge[], mark: (project: string, root: string) => string | undefined = () => undefined): string {
  const shown = projects.filter((p) => p.roots.length > 0);
  if (shown.length === 0) return "";
  const pos = new Map<string, { x: number; y: number }>();
  const bands: string[] = [];
  const nodes: string[] = [];
  let y = PAD;
  let width = 0;
  for (const p of shown) {
    const waves = [...new Set(p.roots.map((r) => r.wave))].sort((a, b) => a - b);
    const col = new Map(waves.map((w, i) => [w, i]));
    const rows = new Map<number, number>();
    const top = y + BAND_HEAD;
    for (const r of [...p.roots].sort((a, b) => a.wave - b.wave || (a.root < b.root ? -1 : 1))) {
      const c = col.get(r.wave)!;
      const n = rows.get(r.wave) ?? 0;
      rows.set(r.wave, n + 1);
      const x = PAD + c * (NODE_W + GAP_X);
      const ny = top + 18 + n * (NODE_H + GAP_Y);
      pos.set(nodeId(p.project, r.root), { x, y: ny });
      const cls = mark(p.project, r.root);
      nodes.push(`<g class="node${cls ? ` ${cls}` : ""}" data-project="${esc(p.project)}" data-root="${esc(r.root)}" data-wave="${r.wave}"><title>${esc(`${p.project}: ${r.root}, wave ${r.wave}`)}</title><rect x="${x}" y="${ny}" width="${NODE_W}" height="${NODE_H}" rx="4"/><text x="${x + 8}" y="${ny + 16}">${esc(fit(r.root))}</text></g>`);
    }
    const tall = Math.max(...rows.values());
    const bottom = top + 18 + tall * (NODE_H + GAP_Y);
    const right = PAD + waves.length * (NODE_W + GAP_X) - GAP_X;
    width = Math.max(width, right + PAD);
    const heads = waves.map((w, i) => `<text class="wave" x="${PAD + i * (NODE_W + GAP_X)}" y="${top + 10}">wave ${w}</text>`).join("");
    const name = p.href ? `<a href="${esc(p.href)}"><text class="project" x="${PAD}" y="${y + 18}">${esc(p.project)}</text></a>` : `<text class="project" x="${PAD}" y="${y + 18}">${esc(p.project)}</text>`;
    bands.push(`<g class="band" data-project="${esc(p.project)}"><rect class="band" x="${PAD / 2}" y="${y}" width="0" height="${bottom - y}" rx="6"/>${name}${heads}</g>`);
    y = bottom + BAND_GAP;
  }
  const height = y - BAND_GAP + PAD;
  // The bands' boxes span the widest band.
  const banded = bands.map((b) => b.replace('width="0"', `width="${width - PAD}"`));
  const arrows = edges.flatMap((e) => {
    const a = pos.get(nodeId(e.from.project, e.from.root));
    const b = pos.get(nodeId(e.to.project, e.to.root));
    if (!a || !b) return [];
    const cross = e.from.project !== e.to.project;
    const x1 = a.x + NODE_W;
    const y1 = a.y + NODE_H / 2;
    // A reader to the right is entered on its left; one in the same or an earlier column, from another project, on its right.
    const forward = b.x > a.x;
    const x2 = forward ? b.x : b.x + NODE_W;
    const y2 = b.y + NODE_H / 2;
    const bend = forward ? Math.max(30, (x2 - x1) / 2) : 60;
    const c2 = forward ? x2 - bend : x2 + bend;
    const d = `M${x1},${y1} C${x1 + bend},${y1} ${c2},${y2} ${x2},${y2}`;
    return [`<path class="edge${cross ? " cross" : ""}" data-from="${esc(`${e.from.project} ${e.from.root}`)}" data-to="${esc(`${e.to.project} ${e.to.root}`)}" d="${d}" marker-end="url(#arrow)"/>`];
  });
  return `<svg class="graph" xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Each project's roots by wave, and an arrow from each root to the roots that read its state">
<defs><marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L8,4 L0,8 z" class="arrowhead"/></marker></defs>
${banded.join("\n")}
${arrows.join("\n")}
${nodes.join("\n")}
</svg>`;
}

/** CSS for the graph and the timeline, on the page's variables (`--fg`, `--line`, `--link`, `--bg`). */
export const GRAPH_CSS =
  ".graphwrap{overflow-x:auto;border:1px solid var(--line);border-radius:6px;margin:8px 0}svg.graph,svg.timeline{display:block;font:12px ui-monospace,Menlo,monospace}" +
  "svg.graph rect.band{fill:none;stroke:var(--line)}svg.graph .project{font:600 13px system-ui,sans-serif;fill:var(--fg)}svg.graph a .project{fill:var(--link)}svg.graph .wave{fill:var(--fg);opacity:.6}" +
  "svg.graph .node rect{fill:var(--bg);stroke:var(--fg);stroke-opacity:.45}svg.graph .node text{fill:var(--fg)}svg.graph .node.changed rect{stroke:#c62828;stroke-width:2;stroke-opacity:1}svg.graph .node.downstream rect{stroke:#b26a00;stroke-width:2;stroke-dasharray:4 2;stroke-opacity:1}" +
  "svg.graph .edge{fill:none;stroke:var(--fg);stroke-opacity:.5;stroke-width:1.3}svg.graph .edge.cross{stroke:var(--link);stroke-opacity:.9;stroke-dasharray:5 3}svg.graph .arrowhead{fill:var(--fg);fill-opacity:.6}" +
  "svg.timeline .axis{stroke:var(--line)}svg.timeline text{fill:var(--fg)}svg.timeline .tick{opacity:.6}svg.timeline .span.plan{fill:#3d7bd9}svg.timeline .span.gate{fill:#d29a1e}svg.timeline .span.gate.open{fill-opacity:.45}svg.timeline .span.apply{fill:#2e9a4a}" +
  ".legend span{display:inline-block;width:10px;height:10px;border-radius:2px;margin:0 4px 0 12px;vertical-align:-1px}.legend .plan{background:#3d7bd9}.legend .gate{background:#d29a1e}.legend .apply{background:#2e9a4a}.legend .changed{border:2px solid #c62828}.legend .downstream{border:2px dashed #b26a00}";

/** One span of a wave's time: its plan, its wait at the gate (open while it waits), or its apply. */
export interface Span {
  phase: "plan" | "gate" | "apply";
  start: string;
  end?: string;
  /** The share of a wave split across jobs that planned or applied. */
  share?: number;
}

const ms = (iso: string): number => Date.parse(iso);

/** "1h 5m", "4m 10s", "12s". */
export function span(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

const PHASE_TEXT: Record<Span["phase"], string> = { plan: "plan", gate: "gate wait", apply: "apply" };

/**
 * The run's timeline: a row per wave, its spans on one time axis from the
 * first start to `until` (when the view was last written), which ends a
 * span still open. Empty when no wave has a span.
 */
export function renderTimelineSvg(waves: readonly { number: number; spans?: Span[] }[], until: string): string {
  const rows = waves.filter((w) => w.spans && w.spans.some((s) => !Number.isNaN(ms(s.start))));
  if (rows.length === 0) return "";
  const all = rows.flatMap((w) => w.spans!).filter((s) => !Number.isNaN(ms(s.start)));
  const t0 = Math.min(...all.map((s) => ms(s.start)));
  const endOf = (s: Span): number => (s.end && !Number.isNaN(ms(s.end)) ? ms(s.end) : Number.isNaN(ms(until)) ? ms(s.start) : Math.max(ms(s.start), ms(until)));
  const t1 = Math.max(t0 + 1000, ...all.map(endOf));
  const left = 70;
  const plot = 760;
  const rowH = 26;
  const top = 8;
  const width = left + plot + 20;
  const height = top + rows.length * rowH + 30;
  const x = (t: number): number => left + ((t - t0) / (t1 - t0)) * plot;
  const bars = rows.map((w, i) => {
    const y = top + i * rowH;
    const spans = w.spans!
      .filter((s) => !Number.isNaN(ms(s.start)))
      .map((s) => {
        const a = x(ms(s.start));
        const b = Math.max(a + 2, x(endOf(s)));
        const open = s.end === undefined;
        const what = `wave ${w.number}${s.share !== undefined ? `, share ${s.share}` : ""}: ${PHASE_TEXT[s.phase]} ${span((endOf(s) - ms(s.start)) / 1000)}${open ? (s.phase === "gate" ? ", still waiting" : ", still running") : ""}, from ${s.start}`;
        return `<rect class="span ${s.phase}${open ? " open" : ""}" data-phase="${s.phase}"${open ? " data-open" : ""} x="${a.toFixed(1)}" y="${y + 4}" width="${(b - a).toFixed(1)}" height="${rowH - 8}" rx="2"><title>${esc(what)}</title></rect>`;
      });
    return `<g class="row" data-wave="${w.number}"><text x="4" y="${y + rowH / 2 + 4}">wave ${w.number}</text>${spans.join("")}</g>`;
  });
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => {
    const t = t0 + f * (t1 - t0);
    const tx = left + f * plot;
    return `<line class="axis" x1="${tx}" y1="${top}" x2="${tx}" y2="${height - 24}"/><text class="tick" x="${tx}" y="${height - 8}" text-anchor="${f === 0 ? "start" : f === 1 ? "end" : "middle"}">${f === 0 ? esc(new Date(t).toISOString().slice(11, 19)) : `+${esc(span((t - t0) / 1000))}`}</text>`;
  });
  return `<svg class="timeline" xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Each wave's plan, gate wait and apply over time">
${ticks.join("")}
${bars.join("\n")}
</svg>`;
}

/** Each wave's time in each phase, summed, for the table under the timeline. */
export function phaseTotals(spans: readonly Span[], until: string): { plan?: number; gate?: number; apply?: number; waiting: boolean } {
  const out: { plan?: number; gate?: number; apply?: number; waiting: boolean } = { waiting: false };
  for (const s of spans) {
    const a = ms(s.start);
    if (Number.isNaN(a)) continue;
    const b = s.end ? ms(s.end) : ms(until);
    if (s.end === undefined && s.phase === "gate") out.waiting = true;
    if (Number.isNaN(b)) continue;
    out[s.phase] = (out[s.phase] ?? 0) + Math.max(0, (b - a) / 1000);
  }
  return out;
}
