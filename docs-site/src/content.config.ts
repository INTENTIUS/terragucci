import { defineCollection } from 'astro:content';
import { z } from 'astro/zod';
import { docsLoader } from '@astrojs/starlight/loaders';
import { docsSchema } from '@astrojs/starlight/schema';
import { promptText } from './prompts';

export const collections = {
	docs: defineCollection({
		loader: docsLoader(),
		schema: docsSchema({
			extend: z.object({
				// The smoke claims a tutorial page shows. `just tutorial-check` lets a
				// page out of draft only when every one of them passes.
				claims: z.array(z.string()).default([]),
				// "Optional: hand this page to your coding agent": the prompt the page header shows under the
				// title, and llms.txt and llms-full.txt carry. `prompt: setup` is the
				// setup prompt from src/prompts.ts. scripts/lint-prompts.mjs checks it.
				prompt: z.string().optional().transform(promptText),
			}),
		}),
	}),
};
