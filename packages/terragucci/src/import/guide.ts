/**
 * The tables of the guide "Coming from Atlantis or OpenTaco"
 * (docs-site/src/content/docs/guides/coming-from-atlantis-or-opentaco.mdx),
 * cell for cell. `terragucci import atlantis` and `import digger` map
 * settings by these rows and print their text, and the `atlantis plan` and
 * `atlantis apply` comment aliases quote them when they refuse a form. A test
 * (test/import.test.ts) holds the page and these tables equal, so the command
 * says what the page says: change one and the other with it.
 */

/** The page the tables come from. */
export const GUIDE_URL = "https://intentius.io/terragucci/guides/coming-from-atlantis-or-opentaco/";

/** `## Settings`: setting, Atlantis, OpenTaco (`digger.yml`), terragucci (`terragucci.yml`). */
export const SETTINGS_TABLE = [
  ["Which directories", "`projects[].dir`, `autodiscover`", "`projects[].dir`, `generate_projects`", "detected: every directory with a backend, `cloud` block or provider; `roots` globs to narrow, which an import writes from the projects' directories"],
  ["Project name", "`projects[].name`", "`projects[].name`", "none: a root goes by its path from the repo root"],
  ["Workspace", "`projects[].workspace`", "`projects[].workspace`", "none: each root is a directory with one state"],
  ["What triggers a plan", "`autoplan.when_modified`, `autoplan.enabled`", "`include_patterns`, `exclude_patterns`, `on_pull_request_pushed`", "no key: a root plans when a file in it, a local module it calls or its var files changed, and so does every root that reads its state"],
  ["Binary version", "`terraform_version`", "a project's `opentofu`, or the action's `terraform-version` or `opentofu-version` input", "`binary` and `version`, or the pins the roots carry"],
  ["Order", "`execution_order_group`, `depends_on`, `abort_on_execution_order_fail`", "`depends_on`, layering", "waves from `terraform_remote_state` reads; `waves.canary` puts roots first; Terragrunt's dependency layers"],
  ["Concurrency", "`parallel_plan`, `parallel_apply`", "", "`parallelism` within a job: 1 when either is false, otherwise read from the state backend; `waves.jobs` to spread one wave over several jobs (plain roots on GitHub and Forgejo)"],
  ["Required approval", "`apply_requirements: [approved]`", "`apply_requirements: [approved]`", "branch protection for a merge; with `apply.when: pull-request`, `apply.requires: [approved]`: a reviewer other than the author approved the head"],
  ["Checks green", "`apply_requirements: [mergeable]`", "`apply_requirements: [mergeable]`", "with `apply.when: pull-request`, `apply.requires: [mergeable, checks]`: the forge can merge it, no status failed or running, and `terragucci/plan` passed"],
  ["Up to date", "`apply_requirements: [undiverged]`", "`apply_requirements: [undiverged]`", "with `apply.when: pull-request`, `apply.requires: [undiverged]`: the head contains the default branch"],
  ["Plan requirements", "`plan_requirements`", "", "none: every pull request from the repo itself plans, and a comment plans for someone with write access"],
  ["Apply on merge", "", "`on_commit_to_default: [digger apply]`", "the default, `apply.when: merge`"],
  ["Merge after apply", "`automerge`", "`auto_merge`", "`apply.merge: auto` with `apply.when: pull-request`"],
  ["Lock at plan time", "`repo_locks.mode: on_plan`", "`pr_locks`", "`locks: plan` (GitHub, Forgejo); unset, a root locks when it applies before merge"],
  ["Release locks on close", "automatic", "`on_pull_request_closed: [digger unlock]`, `on_commit_to_default: [digger unlock]`", "automatic: a lock whose pull request merged or closed counts as released"],
  ["Policy", "conftest, set in the server's config; a workflow's `policy_check`; a project's `custom_policy_check`", "a conftest step you add", "`policy`: conftest or OPA over each plan, with Rego in the repo or a shared policy repo at a pinned ref (`policy.source`); the base branch's key decides"],
  ["Custom steps", "`workflows`", "`workflows`", "none: the jobs are generated; `env` sets variables every job gets, which an import writes from the workflows' `env` steps that set a fixed value"],
  ["Cloud credentials", "the server's environment", "`aws-role-to-assume` in your workflow, or a project's `aws_role_to_assume`, over OIDC", "`oidc`: a plan role and an apply role per cloud, from the forge's identity token"],
  ["Many repos", "the server's repo config", "", "a control repo's `defaults` and `projects` ([Govern many repos](/terragucci/guides/govern-many-repos/))"],
  ["Terragrunt", "a custom workflow, or terragrunt-atlantis-config", "`generate_projects` with Terragrunt parsing, or a project's `terragrunt`", "detected; `terragrunt` for the version, excludes and roles ([Use Terragrunt](/terragucci/guides/use-terragrunt/))"],
  ["Drift", "drift webhooks", "drift detection", "`drift`, a cron schedule"],
] as const satisfies readonly (readonly [string, string, string, string])[];

/** `## Left out on purpose`: not here, in `atlantis.yaml` or `digger.yml`, terragucci's rule, do this instead. */
export const LEFT_OUT_TABLE = [
  ["`import` or `state rm` from a comment", "a workflow's `import` or `state_rm`, `import_requirements`", "every state change comes from a reviewed commit, through a plan and the gate", "an `import` or `removed` block in the change: it plans, shows in the plan note and waits at the gate like any other change"],
  ["Passing a failed policy from a comment", "", "a policy decides from the base branch; an override names one root's plan and its rules, and only a person the base lists can write one", "change the code, change the policy in a reviewed pull request, or [`terragucci override`](/terragucci/reference/policy/#overriding-a-denial) by a listed approver"],
  ["Approving from a comment", "", "an approval binds the wave's set digest, which a comment does not carry", "`terragucci approve` from a checkout, a review under `approval: pr-review`, or a relay of your own that runs `terragucci approve --plan <digest>` on the [signed webhook](/terragucci/guides/notify-a-chat-channel/#send-events-to-your-own-webhook); the approval is signed only under `approval: sealed`"],
  ["Applying one root of a wave", "", "an approval covers the wave's plans as one set", "split the change, or `waves.canary` to send roots out first"],
  ["Flags at run time", "a step's `extra_args`", "what an approval covers is fixed by the commit and the config", "the change itself, or a key in `terragucci.yml`"],
  ["A server or web UI", "", "the jobs run in your CI and write to your git and your bucket", "the plan note, the report artifact, and [`chant/lifecycle`](/terragucci/concepts/glossary/#chantlifecycle)"],
] as const satisfies readonly (readonly [string, string, string, string])[];

/** `## Apply before or after merge`: (when), Atlantis, OpenTaco, terragucci. */
export const APPLY_TIMING_TABLE = [
  ["Default", "before merge", "before merge; `on_commit_to_default` applies after", "after merge"],
  ["The other way", "", "`on_commit_to_default`", "`apply.when: pull-request`; on GitLab with `comments:` set"],
] as const satisfies readonly (readonly [string, string, string, string])[];

/** `## Comment commands`: to do this, Atlantis, OpenTaco, terragucci. */
export const COMMENT_TABLE = [
  ["Plan what the change reaches", "`atlantis plan`", "`digger plan`", "push to the pull request, or comment `/terragucci plan`"],
  ["Plan one project", "`atlantis plan -d <dir>` or `-p <project>`", "`digger plan -p <project>`", "`/terragucci plan <root>`, the root's path from the repo root"],
  ["Plan one workspace", "`atlantis plan -w <workspace>`", "a project's `workspace`", "no flag: each root is a directory with one state"],
  ["Pass flags to the binary", "`atlantis plan -- <flags>`", "a workflow step", "none"],
  ["Apply", "`atlantis apply`, before merge", "`digger apply`, before merge by default", "merge: the default branch's wave jobs apply ([before merge](#apply-before-or-after-merge) is a setting)"],
  ["Apply part of the change", "`atlantis apply -d <dir>` or `-p <project>`", "`digger apply -p <project>`", "`/terragucci apply wave-<n>` applies the approved waves up to wave n; no single-root apply"],
  ["Re-run an approved apply", "`atlantis apply`", "`digger apply`", "`/terragucci apply` on the merged pull request"],
  ["Lock", "at plan time", "`digger lock`, or at plan time", "with [`locks: plan`](/terragucci/reference/config/#plan-locks) (GitHub, Forgejo), from the first plan; otherwise when it applies before merge or on `/terragucci lock`, with `apply.when: pull-request`"],
  ["Unlock", "`atlantis unlock`", "`digger unlock`", "`/terragucci unlock`, with `apply.when: pull-request` or `locks: plan`"],
  ["Import", "`atlantis import <address> <id>`", "none", "refused; [an `import` block](#left-out-on-purpose) in the change"],
  ["Remove from state", "`atlantis state rm <address>`", "none", "refused; [a `removed` block](#left-out-on-purpose) in the change"],
  ["Pass a failed policy", "`atlantis approve_policies`", "none", "refused from a comment; a person `policy.override` lists runs [`terragucci override`](/terragucci/reference/policy/#overriding-a-denial) for one root's plan"],
  ["Approve", "the forge's review", "the forge's review", "[`terragucci approve`](/terragucci/reference/cli/#approve) (it runs [`chant approve`](/terragucci/concepts/glossary/#chant)) for a wave its gate holds, or the forge's review under [`approval: pr-review`](/terragucci/guides/approve-a-wave/#approval-modes)"],
] as const satisfies readonly (readonly [string, string, string, string])[];

export type SettingRow = (typeof SETTINGS_TABLE)[number][0];
export type LeftOutRow = (typeof LEFT_OUT_TABLE)[number][0];
export type CommentRow = (typeof COMMENT_TABLE)[number][0];

/** A cell as plain text: a link keeps its words. */
export function plain(cell: string): string {
  return cell.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
}

/** The terragucci cell of a settings row. */
export function settingCell(row: SettingRow): string {
  return plain(SETTINGS_TABLE.find((r) => r[0] === row)![3]);
}

/** A left-out row's rule and what to do instead. */
export function leftOut(row: LeftOutRow): { rule: string; instead: string } {
  const r = LEFT_OUT_TABLE.find((x) => x[0] === row)!;
  return { rule: plain(r[2]), instead: plain(r[3]) };
}

/** The terragucci cell of a comment row. */
export function commentCell(row: CommentRow): string {
  return plain(COMMENT_TABLE.find((r) => r[0] === row)![3]);
}
