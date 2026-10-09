// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import rego from './src/rego-grammar.mjs';

// expressive-code renders each code line as its own block element with no
// newline between them, so text extracted from the page (an agent, a reader
// mode, a copy of the selection) runs lines together. A newline text node as the
// last child of each line fixes that. The line is a grid, which does not render a
// whitespace-only text child, so nothing changes on screen. Between the lines,
// inside the <pre>, the same node would render as a blank line.
const newlinesBetweenLines = {
	name: 'newlines-between-lines',
	hooks: {
		postprocessRenderedBlock: ({ renderData }) => {
			const visit = (node) => {
				if (!node.children) return;
				const lines = node.children.filter((c) => c.type === 'element' && (c.properties?.className ?? []).includes('ec-line'));
				for (const line of lines.slice(0, -1)) {
					// A blank line already carries its own newline.
					const code = line.children.find((c) => c.type === 'element');
					if (code && !code.children.some((c) => c.type === 'element')) continue;
					line.children.push({ type: 'text', value: '\n' });
				}
				node.children.forEach(visit);
			};
			visit(renderData.blockAst);
		},
	},
};

// Published under the org domain at /terragucci, the same shape fountain-ops
// and loomster use. `base` has to match or every internal link 404s on Pages.
export default defineConfig({
	site: 'https://intentius.io',
	base: '/terragucci',
	// Pages that moved keep their old address.
	redirects: {
		'/getting-started/overview': '/terragucci/getting-started/',
		'/getting-started/binaries': '/terragucci/guides/use-a-binary/',
		'/getting-started/config': '/terragucci/reference/config/',
		'/status': '/terragucci/reference/validation/',
		'/guides/move-apply-to-fountain': '/terragucci/reference/runtimes/',
		'/guides/agent-explain-a-plan': '/terragucci/reference/responses/',
		'/guides/agent-drift-fixes': '/terragucci/guides/turn-on-drift-checks/',
		'/guides/add-to-github': '/terragucci/guides/add-to-a-repo/',
		'/guides/keep-reports-in-s3': '/terragucci/guides/keep-reports-in-a-bucket/',
		'/guides/add-to-gitlab': '/terragucci/guides/add-to-a-repo/',
		'/guides/add-to-forgejo': '/terragucci/guides/add-to-a-repo/',
	},
	integrations: [
		starlight({
			title: 'terragucci',
			// The taco: the logo beside the title, the favicons, and the square 160 px taco a shared link shows (LinkedIn, Slack, X).
			logo: { src: './src/assets/brand/taco.svg', alt: '' },
			favicon: '/favicon.svg',
			head: [
				{ tag: 'link', attrs: { rel: 'icon', href: '/terragucci/favicon.ico', sizes: '32x32' } },
				{ tag: 'link', attrs: { rel: 'apple-touch-icon', href: '/terragucci/apple-touch-icon.png' } },
				{ tag: 'meta', attrs: { property: 'og:image', content: 'https://intentius.io/terragucci/taco-share.png' } },
				{ tag: 'meta', attrs: { property: 'og:image:width', content: '400' } },
				{ tag: 'meta', attrs: { property: 'og:image:height', content: '400' } },
				{ tag: 'meta', attrs: { property: 'og:image:alt', content: 'The terragucci taco: a pixel-art taco with a diamond in it' } },
				{ tag: 'meta', attrs: { name: 'twitter:card', content: 'summary' } },
				{ tag: 'meta', attrs: { name: 'twitter:image', content: 'https://intentius.io/terragucci/taco-share.png' } },
			],
			expressiveCode: { plugins: [newlinesBetweenLines], shiki: { langs: [rego] } },
			customCss: ['./src/styles/terragucci.css'],
			// The title gets a "Copy page as Markdown" button, an llms.txt pointer and
			// the page's agent prompt. The footer adds the tutorial step and a small taco.
			components: { PageTitle: './src/components/PageTitle.astro', Footer: './src/components/Footer.astro' },
			description: 'One workflow, one audit trail and one place to enforce policy for every Terraform, OpenTofu and Terragrunt repo, run in your own CI. Plan, approve and apply hundreds of roots from pull requests, with a trace of every run.',
			social: [
				{ icon: 'github', label: 'GitHub', href: 'https://github.com/INTENTIUS/terragucci' },
			],
			editLink: {
				baseUrl: 'https://github.com/INTENTIUS/terragucci/edit/main/docs-site/',
			},
			// The sections follow what the reader is doing. The validation page is the
			// one people link to, so it has a fixed place.
			sidebar: [
				{ label: 'The launch party', slug: 'launch-party' },
				{
					label: 'Getting started',
					items: [
						{ label: 'How terragucci works', slug: 'concepts/how-it-works' },
						{ label: 'Get your first plan note', slug: 'getting-started' },
					],
				},
				{
					label: 'Tutorial',
					items: [{ autogenerate: { directory: 'tutorial' } }],
				},
				{
					label: 'How-to guides',
					items: [
						{ label: 'Add terragucci to a repo', slug: 'guides/add-to-a-repo' },
						{
							label: 'Ship changes',
							items: [
								{ label: 'Approve a waiting wave', slug: 'guides/approve-a-wave' },
								{ label: 'Fix a refused wave', slug: 'guides/fix-a-refused-wave' },
								{ label: 'Approvals runbook', slug: 'guides/approvals-runbook' },
								{ label: 'Roll out a new module version', slug: 'guides/roll-out-a-module-version' },
								{ label: 'Publish your modules', slug: 'guides/publish-modules' },
								{ label: 'Re-plan from a comment', slug: 'guides/re-plan-from-a-comment' },
								{ label: 'Apply a pull request before it merges', slug: 'guides/apply-before-merge' },
								{ label: 'Move resources between roots', slug: 'guides/move-resources-between-roots' },
								{ label: 'Release a state lock a killed job left', slug: 'guides/release-a-state-lock' },
							],
						},
						{
							label: 'Watch and keep',
							items: [
								{ label: 'Turn on drift checks', slug: 'guides/turn-on-drift-checks' },
								{ label: 'Keep reports in a bucket', slug: 'guides/keep-reports-in-a-bucket' },
								{ label: 'See every project in one page', slug: 'guides/see-every-project' },
								{ label: 'Find the state version an apply left', slug: 'guides/find-a-state-version' },
								{ label: 'Export a state version', slug: 'guides/export-a-state-version' },
								{ label: 'Track the roots that read other roots\' state', slug: 'guides/track-cross-state-edges' },
								{ label: 'Send traces and metrics', slug: 'guides/send-traces-and-metrics' },
							],
						},
						{
							label: 'Set it up your way',
							items: [
								{ label: 'Govern many repos from one place', slug: 'guides/govern-many-repos' },
								{ label: 'Keep each environment\'s roles to its own state', slug: 'guides/scope-state-access' },
								{ label: 'Choose your binary', slug: 'guides/use-a-binary' },
								{ label: 'Use Terragrunt', slug: 'guides/use-terragrunt' },
								{ label: 'Plan CDK Terrain stacks', slug: 'guides/plan-cdk-terrain-stacks' },
								{ label: 'Tell a chat channel when a wave stops', slug: 'guides/notify-a-chat-channel' },
								{ label: 'Approve from Slack and Teams', slug: 'guides/approve-from-chat' },
								{ label: 'Estimate the cost of a change', slug: 'guides/estimate-cost' },
								{ label: 'Run steps around a stage', slug: 'guides/run-steps' },
								{ label: 'Generate backend and provider files', slug: 'guides/generate-root-files' },
							],
						},
						{
							label: 'With a coding agent',
							items: [
								{ label: 'Set up with a coding agent', slug: 'getting-started/agents' },
								{ label: 'Have an agent summarize a refused wave', slug: 'guides/agent-refused-wave' },
								{ label: 'Read the estate over MCP', slug: 'guides/agent-read-over-mcp' },
								{ label: 'Have an agent change a pull request', slug: 'guides/agent-change-a-pull-request' },
								{ label: 'Have an agent fix drift', slug: 'guides/agent-fix-drift' },
								{ label: 'Have a model review a pull request', slug: 'guides/agent-review-a-pull-request' },
							],
						},
					],
				},
				{
					label: 'Reference',
					items: [
						{ label: 'terragucci.yml keys', slug: 'reference/config' },
						{ label: 'CLI commands', slug: 'reference/cli' },
						{ label: 'The CLI\'s JSON output', slug: 'reference/cli-json' },
						{ label: 'Stages', slug: 'reference/stages' },
						{ label: 'The generated pipeline', slug: 'reference/pipeline' },
						{ label: 'The plan report', slug: 'reference/report' },
						{ label: 'Report JSON schema', slug: 'reference/report-schema' },
						{ label: 'The reports bucket', slug: 'reference/reports-bucket' },
						{ label: 'Webhook event schema', slug: 'reference/notify-event' },
						{ label: 'The audit trail', slug: 'reference/audit-trail' },
						{ label: 'Migration files', slug: 'reference/migration-files' },
						{ label: 'Delivery metrics', slug: 'reference/delivery-metrics' },
						{ label: 'Environment variables and credentials', slug: 'reference/environment' },
						{ label: 'Tips', slug: 'reference/tips' },
						{ label: 'Policy', slug: 'reference/policy' },
						{ label: 'Threat model', slug: 'reference/threat-model' },
						{ label: 'Responses to pipeline events', slug: 'reference/responses' },
						{ label: 'Traces and metrics', slug: 'reference/observability' },
						{ label: 'Where it runs', slug: 'reference/runtimes' },
					],
				},
				{
					label: 'Concepts',
					items: [
						{ label: 'How waves and approvals work', slug: 'concepts/waves-and-approvals' },
						{ label: 'Why plans are grouped', slug: 'concepts/why-plans-are-grouped' },
						{ label: 'Approvals as records in your repo', slug: 'concepts/approvals-as-records' },
						{ label: 'Locking per resource', slug: 'concepts/locking-per-resource' },
						{ label: 'Glossary', slug: 'concepts/glossary' },
					],
				},
				{ label: 'Coming from Atlantis or OpenTaco', slug: 'guides/coming-from-atlantis-or-opentaco' },
				{ label: 'Validation', slug: 'reference/validation' },
				{ label: 'Scale', slug: 'reference/scale' },
				{ label: 'What is new in 0.4.3', slug: 'reference/whats-new' },
			],
		}),
	],
});
