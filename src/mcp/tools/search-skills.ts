import { z } from 'zod';
import { searchSkills } from '../../core/search.js';
import { getLinkRecords } from '../../core/state.js';
import { withToolHandler } from './helpers.js';

export const searchSkillsSchema = z.object({
  query: z.string().describe('Search term'),
});

export const searchSkillsHandler = withToolHandler(
  async (args: z.infer<typeof searchSkillsSchema>) => {
    const matches = await searchSkills(args.query);

    const links = await getLinkRecords();

    return matches.map((s) => {
      const skillLinks = links.filter((l) => l.slug === s.slug);
      return {
        slug: s.slug,
        name: s.name,
        description: s.description,
        tags: s.tags,
        deployedTo: [...new Set(skillLinks.map((l) => l.tool))],
      };
    });
  },
);
