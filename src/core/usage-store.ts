import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync as Database } from 'node:sqlite';
import fs from 'fs-extra';
import { SM_HOME, SM_SEARCH_DB } from '../fs/paths.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

export interface UsageEvent {
  id: string;
  slug: string;
  source: string;
  kind: 'native' | 'mcp' | 'command' | 'playbook';
  timestamp: number;
  session: string;
  project?: string;
  client?: string;
}

export interface UsageContext {
  sessionId: string;
  requestId?: string;
  invocationId?: string;
  client?: string;
}

export async function openUsageDb(): Promise<Database> {
  await fs.ensureDir(SM_HOME);
  const db = new DatabaseSync(SM_SEARCH_DB);
  db.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS skill_usage (slug TEXT PRIMARY KEY, use_count INTEGER NOT NULL DEFAULT 0, sessions INTEGER NOT NULL DEFAULT 0, projects INTEGER NOT NULL DEFAULT 0, last_used TEXT, synced_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS usage_events (
      id TEXT PRIMARY KEY, slug TEXT NOT NULL, source TEXT NOT NULL, kind TEXT NOT NULL,
      timestamp INTEGER NOT NULL, session TEXT NOT NULL, project TEXT, client TEXT
    );
    CREATE INDEX IF NOT EXISTS usage_slug ON usage_events(slug, timestamp);
    CREATE VIEW IF NOT EXISTS valid_usage_events AS SELECT * FROM usage_events WHERE timestamp BETWEEN 1 AND 8640000000000000;
    CREATE TABLE IF NOT EXISTS usage_files (source TEXT NOT NULL, path TEXT NOT NULL, fingerprint TEXT NOT NULL, PRIMARY KEY(source, path));
    CREATE TABLE IF NOT EXISTS usage_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS usage_collectors (source TEXT PRIMARY KEY, status TEXT NOT NULL, scanned_at TEXT NOT NULL, error TEXT);
    CREATE TABLE IF NOT EXISTS skill_searches (
      id INTEGER PRIMARY KEY AUTOINCREMENT, event_key TEXT UNIQUE, session TEXT NOT NULL,
      client TEXT, query TEXT NOT NULL, results TEXT NOT NULL, timestamp INTEGER NOT NULL,
      selected_slug TEXT, selected_at INTEGER, load_id TEXT
    );
    CREATE INDEX IF NOT EXISTS searches_session ON skill_searches(session, timestamp);
  `);
  return db;
}

export function insertUsageEvent(db: Database, event: UsageEvent): boolean {
  if (!event.slug || !Number.isFinite(new Date(event.timestamp).getTime()) || event.timestamp <= 0) return false;
  const correlated = event.kind === 'mcp' ? mcpSessionFromId(event.id) : undefined;
  const session = correlated ?? event.session;
  const client = event.client ?? (event.kind === 'mcp' && event.source !== 'mcp' ? event.source : undefined);
  const inserted =
    db
      .prepare('INSERT OR IGNORE INTO usage_events VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(
        event.id,
        event.slug,
        correlated ? 'mcp' : event.source,
        event.kind,
        event.timestamp,
        session,
        event.project || null,
        client || null,
      ).changes > 0;
  if (correlated && !inserted && (event.project || client)) {
    db.prepare(
      'UPDATE usage_events SET project = COALESCE(project, ?), client = COALESCE(client, ?) WHERE id = ? AND slug = ?',
    ).run(event.project ?? null, client ?? null, event.id, event.slug);
  }
  if (inserted && event.kind === 'mcp') {
    const search = db
      .prepare(
        `SELECT id FROM skill_searches WHERE session = ? AND timestamp <= ?
      AND EXISTS (SELECT 1 FROM json_each(results) WHERE value = ?) ORDER BY id DESC LIMIT 1`,
      )
      .get(session, event.timestamp, event.slug) as { id: number } | undefined;
    if (search)
      db.prepare(
        'UPDATE skill_searches SET selected_slug = ?, selected_at = ?, load_id = ? WHERE id = ? AND selected_slug IS NULL',
      ).run(event.slug, event.timestamp, event.id, search.id);
  }
  return inserted;
}

export function mcpUsageEventId(context: UsageContext): string {
  return `mcp:${Buffer.from(JSON.stringify([context.sessionId, context.invocationId ?? context.requestId ?? randomUUID()])).toString('base64url')}`;
}

function mcpSessionFromId(id: string): string | undefined {
  if (!id.startsWith('mcp:')) return;
  try {
    const identity: unknown = JSON.parse(Buffer.from(id.slice(4), 'base64url').toString());
    if (Array.isArray(identity) && identity.length === 2 && identity.every((value) => typeof value === 'string'))
      return identity[0];
  } catch {
    /* legacy trace IDs need no live-session reconciliation */
  }
}

export async function recordSkillSearch(query: string, slugs: string[], context: UsageContext): Promise<void> {
  const db = await openUsageDb();
  try {
    db.prepare(
      'INSERT OR IGNORE INTO skill_searches(event_key, session, client, query, results, timestamp) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(
      context.invocationId || context.requestId
        ? `${context.sessionId}:search:${context.invocationId ?? context.requestId}`
        : randomUUID(),
      context.sessionId,
      context.client ?? null,
      query,
      JSON.stringify(slugs),
      Date.now(),
    );
  } finally {
    db.close();
  }
}

export async function recordMcpLoad(
  slug: string,
  context: UsageContext,
  id = mcpUsageEventId(context),
): Promise<string> {
  const db = await openUsageDb();
  try {
    db.exec('BEGIN IMMEDIATE');
    const timestamp = Date.now();
    insertUsageEvent(db, {
      id,
      slug,
      source: 'mcp',
      kind: 'mcp',
      timestamp,
      session: context.sessionId,
      client: context.client,
    });
    db.exec('COMMIT');
    return id;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally {
    db.close();
  }
}

export async function getSearchUsage(limit = 100) {
  const db = await openUsageDb();
  try {
    const totals = db
      .prepare(
        `SELECT COUNT(*) AS searches,
      COALESCE(SUM(json_array_length(results) = 0), 0) AS empty,
      COALESCE(SUM(selected_slug IS NOT NULL), 0) AS selected FROM skill_searches`,
      )
      .get() as { searches: number; empty: number; selected: number };
    const rows = db
      .prepare('SELECT * FROM skill_searches ORDER BY id DESC LIMIT ?')
      .all(Math.min(Math.max(limit, 1), 1000));
    return {
      ...totals,
      unselected: totals.searches - totals.empty - totals.selected,
      selectionRate: totals.searches ? totals.selected / totals.searches : 0,
      recent: rows.map((row) => ({
        id: row.id,
        query: row.query,
        session: row.session,
        client: row.client,
        results: JSON.parse(String(row.results)) as string[],
        timestamp: new Date(Number(row.timestamp)).toISOString(),
        selectedSlug: row.selected_slug ?? undefined,
        selectedAt: row.selected_at ? new Date(Number(row.selected_at)).toISOString() : undefined,
      })),
    };
  } finally {
    db.close();
  }
}

export async function getUsageSources() {
  const db = await openUsageDb();
  try {
    return db
      .prepare(
        `SELECT source, kind, client, COUNT(*) AS calls, COUNT(DISTINCT session) AS sessions,
      COUNT(DISTINCT project) AS projects, MAX(timestamp) AS last_used
      FROM valid_usage_events GROUP BY source, kind, client ORDER BY calls DESC, source`,
      )
      .all()
      .map((row) => ({
        source: String(row.source),
        kind: String(row.kind),
        client: typeof row.client === 'string' ? row.client : undefined,
        calls: Number(row.calls),
        sessions: Number(row.sessions),
        projects: Number(row.projects),
        lastUsed: new Date(Number(row.last_used)).toISOString(),
      }));
  } finally {
    db.close();
  }
}
