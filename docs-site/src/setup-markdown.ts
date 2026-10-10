// A setup page (src/content/docs/for/*) as Markdown, for llms-full.txt and the
// "Copy page as Markdown" button: the same lists Room.astro renders, from the
// same data, since the page body itself is only a <Room /> tag.
import { ASSUMED, BINARIES, FORGES, SHAPES, room, type Link } from './data/rooms';
import { provenFor } from './data/coverage';
import { SITE } from './prompts';

const link = (l: Link) => `[${l.label}](${SITE}${l.href})`;
const list = (items: string[]) => items.map((i) => `- ${i}`).join('\n');

export function setupMarkdown(id: string): string {
	const r = room(id);
	const isShape = SHAPES.some((s) => s.room === r.id);
	const out = [r.lede, '## Works', list(r.works), '## Differs', r.differs.length ? list(r.differs) : 'Nothing beyond what the other pages describe.'];
	if (isShape) {
		for (const x of [...BINARIES, ...FORGES]) if (x.differs.length) out.push(`On ${x.label}:`, list(x.differs));
	}
	out.push('## First step', link(r.first));
	if (r.column) {
		out.push('## Proof', `${provenFor(r.column)} recorded checks are proven for ${r.column} on Forgejo. The ${link({ label: 'validation page', href: '/reference/validation/' })} lists them by feature area.`);
	}
	out.push('## You can count on', list(ASSUMED.map(link)));
	out.push('## Then read', `Tasks: ${r.howto.map(link).join(', ')}`, `Background: ${r.explain.map(link).join(', ')}`, `Details: ${r.reference.map(link).join(', ')}`);
	return out.join('\n\n');
}
