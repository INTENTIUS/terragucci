import type { APIRoute } from 'astro';
import { PREAMBLE, pages } from './_llms';
import { pageMarkdown } from '../markdown';

export const GET: APIRoute = async () => {
	const body = (await pages()).map(pageMarkdown).join('\n\n---\n\n');
	return new Response(`${PREAMBLE}\n\n---\n\n${body}\n`, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
};
