import { z } from 'zod';
import fs from 'fs-extra';
import { loadSkill, getSkillFiles } from '../../core/skill.js';
import { getLinkRecords } from '../../core/state.js';
import { skillFile } from '../../fs/paths.js';
import { validateSlug } from '../../utils/errors.js';
import { withToolHandler } from './helpers.js';
import { recordMcpLoad, mcpUsageEventId } from '../../core/usage-store.js';
import { log } from '../../utils/logger.js';

export const getSkillSchema = z.object({
  slug: z.string().describe('Skill identifier'),
  include_content: z
    .boolean()
    .default(true)
    .describe('Include full SKILL.md content; set false for metadata-only disclosure'),
});

export const getSkillHandler = withToolHandler(async (args: z.infer<typeof getSkillSchema>, context) => {
  validateSlug(args.slug);
  const skill = await loadSkill(args.slug);
  const links = await getLinkRecords(args.slug);
  const files = await getSkillFiles(args.slug);
  const rawContent = args.include_content !== false ? await fs.readFile(skillFile(args.slug), 'utf-8') : undefined;
  const usageEventId = rawContent !== undefined ? mcpUsageEventId(context) : undefined;
  if (rawContent !== undefined) {
    try {
      await recordMcpLoad(args.slug, context, usageEventId);
    } catch (error) {
      log.warn(`Could not record MCP skill load: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    slug: skill.slug,
    name: skill.name,
    description: skill.description,
    tags: skill.tags,
    ...(rawContent ? { content: rawContent } : {}),
    ...(usageEventId ? { usage_event_id: usageEventId } : {}),
    meta: skill.meta,
    deployedTo: [...new Set(links.map((l) => l.tool))],
    files,
  };
});
