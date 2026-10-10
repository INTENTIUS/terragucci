/**
 * The notes an import prints, one per setting, and the small readers every
 * source shares.
 */
import { GUIDE_URL, leftOut, settingCell, terrateamCell, type LeftOutRow, type SettingRow, type TerrateamRow } from "./guide";

export type NoteKind = "mapped" | "default" | "unmapped" | "left-out";

export interface ImportNote {
  /** The setting, as a path in the source file. */
  key: string;
  kind: NoteKind;
  /** The guide's row; empty for a note in its own words, such as a key the guide has no row for. */
  row: string;
  /** What the page says: the terragucci cell, or the rule and what to do instead. */
  text: string;
  /** What this file's value made of it, when there is more to say than the page. */
  detail?: string;
}

/** Collects the notes, one per key and row. */
export class Notes {
  readonly list: ImportNote[] = [];
  private add(kind: NoteKind, key: string, row: string, text: string, detail?: string): void {
    if (this.list.some((n) => n.key === key && n.row === row)) return;
    this.list.push({ key, kind, row, text, ...(detail ? { detail } : {}) });
  }
  mapped(key: string, row: SettingRow, detail: string): void {
    this.add("mapped", key, row, settingCell(row), detail);
  }
  covered(key: string, row: SettingRow, detail?: string): void {
    this.add("default", key, row, settingCell(row), detail);
  }
  unmapped(key: string, row: SettingRow, detail?: string): void {
    this.add("unmapped", key, row, settingCell(row), detail);
  }
  leftOut(key: string, row: LeftOutRow, detail?: string): void {
    const l = leftOut(row);
    this.add("left-out", key, row, `${l.rule}. Instead: ${l.instead}`, detail);
  }
  unknown(key: string, detail?: string): void {
    this.add("unmapped", key, "", `the guide has no row for it, so nothing was written; see ${GUIDE_URL}`, detail);
  }
  /** A note by a row of the guide's Terrateam table. */
  terrateam(kind: Exclude<NoteKind, "left-out">, key: string, row: TerrateamRow, detail?: string): void {
    this.add(kind, key, row, terrateamCell(row), detail);
  }
  /** A note by a row of another guide's table, with that row's terragucci cell as its text. */
  cell(kind: NoteKind, key: string, row: string, text: string, detail?: string): void {
    this.add(kind, key, row, text, detail);
  }
  /** A note outside the settings table, in its own words: when the change applies, and the requirements' one list. */
  own(key: string, kind: NoteKind, text: string, detail?: string): void {
    this.add(kind, key, "", text, detail);
  }
}

export function isMap(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

export function list(v: unknown): unknown[] {
  return Array.isArray(v) ? v : v === undefined || v === null ? [] : [v];
}

/** A project directory as a root path: `./envs/dev/` is `envs/dev`, the repo root is `.`; undefined when it leaves the repo. */
export function rootOf(dir: unknown): string | undefined {
  if (typeof dir !== "string") return undefined;
  const parts = dir.trim().split("/").filter((p) => p !== "" && p !== ".");
  if (dir.trim().startsWith("/") || parts.includes("..")) return undefined;
  return parts.length ? parts.join("/") : ".";
}


/**
 * A source tool's dependencies as `waves.after`: each `[root, upstream]` the
 * reads (`reads`, root to the roots whose state it reads) do not already give,
 * by root. `cycle` names the roots of a cycle the dependencies and reads make
 * together, when they do; then nothing is written.
 */
export function wavesAfterOf(edges: readonly (readonly [string, string])[], reads: ReadonlyMap<string, ReadonlySet<string>> = new Map()): { after: Record<string, string[]>; fromReads: Set<string>; cycle?: string[] } {
  const reaches = (from: string, to: string): boolean => {
    const seen = new Set<string>();
    const walk = (x: string): boolean => [...(reads.get(x) ?? [])].some((u) => u === to || (!seen.has(u) && (seen.add(u), walk(u))));
    return walk(from);
  };
  const fromReads = new Set<string>();
  const after: Record<string, string[]> = {};
  for (const [d, u] of edges) {
    if (d === u) continue;
    if (reaches(d, u)) {
      fromReads.add(`${d}\0${u}`);
      continue;
    }
    if (!(after[d] ?? []).includes(u)) after[d] = [...(after[d] ?? []), u].sort();
  }
  // A cycle: a root that, through the order written and the reads, comes after itself.
  const next = (x: string): string[] => [...new Set([...(after[x] ?? []), ...(reads.get(x) ?? [])])];
  const state = new Map<string, 1 | 2>();
  const stack: string[] = [];
  const visit = (x: string): string[] | undefined => {
    if (state.get(x) === 2) return undefined;
    if (state.get(x) === 1) return [...stack.slice(stack.indexOf(x)), x];
    state.set(x, 1);
    stack.push(x);
    for (const u of next(x)) {
      const c = visit(u);
      if (c) return c;
    }
    stack.pop();
    state.set(x, 2);
    return undefined;
  };
  for (const x of Object.keys(after).sort()) {
    const cycle = visit(x);
    if (cycle) return { after: {}, fromReads, cycle };
  }
  return { after: Object.fromEntries(Object.entries(after).sort(([a], [b]) => a.localeCompare(b))), fromReads };
}
