// terragucci's own column of the comparison grid. Each mark says what the
// default branch does today, on every forge it supports, and links the page
// that describes it. A mark moves only when the code and its page have moved.
import type { OwnCell, RowId } from './types';

export const terragucci: Record<RowId, OwnCell> = {
	'grouped-note': {
		mark: 'good',
		text: 'One note per pull request; roots taking the same change are one line with a count, and every destroy and replacement is named',
		page: 'concepts/why-plans-are-grouped/',
	},
	'affected-only': {
		mark: 'good',
		text: 'Plans the roots a change reaches, including every root that includes a changed local module; in Terragrunt, its own change detection plus files and modules the units read',
		page: 'reference/stages/',
	},
	'json-report': {
		mark: 'good',
		text: 'report.json beside the HTML report, with every root, group, policy result and wave, linking each root\'s full plan as JSON',
		page: 'reference/report-schema/',
	},
	policy: {
		mark: 'good',
		text: 'conftest or OPA over each root\'s plan, Rego in your repo; a pull request is checked against the policy on its base branch',
		page: 'reference/policy/',
	},
	override: {
		mark: 'bad',
		text: 'No bypass, by design: a denied change goes through only after a reviewed policy change merges, or the code changes',
		page: 'reference/policy/',
	},
	'apply-when': {
		mark: 'good',
		text: 'Both, per project: apply.when merge (default) or pull-request; before merge on plain roots on GitHub and Forgejo, after merge on GitLab and in Terragrunt repos',
		page: 'reference/config/#apply-before-merge',
	},
	'approval-binds': {
		mark: 'good',
		text: 'A wave\'s set digest, a hash over the plan digest of every root in it, sealed with the approver\'s ssh key',
		page: 'concepts/waves-and-approvals/',
	},
	waves: {
		mark: 'good',
		text: 'Canary roots first, then one dependency layer per wave, each one plans once the one before has applied; a wave waits for its own sealed approval when it destroys or replaces something, or always with gate: always',
		page: 'concepts/waves-and-approvals/',
	},
	'refuse-changed': {
		mark: 'good',
		text: 'A gated wave whose plan changed after approval applies nothing; under on-destroy a re-plan with no destroy applies, and under gate: never nothing is refused',
		page: 'concepts/waves-and-approvals/',
	},
	locks: {
		mark: 'good',
		text: 'A project applies one push at a time; a pull request applied before merge holds its roots until it merges or closes, and /terragucci unlock releases them (plain roots, GitHub and Forgejo)',
		page: 'reference/pipeline/#apply-before-merge',
	},
	terragrunt: {
		mark: 'warn',
		text: 'Two waves, canary units then the rest, each one terragrunt run --all, gated and sealed like plain roots; a changed wave applies nothing',
		page: 'guides/use-terragrunt/',
	},
	drift: {
		mark: 'good',
		text: 'A scheduled tf-drift run plans every root and keeps one issue with the drift, grouped like a plan note',
		page: 'guides/turn-on-drift-checks/',
	},
	hosting: {
		mark: 'good',
		text: 'Nothing new; the generated jobs run on the GitHub, GitLab or Forgejo runners you have',
		page: 'reference/pipeline/',
	},
	state: {
		mark: 'good',
		text: 'In the backend your roots already name; terragucci never holds it. With choudoufu there is no state file: each resource carries its own tag',
		page: 'reference/pipeline/',
	},
	credentials: {
		mark: 'good',
		text: 'In your cloud: jobs trade the forge\'s OIDC token for a plan role and an apply role',
		page: 'reference/environment/',
	},
	telemetry: {
		mark: 'good',
		text: 'One trace per stage run and the pipeline\'s metrics over OTLP to your collector, with Grafana dashboards; with choudoufu, the slow provider calls per resource, summed timings that keep reports readable on large estates, and each wave\'s state lock waits and their attempts',
		page: 'reference/observability/',
	},
	modules: {
		mark: 'good',
		text: 'Publishes changed modules with versions from commit messages, and moves a pin one wave at a time as one pull request per wave',
		page: 'guides/roll-out-a-module-version/',
	},
	licence: {
		mark: 'good',
		text: 'Apache 2.0, free to run',
		page: 'https://github.com/INTENTIUS/terragucci/blob/main/LICENSE',
	},
};
