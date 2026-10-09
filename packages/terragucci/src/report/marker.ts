/** The marker a plan note carries its waves in, for `approval: pr-review` (../review.ts), and the Terragrunt previews a gate compares with (../tg-preview.ts). */
import type { NotePreview } from "../tg-preview";

/** The command that approves wave `wave`'s plans of `digest`, with `--sign` under `approval: sealed`. */
export function approveCommand(wave: number, digest: string, sealed = false): string {
  return `chant approve tf-apply wave-${wave} --plan ${digest}${sealed ? " --sign" : ""}`;
}

/** The marker the plan note carries the waves in. */
export const WAVES_MARKER = "terragucci:waves";

/**
 * What the plan note's marker holds: the head planned and, per wave, its
 * review digest and whether the gate will hold it; and each Terragrunt unit
 * planned on another unit's planned outputs, as the gate compares it.
 */
export interface NoteWaves {
  head: string;
  waves: { number: number; digest: string | null; waits: boolean }[];
  previews?: NotePreview[];
}

/** The marker line for a plan note, an HTML comment the note's reader never sees. */
export function noteMarker(w: NoteWaves): string {
  // No `<` or `>` in the JSON, so nothing in it ends the comment.
  return `<!-- ${WAVES_MARKER} ${JSON.stringify(w).replace(/</g, "\\u003c").replace(/>/g, "\\u003e")} -->`;
}

/** The marker of a comment body, or undefined. */
export function parseMarker(body: unknown): NoteWaves | undefined {
  if (typeof body !== "string") return undefined;
  const m = new RegExp(`<!-- ${WAVES_MARKER} (\\{.*?\\}) -->`).exec(body);
  if (!m) return undefined;
  try {
    const w = JSON.parse(m[1]!) as NoteWaves;
    if (typeof w.head !== "string" || !Array.isArray(w.waves)) return undefined;
    return w;
  } catch {
    return undefined;
  }
}

