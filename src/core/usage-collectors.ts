import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { createRequire } from 'node:module';
import type { DatabaseSync as Database } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import fs from 'fs-extra';
import fg from 'fast-glob';
import { createTraceParser, parseOpenCodePart, type AgentSource } from './usage-parsers.js';
import { insertUsageEvent, type UsageEvent } from './usage-store.js';
import { resolveProjectRoot } from '../fs/paths.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

export interface CollectorStatus {
  source: string;
  status: 'available' | 'unavailable' | 'error';
  scannedAt: string;
  error?: string;
}

export async function collectAgentUsage(db: Database): Promise<CollectorStatus[]> {
  const home = process.env.SM_TEST_HOME ?? os.homedir();
  // Test homes never accidentally scan the real user's runtime directories.
  const claude = process.env.SM_TEST_HOME
    ? path.join(home, '.claude')
    : (process.env.CLAUDE_CONFIG_DIR ?? path.join(home, '.claude'));
  const codex = process.env.SM_TEST_HOME
    ? path.join(home, '.codex')
    : (process.env.CODEX_HOME ?? path.join(home, '.codex'));
  const dataHome = process.env.SM_TEST_HOME
    ? path.join(home, '.local/share')
    : (process.env.XDG_DATA_HOME ?? path.join(home, '.local/share'));
  const openCodeRoot = path.join(dataHome, 'opencode');
  const openCodeDb =
    !process.env.SM_TEST_HOME && process.env.OPENCODE_DB
      ? path.isAbsolute(process.env.OPENCODE_DB)
        ? process.env.OPENCODE_DB
        : path.join(openCodeRoot, process.env.OPENCODE_DB)
      : path.join(openCodeRoot, 'opencode.db');

  const statuses: CollectorStatus[] = [];
  const run = async (source: AgentSource, action: () => Promise<boolean>) => {
    const scannedAt = new Date().toISOString();
    let status: CollectorStatus;
    try {
      status = { source, status: (await action()) ? 'available' : 'unavailable', scannedAt };
    } catch (error) {
      status = { source, status: 'error', scannedAt, error: error instanceof Error ? error.message : String(error) };
    }
    db.prepare('INSERT OR REPLACE INTO usage_collectors VALUES (?, ?, ?, ?)').run(
      source,
      status.status,
      scannedAt,
      status.error ?? null,
    );
    statuses.push(status);
  };

  const jsonl = async (source: AgentSource, root: string, patterns: string[]) => {
    if (!(await fs.pathExists(root))) return false;
    const files = await fg(patterns, { cwd: root, absolute: true, onlyFiles: true, followSymbolicLinks: false });
    const problems: string[] = [];
    for (const file of files) {
      const stat = await fs.stat(file);
      const fingerprint = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
      const previous = db
        .prepare('SELECT fingerprint FROM usage_files WHERE source = ? AND path = ?')
        .get(source, file) as { fingerprint: string } | undefined;
      if (previous?.fingerprint === fingerprint) continue;
      const parse = createTraceParser(source, file);
      const events: UsageEvent[] = [];
      const input = createReadStream(file, { encoding: 'utf8' });
      const lines = createInterface({ input, crlfDelay: Infinity });
      let index = 0;
      let malformed = 0;
      try {
        for await (const line of lines) {
          index++;
          if (!line.trim()) continue;
          let row: unknown;
          try {
            row = JSON.parse(line);
          } catch {
            malformed++;
            continue;
          }
          if (row && typeof row === 'object') events.push(...parse(row as Record<string, unknown>, index));
        }
      } finally {
        lines.close();
        input.destroy();
      }
      // Parse a changed file again in full: stable invocation IDs make this idempotent,
      // preserve header context and recover partial tails/rotated trace files.
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const event of events) {
          if (event.project) event.project = resolveProjectRoot(event.project);
          insertUsageEvent(db, event);
        }
        if (!malformed)
          db.prepare('INSERT OR REPLACE INTO usage_files VALUES (?, ?, ?)').run(source, file, fingerprint);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      // Surface damage, but keep valid records and retry an unfinished tail next time.
      if (malformed) problems.push(`${file}: ${malformed} malformed or unfinished JSONL record(s)`);
    }
    if (problems.length) throw new Error(problems.join('; '));
    return files.length > 0;
  };

  await run('claude-code', () => jsonl('claude-code', claude, ['history.jsonl', 'projects/**/*.jsonl']));
  await run('codex', () => jsonl('codex', codex, ['sessions/**/*.jsonl', 'archived_sessions/**/*.jsonl']));
  await run('droid', () => jsonl('droid', path.join(home, '.factory/sessions'), ['**/*.jsonl']));
  await run('grok', () =>
    jsonl('grok', path.join(home, '.grok/sessions'), ['**/updates.jsonl', '**/chat_history.jsonl']),
  );
  await run('opencode', async () => {
    if (openCodeDb.endsWith(':memory:') || !(await fs.pathExists(openCodeDb))) return false;
    const fingerprint = async () => {
      const stats = await Promise.all([fs.stat(openCodeDb), fs.stat(`${openCodeDb}-wal`).catch(() => undefined)]);
      return stats.map((stat) => (stat ? `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}` : 'none')).join('|');
    };
    const before = await fingerprint();
    const previous = db
      .prepare('SELECT fingerprint FROM usage_files WHERE source = ? AND path = ?')
      .get('opencode', openCodeDb) as { fingerprint: string } | undefined;
    const input = new DatabaseSync(openCodeDb, { readOnly: true });
    try {
      input.exec('PRAGMA busy_timeout = 1000');
      const columns = input.prepare('PRAGMA table_info(part)').all();
      const incremental = columns.some((column) => column.name === 'time_updated');
      const cursorKey = `opencode:${openCodeDb}`;
      const stored = db.prepare('SELECT value FROM usage_settings WHERE key = ?').get(cursorKey) as
        { value: string } | undefined;
      const cursor = stored
        ? (JSON.parse(stored.value) as { identity: string; watermark: number; fullScanAt: number })
        : undefined;
      const stat = await fs.stat(openCodeDb);
      const identity = `${stat.dev}:${stat.ino}`;
      const upper = incremental
        ? Number(input.prepare('SELECT COALESCE(MAX(time_updated), 0) AS value FROM part').get()?.value)
        : 0;
      const fullScan =
        !cursor ||
        cursor.identity !== identity ||
        upper < cursor.watermark ||
        Date.now() - cursor.fullScanAt >= 86_400_000;
      if (previous?.fingerprint === before && !fullScan) return true;
      const lower = fullScan ? 0 : Math.max(0, cursor.watermark - 1000);
      const rows = input
        .prepare(
          `SELECT p.id, p.session_id, p.data, s.directory FROM part p
         JOIN session s ON s.id = p.session_id
         WHERE ${incremental ? 'p.time_updated >= ? AND p.time_updated <= ? AND' : ''}
          CASE WHEN json_valid(p.data) THEN json_extract(p.data, '$.type') = 'tool' AND
          (json_extract(p.data, '$.tool') = 'skill' OR json_extract(p.data, '$.tool') LIKE '%get_skill') ELSE 0 END`,
        )
        .all(...(incremental ? [lower, upper] : []));
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const row of rows) {
          for (const event of parseOpenCodePart(row)) {
            if (event.project) event.project = resolveProjectRoot(event.project);
            insertUsageEvent(db, event);
          }
        }
        if (incremental)
          db.prepare('INSERT OR REPLACE INTO usage_settings VALUES (?, ?)').run(
            cursorKey,
            JSON.stringify({
              identity,
              watermark: upper,
              fullScanAt: fullScan ? Date.now() : cursor!.fullScanAt,
            }),
          );
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    } finally {
      input.close();
    }
    // A write during the read is revisited on the next refresh, rather than skipped.
    if ((await fingerprint()) === before)
      db.prepare('INSERT OR REPLACE INTO usage_files VALUES (?, ?, ?)').run('opencode', openCodeDb, before);
    return true;
  });

  // Claude's slash-command log is a fallback when the same skill/session has no
  // authoritative Skill-tool observation. It is not an additional invocation.
  db.exec(`DELETE FROM usage_events AS command WHERE command.source = 'claude-code' AND command.kind = 'command'
    AND EXISTS (SELECT 1 FROM usage_events AS tool WHERE tool.source = command.source
      AND tool.session = command.session AND tool.slug = command.slug AND tool.kind = 'native');`);
  db.exec(`DELETE FROM usage_events AS fallback WHERE fallback.source = 'grok' AND fallback.id LIKE 'grok-fallback:%'
    AND EXISTS (SELECT 1 FROM usage_events AS trace WHERE trace.source = fallback.source
      AND trace.session = fallback.session AND trace.slug = fallback.slug AND trace.id NOT LIKE 'grok-fallback:%');`);
  return statuses;
}
