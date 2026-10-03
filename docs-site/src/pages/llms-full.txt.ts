import type { APIRoute } from 'astro';
import { PREAMBLE, pages } from './_llms';

export const GET: APIRoute = async () => {
	const body = (await pages()).map((p) => `# ${p.title}\n\nSource: ${p.url}\n\n${p.body}`).join('\n\n---\n\n');
	return new Response(`${PREAMBLE}\n\n---\n\n${body}\n`, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
};
