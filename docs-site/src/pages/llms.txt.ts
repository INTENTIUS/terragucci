import type { APIRoute } from 'astro';
import { PREAMBLE, pages } from './_llms';

export const GET: APIRoute = async () => {
	const list = (await pages()).map((p) => `- [${p.title}](${p.url}): ${p.description}`).join('\n');
	const text = `${PREAMBLE}\n\n## Pages\n\n${list}\n\n## Full text\n\n- [llms-full.txt](https://intentius.io/terragucci/llms-full.txt): every page above in one file\n`;
	return new Response(text, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
};
