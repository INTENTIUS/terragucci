import { defineCollection } from 'astro:content';
import { z } from 'astro/zod';
import { docsLoader } from '@astrojs/starlight/loaders';
import { docsSchema } from '@astrojs/starlight/schema';

export const collections = {
	docs: defineCollection({
		loader: docsLoader(),
		schema: docsSchema({
			extend: z.object({
				// The smoke claims a tutorial page shows. `just tutorial-check` lets a
				// page out of draft only when every one of them passes.
				claims: z.array(z.string()).default([]),
			}),
		}),
	}),
};
