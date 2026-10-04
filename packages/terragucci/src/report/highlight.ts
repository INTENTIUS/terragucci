/**
 * What the report opens and what it folds.
 *
 * Open: destroys, replacements and refusals; outlier roots; changes to the
 * types in {@link HIGHLIGHTS}, where one wrong value reaches far; and
 * anything under `prevent_destroy`. Folded: groups of identical changes,
 * tags-only and description-only updates, values known only after apply,
 * and roots with no changes. A tags-only change to a highlighted type stays
 * folded: retagging a security group reaches nothing.
 */
import type { ChangeSetAttribute } from "@intentius/chant/change-set";
import type { Fold, ReportChange } from "./schema";

export interface HighlightRule {
  /** Matched against the resource type. */
  match: RegExp;
  why: string;
}

/** The types where one wrong value reaches far, and why the report says so. */
export const HIGHLIGHTS: readonly HighlightRule[] = [
  { match: /^aws_iam_|^google_.*_iam_|^azurerm_role_(assignment|definition)$|^kubernetes_(cluster_)?role(_binding)?$/, why: "IAM: changes who may do what" },
  { match: /^aws_(default_)?security_group(_rule)?$|^aws_vpc_security_group_(ingress|egress)_rule$|^google_compute_firewall$|^azurerm_network_security_(group|rule)$/, why: "security group: changes what traffic gets in or out" },
  { match: /^aws_(default_)?network_acl(_rule|_association)?$/, why: "network ACL: changes what traffic a subnet allows" },
  { match: /^aws_kms_|^google_kms_|^azurerm_key_vault_key$/, why: "KMS key: data encrypted under it depends on it" },
  { match: /^aws_route53_(record|zone)$|^google_dns_(record_set|managed_zone)$|^azurerm_dns_|^cloudflare_(dns_)?record$/, why: "DNS: changes where names resolve" },
];

/** The rule a type falls under, if any. */
export function highlightRule(type: string): HighlightRule | undefined {
  return HIGHLIGHTS.find((r) => r.match.test(type));
}

const TAG_PATHS = new Set(["tags", "tags_all", "labels", "effective_labels", "terraform_labels"]);
const DESCRIPTION_PATHS = new Set(["description"]);

/** `tags`, `description` or `unknown` when only those move in an update; else undefined. */
export function changeKind(action: string, attributes: ChangeSetAttribute[]): ReportChange["kind"] {
  if (action !== "update" || attributes.length === 0) return undefined;
  if (attributes.every((a) => TAG_PATHS.has(a.path))) return "tags";
  if (attributes.every((a) => DESCRIPTION_PATHS.has(a.path))) return "description";
  if (attributes.every((a) => a.unknown === true)) return "unknown";
  return undefined;
}

/** Whether a change is open, and the one reason a reader sees beside it. */
export function foldChange(c: Pick<ReportChange, "type" | "action" | "attributes" | "replace_paths" | "kind">, preventDestroy = false): { fold: Fold; why?: string } {
  const paths = (c.replace_paths ?? []).map((p) => p.join("."));
  switch (c.action) {
    case "delete":
      return { fold: "open", why: preventDestroy ? "destroys a resource under prevent_destroy" : "destroys" };
    case "replace":
      return { fold: "open", why: paths.length > 0 ? `replaces, forced by ${paths.join(", ")}` : "replaces" };
    case "forget":
      return { fold: "open", why: "forgets: leaves the resource running, out of state" };
  }
  if (c.kind !== undefined) return { fold: "folded" };
  if (preventDestroy) return { fold: "open", why: "under prevent_destroy" };
  const rule = highlightRule(c.type);
  if (rule && c.action !== "no-op" && c.action !== "read") return { fold: "open", why: rule.why };
  return { fold: "open" };
}

/** Whether a change is one a reader should look at first: it carries a reason. */
export const isHighlighted = (c: { why?: string }): boolean => c.why !== undefined;
