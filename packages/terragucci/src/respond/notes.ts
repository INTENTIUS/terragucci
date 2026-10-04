/**
 * Release notes for a published module, from the conventional commits that
 * touched it between its last two `modules/<name>/vX.Y.Z` tags.
 */
import { git, tryGit } from "../publish/git";
import { compareSemver, parseSemver } from "../publish/semver";

export interface ModuleNotes {
  module: string;
  version: string;
  previous?: string;
  notes: string;
}

const SECTIONS: [string, (type: string, breaking: boolean) => boolean][] = [
  ["Breaking changes", (_t, b) => b],
  ["Features", (t) => t === "feat"],
  ["Fixes", (t) => t === "fix"],
  ["Other changes", () => true],
];

/** Commit messages, newest first, as markdown grouped by kind. */
export function releaseNotes(messages: string[]): string {
  const groups = new Map<string, string[]>();
  for (const message of messages) {
    const subject = message.split("\n", 1)[0]!.trim();
    const m = /^(\w+)(?:\(([^)]*)\))?(!)?:\s*(.+)$/.exec(subject);
    const type = m?.[1]?.toLowerCase() ?? "";
    const breaking = !!m?.[3] || /^BREAKING[ -]CHANGE:/m.test(message);
    const line = m ? `${m[2] ? `${m[2]}: ` : ""}${m[4]}` : subject;
    const section = SECTIONS.find(([, test]) => test(type, breaking))![0];
    groups.set(section, [...(groups.get(section) ?? []), line]);
  }
  if (groups.size === 0) return "No changes since the last release.";
  return SECTIONS.filter(([name]) => groups.has(name))
    .map(([name]) => `### ${name}\n\n${groups.get(name)!.map((l) => `- ${l}`).join("\n")}`)
    .join("\n\n");
}

/** Notes for the module at `rel`, for its newest tag or the version given. */
export function moduleNotes(repo: string, rel: string, version?: string): ModuleNotes | undefined {
  const tags = (tryGit(repo, ["tag", "--list", `${rel}/v*`]) ?? "")
    .split("\n")
    .filter(Boolean)
    .map((tag) => ({ tag, v: parseSemver(tag.slice(rel.length + 1)) }))
    .filter((t): t is { tag: string; v: NonNullable<ReturnType<typeof parseSemver>> } => !!t.v)
    .sort((a, b) => compareSemver(b.v, a.v));
  const at = version ? tags.findIndex((t) => t.tag === `${rel}/v${version.replace(/^v/, "")}`) : 0;
  const tag = tags[at];
  if (!tag) return undefined;
  const prev = tags[at + 1];
  const range = prev ? `${prev.tag}..${tag.tag}` : tag.tag;
  const messages = git(repo, ["log", "--format=%B%x1e", range, "--", rel]).split("\x1e").map((m) => m.trim()).filter(Boolean);
  return { module: rel, version: tag.tag.slice(rel.length + 2), ...(prev ? { previous: prev.tag.slice(rel.length + 2) } : {}), notes: releaseNotes(messages) };
}
