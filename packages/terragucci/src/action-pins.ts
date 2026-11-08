/**
 * The actions a rendered GitHub or Forgejo workflow uses, each pinned by
 * commit SHA from chant's table (`@intentius/chant/action-pins`). A tag can
 * move; a SHA cannot. Every renderer takes its `uses:` from here, and chant's
 * `tagComments` writes each pin's release beside its `uses:` line.
 *
 * Forgejo's runner takes the same refs under https://code.forgejo.org (the
 * forgejo lexicon rewrites them), whose actions mirror GitHub's with the same
 * commits. upload-artifact and download-artifact stay at v3 there: v4 and
 * later refuse to run on a Forgejo runner.
 */
import { ACTION_PINS, usesRef } from "@intentius/chant/action-pins";
import type { ForgeName as Forge } from "./config";

export { tagComments, unpinnedActions } from "@intentius/chant/action-pins";

export const CHECKOUT = usesRef(ACTION_PINS.checkout4);
export const CACHE_RESTORE = usesRef(ACTION_PINS.cacheRestore4);
export const SETUP_NODE = usesRef(ACTION_PINS.setupNode4);
/**
 * actions/cache at v4.3.0, the commit chant's cache/restore and cache/save
 * rows pin. chant's table has no actions/cache row at v4 (chant issue 4816).
 */
export const CACHE = `actions/cache@${ACTION_PINS.cacheRestore4.sha}`;

/** upload-artifact for the forge: v3 on Forgejo, v4 on GitHub. */
export const uploadArtifact = (forge: Forge): string => usesRef(forge === "forgejo" ? ACTION_PINS.uploadArtifact3 : ACTION_PINS.uploadArtifact4);
/** download-artifact for the forge: v3 on Forgejo, v4 on GitHub. */
export const downloadArtifact = (forge: Forge): string => usesRef(forge === "forgejo" ? ACTION_PINS.downloadArtifact3 : ACTION_PINS.downloadArtifact4);

/** A ref as the rendered workflow names it: the forgejo lexicon puts Forgejo's under its actions root. */
export const forgeRef = (forge: Forge, ref: string): string => (forge === "forgejo" ? `https://code.forgejo.org/${ref}` : ref);
