/**
 * A test-only SSHSIG signer over an Ed25519 key, the format `ssh-keygen -Y
 * sign` writes (PROTOCOL.sshsig), so a test can seal an approval the way
 * `chant approve --sign` does without ssh-keygen.
 */
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";

export interface TestKey {
  privateKey: KeyObject;
  /** The ssh wire-format public key blob. */
  blob: Buffer;
}

const wire = (b: Buffer | string): Buffer => {
  const v = Buffer.from(b);
  const n = Buffer.alloc(4);
  n.writeUInt32BE(v.length);
  return Buffer.concat([n, v]);
};

export function sshKey(): TestKey {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = Buffer.from(publicKey.export({ format: "jwk" }).x!, "base64url");
  return { privateKey, blob: Buffer.concat([wire("ssh-ed25519"), wire(raw)]) };
}

/** An allowed_signers line for `principal`. */
export const signerLine = (principal: string, key: TestKey, options = ""): string =>
  `${principal} ${options ? `${options} ` : ""}ssh-ed25519 ${key.blob.toString("base64")}`;

/** The armored SSHSIG over `message` in `namespace`. */
export function sshsig(key: TestKey, message: Buffer, namespace: string): string {
  const alg = "sha512";
  const signed = Buffer.concat([Buffer.from("SSHSIG"), wire(namespace), wire(""), wire(alg), wire(createHash(alg).update(message).digest())]);
  const sig = Buffer.concat([wire("ssh-ed25519"), wire(sign(null, signed, key.privateKey))]);
  const version = Buffer.alloc(4);
  version.writeUInt32BE(1);
  const blob = Buffer.concat([Buffer.from("SSHSIG"), version, wire(key.blob), wire(namespace), wire(""), wire(alg), wire(sig)]);
  const lines = blob.toString("base64").match(/.{1,70}/g)!.join("\n");
  return `-----BEGIN SSH SIGNATURE-----\n${lines}\n-----END SSH SIGNATURE-----\n`;
}
