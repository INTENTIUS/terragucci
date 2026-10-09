/** A cosign-shaped signer for tests: an EC P-256 key pair, and bundles as cosign 2's `sign-blob` and `attest-blob --bundle` write them with a key and no tlog. */
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type { Signer } from "../src/publish/attest";
import { sha256 } from "../src/publish/archive";
import { pae } from "../src/publish/verify";

export type Pair = { privateKey: KeyObject; pem: string };
export const keyPair = (): Pair => {
  const { privateKey, publicKey: pub } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return { privateKey, pem: pub.export({ type: "spki", format: "pem" }).toString() };
};

export const TYPE_URI = { slsaprovenance1: "https://slsa.dev/provenance/v1", spdxjson: "https://spdx.dev/Document" } as const;

export function testSigner(key: KeyObject): Signer & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async signBlob(blob) {
      calls.push("sign-blob");
      return JSON.stringify({ base64Signature: sign("sha256", readFileSync(blob), key).toString("base64") });
    },
    async attestBlob(blob, predicate, type) {
      calls.push(`attest-blob ${type}`);
      const statement = {
        _type: "https://in-toto.io/Statement/v0.1",
        predicateType: TYPE_URI[type],
        subject: [{ name: basename(blob), digest: { sha256: sha256(readFileSync(blob)).slice(7) } }],
        predicate: JSON.parse(readFileSync(predicate, "utf-8")),
      };
      const payload = Buffer.from(JSON.stringify(statement));
      const envelope = { payloadType: "application/vnd.in-toto+json", payload: payload.toString("base64"), signatures: [{ keyid: "", sig: sign("sha256", pae("application/vnd.in-toto+json", payload), key).toString("base64") }] };
      return JSON.stringify({ base64Signature: Buffer.from(JSON.stringify(envelope)).toString("base64") });
    },
  };
}

