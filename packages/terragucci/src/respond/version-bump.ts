/**
 * The version a module's next release calls for, when its commits do not say
 * (terragucci#32). Conventional commits decide the bump as tf-publish does, a
 * `version` file in the module overrides it, and the typed-decision service is
 * asked only when the commits since the last release carry no conventional
 * type. The answer is a suggestion in a release pull request that writes the
 * module's `version` file; a person merges it to confirm. Nothing here
 * publishes.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ResolvedSettings } from "../config";
import { decide, isConfident, summarize, type DecideOptions } from "../decide";
import { QUESTIONS } from "../decide/questions";
import { findModules } from "../publish";
import { commitsSince, tryGit } from "../publish/git";
import { applyBump, bumpFor, compareSemver, formatSemver, parseSemver, type Bump, type Semver } from "../publish/semver";
import type { Proposal } from "./change";

const TYPES = "feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert";

/** Whether a commit message names a conventional type, or marks a breaking change. */
export function isConventional(message: string): boolean {
  const subject = message.split("\n", 1)[0]!;
  return new RegExp(`^(${TYPES})(\\([^)]*\\))?!?:`, "i").test(subject) || /^\w+(\([^)]*\))?!:/.test(subject) || /^BREAKING[ -]CHANGE:/m.test(message);
}

export interface BumpSuggestion {
  module: string;
  /** The last release, from the module's git tags. */
  last: string;
  /** Where the bump came from. `none` means nothing to release or a person already chose. */
  source: "conventional" | "suggested" | "default" | "none";
  bump?: Bump;
  version?: string;
  probability?: number;
  /** One line a person can read: why this version, and what to check. */
  note: string;
}

/** The module's changes since `tag`: the files, and the declarations added or removed. */
function diffSummary(repo: string, tag: string, rel: string): { files: string; declarations: string[] } {
  const files = tryGit(repo, ["diff", "--stat", "--no-color", `${tag}..HEAD`, "--", rel]) ?? "";
  const patch = tryGit(repo, ["diff", "--unified=0", "--no-color", `${tag}..HEAD`, "--", rel]) ?? "";
  const declarations = patch.split("\n").filter((l) => /^[+-]\s*(variable|output|resource|data|module)\s+"/.test(l)).slice(0, 80);
  return { files: files.slice(0, 2000), declarations };
}

/** The version a module had at `ref`: its version file there, or 0.0.0 when it had none. */
function baseVersion(repo: string, rel: string, ref: string): Semver {
  const file = tryGit(repo, ["show", `${ref}:${rel}/version`]);
  return (file && parseSemver(file.trim().replace(/^v/, ""))) || { major: 0, minor: 0, patch: 0 };
}

function latestTag(repo: string, rel: string): { tag: string; v: Semver } | undefined {
  const tags = (tryGit(repo, ["tag", "--list", `${rel}/v*`]) ?? "").split("\n").filter(Boolean);
  let best: { tag: string; v: Semver } | undefined;
  for (const tag of tags) {
    const v = parseSemver(tag.slice(rel.length + 1));
    if (v && (!best || compareSemver(v, best.v) > 0)) best = { tag, v };
  }
  return best;
}

export interface BumpOptions extends DecideOptions {
  /** One module's path. */
  module?: string;
  /**
   * A ref (a tag, a branch or a commit) to count changes from for a module with
   * no release tag, as with OCI-only publishing. The module's `version` file at
   * that ref is the last release (0.0.0 when it had none). A module that has
   * release tags ignores it.
   */
  since?: string;
}

/**
 * A suggestion per module that changed since its last release, and for each
 * one whose bump the model suggested or defaulted, a release pull request.
 */
export async function versionBumps(
  repo: string,
  settings: Pick<ResolvedSettings, "modules" | "decide">,
  options: BumpOptions = {},
): Promise<{ suggestions: BumpSuggestion[]; proposals: Proposal[] }> {
  const suggestions: BumpSuggestion[] = [];
  const proposals: Proposal[] = [];
  const modules = findModules(repo, settings.modules?.path ?? "modules/*").filter((m) => !options.module || m.rel === options.module.replace(/\/+$/, ""));
  for (const mod of modules) {
    const tagged = latestTag(repo, mod.rel);
    const sinceRef = !tagged && options.since ? options.since : undefined;
    if (sinceRef && tryGit(repo, ["rev-parse", "--verify", "--quiet", `${sinceRef}^{commit}`]) === undefined) {
      suggestions.push({ module: mod.rel, last: "none", source: "none", note: `--since ${sinceRef} is not a ref in this repository` });
      continue;
    }
    const last = tagged ?? (sinceRef ? { tag: sinceRef, v: baseVersion(repo, mod.rel, sinceRef) } : undefined);
    if (!last) {
      suggestions.push({ module: mod.rel, last: "none", source: "none", note: "no release tag yet, so the first release is 0.1.0" });
      continue;
    }
    const lastText = formatSemver(last.v);
    const base = { module: mod.rel, last: lastText };
    const revision = tryGit(repo, ["rev-list", "-n", "1", last.tag]);
    const messages = commitsSince(repo, revision, mod.rel);
    if (messages.length === 0) {
      suggestions.push({ ...base, source: "none", note: "no commits since the last release" });
      continue;
    }
    // With --since, the version file at the ref is the baseline, so it only overrides when it changed after the ref.
    const versionFile = join(repo, mod.rel, "version");
    const baseline = sinceRef ? tryGit(repo, ["show", `${sinceRef}:${mod.rel}/version`]) : undefined;
    if (existsSync(versionFile) && (baseline === undefined || readFileSync(versionFile, "utf8").trim() !== baseline.trim())) {
      suggestions.push({ ...base, source: "none", note: `${mod.rel}/version sets the version, and it overrides any bump` });
      continue;
    }
    if (messages.some(isConventional)) {
      const bump = bumpFor(messages);
      suggestions.push({ ...base, source: "conventional", bump, version: formatSemver(applyBump(last.v, bump)), note: "the conventional commits decide the bump" });
      continue;
    }

    // No commit carries a conventional type: the one case the model is asked.
    const state = { module: mod.rel, last_release: lastText, commits: messages.slice(0, 40).map((m) => m.slice(0, 500)), diff: diffSummary(repo, last.tag, mod.rel) };
    const record = await decide(settings.decide, state, { bump: QUESTIONS.versionBump }, options);
    const d = record.decisions.bump!;
    let s: BumpSuggestion;
    if (isConfident(d) && (d.answer === "major" || d.answer === "minor" || d.answer === "patch")) {
      const bump = d.answer;
      s = { ...base, source: "suggested", bump, version: formatSemver(applyBump(last.v, bump)), probability: d.probability, note: `suggested from the commit messages and the diff: ${summarize(d, record)}` };
    } else {
      s = { ...base, source: "default", bump: "patch", version: formatSemver(applyBump(last.v, "patch")), note: `no suggestion, so patch is proposed: ${summarize(d, record)}` };
    }
    suggestions.push(s);
    proposals.push({
      branch: `terragucci/release/${mod.rel.replace(/[^A-Za-z0-9._-]+/g, "-")}`,
      title: `Release ${mod.rel} ${s.version}`,
      body: releaseBody(s, messages),
      files: new Map([[`${mod.rel}/version`, `${s.version}\n`]]),
    });
  }
  return { suggestions, proposals };
}

function releaseBody(s: BumpSuggestion, messages: string[]): string {
  const head =
    s.source === "suggested"
      ? `Suggested bump: **${s.bump}**, ${s.last} to ${s.version}, with probability ${s.probability!.toFixed(2)}. None of the commits since ${s.last} carries a conventional type, so a model read the commit messages and the diff summary.`
      : `Proposed bump: patch, ${s.last} to ${s.version}. None of the commits since ${s.last} carries a conventional type, and ${s.note.replace(/^no suggestion, so patch is proposed: /, "")}.`;
  return [
    head,
    "",
    "Merging this pull request writes the module's `version` file, and the next `tf-publish` run publishes that version. Change the file to another version first if the bump is wrong. Nothing is published until then.",
    "",
    "Commits since the last release:",
    ...messages.slice(0, 40).map((m) => `- ${m.split("\n", 1)[0]}`),
  ].join("\n");
}
