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

