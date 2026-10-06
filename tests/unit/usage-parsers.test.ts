import { describe, expect, it } from 'vitest';
import { createTraceParser, parseOpenCodePart } from '../../src/core/usage-parsers.js';

const time = '2026-09-24T06:27:40.147Z';
const when = Date.parse(time);
const content = JSON.stringify({
  slug: 'review',
  content: '# Review',
  meta: { source: { type: 'created' } },
  files: [],
});

describe('native usage extraction', () => {
  it('extracts Claude commands and Skill calls with session/project identities', () => {
    const parse = createTraceParser('claude-code', '/traces/session.jsonl');
    expect(parse({ display: '/review code', timestamp: when, sessionId: 's1', project: '/repo' }, 1)[0]).toMatchObject({
      slug: 'review',
      source: 'claude-code',
      kind: 'command',
      project: '/repo',
      session: 's1',
    });
    const row = {
      timestamp: time,
      message: { content: [{ type: 'tool_use', id: 'tool-1', name: 'Skill', input: { skill: 'review' } }] },
    };
    expect(parse(row, 2)[0]).toMatchObject({ slug: 'review', kind: 'native', timestamp: when });
    expect(parse(row, 99)[0].id).toBe(parse(row, 2)[0].id);
    expect(parse({ display: '/help', timestamp: when }, 3)).toEqual([]);
  });

  it('restricts Codex names to skill blocks and carries session metadata', () => {
    const parse = createTraceParser('codex', '/traces/file.jsonl');
    parse({ type: 'session_meta', payload: { id: 'codex-session', cwd: '/repo' } }, 1);
    const events = parse(
      {
        type: 'response_item',
        timestamp: time,
        payload: {
          content: [
            {
              type: 'input_text',
              text: '<name>not-a-skill</name><skill><name>review</name></skill><skill><name>plan</name></skill>',
            },
          ],
        },
      },
      2,
    );
    expect(events.map((event) => event.slug)).toEqual(['review', 'plan']);
    expect(events[0]).toMatchObject({ session: 'codex-session', project: '/repo' });
  });

  it('extracts Droid activation results, not arbitrary assistant prose', () => {
    const parse = createTraceParser('droid', '/traces/s1.jsonl');
    parse({ type: 'session_start', id: 's1', cwd: '/repo' }, 1);
    const events = parse(
      {
        timestamp: time,
        message: {
          content: [
            { type: 'text', content: 'Skill "fake" is now active' },
            { type: 'tool_result', tool_use_id: 'call1', content: 'Skill "review" is now active' },
          ],
        },
      },
      2,
    );
    expect(events.map((event) => event.slug)).toEqual(['review']);
  });

  it('extracts Grok command tags and playbook reads with shared update/chat IDs', () => {
    const parse = createTraceParser('grok', '/sessions/%2Frepo/session/updates.jsonl');
    const events = parse(
      {
        timestamp: when / 1000,
        params: {
          sessionId: 'session',
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'call1',
            title: 'read_file',
            rawInput: { target_file: 'C:\\repo\\skills\\review\\SKILL.md' },
          },
        },
      },
      1,
    );
    expect(events[0]).toMatchObject({ slug: 'review', kind: 'playbook', timestamp: when, project: '/repo' });
    const chat = parse(
      {
        timestamp: time,
        tool_calls: [
          { id: 'call1', name: 'read_file', arguments: JSON.stringify({ path: '/skills/review/SKILL.md' }) },
        ],
      },
      2,
    );
    expect(chat[0].id).toBe(events[0].id);
    expect(
      parse(
        {
          timestamp: when / 1000,
          params: {
            update: { sessionUpdate: 'user_message_chunk', content: { text: '<command-name>plan</command-name>' } },
          },
        },
        3,
      )[0].slug,
    ).toBe('plan');
  });

  it('only extracts completed OpenCode native calls and keeps distinct session identities', () => {
    const row = {
      id: 'part1',
      session_id: 's1',
      directory: '/repo',
      data: JSON.stringify({
        type: 'tool',
        callID: 'call1',
        tool: 'skill',
        state: { status: 'completed', input: { name: 'review' }, time: { start: when } },
      }),
    };
    expect(parseOpenCodePart(row)[0]).toMatchObject({ slug: 'review', session: 's1', source: 'opencode' });
    expect(parseOpenCodePart({ ...row, session_id: 's2' })[0].id).not.toBe(parseOpenCodePart(row)[0].id);
    expect(parseOpenCodePart({ ...row, data: { type: 'tool', tool: 'skill', state: { status: 'error' } } })).toEqual(
      [],
    );
  });

  it('does not fabricate timestamps for malformed or timestamp-free invocations', () => {
    const parse = createTraceParser('claude-code', '/s.jsonl');
    expect(
      parse(
        { timestamp: 'bad', message: { content: [{ type: 'tool_use', name: 'Skill', input: { skill: 'review' } }] } },
        1,
      ),
    ).toEqual([]);
    expect(
      parse(
        { timestamp: 1e20, message: { content: [{ type: 'tool_use', name: 'Skill', input: { skill: 'review' } }] } },
        2,
      ),
    ).toEqual([]);
  });

  it('preserves the first Codex fork metadata and identities across archival', () => {
    const row = {
      type: 'response_item',
      timestamp: time,
      payload: { content: [{ type: 'input_text', text: '<skill><name>review</name></skill>' }] },
    };
    const extract = (file: string) => {
      const parse = createTraceParser('codex', file);
      parse({ type: 'session_meta', payload: { id: 'child', cwd: '/child' } }, 1);
      parse({ type: 'session_meta', payload: { id: 'parent', cwd: '/parent' } }, 2);
      return parse(row, 3)[0];
    };
    expect(extract('/sessions/s.jsonl')).toMatchObject({ session: 'child', project: '/child' });
    expect(extract('/sessions/s.jsonl').id).toBe(extract('/archived_sessions/s.jsonl').id);
  });

  it('extracts Grok timestamp-free chat fallbacks and excludes replayed background context', () => {
    const session = '019f0000-0000-7000-8000-000000000000';
    const parse = createTraceParser('grok', `/sessions/%2Frepo/${session}/chat_history.jsonl`);
    const row = { type: 'user', content: [{ type: 'text', text: '<command-name>review</command-name>' }] };
    expect(parse(row, 1)[0]).toMatchObject({ slug: 'review', session, kind: 'command' });
    expect(
      parse({ ...row, content: '<background_context><command-name>review</command-name></background_context>' }, 2),
    ).toEqual([]);
    expect(
      parse(
        { type: 'assistant', tool_calls: [{ name: 'read_file', arguments: '{"path":"/skills/plan/SKILL.md"}' }] },
        3,
      )[0].slug,
    ).toBe('plan');
  });
});

describe('historical MCP backfill', () => {
  it('requires a successful skill-manager payload and preserves correlation IDs', () => {
    const data = {
      type: 'tool',
      callID: 'load1',
      tool: 'sm_get_skill',
      state: {
        status: 'completed',
        input: { slug: 'review' },
        output: content,
        time: { start: when },
      },
    };
    const row = { id: 'part1', session_id: 's1', data };
    expect(parseOpenCodePart(row)[0].kind).toBe('mcp');
    expect(
      parseOpenCodePart({
        ...row,
        data: {
          ...data,
          state: {
            ...data.state,
            output: JSON.stringify({ ...JSON.parse(content), usage_event_id: 'mcp:correlated' }),
          },
        },
      })[0].id,
    ).toBe('mcp:correlated');
    expect(
      parseOpenCodePart({
        ...row,
        data: { ...data, state: { ...data.state, input: { slug: 'review', include_content: false } } },
      }),
    ).toEqual([]);
    expect(
      parseOpenCodePart({
        ...row,
        data: { ...data, state: { ...data.state, output: '{"slug":"review","content":"unrelated"}' } },
      }),
    ).toEqual([]);
  });

  it('pairs Claude MCP requests/results and rejects failures', () => {
    const parse = createTraceParser('claude-code', '/s1.jsonl');
    parse(
      {
        timestamp: time,
        message: {
          content: [{ type: 'tool_use', id: 'call1', name: 'mcp__sm__get_skill', input: { slug: 'review' } }],
        },
      },
      1,
    );
    expect(
      parse({ message: { content: [{ type: 'tool_result', tool_use_id: 'call1', is_error: true, content }] } }, 2),
    ).toEqual([]);
    expect(
      parse(
        {
          message: {
            content: [{ type: 'tool_result', tool_use_id: 'call1', content: [{ type: 'text', text: content }] }],
          },
        },
        3,
      )[0].slug,
    ).toBe('review');
  });

  it('pairs Codex MCP function calls and content-bearing outputs', () => {
    const parse = createTraceParser('codex', '/s1.jsonl');
    parse(
      {
        type: 'response_item',
        timestamp: time,
        payload: {
          type: 'function_call',
          call_id: 'call1',
          name: 'mcp__sm__get_skill',
          arguments: '{"slug":"review"}',
        },
      },
      1,
    );
    expect(
      parse(
        {
          type: 'response_item',
          payload: {
            type: 'function_call_output',
            call_id: 'call1',
            output: JSON.stringify({ content: [{ type: 'text', text: content }] }),
          },
        },
        2,
      )[0].kind,
    ).toBe('mcp');
  });
});
