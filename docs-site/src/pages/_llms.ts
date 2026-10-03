// The agent index, built from the docs collection so it never drifts from the
// site. llms.txt lists every page; llms-full.txt carries their text.
import { getCollection } from 'astro:content';

const SITE = 'https://intentius.io/terragucci';

// Sidebar order, with the agent page first and status last.
const ORDER = [
	'getting-started/agents',
	'index',
	'getting-started/overview',
	'getting-started/binaries',
	'getting-started/config',
	'tutorial',
	'reference/stages',
	'reference/report',
	'reference/runtimes',
	'reference/validation',
	'reference/ci',
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
			body: (d.body ?? '').replace(/^(import .*|<[A-Z]\w* *\/>)\n?/gm, '').trim(),
		}));
}

export const PREAMBLE = `# terragucci

> The whole Terraform lifecycle, handled: grouped plans on every pull request, applies in gated waves, drift reports, module publishing and rollouts, for Terraform, OpenTofu, choudoufu and CDK Terrain on GitHub, GitLab or Forgejo.

The docs describe the finished product in the present tense. The status page (${SITE}/status/) is the only record of what is built today. Before you run a command or promise a feature to a user, check it there, and say plainly when something is not built yet.

Agents adopting terragucci in a repository: start with ${SITE}/getting-started/agents/.`;
