/**
 * The values `secrets:` fetched in this process (./root-secrets.ts), which
 * nothing terragucci writes may hold.
 *
 *   plans     redactPlan and sensitiveStrings (./report/redact.ts) treat each
 *             one as a value the plan marks sensitive, at any length
 *   reports   writeReportDir (./report/store.ts) replaces each one of eight
 *             characters and more in every file of the report directory, the
 *             note among them
 *   logs      once a value is held, this process's stdout and stderr replace
 *             each one of eight characters and more; on GitHub and Forgejo
 *             each value is also masked with `::add-mask::`, which the runner
 *             applies to the whole job's log at any length
 *
 * Eight characters is GitLab's own floor for a masked variable: a shorter
 * value would match everyday words in a log. A value is held only by the
 * process that fetched it.
 */
import { REDACTED } from "./report/schema";

const held = new Set<string>();

/** The values held, longest first, so a value that contains another is replaced whole. */
export function secretValues(): string[] {
  return [...held].sort((a, b) => b.length - a.length);
}

/** The shortest value replaced inside a longer text. */
export const SCRUB_MIN = 8;

/** The forms a value takes in text: as it is, JSON-escaped, and HTML-escaped. */
function forms(v: string): string[] {
  const json = JSON.stringify(v).slice(1, -1);
  const html = v.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
  return [...new Set([v, json, html])];
}

/** `text` with each held value of SCRUB_MIN characters and more, in each of its forms, replaced by REDACTED. */
export function scrubText(text: string, values: readonly string[] = secretValues()): string {
  let out = text;
  for (const v of values) {
    if (v.length < SCRUB_MIN) continue;
    for (const f of forms(v)) if (out.includes(f)) out = out.split(f).join(REDACTED);
  }
  return out;
}

/**
 * Hold `value`: mask it in the job's log and keep it out of every plan,
 * report and line this process writes. `env` tells the forge: GitHub and
 * Forgejo runners set GITHUB_ACTIONS and read `::add-mask::`. `logs: false`
 * holds it for the plans and reports alone, and leaves stdout as it is.
 */
export function holdSecretValue(value: string, env: NodeJS.ProcessEnv = process.env, options: { logs?: boolean } = {}): void {
  if (value === "" || held.has(value)) return;
  held.add(value);
  if (options.logs === false) return;
  const write = scrubLogs();
  if (env.GITHUB_ACTIONS === "true") for (const line of value.split(/\r?\n/)) if (line.trim() !== "") write(`::add-mask::${line}\n`);
}

/** stdout's own writer, from before scrubLogs wrapped it: the masks go through it whole. */
let rawStdout: ((s: string) => boolean) | undefined;

/** Start replacing the held values in stdout and stderr, once; the unscrubbed stdout writer, for the masks. */
function scrubLogs(): (s: string) => void {
  if (!rawStdout) {
    rawStdout = process.stdout.write.bind(process.stdout) as (s: string) => boolean;
    for (const stream of [process.stdout, process.stderr]) {
      const write = stream.write.bind(stream) as (chunk: unknown, ...rest: unknown[]) => boolean;
      stream.write = ((chunk: unknown, ...rest: unknown[]) => {
        if (typeof chunk === "string") return write(scrubText(chunk), ...rest);
        if (chunk instanceof Uint8Array) return write(scrubText(Buffer.from(chunk).toString("utf8")), ...rest);
        return write(chunk, ...rest);
      }) as typeof stream.write;
    }
  }
  const raw = rawStdout;
  return (s) => void raw(s);
}
