// The comparison grid's rows and every other product's marks. Each mark was
// read from the page its source names, in that product's own docs; where a
// product's docs say nothing about a row, the text says so and the mark is
// the conservative one. terragucci's own column is in ./marks.ts.
import type { Product, Row } from './types';

export const products: Product[] = [
	{ id: 'atlantis', name: 'Atlantis' },
	{ id: 'hcp', name: 'HCP Terraform' },
	{ id: 'spacelift', name: 'Spacelift' },
	{ id: 'digger', name: 'Digger' },
];

export const bands = [
	{ id: 'review', label: 'Review', summary: 'What a reviewer sees on the pull request, and what the policy checks.' },
	{ id: 'apply', label: 'Apply', summary: 'When a change goes out, what an approval covers, and what stops a stale plan.' },
	{ id: 'operate', label: 'Operate', summary: 'What runs where, who holds state and credentials, and what you see afterwards.' },
] as const;

const atlantis = {
	server: { title: 'Server configuration', url: 'https://www.runatlantis.io/docs/server-configuration' },
	api: { title: 'API endpoints', url: 'https://www.runatlantis.io/docs/api-endpoints' },
	policy: { title: 'Policy checking', url: 'https://www.runatlantis.io/docs/policy-checking' },
	automerge: { title: 'Automerging', url: 'https://www.runatlantis.io/docs/automerging' },
	requirements: { title: 'Command requirements', url: 'https://www.runatlantis.io/docs/command-requirements' },
	repoYaml: { title: 'Repo level atlantis.yaml', url: 'https://www.runatlantis.io/docs/repo-level-atlantis-yaml' },
	locking: { title: 'Locking', url: 'https://www.runatlantis.io/docs/locking' },
	workflows: { title: 'Custom workflows', url: 'https://www.runatlantis.io/docs/custom-workflows' },
	faq: { title: 'FAQ', url: 'https://www.runatlantis.io/docs/faq' },
	deployment: { title: 'Deployment', url: 'https://www.runatlantis.io/docs/deployment' },
	credentials: { title: 'Provider credentials', url: 'https://www.runatlantis.io/docs/provider-credentials' },
	stats: { title: 'Metrics', url: 'https://www.runatlantis.io/docs/stats' },
	licence: { title: 'LICENSE', url: 'https://github.com/runatlantis/atlantis/blob/main/LICENSE' },
};

const hcp = {
	ui: { title: 'The UI- and VCS-driven run workflow', url: 'https://developer.hashicorp.com/terraform/cloud-docs/run/ui' },
	vcs: { title: 'Workspace VCS settings', url: 'https://developer.hashicorp.com/terraform/cloud-docs/workspaces/settings/vcs' },
	plans: { title: 'Plans API', url: 'https://developer.hashicorp.com/terraform/cloud-docs/api-docs/plans' },
	policySets: { title: 'Manage policy sets', url: 'https://developer.hashicorp.com/terraform/cloud-docs/policy-enforcement/manage-policy-sets' },
	policyResults: { title: 'View policy results', url: 'https://developer.hashicorp.com/terraform/cloud-docs/workspaces/policy-enforcement/view-results' },
	remote: { title: 'Remote operations', url: 'https://developer.hashicorp.com/terraform/cloud-docs/run/remote-operations' },
	stacks: { title: 'Stacks deployment conditions', url: 'https://developer.hashicorp.com/terraform/cloud-docs/stacks/deploy/conditions' },
	cli: { title: 'The CLI-driven run workflow', url: 'https://developer.hashicorp.com/terraform/cloud-docs/run/cli' },
	settings: { title: 'Workspace settings', url: 'https://developer.hashicorp.com/terraform/cloud-docs/workspaces/settings' },
	runEnv: { title: 'Run environment', url: 'https://developer.hashicorp.com/terraform/cloud-docs/workspaces/run/run-environment' },
	health: { title: 'Health assessments', url: 'https://developer.hashicorp.com/terraform/cloud-docs/workspaces/health' },
	cloudSettings: { title: 'HCP Terraform settings', url: 'https://developer.hashicorp.com/terraform/cli/cloud/settings' },
	dynamic: { title: 'Dynamic provider credentials', url: 'https://developer.hashicorp.com/terraform/cloud-docs/workspaces/dynamic-provider-credentials' },
	telemetry: { title: 'Agent telemetry', url: 'https://developer.hashicorp.com/terraform/cloud-docs/agents/telemetry' },
	registry: { title: 'Publish modules', url: 'https://developer.hashicorp.com/terraform/cloud-docs/registry/publish-modules' },
	overview: { title: 'HCP Terraform overview', url: 'https://developer.hashicorp.com/terraform/cloud-docs/overview' },
};

const spacelift = {
	prComments: { title: 'Pull request comments', url: 'https://docs.spacelift.io/concepts/run/pull-request-comments' },
	stackSettings: { title: 'Stack settings', url: 'https://docs.spacelift.io/concepts/stack/stack-settings' },
	api: { title: 'API', url: 'https://docs.spacelift.io/integrations/api' },
	policy: { title: 'Policies', url: 'https://docs.spacelift.io/concepts/policy' },
	planPolicy: { title: 'Plan policy', url: 'https://docs.spacelift.io/concepts/policy/terraform-plan-policy' },
	promotion: { title: 'Run promotion', url: 'https://docs.spacelift.io/concepts/run/run-promotion' },
	approval: { title: 'Approval policy', url: 'https://docs.spacelift.io/concepts/policy/approval-policy' },
	dependencies: { title: 'Stack dependencies', url: 'https://docs.spacelift.io/concepts/stack/stack-dependencies' },
	run: { title: 'Runs', url: 'https://docs.spacelift.io/concepts/run' },
	locking: { title: 'Stack locking (self-hosted docs)', url: 'https://docs.spacelift.io/self-hosted/v2.6.1/concepts/stack/stack-locking' },
	terragrunt: { title: 'Terragrunt limitations', url: 'https://docs.spacelift.io/vendors/terragrunt/limitations' },
	drift: { title: 'Drift detection', url: 'https://docs.spacelift.io/concepts/stack/drift-detection' },
	workers: { title: 'Worker pools', url: 'https://docs.spacelift.io/concepts/worker-pools' },
	creating: { title: 'Creating a stack', url: 'https://docs.spacelift.io/concepts/stack/creating-a-stack' },
	cloud: { title: 'Cloud providers', url: 'https://docs.spacelift.io/integrations/cloud-providers' },
	prometheus: { title: 'Prometheus exporter', url: 'https://docs.spacelift.io/integrations/observability/prometheus' },
	registry: { title: 'Module registry', url: 'https://docs.spacelift.io/vendors/terraform/module-registry' },
	pricing: { title: 'Pricing', url: 'https://spacelift.io/pricing' },
};

// Digger's docs site no longer resolves; these are the same pages as the
// files its docs are built from, in its own repository.
const digger = {
	noise: { title: 'Noise reduction', url: 'https://github.com/diggerhq/digger/blob/develop/docs/ce/howto/noise-reduction.mdx' },
	include: { title: 'Include and exclude patterns', url: 'https://github.com/diggerhq/digger/blob/develop/docs/ce/howto/include-exclude-patterns.mdx' },
	api: { title: 'Orchestrator API', url: 'https://github.com/diggerhq/digger/blob/develop/docs/ce/reference/api.mdx' },
	conftest: { title: 'Using OPA Conftest', url: 'https://github.com/diggerhq/digger/blob/develop/docs/ce/howto/using-opa-conftest.mdx' },
	applyOnMerge: { title: 'Apply on merge', url: 'https://github.com/diggerhq/digger/blob/develop/docs/ce/howto/apply-on-merge.mdx' },
	requirements: { title: 'Apply requirements', url: 'https://github.com/diggerhq/digger/blob/develop/docs/ce/howto/apply-requirements.mdx' },
	layering: { title: 'Layering', url: 'https://github.com/diggerhq/digger/blob/develop/docs/ce/features/layering.mdx' },
	commentops: { title: 'CommentOps', url: 'https://github.com/diggerhq/digger/blob/develop/docs/ce/features/commentops.mdx' },
	diggerYml: { title: 'digger.yml reference', url: 'https://github.com/diggerhq/digger/blob/develop/docs/ce/reference/digger.yml.mdx' },
	drift: { title: 'Drift detection', url: 'https://github.com/diggerhq/digger/blob/develop/docs/ce/drift/overview.mdx' },
	backendless: { title: 'Backendless mode', url: 'https://github.com/diggerhq/digger/blob/develop/docs/ce/howto/backendless-mode.mdx' },
	state: { title: 'State management', url: 'https://github.com/diggerhq/digger/blob/develop/docs/introduction/state-management.mdx' },
	oidc: { title: 'Authenticating with OIDC on AWS', url: 'https://github.com/diggerhq/digger/blob/develop/docs/ce/cloud-providers/authenticating-with-oidc-on-aws.mdx' },
	telemetry: { title: 'Disable telemetry', url: 'https://github.com/diggerhq/digger/blob/develop/docs/ce/howto/disable-telemetry.mdx' },
	features: { title: 'Features overview', url: 'https://github.com/diggerhq/digger/blob/develop/docs/ce/features/overview.mdx' },
	licence: { title: 'Enterprise LICENSE', url: 'https://github.com/diggerhq/digger/blob/develop/ee/LICENSE' },
};

export const rows: Row[] = [
	{
		id: 'grouped-note',
		band: 'review',
		label: 'One plan note across many roots',
		statement: 'A single note on the pull request covers every root the change reaches, and roots taking the same change are read once.',
		cells: {
			atlantis: { mark: 'warn', text: 'Comments each command\'s plans on the pull request; the docs describe no grouping of roots whose plans are the same', source: atlantis.server },
			hcp: { mark: 'warn', text: 'A status check and a plan link per connected workspace; the plans are read in the HCP Terraform UI', source: hcp.ui },
			spacelift: { mark: 'warn', text: 'A comment per stack run, turned on by a stack label, with checks per stack or aggregated; no grouping of identical plans', source: spacelift.prComments },
			digger: { mark: 'warn', text: 'A comment for every plan or apply plus a summary comment on top; no grouping of identical plans', source: digger.noise },
		},
	},
	{
		id: 'affected-only',
		band: 'review',
		label: 'Plans only what a change affects',
		statement: 'Only the roots a change reaches are planned, including every root that uses a changed local module.',
		cells: {
			atlantis: { mark: 'good', text: 'With --autoplan-modules, which is off by default, it traces local modules and plans every project that uses a changed one', source: atlantis.server },
			hcp: { mark: 'warn', text: 'Runs are filtered by trigger patterns or path prefixes set per workspace; module use is not followed', source: hcp.vcs },
			spacelift: { mark: 'warn', text: 'Runs start on changes under the project root or the project globs you list; module use is not followed', source: spacelift.stackSettings },
			digger: { mark: 'warn', text: 'A Terraform project triggers on the folders you list in include_patterns; Terragrunt projects can cascade to dependents', source: digger.include },
		},
	},
	{
		id: 'json-report',
		band: 'review',
		label: 'Plan report as JSON',
		statement: 'The run\'s plans, for every root, as one documented JSON report a script can read.',
		cells: {
			atlantis: { mark: 'warn', text: 'The /api/plan endpoint returns per-project results as JSON, for a run it starts itself; no JSON report of a pull request\'s plans is documented', source: atlantis.api },
			hcp: { mark: 'warn', text: 'The API returns one run\'s raw JSON plan, with a token that has admin access to the workspace', source: hcp.plans },
			spacelift: { mark: 'warn', text: 'A GraphQL API; the docs describe no JSON report of a run\'s plan results', source: spacelift.api },
			digger: { mark: 'warn', text: 'No run report is documented, and the orchestrator\'s API is described as neither stable nor fully documented', source: digger.api },
		},
	},
	{
		id: 'policy',
		band: 'review',
		label: 'Policy checks on the plan',
		statement: 'Policy runs on every plan as part of the product, and the policies live in git where your team reviews them.',
		cells: {
			atlantis: { mark: 'good', text: 'Conftest policies run on each plan and block apply; policy sets are named in the server\'s config, so its operators control them', source: atlantis.policy },
			hcp: { mark: 'warn', text: 'Sentinel and OPA policy sets; the Free edition has one set of up to five policies, and sets kept in git need Standard or Premium', source: hcp.policySets },
			spacelift: { mark: 'warn', text: 'OPA plan, approval and push policies, managed by Spacelift admins; the pricing page lists the policy engine from Starter+', source: spacelift.policy },
			digger: { mark: 'warn', text: 'Conftest runs over Rego in your repo as a workflow step you add; OPA access policies are set through the orchestrator\'s API', source: digger.conftest },
		},
	},
	{
		id: 'override',
		band: 'review',
		label: 'Policy override',
		statement: 'Named people can let a plan through a failed policy, and the override is recorded.',
		cells: {
			atlantis: { mark: 'good', text: 'Owners named per policy set approve a failure with atlantis approve_policies, and self-approval can be blocked', source: atlantis.policy },
			hcp: { mark: 'warn', text: 'Teams with the manage policy overrides permission can override; the docs do not say whether it is recorded', source: hcp.policyResults },
			spacelift: { mark: 'warn', text: 'Deny rules fail the run with no override; warn rules send the run to a human review that approval policies can limit', source: spacelift.planPolicy },
			digger: { mark: 'bad', text: 'The docs describe no override of a failed policy check', source: digger.conftest },
		},
	},
	{
		id: 'apply-when',
		band: 'apply',
		label: 'Apply before or after merge',
		statement: 'Each project chooses whether a change applies on the open pull request or after merge.',
		cells: {
			atlantis: { mark: 'warn', text: 'Applies on the open pull request, and can merge it once every plan has applied; no apply-after-merge mode is documented', source: atlantis.automerge },
			hcp: { mark: 'warn', text: 'Pull requests get speculative plans only; applies come from runs on the connected branch or from the CLI', source: hcp.ui },
			spacelift: { mark: 'good', text: 'Tracked runs apply after merge; run promotion or a push policy deploys a pull request\'s commit before merge, set per stack', source: spacelift.promotion },
			digger: { mark: 'good', text: 'Applies on the open pull request by default; a project\'s workflow can apply on merge instead', source: digger.applyOnMerge },
		},
	},
	{
		id: 'approval-binds',
		band: 'apply',
		label: 'What an approval binds to',
		statement: 'An approval covers the exact saved plan that applies, and nothing else can apply under it.',
		cells: {
			atlantis: { mark: 'warn', text: 'The approved requirement asks for a pull request approval; apply uses the saved plan file, but the approval is not bound to it', source: atlantis.requirements },
			hcp: { mark: 'good', text: 'Confirming a run applies that run\'s own plan', source: hcp.remote },
			spacelift: { mark: 'warn', text: 'A review is stored on the run and read by the approval policy; the docs do not say the apply reuses the reviewed plan', source: spacelift.approval },
			digger: { mark: 'warn', text: 'The approved requirement checks for a pull request approval, not a particular plan', source: digger.requirements },
		},
	},
	{
		id: 'waves',
		band: 'apply',
		label: 'Staged rollout in waves',
		statement: 'Changed roots go out in ordered groups, and each group waits for its own approval.',
		cells: {
			atlantis: { mark: 'warn', text: 'execution_order_group and depends_on order plans and applies; no approval per group is documented', source: atlantis.repoYaml },
			hcp: { mark: 'warn', text: 'Run triggers chain workspaces, each run confirmed on its own; orchestration rules for Stacks deployment groups need the Plus edition', source: hcp.stacks },
			spacelift: { mark: 'warn', text: 'Stack dependencies run tracked runs in order and stop the chain on a failure; no approval per group is documented', source: spacelift.dependencies },
			digger: { mark: 'warn', text: 'Layering orders projects into layers you plan and apply one at a time by comment; no approval per layer is documented', source: digger.layering },
		},
	},
	{
		id: 'refuse-changed',
		band: 'apply',
		label: 'Refuses a plan that changed after approval',
		statement: 'If what would apply is not what was approved, nothing applies until someone approves again.',
		cells: {
			atlantis: { mark: 'warn', text: 'The undiverged requirement blocks apply when the base branch changed since the last plan; the docs do not say an approval resets', source: atlantis.requirements },
			hcp: { mark: 'good', text: 'A saved plan whose state changed under it is detected as stale and discarded', source: hcp.cli },
			spacelift: { mark: 'warn', text: 'Proposed runs stop when newer code is pushed; the docs do not say a tracked run\'s approval is dropped', source: spacelift.run },
			digger: { mark: 'warn', text: 'The undiverged requirement blocks apply when the base branch changed; nothing compares the plan with the approved one', source: digger.requirements },
		},
	},
	{
		id: 'locks',
		band: 'apply',
		label: 'Root locks',
		statement: 'A root is held by one pull request or run at a time, with a documented way to release it.',
		cells: {
			atlantis: { mark: 'good', text: 'A plan locks the directory and workspace to the pull request until it merges or closes; atlantis unlock releases it', source: atlantis.locking },
			hcp: { mark: 'good', text: 'A workspace runs one run at a time, and admins can lock, unlock and force unlock it', source: hcp.settings },
			spacelift: { mark: 'warn', text: 'A stack can be locked to a person, not a pull request; only its creator or an admin releases it', source: spacelift.locking },
			digger: { mark: 'good', text: 'Pull request locks hold a project for one pull request; a digger unlock comment releases them', source: digger.commentops },
		},
	},
	{
		id: 'terragrunt',
		band: 'apply',
		label: 'Terragrunt waves with gates',
		statement: 'Terragrunt units go out in dependency order, in groups that each wait for an approval.',
		cells: {
			atlantis: { mark: 'warn', text: 'Terragrunt runs through custom workflows; no gated groups of units are documented', source: atlantis.workflows },
			hcp: { mark: 'bad', text: 'The run environment documents Terraform only; no page mentions Terragrunt', source: hcp.runEnv },
			spacelift: { mark: 'warn', text: 'run-all follows Terragrunt dependencies, with no gated groups, and the apply does not use the plan files', source: spacelift.terragrunt },
			digger: { mark: 'warn', text: 'Projects are generated from Terragrunt with its dependency order and execution-order groups; no gate per group is documented', source: digger.diggerYml },
		},
	},
	{
		id: 'drift',
		band: 'operate',
		label: 'Drift detection',
		statement: 'A scheduled check plans every root and reports drift where the team will see it.',
		cells: {
			atlantis: { mark: 'warn', text: 'An alpha drift API with webhook notifications and no scheduler; you call it from a cron of your own', source: atlantis.faq },
			hcp: { mark: 'warn', text: 'Health assessments report drift in the workspace and by notification, in the Standard and Premium editions', source: hcp.health },
			spacelift: { mark: 'warn', text: 'Scheduled drift detection with reconcile runs and webhooks, on private workers and the Starter+ plan', source: spacelift.drift },
			digger: { mark: 'good', text: 'Scheduled drift checks in GitHub Actions report to Slack or GitHub issues', source: digger.drift },
		},
	},
	{
		id: 'hosting',
		band: 'operate',
		label: 'Nothing new to host',
		statement: 'It runs on the CI runners you already have, with no server or service of its own.',
		cells: {
			atlantis: { mark: 'warn', text: 'You run the Atlantis server, a Go app or container, on Kubernetes, a VM or similar', source: atlantis.deployment },
			hcp: { mark: 'warn', text: 'A service HashiCorp runs; agents in your network are optional and a paid feature', source: hcp.remote },
			spacelift: { mark: 'warn', text: 'A service Spacelift runs, on its workers or on private workers in your infrastructure', source: spacelift.workers },
			digger: { mark: 'warn', text: 'Jobs run in your CI; full features need an orchestrator backend, Digger\'s hosted app or one you run', source: digger.backendless },
		},
	},
	{
		id: 'state',
		band: 'operate',
		label: 'State stays in your backend',
		statement: 'State stays in the backend your roots already use, and the tool never has to hold it.',
		cells: {
			atlantis: { mark: 'good', text: 'Atlantis has no external database; your roots keep their own backend', source: atlantis.deployment },
			hcp: { mark: 'bad', text: 'Each workspace keeps its state in HCP Terraform', source: hcp.cloudSettings },
			spacelift: { mark: 'warn', text: 'Spacelift can hold state if chosen when the stack is created; otherwise your backend keeps it', source: spacelift.creating },
			digger: { mark: 'good', text: 'Teams bring their own backend; Digger\'s state service is optional', source: digger.state },
		},
	},
	{
		id: 'credentials',
		band: 'operate',
		label: 'Cloud credentials stay with you',
		statement: 'Cloud access comes from your own runners\' identity, and the product never holds a credential.',
		cells: {
			atlantis: { mark: 'warn', text: 'Credentials live on the Atlantis server, as environment variables, files or an instance role', source: atlantis.credentials },
			hcp: { mark: 'warn', text: 'Each run gets an OIDC token that HashiCorp\'s runners or your agents trade for short-lived credentials', source: hcp.dynamic },
			spacelift: { mark: 'warn', text: 'Spacelift\'s workers get short-lived generated credentials; private workers can use your own cloud roles', source: spacelift.cloud },
			digger: { mark: 'good', text: 'The job in your own CI trades its OIDC token for your role', source: digger.oidc },
		},
	},
	{
		id: 'telemetry',
		band: 'operate',
		label: 'Traces and metrics',
		statement: 'Each run sends traces and metrics to a backend you choose.',
		cells: {
			atlantis: { mark: 'warn', text: 'Run metrics to Statsd or Prometheus; no traces are documented', source: atlantis.stats },
			hcp: { mark: 'warn', text: 'Self-hosted agents send OpenTelemetry metrics and traces; runs on HashiCorp\'s workers are not covered', source: hcp.telemetry },
			spacelift: { mark: 'warn', text: 'A Prometheus exporter you run against the API, or a Datadog module built on notification policies', source: spacelift.prometheus },
			digger: { mark: 'bad', text: 'No metrics or traces of runs are documented, only anonymized product telemetry', source: digger.telemetry },
		},
	},
	{
		id: 'modules',
		band: 'operate',
		label: 'Module publishing and pinned rollouts',
		statement: 'Modules are published as versions, and a new version is rolled out to the roots that pin it.',
		cells: {
			atlantis: { mark: 'bad', text: 'The docs describe no module publishing or rollout of a pinned version', source: atlantis.faq },
			hcp: { mark: 'warn', text: 'The private registry publishes modules from tags or branches; rolling a version out to its users is not documented', source: hcp.registry },
			spacelift: { mark: 'warn', text: 'A private registry with version tests that can trigger the stacks using a module; nothing moves their pins', source: spacelift.registry },
			digger: { mark: 'bad', text: 'The docs describe no module registry or rollout', source: digger.features },
		},
	},
	{
		id: 'licence',
		band: 'operate',
		label: 'Licence and cost',
		statement: 'Open source and free to run, with no paid tier holding a feature back.',
		cells: {
			atlantis: { mark: 'good', text: 'Apache 2.0, free to run', source: atlantis.licence },
			hcp: { mark: 'warn', text: 'A proprietary service priced per managed resource; Free organizations are limited to 500', source: hcp.overview },
			spacelift: { mark: 'warn', text: 'A proprietary service, free for small teams; paid plans start at $20,000 a year', source: spacelift.pricing },
			digger: { mark: 'warn', text: 'The core is MIT, while the ee folder is under an enterprise licence', source: digger.licence },
		},
	},
];
