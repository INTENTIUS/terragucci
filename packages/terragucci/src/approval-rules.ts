/**
 * `approval_rules`: more than one approver, or approvers with a role, for the
 * waves whose roots a glob names.
 *
 *   approval_rules:
 *     - roots: ["envs/prod/**"]
 *       count: 2
 *       roles: [platform]
 *       not_author: true
 *
 * A wave takes every rule a root of it matches, and applies once each is met
 * by distinct approvers of its set digest. A root no rule matches needs what
 * the approval mode needs. The rules are read at base with `approval:`, and
 * the roles from `.chant/trust.json` at base (`roles`: role name to the
 * principals that hold it), so a change cannot loosen the rules its own wave
 * is judged by.
 *
 * An approver counts toward `roles`, and as someone who is not the author,
 * only when the approval proves who they are: a seal that verifies against
 * the signers file at base, or under `pr-review` the forge identity of the
 * pull request's approving reviewer. A role the approver names for
 * themselves never counts. Under `ledger` no approval proves its name, so
 * `config check` refuses `roles` and `not_author` there.
 *
 * chant's wave gate passes on one approval of the digest. The wave's job
 * keeps it shut until the rules are met the way it does for the people
 * behind the change (./involved.ts): it records a pending fact for the
 * digest newer than the approvals it has, so chant waits, and counts the
 * approvals of the same digest made since the first pending fact of this
 * wait. Once a wave applies, every approval of its digest made up to the one
 * chant applied under is spent (chant's applied record), so none of them
 * counts toward the digest again.
 */
import { spawnSync } from "node:child_process";
import { TRUST_CONFIG_PATH, trustConfigProblems } from "@intentius/chant/gate-decision";
import type { ApprovalRuleSettings } from "./config";
import { globMatch } from "./detect";

/** One approver of a wave's digest, as the rules judge them. */
export interface RuleApprover {
  /** The principal or login the approval names; a review's reviewer by their forge login. */
  who: string;
  /** When the approval was made. */
  at: string;
  /** The approval proves `who`: a seal verified against the signers at base, or the forge's review. */
  proven: boolean;
  /** The roles `.chant/trust.json` at base gives `who`, when `proven`. */
  roles: string[];
  /** `who` is the change's author, or had a hand in it otherwise (./involved.ts). */
  author: boolean;
}

/** How far one rule is met for a wave. */
export interface RuleProgress {
  roots: string[];
  count: number;
  roles?: string[];
  not_author?: boolean;
  /** The approvers it counts, oldest first. */
  approvers: string[];
  met: boolean;
}

/** The rules a wave takes: each one a root of `roots` matches. */
export function rulesFor(rules: readonly ApprovalRuleSettings[] | undefined, roots: readonly string[]): ApprovalRuleSettings[] {
  return (rules ?? []).filter((r) => roots.some((root) => r.roots.some((g) => globMatch(g, root))));
}

const norm = (s: string): string => s.normalize("NFKC").trim().toLowerCase();

/**
 * The role grants of `.chant/trust.json` at `base`, as chant reads them: role
 * name to the principals that hold it. A file that is missing gives none; one
 * that is not valid gives none too and says why, as chant then turns its
 * trust off.
 */
export function trustRolesAt(repo: string, base: string): { roles: Record<string, string[]>; problem?: string } {
  const r = spawnSync("git", ["cat-file", "blob", `${base}:${TRUST_CONFIG_PATH}`], { cwd: repo, encoding: "utf-8" });
  if (r.status !== 0) return { roles: {} };
  let raw: unknown;
  try {
    raw = JSON.parse(r.stdout);
  } catch (e) {
    return { roles: {}, problem: `${TRUST_CONFIG_PATH} at base is not JSON (${(e as Error).message}), so it gives nobody a role` };
  }
  const problems = trustConfigProblems(raw);
  if (problems.length > 0) return { roles: {}, problem: `${TRUST_CONFIG_PATH} at base is not valid (${problems.join("; ")}), so it gives nobody a role` };
  return { roles: (raw as { roles?: Record<string, string[]> }).roles ?? {} };
}

/** A forge principal's forge and login: `github:alice`, `gitlab@gitlab.acme.com:bob`. */
const FORGE_PRINCIPAL = /^(github|gitlab|forgejo|gitea)(?:@[^:\s]+)?:(\S+)$/i;

/** The forges a review's login is on: Forgejo's and Gitea's principals name the same accounts. */
const sameForge = (a: string, b: string): boolean => {
  const f = (x: string) => (x.toLowerCase() === "gitea" ? "forgejo" : x.toLowerCase());
  return f(a) === f(b);
};

/**
 * The roles `roles` gives a principal. `forge` is set for a review's reviewer,
 * known by a login on that forge: a grant to `<forge>:<login>` (or the login
 * alone) is theirs.
 */
export function rolesOf(who: string, roles: Record<string, string[]>, forge?: string): string[] {
  const holds = (p: string): boolean => {
    if (norm(p) === norm(who)) return true;
    if (forge === undefined) return false;
    const m = FORGE_PRINCIPAL.exec(p.trim());
    return m !== null && sameForge(m[1]!, forge) && norm(m[2]!) === norm(who);
  };
  return Object.entries(roles)
    .filter(([, principals]) => principals.some(holds))
    .map(([role]) => role)
    .sort();
}

/** How far `rule` is met by `approvers`: each counted once, by name, oldest first. */
export function ruleProgress(rule: ApprovalRuleSettings, approvers: readonly RuleApprover[]): RuleProgress {
  const count = rule.count ?? 1;
  const seen = new Set<string>();
  const counted: RuleApprover[] = [];
  for (const a of [...approvers].sort((x, y) => Date.parse(x.at) - Date.parse(y.at))) {
    if (seen.has(norm(a.who))) continue;
    if (rule.roles?.length && !(a.proven && a.roles.some((r) => rule.roles!.includes(r)))) continue;
    seen.add(norm(a.who));
    counted.push(a);
  }
  const notAuthor = !rule.not_author || counted.some((a) => a.proven && !a.author);
  return {
    roots: [...rule.roots],
    count,
    ...(rule.roles?.length ? { roles: [...rule.roles] } : {}),
    ...(rule.not_author ? { not_author: true } : {}),
    approvers: counted.map((a) => a.who),
    met: counted.length >= count && notAuthor,
  };
}

/** Whether every rule is met. */
export const rulesMet = (progress: readonly RuleProgress[]): boolean => progress.every((p) => p.met);

/** What a rule asks for, in words: `2 approvals, from platform, one of them not the author`. */
export function ruleAsks(rule: Pick<RuleProgress, "count" | "roles" | "not_author">): string {
  const n = `${rule.count} approval${rule.count === 1 ? "" : "s"}`;
  const from = rule.roles?.length ? `, from ${rule.roles.join(" or ")}` : "";
  const author = rule.not_author ? `, ${rule.count === 1 ? "not" : "one of them not"} the author` : "";
  return `${n}${from}${author}`;
}

/**
 * Where a rule stands, for the wave's log and its waiting line: `envs/prod/**:
 * 1 of 2 approvals (alice), needs 1 more from platform`.
 */
export function ruleLine(p: RuleProgress): string {
  const have = `${p.approvers.length} of ${p.count} approval${p.count === 1 ? "" : "s"}${p.approvers.length ? ` (${p.approvers.join(", ")})` : ""}`;
  if (p.met) return `${p.roots.join(", ")}: ${have}, met`;
  const more = p.count - p.approvers.length;
  const needs: string[] = [];
  if (more > 0) needs.push(`${more} more${p.roles?.length ? ` from ${p.roles.join(" or ")}` : ""}`);
  if (p.not_author) needs.push(more > 0 ? "one of them not the author" : "an approver who is not the author");
  return `${p.roots.join(", ")}: ${have}, needs ${needs.join(", ")}`;
}

/** The waiting line of a wave the rules hold: `1 of 2, needs 1 more from platform`, rule by rule. */
export function rulesWaiting(progress: readonly RuleProgress[]): string {
  return progress.filter((p) => !p.met).map(ruleLine).join("; ");
}
