import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import type { DatabaseSync as Database } from 'node:sqlite';
import fs from 'fs-extra';
import { SM_HOME, SM_SEARCH_DB } from '../fs/paths.js';
import { listSkills } from './skill.js';

const execFileAsync = promisify(execFile);
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

export interface UsageRecord { slug: string; useCount: number; sessions: number; projects: number; lastUsed?: string }

async function openUsageDb(): Promise<Database> {
  await fs.ensureDir(SM_HOME);
  const db = new DatabaseSync(SM_SEARCH_DB);
  db.exec('CREATE TABLE IF NOT EXISTS skill_usage (slug TEXT PRIMARY KEY, use_count INTEGER NOT NULL DEFAULT 0, sessions INTEGER NOT NULL DEFAULT 0, projects INTEGER NOT NULL DEFAULT 0, last_used TEXT, synced_at TEXT NOT NULL)');
  return db;
}

export async function refreshUsage(): Promise<{ source: 'skilled' | 'meta'; records: number }> {
  let source: 'skilled' | 'meta' = 'skilled';
  let records: UsageRecord[];
  try {
    const { stdout } = await execFileAsync('skilled', ['list', '--no-index', '--json'], { maxBuffer: 5 * 1024 * 1024, timeout: 1_000 });
    const parsed: unknown = JSON.parse(stdout);
    if (!Array.isArray(parsed)) throw new Error('Expected JSON array');
    records = parsed.map((value) => {
      const row = value as Record<string, unknown>;
      const slug = row.name ?? row.skill;
      if (typeof slug !== 'string') throw new Error('Missing skill name');
      return { slug, useCount: Number(row.count ?? 0), sessions: Number(row.sessions ?? 0), projects: Number(row.projects ?? 0), lastUsed: typeof row.lastUsed === 'string' ? row.lastUsed : undefined };
    });
  } catch {
    source = 'meta';
    records = (await listSkills()).map((skill) => ({ slug: skill.slug, useCount: skill.meta.usageCount ?? 0, sessions: 0, projects: 0, lastUsed: skill.meta.lastUsed }));
  }
  const db = await openUsageDb();
  try {
    const insert = db.prepare('INSERT OR REPLACE INTO skill_usage VALUES (?, ?, ?, ?, ?, ?)');
    const now = new Date().toISOString();
    for (const record of records) insert.run(record.slug, record.useCount, record.sessions, record.projects, record.lastUsed ?? null, now);
  } finally { db.close(); }
  return { source, records: records.length };
}

export async function usageBySlug(): Promise<Map<string, UsageRecord>> {
  const db = await openUsageDb();
  try {
    const rows = db.prepare('SELECT slug, use_count, sessions, projects, last_used FROM skill_usage').all() as Array<Record<string, unknown>>;
    return new Map(rows.map((row) => [String(row.slug), { slug: String(row.slug), useCount: Number(row.use_count), sessions: Number(row.sessions), projects: Number(row.projects), lastUsed: typeof row.last_used === 'string' ? row.last_used : undefined }]));
  } finally { db.close(); }
}
