import { openUsageDb } from './usage-store.js';
import { collectAgentUsage, type CollectorStatus } from './usage-collectors.js';

export interface UsageRecord {
  slug: string;
  useCount: number;
  sessions: number;
  projects: number;
  lastUsed?: string;
}

export interface UsageDetail {
  skill: string;
  count: number;
  sessions: number;
  firstUsed?: string;
  lastUsed?: string;
  projects: Array<{ name: string; count: number }>;
}

export async function refreshUsage(): Promise<{
  source: 'native' | 'meta';
  records: number;
  collectors: CollectorStatus[];
}> {
  const db = await openUsageDb();
  try {
    const collectors = await collectAgentUsage(db);
    const { records } = db.prepare('SELECT COUNT(*) AS records FROM valid_usage_events').get() as { records: number };
    // A missing/corrupt provider never deletes previous native or MCP evidence.
    return {
      source: records || collectors.some((status) => status.status === 'available') ? 'native' : 'meta',
      records,
      collectors,
    };
  } finally {
    db.close();
  }
}

export async function usageBySlug(): Promise<Map<string, UsageRecord>> {
  const db = await openUsageDb();
  try {
    const legacy = db.prepare('SELECT slug, use_count, sessions, projects, last_used FROM skill_usage').all();
    const result = new Map(
      legacy.map((row) => [
        String(row.slug),
        {
          slug: String(row.slug),
          useCount: Number(row.use_count),
          sessions: Number(row.sessions),
          projects: Number(row.projects),
          lastUsed: typeof row.last_used === 'string' ? row.last_used : undefined,
        },
      ]),
    );
    const rows = db
      .prepare(
        `SELECT slug, COUNT(*) AS uses, COUNT(DISTINCT source || ':' || session) AS sessions,
      COUNT(DISTINCT project) AS projects, MAX(timestamp) AS last_used FROM valid_usage_events GROUP BY slug`,
      )
      .all();
    for (const row of rows)
      result.set(String(row.slug), {
        slug: String(row.slug),
        useCount: Number(row.uses),
        sessions: Number(row.sessions),
        projects: Number(row.projects),
        lastUsed: new Date(Number(row.last_used)).toISOString(),
      });
    return result;
  } finally {
    db.close();
  }
}

/** Local indexed detail: full canonical project paths, never ambiguous basenames. */
export async function usageDetail(slug: string, project?: string): Promise<UsageDetail> {
  const db = await openUsageDb();
  try {
    const filter = project ? 'slug = ? AND project = ?' : 'slug = ?';
    const args = project ? [slug, project] : [slug];
    const row = db
      .prepare(
        `SELECT COUNT(*) AS count, COUNT(DISTINCT source || ':' || session) AS sessions,
      MIN(timestamp) AS first_used, MAX(timestamp) AS last_used FROM valid_usage_events WHERE ${filter}`,
      )
      .get(...args)!;
    const projects = db
      .prepare(
        `SELECT project AS name, COUNT(*) AS count FROM valid_usage_events
      WHERE ${filter} AND project IS NOT NULL GROUP BY project ORDER BY count DESC, project`,
      )
      .all(...args);
    if (!project && Number(row.count) === 0) {
      const legacy = db.prepare('SELECT use_count, sessions, last_used FROM skill_usage WHERE slug = ?').get(slug);
      if (legacy)
        return {
          skill: slug,
          count: Number(legacy.use_count),
          sessions: Number(legacy.sessions),
          lastUsed: typeof legacy.last_used === 'string' ? legacy.last_used : undefined,
          projects: [],
        };
    }
    return {
      skill: slug,
      count: Number(row.count),
      sessions: Number(row.sessions),
      firstUsed: row.first_used ? new Date(Number(row.first_used)).toISOString() : undefined,
      lastUsed: row.last_used ? new Date(Number(row.last_used)).toISOString() : undefined,
      projects: projects.map((value) => ({ name: String(value.name), count: Number(value.count) })),
    };
  } finally {
    db.close();
  }
}
