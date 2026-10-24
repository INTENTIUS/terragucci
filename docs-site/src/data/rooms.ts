// The doors and rooms of the site. The picker on the home page reads every
// list here, and each page under rooms/ renders one room with Room.astro.
// A room opens with what works, then what you can count on, what differs and
// the first step; its links then go how-to, explanation, reference.
// Paths are relative to the site base.

export type Link = { label: string; href: string };

export type Room = {
	id: string;
	title: string;
	/** One line: who the room is for. */
	lede: string;
	/** The CoverageGrid column that shows what is proven for this room, if one fits. */
	column?: string;
	works: string[];
	differs: string[];
	first: Link;
	/**
	 * For a tool's room: what the tool already does that overlaps terragucci,
	 * each linked to the tool's own docs, when to use that instead, and what
	 * terragucci adds on top. Each line holds to what those docs and terragucci's
	 * source say.
	 */
	native?: { tool: string; has: Link[]; choose: string; adds: string[] };
	howto: Link[];
	explain: Link[];
	reference: Link[];
};

/** What every room can count on, whatever it runs. Each line links where it is shown. */
export const ASSUMED: Link[] = [
	{ label: 'A plan note on every pull request', href: '/getting-started/' },
	{ label: 'Gated applies of the plans you approved', href: '/guides/approve-a-wave/' },
	{ label: 'No overlapping or stale applies', href: '/concepts/locking-and-staleness/' },
	{ label: 'Re-plan from a comment', href: '/guides/re-plan-from-a-comment/' },
	{ label: 'Scheduled drift checks', href: '/guides/turn-on-drift-checks/' },
	{ label: 'OIDC roles, one to plan, one to apply', href: '/guides/add-to-a-repo/' },
	{ label: 'Policy on every plan', href: '/guides/write-a-policy/' },
	{ label: 'An audit trail in your bucket', href: '/guides/read-the-audit-trail/' },
	{ label: 'Secrets kept out of notes and logs', href: '/guides/keep-secrets-out-of-notes/' },
	{ label: 'Your state backend, as is', href: '/reference/state-backends/' },
	{ label: 'Your own runners', href: '/guides/add-to-a-repo/' },
	{ label: 'Your forge\'s sign-in and permissions', href: '/standards/access-and-identity/' },
];

/** What the site does not do, each with its reason. Shown on the home page and in the picker. */
export const LIMITS: { label: string; why: string; href?: string }[] = [
	{ label: 'Bitbucket and Azure DevOps', why: 'init writes pipelines for GitHub, GitLab and Forgejo only.', href: '/standards/tacos-guru/' },
	{ label: 'Accounts, sign-in and roles of its own', why: 'Your forge decides who signs in and approves, and your cloud IAM decides what each job reaches.', href: '/standards/access-and-identity/' },
	{ label: 'A hosted web UI', why: 'Runs show on your forge\'s run pages and on the estate page in your bucket.', href: '/guides/see-every-project/' },
	{ label: 'A server or database to run', why: 'Every job runs in your CI and writes to your git and your bucket.', href: '/concepts/how-it-works/#components' },
];

/** The repo shapes, each a tile on the picker with a short line under its name, unless `picker` is false. */
export const SHAPES: { id: string; label: string; blurb: string; room: string; picker?: false }[] = [
	{ id: 'plain', label: 'Plain roots', blurb: 'Directories of .tf files', room: 'plain-roots' },
	{ id: 'terragrunt', label: 'Terragrunt', blurb: 'Units, stacks, Scale', room: 'terragrunt' },
	{ id: 'atmos', label: 'Atmos', blurb: 'Component instances', room: 'atmos' },
	{ id: 'terramate', label: 'Terramate', blurb: 'Stacks with order', room: 'terramate', picker: false },
	{ id: 'cdktn', label: 'CDK Terrain', blurb: 'Synthesized stacks', room: 'cdk-terrain' },
];

/** The binaries: what each adds to the Works card, what differs, and its page. */
export const BINARIES: { id: string; label: string; adds: string[]; differs: string[]; href: string }[] = [
	{ id: 'tofu', label: 'OpenTofu', adds: [], differs: [], href: '/guides/use-a-binary/' },
	{
		id: 'terraform',
		label: 'Terraform',
		adds: [],
		differs: ['Two overlapping pushes to one root can fail the newer apply with "Saved plan is stale"; run it again and it plans again.'],
		href: '/guides/use-a-binary/',
	},
	{
		id: 'choudoufu',
		label: 'choudoufu',
		adds: [
			'Applies to different resources of one estate run at the same time',
			'One record per resource in a bucket you own, with no lock table',
		],
		differs: ['terragucci does not read a root\'s required_version as a choudoufu release.'],
		href: '/for/choudoufu/',
	},
];

export const FORGES: { id: string; label: string; differs: string[]; href: string }[] = [
	{ id: 'github', label: 'GitHub', differs: [], href: '/guides/add-to-a-repo/#per-forge' },
	{
		id: 'gitlab',
		label: 'GitLab',
		differs: [
			'Comment commands answer on a schedule, since a merge request note starts no pipeline.',
			'Roots lock on /terragucci apply or /terragucci lock, not at the first plan.',
			'The agent comment and drift fixes are GitHub and Forgejo only.',
		],
		href: '/guides/add-to-a-repo/#per-forge',
	},
	{ id: 'forgejo', label: 'Forgejo', differs: [], href: '/guides/add-to-a-repo/#per-forge' },
];

/** What you are leaving: its first page, and what carries over, shown in the picker's Works card. */
export const FROM: { id: string; label: string; first: Link; carries: string[] }[] = [
	{ id: 'none', label: 'Nothing yet, or a CI script', first: { label: 'Get your first plan note', href: '/getting-started/' }, carries: [] },
	{
		id: 'atlantis',
		label: 'Atlantis',
		first: { label: 'Coming from Atlantis or OpenTaco', href: '/guides/coming-from-atlantis-or-opentaco/' },
		carries: ['terragucci import atlantis writes terragucci.yml from atlantis.yaml', 'Apply before merge stays, and /terragucci plan and /terragucci apply take the place of atlantis plan and atlantis apply'],
	},
	{
		id: 'digger',
		label: 'OpenTaco or Digger',
		first: { label: 'Coming from Atlantis or OpenTaco', href: '/guides/coming-from-atlantis-or-opentaco/' },
		carries: ['terragucci import digger writes terragucci.yml from digger.yml', 'Apply before merge stays, and /terragucci plan and /terragucci apply take the place of digger plan and digger apply'],
	},
	{
		id: 'hcp',
		label: 'HCP Terraform or Terraform Enterprise',
		first: { label: 'Coming from HCP Terraform, Scalr or OTF', href: '/guides/coming-from-hcp-terraform-scalr-or-otf/' },
		carries: ['terragucci import hcp reads your workspaces over the API, and each becomes a root', 'An OPA policy set runs as it is; a Sentinel policy is rewritten in Rego', 'Workspace state moves to your bucket, one root at a time'],
	},
	{
		id: 'scalr',
		label: 'Scalr or OTF',
		first: { label: 'Coming from HCP Terraform, Scalr or OTF', href: '/guides/coming-from-hcp-terraform-scalr-or-otf/' },
		carries: ['terragucci import scalr or import otf reads your workspaces, and each becomes a root', 'A Scalr OPA policy group runs with its input paths changed', 'Workspace state moves to your bucket, one root at a time'],
	},
	{
		id: 'spacelift',
		label: 'Spacelift',
		first: { label: 'Coming from Spacelift or env zero', href: '/guides/coming-from-spacelift-or-env-zero/' },
		carries: ['terragucci import spacelift reads .spacelift/config.yml and the spacelift_* resources, and each stack becomes a root', 'Hooks become steps, and the drift schedule carries over', 'Managed state moves to your bucket, one root at a time'],
	},
	{
		id: 'env0',
		label: 'env zero',
		first: { label: 'Coming from Spacelift or env zero', href: '/guides/coming-from-spacelift-or-env-zero/' },
		carries: ['terragucci import env0 reads env0-discovery.yml and the env0_* resources, and each environment becomes a root', 'An environment with a TTL becomes an ephemeral environment per pull request', 'State in env zero\'s backend moves to your bucket, one root at a time'],
	},
	{
		id: 'tgscale',
		label: 'Terragrunt Scale (Gruntwork Pipelines)',
		first: { label: 'Use Terragrunt: Terragrunt Scale', href: '/guides/use-terragrunt/#terragrunt-scale' },
		carries: ['terragucci import terragrunt-scale writes each environment\'s roles from .gruntwork/*.hcl'],
	},
];

/** The doors for a role rather than a stack. */
export const ROLES: { label: string; room: string }[] = [
	{ label: 'I review security', room: 'security' },
	{ label: 'I am evaluating', room: 'evaluate' },
	{ label: 'I have many repos', room: 'many-repos' },
	{ label: 'I work with a coding agent', room: 'agents' },
];

export const ROOMS: Room[] = [
	{
		id: 'plain-roots',
		title: 'Terraform or OpenTofu roots',
		lede: 'Directories of .tf files with their own state.',
		column: 'OpenTofu',
		works: [
			'init finds every root and writes the pipeline for your forge',
			'Each root runs its own pinned Terraform or OpenTofu version',
			'Roots that read each other through terraform_remote_state apply in waves, in order',
		],
		differs: [],
		first: { label: 'Get your first plan note', href: '/getting-started/' },
		native: {
			tool: 'OpenTofu',
			has: [
				{ label: 'The core workflow of write, plan and apply, with team CI left to other tools', href: 'https://opentofu.org/docs/intro/core-workflow/' },
				{ label: 'TACOS, the tools that run that workflow for a team', href: 'https://opentofu.org/docs/intro/tacos/' },
				{ label: 'State and plan encryption, set in your roots', href: 'https://opentofu.org/docs/language/state/encryption/' },
			],
			choose: 'OpenTofu leaves CI to other tools on purpose, and that is the part terragucci does. Encryption of state and plans is OpenTofu\'s own feature; terragucci adds none.',
			adds: [
				'Every wave waits at a gate for an approval of its plan digest by someone who had no hand in the change',
				'A wave whose plans moved since the approval applies nothing',
			],
		},
		howto: [
			{ label: 'Add terragucci to a repo', href: '/guides/add-to-a-repo/' },
			{ label: 'Choose your binary', href: '/guides/use-a-binary/' },
			{ label: 'Approve a waiting wave', href: '/guides/approve-a-wave/' },
		],
		explain: [
			{ label: 'Architecture', href: '/concepts/how-it-works/' },
			{ label: 'Waves and approvals', href: '/concepts/waves-and-approvals/' },
		],
		reference: [
			{ label: 'terragucci.yml keys', href: '/reference/config/' },
			{ label: 'Stages', href: '/reference/stages/' },
		],
	},
	{
		id: 'terragrunt',
		title: 'Terragrunt',
		lede: 'A Terragrunt repo of units or explicit stacks, or one on Terragrunt Scale.',
		column: 'Terragrunt',
		works: [
			'Each unit is a root, and dependency order decides the waves',
			'A pull request plans the units of every layer it reaches, each on its upstream\'s planned outputs',
			'terragucci import terragrunt-scale reads Gruntwork Pipelines\' environments and roles',
		],
		differs: [
			'roots is refused; terragrunt.exclude leaves units out.',
			'A step after init is refused, since Terragrunt inits each unit inside the plan.',
			'CDK Terrain in a Terragrunt repo is not supported.',
		],
		first: { label: 'Use Terragrunt', href: '/guides/use-terragrunt/' },
		native: {
			tool: 'Terragrunt',
			has: [
				{ label: 'run --all in dependency order, with --filter-affected, --queue-ignore-errors and retries', href: 'https://docs.terragrunt.com/reference/cli/commands/run' },
				{ label: 'The run queue, where each unit waits for its dependencies', href: 'https://docs.terragrunt.com/features/stacks/run-queue/' },
				{ label: 'Gruntwork Pipelines: plans and applies the units a commit changes, in your own CI', href: 'https://docs.gruntwork.io/2.0/docs/pipelines/guides/running-plan-apply/' },
				{ label: 'Drift Detected pull requests from Pipelines, on a schedule', href: 'https://docs.gruntwork.io/2.0/docs/pipelines/guides/running-drift-detection/' },
			],
			choose: 'If ordering and drift pull requests are what you need, Terragrunt and Pipelines already do them.',
			adds: [
				'A pull request plans each unit on its upstream\'s planned outputs in place of mock_outputs, and a plan that would read mocks fails',
				'A wave waits for an approval when it would apply a value no review saw',
				'An approval counts only for the plan digest it saw, and only from someone with no hand in the change, where Pipelines relies on branch protection',
				'A wave whose plans moved since the approval applies nothing, where the Pipelines docs ask for branches kept up to date',
			],
		},
		howto: [
			{ label: 'Use Terragrunt', href: '/guides/use-terragrunt/' },
			{ label: 'From Terragrunt Scale', href: '/guides/use-terragrunt/#terragrunt-scale' },
			{ label: 'Steps around a stage', href: '/guides/run-steps/' },
		],
		explain: [{ label: 'Waves and approvals', href: '/concepts/waves-and-approvals/' }],
		reference: [{ label: 'terragucci.yml keys', href: '/reference/config/' }],
	},
	{
		id: 'atmos',
		title: 'Atmos',
		lede: 'An Atmos repo, where each component instance is a root in its own workspace.',
		column: 'Atmos',
		works: [
			'Each component instance is a root, and dependencies.components decides the waves',
			'A pull request plans the instances it changes and the ones that depend on them',
			'The check job runs atmos validate stacks first',
		],
		differs: [
			'Settings that would edit an instance\'s copied directory are refused, each by name.',
			'A change outside a component directory, such as to a stack manifest, locks every instance.',
		],
		first: { label: 'Use Atmos', href: '/guides/use-atmos/' },
		native: {
			tool: 'Atmos',
			has: [
				{ label: 'Ordered deployments in Atmos Pro, parents first on merge', href: 'https://atmos-pro.com/docs/learn/ordered-deployments' },
				{ label: 'Apply on merge, which plans again and by default fails on drift from the stored plan', href: 'https://atmos.tools/integrations/github-actions/apply-on-merge' },
				{ label: 'Affected stacks as a CI matrix', href: 'https://atmos.tools/integrations/github-actions/deploy-affected' },
				{ label: 'Planfile storage with checksums', href: 'https://atmos.tools/ci/planfile-storage' },
				{ label: 'Scheduled drift checks in Atmos Pro', href: 'https://atmos-pro.com/docs/learn/drift-detection' },
			],
			choose: 'If Atmos Pro\'s ordered deployments and apply on merge already fit your team, you may not need terragucci\'s waves or its stale-plan refusal.',
			adds: [
				'An approval counts only for the plan digest it saw, and only from someone with no hand in the change',
				'Every job runs in your own CI, and no hosted service takes part',
				'Pipelines for GitLab and Forgejo as well as GitHub',
			],
		},
		howto: [{ label: 'Use Atmos', href: '/guides/use-atmos/' }],
		explain: [{ label: 'Waves and approvals', href: '/concepts/waves-and-approvals/' }],
		reference: [{ label: 'terragucci.yml keys', href: '/reference/config/' }],
	},
	{
		id: 'terramate',
		title: 'Terramate',
		lede: 'A Terramate repo, where each stack is one root.',
		column: 'Terramate',
		works: [
			'Stacks apply in waves ordered by their after and before',
			'Only the stacks a change reaches, and those ordered after them, are planned',
			'Stale generated code fails the check',
		],
		differs: [
			'Terramate Cloud and Terramate scripts are not read, and neither are watch files or wants and wanted_by.',
			'A drift pull request, rollouts and generate are refused, since their edits would land in code terramate generate owns.',
		],
		first: { label: 'Use Terramate', href: '/guides/use-terramate/' },
		native: {
			tool: 'Terramate',
			has: [
				{ label: 'terramate run in order: parents first, then after and before', href: 'https://terramate.io/docs/cli/orchestration/order-of-execution' },
				{ label: 'Change detection from git with --changed', href: 'https://terramate.io/docs/cli/change-detection' },
				{ label: 'Preview, deployment and drift check workflows for GitHub, GitLab and Bitbucket', href: 'https://terramate.io/docs/cli/automation/' },
				{ label: 'Terramate Cloud: deployment history and alerts', href: 'https://terramate.io/docs/cloud/deployments/' },
				{ label: 'Terramate Cloud: scheduled drift checks, alerts and reconciliation', href: 'https://terramate.io/docs/cloud/drift/' },
			],
			choose: 'If ordered runs of the changed stacks and Terramate\'s own workflows already fit your team, you may not need terragucci\'s waves.',
			adds: [
				'Each layer waits at its own gate for an approval of its plan digest by someone who had no hand in the change',
				'A wave whose plans moved since the approval applies nothing',
				'A stack that reads an input is never planned on its mock; it waits for the upstream\'s state',
				'Pipelines for Forgejo as well as GitHub and GitLab',
			],
		},
		howto: [{ label: 'Use Terramate', href: '/guides/use-terramate/' }],
		explain: [{ label: 'Waves and approvals', href: '/concepts/waves-and-approvals/' }],
		reference: [{ label: 'terragucci.yml keys', href: '/reference/config/' }],
	},
	{
		id: 'cdk-terrain',
		title: 'CDK Terrain',
		lede: 'A CDK Terrain app, synthesized in the pipeline before each plan.',
		column: 'CDK Terrain',
		works: [
			'synth runs in the pipeline, then each pull request plans the stacks its change affects',
			'Each apply wave synthesizes the stacks and applies behind its gate',
			'A stack that reads another\'s state plans on that stack\'s planned outputs',
		],
		differs: [
			'The stacks are the app\'s output, so terragucci never edits them: drift goes to the issue, and rollouts and generate are config errors.',
			'A Terragrunt repo takes no synth, so the two do not mix.',
		],
		first: { label: 'Plan CDK Terrain stacks', href: '/guides/plan-cdk-terrain-stacks/' },
		native: {
			tool: 'CDK Terrain',
			has: [
				{ label: 'cdktn deploy orders the stacks itself and takes several stack ids or globs', href: 'https://cdktn.io/docs/cli-reference/commands' },
				{ label: 'The CDK Terrain action: one stack per step, with auto-approve modes', href: 'https://github.com/cdktn-io/action' },
			],
			choose: 'If one deploy of every stack in order is all you need, cdktn deploy already does it.',
			adds: [
				'A pull request plans only the stacks whose synth output differs between base and head',
				'Each wave waits at its own gate for an approval of its plan digest by someone who had no hand in the change',
			],
		},
		howto: [{ label: 'Plan CDK Terrain stacks', href: '/guides/plan-cdk-terrain-stacks/' }],
		explain: [{ label: 'Waves and approvals', href: '/concepts/waves-and-approvals/' }],
		reference: [{ label: 'terragucci.yml keys', href: '/reference/config/' }],
	},
	{
		id: 'choudoufu',
		title: 'choudoufu',
		lede: 'The OpenTofu fork for AWS and Kubernetes from the team behind terragucci, set with binary: choudoufu.',
		column: 'choudoufu',
		works: [
			'One record per resource in an S3 bucket you own, each write conditional, with no lock table',
			'Applies to different resources of one estate run at the same time; a killed apply leaves nothing to release',
			'A live check on every push, and the slowest provider calls in the report',
		],
		differs: [
			'terragucci does not read a root\'s required_version as a choudoufu release.',
			'Record history needs the ListBucketVersions permission on the record store bucket; a local or kubernetes record store keeps none.',
		],
		first: { label: 'Choose your binary: choudoufu', href: '/guides/use-a-binary/#choudoufu' },
		howto: [
			{ label: 'Choose your binary', href: '/guides/use-a-binary/' },
			{ label: 'Watch a choudoufu wave', href: '/guides/watch-a-choudoufu-wave/' },
		],
		explain: [{ label: 'Locking with choudoufu', href: '/concepts/locking-and-staleness/#with-choudoufu' }],
		reference: [{ label: 'Traces and metrics', href: '/reference/observability/' }],
	},
	{
		id: 'security',
		title: 'Security review',
		lede: 'What each job can reach and who can approve, with the record every change leaves.',
		works: [
			'Plan and apply use separate roles, and the plan job never gets the apply role',
			'A gated wave whose plans moved after the approval applies nothing and names both digests',
			'The audit trail in your bucket records every approval, apply and override',
		],
		differs: [
			'terragucci has no accounts; access and identity maps each action to the forge or IAM setting that decides it.',
		],
		first: { label: 'The threat model', href: '/reference/threat-model/' },
		howto: [
			{ label: 'Write a policy', href: '/guides/write-a-policy/' },
			{ label: 'Read the audit trail', href: '/guides/read-the-audit-trail/' },
			{ label: 'Lock roots', href: '/guides/lock-roots/' },
			{ label: 'Handle secrets', href: '/guides/keep-secrets-out-of-notes/' },
			{ label: 'Scope state access', href: '/guides/scope-state-access/' },
			{ label: 'Approvals runbook', href: '/guides/approvals-runbook/' },
		],
		explain: [
			{ label: 'Approvals as records', href: '/concepts/approvals-as-records/' },
			{ label: 'Access and identity', href: '/standards/access-and-identity/' },
		],
		reference: [
			{ label: 'Threat model', href: '/reference/threat-model/' },
			{ label: 'Policy', href: '/reference/policy/' },
			{ label: 'The audit trail', href: '/reference/audit-trail/' },
			{ label: 'Validation', href: '/reference/validation/' },
		],
	},
	{
		id: 'evaluate',
		title: 'Evaluating terragucci',
		lede: 'What terragucci does and proves, and what it leaves to your forge and your cloud.',
		works: [
			'Apache-2.0, with nothing to buy and no server to host',
			'Every pipeline feature that runs on Forgejo is proven by a recorded check, listed by tool and forge',
			'Scored against the 24 tacos.guru criteria',
		],
		differs: [],
		first: { label: 'See a plan note in about 10 minutes', href: '/tutorial/' },
		howto: [{ label: 'Add terragucci to a repo', href: '/guides/add-to-a-repo/' }],
		explain: [
			{ label: 'Architecture', href: '/concepts/how-it-works/' },
			{ label: 'tacos.guru', href: '/standards/tacos-guru/' },
		],
		reference: [
			{ label: 'Validation', href: '/reference/validation/' },
			{ label: 'Scale', href: '/reference/scale/' },
		],
	},
	{
		id: 'many-repos',
		title: 'Many repos',
		lede: 'One place that keeps every repo\'s settings and policy alike.',
		works: [
			'A control repo holds the shared settings and opens a pull request in each repo that changes',
			'A single project works without a control repo, from its own terragucci.yml',
			'One estate page lists every project with its roots and last applies',
			'A new module version rolls out to every repo that pins it, a wave of pull requests at a time',
		],
		differs: [],
		first: { label: 'Govern many repos', href: '/guides/govern-many-repos/' },
		howto: [
			{ label: 'Govern many repos', href: '/guides/govern-many-repos/' },
			{ label: 'Trust in Terraform', href: '/guides/manage-the-control-repo-with-terraform/' },
			{ label: 'Every project, one page', href: '/guides/see-every-project/' },
			{ label: 'Roll out a module', href: '/guides/roll-out-a-module-version/' },
		],
		explain: [{ label: 'Control repo', href: '/concepts/control-repo/' }],
		reference: [{ label: 'terragucci.yml keys', href: '/reference/config/' }],
	},
	{
		id: 'agents',
		title: 'Coding agents',
		lede: 'Setup by an agent, and four opt-in features that run a model.',
		works: [
			'An agent can run the setup and stops at a pull request; it never applies or approves',
			'An MCP server over the estate, the audit trail and the delivery metrics, running no model; with --propose it opens pull requests and reads their plans',
			'A local guard that refuses an apply in a pipeline root from the agent\'s shell',
			'Four opt-in features run a model, each off until you set it up with a model API key',
		],
		differs: ['On GitLab the agent comment and drift fixes are refused, and the review runs through the comments schedule.'],
		first: { label: 'Set up with a coding agent', href: '/getting-started/agents/' },
		howto: [
			{ label: 'Agent changes to a pull request', href: '/guides/agent-change-a-pull-request/' },
			{ label: 'Agent drift fixes', href: '/guides/agent-fix-drift/' },
			{ label: 'Model review of a pull request', href: '/guides/agent-review-a-pull-request/' },
			{ label: 'Refused wave summaries', href: '/guides/agent-refused-wave/' },
			{ label: 'The estate over MCP', href: '/guides/agent-read-over-mcp/' },
			{ label: 'Changes proposed over MCP', href: '/guides/agent-propose-over-mcp/' },
		],
		explain: [{ label: 'Architecture', href: '/concepts/how-it-works/' }],
		reference: [{ label: 'CLI commands', href: '/reference/cli/' }],
	},
];

export const room = (id: string): Room => {
	const r = ROOMS.find((x) => x.id === id);
	if (!r) throw new Error(`no room ${id}`);
	return r;
};
