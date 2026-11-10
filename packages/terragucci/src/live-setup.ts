/**
 * The record store and estate choudoufu resolves for a live root
 * (choudoufu#2293), read from `choudoufu live-check -json`. The reading, the
 * setup line and the bucket check are the terraform lexicon's
 * (`@intentius/chant-lexicon-terraform/live-roots`, chant#4910). What stays
 * here is terragucci's: live-check run as the policy engine runs, with the
 * job's environment less its forge tokens, the bucket check given the root's
 * backend block, and the record store ./cdf-records.ts reads.
 *
 * A choudoufu release without those fields prints a `live-check -json`
 * document with no `estate_source`; then nothing is remembered, and every
 * reader falls back to the live block's own text (the lexicon's estateOf,
 * ./cdf-records.ts recordStoreOf), as before.
 */
import { resolve } from "node:path";
import { checkStoreBucket as chantCheckStoreBucket, knownLiveSetup, readLiveSetup as chantReadLiveSetup, type BucketOutcome, type LiveSetup, type LiveStore } from "@intentius/chant-lexicon-terraform/live-roots";
import { backendBlock, liveBody } from "./detect";
import { recordStoreOf, type RecordStore } from "./cdf-records";
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

/**
 * The record store of a live root's estate, as ./cdf-records.ts reads it:
 * choudoufu's resolved store when it was read, else the live block's
 * `record_store`. Undefined when the root has no live block.
 */
export function resolvedRecordStore(dir: string, estate: string): RecordStore | undefined {
  if (liveBody(dir) === undefined) return undefined;
  const s = knownLiveSetup(dir)?.store;
  if (!s) return recordStoreOf(dir, estate);
  if (s.kind === "local") return { kind: "local", dir: resolve(dir, s.bucket || ".tofu-records"), prefix: s.prefix };
  if (s.kind === "s3" && s.bucket) {
    // The JSON carries no region: the record_store block's, else the backend block's, else the job's.
    const written = recordStoreOf(dir, estate);
    const region = (written?.kind === "s3" ? written.region : undefined) ?? backendAttrs(dir).region;
    return { kind: "s3", bucket: s.bucket, prefix: s.prefix, ...(region ? { region } : {}) };
  }
  return { kind: "unread", name: s.kind };
}

/** A root's backend block's string attributes, for the bucket check's region, subscription and resource group. */
export function backendAttrs(dir: string): Record<string, string> {
  const b = backendBlock(dir);
  return b && "attrs" in b ? b.attrs : {};
}

/** The lexicon's bucket check on a root's resolved store, with the root's backend block. */
export const checkStoreBucket = (dir: string, s: LiveStore, env: NodeJS.ProcessEnv = process.env): Promise<BucketOutcome> => chantCheckStoreBucket(s, backendAttrs(dir), env);
