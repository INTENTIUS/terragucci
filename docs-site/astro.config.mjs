// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// Published under the org domain at /terragucci, the same shape fountain-ops
// and loomster use. `base` has to match or every internal link 404s on Pages.
export default defineConfig({
	site: 'https://intentius.io',
	base: '/terragucci',
	integrations: [
		starlight({
			title: 'terragucci',
			customCss: ['./src/styles/terragucci.css'],
			description: 'A lifecycle kit for Terraform, OpenTofu and choudoufu: plan, approve, apply and watch for drift, on your CI or a fountain steward.',
			social: [
				{ icon: 'github', label: 'GitHub', href: 'https://github.com/INTENTIUS/terragucci' },
			],
			editLink: {
				baseUrl: 'https://github.com/INTENTIUS/terragucci/edit/main/docs-site/',
			},
			// The status page is the one people link to, so it has a fixed place.
			sidebar: [
				{
					label: 'Getting started',
					items: [
						{ label: 'What terragucci is', slug: 'getting-started/overview' },
						{ label: 'Which binary you run', slug: 'getting-started/binaries' },
						{ label: 'Your config file', slug: 'getting-started/config' },
					],
				},
				{
					label: 'Reference',
					items: [
						{ label: 'Stages', slug: 'reference/stages' },
						{ label: 'The plan report', slug: 'reference/report' },
						{ label: 'Where it runs', slug: 'reference/runtimes' },
						{ label: 'Validation', slug: 'reference/validation' },
						{ label: 'CI and the site', slug: 'reference/ci' },
					],
				},
				{ label: 'Status', slug: 'status' },
			],
		}),
	],
});
