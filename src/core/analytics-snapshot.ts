import Keyv from 'keyv';
import { KeyvFile } from 'keyv-file';
import { SM_ANALYTICS_CACHE } from '../fs/paths.js';
import { getUsageStats, findStaleSkills, findUnusedSkills, type UsageStat, type SkillMetaEntry } from './analytics.js';
import { readMeta } from './meta.js';
import { listSlugs } from './skill.js';
import { refreshUsage, usageBySlug } from './usage.js';

const CACHE_TTL_MS = 2 * 60 * 1_000;

export interface AnalyticsSnapshot {
  totalSkills: number;
  stats: UsageStat[];
  stale: string[];
  unused: string[];
}

const cache = new Keyv<AnalyticsSnapshot>({
  store: new KeyvFile({ filename: SM_ANALYTICS_CACHE, writeDelay: 0 }),
});

export async function getAnalyticsSnapshot(staleDays = 30, unusedDays = 30): Promise<AnalyticsSnapshot> {
  const key = `${staleDays}:${unusedDays}`;
  const cached = await cache.get(key);
  if (cached) return cached;

  await refreshUsage();
  const usage = await usageBySlug();
  const slugs = await listSlugs();
  const metas: SkillMetaEntry[] = [];

  for (const slug of slugs) {
    try {
      metas.push({ slug, meta: await readMeta(slug) });
    } catch {
      // Skip skills with unreadable meta.
    }
  }

  const snapshot = {
    totalSkills: slugs.length,
    stats: getUsageStats(metas, usage),
    stale: findStaleSkills(metas, staleDays),
    unused: findUnusedSkills(metas, unusedDays, usage),
  };
  await cache.set(key, snapshot, CACHE_TTL_MS);
  return snapshot;
}
