import { getUsageStats, findStaleSkills, findUnusedSkills, type UsageStat, type SkillMetaEntry } from './analytics.js';
import { readMeta } from './meta.js';
import { listSlugs } from './skill.js';
import { refreshUsage, usageBySlug, usageDetail, type UsageDetail } from './usage.js';
import { getLinkRecords } from './state.js';
import { resolveProjectRoot } from '../fs/paths.js';
import { recommendScopes, type ScopeRecommendation } from './scope-recommendations.js';
import { getSearchUsage, getUsageSources } from './usage-store.js';
import type { CollectorStatus } from './usage-collectors.js';

export interface AnalyticsSnapshot {
  totalSkills: number;
  stats: UsageStat[];
  stale: string[];
  unused: string[];
  usageSource: 'native' | 'meta';
  collectors: CollectorStatus[];
  searches: Awaited<ReturnType<typeof getSearchUsage>>;
  sources: Awaited<ReturnType<typeof getUsageSources>>;
}

export async function getAnalyticsSnapshot(staleDays = 30, unusedDays = 30): Promise<AnalyticsSnapshot> {
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
    collectors: refresh.collectors,
    searches: await getSearchUsage(),
    sources: await getUsageSources(),
  };
  return snapshot;
}

export interface ScopeRecommendationResult {
  available: boolean;
  recommendations: ScopeRecommendation[];
}

/** Query local invocation details and recommend their deployment scope. */
export async function getScopeRecommendations(projectRoot = process.cwd()): Promise<ScopeRecommendationResult> {
  const snapshot = await getAnalyticsSnapshot();
  if (snapshot.usageSource !== 'native') return { available: false, recommendations: [] };

  const usage = await usageBySlug();
  const projectName = resolveProjectRoot(projectRoot);
  const now = Date.now();
  const projectCutoff = now - 7 * 24 * 60 * 60 * 1000;
  const globalCutoff = now - 14 * 24 * 60 * 60 * 1000;
  const projectDetails = new Map<string, UsageDetail>();
  const globalProjectDetails = new Map<string, UsageDetail[]>();

  try {
    for (const [slug, record] of usage) {
      if (record.useCount >= 3 && record.lastUsed && new Date(record.lastUsed).getTime() >= projectCutoff) {
        projectDetails.set(slug, await usageDetail(slug, projectName));
      }
      if (record.projects >= 3 && record.lastUsed && new Date(record.lastUsed).getTime() >= globalCutoff) {
        const detail = await usageDetail(slug);
        const details: UsageDetail[] = [];
        for (const project of detail.projects) details.push(await usageDetail(slug, project.name));
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
