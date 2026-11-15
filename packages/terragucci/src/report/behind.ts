/**
 * How far behind the newest release each module and provider version in use
 * is. The page and `estate.json` carry it beside each version of the
 * versions section: the newest release, how many releases are newer, and the
 * bump to the newest. It does not depend on `rollouts.watch`; a repo with no
 * rule sees what is behind the same.
 *
 * The registries are asked through `ReleaseSources` (rollout/releases.ts),
 * once for each module source and provider in use. A subject whose releases
 * cannot be listed (a git module, a registry that answered an error) is named
 * in `unread` with why, and its versions carry no `behind`.
 */
import { behindOf, plainReleases, type ReleaseSources } from "../rollout/releases";
import type { EstateVersions } from "./versions";

export async function addBehind(versions: EstateVersions, sources: ReleaseSources): Promise<void> {
  const unread: NonNullable<EstateVersions["unread"]> = [];
  const groups = [
    ...versions.modules.map((m) => ({ subject: { kind: "module" as const, name: m.source }, rows: m.versions })),
    ...versions.providers.map((p) => ({ subject: { kind: "provider" as const, name: p.provider }, rows: p.versions })),
  ];
  for (const { subject, rows } of groups) {
    if (!rows.some((r) => r.version !== undefined)) continue;
    let listed: string[] | undefined;
    try {
      listed = await sources.versions(subject);
    } catch (e) {
      unread.push({ name: subject.name, reason: (e as Error).message });
      continue;
    }
    if (listed === undefined) {
      unread.push({ name: subject.name, reason: "its releases are not listed for this kind of source" });
      continue;
    }
    const releases = plainReleases(listed);
    for (const row of rows) {
      const behind = row.version === undefined ? undefined : behindOf(row.version, releases);
      if (behind) row.behind = behind;
    }
  }
  if (unread.length > 0) versions.unread = unread;
}
