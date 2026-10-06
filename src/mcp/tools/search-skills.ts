import { z } from 'zod';
import { searchSkills } from '../../core/search.js';
import { getLinkRecords } from '../../core/state.js';
import { withToolHandler } from './helpers.js';
import { recordSkillSearch } from '../../core/usage-store.js';
import { log } from '../../utils/logger.js';

export const searchSkillsSchema = z.object({
  query: z.string().describe('Search term'),
});

export const searchSkillsHandler = withToolHandler(async (args: z.infer<typeof searchSkillsSchema>, context) => {
  const matches = await searchSkills(args.query);

  const links = await getLinkRecords();

  const results = matches.map((s) => {
    const skillLinks = links.filter((l) => l.slug === s.slug);
    return {
      slug: s.slug,
      name: s.name,
      description: s.description,
      tags: s.tags,
      deployedTo: [...new Set(skillLinks.map((l) => l.tool))],
    };
  });
  try {
    await recordSkillSearch(
      args.query,
      results.map((result) => result.slug),
      context,
    );
  } catch (error) {
    log.warn(`Could not record MCP skill search: ${error instanceof Error ? error.message : String(error)}`);
  }
  return results;
});
