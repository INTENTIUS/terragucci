/**
 * The concepts table of the guide "Coming from Spacelift or env zero"
 * (docs-site/src/content/docs/guides/coming-from-spacelift-or-env-zero.mdx),
 * cell for cell. `terragucci import spacelift` and `import env0` map settings
 * by these rows and print their terragucci cell. A test
 * (test/import-spacelift.test.ts) holds the page and this table equal.
 */
import { plain } from "./guide";
import type { Notes, NoteKind } from "./notes";

/** The page the table comes from. */
export const SPACELIFT_ENV0_GUIDE_URL = "https://intentius.io/terragucci/guides/coming-from-spacelift-or-env-zero/";

/** `## Concepts`: concept, Spacelift, env zero, terragucci. */
export const SPACELIFT_ENV0_TABLE = [
  ["Root", "stack", "environment", "a [root](/terragucci/concepts/glossary/#root): one directory, one state; an import writes `roots` from the stacks' project roots or the environments' template paths"],
  ["Shared code", "several stacks on one project root", "several environments from one template", "a directory per stack or environment, each with its backend key and `terraform.tfvars`, calling a shared module"],
  ["Workspace", "`terraform_workspace`", "`workspaceName`, `workspace`", "none: each root is a directory with one state"],
  ["Managed state", "managed state, `manage_state`", "env zero's remote backend, `isRemoteBackend`", "a key in your S3 bucket, moved by a [backend move](#state-move); an import names each stack or environment whose state moves"],
  ["Own backend", "your own backend", "your own S3 backend", "the same backend; nothing moves"],
  ["Variables", "context and stack environment variables", "variables", "[`env`](/terragucci/reference/config/#keys) for values every root gets; a secret's name under [`pass`](#variables), whose value you create as a CI secret; a root's own values in its `terraform.tfvars`"],
  ["Files", "context and stack mounted files", "", "files committed in the root, such as `terraform.tfvars`"],
  ["Cloud credentials", "cloud integration", "credentials", "[`oidc`](/terragucci/reference/environment/#cloud-roles-over-oidc): a plan role and an apply role per cloud"],
  ["Version", "`terraform_version`, `opentofu_version`, `terraform_workflow_tool`", "a template's `type`, `terraform_version`, `opentofu_version`", "`binary`, and [`version`](/terragucci/reference/config/#a-version-per-root) for every root or per root glob, or the root's `.terraform-version`"],
  ["Hooks", "hooks: `before_init`, `after_plan`, `before_apply` and the rest", "custom flows (`env0.yml`)", "[`steps`](/terragucci/guides/run-steps/) before or after `init`, `plan`, `apply` and `drift`, for the roots the hook ran in; nothing runs at a destroy or a task"],
  ["Runner image", "`runner_image`", "", "`image`: one image for every job, built FROM the terragucci image for the binary"],
  ["Plan policy", "plan policy", "approval policy (OPA)", "[`policy`](/terragucci/reference/policy/) over each plan, with [cost](/terragucci/guides/estimate-cost/#cost-in-the-policy) in `input.cost`"],
  ["Approval", "approval policy, `autodeploy` off", "approval policy, `requiresApproval`", "[`gate`](/terragucci/reference/stages/#gate-policy) and [approval modes](/terragucci/guides/approve-a-wave/#approval-modes); [`cost.approve_above`](/terragucci/guides/estimate-cost/#hold-a-wave-over-an-amount); an import writes `gate: always` when every stack or environment waits for an approval"],
  ["Triggers", "push and trigger policies, project globs", "triggers, `continuousDeployment`, `pullRequestPlanDeployments`", "the [generated pipeline](/terragucci/getting-started/): a pull request plans the roots its files reach; merge applies them"],
  ["Order", "stack dependencies, output references", "workflows", "[waves](/terragucci/concepts/waves-and-approvals/#linked-roots): a root that reads another through `terraform_remote_state` applies in a later wave; an import writes `waves.after` for a stack dependency the reads do not give"],
  ["Access", "login policy, spaces", "RBAC", "your forge's permissions and cloud IAM ([access and identity](/terragucci/standards/access-and-identity/))"],
  ["Notifications", "notification policy", "notifications", "[`notify`](/terragucci/guides/notify-a-chat-channel/): Slack, Teams or a signed webhook"],
  ["Drift", "drift detection", "drift detection, `driftDetectionCron`", "[`drift`](/terragucci/guides/turn-on-drift-checks/), one cron schedule over every root, and a pull request for drift on a literal; it never reconciles"],
  ["TTL", "", "environment TTL", "[ephemeral environments](/terragucci/guides/ephemeral-environments/) per pull request, with a TTL; an import writes `ephemeral` for the environments that expire"],
  ["Cost", "", "cost monitoring", "[`cost`](/terragucci/guides/estimate-cost/): an estimate per plan, not billed spend"],
  ["Workers", "private workers, `worker_pool_id`", "self-hosted agents", "your CI's runners, your own ones by label with [`runner`](/terragucci/guides/add-to-a-repo/#self-hosted-runners)"],
  ["Module registry", "module registry", "module registry", "[a module registry](/terragucci/guides/publish-modules/#serve-a-module-registry) in your bucket"],
  ["Run history", "run history", "deployment log", "the [report](/terragucci/guides/keep-reports-in-a-bucket/) per run and [`chant/lifecycle`](/terragucci/concepts/glossary/#chantlifecycle)"],
] as const satisfies readonly (readonly [string, string, string, string])[];

export type SpaceliftEnv0Row = (typeof SPACELIFT_ENV0_TABLE)[number][0];

/** The terragucci cell of a concept row. */
export function spaceliftEnv0Cell(row: SpaceliftEnv0Row): string {
  return plain(SPACELIFT_ENV0_TABLE.find((r) => r[0] === row)![3]);
}

/** A note by a concept row. */
export function noteConcept(notes: Notes, kind: Exclude<NoteKind, "left-out">, key: string, row: SpaceliftEnv0Row, detail?: string): void {
  notes.cell(kind, key, row, spaceliftEnv0Cell(row), detail);
}

/** A setting the table has no row for. */
export function noteUnknown(notes: Notes, key: string, detail?: string): void {
  notes.own(key, "unmapped", `the guide has no row for it, so nothing was written; see ${SPACELIFT_ENV0_GUIDE_URL}`, detail);
}

/** A setting of the platform's own that has nothing to carry over. */
export function notePlatformOnly(notes: Notes, key: string, platform: string, detail?: string): void {
  notes.own(key, "default", `${platform}'s own setting, with nothing to carry over`, detail);
}
