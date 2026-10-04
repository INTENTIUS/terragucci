/**
 * Provider bumps: a root's provider version lives in its `.terraform.lock.hcl`,
 * so a provider rolls out by moving that file a wave at a time.
 *
 * The lock file holds hashes a text edit cannot make, so the binary writes it:
 * `providers lock` for the one provider, with an override file that holds the
 * provider at exactly the new version while it runs. An exact `version`
 * constraint in the root's `required_providers` that names the old version
 * moves with it, or the next `init` would refuse the lock file. The new lock
 * file is re-read: the provider must be at the new version and every other
 * provider where it was, or nothing is written.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";

export const LOCK_FILE = ".terraform.lock.hcl";

/** The file a lock edit writes beside the root's own while the binary runs. Terraform merges `*_override.tf` over the rest. */
const OVERRIDE = "terragucci_rollout_override.tf";

/** Every provider in a lock file, by its full address, with its version. */
export function readLock(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of text.matchAll(/provider\s+"([^"]+)"\s*\{([^}]*)\}/g)) {
    const v = /\bversion\s*=\s*"([^"]+)"/.exec(m[2]!);
    if (v) out.set(m[1]!, v[1]!);
  }
  return out;
}

/** Whether a lock file's full address (`registry.opentofu.org/hashicorp/aws`) is the provider asked for. */
export function namesProvider(address: string, wanted: string): boolean {
  const w = wanted.toLowerCase();
  const a = address.toLowerCase();
  return a === w || a.endsWith(`/${w}`);
}

/** The lock file's entry for the provider, or undefined. */
export function lockedProvider(lock: Map<string, string>, wanted: string): { address: string; version: string } | undefined {
  for (const [address, version] of lock) if (namesProvider(address, wanted)) return { address, version };
  return undefined;
}

function tfFiles(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".tf") && f !== OVERRIDE).sort() : [];
}

/** The local name a root gives the provider in `required_providers`, or its type when it declares none. */
function localName(dir: string, address: string): string {
  const source = address.split("/").slice(-2).join("/").toLowerCase();
  for (const f of tfFiles(dir)) {
    for (const m of readFileSync(join(dir, f), "utf-8").matchAll(/([A-Za-z_][\w-]*)\s*=\s*\{([^{}]*)\}/g)) {
      const s = /\bsource\s*=\s*"([^"]+)"/.exec(m[2]!)?.[1]?.toLowerCase();
      if (s && (s === source || s.endsWith(`/${source}`))) return m[1]!;
    }
  }
  return address.split("/").pop()!;
}

/**
 * Move an exact `version = "<from>"` beside the provider's `source` in the
 * root's `.tf` files. A range is left alone: the lock file narrows it.
 */
export function moveConstraint(text: string, address: string, from: string, to: string): string {
  const source = address.split("/").slice(-2).join("/").toLowerCase();
  return text.replace(/(\{[^{}]*\})/g, (block) => {
    const s = /\bsource\s*=\s*"([^"]+)"/.exec(block)?.[1]?.toLowerCase();
    if (!s || !(s === source || s.endsWith(`/${source}`))) return block;
    return block.replace(/(\bversion\s*=\s*")(=?\s*)([^"]+)(")/, (all, a, eq, v, z) => (v.trim() === from ? `${a}${eq}${to}${z}` : all));
  });
}

export type Run = (bin: string, args: string[], cwd: string) => { status: number | null; output: string };

const defaultRun: Run = (bin, args, cwd) => {
  const r = spawnSync(bin, args, { cwd, encoding: "utf-8", env: { ...process.env, TF_IN_AUTOMATION: "1", TF_INPUT: "0" } });
  return { status: r.status, output: `${r.stdout ?? ""}${r.stderr ?? ""}${r.error ? r.error.message : ""}` };
};

/** Writes a root's new lock file. The default runs the binary; a test passes its own. */
export type Locker = (dir: string, address: string, to: string) => void;

export function binaryLocker(binary: string, run: Run = defaultRun): Locker {
  return (dir, address, to) => {
    const name = localName(dir, address);
    writeFileSync(join(dir, OVERRIDE), `terraform {\n  required_providers {\n    ${name} = {\n      source  = "${address}"\n      version = "= ${to}"\n    }\n  }\n}\n`);
    try {
      for (const args of [["get", "-no-color"], ["providers", "lock", "-no-color", address]]) {
        const r = run(binary, args, dir);
        if (r.status !== 0) throw new Error(`${binary} ${args.join(" ")} failed: ${r.output.trim().split("\n").slice(-3).join(" ")}`);
      }
    } finally {
      rmSync(join(dir, OVERRIDE), { force: true });
      rmSync(join(dir, ".terraform"), { recursive: true, force: true });
    }
  };
}

/**
 * Move the provider in one root of a checkout from `from` to `to`. Returns the
 * edited files, relative to the repository, or the reason it could not.
 */
export function moveLock(repo: string, root: string, wanted: string, from: string, to: string, locker: Locker): { edits: Map<string, string> } | { refused: string } {
  const dir = join(repo, root);
  const rel = (f: string) => (root === "." ? f : posix.join(root, f));
  const before = readLock(readFileSync(join(dir, LOCK_FILE), "utf-8"));
  const entry = lockedProvider(before, wanted);
  if (!entry) return { refused: `${rel(LOCK_FILE)} has no ${wanted}` };
  const edits = new Map<string, string>();
  for (const f of tfFiles(dir)) {
    const text = readFileSync(join(dir, f), "utf-8");
    const moved = moveConstraint(text, entry.address, from, to);
    if (moved !== text) {
      writeFileSync(join(dir, f), moved);
      edits.set(rel(f), moved);
    }
  }
  // The binary refuses to lock past a version the file already holds, so the
  // provider's entry goes first and the binary writes it afresh.
  const lockText = readFileSync(join(dir, LOCK_FILE), "utf-8");
  const escaped = entry.address.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  writeFileSync(join(dir, LOCK_FILE), lockText.replace(new RegExp(`\\n?provider\\s+"${escaped}"\\s*\\{[^}]*\\}\\n?`), "\n"));
  try {
    locker(dir, entry.address, to);
  } catch (e) {
    return { refused: (e as Error).message };
  }
  const text = readFileSync(join(dir, LOCK_FILE), "utf-8");
  const after = readLock(text);
  if (after.get(entry.address) !== to) return { refused: `${rel(LOCK_FILE)} has ${entry.address} at ${after.get(entry.address) ?? "nothing"} after locking, not ${to}` };
  for (const [address, version] of before) {
    if (address !== entry.address && after.get(address) !== version) {
      return { refused: `locking ${entry.address} also moved ${address} from ${version} to ${after.get(address) ?? "nothing"}, so nothing was written` };
    }
  }
  edits.set(rel(LOCK_FILE), text);
  return { edits };
}
