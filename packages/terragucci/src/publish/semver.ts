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
