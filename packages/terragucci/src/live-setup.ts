/**
 * The record store and estate choudoufu resolves for a live root
 * (choudoufu#2293), read from `choudoufu live-check -json`. The reading, the
 * setup line and the bucket check are the terraform lexicon's
 * (`@intentius/chant-lexicon-terraform/live-roots`, chant#4910). What stays
 * here is terragucci's: live-check run as the policy engine runs, with the
 * job's environment less its forge tokens, and the bucket check given the
 * root's backend block.
 *
 * A choudoufu release without those fields prints a `live-check -json`
 * document with no `estate_source`; then nothing is remembered, and every
 * reader falls back to the live block's own text (the lexicon's estateOf
 * and writtenRecordStore), as before. The record store of a live root's
 * estate is the lexicon's liveRecordStore.
 */
import { checkStoreBucket as chantCheckStoreBucket, readLiveSetup as chantReadLiveSetup, rootBackendAttrs, type BucketOutcome, type LiveSetup, type LiveStore } from "@intentius/chant-lexicon-terraform/live-roots";
import { defaultPolicyExec, type PolicyExec } from "./report/policy";

/**
 * `choudoufu live-check -json <dir>` for one root, run in the directory with
 * `exec` (default the policy engine's runner), and the setup it prints,
 * remembered for the process by the lexicon's `readLiveSetup`.
 */
export function readLiveSetup(dir: string, options: { binary?: string; exec?: PolicyExec } = {}): Promise<LiveSetup | undefined> {
  const exec = options.exec ?? defaultPolicyExec;
  return chantReadLiveSetup(dir, {
    ...(options.binary ? { binary: options.binary } : {}),
    exec: async (binary, args, at) => {
      const r = await exec(binary, args, at);
      return { code: r.status ?? 1, stdout: r.stdout, out: `${r.stdout}${r.stderr}` };
    },
  });
}

/** The lexicon's bucket check on a root's resolved store, with the root's backend block (the lexicon's rootBackendAttrs). */
export const checkStoreBucket = (dir: string, s: LiveStore, env: NodeJS.ProcessEnv = process.env): Promise<BucketOutcome> => chantCheckStoreBucket(s, rootBackendAttrs(dir), env);
