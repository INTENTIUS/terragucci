/**
 * Terragrunt previews: in a pull request, a unit of a later layer is planned
 * on the outputs its upstream's plan in the same run makes, not on the ones
 * the upstream last applied.
 *
 * Terragrunt reads a `dependency` block's outputs by running the binary's
 * `output -json` (`TG_TF_PATH`), either in the upstream's working directory
 * or, when the upstream has a `remote_state` block, in a directory of its own
 * that holds only the backend file Terragrunt wrote for it (observed on
 * 1.1.6). Each wave's `TG_TF_PATH` is a wrapper (servingWrapper) that notes
 * the working directory of every unit it plans, and answers `output -json`
 * for an upstream planned earlier in the run with that plan's outputs: in the
 * upstream's working directory, or in a directory whose one backend file
 * holds every string of the upstream's `remote_state` config, as `terragrunt
 * render --json` prints it. Every other call runs the binary. So Terragrunt
 * evaluates the unit's own HCL, includes and all, on the planned values.
 *
 * Only known values are handed over. A unit that reads a value known only
 * once its upstream applies is not planned at all: it is listed with the
 * value and the wave that settles it, and it plans once that wave applied,
 * as every wave does. Nothing stands in for the value, and the mock check
 * still refuses a plan that would read `mock_outputs`.
 *
 * At the gate, a wave's units are planned again on the state the waves
 * before them left, and compared with the preview the pull request's plan
 * note carries (`notePreviews`, `previewDifferences`, ./tg-preview-gate.ts).
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { anyTrue, plannedOutputs, unknownOutputs, type PlannedOutput } from "./planned-outputs";
import type { ReportChange, ReportRead, ReportRoot } from "./report/schema";

const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
const tick = (s: string): string => `\`${s}\``;

// ── the outputs handed to Terragrunt ─────────────────────────────────────

/** A JSON value's cty type, as `output -json` prints it. A null is typed as a string, which it decodes as. */
export function ctyType(v: unknown): unknown {
  if (typeof v === "string" || v === null || v === undefined) return "string";
  if (typeof v === "number") return "number";
  if (typeof v === "boolean") return "bool";
  if (Array.isArray(v)) return ["tuple", v.map(ctyType)];
  return ["object", Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, ctyType(x)]))];
}

/**
 * What `output -json` prints for an upstream whose plan makes `outputs`: each
 * output known in whole, with its value and type. An output any part of
 * which is unknown is left out, and so is a null, which state never holds.
 */
export function servedOutputs(outputs: ReadonlyMap<string, PlannedOutput>): Record<string, { sensitive: boolean; type: unknown; value: unknown }> {
  const out: Record<string, { sensitive: boolean; type: unknown; value: unknown }> = {};
  for (const [name, o] of [...outputs].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (anyTrue(o.unknown) || o.value === null || o.value === undefined) continue;
    out[name] = { sensitive: o.sensitive, type: ctyType(o.value), value: o.value };
  }
  return out;
}

/**
 * The strings of an upstream's `remote_state` config, quoted as Terragrunt
 * writes them into a backend file, from `terragrunt render --json`. A string
 * that HCL would escape is left out. Empty when the unit has no remote_state.
 */
export function backendStrings(rendered: unknown): string[] {
  const config = (rendered as { remote_state?: { config?: Record<string, unknown> } | null } | undefined)?.remote_state?.config;
  if (!config || typeof config !== "object") return [];
  return Object.values(config)
    .filter((v): v is string => typeof v === "string" && v !== "" && !/["\\\n]|\$\{|%\{/.test(v))
    .map((v) => `"${v}"`)
    .sort();
}

/** An upstream the wrapper answers `output -json` for. */
export interface ServedUnit {
  unit: string;
  /** Its working directory, as its plan ran in it (`pwd -P`). */
  dir?: string;
  /** The file holding its `output -json`. */
  outputs: string;
  /** The strings its backend file holds (backendStrings). */
  backend: string[];
}

/** The files a wrapper records into under `rec`: each unit's working directory, and each answer it gave. */
export const DIRS_FILE = "dirs.tsv";
export const SERVED_FILE = "served.tsv";

/**
 * The `TG_TF_PATH` wrapper for one wave. It runs `TERRAGUCCI_TG_NEXT` (the
 * spans wrapper, when there is one) or `binary` for every call, except an
 * `output -json` it answers for a served upstream. A plan with
 * `-out=<plans>/<unit>/tfplan.tfplan` records the unit's working directory.
 */
export function servingWrapper(binary: string, plans: readonly string[], rec: string, served: readonly ServedUnit[]): string {
  const lines = [
    "#!/bin/sh",
    "# terragucci: hands each unit the planned outputs of the units it reads. Written for one wave.",
    `next="\${TERRAGUCCI_TG_NEXT:-}"`,
    `[ -n "$next" ] || next=${shq(binary)}`,
    `rec=${shq(rec)}`,
    'out=""',
    'prev=""',
    'json=""',
    'for a in "$@"; do',
    '  case "$a" in -out=*|--out=*) out="${a#*=}" ;; -json) json=1 ;; esac',
    '  if [ "$prev" = "-out" ] || [ "$prev" = "--out" ]; then out="$a"; fi',
    '  prev="$a"',
    "done",
    'case "$out" in',
  ];
  for (const d of [...new Set(plans)]) {
    lines.push(`  ${shq(d)}/*/tfplan.tfplan) u="\${out#${shq(d)}/}"; printf '%s\\t%s\\n' "\${u%/tfplan.tfplan}" "$(pwd -P)" >> "$rec/${DIRS_FILE}" ;;`);
  }
  lines.push("esac");
  if (served.length > 0) {
    lines.push(
      // `output -json <name>` asks for one output: the binary answers it.
      'if [ "$1" = output ] && [ -n "$json" ]; then',
      '  for a in "$@"; do case "$a" in output|-*) ;; *) json="" ;; esac; done',
      "fi",
      'if [ "$1" = output ] && [ -n "$json" ]; then',
      '  here="$(pwd -P)"',
      '  one=""',
      "  n=0",
      '  for g in *.tf *.tf.json; do if [ -f "$g" ]; then n=$((n + 1)); one="$g"; fi; done',
      `  hit() { printf '%s\\t%s\\t%s\\t%s\\n' "$1" "$2" "\${TERRAGUCCI_TG_PHASE:-}" "$here" >> "$rec/${SERVED_FILE}"; cat "$3"; exit 0; }`,
      "  serve() {",
      '    u="$1"; d="$2"; j="$3"; shift 3',
      '    if [ -n "$d" ] && [ "$here" = "$d" ]; then hit "$u" dir "$j"; fi',
      '    { [ "$#" -gt 0 ] && [ "$n" = 1 ] && grep -q backend "$one"; } || return 0',
      '    for s in "$@"; do grep -qF -- "$s" "$one" || return 0; done',
      '    hit "$u" backend "$j"',
      "  }",
    );
    for (const s of served) lines.push(`  serve ${[s.unit, s.dir ?? "", s.outputs, ...s.backend].map(shq).join(" ")}`);
    lines.push("fi");
  }
  lines.push('exec "$next" "$@"');
  return lines.join("\n") + "\n";
}

/** The last line per unit of a wrapper's record: unit, then the rest of the line's fields. */
export function readRecord(text: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const line of text.split("\n")) {
    const [unit, ...rest] = line.split("\t");
    if (unit && rest.length > 0) out.set(unit, rest);
  }
  return out;
}

/** The phase a wrapper answered in: `plan` for a layer's `run --all` plan, `check` for the mock check's render and output calls. */
export const PHASE_ENV = "TERRAGUCCI_TG_PHASE";

/** Every unit a wrapper answered for, with the phases it answered in. */
export function readServed(text: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const line of text.split("\n")) {
    const [unit, how, phase] = line.split("\t");
    if (!unit || !how) continue;
    if (!out.has(unit)) out.set(unit, new Set());
    out.get(unit)!.add(phase ?? "");
  }
  return out;
}

// ── what a unit reads ────────────────────────────────────────────────────

const stripComments = (text: string): string => text.replace(/(^|[^:"$])(#|\/\/).*$/gm, "$1");

/** Each `dependency "<label>" { ... }` block's label and body, braces matched, strings skipped. */
function dependencyBlocks(text: string): { label: string; body: string }[] {
  const out: { label: string; body: string }[] = [];
  const head = /^\s*dependency\s+"([^"]+)"\s*\{/gm;
  for (let m = head.exec(text); m; m = head.exec(text)) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    for (let quoted = false; i < text.length && depth > 0; i++) {
      const c = text[i];
      if (quoted) {
        if (c === "\\") i++;
        else if (c === '"') quoted = false;
      } else if (c === '"') quoted = true;
      else if (c === "{") depth++;
      else if (c === "}") depth--;
    }
    out.push({ label: m[1]!, body: text.slice(start, i - 1) });
    head.lastIndex = i;
  }
  return out;
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The outputs `texts` read through `dependency.<label>.outputs`: their names,
 * or undefined when they read the whole object (or the whole block).
 */
export function dependencyReads(texts: readonly string[], label: string): Set<string> | undefined {
  const re = new RegExp(`\\bdependency\\.${escapeRe(label)}(?![\\w-])(\\.outputs(?![\\w-])(?:\\.([A-Za-z_][\\w-]*)|\\[\\s*"([^"]+)"\\s*\\])?|\\.[A-Za-z_][\\w-]*)?`, "g");
  const read = new Set<string>();
  for (const t of texts.map(stripComments)) {
    for (const m of t.matchAll(re)) {
      if (m[1] === undefined) return undefined;
      if (!m[1].startsWith(".outputs")) continue;
      const name = m[2] ?? m[3];
      if (!name) return undefined;
      read.add(name);
    }
  }
  return read;
}

/** A unit's own `terragrunt.hcl`, and the other files it includes or reads, as text. */
export interface UnitTexts {
  own: string;
  others: string[];
}

/** Read a unit's files: its `terragrunt.hcl`, and the `.hcl` files `terragrunt find` says it includes or reads. */
export function unitTexts(repo: string, unit: string, include: readonly string[] = []): UnitTexts {
  const read = (rel: string): string => {
    try {
      return readFileSync(join(repo, rel), "utf-8");
    } catch {
      return "";
    }
  };
  const own = `${unit}/terragrunt.hcl`;
  return { own: read(own), others: [...new Set(include)].filter((f) => f !== own && f.endsWith(".hcl")).map(read) };
}

/** How a unit reads one upstream: the dependency labels, and the outputs (undefined: every one). Null when it reads none. */
export interface UpstreamRead {
  labels: string[];
  outputs?: Set<string>;
}

/**
 * How `unit` reads `upstream`, from its files. A `dependency` block in its
 * own file with a plain-string `config_path` names its upstream; one whose
 * path is built, or that sits in an included file, may name any upstream, so
 * every output of the upstream counts as read. An upstream that no block can
 * name is a `dependencies` edge: the unit reads none of it.
 */
export function readsOf(unit: string, upstream: string, texts: UnitTexts): UpstreamRead | null {
  const all = [texts.own, ...texts.others];
  const own = dependencyBlocks(stripComments(texts.own));
  const labels: string[] = [];
  let unnamed = false;
  for (const b of own) {
    const m = /^\s*config_path\s*=\s*"([^"$]*)"\s*$/m.exec(b.body);
    if (!m) {
      unnamed = true;
      continue;
    }
    const path = m[1]!.replace(/\/terragrunt\.hcl$/, "");
    if (posix.normalize(posix.join(unit, path)).replace(/\/$/, "") === upstream) labels.push(b.label);
  }
  if (texts.others.some((t) => dependencyBlocks(stripComments(t)).length > 0)) unnamed = true;
  if (labels.length === 0) return unnamed ? { labels: [] } : null;
  let outputs: Set<string> | undefined = new Set();
  for (const l of labels) {
    const r = dependencyReads(all, l);
    if (r === undefined) {
      outputs = undefined;
      break;
    }
    r.forEach((n) => outputs!.add(n));
  }
  if (unnamed) outputs = undefined;
  return { labels: labels.sort(), ...(outputs ? { outputs } : {}) };
}

/** Why a unit is not previewed, and the upstreams it waits for. */
export interface PreviewBlock {
  after: string[];
  why: string;
}

/** An upstream of this run as a preview reads it: its plan, when it has one, and the wave that applies it. */
export interface RunUpstream {
  plan?: unknown;
  wave: number;
}

/** What previewing `unit` takes: the reads of upstreams planned in this run, or why it cannot be previewed. */
export function previewReads(unit: string, deps: readonly string[], texts: UnitTexts, run: ReadonlyMap<string, RunUpstream>): { reads: ReportRead[]; served: string[] } | PreviewBlock {
  const reads: ReportRead[] = [];
  const served: string[] = [];
  const after: string[] = [];
  const why: string[] = [];
  for (const up of [...new Set(deps)].sort()) {
    const u = run.get(up);
    if (!u) continue;
    const r = readsOf(unit, up, texts);
    if (r === null) continue;
    if (u.plan === undefined) {
      after.push(up);
      why.push(`reads ${up}, which has no plan in this run, so what it reads is known once wave ${u.wave} applies`);
      continue;
    }
    const planned = plannedOutputs(u.plan);
    // Its plan changes no output: the state it applied stands, and Terragrunt reads that.
    if (!planned || !planned.changed) continue;
    const unknown = unknownOutputs(planned.outputs, r.outputs);
    if (unknown.length > 0) {
      after.push(up);
      why.push(`reads ${unknown.map(tick).join(", ")} of ${up}, unknown until wave ${u.wave} applies`);
      continue;
    }
    served.push(up);
    reads.push({ upstream: up, data: r.labels.length ? r.labels.join(", ") : "dependency", outputs: "planned" });
  }
  if (why.length > 0) return { after, why: why.join("; ") };
  return { reads, served };
}

/** A missing attribute in Terragrunt's error: an output a unit read that the planned outputs leave unknown. */
export function missingOutput(error: string): string | undefined {
  return /does not have an attribute named "([^"]+)"/.exec(error)?.[1];
}

// ── the preview at the gate ──────────────────────────────────────────────

/** One previewed unit as the plan note's marker carries it. */
export interface NotePreview {
  unit: string;
  /** The preview's plan digest. */
  plan: string | null;
  /** Each change: address, action, and a short hash of each attribute's before and after. Absent when the note had no room. */
  changes?: [string, string, Record<string, string>][];
}

const short = (v: unknown): string => createHash("sha256").update(JSON.stringify(v) ?? "null").digest("hex").slice(0, 10);

/** A unit's changes as the marker keeps them: no value, only a hash of each attribute. */
export function previewChanges(changes: readonly ReportChange[]): [string, string, Record<string, string>][] {
  return changes.map((c) => [
    c.address,
    c.action,
    Object.fromEntries(c.attributes.map((a) => [a.path, short(a.sensitive ? ["sensitive"] : [a.before ?? null, a.after ?? null, a.unknown === true])])),
  ]);
}

/** The previews a plan note carries: each Terragrunt unit that planned on another unit's planned outputs. */
export function notePreviews(roots: readonly ReportRoot[], room = 30_000): NotePreview[] {
  const previews: NotePreview[] = roots
    .filter((r) => r.terragrunt && r.status === "planned" && (r.reads ?? []).some((x) => x.outputs === "planned"))
    .map((r) => ({ unit: r.path, plan: r.plan_digest, changes: previewChanges(r.changes) }));
  // Over the room a note gives the marker, the changes go, from the largest, and the digests stay.
  let size = JSON.stringify(previews).length;
  for (const p of [...previews].sort((a, b) => JSON.stringify(b.changes).length - JSON.stringify(a.changes).length)) {
    if (size <= room) break;
    size -= JSON.stringify(p.changes).length;
    delete p.changes;
  }
  return previews;
}

/**
 * How a unit's plan now differs from its preview, one line each. Empty when
 * the plan digests match. A difference the marker kept no detail of is said
 * as such.
 */
export function previewDifferences(preview: NotePreview, plan: string | null, changes: readonly ReportChange[]): string[] {
  if (preview.plan !== null && plan === preview.plan) return [];
  if (!preview.changes) return ["its plan differs from the preview; the note had no room for the preview's changes"];
  const was = new Map(preview.changes.map(([a, x, h]) => [a, { action: x, attrs: h }]));
  const now = new Map(previewChanges(changes).map(([a, x, h]) => [a, { action: x, attrs: h }]));
  const out: string[] = [];
  for (const [address, n] of now) {
    const p = was.get(address);
    if (!p) {
      out.push(`${address} (${n.action}) was not in the preview`);
      continue;
    }
    if (p.action !== n.action) {
      out.push(`${address}: ${p.action} in the preview, ${n.action} now`);
      continue;
    }
    const attrs = [...new Set([...Object.keys(p.attrs), ...Object.keys(n.attrs)])].filter((k) => p.attrs[k] !== n.attrs[k]).sort();
    if (attrs.length > 0) out.push(`${address} (${n.action}): ${attrs.join(", ")} ${attrs.length === 1 ? "differs" : "differ"} from the preview`);
  }
  for (const [address, p] of was) if (!now.has(address)) out.push(`${address} (${p.action}) was in the preview and is not planned now`);
  if (out.length === 0) out.push("its plan differs from the preview outside its resources' changes (its outputs, or a sensitive value)");
  return out;
}
