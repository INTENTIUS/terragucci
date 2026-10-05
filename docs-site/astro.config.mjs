// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

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
	},
	integrations: [
		starlight({
			title: 'terragucci',
			customCss: ['./src/styles/terragucci.css'],
			description: 'A lifecycle kit for Terraform, OpenTofu and Terragrunt: plan, approve, apply and watch for drift, on your CI or a fountain steward.',
			social: [
				{ icon: 'github', label: 'GitHub', href: 'https://github.com/INTENTIUS/terragucci' },
			],
			editLink: {
				baseUrl: 'https://github.com/INTENTIUS/terragucci/edit/main/docs-site/',
			},
			// The sections follow what the reader is doing. The status page is the
			// one people link to, so it has a fixed place.
			sidebar: [
				{ label: 'Getting started', items: [{ label: 'Get your first plan note', slug: 'getting-started' }] },
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
								{ label: 'Roll out a new module version', slug: 'guides/roll-out-a-module-version' },
								{ label: 'Publish your modules', slug: 'guides/publish-modules' },
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
								{ label: 'Use OpenTofu, choudoufu or CDK Terrain', slug: 'guides/use-a-binary' },
								{ label: 'Use Terragrunt', slug: 'guides/use-terragrunt' },
								{ label: 'Move apply onto a fountain steward', slug: 'guides/move-apply-to-fountain' },
							],
						},
						{
							label: 'With a coding agent',
							items: [
								{ label: 'Set up with a coding agent', slug: 'getting-started/agents' },
								{ label: 'Have an agent explain a plan', slug: 'guides/agent-explain-a-plan' },
								{ label: 'Have an agent summarize a refused wave', slug: 'guides/agent-refused-wave' },
								{ label: 'Have an agent propose drift fixes', slug: 'guides/agent-drift-fixes' },
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
						{ label: 'Validation', slug: 'reference/validation' },
					],
				},
				{
					label: 'Concepts',
					items: [
						{ label: 'How waves and approvals work', slug: 'concepts/waves-and-approvals' },
						{ label: 'Why plans are grouped', slug: 'concepts/why-plans-are-grouped' },
						{ label: 'Approvals as records in your repo', slug: 'concepts/approvals-as-records' },
					],
				},
				{ label: 'Status', slug: 'status' },
			],
		}),
	],
});
