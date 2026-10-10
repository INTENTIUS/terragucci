/**
 * The concepts table of the guide "Coming from HCP Terraform, Scalr or OTF"
 * (docs-site/src/content/docs/guides/coming-from-hcp-terraform-scalr-or-otf.mdx),
 * cell for cell. `terragucci import hcp`, `import otf` and `import scalr`
 * name a row of it in each note they print, and a test
 * (test/import-workspaces.test.ts) holds the page and this table equal.
 */
import { plain } from "./guide";

/** The page the table comes from. */
export const PLATFORM_GUIDE_URL = "https://intentius.io/terragucci/guides/coming-from-hcp-terraform-scalr-or-otf/";

/** `## Concepts`: HCP Terraform, Scalr, OTF; terragucci. */
export const CONCEPTS_TABLE = [
  ["Workspace", "a [root](/terragucci/concepts/glossary/#root): one directory, one state. terragucci runs no CLI workspaces"],
  ["Several workspaces on one working directory", "a directory per workspace, each with its backend key and `terraform.tfvars`, calling a shared module"],
  ["Workspace state", "a key in your S3 bucket, moved by a [backend move](#state-move)"],
  ["Terraform variables", "`terraform.tfvars` in the root, committed"],
  ["Environment variables, variable sets", "[`env`](/terragucci/reference/config/#keys) for values; CI secrets named under [`pass`](#variables) for the rest"],
  ["Dynamic provider credentials", "[`oidc`](/terragucci/reference/environment/#cloud-roles-over-oidc): a plan role and an apply role per cloud"],
  ["Terraform version per workspace", "[`version`](/terragucci/reference/config/#a-version-per-root) per root glob, or the root's `.terraform-version`"],
  ["VCS-driven runs, trigger patterns", "the [generated pipeline](/terragucci/getting-started/): a pull request plans the roots its files reach"],
  ["Speculative plan", "the plan note and `terragucci/plan` status on the pull request"],
  ["Confirm and apply, auto-apply", "[`gate`](/terragucci/reference/stages/#gate-policy): `always`, `on-destroy` (default) or `never`, then [approve a wave](/terragucci/guides/approve-a-wave/)"],
  ["Run triggers, `tfe_outputs`", "[waves](/terragucci/concepts/waves-and-approvals/#linked-roots): a root that reads another through `terraform_remote_state` applies in a later wave; `waves.after`, which an import writes from run triggers, for an order the reads do not give"],
  ["Sentinel policy set", "[`policy`](/terragucci/reference/policy/) in Rego, rewritten by hand"],
  ["OPA policy set", "`policy.input: hcp` with `engine: opa`; `policies.hcl` [runs as is](/terragucci/reference/policy/#hcp-terraform-policy-sets)"],
  ["Scalr OPA policy group", "`policy` with `engine: opa` and `input: plan`, each policy's `input.tfplan` changed to `input`; a check of `input.tfrun` is rewritten"],
  ["Soft-mandatory override", "[`terragucci override`](/terragucci/reference/policy/#overriding-a-denial) by a person `policy.override` lists"],
  ["Run tasks", "[`steps`](/terragucci/guides/run-steps/) after `plan`, with `on_failure: fail` or `approve`"],
  ["Workspace lock", "[root locks](/terragucci/reference/config/#plan-locks) and the backend's lock file"],
  ["Agents, remote execution", "jobs on your CI's runners, your own ones by label with [`runner`](/terragucci/guides/add-to-a-repo/#self-hosted-runners)"],
  ["Health assessments", "[`drift`](/terragucci/guides/turn-on-drift-checks/), a cron schedule"],
  ["Cost estimation", "[`cost`](/terragucci/guides/estimate-cost/) with Infracost"],
  ["Notifications", "[`notify`](/terragucci/guides/notify-a-chat-channel/): Slack, Teams or a signed webhook"],
  ["Private registry", "[a module registry](/terragucci/guides/publish-modules/#serve-a-module-registry) in your bucket"],
  ["Ephemeral workspaces", "[ephemeral environments](/terragucci/guides/ephemeral-environments/) per pull request, with a TTL"],
  ["Teams and permissions", "your forge's permissions and cloud IAM ([access and identity](/terragucci/standards/access-and-identity/))"],
  ["Run history", "the [report](/terragucci/guides/keep-reports-in-a-bucket/) per run and [`chant/lifecycle`](/terragucci/concepts/glossary/#chantlifecycle)"],
] as const satisfies readonly (readonly [string, string])[];

export type ConceptRow = (typeof CONCEPTS_TABLE)[number][0];

/** The terragucci cell of a concept row. */
export function conceptCell(row: ConceptRow): string {
  return plain(CONCEPTS_TABLE.find((r) => r[0] === row)![1]);
}
