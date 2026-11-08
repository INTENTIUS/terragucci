/**
 * The client for a `reports` block: `reports.bucket`'s scheme picks the
 * store, and the job's environment gives the identity. The client is
 * chant's (`@intentius/chant/object-store`, chant#4554), made by chant's
 * `storeFromEnv` with terragucci's setting names.
 */
import { storeFromEnv as chantStoreFromEnv, type ObjectStore, type StoreFetch } from "@intentius/chant/object-store";
import { STORE_WORDS } from "./object-store";

export function storeFromEnv(reports: { bucket: string; endpoint?: string; role?: string }, env: NodeJS.ProcessEnv = process.env, fetchFn?: StoreFetch): ObjectStore {
  return chantStoreFromEnv(
    {
      bucket: reports.bucket,
      ...(reports.endpoint ? { endpoint: reports.endpoint } : {}),
      ...(reports.role ? { role: reports.role } : {}),
      ...STORE_WORDS,
    },
    env,
    fetchFn,
  );
}
