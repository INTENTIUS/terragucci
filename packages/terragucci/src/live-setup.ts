/**
 * The record store and estate choudoufu resolves for a live root
 * (choudoufu#2293), read from `choudoufu live-check -json`: its `estate`,
 * `estate_source` and `record_store` fields. choudoufu derives the store
 * from the backend block a live block ignores, and the estate from the
 * backend key, else the root's path, when the live block names neither, so
 * the answer is choudoufu's own and terragucci keeps no copy of the rules.
 *
 * A choudoufu release without those fields prints a `live-check -json`
 * document with no `estate_source`; then nothing is remembered, and every
 * reader falls back to the live block's own text (./detect.ts estateOf,
 * ./cdf-records.ts recordStoreOf), as before.
 *
 * Terragrunt units go through choudoufu's own Terragrunt support: the unit's
 * working directory holds the backend Terragrunt generated, and choudoufu
 * reads it there. Nothing here calls Terragrunt or reads its files.
 */
import { resolve } from "node:path";
import { backendBlock, estateOf, liveBody } from "./detect";
import { recordStoreOf, type RecordStore } from "./cdf-records";
import { chantBucketCheck, type ChantBucketReport, type ChantBucketTarget } from "./chant-next";
import { defaultPolicyExec, type PolicyExec } from "./report/policy";

/** Where choudoufu's estate name came from: the live block, the configuration's tags, the backend key, or the root's path. */
export type EstateSource = "explicit" | "tags" | "backend_key" | "root_path" | "none";

/** The record store choudoufu resolved, as `live-check -json` prints it. */
export interface LiveStore {
  /** `local`, `s3`, `gcs`, `azurerm` or `kubernetes`. */
  kind: string;
  /** The s3 or gcs bucket, `<account>/<container>` for azurerm, the namespace for kubernetes, the directory for local. */
  bucket: string;
  /** Where this estate's records go, with one trailing slash. */
  prefix: string;
  /** `record_store` (written by the author), `backend` (derived from the backend block) or `implied` (the local store). */
  source: string;
  /** `file:line` of the block that decided it. */
  declaredAt?: string;
  /** Why a backend that was there was not used. */
  note?: string;
}

/** What choudoufu resolves for one root. */
export interface LiveSetup {
  estate?: string;
  estateSource: string;
  store?: LiveStore;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

/**
 * The setup in a `live-check -json` document, or undefined when the document
 * is not JSON or comes from a choudoufu that does not print `estate_source`.
 */
export function parseLiveSetup(stdout: string): LiveSetup | undefined {
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (!doc || typeof doc !== "object" || typeof doc.estate_source !== "string") return undefined;
  const rs = doc.record_store && typeof doc.record_store === "object" ? (doc.record_store as Record<string, unknown>) : undefined;
  const kind = str(rs?.kind);
  const store: LiveStore | undefined = rs && kind
    ? {
        kind,
        bucket: str(rs.bucket) ?? "",
        prefix: str(rs.prefix) ?? "",
        source: str(rs.source) ?? "",
        ...(str(rs.declared_at) ? { declaredAt: str(rs.declared_at) } : {}),
        ...(str(rs.note) ? { note: str(rs.note) } : {}),
      }
    : undefined;
  const estate = str(doc.estate);
  return { ...(estate ? { estate } : {}), estateSource: doc.estate_source, ...(store ? { store } : {}) };
}

const known = new Map<string, LiveSetup>();

/** Keep what choudoufu resolved for a root's directory, for the readers below. */
export function rememberLiveSetup(dir: string, setup: LiveSetup): void {
  known.set(resolve(dir), setup);
}

/** What choudoufu resolved for a root's directory in this process, if it was read. */
export function knownLiveSetup(dir: string): LiveSetup | undefined {
  return known.get(resolve(dir));
}

/** For tests: forget every setup read so far. */
export function forgetLiveSetups(): void {
  known.clear();
}

/**
 * `choudoufu live-check -json <dir>` for one root, run in the directory, and
 * the setup it prints. Undefined when the binary prints none (an older
 * release, a root it cannot read, or no binary at all); the caller then reads
 * the live block's text. A root that live-check blocks still prints its
 * setup, so the exit status is not read.
 */
export async function readLiveSetup(dir: string, options: { binary?: string; exec?: PolicyExec } = {}): Promise<LiveSetup | undefined> {
  const at = resolve(dir);
  const had = known.get(at);
  if (had) return had;
  const exec = options.exec ?? defaultPolicyExec;
  let stdout: string;
  try {
    stdout = (await exec(options.binary ?? "choudoufu", ["live-check", "-json", at], at)).stdout;
  } catch {
    return undefined;
  }
  const setup = parseLiveSetup(stdout);
  if (setup) known.set(at, setup);
  return setup;
}

/** A live root's estate: choudoufu's resolved name when it was read, else the name the live block writes. */
export function resolvedEstate(dir: string): string | undefined {
  return knownLiveSetup(dir)?.estate ?? estateOf(dir).estate;
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

function backendAttrs(dir: string): Record<string, string> {
  const b = backendBlock(dir);
  return b && "attrs" in b ? b.attrs : {};
}

const STORE_FROM: Record<string, string> = {
  record_store: "from its record_store block",
  backend: "derived from its backend block",
  implied: "the local store, since no backend block gives one",
};

const ESTATE_FROM: Record<EstateSource, string> = {
  explicit: "named by its live block",
  tags: "from its tofu-estate tags",
  backend_key: "from the backend key",
  root_path: "from the root's path",
  none: "none resolves",
};

/** The store as one phrase: `s3 bucket "acme" under tofu-records/prod/`. */
export function storePhrase(s: LiveStore): string {
  if (s.kind === "local") return `the local directory ${s.bucket || ".tofu-records"} under ${s.prefix}`;
  if (s.kind === "azurerm") return `azurerm container ${s.bucket} under ${s.prefix}`;
  if (s.kind === "kubernetes") return `kubernetes namespace ${s.bucket} under ${s.prefix}`;
  return `${s.kind} bucket "${s.bucket}" under ${s.prefix}`;
}

/**
 * The line terragucci prints for a root's setup: where its records go, where
 * that came from, and its estate. choudoufu prints its own line on stderr at
 * each init and plan; this one goes in terragucci's log and reports.
 */
export function setupLine(root: string, setup: LiveSetup): string {
  const s = setup.store;
  const where = s ? `records in ${storePhrase(s)} (${STORE_FROM[s.source] ?? s.source}${s.declaredAt ? ` at ${s.declaredAt}` : ""})` : "no record store resolved";
  const estate = setup.estate ? `estate "${setup.estate}" (${ESTATE_FROM[setup.estateSource as EstateSource] ?? setup.estateSource})` : "no estate resolves";
  return `${root}: ${where}; ${estate}${s?.note ? `; ${s.note}` : ""}`;
}

/** The setup's store is the local directory, which is empty on every CI run. */
export const onLocalStore = (setup: LiveSetup): boolean => setup.store?.kind === "local";

/**
 * The bucket chant's check reads for a resolved store, or why there is none.
 * s3 takes the region from the backend block or the job, and an emulator's
 * endpoint and keys from the job; gcs an emulator from
 * STORAGE_EMULATOR_HOST; azurerm needs the subscription and resource group,
 * from the backend block or ARM_SUBSCRIPTION_ID.
 */
export function bucketTarget(dir: string, s: LiveStore, env: NodeJS.ProcessEnv = process.env): { target: ChantBucketTarget } | { skip: string } {
  const attrs = backendAttrs(dir);
  if (s.kind === "s3") {
    const region = attrs.region ?? env.AWS_REGION ?? env.AWS_DEFAULT_REGION;
    if (!region) return { skip: `no region: set region in the backend block or AWS_REGION` };
    const endpoint = env.AWS_ENDPOINT_URL_S3 ?? env.AWS_ENDPOINT_URL;
    const keys = env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY ? { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY, ...(env.AWS_SESSION_TOKEN ? { sessionToken: env.AWS_SESSION_TOKEN } : {}) } : undefined;
    if (endpoint && !keys) return { skip: `AWS_ENDPOINT_URL is set with no AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY` };
    return { target: { store: "s3", bucket: s.bucket, region, ...(endpoint ? { endpoint, credentials: keys } : {}) } };
  }
  if (s.kind === "gcs") {
    const emulator = env.STORAGE_EMULATOR_HOST;
    return { target: { store: "gcs", bucket: s.bucket, ...(emulator ? { endpoint: /^https?:\/\//.test(emulator) ? emulator : `http://${emulator}`, token: null } : {}) } };
  }
  if (s.kind === "azurerm") {
    const [account, container] = s.bucket.split("/");
    const subscriptionId = attrs.subscription_id ?? env.ARM_SUBSCRIPTION_ID;
    const resourceGroup = attrs.resource_group_name;
    if (!account || !container) return { skip: `the store names no storage account and container` };
    if (!subscriptionId || !resourceGroup) return { skip: `the bucket check needs the subscription and resource group: set resource_group_name in the backend block, and subscription_id there or ARM_SUBSCRIPTION_ID` };
    return { target: { store: "azblob", subscriptionId, resourceGroup, account, container } };
  }
  return { skip: `a ${s.kind} store has no bucket to check` };
}

/** What the bucket check said about one root's store. */
export type BucketOutcome =
  | { checked: ChantBucketReport }
  | { skipped: string };

/**
 * chant's shared bucket check (chant#4558) on a root's resolved store, when
 * the installed chant has it: the settings choudoufu refuses to open the
 * bucket without. It reads only. A store with no bucket, or a check that
 * cannot run, is skipped with the reason; nothing here throws.
 */
export async function checkStoreBucket(dir: string, s: LiveStore, env: NodeJS.ProcessEnv = process.env): Promise<BucketOutcome> {
  if (s.kind === "local") return { skipped: "the local store has no bucket" };
  const lib = await chantBucketCheck();
  if (!lib) return { skipped: "the installed chant has no bucket check" };
  const t = bucketTarget(dir, s, env);
  if ("skip" in t) return { skipped: t.skip };
  try {
    return { checked: await lib.checkBucket(t.target, { namespaces: s.prefix ? [s.prefix] : [] }) };
  } catch (e) {
    return { skipped: `the bucket could not be checked: ${(e as Error).message}` };
  }
}

/** The bucket check's outcome as lines: one for a correct bucket, else one per setting that did not pass, with its fix. */
export function bucketLines(root: string, outcome: BucketOutcome): string[] {
  if ("skipped" in outcome) return [`${root}: bucket not checked: ${outcome.skipped}`];
  const r = outcome.checked;
  if (r.correct) return [`${root}: bucket ${r.bucket} has every setting choudoufu needs (${r.settings.map((f) => f.setting).join(", ")})`];
  return r.settings
    .filter((f) => f.verdict !== "ok")
    .map((f) => `${root}: bucket ${r.bucket}: ${f.setting} ${f.verdict === "unreadable" ? "could not be read" : "fails"}: ${f.found}${f.unwaivable ? " (no allow_insecure reaches this one)" : ""}${f.fix ? `; fix: ${f.fix}` : ""}`);
}
