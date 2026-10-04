// The agent index, built from the docs collection so it never drifts from the
// site. llms.txt lists every page; llms-full.txt carries their text.
import { getCollection } from 'astro:content';

const SITE = 'https://intentius.io/terragucci';

// Sidebar order, with the agent page first and status last.
const ORDER = [
	'getting-started/agents',
	'index',
	'getting-started',
	'tutorial',
	'guides/add-to-github',
	'guides/add-to-gitlab',
	'guides/add-to-forgejo',
	'guides/approve-a-wave',
	'guides/fix-a-refused-wave',
	'guides/roll-out-a-module-version',
	'guides/publish-modules',
	'guides/turn-on-drift-checks',
	'guides/keep-reports-in-s3',
	'guides/govern-many-repos',
	'guides/use-a-binary',
	'guides/use-terragrunt',
	'guides/move-apply-to-fountain',
	'guides/agent-explain-a-plan',
	'guides/agent-refused-wave',
	'guides/agent-drift-fixes',
	'reference/config',
	'reference/cli',
	'reference/stages',
	'reference/report-schema',
	'reference/environment',
	'reference/report',
	'reference/runtimes',
	'reference/validation',
	'concepts/waves-and-approvals',
	'concepts/why-plans-are-grouped',
	'concepts/approvals-as-records',
	'status',
];

export async function pages() {
	const docs = await getCollection('docs');
	const rank = (id: string) => {
		const i = ORDER.indexOf(id);
		return i === -1 ? ORDER.length : i;
	};
	return docs
		.sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id))
		.map((d) => ({
			id: d.id,
			title: d.data.title,
			description: d.data.description ?? '',
			url: d.id === 'index' ? `${SITE}/` : `${SITE}/${d.id}/`,
			// MDX import lines and component tags are code, not text.
			body: (d.body ?? '').replace(/^(import .*|<[A-Z][^>]*\/>)\n?/gm, '').trim(),
		}));
}

export const PREAMBLE = `# terragucci

> The whole Terraform lifecycle, handled: grouped plans on every pull request, applies in gated waves, drift reports, module publishing and rollouts, for Terraform, OpenTofu and Terragrunt on GitHub, GitLab or Forgejo.

The docs describe the finished product in the present tense. The status page (${SITE}/status/) is the only record of what is built today. Before you run a command or promise a feature to a user, check it there, and say plainly when something is not built yet.

Agents adopting terragucci in a repository: start with ${SITE}/getting-started/agents/.`;
