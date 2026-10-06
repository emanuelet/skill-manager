// Extraction predicates researched from av/skilled (MIT), revision
// 736dcccb46697d3e261ec83ca340168efc575d7c. See docs/usage-tracking.md.
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { UsageEvent } from './usage-store.js';

// Trace formats are heterogeneous; extraction validates names, timestamps and payloads.
// oxlint-disable-next-line typescript/no-explicit-any
type Row = Record<string, any>;
export type AgentSource = 'claude-code' | 'codex' | 'opencode' | 'grok' | 'droid';
const CLAUDE_COMMANDS = new Set([
  'clear',
  'model',
  'usage',
  'resume',
  'new',
  'quit',
  'exit',
  'login',
  'logout',
  'help',
  'config',
  'compact',
  'doctor',
  'cost',
  'effort',
  'memory',
  'status',
  'skills',
  'permissions',
  'mcp',
  'terminal-setup',
  'remote-env',
  'remote-control',
  'fast',
]);
const GROK_COMMANDS = new Set([
  'compact',
  'always-approve',
  'context',
  'plugins',
  'reload-plugins',
  'session-info',
  'imagine',
  'imagine-video',
  'feedback',
  'loop',
  'help',
  'memory',
  'clear',
  'exit',
]);

export function timestamp(value: unknown, seconds = false): number | undefined {
  const result =
    typeof value === 'number' ? value * (seconds ? 1000 : 1) : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(new Date(result).getTime()) && result > 0 ? result : undefined;
}

export function eventId(source: string, session: string, identity: string): string {
  return createHash('sha256')
    .update(JSON.stringify([source, session, identity]))
    .digest('hex');
}

/** Parser state belongs to one trace file, never another session. No transcript text is retained. */
export function createTraceParser(source: AgentSource, file: string) {
  let session = path.basename(file, '.jsonl');
  let project: string | undefined;
  const pending = new Map<string, { slug: string; time: number }>();
  const occurrences = new Map<string, number>();
  let hasSessionMetadata = false;
  if (source === 'grok') {
    session = path.basename(path.dirname(file));
    try {
      project = decodeURIComponent(path.basename(path.dirname(path.dirname(file))));
    } catch {
      /* malformed directory */
    }
  }
  return (row: Row, _line: number): UsageEvent[] => {
    if (!row || typeof row !== 'object') return [];
    const events: UsageEvent[] = [];
    let fallbackIdentity: string | undefined;
    const add = (
      slug: unknown,
      time: unknown,
      identity?: string,
      kind: UsageEvent['kind'] = 'native',
      seconds = false,
      usageId?: string,
    ) => {
      const when = timestamp(time, seconds);
      if (typeof slug !== 'string' || !slug || !when) return;
      if (kind === 'command' && (source === 'claude-code' ? CLAUDE_COMMANDS : GROK_COMMANDS).has(slug)) return;
      if (!identity && !usageId && fallbackIdentity === undefined) {
        const rowKey = eventId(source, session, JSON.stringify(row));
        const occurrence = occurrences.get(rowKey) ?? 0;
        occurrences.set(rowKey, occurrence + 1);
        fallbackIdentity = `${rowKey}:${occurrence}`;
      }
      events.push({
        id: usageId ?? eventId(source, session, identity ?? `${fallbackIdentity}:${events.length}`),
        slug,
        source,
        kind,
        timestamp: when,
        session,
        project,
      });
    };
    if (source === 'claude-code') {
      if (typeof row.sessionId === 'string') session = row.sessionId;
      if (typeof row.cwd === 'string') project = row.cwd;
      else if (typeof row.project === 'string') project = row.project;
      if (typeof row.display === 'string') {
        const match = /^\/([a-zA-Z][a-zA-Z0-9_:-]*)(?:\s|$)/.exec(row.display);
        if (match) add(match[1], row.timestamp, `command:${match[1]}:${row.timestamp}`, 'command');
      }
      for (const part of Array.isArray(row.message?.content) ? row.message.content : []) {
        if (!part || typeof part !== 'object') continue;
        if (part.type === 'tool_use' && part.name === 'Skill') add(part.input?.skill, row.timestamp, part.id);
        if (
          part.type === 'tool_use' &&
          String(part.name).endsWith('get_skill') &&
          part.input?.include_content !== false
        ) {
          const time = timestamp(row.timestamp);
          if (typeof part.input?.slug === 'string' && time) pending.set(part.id, { slug: part.input.slug, time });
        }
        if (part.type === 'tool_result' && !part.is_error) {
          const request = pending.get(part.tool_use_id);
          const payload = request && skillPayload(part.content, request.slug);
          if (request && payload)
            add(request.slug, request.time, part.tool_use_id, 'mcp', false, payloadUsageId(payload));
        }
      }
    } else if (source === 'codex') {
      if (row.type === 'session_meta' && !hasSessionMetadata) {
        hasSessionMetadata = true;
        if (typeof row.payload?.id === 'string') session = row.payload.id;
        if (typeof row.payload?.cwd === 'string') project = row.payload.cwd;
      }
      if (row.type === 'response_item') {
        const payload = row.payload;
        if (payload?.type === 'function_call' && String(payload.name).endsWith('get_skill')) {
          try {
            const args = JSON.parse(payload.arguments);
            const time = timestamp(row.timestamp);
            if (typeof args.slug === 'string' && args.include_content !== false && time)
              pending.set(payload.call_id, { slug: args.slug, time });
          } catch {
            /* malformed tool arguments */
          }
        }
        if (payload?.type === 'function_call_output') {
          const request = pending.get(payload.call_id);
          const result = request && skillPayload(payload.output, request.slug);
          if (request && result) add(request.slug, request.time, payload.call_id, 'mcp', false, payloadUsageId(result));
        }
        for (const part of Array.isArray(row.payload?.content) ? row.payload.content : []) {
          if (!part || typeof part !== 'object') continue;
          if (part.type !== 'input_text' || typeof part.text !== 'string') continue;
          for (const block of part.text.matchAll(/<skill>([\s\S]*?)<\/skill>/g)) {
            const name = /<name>([^<]+)<\/name>/.exec(block[1]);
            if (name) add(name[1], row.timestamp);
          }
        }
      }
    } else if (source === 'droid') {
      if (row.type === 'session_start') {
        if (typeof row.id === 'string') session = row.id;
        if (typeof row.cwd === 'string') project = row.cwd;
      }
      for (const part of Array.isArray(row.message?.content) ? row.message.content : []) {
        if (!part || typeof part !== 'object') continue;
        if (part.type !== 'tool_result' || typeof part.content !== 'string') continue;
        const match = /Skill "([^"]+)" is now active/.exec(part.content);
        if (match) add(match[1], row.timestamp, part.tool_use_id);
      }
    } else if (source === 'grok') {
      const update = row.params?.update;
      if (typeof row.params?.sessionId === 'string') session = row.params.sessionId;
      if (update?.sessionUpdate === 'user_message_chunk' && typeof update.content?.text === 'string') {
        for (const match of update.content.text.matchAll(/<command-name>\/?([^<]+)<\/command-name>/g))
          add(match[1], row.timestamp, undefined, 'command', true);
      }
      const tool = update?._meta?.['x.ai/tool']?.name ?? update?.title;
      if (update?.sessionUpdate === 'tool_call' && tool === 'read_file') {
        const target =
          update.rawInput?.target_file ?? update.rawInput?.path ?? update._meta?.['x.ai/tool']?.input?.path;
        const match =
          typeof target === 'string' ? /(?:^|\/)skills\/([^/]+)\/SKILL\.md$/i.exec(target.replace(/\\/g, '/')) : null;
        if (match) add(match[1], row.timestamp, update.toolCallId, 'playbook', true);
      }
      // chat_history mirrors updates: shared call IDs collapse both observations.
      for (const call of Array.isArray(row.tool_calls) ? row.tool_calls : []) {
        if (!call || typeof call !== 'object') continue;
        if (call.name !== 'read_file') continue;
        try {
          const args = typeof call.arguments === 'string' ? JSON.parse(call.arguments) : call.arguments;
          const target = args?.target_file ?? args?.path;
          const match =
            typeof target === 'string' ? /(?:^|\/)skills\/([^/]+)\/SKILL\.md$/i.exec(target.replace(/\\/g, '/')) : null;
          const time = timestamp(row.timestamp, typeof row.timestamp === 'number') ?? grokSessionTime(session);
          if (match && time)
            add(
              match[1],
              time,
              call.id,
              'playbook',
              false,
              call.id ? undefined : `grok-fallback:${eventId(source, session, match[1])}`,
            );
        } catch {
          /* malformed tool arguments */
        }
      }
      if (row.type === 'user') {
        const text =
          typeof row.content === 'string'
            ? row.content
            : Array.isArray(row.content)
              ? row.content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('')
              : typeof row.message?.content === 'string'
                ? row.message.content
                : '';
        if (!text.includes('<background_context>')) {
          for (const match of text.matchAll(/<command-name>\/?([^<]+)<\/command-name>/g)) {
            const time = timestamp(row.timestamp, typeof row.timestamp === 'number') ?? grokSessionTime(session);
            if (time)
              add(match[1], time, undefined, 'command', false, `grok-fallback:${eventId(source, session, match[1])}`);
          }
        }
      }
    }
    // Require a successful skill-manager-shaped payload, not just a shared tool name.
    const mcp = historicalMcp(row);
    if (mcp) add(mcp.slug, mcp.timestamp, mcp.id, 'mcp', false, mcp.usageId);
    return events;
  };
}

function historicalMcp(row: Row): { slug: string; timestamp: number; id?: string; usageId?: string } | undefined {
  if (
    row.type !== 'tool' ||
    row.state?.status !== 'completed' ||
    !String(row.tool).endsWith('get_skill') ||
    row.state.input?.include_content === false
  )
    return;
  try {
    const result = skillPayload(row.state.output, row.state.input?.slug);
    if (!result) return;
    const when = timestamp(row.state.time?.start);
    if (when) return { slug: result.slug, timestamp: when, id: row.callID, usageId: payloadUsageId(result) };
  } catch {
    /* non-skill-manager output */
  }
}

function payloadUsageId(payload: Row): string | undefined {
  return typeof payload.usage_event_id === 'string' && payload.usage_event_id.startsWith('mcp:')
    ? payload.usage_event_id
    : undefined;
}

function grokSessionTime(session: string): number | undefined {
  if (!/^[\da-f]{8}-[\da-f]{4}-7[\da-f]{3}-[\da-f]{4}-[\da-f]{12}$/i.test(session)) return;
  return timestamp(Number.parseInt(session.replace(/-/g, '').slice(0, 12), 16));
}

function skillPayload(value: unknown, slug: string, depth = 0): Row | undefined {
  if (depth > 3) return;
  try {
    const result: Row = typeof value === 'string' ? JSON.parse(value) : (value as Row);
    if (!result || result.isError) return;
    if (
      result.slug === slug &&
      typeof result.content === 'string' &&
      result.meta?.source &&
      Array.isArray(result.files)
    )
      return result;
    for (const part of Array.isArray(result) ? result : Array.isArray(result.content) ? result.content : []) {
      if (part?.type === 'text') {
        const parsed = skillPayload(part.text, slug, depth + 1);
        if (parsed) return parsed;
      }
    }
  } catch {
    /* another server's payload */
  }
}

export function parseOpenCodePart(row: Row): UsageEvent[] {
  const data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
  if (!data || data.type !== 'tool' || data.state?.status !== 'completed') return [];
  const when = timestamp(data.state.time?.start);
  if (!when) return [];
  if (data.tool === 'skill' && typeof data.state.input?.name === 'string') {
    return [
      {
        id: eventId('opencode', row.session_id, data.callID ?? row.id),
        slug: data.state.input.name,
        source: 'opencode',
        kind: 'native',
        timestamp: when,
        session: row.session_id,
        project: row.directory,
      },
    ];
  }
  const mcp = historicalMcp(data);
  if (mcp)
    return [
      {
        id: mcp.usageId ?? eventId('opencode', row.session_id, mcp.id ?? row.id),
        slug: mcp.slug,
        source: 'opencode',
        kind: 'mcp',
        timestamp: when,
        session: row.session_id,
        project: row.directory,
      },
    ];
  return [];
}
