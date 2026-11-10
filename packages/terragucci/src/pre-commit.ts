/**
 * `check.pre_commit` (terragucci#1284): tf-check runs the repo's own
 * `.pre-commit-config.yaml` (pre-commit-terraform and whatever else it
 * names) as a chant check hook, `ci.hooks.check` (chant#4556). terragucci
 * adds no tool and no rule of its own: the hooks are the ones the config
 * names.
 *
 * The hook runs `pre-commit run` over the files the change touches, from
 * the base the check reads its hooks at (`CHANT_HOOKS_BASE`) to HEAD, or
 * over every file when the check runs on the base itself (a push to the
 * default branch). It sets `PCT_TFPATH` to the repo's binary, which
 * pre-commit-terraform's hooks run (`init -backend=false`, as tf-check
 * does), and skips `terraform_fmt`, which tf-check's format check and the
 * fmt job already cover.
 *
 * `init` writes the hook into chant.workspace.json and the check job runs
 * it through chant, read from the declaration at base.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CI_CHECK_HOOK_FLOOR } from "@intentius/chant/components/check-hooks";
import type { ChantCheckHook, ChantCheckHooks } from "./chant-next";
import { CHECK_DIR } from "./check";
import type { Binary } from "./config";

/** The hook's name in chant.workspace.json, which a later init replaces by. */
export const PRE_COMMIT_HOOK = "terragucci-pre-commit";

/** The file pre-commit reads, which init looks for to mention the preset. */
export const PRE_COMMIT_CONFIG = ".pre-commit-config.yaml";

/** The declaration files chant reads, in its order. */
const DECLARATION_FILES = ["chant.workspace.json", "chant.workspace.jsonc"];

/** Where the check hooks' runs file and report go: beside the check report, so the job keeps them. */
export const CHECK_HOOKS_OUT = `${CHECK_DIR}/hooks`;

/** The shell the hook runs: pre-commit over the change, with the binary and the skip set. */
export function preCommitScript(binary: Binary): string {
  return [
    "set -eu",
    `command -v pre-commit >/dev/null 2>&1 || { echo "terragucci: check.pre_commit is on and this job's image has no pre-commit; use an image built FROM terragucci's that adds pre-commit and the tools ${PRE_COMMIT_CONFIG} names (image: in terragucci.yml)" >&2; exit 1; }`,
    `PCT_TFPATH="$(command -v ${binary})" || { echo "terragucci: check.pre_commit: no ${binary} on the path" >&2; exit 1; }`,
    'SKIP="terraform_fmt${SKIP:+,$SKIP}"',
    "export PCT_TFPATH SKIP",
    'base="${CHANT_HOOKS_BASE:-HEAD}"',
    'if [ "$(git rev-parse "$base^{commit}")" = "$(git rev-parse HEAD)" ]; then',
    "  exec pre-commit run --all-files --show-diff-on-failure --color never",
    "fi",
    'exec pre-commit run --from-ref "$base" --to-ref HEAD --show-diff-on-failure --color never',
  ].join("\n");
}

/** The preset's check hook: once for the check, over the files the change touches. */
export function preCommitHook(binary: Binary): ChantCheckHook {
  return { name: PRE_COMMIT_HOOK, command: ["sh", "-c", preCommitScript(binary)] };
}

/** The declaration file in `repo` chant reads, or undefined. */
export function declarationFile(repo: string): string | undefined {
  return DECLARATION_FILES.map((f) => join(repo, f)).find((f) => existsSync(f));
}

/** Whether a declaration's text names any `ci.hooks.check` hook at its top level or in a member. */
export function namesCheckHooks(text: string | undefined): boolean {
  if (text === undefined) return false;
  let doc: unknown;
  try {
    doc = JSON.parse(text.replace(/^\s*\/\/.*$/gm, ""));
  } catch {
    return false;
  }
  const check = (o: unknown): boolean => {
    const list = (o as { ci?: { hooks?: { check?: unknown } } } | undefined)?.ci?.hooks?.check;
    return Array.isArray(list) && list.length > 0;
  };
  const d = doc as { members?: unknown[] } | null;
  return check(d) || (Array.isArray(d?.members) && d.members.some(check));
}

/** `a.b.c` below `b.c`: whether version `have` is older than `floor`. */
function older(have: unknown, floor: string): boolean {
  if (typeof have !== "string") return true;
  const a = have.split(".").map(Number);
  const b = floor.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (Number.isNaN(x)) return true;
    if (x !== y) return x < y;
  }
  return false;
}

/**
 * The declaration's text once the preset's hook is in `ci.hooks.check`:
 * written with chant's writer in a scratch directory, so `init --dry-run`
 * shows it and the repo's file is written with the rest of init's files.
 * `before` is the text init has for it so far (a new declaration, or one it
 * already changed). `minReader` rises to the first chant that reads the
 * check moment.
 */
export function withPreCommitHook(chant: ChantCheckHooks, name: string, before: string, binary: Binary): string {
  const scratch = mkdtempSync(join(tmpdir(), "terragucci-hooks-"));
  try {
    writeFileSync(join(scratch, name), before);
    chant.writeCiHook(scratch, "check", preCommitHook(binary));
    const text = readFileSync(join(scratch, name), "utf-8");
    if (name.endsWith(".jsonc")) return text;
    const doc = JSON.parse(text) as { minReader?: unknown };
    if (!older(doc.minReader, CI_CHECK_HOOK_FLOOR)) return text;
    doc.minReader = CI_CHECK_HOOK_FLOOR;
    return `${JSON.stringify(doc, null, 2)}\n`;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** The declaration's text without the preset's hook, or undefined when it has none: `check.pre_commit` was turned off. */
export function withoutPreCommitHook(text: string): string | undefined {
  let doc: { ci?: { hooks?: { check?: { name?: string }[] } & Record<string, unknown> } & Record<string, unknown> };
  try {
    doc = JSON.parse(text);
  } catch {
    return undefined;
  }
  const list = doc.ci?.hooks?.check;
  if (!Array.isArray(list) || !list.some((h) => h?.name === PRE_COMMIT_HOOK)) return undefined;
  const kept = list.filter((h) => h?.name !== PRE_COMMIT_HOOK);
  const hooks = doc.ci!.hooks!;
  if (kept.length > 0) hooks.check = kept;
  else delete hooks.check;
  if (Object.keys(hooks).length === 0) delete doc.ci!.hooks;
  if (Object.keys(doc.ci!).length === 0) delete doc.ci;
  return `${JSON.stringify(doc, null, 2)}\n`;
}
