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
		text: 'report.json beside the HTML report, with every root, group, policy result and wave, and each root\'s full plan as JSON',
		page: 'reference/report-schema/',
	},
	policy: {
		mark: 'good',
		text: 'conftest or OPA over each root\'s plan, Rego in your repo; a pull request is checked against the policy on its base branch',
		page: 'reference/policy/',
	},
	override: {
		mark: 'bad',
		text: 'A denial has no override; the code or the policy changes in a reviewed pull request',
		page: 'reference/policy/',
	},
	'apply-when': {
		mark: 'warn',
		text: 'Applies after merge, from the push to the default branch or a /terragucci apply comment on the merged pull request',
		page: 'reference/pipeline/',
	},
	'approval-binds': {
		mark: 'good',
		text: 'A wave\'s set digest, a hash over the plan digest of every root in it, sealed with the approver\'s ssh key',
		page: 'concepts/waves-and-approvals/',
	},
	waves: {
		mark: 'good',
		text: 'Canary roots first, then one dependency layer per wave, each wave planned once the wave before it has applied, and gated by policy',
		page: 'concepts/waves-and-approvals/',
	},
	'refuse-changed': {
		mark: 'good',
		text: 'If any plan in the wave changed after the approval, the digest changes and the wave applies nothing',
		page: 'concepts/waves-and-approvals/',
	},
	locks: {
		mark: 'warn',
		text: 'A project applies one push at a time, queued on each forge; pull requests take no locks on roots',
		page: 'reference/pipeline/',
	},
	terragrunt: {
		mark: 'warn',
		text: 'Waves follow the dependency graph, one terragrunt run --all per wave, and no unit plans against mock outputs; a Terragrunt wave applies without an approval gate',
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
		text: 'In the backend your roots already name; terragucci never holds it',
		page: 'reference/pipeline/',
	},
	credentials: {
		mark: 'good',
		text: 'In your cloud: jobs trade the forge\'s OIDC token for a plan role and an apply role',
		page: 'reference/environment/',
	},
	telemetry: {
		mark: 'good',
		text: 'One trace per stage run and the pipeline\'s metrics over OTLP to your collector, with Grafana dashboards',
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
