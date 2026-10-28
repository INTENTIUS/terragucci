import { chantChangelogNow } from "../chant-next";

export interface Semver {
  major: number;
  minor: number;
  patch: number;
}

const RE = /^v?(\d+)\.(\d+)\.(\d+)$/;

export function parseSemver(text: string): Semver | undefined {
  const m = RE.exec(text.trim());
  return m ? { major: +m[1], minor: +m[2], patch: +m[3] } : undefined;
}

export const formatSemver = (v: Semver): string => `${v.major}.${v.minor}.${v.patch}`;

export function compareSemver(a: Semver, b: Semver): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

export type Bump = "major" | "minor" | "patch";

/**
 * The bump a set of commit messages calls for. A breaking marker (`type!:` or
 * a `BREAKING CHANGE` footer) is a major, `feat` a minor, and anything else a
 * patch, because a changed module is always published at a new version.
 *
 * chant's `changelogBump` (chant#4597) decides it when the installed chant
 * has it, so the version a publish cuts and the changelog's bump in the
 * release catalog are one decision; the loop below is the fallback, with the
 * same rules. cli.ts loads it before a command runs (preloadChantNext).
 */
export function bumpFor(messages: string[]): Bump {
  const chant = chantChangelogNow();
  if (chant) return chant.changelogBump(messages);
  return ownBumpFor(messages);
}

/** terragucci's own bump, the fallback on a chant without `changelogBump`. */
export function ownBumpFor(messages: string[]): Bump {
  let bump: Bump = "patch";
  for (const message of messages) {
    const subject = message.split("\n", 1)[0];
    if (/^\w+(\([^)]*\))?!:/.test(subject) || /^BREAKING[ -]CHANGE:/m.test(message)) return "major";
    if (/^feat(\([^)]*\))?:/.test(subject)) bump = "minor";
  }
  return bump;
}

/** The bump that takes `from` to `to`, a later version: the largest part that moved. */
export function bumpBetween(from: Semver, to: Semver): Bump {
  if (to.major !== from.major) return "major";
  if (to.minor !== from.minor) return "minor";
  return "patch";
}

export function applyBump(v: Semver, bump: Bump): Semver {
  if (bump === "major") return { major: v.major + 1, minor: 0, patch: 0 };
  if (bump === "minor") return { major: v.major, minor: v.minor + 1, patch: 0 };
  return { major: v.major, minor: v.minor, patch: v.patch + 1 };
}
