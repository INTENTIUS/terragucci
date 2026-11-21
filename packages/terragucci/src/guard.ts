/**
 * `terragucci guard`: a local guard that keeps a coding agent in a checkout
 * from applying a root the pipeline owns.
 *
 * The guard itself is chant's `installAgentGuard` (@intentius/chant/agent-guard);
 * this file holds terragucci's words and rules and maps the pipeline's roots
 * onto it. It writes, under the checkout's git directory (`<git-dir>/terragucci/guard`,
 * so nothing of it is committed):
 * - `guard.mjs`, one Node script holding the rule, the repo and its roots;
 * - `bin/<binary>` for tofu, terraform, terragrunt and choudoufu, each a
 *   wrapper that runs the script, for the agent's shell to put ahead of the
 *   real binary on PATH. The wrapper refuses `apply`, `destroy`, `import`,
 *   `taint`, `untaint`, `force-unlock`, `state rm|mv|push|replace-provider`
 *   and `-auto-approve` in a root of the pipeline (for Terragrunt's `--all`
 *   and `run-all`, in a directory that holds one), and runs the next binary of
 *   that name on PATH for everything else;
 * - a PreToolUse hook in `.claude/settings.local.json`, the file Claude Code
 *   reads, which refuses the same commands in the agent's Bash tool, and the
 *   terragucci commands that approve, apply, deploy, override or merge
 *   anywhere (`stage tf-apply`, `approve`, `override`, `unlock-state`,
 *   `pr-merge`, `promote`, `rollback`, `--mode apply`). The file is listed in `.git/info/exclude` unless git
 *   already ignores it.
 *
 * Each refusal names `propose` on `terragucci mcp --propose` as the way to get
 * the change applied: a pull request, planned by the pipeline, approved by a
 * person.
 *
 * The guard is a speed bump. An agent that calls the real binary by its path,
 * through a script, or with credentials of its own gets past it; the control
 * is a plan role that cannot write, per-environment state roles and approvals
 * bound to the plan digest. The roots are written into the script when the
 * guard is written, so it is written again after the roots change.
 */
import { relative, resolve } from "node:path";
import { installAgentGuard, type AgentGuardEngine, type AgentGuardSpec } from "@intentius/chant/agent-guard";
import { ConfigError, type ResolvedSettings } from "./config";
import { findRoots } from "./detect";
import { detectShape } from "./shape";
import { walkUnits } from "./terragrunt";
import { rootPath } from "./root-config";

/** The binaries the guard wraps. */
export const GUARD_BINARIES = ["tofu", "terraform", "terragrunt", "choudoufu"] as const;

const engine: AgentGuardEngine = {
  refuse: ["apply", "destroy", "import", "taint", "untaint", "force-unlock"],
  refuseSub: { state: ["rm", "mv", "push", "replace-provider"] },
  refuseFlags: ["-auto-approve", "-terragrunt-auto-approve"],
  dirFlags: ["-chdir", "-working-dir", "-terragrunt-working-dir"],
};

/** terragucci's words and rules for chant's agent guard. */
export const GUARD_SPEC: AgentGuardSpec = {
  words: {
    product: "terragucci",
    refusal:
      "{what} is refused{where}. Propose the change instead: commit it to a branch and call the propose tool of terragucci mcp --propose, which pushes the branch and opens a pull request. The pipeline plans it, and a person approves its apply. init, validate, fmt and plan still run here.",
    where: " in {root}, a root of this repo's pipeline",
  },
  rules: {
    engines: {
      tofu: engine,
      terraform: engine,
      terragrunt: {
        ...engine,
        allFlags: ["--all", "-a"],
        prefixes: [{ words: ["run-all"], all: true }, { words: ["stack", "run"], all: true }, { words: ["run"] }],
      },
      choudoufu: engine,
    },
    product: {
      commands: [["stage", "tf-apply"], ["approve"], ["override"], ["unlock-state"], ["pr-merge"], ["promote"], ["rollback"]],
      flagValues: [["--mode", "apply"]],
    },
    wrapperExit: 3,
  },
};

/** The pipeline's roots as the guard counts them: Terragrunt's units in a Terragrunt repo, the roots everywhere else. */
export function guardRoots(repo: string, settings: ResolvedSettings): string[] {
  const shape = detectShape(repo, settings);
  return shape.kind === "terragrunt" ? walkUnits(repo, settings.terragrunt?.exclude).map((u) => u.path) : findRoots(repo, settings.roots);
}

export interface GuardOptions {
  /** The checkout's top directory. */
  repo: string;
  settings: ResolvedSettings;
  /** Where to write the guard, in place of `<git-dir>/terragucci/guard`. */
  dir?: string;
  /** The Node the wrappers and the hook run. Default: this one. */
  node?: string;
  /** Leave Claude Code's settings alone. */
  noHook?: boolean;
}

export interface GuardResult {
  dir: string;
  bin: string;
  script: string;
  roots: string[];
  /** The settings file the hook was written to, when it was. */
  hook?: string;
  /** The line the agent's shell runs to put the wrappers ahead of the binaries. */
  path: string;
}

/** Write the guard: the script, the wrappers, and the hook. */
export function writeGuard(o: GuardOptions): GuardResult {
  const repo = resolve(o.repo);
  const roots = guardRoots(repo, o.settings);
  const r = installAgentGuard({
    ...GUARD_SPEC,
    repo,
    install: "local",
    roots: roots.map((x) => relative(repo, rootPath(repo, x)) || "."),
    ...(o.dir ? { dir: o.dir } : {}),
    ...(o.node ? { node: o.node } : {}),
    ...(o.noHook ? { noHook: true } : {}),
    fail: (m) => new ConfigError(m),
  });
  return { dir: resolve(r.script, ".."), bin: r.bin, script: r.script, roots, ...(r.hook ? { hook: r.hook } : {}), path: r.path };
}

/** What `terragucci guard` prints. */
export function describeGuard(r: GuardResult): string {
  return [
    `terragucci guard: wrote ${GUARD_BINARIES.join(", ")} wrappers to ${r.bin}, guarding ${r.roots.length} root${r.roots.length === 1 ? "" : "s"}.`,
    `In the agent's shell, put them ahead of the binaries:`,
    `  ${r.path}`,
    r.hook ? `Claude Code's hook is in ${r.hook}: it refuses the same commands in the agent's Bash tool.` : `No hook was written (--no-hook).`,
    `The guard is a speed bump, not the control: the agent's credentials are. Run terragucci guard again after the roots change.`,
  ].join("\n");
}
