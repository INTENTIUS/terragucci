// The prompts handed to a coding agent. The setup prompt has this one source:
// the home page and the agents page render it, and scripts/lint-prompts.mjs
// holds the copy in README.md to it. Every prompt forbids apply, approve and
// merge; lint-prompts.mjs fails a page whose prompt does not.

export const SITE = 'https://intentius.io/terragucci';

export const setupPrompt = [
	'Set up terragucci in this repository.',
	`Read ${SITE}/llms.txt first, then`,
	`${SITE}/getting-started/agents/ and follow it.`,
	'Do not apply anything. Open a pull request with the result.',
	'Never approve or run chant approve; never merge.',
].join('\n');

// A page's `prompt:` front matter, as its text. `prompt: setup` stands for the
// setup prompt, so a page can carry it without a second copy.
export function promptText(prompt: string | undefined): string | undefined {
	const text = prompt?.trim();
	if (!text) return undefined;
	return text === 'setup' ? setupPrompt : text;
}
