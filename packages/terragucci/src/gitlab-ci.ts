/**
 * GitLab runs one file, the repo's `.gitlab-ci.yml`, so terragucci's jobs go
 * in `.gitlab/terragucci.yml` and the repo's file includes it. init writes the
 * repo's file when there is none, or when terragucci wrote the whole of it
 * before; otherwise it adds the one include entry and leaves the rest of the
 * file, and the repo's own jobs, as they are.
 */
import { parseYAML } from "@intentius/chant/yaml";
import { ConfigError } from "./config";
import { GL_DEFAULT_STAGES, MARKER, PIPELINE_PATHS } from "./render";

export const GL_ROOT_FILE = ".gitlab-ci.yml";

/** The include entry, as init writes it. */
const ENTRY = `- local: ${PIPELINE_PATHS.gitlab}`;

/** The repo's file when init writes the whole of it. Not the pipeline's marker: the jobs a person adds here are theirs. */
const NEW_FILE = [
  "# terragucci's jobs are in .gitlab/terragucci.yml, which terragucci init writes",
  "# and this file includes. Add your own jobs here; init keeps them.",
  "include:",
  `  ${ENTRY}`,
  "",
].join("\n");

/** Whether an include value names the included file: `.gitlab/terragucci.yml`, `/.gitlab/terragucci.yml` or `{ local: ... }`, alone or in a list. */
function includes(value: unknown): boolean {
  const named = (v: unknown): boolean => {
    const path = typeof v === "string" ? v : v && typeof v === "object" ? (v as Record<string, unknown>).local : undefined;
    return typeof path === "string" && path.replace(/^\.?\//, "") === PIPELINE_PATHS.gitlab;
  };
  return Array.isArray(value) ? value.some(named) : named(value);
}

function read(text: string): Record<string, unknown> {
  try {
    return parseYAML(text);
  } catch (e) {
    throw new ConfigError(`${GL_ROOT_FILE} is not YAML init can read, so it cannot add the include of ${PIPELINE_PATHS.gitlab} (${(e as Error).message})`);
  }
}

/** The text with the include entry added, or undefined when the file's include is not a block list init can add a line to. */
function addEntry(text: string, doc: Record<string, unknown>): string | undefined {
  const lines = text.split("\n");
  if (!("include" in doc)) {
    // Above the first key, below the comments and the document marker that head the file.
    let at = 0;
    while (at < lines.length && (lines[at].trim() === "" || lines[at].trim().startsWith("#") || lines[at].trim() === "---")) at++;
    return [...lines.slice(0, at), "include:", `  ${ENTRY}`, "", ...lines.slice(at)].join("\n");
  }
  const key = lines.findIndex((l) => /^include:\s*(#.*)?$/.test(l));
  if (key < 0 || !Array.isArray(doc.include)) return undefined;
  const first = lines.slice(key + 1).find((l) => l.trim() !== "" && !l.trim().startsWith("#"));
  const indent = first && /^(\s*)- /.exec(first)?.[1];
  if (indent === undefined) return undefined;
  return [...lines.slice(0, key + 1), `${indent}${ENTRY}`, ...lines.slice(key + 1)].join("\n");
}

/**
 * What the repo's `.gitlab-ci.yml` becomes, given what it holds now (undefined
 * when there is none) and the included file's content. Refused, with what to
 * change, when the repo's file names a job the included file also names, or
 * lists stages without terragucci's in order: GitLab then reads the stages
 * from the repo's file alone.
 */
export function gitlabCi(before: string | undefined, included: string): string {
  if (before === undefined || before.startsWith(MARKER) || before.trim() === "") return NEW_FILE;
  const doc = read(before);
  const ours = read(included);
  const jobs = Object.keys(ours).filter((k) => k !== "stages");
  const clash = jobs.filter((j) => j in doc);
  if (clash.length) {
    throw new ConfigError(`${GL_ROOT_FILE} has jobs named ${clash.join(", ")}, as ${PIPELINE_PATHS.gitlab} does, and GitLab would merge the two; rename yours`);
  }
  if (Array.isArray(doc.stages)) {
    const defaults = [...GL_DEFAULT_STAGES.before, ...GL_DEFAULT_STAGES.after];
    const need = (ours.stages as string[]).filter((s) => !defaults.includes(s));
    const listed = need.map((s) => (doc.stages as unknown[]).indexOf(s));
    if (listed.some((at, i) => at < 0 || (i > 0 && at < listed[i - 1]))) {
      throw new ConfigError(`${GL_ROOT_FILE} lists its own stages, which GitLab reads in place of the included file's; add ${need.join(", ")} to them, in that order`);
    }
  }
  if (includes(doc.include)) return before;
  const after = addEntry(before, doc);
  // The edit must add the entry and change nothing else.
  const check = after === undefined ? undefined : read(after);
  const same = (a: Record<string, unknown>, b: Record<string, unknown>): boolean => {
    const { include: ia, ...ra } = a;
    const { include: ib, ...rb } = b;
    const kept = Array.isArray(ib) ? ib.filter((v) => !includes(v)) : [];
    return JSON.stringify(ra) === JSON.stringify(rb) && JSON.stringify(ia ?? []) === JSON.stringify(kept);
  };
  if (after === undefined || !check || !includes(check.include) || !same(doc, check)) {
    throw new ConfigError(`${GL_ROOT_FILE} has an include init cannot add a line to; write its include as a list and add \`${ENTRY}\` to it`);
  }
  return after;
}
