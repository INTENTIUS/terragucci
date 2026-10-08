// The agent index, built from the docs collection so it never drifts from the
// site. llms.txt lists every page; llms-full.txt carries their text.
import { getCollection } from 'astro:content';
import { bodyMarkdown, pageUrl } from '../markdown';
import { SITE } from '../prompts';

// Sidebar order, with the agent page first.
const ORDER = [
	'getting-started/agents',
	'index',
	'concepts/how-it-works',
	'getting-started',
	'tutorial',
	'guides/add-to-a-repo',
	'guides/approve-a-wave',
	'guides/fix-a-refused-wave',
	'guides/approvals-runbook',
	'guides/re-plan-from-a-comment',
	'guides/apply-before-merge',
	'guides/roll-out-a-module-version',
	'guides/publish-modules',
	'guides/turn-on-drift-checks',
	'guides/keep-reports-in-a-bucket',
	'guides/send-traces-and-metrics',
	'guides/govern-many-repos',
	'guides/use-a-binary',
	'guides/use-terragrunt',
	'guides/agent-refused-wave',
	'guides/agent-change-a-pull-request',
	'reference/config',
	'reference/cli',
	'reference/stages',
	'reference/report-schema',
	'reference/reports-bucket',
	'reference/environment',
	'reference/report',
	'reference/runtimes',
	'reference/validation',
	'concepts/waves-and-approvals',
	'concepts/why-plans-are-grouped',
	'concepts/approvals-as-records',
	'concepts/glossary',
];

export async function pages() {
	const docs = await getCollection('docs');
	const rank = (id: string) => {
		const i = ORDER.indexOf(id);
		return i === -1 ? ORDER.length : i;
	};
	// The 404 page is no page to read.
	return docs
		.filter((d) => d.id !== '404')
		.sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id))
		.map((d) => ({
			id: d.id,
			title: d.data.title,
			description: d.data.description ?? '',
			url: pageUrl(d.id),
			prompt: d.data.prompt,
			body: bodyMarkdown(d.body ?? ''),
		}));
}

export const PREAMBLE = `# terragucci

> The whole Terraform lifecycle, handled: grouped plans on every pull request, applies in gated waves, drift reports, module publishing and rollouts, for Terraform, OpenTofu and Terragrunt on GitHub, GitLab or Forgejo.

Every page is true as written: a command or key on this site works as the page says. A key that \`terragucci config check\` refuses is not part of terragucci. The validation page (${SITE}/reference/validation/) lists the checks every generated pipeline passes.

Agents adopting terragucci in a repository: start with ${SITE}/getting-started/agents/.

A page with a prompt carries it under "Optional: hand this page to your coding agent", and llms.txt lists it under the page. Every prompt forbids apply, approve and merge; those stay with the person.`;
