import { describe, expect, it } from 'vitest';
import { recommendScopes } from '../../src/core/scope-recommendations.js';
import type { UsageDetail, UsageRecord } from '../../src/core/usage.js';

const now = new Date('2026-09-14T12:00:00.000Z');

function record(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    slug: 'skill',
    useCount: 0,
    sessions: 0,
    projects: 0,
    ...overrides,
  };
}

function detail(overrides: Partial<UsageDetail> = {}): UsageDetail {
  return {
    skill: 'skill',
    count: 0,
    sessions: 0,
    projects: [],
    ...overrides,
  };
}

function recommend(overrides: Partial<Parameters<typeof recommendScopes>[0]> = {}) {
  return recommendScopes({
    usage: new Map(),
    globalDeployments: new Set(),
    projectDeployments: new Set(),
    projectDetails: new Map(),
    globalProjectDetails: new Map(),
    now,
    ...overrides,
  });
}

describe('recommendScopes', () => {
  it('promotes a repeatedly used current-project skill', () => {
    const recommendations = recommend({
      projectDetails: new Map([
        ['review', detail({ skill: 'review', count: 3, firstUsed: '2026-09-07T12:00:00.000Z' })],
      ]),
    });

    expect(recommendations).toEqual([
      { action: 'promote-project', slug: 'review', reason: 'used 3 times in this project within 7 days' },
    ]);
  });

  it('does not promote project usage that began outside the seven-day window', () => {
    const recommendations = recommend({
      projectDetails: new Map([
        ['review', detail({ skill: 'review', count: 5, firstUsed: '2026-09-07T11:59:59.999Z' })],
      ]),
    });

    expect(recommendations).toEqual([]);
  });

  it('promotes a skill used recently in three distinct projects', () => {
    const projectDetails = [
      detail({ skill: 'review', count: 1, lastUsed: '2026-09-01T12:00:00.000Z' }),
      detail({ skill: 'review', count: 2, lastUsed: '2026-09-10T12:00:00.000Z' }),
      detail({ skill: 'review', count: 1, lastUsed: '2026-09-14T12:00:00.000Z' }),
    ];
    const recommendations = recommend({
      globalProjectDetails: new Map([['review', projectDetails]]),
    });

    expect(recommendations).toEqual([
      { action: 'promote-global', slug: 'review', reason: 'used in 3 projects within 14 days' },
    ]);
  });

  it('suggests demoting a global skill unused for thirty days', () => {
    const recommendations = recommend({
      usage: new Map([['legacy', record({ slug: 'legacy', lastUsed: '2026-08-15T11:59:59.999Z' })]]),
      globalDeployments: new Set(['legacy']),
    });

    expect(recommendations).toEqual([{ action: 'demote-global', slug: 'legacy', reason: 'unused for 30 days' }]);
  });

  it('does not demote a global skill used at the thirty-day boundary', () => {
    const recommendations = recommend({
      usage: new Map([['active', record({ slug: 'active', lastUsed: '2026-08-15T12:00:00.000Z' })]]),
      globalDeployments: new Set(['active']),
    });

    expect(recommendations).toEqual([]);
  });
});
