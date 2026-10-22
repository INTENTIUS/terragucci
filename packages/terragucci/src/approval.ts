/**
 * Which approvals count toward a waiting wave: the `approval:` key.
 *
 *   ledger  (default) any `chant approve` of the wave's set digest on
 *           chant/lifecycle, signed or not. It binds the plans, not the
 *           person: whoever can push to chant/lifecycle can write one in
 *           anyone's name.
 *   sealed  only an approval sealed by a key the signers file at base lists
 *           for its approver (./seal.ts).
 *
 * Every mode binds the digest: an approval of other plans is the changed-wave
 * refusal (exit 4), whatever the mode.
 *
 * The mode is read at base, the commit before the one applied (or the
 * pull request's base with `apply.when: pull-request`), so a change cannot
 * relax the rule its own apply is judged by. In order: the `approval:` key of
 * the config at base; then, with no key, any gate under `identity.gates`
 * in chant.workspace.json at base, which a repo set up before the key existed
 * carries, means sealed; then the pipeline's `--approval`, which a control
 * repo's project carries; then ledger.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { APPROVALS, approvalModeOf, ConfigError, requireSignedOf, type Approval, type ApprovalRuleSettings, type OverrideEntry, type PolicyOutcome, type TerragucciConfig } from "./config";
import { quorumRuleLine, type GateQuorumRule, type GateQuorumRuleProgress } from "@intentius/chant/gate-decision";
import { configAtBase } from "./report/policy";
import type { ReportApprovalRule } from "./report/schema";
import { baseCommit, sealRule, type SealRule } from "./seal";

/** The mode in force, where it was read, and a line for the log when the repo should change something. */
export interface ApprovalMode {
  mode: Approval;
  source: string;
  note?: string;
}

/** The mode at base, with the seal rule (gates and signers) read from the same commit. */
export interface ApprovalRule extends ApprovalMode, SealRule {
  /** The commit the rule was read from. */
  base: string;
  /** Who may override a policy denial: the flat names of `policy.override` in the config at base, for every root and rule. */
  overriders: string[];
  /** The scoped entries of `policy.override` at base (./override.ts). */
  overrideEntries?: OverrideEntry[];
  /** The decision point every wave gate asks: `apply.point` in the config at base (./point-gate.ts). Unset, the gate waits for an approval. */
  point?: string;
  /** `approval.require_signed` at base: an unsigned approval on the ledger counts for nothing. */
  requireSigned?: boolean;
  /** `agent.token_env` at base: the variable holding the agent's token, whose user never approves (./involved.ts). */
  agentTokenEnv?: string;
  /** `agent.login` at base: the account the agent's token acts as, never an approver. */
  agentLogin?: string;
  /** `approval_rules` at base, as chant's `approvals.quorum` rules (quorumOf): more approvers, or approvers with a role, for the waves whose roots a glob names. */
  approvalRules?: GateQuorumRule[];
  /** `policy.outcomes` at base: the outcomes besides deny the policy's rules have, which only the base can turn on. */
  policyOutcomes?: PolicyOutcome[];
}

/** Whether a value is one of APPROVALS. */
export const isApproval = (v: unknown): v is Approval => typeof v === "string" && (APPROVALS as readonly string[]).includes(v);

/**
 * The mode from what a commit holds: its config's `approval:` key, how many
 * gates its chant.workspace.json lists under `identity.gates`, and the
 * pipeline's `--approval`. `where` names the commit for the source line.
 */
export function effectiveApproval(key: Approval | undefined, gates: number, flag: Approval | undefined, where: string): ApprovalMode {
  if (key) {
    return {
      mode: key,
      source: `approval: ${key} in the config ${where}`,
      ...(key !== "sealed" && gates > 0
        ? { note: `chant.workspace.json ${where} still lists gates under identity.gates, and terragucci approve refuses an unsigned approval of a gate it lists; run terragucci init to drop them` }
        : {}),
    };
  }
  if (gates > 0) {
    return {
      mode: "sealed",
      source: `identity.gates in chant.workspace.json ${where}, with no approval key`,
      note: "set approval: sealed in terragucci.yml to keep sealed approvals, or approval: ledger and run terragucci init to drop the gates",
    };
  }
  if (flag) return { mode: flag, source: "the pipeline's --approval" };
  return { mode: "ledger", source: "the default" };
}

/** How many gates a chant.workspace.json text lists under `identity.gates`. Any gate there seals every wave gate, as it did before the key. */
export function declaredGates(text: string | undefined): number {
  if (text === undefined) return 0;
  try {
    return Object.keys((JSON.parse(text) as { identity?: { gates?: Record<string, unknown> } }).identity?.gates ?? {}).length;
  } catch {
    return 0;
  }
}

/**
 * The rule a wave is judged by, read at base: `at`, or the first parent of
 * HEAD. `config` is the config file the run reads; its copy at base supplies
 * the key. A config at base that cannot be read throws: the mode cannot be
 * decided, and guessing ledger would open a gate the base keeps sealed.
 */
export async function approvalRule(repo: string, options: { at?: string; config?: string; flag?: Approval } = {}): Promise<ApprovalRule> {
  const base = options.at ?? baseCommit(repo);
  const seal = sealRule(repo, base);
  const read = await configAtBase(repo, base, options.config ? { config: options.config } : {});
  if ("error" in read) throw new ConfigError(`approval is read from the config at base, and it could not be read (${read.error}), so the gate cannot be decided`);
  const own = !(read.config as TerragucciConfig).projects;
  const key = own ? approvalModeOf(read.config.approval) : undefined;
  const requireSigned = own && requireSignedOf(read.config.approval);
  const agentTokenEnv = own && typeof read.config.agent?.token_env === "string" ? read.config.agent.token_env : undefined;
  const agentLogin = own && typeof read.config.agent?.login === "string" && read.config.agent.login ? read.config.agent.login : undefined;
  const overriders = own && Array.isArray(read.config.policy?.override) ? read.config.policy.override.filter((o): o is string => typeof o === "string") : [];
  const overrideEntries = own && Array.isArray(read.config.policy?.override) ? read.config.policy.override.filter((o): o is OverrideEntry => typeof o === "object" && o !== null) : [];
  const point = own && typeof read.config.apply?.point === "string" ? read.config.apply.point : undefined;
  const approvalRules = own && Array.isArray(read.config.approval_rules) && read.config.approval_rules.length > 0 ? quorumOf(read.config.approval_rules) : undefined;
  const policyOutcomes = own && Array.isArray(read.config.policy?.outcomes) && read.config.policy.outcomes.some((o) => o !== "deny") ? read.config.policy.outcomes : undefined;
  return { ...effectiveApproval(key, seal.gates.size, options.flag, "at base"), ...seal, base, overriders, ...(point ? { point } : {}), ...(requireSigned ? { requireSigned } : {}), ...(agentTokenEnv ? { agentTokenEnv } : {}), ...(agentLogin ? { agentLogin } : {}), ...(approvalRules ? { approvalRules } : {}), ...(policyOutcomes ? { policyOutcomes } : {}), ...(overrideEntries.length ? { overrideEntries } : {}) };
}

/**
 * `approval_rules` as chant's `approvals.quorum` rules
 * (`@intentius/chant/gate-decision`): `roots` are the rule's `targets`, a
 * wave's roots, and `not_author` is `notAuthor`.
 */
export function quorumOf(rules: readonly ApprovalRuleSettings[]): GateQuorumRule[] {
  return rules.map((r) => ({
    targets: [...r.roots],
    count: r.count ?? 1,
    ...(r.roles?.length ? { roles: [...r.roles] } : {}),
    ...(r.not_author ? { notAuthor: true } : {}),
  }));
}

/** Where a rule stands, as the report and the pending fact keep it: `roots` and `not_author`, as `approval_rules` spells them. */
export function ruleReport(p: GateQuorumRuleProgress): ReportApprovalRule {
  return {
    roots: [...(p.targets ?? [])],
    count: p.count,
    ...(p.roles?.length ? { roles: [...p.roles] } : {}),
    ...(p.notAuthor ? { not_author: true } : {}),
    approvers: [...p.approvers],
    met: p.met,
  };
}

/** A rule the report or a pending fact keeps, in one line: `envs/prod/**: 1 of 2 approvals (alice), needs 1 more from platform`. */
export function reportRuleLine(r: ReportApprovalRule): string {
  return quorumRuleLine({ targets: r.roots, count: r.count, ...(r.roles?.length ? { roles: r.roles } : {}), ...(r.not_author ? { notAuthor: true } : {}), approvers: r.approvers, met: r.met });
}

/** What a rule asks for, in words: `2 approvals, from platform, one of them not the author`. */
export function ruleAsks(rule: Pick<ReportApprovalRule, "count" | "roles" | "not_author">): string {
  const n = `${rule.count} approval${rule.count === 1 ? "" : "s"}`;
  const from = rule.roles?.length ? `, from ${rule.roles.join(" or ")}` : "";
  const author = rule.not_author ? `, ${rule.count === 1 ? "not" : "one of them not"} the author` : "";
  return `${n}${from}${author}`;
}

/** The mode a repo's checkout holds, as `config check` reports it. */
export function checkoutApproval(dir: string, config: TerragucciConfig): ApprovalMode | undefined {
  if (config.projects) return undefined;
  const decl = join(dir, "chant.workspace.json");
  return effectiveApproval(approvalModeOf(config.approval), declaredGates(existsSync(decl) ? readFileSync(decl, "utf-8") : undefined), undefined, "here");
}
