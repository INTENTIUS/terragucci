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
import { APPROVALS, ConfigError, type Approval, type TerragucciConfig } from "./config";
import { configAtBase } from "./report/policy";
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
  /** Who may override a policy denial: `policy.override` in the config at base. Empty: nobody. */
  overriders: string[];
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
        ? { note: `chant.workspace.json ${where} still lists gates under identity.gates, and chant approve refuses an unsigned approval of a gate it lists; run terragucci init to drop them` }
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
  const key = own ? read.config.approval : undefined;
  const overriders = own && Array.isArray(read.config.policy?.override) ? read.config.policy.override.filter((o) => typeof o === "string") : [];
  return { ...effectiveApproval(key, seal.gates.size, options.flag, "at base"), ...seal, base, overriders };
}

/** The mode a repo's checkout holds, as `config check` reports it. */
export function checkoutApproval(dir: string, config: TerragucciConfig): ApprovalMode | undefined {
  if (config.projects) return undefined;
  const decl = join(dir, "chant.workspace.json");
  return effectiveApproval(config.approval, declaredGates(existsSync(decl) ? readFileSync(decl, "utf-8") : undefined), undefined, "here");
}
