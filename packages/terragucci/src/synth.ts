/**
 * Which synthesized roots a pull request changes (`synth` in terragucci.yml).
 * The roots a command writes, such as CDK Terrain's stacks, are not in git,
 * so no diff names them. tf-plan runs the command on the base as well, in a
 * checkout of its own, and compares each root's files (`cdk.tf.json`, its
 * lock file, its assets) and the local modules it calls, base against head.
 * A root whose files differ plans, and so does a new or removed one; the
 * rest plan nothing. When the base cannot be synthesized every root plans,
 * and the note says why.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, normalize, relative, resolve } from "node:path";

/** Never compared: what init and an apply leave beside the code. */
const SKIP_DIRS = new Set([".terraform", ".terragrunt-cache"]);
const isState = (name: string): boolean => /\.tfstate(\.backup)?$/.test(name);

/**
 * The ways a checkout's own directory can be spelled, longest first. A synth
 * writes it into its output (CDK Terrain's default local backend names
 * `<project>/terraform.<stack>.tfstate` by its absolute path), so it is
 * taken out before two checkouts' files are compared.
 */
export function checkoutPaths(repo: string): string[] {
  const paths = new Set([resolve(repo)]);
  try {
    paths.add(realpathSync(repo));
  } catch {
    // The path as given is taken out alone.
  }
  return [...paths].sort((a, b) => b.length - a.length);
}

/** `bytes` with every occurrence of each of `paths` replaced by a fixed marker. */
function withoutPaths(bytes: Buffer, paths: string[]): Buffer {
  let out = bytes;
  for (const path of paths) {
    const needle = Buffer.from(path);
    if (out.indexOf(needle) < 0) continue;
    const parts: Buffer[] = [];
    let at = 0;
    for (let i = out.indexOf(needle); i >= 0; i = out.indexOf(needle, at)) {
      parts.push(out.subarray(at, i), Buffer.from("<checkout>"));
      at = i + needle.length;
    }
    parts.push(out.subarray(at));
    out = Buffer.concat(parts);
  }
  return out;
}

/**
 * Each file under `dir` by its path from `dir`, as a SHA-256 of its bytes with
 * the checkout's own directory (`paths`) taken out. Empty when `dir` is missing.
 */
export function treeDigest(dir: string, paths: string[] = []): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (at: string): void => {
    for (const name of readdirSync(at).sort()) {
      const abs = join(at, name);
      const st = statSync(abs);
      if (st.isDirectory()) {
        if (!SKIP_DIRS.has(name)) walk(abs);
      } else if (st.isFile() && !isState(name)) {
        out.set(relative(dir, abs), createHash("sha256").update(withoutPaths(readFileSync(abs), paths)).digest("hex"));
      }
    }
  };
  if (existsSync(dir) && statSync(dir).isDirectory()) walk(dir);
  return out;
}

/** The first difference between two digests, in words, or undefined when they match. */
function firstDifference(base: Map<string, string>, head: Map<string, string>): string | undefined {
  for (const [file, digest] of head) {
    if (!base.has(file)) return `${file} is new`;
    if (base.get(file) !== digest) return `${file} differs`;
  }
  for (const file of base.keys()) if (!head.has(file)) return `${file} is gone`;
  return undefined;
}

/**
 * The local module sources a root calls (`./x` and `../x`), as paths from
 * the repo: from `module` blocks in Terraform JSON (`*.tf.json`), which CDK
 * Terrain writes, and from `source = "..."` in HCL files.
 */
export function localModules(repo: string, root: string): string[] {
  const dir = join(repo, root);
  const sources: string[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const obj = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);
  for (const name of names) {
    const file = join(dir, name);
    if (!statSync(file).isFile()) continue;
    if (name.endsWith(".tf.json") || name.endsWith(".tofu.json")) {
      let doc: unknown;
      try {
        doc = JSON.parse(readFileSync(file, "utf-8"));
      } catch {
        continue;
      }
      // `module` is an object of blocks by name or, in Terraform's JSON syntax, a list of such objects.
      const module = obj(doc)?.module;
      for (const group of Array.isArray(module) ? module : [module]) {
        for (const block of Object.values(obj(group) ?? {})) {
          for (const b of Array.isArray(block) ? block : [block]) {
            const source = obj(b)?.source;
            if (typeof source === "string") sources.push(source);
          }
        }
      }
    } else if (name.endsWith(".tf") || name.endsWith(".tofu")) {
      for (const m of readFileSync(file, "utf-8").matchAll(/^\s*source\s*=\s*"([^"]+)"/gm)) sources.push(m[1]);
    }
  }
  return [...new Set(sources.filter((s) => s.startsWith("./") || s.startsWith("../")).map((s) => normalize(join(root, s))).filter((p) => p !== ".." && !p.startsWith("../")))].sort();
}

/**
 * The roots whose synthesized files differ between two trees, each with the
 * first difference found, and the roots that match. A root's own directory
 * is compared, then every local module it calls outside it, followed through
 * the modules those call (as the head has them). Each side's own directory
 * is taken out of its files first, so an absolute path a synth writes does
 * not set the checkouts apart.
 */
export function compareSynthesized(baseRepo: string, headRepo: string, roots: string[]): { changed: Map<string, string>; unchanged: string[] } {
  const changed = new Map<string, string>();
  const unchanged: string[] = [];
  const digests = new Map<string, string | undefined>();
  const basePaths = checkoutPaths(baseRepo);
  const headPaths = checkoutPaths(headRepo);
  const differs = (path: string): string | undefined => {
    if (!digests.has(path)) digests.set(path, firstDifference(treeDigest(join(baseRepo, path), basePaths), treeDigest(join(headRepo, path), headPaths)));
    return digests.get(path);
  };
  for (const root of roots) {
    const atBase = existsSync(join(baseRepo, root));
    const atHead = existsSync(join(headRepo, root));
    if (!atBase && !atHead) {
      changed.set(root, "neither the base nor the head synthesizes it");
      continue;
    }
    if (!atBase) {
      changed.set(root, "new: the base does not synthesize it");
      continue;
    }
    if (!atHead) {
      changed.set(root, "removed: the head does not synthesize it");
      continue;
    }
    let why = differs(root);
    const seen = new Set<string>([root]);
    const queue = localModules(headRepo, root);
    while (!why && queue.length > 0) {
      const module = queue.shift()!;
      if (seen.has(module) || module === root || module.startsWith(`${root}/`)) continue;
      seen.add(module);
      const d = differs(module);
      if (d) why = `module ${module}: ${d}`;
      else queue.push(...localModules(headRepo, module));
    }
    if (why) changed.set(root, why);
    else unchanged.push(root);
  }
  return { changed, unchanged };
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** Run a shell command in `cwd`, keeping its output for the log. */
function runCommand(command: string, cwd: string, env: NodeJS.ProcessEnv): Promise<{ status: number | null; output: string }> {
  return new Promise((done) => {
    const child = spawn("sh", ["-c", command], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => out.push(d));
    child.on("error", (e) => done({ status: null, output: e.message }));
    child.on("close", (code) => done({ status: code, output: Buffer.concat(out).toString("utf-8") }));
  });
}

export interface SynthSelection {
  /** The roots to plan: changed, new and removed ones and the roots that read their state. Undefined: every root. */
  selected?: Set<string>;
  /** The line the plan note carries: how many roots were unchanged, or why every root plans. */
  notice: string;
}

/**
 * Synthesize the merge base of `base` and HEAD in a worktree of its own, with
 * the same command, and select the roots whose output differs, plus every
 * root that reads a selected root's state (`deps`, followed through). The
 * worktree is removed afterwards.
 */
export async function synthAffected(
  repo: string,
  base: string,
  command: string,
  roots: string[],
  deps: Map<string, Set<string>>,
  env: NodeJS.ProcessEnv,
  log: (line: string) => void,
  order: Map<string, Set<string>> = new Map(),
): Promise<SynthSelection> {
  const everyRoot = (why: string): SynthSelection => {
    log(`every root: ${why}`);
    return { notice: `Every synthesized root is planned: ${why}.` };
  };
  const git = (...args: string[]) => spawnSync("git", ["-C", repo, ...args], { encoding: "utf-8" });
  const mb = git("merge-base", base, "HEAD");
  if (mb.status !== 0) return everyRoot(`no merge base of ${base} and HEAD to synthesize (${(mb.stderr || "").trim().split("\n")[0]})`);
  const sha = mb.stdout.trim();
  const dir = mkdtempSync(join(tmpdir(), "terragucci-synth-base-"));
  try {
    const added = git("worktree", "add", "--detach", "--force", dir, sha);
    if (added.status !== 0) return everyRoot(`could not check out the base ${sha.slice(0, 8)} (${(added.stderr || "").trim().split("\n")[0]})`);
    log(`synth at the base: ${command}, on ${sha.slice(0, 8)} in a checkout of its own`);
    const ran = await runCommand(command, dir, env);
    if (ran.status !== 0) {
      for (const line of ran.output.split("\n").filter((l) => l.trim()).slice(-20)) log(`synth at the base: ${line}`);
      return everyRoot(`the synth command failed on the base ${sha.slice(0, 8)}, so its stacks could not be compared`);
    }
    const { changed, unchanged } = compareSynthesized(dir, repo, roots);
    const selected = new Set(changed.keys());
    // A dependent: a root that reads a selected root's state, or (an Atmos instance) depends on one.
    const upstreams = (root: string): string[] => [...new Set([...(deps.get(root) ?? []), ...(order.get(root) ?? [])])];
    for (let grew = true; grew; ) {
      grew = false;
      for (const root of new Set([...deps.keys(), ...order.keys()])) {
        if (roots.includes(root) && !selected.has(root) && upstreams(root).some((d) => selected.has(d))) {
          selected.add(root);
          grew = true;
        }
      }
    }
    for (const [root, why] of changed) log(`affected: ${root} differs from the base (${why})`);
    const dependents = [...selected].filter((r) => !changed.has(r)).sort();
    for (const r of dependents) {
      const reads = [...(deps.get(r) ?? [])].filter((d) => selected.has(d)).sort();
      const after = [...(order.get(r) ?? [])].filter((d) => selected.has(d) && !reads.includes(d)).sort();
      log(`affected: ${r} ${[...(reads.length ? [`reads the state of ${reads.join(", ")}`] : []), ...(after.length ? [`depends on ${after.join(", ")}`] : [])].join(" and ")}`);
    }
    const skipped = unchanged.filter((r) => !selected.has(r));
    log(`affected: ${changed.size} of ${roots.length} synthesized roots differ from ${base}, ${plural(dependents.length, "dependent")} after them, ${skipped.length} unchanged and not planned`);
    return {
      selected,
      notice: `The synth command ran on the base (${sha.slice(0, 8)}) too: ${plural(selected.size, "synthesized root")} planned, ${skipped.length} unchanged and not planned.`,
    };
  } finally {
    git("worktree", "remove", "--force", dir);
    rmSync(dir, { recursive: true, force: true });
    git("worktree", "prune");
  }
}
