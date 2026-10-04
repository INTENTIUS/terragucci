/**
 * The HTML report: one self-contained file, no network calls, light and
 * dark. It is rendered from the report JSON alone, and carries that JSON
 * inline as `<script type="application/json" id="terragucci-report">`, on
 * lines of its own, so a script handed only the HTML still gets the data.
 *
 * The page opens on what a reviewer looks for. Destroys, replacements and
 * refusals are pinned above the filters, and the roots and changes that need
 * reading on their own are listed next. Every group, root and named change
 * links to its root's full plan and to the CI job that produced it.
 */
import { groupAnchor, rootAnchor } from "./build";
import type { Report, ReportChange, ReportGroup, ReportNamed, ReportRoot } from "./schema";

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** The report JSON, safe inside a script element: `</` and `<!--` cannot end or open anything. */
export function inlineJson(report: Report): string {
  return JSON.stringify(report).replace(/<\//g, "<\\/").replace(/<!--/g, "<\\u0021--");
}

/** The report JSON from an HTML report, found by its script tag alone. */
export function readInlineReport(html: string): Report {
  const open = html.indexOf('id="terragucci-report"');
  if (open < 0) throw new Error("no terragucci-report script in this HTML");
  const start = html.indexOf(">", open) + 1;
  const end = html.indexOf("</script>", start);
  return JSON.parse(html.slice(start, end)) as Report;
}

const SYMBOL: Record<string, string> = { create: "+", update: "~", replace: "-/+", delete: "-", read: "<=", forget: "forget", "no-op": " ", import: "import", refused: "!" };

function value(v: unknown): string {
  const s = typeof v === "string" ? JSON.stringify(v) : JSON.stringify(v) ?? "null";
  return s.length > 160 ? `${s.slice(0, 157)}...` : s;
}

function planLinks(r: Pick<ReportRoot, "plan" | "job_url">): string {
  const out: string[] = [];
  if (r.plan.text) out.push(`<a href="${esc(r.plan.text)}">plan</a>`);
  if (r.plan.json) out.push(`<a href="${esc(r.plan.json)}">plan.json</a>`);
  if (r.job_url) out.push(`<a href="${esc(r.job_url)}">job</a>`);
  return out.length ? `<span class="links">${out.join(" ")}</span>` : "";
}

function attrLine(a: ReportChange["attributes"][number], writeOnly: boolean): string {
  let v: string;
  if (a.sensitive) v = "(sensitive)";
  else if (a.unknown) v = `${a.before !== undefined ? `${esc(value(a.before))} -&gt; ` : ""}(known after apply)`;
  else v = `${a.before !== undefined ? `${esc(value(a.before))} -&gt; ` : ""}${a.after !== undefined ? esc(value(a.after)) : "null"}`;
  const tags = [a.forcesReplacement ? '<span class="tag bad">forces replacement</span>' : "", writeOnly ? '<span class="tag">write-only: the value is never in the plan</span>' : ""].join("");
  return `<li><code>${esc(a.path)}</code> ${v} ${tags}</li>`;
}

function changeRow(c: ReportChange): string {
  const action = c.importing !== undefined && c.action === "no-op" ? "import" : c.action;
  const wo = new Set(c.write_only ?? []);
  const why = c.why ? ` <span class="why">${esc(c.why)}</span>` : "";
  const imp = c.importing !== undefined ? ` <span class="tag">imports id ${esc(c.importing)}</span>` : "";
  const attrs = c.attributes.length ? `<ul class="attrs">${c.attributes.map((a) => attrLine(a, wo.has(a.path))).join("")}</ul>` : "";
  return `<li class="change a-${esc(action)}${c.why ? " hl" : ""}" data-action="${esc(action)}"><code class="sym">${esc(SYMBOL[action] ?? action)}</code> <code>${esc(c.address)}${c.deposed !== undefined ? ` (deposed ${esc(c.deposed)})` : ""}</code>${why}${imp}${attrs}</li>`;
}

const KIND_WORD: Record<string, string> = { tags: "tags only", description: "description only", unknown: "known after apply only" };

function rootBlock(r: ReportRoot, wave: number | undefined): string {
  const shown = r.changes.filter((c) => !c.kind);
  const folded = r.changes.filter((c) => c.kind);
  const counts = Object.entries(r.counts).filter(([a]) => a !== "no-op").map(([a, n]) => `${n} ${a}`).join(", ") || "no changes";
  const actions: string[] = [...new Set(r.changes.map((c) => (c.importing !== undefined && c.action === "no-op" ? "import" : c.action)))];
  if (r.status === "failed") actions.push("refused");
  const why = r.why.map((w) => `<span class="why">${esc(w)}</span>`).join(" ");
  let body = `<div class="meta">${planLinks(r)} ${r.group ? `<a href="#${esc(groupAnchor(r.group))}">group ${esc(r.group)}</a>` : ""} ${r.plan_digest ? `<code class="digest">${esc(r.plan_digest)}</code>` : ""}</div>`;
  if (r.error) body += `<pre class="error">${esc(r.error)}</pre>`;
  if (shown.length) body += `<ul class="changes">${shown.map(changeRow).join("")}</ul>`;
  if (folded.length) {
    const kinds = [...new Set(folded.map((c) => KIND_WORD[c.kind!]))].join(", ");
    body += `<details class="minor"><summary>${folded.length} folded: ${esc(kinds)}</summary><ul class="changes">${folded.map(changeRow).join("")}</ul></details>`;
  }
  return `<details class="root" id="${esc(rootAnchor(r.path))}" data-root="${esc(r.path)}" data-group="${esc(r.group ?? "")}" data-actions="${esc(actions.join(" "))}" data-wave="${wave ?? ""}"${r.fold === "open" ? " open" : ""}><summary><code>${esc(r.path)}</code> <span class="counts">${esc(counts)}</span> ${why}</summary>${body}</details>`;
}

function changeLines(g: ReportGroup): string {
  const lines = g.extends ? (g.plus ?? []) : g.changes;
  if (!lines.length) return "";
  const text = lines.map((l) => {
    let t = l.count > 1 ? `${l.line} (x${l.count})` : l.line;
    if (l.differsFrom) t += `  [differs from group ${l.differsFrom}${l.differsIn?.length ? ` in: ${l.differsIn.join(", ")}` : ""}]`;
    return t;
  });
  return `<pre class="diff">${esc(text.join("\n"))}</pre>`;
}

function groupBlock(report: Report, g: ReportGroup, roots: Map<string, ReportRoot>, waveOf: Map<string, number>): string {
  const word = report.unit === "instance" ? "instance" : "root";
  let title = `Group ${g.id}: ${g.units.length} ${word}${g.units.length === 1 ? "" : "s"}`;
  if (g.resource) title += ` of ${g.resource}`;
  if (g.outlier) title += " (outlier)";
  title += g.noChanges ? ", no changes" : g.extends ? `, group ${g.extends}'s change plus` : g.units.length > 1 ? ", identical change" : ", change";
  const members = g.units.map((u) => roots.get(u)).filter((r): r is ReportRoot => r !== undefined);
  const actions = [...new Set([...g.changes, ...(g.plus ?? [])].map((c) => c.action))];
  const waves = [...new Set(g.units.map((u) => waveOf.get(u)).filter((w) => w !== undefined))];
  const why = g.why.map((w) => `<span class="why">${esc(w)}</span>`).join(" ");
  const varies = g.varies.length
    ? `<p class="varies">Differs between its roots: ${g.varies.map((v) => `<code>${esc(v.address)}</code> (${v.paths.map(esc).join(", ")})`).join("; ")}</p>`
    : "";
  const first = members[0];
  const rep = first ? `<p class="meta">One of them in full: <a href="#${esc(rootAnchor(first.path))}"><code>${esc(first.path)}</code></a> ${planLinks(first)}</p>` : "";
  const list = members.length
    ? `<details class="units"><summary>${members.length} ${word}${members.length === 1 ? "" : "s"}</summary><ul>${members.map((r) => `<li><a href="#${esc(rootAnchor(r.path))}"><code>${esc(r.path)}</code></a> ${planLinks(r)}</li>`).join("")}</ul></details>`
    : `<ul>${g.units.map((u) => `<li><code>${esc(u)}</code></li>`).join("")}</ul>`;
  return `<details class="group" id="${esc(groupAnchor(g.id))}" data-group="${esc(g.id)}" data-roots="${esc(g.units.join(" "))}" data-actions="${esc(actions.join(" "))}" data-wave="${esc(waves.join(" "))}"${g.fold === "open" ? " open" : ""}><summary>${esc(title)} ${why}</summary>${changeLines(g)}${varies}${rep}${list}</details>`;
}

const ACTION_WORD: Record<ReportNamed["action"], string> = { delete: "destroy", replace: "replace", refused: "refused to plan", forget: "forget", import: "import" };

function namedRow(n: ReportNamed, roots: Map<string, ReportRoot>): string {
  const r = roots.get(n.root);
  const forced = n.replace_paths?.length ? ` <span class="why">forced by ${n.replace_paths.map((p) => `<code>${esc(p.join("."))}</code>`).join(", ")}</span>` : "";
  const reason = n.reason ? ` <span class="why">${esc(n.reason.split(/\s+/).join(" "))}</span>` : "";
  return `<li class="named a-${esc(n.action)}"><span class="tag ${n.action === "delete" || n.action === "replace" || n.action === "refused" ? "bad" : ""}">${esc(ACTION_WORD[n.action])}</span> <a href="#${esc(rootAnchor(n.root))}"><code>${esc(n.root)}</code></a>${n.address ? ` <code>${esc(n.address)}</code>` : ""}${n.deposed !== undefined ? ` (deposed ${esc(n.deposed)})` : ""}${forced}${reason} ${r ? planLinks(r) : ""}</li>`;
}

const CSS = `
:root{--bg:#fbfbfa;--fg:#1d1d1b;--muted:#6b6b66;--line:#deded8;--card:#fff;--bad:#b42318;--badbg:#fdecea;--hl:#8a5a00;--hlbg:#fff5e0;--link:#1f5fbf;--code:#f1f1ee}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--fg:#ecece8;--muted:#a0a09a;--line:#34342f;--card:#1c1c1a;--bad:#ff8a80;--badbg:#3a1714;--hl:#ffc766;--hlbg:#33270f;--link:#8ab4ff;--code:#262623}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:1100px;margin:0 auto;padding:16px}h1{font-size:20px;margin:0 0 4px}h2{font-size:16px;margin:20px 0 8px}
a{color:var(--link)}code,pre{font:12.5px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace}pre{background:var(--code);padding:8px;overflow-x:auto;margin:6px 0}
.run{color:var(--muted);margin:0 0 8px}.run code{color:var(--fg)}.notice{color:var(--muted);font-size:13px}
details{background:var(--card);border:1px solid var(--line);border-radius:6px;margin:6px 0;padding:6px 10px}details details{margin:6px 0}
summary{cursor:pointer}ul{margin:4px 0;padding-left:20px}.attrs{list-style:none;padding-left:16px}
.why{display:inline-block;background:var(--hlbg);color:var(--hl);border-radius:4px;padding:0 6px;font-size:12px;margin-left:4px}
.tag{display:inline-block;border:1px solid var(--line);border-radius:4px;padding:0 6px;font-size:12px}.tag.bad{background:var(--badbg);color:var(--bad);border-color:transparent}
.pinned{border:2px solid var(--bad);border-radius:8px;padding:8px 12px;background:var(--card)}.pinned h2{margin-top:0;color:var(--bad)}
.first{border:1px solid var(--hl);border-radius:8px;padding:8px 12px;margin-top:10px;background:var(--card)}.first h2{margin-top:0}
.filters{display:flex;flex-wrap:wrap;gap:8px;margin:14px 0 4px;position:sticky;top:0;background:var(--bg);padding:6px 0;z-index:1}
.filters label{display:flex;gap:4px;align-items:center}select,input{background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:4px;padding:3px 6px;font:inherit}
.counts,.meta{color:var(--muted)}.links a{margin-right:6px}.digest{color:var(--muted);font-size:11px}.sym{display:inline-block;min-width:3ch}
.a-delete .sym,.a-replace .sym{color:var(--bad)}.hidden{display:none}table{border-collapse:collapse}td,th{border-bottom:1px solid var(--line);padding:3px 10px 3px 0;text-align:left}
`;

const JS = `
(function(){
var report=JSON.parse(document.getElementById("terragucci-report").textContent);
function openTo(id){var el=document.getElementById(id);if(!el)return;for(var p=el;p;p=p.parentElement){if(p.tagName==="DETAILS")p.open=true;}el.scrollIntoView();}
function onHash(){if(location.hash.length>1)openTo(decodeURIComponent(location.hash.slice(1)));}
window.addEventListener("hashchange",onHash);onHash();
var f={group:document.getElementById("f-group"),root:document.getElementById("f-root"),action:document.getElementById("f-action"),wave:document.getElementById("f-wave")};
function has(list,v){return (" "+(list||"")+" ").indexOf(" "+v+" ")>=0;}
function apply(){
var g=f.group.value,r=f.root.value.trim(),a=f.action.value,w=f.wave?f.wave.value:"";
document.querySelectorAll(".group").forEach(function(el){
var ok=(!g||el.dataset.group===g)&&(!r||el.dataset.roots.indexOf(r)>=0)&&(!a||has(el.dataset.actions,a))&&(!w||has(el.dataset.wave,w));
el.classList.toggle("hidden",!ok);});
document.querySelectorAll(".root").forEach(function(el){
var ok=(!g||el.dataset.group===g)&&(!r||el.dataset.root.indexOf(r)>=0)&&(!a||has(el.dataset.actions,a))&&(!w||el.dataset.wave===w);
el.classList.toggle("hidden",!ok);});
document.getElementById("shown").textContent=document.querySelectorAll(".root:not(.hidden)").length+" of "+report.roots.length+" roots shown";
}
Object.keys(f).forEach(function(k){if(f[k])f[k].addEventListener("input",apply);});apply();
})();
`;

export function renderHtml(report: Report): string {
  const { run } = report;
  const roots = new Map(report.roots.map((r) => [r.path, r]));
  const waveOf = new Map<string, number>();
  for (const w of report.waves) for (const r of w.roots) waveOf.set(r, w.number);
  const totals = Object.entries(report.totals).filter(([a, n]) => n > 0 && a !== "no-op").map(([a, n]) => `${n} ${a}`).join(", ") || "no changes";
  const title = `${run.project} ${run.stage}${run.wave !== undefined ? ` wave ${run.wave}` : ""} at ${run.commit.slice(0, 12)}`;

  const pinnedNamed = report.named.filter((n) => n.action === "delete" || n.action === "replace" || n.action === "refused");
  const otherNamed = report.named.filter((n) => !pinnedNamed.includes(n));
  const pinned = `<section class="pinned" id="pinned"><h2>Destroys, replacements and refusals (${pinnedNamed.length})</h2>${pinnedNamed.length ? `<ul>${pinnedNamed.map((n) => namedRow(n, roots)).join("")}</ul>` : "<p>None. Nothing in this run destroys, replaces or refuses.</p>"}${otherNamed.length ? `<h2>Imports and forgets (${otherNamed.length})</h2><ul>${otherNamed.map((n) => namedRow(n, roots)).join("")}</ul>` : ""}</section>`;

  const outliers = report.roots.filter((r) => r.why.some((w) => w.startsWith("outlier")));
  const highlighted = report.roots.flatMap((r) => r.highlights.filter((h) => h.action !== "delete" && h.action !== "replace").map((h) => ({ root: r.path, ...h })));
  const firstItems = [
    ...outliers.map((r) => `<li class="outlier"><span class="why">outlier</span> <a href="#${esc(rootAnchor(r.path))}"><code>${esc(r.path)}</code></a> its change matches no other root's ${planLinks(r)}</li>`),
    ...highlighted.map((h) => `<li class="highlight"><span class="why">${esc(h.why)}</span> <a href="#${esc(rootAnchor(h.root))}"><code>${esc(h.root)}</code></a> <code>${esc(h.address)}</code> (${esc(h.action)})</li>`),
  ];
  const first = firstItems.length ? `<section class="first" id="first"><h2>Read these first (${firstItems.length})</h2><ul>${firstItems.join("")}</ul></section>` : "";

  const opt = (v: string, label: string) => `<option value="${esc(v)}">${esc(label)}</option>`;
  const actions: string[] = [...new Set(report.roots.flatMap((r) => r.changes.map((c) => (c.importing !== undefined && c.action === "no-op" ? "import" : c.action))))].sort();
  if (report.roots.some((r) => r.status === "failed")) actions.push("refused");
  const filters = `<form class="filters" onsubmit="return false"><label>Group <select id="f-group">${opt("", "all")}${report.groups.map((g) => opt(g.id, `${g.id} (${g.units.length})`)).join("")}</select></label><label>Root <input id="f-root" placeholder="path contains" size="18"></label><label>Action <select id="f-action">${opt("", "all")}${actions.map((a) => opt(a, a)).join("")}</select></label>${report.waves.length ? `<label>Wave <select id="f-wave">${opt("", "all")}${report.waves.map((w) => opt(String(w.number), String(w.number))).join("")}</select></label>` : ""}<span id="shown" class="counts"></span></form>`;

  const waves = report.waves.length
    ? `<h2>Waves</h2><table><tr><th>Wave</th><th>Roots</th><th>Set digest</th><th>Approval</th><th>Record</th></tr>${report.waves.map((w) => `<tr><td>${w.number}</td><td>${w.roots.length}</td><td><code class="digest">${esc(w.set_digest ?? "none: a root did not plan")}</code></td><td>${esc(w.approval)}</td><td>${w.gate ? `<code>${esc(w.gate.branch)}:${esc(w.gate.path)}</code>` : ""}</td></tr>`).join("")}</table>`
    : "";

  const holes = report.holes.length ? `<h2>Holes (${report.holes.length})</h2><ul>${report.holes.map((h) => `<li><code>${esc(h.root)}: ${esc(h.address)}</code> ${esc(h.reason)}</li>`).join("")}</ul>` : "";

  const li = (s: string): string => `<li>${s}</li>`;
  const later = report.deferred?.length
    ? `<section id="deferred"><h2>Planned later (${report.deferred.length})</h2><ul>${report.deferred.map((d) => li(`<code>${esc(d.unit)}</code> after ${esc(d.after.join(", "))}: ${esc(d.why)}${d.previewed ? " (previewed)" : ""}`)).join("")}${(report.mock_reads ?? []).map((r) => li(`<code>${esc(r.unit)}</code> would read mock_outputs of ${esc(r.upstream)} (${esc(r.reason)})`)).join("")}</ul></section>`
    : "";
  const tips = report.tips
    ? `<section id="tips"><h2>Tips (${report.tips.length})</h2><p class="notice">Advice on how your roots are set up. A tip never fails a run or changes a gate.</p>${report.tips.length ? `<ul>${report.tips.map((t) => `<li><a href="${esc(t.url)}"><code>${esc(t.rule)}</code></a>${t.root ? ` <code>${esc(t.root)}</code>` : ""} ${esc(t.message)}</li>`).join("")}</ul>` : "<p>None.</p>"}</section>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:">
<meta name="color-scheme" content="light dark">
<title>${esc(title)}</title>
<style>${CSS}</style>
</head>
<body>
<main>
<h1>${esc(run.project)}: ${esc(run.stage)}${run.wave !== undefined ? `, wave ${run.wave}` : ""}</h1>
<p class="run">commit <code>${esc(run.commit)}</code>${run.base ? ` against <code>${esc(run.base)}</code>` : ""}, ${esc(run.binary)} on ${esc(run.runtime)}, ${esc(run.started)} to ${esc(run.finished)}${run.job_url ? `, <a href="${esc(run.job_url)}">job</a>` : ""}<br>${report.units} ${report.unit === "instance" ? "instances" : "roots"} in ${report.groups.length} groups: ${esc(totals)}. Change set <code class="digest">${esc(report.change_set)}</code></p>
<p class="notice">Every value a plan marks sensitive is replaced with <code>${esc(report.redaction.marker)}</code> in the stored plans (${report.redaction.values} in this run). Plan digests are taken before that, over the plans as planned.</p>
${pinned}
${first}
${filters}
${waves}
<h2>Groups (${report.groups.length})</h2>
${report.groups.map((g) => groupBlock(report, g, roots, waveOf)).join("\n")}
<h2>Roots (${report.roots.length})</h2>
${report.roots.map((r) => rootBlock(r, waveOf.get(r.path))).join("\n")}
${holes}
${later}${tips}
</main>
<script type="application/json" id="terragucci-report">
${inlineJson(report)}
</script>
<script>${JS}</script>
</body>
</html>
`;
}
