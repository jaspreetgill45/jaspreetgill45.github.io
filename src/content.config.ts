import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

// Writeups live in src/content/writeups/ as Markdown files.
// Files starting with an underscore (like _TEMPLATE.md) are ignored.
const writeups = defineCollection({
	loader: glob({ base: './src/content/writeups', pattern: '**/[^_]*.{md,mdx}' }),
	schema: z.object({
		title: z.string(),
		description: z.string(),
		date: z.coerce.date(),
		updated: z.coerce.date().optional(),
		platform: z.string().optional(), // e.g. CyberDefenders, Blue Team Labs Online, Home lab
		category: z.string().optional(), // e.g. Network forensics, Memory forensics
		difficulty: z.enum(['Easy', 'Medium', 'Hard']).optional(),
		tools: z.array(z.string()).default([]),
		draft: z.boolean().default(false), // true = visible locally, hidden on the live site
	}),
});

export const collections = { writeups };
