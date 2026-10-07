// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// expressive-code renders each code line as its own block element with no
// newline between them, so text extracted from the page (an agent, a reader
// mode, a copy of the selection) runs lines together. A newline text node at the
// end of each line fixes that. The line is a grid, which drops a whitespace-only
// text node, so nothing changes on screen.
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
					node.children.splice(node.children.indexOf(line) + 1, 0, { type: 'text', value: '\n' });
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
	},
	integrations: [
		starlight({
			title: 'terragucci',
			expressiveCode: { plugins: [newlinesBetweenLines] },
			customCss: ['./src/styles/terragucci.css'],
			description: 'CI for Terraform, OpenTofu and Terragrunt, from the pull request to the drift check.',
			social: [
				{ icon: 'github', label: 'GitHub', href: 'https://github.com/INTENTIUS/terragucci' },
			],
			editLink: {
				baseUrl: 'https://github.com/INTENTIUS/terragucci/edit/main/docs-site/',
			},
			// The sections follow what the reader is doing. The validation page is the
			// one people link to, so it has a fixed place.
			sidebar: [
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
						{
							label: 'Add terragucci to a repo',
							items: [
								{ label: 'A GitHub repo', slug: 'guides/add-to-github' },
								{ label: 'A GitLab repo', slug: 'guides/add-to-gitlab' },
								{ label: 'A Forgejo repo', slug: 'guides/add-to-forgejo' },
							],
						},
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
							],
						},
						{
							label: 'Watch and keep',
							items: [
								{ label: 'Turn on drift checks', slug: 'guides/turn-on-drift-checks' },
								{ label: 'Keep reports in S3', slug: 'guides/keep-reports-in-s3' },
							],
						},
						{
							label: 'Set it up your way',
							items: [
								{ label: 'Govern many repos from one place', slug: 'guides/govern-many-repos' },
								{ label: 'Use OpenTofu or choudoufu', slug: 'guides/use-a-binary' },
								{ label: 'Use Terragrunt', slug: 'guides/use-terragrunt' },
							],
						},
						{
							label: 'With a coding agent',
							items: [
								{ label: 'Set up with a coding agent', slug: 'getting-started/agents' },
								{ label: 'Have an agent summarize a refused wave', slug: 'guides/agent-refused-wave' },
								{ label: 'Have an agent change a pull request', slug: 'guides/agent-change-a-pull-request' },
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
						{ label: 'Environment variables and credentials', slug: 'reference/environment' },
						{ label: 'Tips', slug: 'reference/tips' },
						{ label: 'Policy', slug: 'reference/policy' },
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
						{ label: 'Glossary', slug: 'concepts/glossary' },
					],
				},
				{ label: 'How terragucci compares', slug: 'compare' },
				{ label: 'Validation', slug: 'reference/validation' },
			],
		}),
	],
});
