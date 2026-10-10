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
	howto: Link[];
	explain: Link[];
	reference: Link[];
};

/** What every room can count on, whatever it runs. Each line links where it is shown. */
export const ASSUMED: Link[] = [
	{ label: 'A plan note and a status on every pull request', href: '/getting-started/' },
	{ label: 'Apply after merge, gated by an approval of the exact plans shown', href: '/guides/approve-a-wave/' },
	{ label: 'No two applies of one root overlap, and a plan that went stale is refused', href: '/concepts/locking-and-staleness/' },
	{ label: 'Re-plan from a comment', href: '/guides/re-plan-from-a-comment/' },
	{ label: 'Scheduled drift checks', href: '/guides/turn-on-drift-checks/' },
	{ label: 'Short-lived cloud credentials through OIDC, one role for plan and one for apply', href: '/guides/add-to-a-repo/' },
	{ label: 'Policy checks on every plan', href: '/guides/write-a-policy/' },
	{ label: 'An audit trail of every approval, apply and override, in your bucket', href: '/guides/read-the-audit-trail/' },
	{ label: 'Secrets kept out of plan notes and logs', href: '/reference/threat-model/' },
	{ label: 'Your state backend, as it is', href: '/reference/state-backends/' },
	{ label: 'Your own runners', href: '/guides/add-to-a-repo/' },
	{ label: 'Sign-in and permissions from your forge', href: '/standards/access-and-identity/' },
];

/** What the site does not do, each with its reason. Shown on the home page and in the picker. */
export const LIMITS: { label: string; why: string; href?: string }[] = [
	{ label: 'Bitbucket and Azure DevOps', why: 'not supported: init writes pipelines for GitHub, GitLab and Forgejo only', href: '/standards/tacos-guru/' },
	{ label: 'Accounts, sign-in and roles of its own', why: 'none: your forge decides who signs in, merges and approves, and your cloud IAM decides what each job reaches', href: '/standards/access-and-identity/' },
	{ label: 'A hosted web UI', why: 'none: runs show on your forge\'s run pages, in the report and on the estate page in your bucket', href: '/guides/see-every-project/' },
	{ label: 'A server or database to run', why: 'none: every job runs in your CI and writes to your git and your bucket', href: '/concepts/how-it-works/#components' },
];

export const SHAPES: { id: string; label: string; room: string }[] = [
	{ id: 'plain', label: 'Terraform or OpenTofu roots', room: 'plain-roots' },
	{ id: 'terragrunt', label: 'Terragrunt', room: 'terragrunt' },
	{ id: 'atmos', label: 'Atmos', room: 'atmos' },
	{ id: 'terramate', label: 'Terramate', room: 'terramate' },
	{ id: 'cdktn', label: 'CDK Terrain', room: 'cdk-terrain' },
];

export const BINARIES: { id: string; label: string; differs: string[]; href: string }[] = [
	{ id: 'tofu', label: 'OpenTofu', differs: [], href: '/guides/use-a-binary/' },
	{
		id: 'terraform',
		label: 'Terraform',
		differs: ['Two overlapping pushes to one root can fail the newer apply with "Saved plan is stale"; run it again and it plans again.'],
		href: '/guides/use-a-binary/',
	},
	{
		id: 'choudoufu',
		label: 'choudoufu',
		differs: ['Applies to different resources of one estate run at the same time, and a killed apply leaves no lock to release.'],
		href: '/rooms/choudoufu/',
	},
];

export const FORGES: { id: string; label: string; differs: string[]; href: string }[] = [
	{ id: 'github', label: 'GitHub', differs: [], href: '/guides/add-to-a-repo/#per-forge' },
	{
		id: 'gitlab',
		label: 'GitLab',
		differs: [
			'Comment commands run from the comments schedule, since a merge request note starts no pipeline.',
			'No locks from the first plan: no merge request event runs a job from the default branch that could hold them. A merge request locks its roots on /terragucci apply or /terragucci lock.',
			'The coding agent comment and drift fixes run on GitHub and Forgejo only.',
		],
		href: '/guides/add-to-a-repo/#per-forge',
	},
	{ id: 'forgejo', label: 'Forgejo', differs: [], href: '/guides/add-to-a-repo/#per-forge' },
];

export const FROM: { id: string; label: string; first: Link }[] = [
	{ id: 'none', label: 'Nothing yet, or a CI script', first: { label: 'Get your first plan note', href: '/getting-started/' } },
	{ id: 'atlantis', label: 'Atlantis', first: { label: 'Coming from Atlantis, OpenTaco or Terrateam', href: '/guides/coming-from-atlantis-or-opentaco/' } },
	{ id: 'digger', label: 'OpenTaco or Digger', first: { label: 'Coming from Atlantis, OpenTaco or Terrateam', href: '/guides/coming-from-atlantis-or-opentaco/' } },
	{ id: 'terrateam', label: 'Terrateam', first: { label: 'Coming from Atlantis, OpenTaco or Terrateam', href: '/guides/coming-from-atlantis-or-opentaco/' } },
	{ id: 'hcp', label: 'HCP Terraform or Terraform Enterprise', first: { label: 'Coming from HCP Terraform, Scalr or OTF', href: '/guides/coming-from-hcp-terraform-scalr-or-otf/' } },
	{ id: 'scalr', label: 'Scalr or OTF', first: { label: 'Coming from HCP Terraform, Scalr or OTF', href: '/guides/coming-from-hcp-terraform-scalr-or-otf/' } },
	{ id: 'spacelift', label: 'Spacelift', first: { label: 'Coming from Spacelift or env zero', href: '/guides/coming-from-spacelift-or-env-zero/' } },
	{ id: 'env0', label: 'env zero', first: { label: 'Coming from Spacelift or env zero', href: '/guides/coming-from-spacelift-or-env-zero/' } },
	{ id: 'tgscale', label: 'Terragrunt Scale (Gruntwork Pipelines)', first: { label: 'Use Terragrunt: Terragrunt Scale', href: '/guides/use-terragrunt/#terragrunt-scale' } },
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
		lede: 'Directories of .tf files, each with its own state, on Terraform or OpenTofu.',
		column: 'OpenTofu',
		works: [
			'init finds every root and writes the pipeline for your forge',
			'Each root runs its own pinned Terraform or OpenTofu version',
			'Roots that read each other through terraform_remote_state apply in waves, in order',
		],
		differs: [],
		first: { label: 'Get your first plan note', href: '/getting-started/' },
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
		lede: 'A Terragrunt repo, with units, explicit stacks or Terragrunt Scale.',
		column: 'Terragrunt',
		works: [
			'Each unit is a root, and dependency order decides the waves',
			'A pull request plans the units of every layer it reaches, each on its upstream\'s planned outputs',
			'terragucci import terragrunt-scale reads Gruntwork Pipelines\' environments and roles',
		],
		differs: [
			'roots is refused: leave units out with terragrunt.exclude.',
			'A step after init is refused, since Terragrunt inits each unit inside the plan.',
			'CDK Terrain in a Terragrunt repo is not supported.',
		],
		first: { label: 'Use Terragrunt', href: '/guides/use-terragrunt/' },
		howto: [
			{ label: 'Use Terragrunt', href: '/guides/use-terragrunt/' },
			{ label: 'Coming from Terragrunt Scale', href: '/guides/use-terragrunt/#terragrunt-scale' },
			{ label: 'Run steps around a stage', href: '/guides/run-steps/' },
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
			'A change to a stack manifest, a catalog or atmos.yaml locks every instance.',
		],
		first: { label: 'Use Atmos', href: '/guides/use-atmos/' },
		howto: [{ label: 'Use Atmos', href: '/guides/use-atmos/' }],
		explain: [{ label: 'Waves and approvals', href: '/concepts/waves-and-approvals/' }],
		reference: [{ label: 'terragucci.yml keys', href: '/reference/config/' }],
	},
	{
		id: 'terramate',
		title: 'Terramate',
		lede: 'A Terramate repo, where each stack is a root and its after and before decide the waves.',
		column: 'Terramate',
		works: [
			'Each stack is a root, in the order its after and before give',
			'A pull request plans the stacks it changes and the ones ordered after them',
			'Stale generated code fails the check',
		],
		differs: [
			'Terramate\'s watch files, scripts, wants and wanted_by, and Terramate Cloud are not read.',
			'A drift pull request, rollouts and generate are refused, since their edits would land in code terramate generate owns.',
		],
		first: { label: 'Use Terramate', href: '/guides/use-terramate/' },
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
			'The stacks are the app\'s output, so a drift pull request, rollouts and generate are config errors; drift is reported in the issue instead.',
			'Not supported in a Terragrunt repo.',
		],
		first: { label: 'Plan CDK Terrain stacks', href: '/guides/plan-cdk-terrain-stacks/' },
		howto: [{ label: 'Plan CDK Terrain stacks', href: '/guides/plan-cdk-terrain-stacks/' }],
		explain: [{ label: 'Waves and approvals', href: '/concepts/waves-and-approvals/' }],
		reference: [{ label: 'terragucci.yml keys', href: '/reference/config/' }],
	},
	{
		id: 'choudoufu',
		title: 'choudoufu',
		lede: 'The OpenTofu fork from the team behind terragucci, set with binary: choudoufu.',
		column: 'choudoufu',
		works: [
			'One record per resource in an S3 bucket you own, each write conditional, with no lock table',
			'Applies to different resources of one estate run at the same time; a killed apply leaves nothing to release',
			'A live check on every push, slow provider calls in the report, and each record\'s past versions',
		],
		differs: [
			'terragucci does not read a root\'s required_version as a choudoufu release.',
			'Record history needs s3:ListBucketVersions on the record store bucket; a local or kubernetes record store keeps none.',
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
		lede: 'What each job can reach, who can approve, and the record every change leaves.',
		works: [
			'Plan and apply use separate roles, and the plan job never gets the apply role',
			'A gated wave whose plans moved after the approval applies nothing and names both digests',
			'Every approval, apply, override and refused wave is recorded in your bucket',
		],
		differs: [
			'terragucci has no accounts: sign-in and permissions are your forge\'s, and what a job reaches is your cloud IAM.',
		],
		first: { label: 'The threat model', href: '/reference/threat-model/' },
		howto: [
			{ label: 'Write a policy', href: '/guides/write-a-policy/' },
			{ label: 'Read the audit trail', href: '/guides/read-the-audit-trail/' },
			{ label: 'Keep each environment\'s roles to its own state', href: '/guides/scope-state-access/' },
			{ label: 'Approvals runbook', href: '/guides/approvals-runbook/' },
		],
		explain: [
			{ label: 'Approvals as records in your repo', href: '/concepts/approvals-as-records/' },
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
		lede: 'What it does, what it proves, and what it leaves to your forge and your cloud.',
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
		lede: 'One place for the settings, policy and module versions of every repo.',
		works: [
			'A control repo holds the shared settings and opens a pull request in each repo that changes',
			'One estate page lists every project, its roots and its last applies',
			'A new module version rolls out to every repo that pins it, a wave of pull requests at a time',
		],
		differs: [],
		first: { label: 'Govern many repos from one place', href: '/guides/govern-many-repos/' },
		howto: [
			{ label: 'Govern many repos from one place', href: '/guides/govern-many-repos/' },
			{ label: 'Manage the control repo with Terraform', href: '/guides/manage-the-control-repo-with-terraform/' },
			{ label: 'See every project in one page', href: '/guides/see-every-project/' },
			{ label: 'Roll out a new module version', href: '/guides/roll-out-a-module-version/' },
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
			'A read-only MCP server over the estate, the audit trail and the delivery metrics, running no model',
			'Four opt-in features run a model, each off until you set it up with a model API key',
		],
		differs: ['The agent comment and drift fixes run on GitHub and Forgejo only; on GitLab the review runs through the comments schedule.'],
		first: { label: 'Set up with a coding agent', href: '/getting-started/agents/' },
		howto: [
			{ label: 'Have an agent change a pull request', href: '/guides/agent-change-a-pull-request/' },
			{ label: 'Have an agent fix drift', href: '/guides/agent-fix-drift/' },
			{ label: 'Have a model review a pull request', href: '/guides/agent-review-a-pull-request/' },
			{ label: 'Have an agent summarize a refused wave', href: '/guides/agent-refused-wave/' },
			{ label: 'Read the estate over MCP', href: '/guides/agent-read-over-mcp/' },
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
