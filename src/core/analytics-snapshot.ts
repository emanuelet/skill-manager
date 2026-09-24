import Keyv from 'keyv';
import { KeyvFile } from 'keyv-file';
import { SM_ANALYTICS_CACHE } from '../fs/paths.js';
import { getUsageStats, findStaleSkills, findUnusedSkills, type UsageStat, type SkillMetaEntry } from './analytics.js';
import { readMeta } from './meta.js';
import { listSlugs } from './skill.js';
import { refreshUsage, usageBySlug, usageDetail, type UsageDetail } from './usage.js';
import { getLinkRecords } from './state.js';
import { resolveProjectRoot } from '../fs/paths.js';
import { recommendScopes, type ScopeRecommendation } from './scope-recommendations.js';

const CACHE_TTL_MS = 2 * 60 * 1_000;

export interface AnalyticsSnapshot {
  totalSkills: number;
  stats: UsageStat[];
  stale: string[];
  unused: string[];
  usageSource: 'skilled' | 'meta';
}

const cache = new Keyv<unknown>({
  store: new KeyvFile({ filename: SM_ANALYTICS_CACHE, writeDelay: 0 }),
});

export async function getAnalyticsSnapshot(staleDays = 30, unusedDays = 30): Promise<AnalyticsSnapshot> {
  const key = `v2:${staleDays}:${unusedDays}`;
  let cached: AnalyticsSnapshot | undefined;
  try {
    cached = (await cache.get(key)) as AnalyticsSnapshot | undefined;
  } catch {
    // Cache contention must not prevent fresh analytics.
  }
  if (cached) return cached;

  const refresh = await refreshUsage();
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
    usageSource: refresh.source,
  };
  try {
    await cache.set(key, snapshot, CACHE_TTL_MS);
  } catch {
    // The cache is optional; another MCP request may hold its file lock.
  }
  return snapshot;
}

const DETAIL_CACHE_PREFIX = 'usage-detail:';

async function cachedUsageDetail(slug: string, project?: string): Promise<UsageDetail> {
  const key = `${DETAIL_CACHE_PREFIX}${slug}:${project ?? '*'}`;
  let cached: UsageDetail | undefined;
  try {
    cached = (await cache.get(key)) as UsageDetail | undefined;
  } catch {
    // Fall through to skilled when the file cache is busy.
  }
  if (cached) return cached;
  const detail = await usageDetail(slug, project);
  try {
    await cache.set(key, detail, CACHE_TTL_MS);
  } catch {
    // Returning fresh data is more important than caching it.
  }
  return detail;
}

export interface ScopeRecommendationResult {
  available: boolean;
  recommendations: ScopeRecommendation[];
}

/** Fetch only aggregate candidates' skilled details and recommend their deployment scope. */
export async function getScopeRecommendations(projectRoot = process.cwd()): Promise<ScopeRecommendationResult> {
  const snapshot = await getAnalyticsSnapshot();
  if (snapshot.usageSource !== 'skilled') return { available: false, recommendations: [] };

  const usage = await usageBySlug();
  const projectName = resolveProjectRoot(projectRoot).split('/').filter(Boolean).pop() ?? projectRoot;
  const now = Date.now();
  const projectCutoff = now - 7 * 24 * 60 * 60 * 1000;
  const globalCutoff = now - 14 * 24 * 60 * 60 * 1000;
  const projectDetails = new Map<string, UsageDetail>();
  const globalProjectDetails = new Map<string, UsageDetail[]>();

  try {
    for (const [slug, record] of usage) {
      if (record.useCount >= 3 && record.lastUsed && new Date(record.lastUsed).getTime() >= projectCutoff) {
        projectDetails.set(slug, await cachedUsageDetail(slug, projectName));
      }
      if (record.projects >= 3 && record.lastUsed && new Date(record.lastUsed).getTime() >= globalCutoff) {
        const detail = await cachedUsageDetail(slug);
        // KeyvFile writes are not concurrency-safe. Cache project details in sequence.
        const details: UsageDetail[] = [];
        for (const project of detail.projects) details.push(await cachedUsageDetail(slug, project.name));
        globalProjectDetails.set(slug, details);
      }
    }
  } catch {
    return { available: false, recommendations: [] };
  }

  const globalDeployments = new Set<string>();
  const projectDeployments = new Set<string>();
  for (const [slug] of usage) {
    if ((await getLinkRecords(slug, { scope: 'user' })).length > 0) globalDeployments.add(slug);
    if ((await getLinkRecords(slug, { scope: 'project', projectRoot: resolveProjectRoot(projectRoot) })).length > 0)
      projectDeployments.add(slug);
  }

  return {
    available: true,
    recommendations: recommendScopes({
      usage,
      globalDeployments,
      projectDeployments,
      projectDetails,
      globalProjectDetails,
    }),
  };
}
