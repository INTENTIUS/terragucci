/**
 * The `--json` contract. Every command that takes `--json` prints exactly one
 * JSON object on stdout and nothing else; progress and tool output stay off
 * stdout. `schema` changes only when a field is removed or changes meaning.
 */
export const SCHEMA_VERSION = 1;

/** The commands that take `--json`. */
export const ENVELOPE_COMMANDS = ["init", "reconcile", "plan", "stage", "config"];

export type ExitClass = "ok" | "failed" | "usage" | "waiting";

export interface Envelope {
  schema: typeof SCHEMA_VERSION;
  command: string;
  /** The process exit code: 0 done, 1 failed, 2 usage or config error, 3 waiting on an approval. */
  exit: number;
  status: ExitClass;
  /** The command's result; null when it could not run. */
  results: unknown;
  /** Why it could not run, when `results` is null. */
  error?: string;
}

const CLASSES: Record<number, ExitClass> = { 0: "ok", 1: "failed", 2: "usage", 3: "waiting" };

export function envelope(command: string, exit: number, results: unknown, error?: string): Envelope {
  const e: Envelope = { schema: SCHEMA_VERSION, command, exit, status: CLASSES[exit], results };
  if (error !== undefined) e.error = error;
  return e;
}
