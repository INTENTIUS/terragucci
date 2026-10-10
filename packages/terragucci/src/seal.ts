/**
 * Sealed approvals for the tf-apply wave gates: the part of chant's
 * `identity.gates` rule (chant#3163) a wave needs, small enough for the
 * bundle.
 *
 * Under `approval: sealed` (./approval.ts) a wave gate counts only an
 * approval whose seal, made by `chant approve --sign`, verifies for its
 * approver against the signers file at base (`.chant/allowed_signers`, or the
 * path `.chant/trust.json` names). An unsigned approval, one signed by a key
 * the file does not list for the approver, or one whose signed fields were
 * edited after sealing, does not count. With no signers file at base, no
 * approval counts. Base is the commit before the one being applied
 * (`sealRule`).
 *
 * A seal is an ssh signature (the SSHSIG format `ssh-keygen -Y sign` makes)
 * in the `chant-gate` namespace, over the lines chant's `gateSealPayload`
 * joins. It is checked here with node:crypto, so the apply job needs no
 * ssh-keygen. Unlike chant, this does not walk the signers file's history:
 * it trusts the file as the base commit holds it.
 */
import { spawnSync } from "node:child_process";
import { createHash, createPublicKey, verify } from "node:crypto";
import { ConfigError } from "./config";

/** The ssh signature namespace of a gate approval's seal. */
export const GATE_SEAL_NAMESPACE = "chant-gate";
/** Where the signers are when `.chant/trust.json` names no other path. */
export const SIGNERS_PATH = ".chant/allowed_signers";

/** The fields of a resolution line a seal covers. */
export interface SealedApproval {
  op: string;
  gate: string;
  environment?: string;
  planDigest?: string;
  resolvedBy: string;
  relayedBy?: string;
  timestamp: string;
  seal?: { signer?: unknown; key?: unknown; signature?: unknown } | null;
}

export interface Signer {
  /** Normalised, as chant compares them. */
  principals: string[];
  /** The public key blob, ssh wire format. */
  key: Buffer;
  /** The `namespaces="..."` option, when the line restricts the key. */
  namespaces?: string[];
}

/** The rule at base: the gates `identity.gates` names, and the signers to check a seal against (null: no signers file). */
export interface SealRule {
  gates: Set<string>;
  signers: Signer[] | null;
  signersPath: string;
}

const norm = (s: string): string => s.normalize("NFKC").trim().toLowerCase();

/** The key types an allowed_signers line may hold. */
const KEY_TYPE = /^(ssh-(ed25519|rsa)|ecdsa-sha2-nistp(256|384|521)|sk-(ssh-ed25519|ecdsa-sha2-nistp256)@openssh\.com)$/;

/**
 * The usable lines of an allowed_signers file. As chant does, a line with a
 * validity window, a `cert-authority` line and a principal pattern are left
 * out: each depends on something the file does not pin down.
 */
export function parseSigners(text: string): Signer[] {
  const out: Signer[] = [];
  for (const line of text.split("\n")) {
    const f = line.trim().match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];
    if (f[0]?.startsWith("#")) continue;
    const opts = KEY_TYPE.test(f[1] ?? "") ? "" : (f[1] ?? "");
    const blob = opts ? f[3] : f[2];
    if (!KEY_TYPE.test((opts ? f[2] : f[1]) ?? "") || !blob || /valid-|cert-authority/i.test(opts) || /[*?!]/.test(f[0]!)) continue;
    const ns = /namespaces="([^"]*)"/i.exec(opts)?.[1];
    out.push({ principals: f[0]!.replace(/"/g, "").split(",").map(norm), key: Buffer.from(blob, "base64"), ...(ns !== undefined ? { namespaces: ns.split(",") } : {}) });
  }
  return out;
}

/** The bytes a gate approval's seal signs: chant's `gateSealPayload`. */
export function gateSealPayload(a: SealedApproval): Buffer {
  const relay = a.relayedBy !== undefined ? `\nrelayed-by ${a.relayedBy}` : "";
  return Buffer.from(`${a.op}\n${a.gate}\n${a.environment ?? ""}\n${a.planDigest ?? ""}\n${a.resolvedBy}\n${a.timestamp}${relay}`);
}

// ── SSHSIG ───────────────────────────────────────────────────────────────

/** A reader over ssh wire format: `take(n)` bytes, or `take()` one length-prefixed string. */
function reader(buf: Buffer): (n?: number) => Buffer {
  let at = 0;
  const take = (n?: number): Buffer => {
    const len = n ?? take(4).readUInt32BE(0);
    if (at + len > buf.length) throw new Error("short");
    return buf.subarray(at, (at += len));
  };
  return take;
}

const wire = (b: Buffer | string): Buffer => {
  const v = Buffer.from(b);
  const n = Buffer.alloc(4);
  n.writeUInt32BE(v.length);
  return Buffer.concat([n, v]);
};
const hash = (alg: string, b: Buffer): Buffer => createHash(alg).update(b).digest();
const b64 = (b: Buffer): string => b.subarray(b[0] === 0 ? 1 : 0).toString("base64url");

/**
 * Whether `armored` is an SSHSIG over `message` in `namespace` by one of
 * `keys`. Ed25519 (with or without a security key) and RSA keys verify; any
 * other key type does not. Never throws.
 */
export function verifySshSignature(armored: string, message: Buffer, namespace: string, keys: readonly Buffer[]): boolean {
  try {
    const body = /-----BEGIN SSH SIGNATURE-----([^-]*)-----END SSH SIGNATURE-----/.exec(armored)?.[1] ?? "";
    const take = reader(Buffer.from(body, "base64"));
    if (take(6).toString() !== "SSHSIG" || take(4).readUInt32BE(0) !== 1) return false;
    const [pk, ns, reserved, alg, sigWire] = [take(), take(), take(), take().toString(), take()];
    if (ns.toString() !== namespace || !/^sha(256|512)$/.test(alg) || !keys.some((k) => k.equals(pk))) return false;
    let data = Buffer.concat([Buffer.from("SSHSIG"), wire(ns), wire(reserved), wire(alg), wire(hash(alg, message))]);
    const key = reader(pk);
    const type = key().toString();
    const sig = reader(sigWire);
    const sigType = sig().toString();
    const raw = sig();
    if (type === "ssh-rsa") {
      const [e, n] = [key(), key()];
      const rsa = createPublicKey({ key: { kty: "RSA", e: b64(e), n: b64(n) }, format: "jwk" });
      return /^rsa-sha2-(256|512)$/.test(sigType) && verify(`sha${sigType.slice(9)}`, data, rsa, raw);
    }
    if (sigType !== type || !/^(ssh|sk-ssh)-ed25519/.test(type)) return false;
    const ed = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: key().toString("base64url") }, format: "jwk" });
    if (type.startsWith("sk-")) {
      // A security key signs its application, flags and counter, then the data; ssh-keygen requires the touch flag.
      const flags = sig(1);
      if (!(flags[0]! & 1)) return false;
      data = Buffer.concat([hash("sha256", key()), flags, sig(4), hash("sha256", data)]);
    }
    return verify(null, data, ed, raw);
  } catch {
    return false;
  }
}

// ── the rule at base ─────────────────────────────────────────────────────

/**
 * Why this approval does not count toward a gate that needs a seal, or null
 * when it does: its seal verifies for its approver against the signers.
 */
export function sealRefusal(signers: Signer[] | null, signersPath: string, a: SealedApproval): string | null {
  if (!signers) return `there is no signers file (${signersPath}) at base to check a seal against`;
  const seal = a.seal;
  if (!seal || typeof seal.signature !== "string") return `the approval by ${a.resolvedBy} is not signed (terragucci approve --sign)`;
  if (typeof seal.signer !== "string" || norm(seal.signer) !== norm(a.resolvedBy)) return `the seal is by ${String(seal.signer)}, and the approver is ${a.resolvedBy}`;
  const keys = signers
    .filter((s) => s.principals.includes(norm(a.resolvedBy)) && (!s.namespaces || s.namespaces.some((n) => n === GATE_SEAL_NAMESPACE || n === "*")))
    .map((s) => s.key);
  if (keys.length === 0) return `${a.resolvedBy} has no key in ${signersPath} at base`;
  return verifySshSignature(seal.signature, gateSealPayload(a), GATE_SEAL_NAMESPACE, keys)
    ? null
    : `the seal by ${a.resolvedBy} does not verify against ${signersPath} at base`;
}

/** The first `parent` line of a commit object; a shallow clone keeps the line even when it lacks the parent itself. */
const firstParent = (commit: string): string | undefined => /^parent ([0-9a-f]{40,64})$/m.exec(commit.split("\n\n")[0] ?? "")?.[1];

/**
 * The gates `chant.workspace.json` names under `identity.gates`, and the
 * signers file, both as they stand at base.
 *
 * Base is the first parent of the commit being applied (HEAD): the default
 * branch as it stood before the merge, so a merge that adds a signer, moves
 * the signers file or drops a gate does not judge its own apply. A shallow
 * checkout fetches that one commit. A root commit has no parent and is read
 * as it is. `at` names another base, for a caller that applies something
 * other than the default branch's own commit.
 */
export function sealRule(repo: string, at?: string): SealRule {
  const git = (args: string[]) => spawnSync("git", args, { cwd: repo, encoding: "utf-8" });
  const base = at ?? baseCommit(repo);
  const show = (path: string): string | undefined => {
    const r = git(["show", `${base}:${path}`]);
    return r.status === 0 ? r.stdout : undefined;
  };
  const json = (path: string): { identity?: { gates?: Record<string, unknown> }; schema?: unknown; signers?: unknown } => {
    const text = show(path);
    try {
      return text === undefined ? {} : JSON.parse(text);
    } catch {
      throw new ConfigError(`${path} at base is not valid JSON, so the gate cannot be decided`);
    }
  };
  const gates = new Set(Object.keys(json("chant.workspace.json").identity?.gates ?? {}));
  // chant reads trust.json only with "schema": 1, and otherwise checks seals
  // against no signers at all; the apply job reads it the same way.
  const trust = json(".chant/trust.json");
  if (show(".chant/trust.json") !== undefined && trust.schema !== 1) {
    return { gates, signers: null, signersPath: `.chant/trust.json, which needs "schema": 1 to name one` };
  }
  const signersPath = typeof trust.signers === "string" ? trust.signers : SIGNERS_PATH;
  const text = show(signersPath);
  return { gates, signers: text === undefined ? null : parseSigners(text), signersPath };
}

/** The first parent of HEAD, fetched when the checkout is shallow; HEAD itself when it has none. Throws when it cannot be read. */
export function baseCommit(repo: string): string {
  const git = (args: string[]) => spawnSync("git", args, { cwd: repo, encoding: "utf-8" });
  const head = git(["rev-parse", "--verify", "-q", "HEAD^{commit}"]);
  const sha = head.stdout.trim();
  if (head.status !== 0 || !sha) throw new ConfigError(`${repo} has no commit checked out, so the gate cannot be decided`);
  const parent = firstParent(git(["cat-file", "commit", sha]).stdout);
  if (!parent) return sha;
  const has = () => git(["cat-file", "-e", `${parent}^{commit}`]).status === 0;
  if (!has()) git(["fetch", "-q", "--depth=1", "origin", parent]);
  if (!has()) throw new ConfigError(`cannot fetch ${parent.slice(0, 12)}, the commit before this one, so the gate cannot be decided`);
  return parent;
}
