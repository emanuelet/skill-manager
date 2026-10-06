import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createTmpSmHome, type TmpSmHome } from '../helpers/tmpdir.js';
import { createTestSkill } from '../helpers/skill-factory.js';

let tmp: TmpSmHome;
beforeEach(async () => {
  tmp = await createTmpSmHome();
  vi.resetModules();
  await createTestSkill('review', { name: 'Review', description: 'Review code' });
});
afterEach(async () => {
  vi.doUnmock('../../src/core/usage-store.js');
  vi.restoreAllMocks();
  await tmp.cleanup();
});

describe('MCP search selection tracking', () => {
  it('records exact queries and ranked results, selects only content loads in the same session', async () => {
    const { searchSkillsHandler } = await import('../../src/mcp/tools/search-skills.js');
    const { getSkillHandler } = await import('../../src/mcp/tools/get-skill.js');
    const { getSearchUsage } = await import('../../src/core/usage-store.js');
    const { usageBySlug } = await import('../../src/core/usage.js');
    const search = await searchSkillsHandler({ query: 'review' }, { sessionId: 's1', requestId: 'search1' });
    expect(JSON.parse(search.content[0].text)[0].slug).toBe('review');
    await getSkillHandler({ slug: 'review', include_content: false }, { sessionId: 's1', requestId: 'meta' });
    expect((await usageBySlug()).size).toBe(0);
    await getSkillHandler({ slug: 'review', include_content: true }, { sessionId: 's2', requestId: 'load1' });
    expect((await getSearchUsage()).selected).toBe(0);
    await getSkillHandler({ slug: 'review', include_content: true }, { sessionId: 's1', requestId: 'load2' });
    const stats = await getSearchUsage();
    expect(stats).toMatchObject({ searches: 1, selected: 1, empty: 0, selectionRate: 1 });
    expect(stats.recent[0]).toMatchObject({ query: 'review', results: ['review'], selectedSlug: 'review' });
    expect((await usageBySlug()).get('review')?.useCount).toBe(2);
  });

  it('keeps empty searches and does not mark nonexistent loads as usage or success', async () => {
    const { searchSkillsHandler } = await import('../../src/mcp/tools/search-skills.js');
    const { getSkillHandler } = await import('../../src/mcp/tools/get-skill.js');
    const { getSearchUsage } = await import('../../src/core/usage-store.js');
    const { usageBySlug } = await import('../../src/core/usage.js');
    await searchSkillsHandler({ query: 'zzzzzzzzzzzz' }, { sessionId: 's' });
    expect((await getSkillHandler({ slug: 'missing', include_content: true }, { sessionId: 's' })).isError).toBe(true);
    expect((await getSearchUsage()).empty).toBe(1);
    expect((await getSearchUsage()).selected).toBe(0);
    expect((await usageBySlug()).size).toBe(0);
  });

  it('uses the nearest matching search once and deduplicates retried requests', async () => {
    const { recordSkillSearch, recordMcpLoad, getSearchUsage } = await import('../../src/core/usage-store.js');
    await recordSkillSearch('old', ['review'], { sessionId: 's', requestId: 'search1' });
    await recordSkillSearch('new', ['review'], { sessionId: 's', requestId: 'search2' });
    await recordSkillSearch('new', ['review'], { sessionId: 's', requestId: 'search2' });
    await recordMcpLoad('review', { sessionId: 's', requestId: 'load1' });
    await recordMcpLoad('review', { sessionId: 's', requestId: 'load1' });
    await recordMcpLoad('review', { sessionId: 's', requestId: 'load2' });
    const result = await getSearchUsage();
    expect(result).toMatchObject({ searches: 2, selected: 1, unselected: 1 });
    expect(result.recent[0].selectedSlug).toBe('review');
    expect(result.recent[1].selectedSlug).toBeUndefined();
  });

  it('keeps telemetry from multiple writers and exposes search outcomes via MCP analytics', async () => {
    const { recordSkillSearch, recordMcpLoad, getSearchUsage } = await import('../../src/core/usage-store.js');
    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        recordSkillSearch(`query ${index}`, ['review'], { sessionId: `s${index}` }),
      ),
    );
    await Promise.all(Array.from({ length: 8 }, (_, index) => recordMcpLoad('review', { sessionId: `s${index}` })));
    expect((await getSearchUsage()).selected).toBe(8);
    const { getAnalyticsHandler } = await import('../../src/mcp/tools/get-analytics.js');
    const result = JSON.parse((await getAnalyticsHandler({})).content[0].text);
    expect(result.searches.selected).toBe(8);
    expect(result.stats[0].usageCount).toBe(8);
  });

  it('preserves request ID types and counts reused IDs as distinct invocations', async () => {
    const { McpServer } = await import('@modelcontextprotocol/server');
    const { registerTools } = await import('../../src/mcp/tools/index.js');
    const server = new McpServer({ name: 'test', version: '1' });
    registerTools(server);
    type Handler = (
      args: Record<string, unknown>,
      context: { sessionId: string; mcpReq: { id: number | string } },
    ) => Promise<unknown>;
    const tools = (server as unknown as { _registeredTools: Record<string, { handler: Handler }> })._registeredTools;
    for (const id of [1, '1'])
      await tools.search_skills.handler({ query: 'review' }, { sessionId: 's', mcpReq: { id } });
    for (const id of [2, '2'])
      await tools.get_skill.handler({ slug: 'review', include_content: true }, { sessionId: 's', mcpReq: { id } });
    await tools.get_skill.handler({ slug: 'review', include_content: true }, { sessionId: 's', mcpReq: { id: 2 } });
    const { getSearchUsage } = await import('../../src/core/usage-store.js');
    const { usageBySlug } = await import('../../src/core/usage.js');
    expect((await getSearchUsage()).searches).toBe(2);
    expect((await usageBySlug()).get('review')?.useCount).toBe(3);
  });

  it('recovers a failed live write from correlated history, including its search selection', async () => {
    const store = await import('../../src/core/usage-store.js');
    await store.recordSkillSearch('review', ['review'], { sessionId: 's', requestId: 'search1' });
    vi.doMock('../../src/core/usage-store.js', () => ({
      ...store,
      recordMcpLoad: vi.fn(async () => {
        throw new Error('temporary write failure');
      }),
    }));
    const { log } = await import('../../src/utils/logger.js');
    vi.spyOn(log, 'warn').mockImplementation(() => {});
    const { getSkillHandler } = await import('../../src/mcp/tools/get-skill.js');
    const result = await getSkillHandler(
      { slug: 'review', include_content: true },
      { sessionId: 's', requestId: 'load1' },
    );
    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.content[0].text);
    expect(payload.usage_event_id).toMatch(/^mcp:/);
    const { parseOpenCodePart } = await import('../../src/core/usage-parsers.js');
    const event = parseOpenCodePart({
      id: 'part1',
      session_id: 'real-agent-session',
      directory: '/repo',
      data: {
        type: 'tool',
        tool: 'sm_get_skill',
        state: {
          status: 'completed',
          input: { slug: 'review' },
          time: { start: Date.now() },
          output: JSON.stringify(payload),
        },
      },
    })[0];
    const db = await store.openUsageDb();
    expect(store.insertUsageEvent(db, event)).toBe(true);
    expect(store.insertUsageEvent(db, event)).toBe(false);
    db.close();
    const { usageBySlug } = await import('../../src/core/usage.js');
    expect((await usageBySlug()).get('review')?.useCount).toBe(1);
    expect((await store.getSearchUsage()).selected).toBe(1);
    expect((await store.getUsageSources())[0]).toMatchObject({ source: 'mcp', calls: 1, projects: 1 });
  });
});
