import type { McpServer } from '@modelcontextprotocol/server';
import { randomUUID } from 'node:crypto';
import { listSkillsSchema, listSkillsHandler } from './list-skills.js';
import { getSkillSchema, getSkillHandler } from './get-skill.js';
import { searchSkillsSchema, searchSkillsHandler } from './search-skills.js';
import { deploySkillSchema, deploySkillHandler } from './deploy-skill.js';
import { undeploySkillSchema, undeploySkillHandler } from './undeploy-skill.js';
import { suggestSkillsSchema, suggestSkillsHandler } from './suggest-skills.js';
import { getAnalyticsSchema, getAnalyticsHandler } from './get-analytics.js';
import { listSourcesSchema, listSourcesHandler } from './list-sources.js';
import { syncSourceSchema, syncSourceHandler } from './sync-source.js';

export function registerTools(server: McpServer): void {
  const connection = randomUUID();
  server.registerTool(
    'list_skills',
    {
      description: 'List all managed skills with optional filtering by tag or deployment status',
      inputSchema: listSkillsSchema,
    },
    (args) => listSkillsHandler(args),
  );

  server.registerTool(
    'get_skill',
    {
      description: 'Read one skill. Set include_content=false for metadata-only progressive disclosure.',
      inputSchema: getSkillSchema,
    },
    (args, ctx) =>
      getSkillHandler(args, {
        sessionId: `${connection}:${ctx.sessionId ?? 'stdio'}`,
        requestId: JSON.stringify(ctx.mcpReq.id),
        client: server.server.getClientVersion()?.name,
      }),
  );

  server.registerTool(
    'search_skills',
    {
      description: 'Search ranked skill metadata by name, description, tags, aliases, intents, or content',
      inputSchema: searchSkillsSchema,
    },
    (args, ctx) =>
      searchSkillsHandler(args, {
        sessionId: `${connection}:${ctx.sessionId ?? 'stdio'}`,
        requestId: JSON.stringify(ctx.mcpReq.id),
        client: server.server.getClientVersion()?.name,
      }),
  );

  server.registerTool(
    'deploy_skill',
    {
      description:
        'Deploy a skill to Claude Code and/or the shared agents directory (Codex CLI and OpenCode) with automatic dependency resolution',
      inputSchema: deploySkillSchema,
    },
    (args) => deploySkillHandler(args),
  );

  server.registerTool(
    'undeploy_skill',
    { description: 'Remove a skill deployment from Claude Code and/or Codex CLI', inputSchema: undeploySkillSchema },
    (args) => undeploySkillHandler(args),
  );

  server.registerTool(
    'suggest_skills',
    {
      description: 'Get paginated trigger-based skill suggestions for a project directory',
      inputSchema: suggestSkillsSchema,
    },
    (args) => suggestSkillsHandler(args),
  );

  server.registerTool(
    'get_analytics',
    {
      description:
        'Get native and MCP skill usage, collector health, search selection outcomes, stale skills, and unused skills',
      inputSchema: getAnalyticsSchema,
    },
    (args) => getAnalyticsHandler(args),
  );

  server.registerTool(
    'list_sources',
    { description: 'List configured remote skill sources with sync status', inputSchema: listSourcesSchema },
    (args) => listSourcesHandler(args),
  );

  server.registerTool(
    'sync_source',
    { description: 'Sync one or all remote skill sources (git pull + rescan)', inputSchema: syncSourceSchema },
    (args) => syncSourceHandler(args),
  );
}
