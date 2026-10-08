// The prompts handed to a coding agent. The setup prompt has this one source:
// the home page and the agents page render it, and scripts/lint-prompts.mjs
// holds the copy in README.md to it. Every prompt carries neverLine word for
// word; lint-prompts.mjs fails a prompt that is missing any part of it.

export const SITE = 'https://intentius.io/terragucci';

export const neverLine =
	'Never apply, approve (a pull request review, `terragucci approve`, `chant approve`), override a policy denial (`terragucci override`), use `--mode apply`, or merge; never touch `.chant/allowed_signers` or `chant/lifecycle`.';

export const setupPrompt = [
	'Set up terragucci in this repository.',
	`Read ${SITE}/llms.txt first, then`,
	`${SITE}/getting-started/agents/ and follow it.`,
	'Open a pull request with the result.',
	neverLine,
].join('\n');

// A page's `prompt:` front matter, as its text. `prompt: setup` stands for the
// setup prompt, so a page can carry it without a second copy.
export function promptText(prompt: string | undefined): string | undefined {
	const text = prompt?.trim();
	if (!text) return undefined;
	return text === 'setup' ? setupPrompt : text;
}
