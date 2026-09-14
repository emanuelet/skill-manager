import { z } from 'zod';
import { listSkills } from '../../core/skill.js';
import { getLinkRecords } from '../../core/state.js';
import { withToolHandler } from './helpers.js';

export const listSkillsSchema = z.object({
  tag: z.string().optional().describe('Filter by tag'),
  deployed_only: z.boolean().optional().describe('Show only deployed skills'),
  offset: z.number().int().min(0).optional().describe('Number of matching skills to skip (default: 0)'),
  limit: z.number().int().min(1).max(100).optional().describe('Maximum skills to return (default: 20, max: 100)'),
});

export const listSkillsHandler = withToolHandler(
  async (args: z.infer<typeof listSkillsSchema>) => {
    let skills = await listSkills();
    const links = await getLinkRecords();

    if (args.tag) {
      const tag = args.tag.toLowerCase();
      skills = skills.filter((s) =>
        s.tags.some((t) => t.toLowerCase() === tag),
      );
    }

    const results = skills.map((s) => {
      const skillLinks = links.filter((l) => l.slug === s.slug);
      return {
        slug: s.slug,
        name: s.name,
        description: s.description,
        tags: s.tags,
        deployedTo: [...new Set(skillLinks.map((l) => l.tool))],
      };
    });

    const filtered = args.deployed_only ? results.filter((r) => r.deployedTo.length > 0) : results;
    const offset = args.offset ?? 0;
    const limit = args.limit ?? 20;

    return {
      skills: filtered.slice(offset, offset + limit),
      total: filtered.length,
      offset,
      limit,
      has_more: offset + limit < filtered.length,
    };
  },
);
