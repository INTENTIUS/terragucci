// A docs page as plain Markdown, for llms-full.txt and the "Copy page as
// Markdown" button. MDX import lines and component tags are code, not text (a
// setup page's <Room /> becomes its text, from setup-markdown.ts); a
// tab's label stays as a bold line so the forge or binary each tab is for is
// still named.
import { SITE } from './prompts';
import { setupMarkdown } from './setup-markdown';

export function pageUrl(id: string): string {
	return id === 'index' ? `${SITE}/` : `${SITE}/${id}/`;
}

export function bodyMarkdown(body: string): string {
	return body
		// A setup page's body is one <Room /> tag; its text comes from the same data.
		.replace(/^[ \t]*<Room id="([a-z-]+)" \/>[ \t]*$/gm, (_, id: string) => setupMarkdown(id))
		.replace(/^[ \t]*<TabItem\b[^>]*\blabel="([^"]+)"[^>]*>[ \t]*$/gm, '**$1**')
		.replace(/^(import .*|[ \t]*<\/?[A-Z][^>]*\/?>[ \t]*)$\n?/gm, '')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

export function pageMarkdown(page: { title: string; url: string; prompt?: string; body: string }): string {
	const prompt = page.prompt ? `## Optional: hand this page to your coding agent\n\n\`\`\`text\n${page.prompt}\n\`\`\`\n\n` : '';
	return `# ${page.title}\n\nSource: ${page.url}\n\n${prompt}${page.body}`;
}
