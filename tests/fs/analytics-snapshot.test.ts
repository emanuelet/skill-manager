import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs-extra';
import path from 'path';
import { createTmpSmHome, type TmpSmHome } from '../helpers/tmpdir.js';

let tmp: TmpSmHome;

beforeEach(async () => {
  tmp = await createTmpSmHome();
  vi.resetModules();
});

afterEach(async () => {
  vi.doUnmock('../../src/core/usage.js');
  await tmp.cleanup();
});

describe('getScopeRecommendations', () => {
  it('queries local details while recommending project and global scope', async () => {
    const now = new Date();
    const recent = now.toISOString();
    const firstUsed = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const usageDetail = vi.fn(async (slug: string, project?: string) => {
      if (!project) {
        return {
          skill: slug,
          count: 5,
          sessions: 5,
          firstUsed,
          lastUsed: recent,
          projects: ['alpha', 'beta', 'gamma'].map((name) => ({ name, count: 1 })),
        };
      }
      return {
        skill: slug,
        count: project?.endsWith('/project-x') ? 3 : 1,
        sessions: 1,
        firstUsed,
        lastUsed: recent,
        projects: [{ name: project, count: project?.endsWith('/project-x') ? 3 : 1 }],
      };
    });

    vi.doMock('../../src/core/usage.js', () => ({
      refreshUsage: vi.fn(async () => ({ source: 'native', records: 1, collectors: [] })),
      usageBySlug: vi.fn(
        async () =>
          new Map([
            [
              'review',
              {
                slug: 'review',
                useCount: 5,
                sessions: 5,
                projects: 3,
                lastUsed: recent,
              },
            ],
          ]),
      ),
      usageDetail,
    }));

    const projectRoot = path.join(tmp.home, 'project-x');
    await fs.ensureDir(projectRoot);
    const { getScopeRecommendations } = await import('../../src/core/analytics-snapshot.js');

    const first = await getScopeRecommendations(projectRoot);
    const second = await getScopeRecommendations(projectRoot);

    expect(first).toEqual(second);
    expect(first.recommendations.map((recommendation) => recommendation.action)).toEqual(['promote-global']);
    expect(usageDetail).toHaveBeenCalledTimes(10);
    expect(usageDetail).toHaveBeenCalledWith('review', projectRoot);
  });

  it('does not infer recommendations without native evidence', async () => {
    vi.doMock('../../src/core/usage.js', () => ({
      refreshUsage: vi.fn(async () => ({ source: 'meta', records: 0 })),
      usageBySlug: vi.fn(async () => new Map()),
      usageDetail: vi.fn(),
    }));

    const { getScopeRecommendations } = await import('../../src/core/analytics-snapshot.js');
    await expect(getScopeRecommendations(tmp.home)).resolves.toEqual({ available: false, recommendations: [] });
  });
});
