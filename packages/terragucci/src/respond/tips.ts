/**
 * Tips as pull requests: each fix a tip names, one small pull request per
 * tip. Pin a provider at the version its lock file holds, add a lock file
 * for the declared platforms, and add a canary wave. From a plan's report,
 * add the moved blocks that make a rename a move.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";
import { CONFIG_NAMES, ConfigError } from "../config";
import { LOCK_FILE, readLock, namesProvider } from "../rollout/lock";
import type { Report } from "../report/schema";
import { appendBlocks, declaringFile, movedBlocks, renamesIn, type Rename } from "../tips/moved";
import type { Proposal } from "./change";

/** The platforms a lock file holds hashes for: the CI images' and the usual workstations'. */
export const PLATFORMS = ["linux_amd64", "linux_arm64", "darwin_amd64", "darwin_arm64"];

const EXACT = /^=?\s*\d+\.\d+\.\d+$/;

const tfFiles = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".tf")).sort() : []);

/** `text` with every unpinned `required_providers` entry for `only` (or for any provider) pinned from `lock`; calls `seen` per entry pinned. */
function pinText(text: string, lock: Map<string, string>, seen: (source: string, version: string) => void, only?: string): string {
  const at = /required_providers\s*\{/.exec(text);
  if (!at) return text;
  let end = at.index + at[0].length;
  for (let depth = 1; depth > 0 && end < text.length; end++) depth += text[end] === "{" ? 1 : text[end] === "}" ? -1 : 0;
  const blockText = text.slice(at.index, end);
  return text.slice(0, at.index) + blockText.replace(/([A-Za-z_][\w-]*)(\s*=\s*\{)([^{}]*)\}/g, (entry, name: string, eq: string, body: string) => {
      const source = (/\bsource\s*=\s*"([^"]+)"/.exec(body)?.[1] ?? `hashicorp/${name}`).toLowerCase();
      const version = /\bversion\s*=\s*"([^"]*)"/.exec(body)?.[1];
      if ((version !== undefined && EXACT.test(version.trim())) || (only && source !== only)) return entry;
      const pin = [...lock].find(([address]) => namesProvider(address, source))?.[1];
      if (!pin) return entry;
      seen(source, pin);
      const next =
        version !== undefined
          ? body.replace(/(\bversion\s*=\s*)"[^"]*"/, `$1"${pin}"`)
          : body.includes("\n")
            ? body.replace(/^([ \t]*)source\s*=\s*("[^"]+")/m, `$1source  = $2\n$1version = "${pin}"`)
            : `${body.trimEnd()}, version = "${pin}" `;
      return `${name}${eq}${next}}`;
    }) + text.slice(end);
}

/** Each provider some root does not pin exactly, with the edits that pin it from the roots' lock files. */
export function pinFromLock(repo: string, roots: string[]): Map<string, { files: Map<string, string>; roots: string[]; versions: Set<string> }> {
  const out = new Map<string, { files: Map<string, string>; roots: string[]; versions: Set<string> }>();
  const sources: { root: string; file: string; text: string; lock: Map<string, string> }[] = [];
  for (const root of roots) {
    const lockPath = join(repo, root, LOCK_FILE);
    if (!existsSync(lockPath)) continue;
    const lock = readLock(readFileSync(lockPath, "utf-8"));
    for (const f of tfFiles(join(repo, root))) sources.push({ root, file: posix.join(root, f), text: readFileSync(join(repo, root, f), "utf-8"), lock });
  }
  for (const s of sources) {
    pinText(s.text, s.lock, (source, version) => {
      const row = out.get(source) ?? { files: new Map<string, string>(), roots: [] as string[], versions: new Set<string>() };
      if (!row.roots.includes(s.root)) row.roots.push(s.root);
      row.versions.add(version);
      out.set(source, row);
    });
  }
  for (const [source, row] of out) {
    for (const s of sources) {
      const text = pinText(s.text, s.lock, () => {}, source);
      if (text !== s.text) row.files.set(s.file, text);
    }
  }
  return out;
}

/** The roots with no lock file. */
export const missingLocks = (repo: string, roots: string[]): string[] => roots.filter((r) => !existsSync(join(repo, r, LOCK_FILE)));

/** Roots a first wave should take: those under a dev, test or sandbox directory, or else the first in apply order. */
export function canaryFor(roots: string[]): string[] {
  const dev = roots.filter((r) => /(^|\/)(dev|development|sandbox|test|qa)(\/|$)/i.test(r));
  return dev.length ? dev : roots.slice(0, 1);
}

/** The config with `waves.canary` added, or the reason it cannot be written. */
export function addCanary(repo: string, canary: string[]): { file: string; text: string } | { refused: string } {
  const found = CONFIG_NAMES.find((n) => existsSync(join(repo, n)));
  const line = `canary: [${canary.map((c) => JSON.stringify(c)).join(", ")}]`;
  if (!found) return { file: "terragucci.yml", text: `waves:\n  ${line}\n` };
  if (!/\.ya?ml$/.test(found)) return { refused: `${found} is not YAML; add waves.canary to it by hand` };
  const text = readFileSync(join(repo, found), "utf-8");
  if (/^waves:\s*\{/m.test(text)) return { refused: `${found} writes waves inline; add canary to it by hand` };
  if (/^waves:\s*$/m.test(text)) return { file: found, text: text.replace(/^waves:\s*$/m, `waves:\n  ${line}`) };
  return { file: found, text: `${text.replace(/\n*$/, "\n")}waves:\n  ${line}\n` };
}

const list = (roots: string[]): string => roots.map((r) => `- \`${r}\``).join("\n");

/**
 * Why `synth` leaves the pin and lock file tips out: they edit the roots' own
 * files, which the synth command writes and git does not hold.
 */
export const SYNTH_TIPS_LEFT = "left out with synth: the provider pin and lock file tips, since the synth command writes the roots' files and git does not hold them; pin providers in the app that writes them";

/**
 * The tips' proposals, one pull request each, and the tips left out. With
 * `synth` only the canary tip is proposed: it edits terragucci.yml, which git
 * holds, and the others would edit files the next synth writes again.
 * `roots` are the directories a pin or a lock file goes in; `waveRoots`, when
 * they differ (an Atmos repo's instances, whose `roots` are their components),
 * the roots the canary names.
 */
export function tipProposals(repo: string, roots: string[], binary: string, opts: { canary?: string[]; platforms?: string[]; synth?: boolean; waveRoots?: string[] }): { proposals: Proposal[]; left: string[] } {
  const out: Proposal[] = [];
  const left = opts.synth ? [SYNTH_TIPS_LEFT] : [];
  if (!opts.synth) for (const [provider, row] of pinFromLock(repo, roots)) {
    const versions = [...row.versions].join(", ");
    out.push({
      branch: `terragucci/tip/pin-${provider.replace(/[^a-z0-9]+/g, "-")}`,
      title: `Pin ${provider} at the version the lock files hold (${versions})`,
      body: `Pins ${provider} at the version each root's lock file holds, so the next plan changes nothing:\n\n${list(row.roots)}`,
      files: row.files,
    });
  }
  const unlocked = opts.synth ? [] : missingLocks(repo, roots);
  const platforms = opts.platforms ?? PLATFORMS;
  if (unlocked.length) {
    out.push({
      branch: "terragucci/tip/lock-files",
      title: `Add ${LOCK_FILE} for ${unlocked.length} root(s)`,
      body: `\`${binary} providers lock\` wrote these, with hashes for ${platforms.join(", ")}:\n\n${list(unlocked)}`,
      files: new Map(),
      expect: unlocked.map((r) => posix.join(r, LOCK_FILE)),
      run: (dir) =>
        unlocked.map((r) => {
          const p = spawnSync(binary, [`-chdir=${join(dir, r)}`, "providers", "lock", ...platforms.map((x) => `-platform=${x}`)], { encoding: "utf-8" });
          if (p.status !== 0) throw new Error(`${r}: ${binary} providers lock failed:\n${(p.stderr || p.stdout).trim().split("\n").slice(-10).join("\n")}`);
          return posix.join(r, LOCK_FILE);
        }),
    });
  }
  // The canary names roots the waves run, which are not the directories edited where they differ (an Atmos instance and its component).
  const waveRoots = opts.waveRoots ?? roots;
  if (!opts.canary?.length && waveRoots.length > 1) {
    const canary = canaryFor(waveRoots);
    const edit = addCanary(repo, canary);
    if ("file" in edit) {
      out.push({
        branch: "terragucci/tip/canary",
        title: `Add a canary wave: ${canary.join(", ")}`,
        body: `A change reaches these roots first, as wave 1, and the rest wait until they have applied:\n\n${list(canary)}`,
        files: new Map([[edit.file, edit.text]]),
      });
    }
  }
  return { proposals: out, left };
}

/** The renames a `stage tf-plan` report's plans show: each root's `plan.json` beside its report.json. */
export function reportRenames(dir: string): Rename[] {
  const file = join(dir, "report.json");
  if (!existsSync(file)) throw new ConfigError(`no report at ${file}; --report names the directory terragucci stage tf-plan wrote`);
  const report = JSON.parse(readFileSync(file, "utf-8")) as Report;
  const out: Rename[] = [];
  for (const root of report.roots) {
    if (root.status !== "planned" || !root.plan?.json) continue;
    const plan = join(dir, root.plan.json);
    if (existsSync(plan)) out.push(...renamesIn(root.path, JSON.parse(readFileSync(plan, "utf-8"))));
  }
  return out;
}

/**
 * One pull request per root whose plan renames a resource: the moved blocks,
 * written after the block of each new address. It goes into `base` (the
 * branch that renamed the resource), or the default branch. `repo`, the
 * checkout the plan was made from, names the files for a dry run.
 */
export function movedProposals(repo: string, renames: readonly Rename[], base?: string): Proposal[] {
  const byRoot = new Map<string, Rename[]>();
  for (const r of renames) byRoot.set(r.root, [...(byRoot.get(r.root) ?? []), r]);
  return [...byRoot].map(([root, rs]): Proposal => {
    const files = [...new Set(rs.map((r) => posix.join(root, declaringFile(join(repo, root), r.to) ?? "main.tf")))];
    return {
      branch: `terragucci/tip/moved-${root.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase() || "root"}`,
      title: `Move ${rs.length === 1 ? `${rs[0]!.from} to ${rs[0]!.to}` : `${rs.length} renamed resources`} in ${root} instead of replacing ${rs.length === 1 ? "it" : "them"}`,
      body: `The plan of \`${root}\` destroys and creates each of these with the same configuration, so the blocks were renamed. These moved blocks make the plan move them, and destroy nothing:\n\n${rs.map((r) => `- \`${r.from}\` to \`${r.to}\``).join("\n")}`,
      files: new Map(),
      expect: files,
      ...(base ? { base } : {}),
      run: (dir) => {
        const written = new Set<string>();
        for (const r of rs) {
          const at = declaringFile(join(dir, root), r.to);
          if (!at) throw new ConfigError(`${root}: no .tf file on ${base ?? "the default branch"} declares ${r.to}, so the moved block has no resource to move to`);
          const path = join(dir, root, at);
          writeFileSync(path, appendBlocks(readFileSync(path, "utf-8"), movedBlocks([r])));
          written.add(posix.join(root, at));
        }
        return [...written];
      },
    };
  });
}
