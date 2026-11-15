/**
 * Keyless module attestation: `modules.attest: { identity: oidc }`.
 *
 * The publish job holds no signing key. It trades its OIDC token for a
 * short-lived certificate from a Fulcio certificate authority, signs with a
 * key made for the run, and has each signature timestamped by an RFC 3161
 * authority, as chant signs check evidence (`@intentius/chant/workspace/trust/keyless`).
 * The bundles that go in the release ledger carry the certificate chain and
 * the timestamp, so a consumer verifies offline against two things it
 * commits: a sigstore trusted root, and the one identity it trusts (the
 * OIDC issuer and the certificate subject, which names the repository, the
 * workflow file and the ref).
 *
 * Nothing is uploaded to a transparency log. Fulcio sees the job's token,
 * which names the repository, workflow and ref; the timestamp authority sees
 * a hash of each signature. The module's name and digest reach neither.
 * Every network call goes through an injected `fetch`.
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import {
  DEFAULT_FULCIO_URL,
  DEFAULT_SIGNING_AUDIENCE,
  DEFAULT_TIMESTAMP_URL,
  keylessSignature,
  requestCertificate,
  signingToken,
  type KeylessCertificate,
} from "@intentius/chant/workspace/trust/keyless";
import { ciRunnerIdentity, DEFAULT_TRUSTED_ROOT_PATH } from "@intentius/chant/workspace/trust/runner-identity";
import { ConfigError, forgeFromHost, type ForgeName, type KeylessAttest, type ModulesSettings } from "../config";
import { hostOfRemote } from "../detect";
import { pathOfRemote } from "../identities";
import { signingWorkflow, defaultBranchOf } from "../trust";
import { sha256 } from "./archive";
import type { Signer } from "./attest";
import { AttestationError, keylessTrust, pae, type KeylessTrust } from "./verify";

export { DEFAULT_TRUSTED_ROOT_PATH };

const IN_TOTO = "application/vnd.in-toto+json";
const TYPE_URI = { slsaprovenance1: "https://slsa.dev/provenance/v1", spdxjson: "https://spdx.dev/Document" } as const;

/** `modules.attest` as a keyless setting, or undefined when it is off or signs with a key. */
export function keylessSetting(attest: ModulesSettings["attest"]): KeylessAttest | undefined {
  return attest && typeof attest === "object" && "identity" in attest && attest.identity === "oidc" ? attest : undefined;
}

/** The trusted root's path in the repo for a keyless setting. */
export const trustedRootPath = (s: { trusted_root?: string }): string => s.trusted_root ?? DEFAULT_TRUSTED_ROOT_PATH;

export interface SigningIdentity {
  issuer: string;
  subject: string;
}

/**
 * The identity the publish job's certificate carries: `issuer` and `subject`
 * when the setting names them, else the generated workflow's on this repo's
 * forge, at the default branch. A forge the origin's host does not name (a
 * self-hosted one) has no derived identity, so the setting names it.
 */
export function signingIdentity(repo: string, s: KeylessAttest, origin: string | undefined, defaultBranch = defaultBranchOf(repo), forge?: ForgeName): SigningIdentity {
  if (s.issuer && s.subject) return { issuer: s.issuer, subject: s.subject };
  const host = origin ? hostOfRemote(origin) : undefined;
  const f = forge ?? (host ? forgeFromHost(host) : undefined);
  const repository = origin ? pathOfRemote(origin) : undefined;
  if (!f || f === "forgejo" || !repository || !host) {
    throw new ConfigError(`modules.attest.identity: oidc cannot work out the publish job's identity from ${origin ? `the origin ${origin}` : "an origin that is not set"}; set modules.attest.issuer and modules.attest.subject, the OIDC issuer and the certificate subject of the publish job`);
  }
  const server = `https://${host}`;
  const id = ciRunnerIdentity({ forge: f, repository, workflow: signingWorkflow(f), ref: `refs/heads/${defaultBranch}`, ...(host === "github.com" || host === "gitlab.com" ? {} : { server, ...(f === "github" ? { issuer: `${server}/_services/token` } : {}) }) });
  return { issuer: s.issuer ?? id.issuer, subject: s.subject ?? id.subject };
}

export interface KeylessSignerOptions {
  audience?: string;
  fulcio?: string;
  timestamp?: string;
  fetch?: typeof fetch;
}

/**
 * The signer a keyless publish job uses. One certificate is requested, on the
 * first signature, and signs everything the job makes; each signature is
 * timestamped on its own. A test hands in a fake `fetch` (chant's
 * `sigstoreFake`), so no real authority is reached.
 *
 * It does not attach to an OCI manifest: the signature and the attestations
 * the consumer checks are the ledger's, which are bundles with the
 * certificate in them. A cosign-keyless attachment needs a certificate flow
 * of cosign's own, and would be a second signature for the same bytes.
 */
export function keylessSigner(env: NodeJS.ProcessEnv = process.env, o: KeylessSignerOptions = {}): Signer {
  const fetchFn = o.fetch ?? fetch;
  const audience = o.audience ?? DEFAULT_SIGNING_AUDIENCE;
  const tsa = o.timestamp ?? DEFAULT_TIMESTAMP_URL;
  let cert: Promise<KeylessCertificate> | undefined;
  const certificate = (): Promise<KeylessCertificate> =>
    (cert ??= (async () => {
      try {
        return await requestCertificate(await signingToken(env, audience, fetchFn), o.fulcio ?? DEFAULT_FULCIO_URL, fetchFn);
      } catch (e) {
        throw new ConfigError(`modules.attest signs with the job's OIDC identity and could not get a certificate: ${(e as Error).message}`);
      }
    })());
  return {
    async signBlob(blob) {
      const bytes = readFileSync(blob);
      const k = await keylessSignature(bytes, await certificate(), tsa, fetchFn);
      return JSON.stringify({ base64Signature: k.sig, keyless: { keyid: k.keyid, certificates: k.certificates, timestamp: k.timestamp } });
    },
    async attestBlob(blob, predicate, type) {
      const statement = {
        _type: "https://in-toto.io/Statement/v0.1",
        predicateType: TYPE_URI[type],
        subject: [{ name: basename(blob), digest: { sha256: sha256(readFileSync(blob)).slice(7) } }],
        predicate: JSON.parse(readFileSync(predicate, "utf-8")),
      };
      const payload = Buffer.from(JSON.stringify(statement));
      const k = await keylessSignature(pae(IN_TOTO, payload), await certificate(), tsa, fetchFn);
      const envelope = { payloadType: IN_TOTO, payload: payload.toString("base64"), signatures: [k] };
      return JSON.stringify({ base64Signature: Buffer.from(JSON.stringify(envelope)).toString("base64") });
    },
  };
}

/**
 * The trust a keyless setting verifies this repo's releases against: its
 * signing identity and the trusted root file in the repo. `read` gives a
 * repo file's text (at the base, for a check that must not take a pull
 * request's word). Throws a ConfigError when the root is not there, and an
 * AttestationError when it is not a trusted root.
 */
export function ownKeylessTrust(repo: string, s: KeylessAttest, origin: string | undefined, read: (path: string) => string | undefined): KeylessTrust {
  const path = trustedRootPath(s);
  const text = read(path);
  if (text === undefined) throw new ConfigError(`modules.attest signs keyless and verifies each release against the sigstore trusted root at ${path}, which is not in the repo; commit sigstore's trusted_root.json there (or name another path in modules.attest.trusted_root)`);
  const id = signingIdentity(repo, s, origin);
  return keylessTrust({ ...id, trustedRoot: text, trustedRootPath: path });
}

/** A trusted publisher's identity as `modules.trusted` names it, with the trusted root read from the repo. */
export function trustedKeylessTrust(t: { identity: { issuer: string; subject: string }; trusted_root?: string }, whose: string, read: (path: string) => string | undefined): KeylessTrust {
  const path = trustedRootPath(t);
  const text = read(path);
  if (text === undefined) throw new AttestationError(`${whose} sigstore trusted root ${path} is not in the repo`);
  return keylessTrust({ ...t.identity, trustedRoot: text, trustedRootPath: path });
}
