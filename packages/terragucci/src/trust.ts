/**
 * `.chant/trust.json` for terragucci.yml's `evidence` key (terragucci issue
 * 1413), as `terragucci init` plans it. chant reads the file at base, and
 * chant writes every piece of it; terragucci names what goes in:
 *
 *   refs      the ref gate's rule for the default branch, from chant's
 *             `refGateInitPlan` (`@intentius/chant/ref-gate-init`): the
 *             `plan` and `policy` checks the plan note job signs, and the
 *             `pre-push` hook in this clone
 *   keyless   with `evidence.identity: oidc`, the workflow's identity on the
 *             default branch (`ciRunnerIdentity`, `withRunnerIdentity`)
 *   local     with `evidence.local: true`, the check hooks by name under
 *             `local.checks`, so a hook proven on a person's machine is
 *             skipped in CI
 *
 * A file already there is merged into: a rule, an identity or a local check
 * it has is kept as it is. Without `evidence` init plans no trust file.
 *
 * The rule names no check hook: the check job's hooks are not signed by a
 * runner (terragucci's check job is its own; chant's check evidence job comes
 * with chant's check job, chant issue 5066), so a rule that named one would
 * refuse every push.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { PipelineEvidence } from "@intentius/chant/ci-evidence-jobs";
import { refGateInitPlan } from "@intentius/chant/ref-gate-init";
import { planFile, type PlannedFile } from "@intentius/chant/planned-files";
import { trustConfigSchema, type TrustConfig } from "@intentius/chant/workspace/trust/policy";
import { ciRunnerIdentity, DEFAULT_TRUSTED_ROOT_PATH, withRunnerIdentity } from "@intentius/chant/workspace/trust/runner-identity";
import type { ForgeName } from "./config";
import { pathOfRemote } from "./identities";

export const TRUST_FILE = ".chant/trust.json";

/** The command the ref gate's refusal names for the plan's checks. */
export const PLAN_EVIDENCE_COMMAND = "/terragucci plan on the pull request";

/** The workflow file whose jobs sign, as the forge's certificate names it. */
export function signingWorkflow(forge: ForgeName): string {
  return forge === "gitlab" ? ".gitlab-ci.yml" : forge === "forgejo" ? ".forgejo/workflows/terragucci.yml" : ".github/workflows/terragucci.yml";
}

export interface TrustInput {
  forge: ForgeName;
  evidence: PipelineEvidence;
  /** `evidence.local`. */
  local: boolean;
  /** The check hooks by name, as `terragucci ci check` runs them. */
  hooks: string[];
  /** A self-hosted forge's base URL (`url` in terragucci.yml). */
  server?: string;
}

export interface TrustPlan {
  files: PlannedFile[];
  notes: string[];
}

function git(repo: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", ["-C", repo, ...args], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

/** The default branch: origin's HEAD, else the branch checked out, else main. */
export function defaultBranchOf(repo: string): string {
  const head = git(repo, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (head) return head.replace(/^origin\//, "");
  return git(repo, ["symbolic-ref", "--short", "HEAD"]) ?? "main";
}

/**
 * The trust file and the `pre-push` hook for `input`, planned in `repo`.
 * Throws when the result is not a trust config chant reads.
 */
export function trustPlan(repo: string, input: TrustInput): TrustPlan {
  const notes: string[] = [];
  const branch = defaultBranchOf(repo);
  const top = git(repo, ["rev-parse", "--show-toplevel"]);
  if (!top) return { files: [], notes: [`evidence is set and ${repo} is not a git checkout, so init wrote no ${TRUST_FILE}; run init again in the clone`] };
  // chant's ref gate pieces first, from the file as it is on disk: the rule for the default branch and the hook.
  const gate = refGateInitPlan(repo, {
    branch,
    checks: [
      { check: "plan", command: PLAN_EVIDENCE_COMMAND },
      { check: "policy", command: PLAN_EVIDENCE_COMMAND },
    ],
    chant: "terragucci",
    ...(input.evidence.runnerKeySecret ? { runnerKeySecret: input.evidence.runnerKeySecret } : {}),
  });
  const trustPath = join(realpathSync(top), TRUST_FILE);
  const planned = gate.files.find((f) => f.path === trustPath);
  const existing = existsSync(trustPath) ? readFileSync(trustPath, "utf-8") : undefined;
  let text = planned?.content ?? existing;
  if (input.evidence.identity === "oidc") {
    const repository = pathOfRemote(git(repo, ["remote", "get-url", "origin"]) ?? "");
    if (input.forge === "forgejo") {
      notes.push(`evidence: add the terragucci workflow's keyless identity to ${TRUST_FILE} (keyless.identities, with ci in roles.runner): a Forgejo job's certificate comes from the authority you run, so its issuer and subject are yours to name`);
    } else if (!repository) {
      notes.push(`evidence: add the terragucci workflow's keyless identity to ${TRUST_FILE}; init read no repository from the origin remote`);
    } else {
      const identity = ciRunnerIdentity({ forge: input.forge, repository, workflow: signingWorkflow(input.forge), ref: `refs/heads/${branch}`, ...(input.server ? { server: input.server } : {}) });
      text = withRunnerIdentity(text, identity);
    }
    notes.push(`evidence: put sigstore's trusted_root.json at ${DEFAULT_TRUSTED_ROOT_PATH}, which ${TRUST_FILE} names under keyless.trustedRoot; until it is there, no keyless evidence verifies`);
  }
  const config: TrustConfig = text === undefined || text.trim() === "" ? { schema: 1 } : (JSON.parse(text) as TrustConfig);
  const next: TrustConfig = { ...config };
  if (input.local && input.hooks.length > 0) {
    const local = config.local ?? {};
    const named = new Set((local.checks ?? []).map((c) => c.check));
    next.local = { ...local, checks: [...(local.checks ?? []), ...input.hooks.filter((h) => !named.has(h)).map((check) => ({ check }))] };
    if (!local.keys?.length) notes.push(`evidence.local: add each person's ssh-ed25519 key under local.keys in ${TRUST_FILE}, so ${input.hooks.join(", ")} proven on their machine is skipped in CI`);
  } else if (input.local) {
    notes.push("evidence.local is set and chant.workspace.json names no check hook, so no check takes local evidence");
  }
  const parsed = trustConfigSchema.safeParse(next);
  if (!parsed.success) throw new Error(`${TRUST_FILE} with terragucci.yml's evidence is not a trust config chant reads: ${parsed.error.issues.map((i) => `${i.path.join(".") || "/"}: ${i.message}`).join("; ")}`);
  const content = `${JSON.stringify(next, null, 2)}\n`;
  // A file whose text init would only reformat stays as it is.
  const same = existing !== undefined && JSON.stringify(JSON.parse(existing)) === JSON.stringify(next);
  const files: PlannedFile[] = [
    planFile(trustPath, same ? existing! : content),
    ...gate.files.filter((f) => f.path !== trustPath).map((f) => planFile(f.path, f.content, { ...(f.mode !== undefined ? { mode: f.mode } : {}), ...(f.local ? { local: true } : {}) })),
  ];
  notes.push(...gate.notes.map((n) => `evidence: ${n}`));
  return { files, notes };
}
