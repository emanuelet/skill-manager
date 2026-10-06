import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import fs from 'fs-extra';
import path from 'node:path';
import { createTmpSmHome, type TmpSmHome } from '../helpers/tmpdir.js';
import { createTestSkill } from '../helpers/skill-factory.js';

let tmp: TmpSmHome;
beforeEach(async () => {
  tmp = await createTmpSmHome();
  vi.resetModules();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await tmp.cleanup();
});

async function writeTrace(relative: string, rows: unknown[]) {
  const file = path.join(tmp.home, relative);
  await fs.outputFile(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  return file;
}

describe('internal usage ledger', () => {
  it('collects every native JSONL provider, deduplicates rescans, and uses canonical project paths', async () => {
    const time = new Date().toISOString();
    await writeTrace('.claude/history.jsonl', [
      { display: '/review', timestamp: Date.parse(time), sessionId: 'cc', project: '/repo' },
    ]);
    await writeTrace('.claude/projects/repo/cc.jsonl', [
      {
        sessionId: 'cc',
        cwd: '/repo',
        timestamp: time,
        message: { content: [{ type: 'tool_use', id: 'call1', name: 'Skill', input: { skill: 'review' } }] },
      },
    ]);
    await writeTrace('.codex/sessions/s.jsonl', [
      { type: 'session_meta', payload: { id: 'cx', cwd: '/repo' } },
      {
        type: 'response_item',
        timestamp: time,
        payload: { content: [{ type: 'input_text', text: '<skill><name>review</name></skill>' }] },
      },
    ]);
    await writeTrace('.factory/sessions/s.jsonl', [
      { type: 'session_start', id: 'dr', cwd: '/repo' },
      {
        timestamp: time,
        message: { content: [{ type: 'tool_result', tool_use_id: 'd1', content: 'Skill "review" is now active' }] },
      },
    ]);
    await writeTrace('.grok/sessions/%2Frepo/gr/updates.jsonl', [
      {
        timestamp: Date.parse(time) / 1000,
        params: {
          sessionId: 'gr',
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'g1',
            title: 'read_file',
            rawInput: { path: '/skills/review/SKILL.md' },
          },
        },
      },
    ]);
    const { refreshUsage, usageBySlug, usageDetail } = await import('../../src/core/usage.js');
    expect((await refreshUsage()).source).toBe('native');
    await refreshUsage();
    expect((await usageBySlug()).get('review')).toMatchObject({ useCount: 4, sessions: 4, projects: 1 });
    expect(await usageDetail('review', '/repo')).toMatchObject({ count: 4, projects: [{ name: '/repo', count: 4 }] });
    expect((await usageDetail('review', '/another/repo')).count).toBe(0);
  });

  it('preserves evidence on provider failure and recovers an unfinished tail', async () => {
    const file = await writeTrace('.claude/projects/repo/s.jsonl', [
      {
        sessionId: 's',
        timestamp: new Date().toISOString(),
        message: { content: [{ type: 'tool_use', id: 'one', name: 'Skill', input: { skill: 'review' } }] },
      },
    ]);
    const { refreshUsage, usageBySlug } = await import('../../src/core/usage.js');
    await refreshUsage();
    await fs.appendFile(file, '{"sessionId":"s",');
    expect((await refreshUsage()).collectors.find((row) => row.source === 'claude-code')?.status).toBe('error');
    expect((await usageBySlug()).get('review')?.useCount).toBe(1);
    await fs.appendFile(
      file,
      `"timestamp":"${new Date().toISOString()}","message":{"content":[{"type":"tool_use","id":"two","name":"Skill","input":{"skill":"review"}}]}}\n`,
    );
    expect((await refreshUsage()).collectors.find((row) => row.source === 'claude-code')?.status).toBe('available');
    expect((await usageBySlug()).get('review')?.useCount).toBe(2);
    await fs.remove(file);
    await refreshUsage();
    expect((await usageBySlug()).get('review')?.useCount).toBe(2);
  });

  it('reads mutable OpenCode SQLite rows and counts live MCP loads only once', async () => {
    const file = path.join(tmp.home, '.local/share/opencode/opencode.db');
    await fs.ensureDir(path.dirname(file));
    const input = new DatabaseSync(file);
    input.exec(
      'CREATE TABLE session(id TEXT PRIMARY KEY, directory TEXT); CREATE TABLE part(id TEXT PRIMARY KEY, session_id TEXT, data TEXT);',
    );
    input.prepare('INSERT INTO session VALUES (?, ?)').run('s', '/repo');
    const part = (status: string) =>
      JSON.stringify({
        type: 'tool',
        callID: 'call1',
        tool: 'skill',
        state: { status, input: { name: 'review' }, time: { start: Date.now() } },
      });
    input.prepare('INSERT INTO part VALUES (?, ?, ?)').run('p', 's', part('running'));
    const { refreshUsage, usageBySlug } = await import('../../src/core/usage.js');
    const { recordMcpLoad } = await import('../../src/core/usage-store.js');
    await refreshUsage();
    expect((await usageBySlug()).size).toBe(0);
    input.prepare('UPDATE part SET data = ?').run(part('completed'));
    await refreshUsage();
    const usageEventId = await recordMcpLoad('review', { sessionId: 'mcp-session', requestId: '1' });
    await recordMcpLoad('review', { sessionId: 'mcp-session', requestId: '1' });
    input.prepare('INSERT INTO part VALUES (?, ?, ?)').run(
      'mcp',
      's',
      JSON.stringify({
        type: 'tool',
        tool: 'sm_get_skill',
        state: {
          status: 'completed',
          input: { slug: 'review' },
          time: { start: Date.now() + 1000 },
          output: JSON.stringify({
            slug: 'review',
            content: '# Review',
            meta: { source: {} },
            files: [],
            usage_event_id: usageEventId,
          }),
        },
      }),
    );
    await refreshUsage();
    expect((await usageBySlug()).get('review')?.useCount).toBe(2);
    input.prepare('INSERT INTO part VALUES (?, ?, ?)').run(
      'untracked',
      's',
      JSON.stringify({
        type: 'tool',
        tool: 'old_sm_get_skill',
        state: {
          status: 'completed',
          input: { slug: 'review' },
          time: { start: Date.now() + 2000 },
          output: JSON.stringify({ slug: 'review', content: '# Review', meta: { source: {} }, files: [] }),
        },
      }),
    );
    await refreshUsage();
    expect((await usageBySlug()).get('review')?.useCount).toBe(3);
    input.close();
  });

  it('immediately exposes MCP loads in analytics without metadata double counting', async () => {
    await createTestSkill('review', { name: 'Review', description: 'Code review' }, { usageCount: 10 });
    const { getAnalyticsSnapshot } = await import('../../src/core/analytics-snapshot.js');
    const { recordMcpLoad } = await import('../../src/core/usage-store.js');
    expect((await getAnalyticsSnapshot()).stats[0].usageCount).toBe(10);
    await recordMcpLoad('review', { sessionId: 's', requestId: '1', client: 'test-agent' });
    const snapshot = await getAnalyticsSnapshot();
    expect(snapshot.stats[0].usageCount).toBe(1);
    expect(snapshot.sources).toContainEqual(expect.objectContaining({ source: 'mcp', calls: 1 }));
    expect(snapshot.usageSource).toBe('native');
  });

  it('keeps legacy aggregate rows as fallback when no collector is available', async () => {
    const { openUsageDb, recordMcpLoad } = await import('../../src/core/usage-store.js');
    const db = await openUsageDb();
    db.prepare('INSERT INTO skill_usage VALUES (?, ?, ?, ?, ?, ?)').run(
      'review',
      12,
      4,
      2,
      new Date().toISOString(),
      new Date().toISOString(),
    );
    db.close();
    const { refreshUsage, usageBySlug, usageDetail } = await import('../../src/core/usage.js');
    await refreshUsage();
    expect((await usageBySlug()).get('review')?.useCount).toBe(12);
    expect(await usageDetail('review')).toMatchObject({ count: 12, sessions: 4, projects: [] });
    await recordMcpLoad('other', { sessionId: 's' });
    await refreshUsage();
    expect((await usageBySlug()).get('review')?.useCount).toBe(12);
  });

  it('does not count a Codex session again when archived', async () => {
    const file = await writeTrace('.codex/sessions/s.jsonl', [
      { type: 'session_meta', payload: { id: 's', cwd: '/repo' } },
      {
        type: 'response_item',
        timestamp: new Date().toISOString(),
        payload: { content: [{ type: 'input_text', text: '<skill><name>review</name></skill>' }] },
      },
    ]);
    const { refreshUsage, usageBySlug } = await import('../../src/core/usage.js');
    await refreshUsage();
    await fs.move(file, path.join(tmp.home, '.codex/archived_sessions/s.jsonl'));
    await refreshUsage();
    expect((await usageBySlug()).get('review')?.useCount).toBe(1);
  });

  it('rejects out-of-range timestamps and ignores previously persisted invalid observations', async () => {
    const { openUsageDb, insertUsageEvent } = await import('../../src/core/usage-store.js');
    const db = await openUsageDb();
    const event = {
      id: 'bad',
      slug: 'review',
      source: 'opencode',
      kind: 'native' as const,
      timestamp: 1e20,
      session: 's',
    };
    expect(insertUsageEvent(db, event)).toBe(false);
    db.prepare('INSERT INTO usage_events VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      'old-invalid',
      'review',
      'opencode',
      'native',
      1e20,
      's',
      null,
      null,
    );
    insertUsageEvent(db, { ...event, id: 'valid', timestamp: Date.now() });
    db.close();
    const { usageBySlug, usageDetail } = await import('../../src/core/usage.js');
    expect((await usageBySlug()).get('review')?.useCount).toBe(1);
    expect((await usageDetail('review')).count).toBe(1);
  });

  it('collects OpenCode updates incrementally and reconciles late rows even when its fingerprint is unchanged', async () => {
    const file = path.join(tmp.home, '.local/share/opencode/opencode.db');
    await fs.ensureDir(path.dirname(file));
    const input = new DatabaseSync(file);
    input.exec(
      'CREATE TABLE session(id TEXT PRIMARY KEY, directory TEXT); CREATE TABLE part(id TEXT PRIMARY KEY, session_id TEXT, data TEXT, time_updated INTEGER);',
    );
    input.prepare('INSERT INTO session VALUES (?, ?)').run('s', '/repo');
    const data = (id: string, status: string) =>
      JSON.stringify({
        type: 'tool',
        callID: id,
        tool: 'skill',
        state: { status, input: { name: 'review' }, time: { start: Date.now() } },
      });
    input.prepare('INSERT INTO part VALUES (?, ?, ?, ?)').run('late', 's', data('late', 'running'), 1000);
    input.prepare('INSERT INTO part VALUES (?, ?, ?, ?)').run('new', 's', data('new', 'completed'), 5000);
    const { refreshUsage, usageBySlug } = await import('../../src/core/usage.js');
    const { openUsageDb } = await import('../../src/core/usage-store.js');
    await refreshUsage();
    expect((await usageBySlug()).get('review')?.useCount).toBe(1);
    // Simulate a late/imported row outside the normal update watermark overlap.
    input.prepare('UPDATE part SET data = ? WHERE id = ?').run(data('late', 'completed'), 'late');
    await refreshUsage();
    expect((await usageBySlug()).get('review')?.useCount).toBe(1);
    const db = await openUsageDb();
    const cursor = db.prepare("SELECT key, value FROM usage_settings WHERE key LIKE 'opencode:%'").get()!;
    db.prepare('UPDATE usage_settings SET value = ? WHERE key = ?').run(
      JSON.stringify({ ...JSON.parse(String(cursor.value)), fullScanAt: 0 }),
      cursor.key,
    );
    db.close();
    await refreshUsage();
    expect((await usageBySlug()).get('review')?.useCount).toBe(2);
    input
      .prepare('UPDATE part SET data = ?, time_updated = ? WHERE id = ?')
      .run(data('newer', 'completed'), 7000, 'new');
    await refreshUsage();
    expect((await usageBySlug()).get('review')?.useCount).toBe(3);
    input.close();
  });
});
