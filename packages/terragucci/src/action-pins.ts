/**
 * The actions a rendered GitHub or Forgejo workflow uses, each pinned by
 * commit SHA. A tag can move; a SHA cannot. Every renderer takes its `uses:`
 * from here, so an update is one change to this table. Each pin is the
 * commit the named major tag pointed at, with the exact release that commit
 * carries; `tagComments` writes that release beside each `uses:` line so a
 * person can read the version.
 *
 * Forgejo's runner takes the same refs under https://code.forgejo.org (the
 * forgejo lexicon rewrites them), whose actions mirror GitHub's with the same
 * commits. upload-artifact and download-artifact stay at v3 there: v4 and
 * later refuse to run on a Forgejo runner.
 */
import type { ForgeName as Forge } from "./config";

interface Pin {
  repo: string;
  sha: string;
  /** The release at that commit. */
  tag: string;
}

const pin = (repo: string, sha: string, tag: string): Pin => ({ repo, sha, tag });

export const ACTION_PINS = {
  checkout: pin("actions/checkout", "11d5960a326750d5838078e36cf38b85af677262", "v4.4.0"),
  cache: pin("actions/cache", "0057852bfaa89a56745cba8c7296529d2fc39830", "v4.3.0"),
  cacheRestore: pin("actions/cache/restore", "0057852bfaa89a56745cba8c7296529d2fc39830", "v4.3.0"),
  setupNode: pin("actions/setup-node", "49933ea5288caeca8642d1e84afbd3f7d6820020", "v4.4.0"),
  uploadArtifact: pin("actions/upload-artifact", "ea165f8d65b6e75b540449e92b4886f43607fa02", "v4.6.2"),
  downloadArtifact: pin("actions/download-artifact", "d3f86a106a0bac45b974a628896c90dbdf5c8093", "v4.3.0"),
  uploadArtifactV3: pin("actions/upload-artifact", "ff15f0306b3f739f7b6fd43fb5d26cd321bd4de5", "v3.2.1"),
  downloadArtifactV3: pin("actions/download-artifact", "9bc31d5ccc31df68ecc42ccf4149144866c47d8a", "v3.0.2"),
} as const satisfies Record<string, Pin>;

const uses = (p: Pin): string => `${p.repo}@${p.sha}`;

export const CHECKOUT = uses(ACTION_PINS.checkout);
export const CACHE = uses(ACTION_PINS.cache);
export const CACHE_RESTORE = uses(ACTION_PINS.cacheRestore);
export const SETUP_NODE = uses(ACTION_PINS.setupNode);

/** upload-artifact for the forge: v3 on Forgejo, v4 on GitHub. */
export const uploadArtifact = (forge: Forge): string => uses(forge === "forgejo" ? ACTION_PINS.uploadArtifactV3 : ACTION_PINS.uploadArtifact);
/** download-artifact for the forge: v3 on Forgejo, v4 on GitHub. */
export const downloadArtifact = (forge: Forge): string => uses(forge === "forgejo" ? ACTION_PINS.downloadArtifactV3 : ACTION_PINS.downloadArtifact);

/** A ref as the rendered workflow names it: the forgejo lexicon puts Forgejo's under its actions root. */
export const forgeRef = (forge: Forge, ref: string): string => (forge === "forgejo" ? `https://code.forgejo.org/${ref}` : ref);

const TAG_BY_SHA =new Map(Object.values(ACTION_PINS).map((p) => [p.sha, p.tag]));

/** Write each pinned `uses:` line's release beside it, as `# v4.4.0`. */
export function tagComments(yaml: string): string {
  return yaml.replace(/^(\s*(?:- )?uses: *["']?[^\s"'#]+@([0-9a-f]{40})["']?)[ \t]*$/gm, (line, head: string, sha: string) => {
    const tag = TAG_BY_SHA.get(sha);
    return tag ? `${head} # ${tag}` : line;
  });
}

/** Every `uses:` in a workflow that names an action by a tag or branch, not a 40-character commit SHA. Local actions and docker images are not actions on a forge. */
export function unpinnedActions(yaml: string): string[] {
  const out: string[] = [];
  for (const m of yaml.matchAll(/^\s*(?:- )?uses: *["']?([^\s"'#]+)["']?/gm)) {
    const ref = m[1];
    if (ref.startsWith("./") || ref.startsWith("../") || ref.startsWith("docker://")) continue;
    if (!/@[0-9a-f]{40}$/.test(ref)) out.push(ref);
  }
  return out;
}
