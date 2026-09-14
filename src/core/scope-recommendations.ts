import type { UsageDetail, UsageRecord } from './usage.js';

export const SCOPE_RECOMMENDATION_DEFAULTS = {
  projectUses: 3,
  projectDays: 7,
  globalProjects: 3,
  globalDays: 14,
  demotionDays: 30,
} as const;

export interface ScopeRecommendation {
  action: 'promote-project' | 'promote-global' | 'demote-global';
  slug: string;
  reason: string;
}

export interface ScopeRecommendationInput {
  usage: ReadonlyMap<string, UsageRecord>;
  globalDeployments: ReadonlySet<string>;
  projectDeployments: ReadonlySet<string>;
  projectDetails: ReadonlyMap<string, UsageDetail>;
  globalProjectDetails: ReadonlyMap<string, UsageDetail[]>;
  now?: Date;
}

function isSince(value: string | undefined, cutoff: number): boolean {
  return value !== undefined && new Date(value).getTime() >= cutoff;
}

/** Turn skilled's usage data into conservative, opt-in scope recommendations. */
export function recommendScopes(input: ScopeRecommendationInput): ScopeRecommendation[] {
  const now = input.now?.getTime() ?? Date.now();
  const projectCutoff = now - SCOPE_RECOMMENDATION_DEFAULTS.projectDays * 24 * 60 * 60 * 1000;
  const globalCutoff = now - SCOPE_RECOMMENDATION_DEFAULTS.globalDays * 24 * 60 * 60 * 1000;
  const demotionCutoff = now - SCOPE_RECOMMENDATION_DEFAULTS.demotionDays * 24 * 60 * 60 * 1000;
  const recommendations: ScopeRecommendation[] = [];
  const globalPromotions = new Set<string>();

  for (const [slug, details] of input.globalProjectDetails) {
    if (input.globalDeployments.has(slug)) continue;
    const recentProjects = details.filter((detail) => detail.count > 0 && isSince(detail.lastUsed, globalCutoff));
    if (recentProjects.length < SCOPE_RECOMMENDATION_DEFAULTS.globalProjects) continue;

    globalPromotions.add(slug);
    recommendations.push({
      action: 'promote-global',
      slug,
      reason: `used in ${recentProjects.length} projects within ${SCOPE_RECOMMENDATION_DEFAULTS.globalDays} days`,
    });
  }

  for (const [slug, detail] of input.projectDetails) {
    if (globalPromotions.has(slug) || input.projectDeployments.has(slug)) continue;
    if (detail.count < SCOPE_RECOMMENDATION_DEFAULTS.projectUses || !isSince(detail.firstUsed, projectCutoff)) continue;

    recommendations.push({
      action: 'promote-project',
      slug,
      reason: `used ${detail.count} times in this project within ${SCOPE_RECOMMENDATION_DEFAULTS.projectDays} days`,
    });
  }

  for (const slug of input.globalDeployments) {
    const usage = input.usage.get(slug);
    if (usage && isSince(usage.lastUsed, demotionCutoff)) continue;
    recommendations.push({
      action: 'demote-global',
      slug,
      reason: `unused for ${SCOPE_RECOMMENDATION_DEFAULTS.demotionDays} days`,
    });
  }

  return recommendations.sort((a, b) => a.slug.localeCompare(b.slug));
}
