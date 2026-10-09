/**
 * Checking an attested module release: the release ledger holds a record of
 * it, and its signature, provenance and SBOM verify against the publisher's
 * public key over the bytes the tag names now.
 *
 * The bundles are cosign's, made with a key and no transparency log
 * (`sign-blob` and `attest-blob --bundle`). They are checked here with
 * node:crypto, as seal.ts checks an ssh signature, so a job that verifies
 * needs no cosign:
 *
 * - a signature bundle's `base64Signature` is an ECDSA signature over the
 *   release's bytes (the module archive of a git tag, the manifest of an OCI
 *   tag), whose SHA-256 is the release digest;
 * - an attestation bundle's `base64Signature` is a DSSE envelope whose
 *   signature covers the envelope's pre-authentication encoding, and whose
 *   payload is an in-toto statement naming the release digest as its subject.
 */
import { createHash, createPublicKey, verify, type KeyObject } from "node:crypto";
import { ATTEST_FILES, type Ledger } from "./ledger";

export const PROVENANCE_TYPE = "https://slsa.dev/provenance/v1";
export const SPDX_TYPE = "https://spdx.dev/Document";
const IN_TOTO = "application/vnd.in-toto+json";

/** The release being checked: the module, its version, the bytes its tag names now and the commit it says it was cut from. */
export interface ReleaseSubject {
  /** The module's path in the publishing repo, the ledger's component. */
  module: string;
  version: string;
  /** The bytes whose digest was signed. */
  bytes: Buffer;
  /** The commit the tag was cut from, when the tag names one (a git tag). */
  commit?: string;
  /**
   * Match the ledger's component by its last path segment: an OCI source
   * names the module `service`, which the publishing repo records as
   * `modules/service`.
   */
  byName?: boolean;
}

export interface VerifiedRelease {
  digest: string;
  /** The commit the ledger records the release was cut from. */
  commit: string;
  checked: Array<"ledger" | "signature" | "provenance" | "sbom">;
}

export class AttestationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttestationError";
  }
}

export function publicKey(pem: string, where: string): KeyObject {
  try {
    const key = createPublicKey(pem);
    if (key.asymmetricKeyType !== "ec") throw new Error(`a ${key.asymmetricKeyType} key`);
    return key;
  } catch (e) {
    throw new AttestationError(`${where} is not a cosign public key (${(e as Error).message.split("\n")[0]})`);
  }
}

const sha256 = (data: Buffer): string => `sha256:${createHash("sha256").update(data).digest("hex")}`;

/** The pre-authentication encoding a DSSE signature covers. */
export function pae(payloadType: string, payload: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`DSSEv1 ${Buffer.byteLength(payloadType)} ${payloadType} ${payload.length} `), payload]);
}

interface Statement {
  _type?: string;
  predicateType?: string;
  subject?: { name?: string; digest?: { sha256?: string } }[];
  predicate?: Record<string, unknown>;
}

function bundleSignature(text: string | undefined, what: string): Buffer {
  if (!text) throw new AttestationError(`the ledger holds no ${what}`);
  try {
    const sig = (JSON.parse(text) as { base64Signature?: unknown }).base64Signature;
    if (typeof sig !== "string" || !sig) throw new Error("no base64Signature");
    return Buffer.from(sig, "base64");
  } catch (e) {
    throw new AttestationError(`the ${what} is not a cosign bundle (${(e as Error).message})`);
  }
}

/** Check a `sign-blob` bundle over `bytes`. */
export function verifySignature(bundle: string | undefined, bytes: Buffer, key: KeyObject): void {
  const sig = bundleSignature(bundle, "signature");
  if (!verify("sha256", bytes, key, sig)) throw new AttestationError("the signature does not verify against the trusted key over these bytes");
}

/** Check an `attest-blob` bundle: its envelope's signature, then that its statement is of `type` and names `digest`. Returns the statement. */
export function verifyAttestation(bundle: string | undefined, digest: string, type: string, key: KeyObject, what: string): Statement {
  const raw = bundleSignature(bundle, what);
  let envelope: { payloadType?: string; payload?: string; signatures?: { sig?: string }[] };
  try {
    envelope = JSON.parse(raw.toString("utf-8"));
  } catch {
    throw new AttestationError(`the ${what} holds no DSSE envelope`);
  }
  if (envelope.payloadType !== IN_TOTO || typeof envelope.payload !== "string") throw new AttestationError(`the ${what} is not an in-toto statement`);
  const payload = Buffer.from(envelope.payload, "base64");
  const signed = (envelope.signatures ?? []).some((s) => typeof s.sig === "string" && verify("sha256", pae(envelope.payloadType!, payload), key, Buffer.from(s.sig, "base64")));
  if (!signed) throw new AttestationError(`the ${what} does not verify against the trusted key`);
  const statement = JSON.parse(payload.toString("utf-8")) as Statement;
  if (statement.predicateType !== type) throw new AttestationError(`the ${what} is a ${statement.predicateType ?? "statement of no type"}, not ${type}`);
  const hex = digest.replace(/^sha256:/, "");
  if (!(statement.subject ?? []).some((s) => s.digest?.sha256 === hex)) throw new AttestationError(`the ${what} is about other bytes than these (${digest})`);
  return statement;
}

/** The commit a provenance statement says the release was built from: its `sourceRef`. */
function sourceCommit(statement: Statement): string | undefined {
  const ext = (statement.predicate?.buildDefinition as { externalParameters?: { sourceRef?: unknown } } | undefined)?.externalParameters;
  return typeof ext?.sourceRef === "string" ? ext.sourceRef : undefined;
}

/**
 * Check one release against a ledger and a key. Throws AttestationError with
 * the reason when any part fails: the bytes are not in a record for the
 * module (unrecorded, or changed since), a record names another commit than
 * the tag, or a bundle is missing or does not verify.
 */
export function verifyRelease(subject: ReleaseSubject, ledger: Ledger, key: KeyObject): VerifiedRelease {
  const digest = sha256(subject.bytes);
  const ofModule = (component: string): boolean => (subject.byName ? component.split("/").pop() === subject.module : component === subject.module);
  const records = ledger.records.filter((r) => ofModule(r.component) && r.digest === digest);
  if (records.length === 0) {
    const others = ledger.records.filter((r) => ofModule(r.component)).length;
    throw new AttestationError(
      others
        ? `${digest} is not in the release ledger (${ledger.from}): the ledger records ${others} release${others === 1 ? "" : "s"} of ${subject.module} and none has these bytes, so the tag was not written by an attested publish or was changed since`
        : `the release ledger (${ledger.from}) records no release of ${subject.module}`,
    );
  }
  const record = subject.commit ? records.find((r) => r.gitSha === subject.commit) : records[records.length - 1];
  if (!record) throw new AttestationError(`the ledger records ${digest} from ${records.map((r) => r.gitSha.slice(0, 12)).join(", ")}, and the tag names ${subject.commit!.slice(0, 12)}`);
  verifySignature(ledger.file(digest, ATTEST_FILES.signature), subject.bytes, key);
  const provenance = verifyAttestation(ledger.file(digest, ATTEST_FILES.provenance), digest, PROVENANCE_TYPE, key, "provenance");
  const built = sourceCommit(provenance);
  if (built !== record.gitSha) throw new AttestationError(`the provenance says the release was built from ${built ?? "no commit"}, and the ledger records ${record.gitSha}`);
  verifyAttestation(ledger.file(digest, ATTEST_FILES.sbomAttestation), digest, SPDX_TYPE, key, "SBOM attestation");
  return { digest, commit: record.gitSha, checked: ["ledger", "signature", "provenance", "sbom"] };
}
