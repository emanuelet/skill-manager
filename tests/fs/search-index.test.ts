import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTmpSmHome, type TmpSmHome } from '../helpers/tmpdir.js';
import { createTestSkill } from '../helpers/skill-factory.js';

let tmp: TmpSmHome;
beforeEach(async () => { tmp = await createTmpSmHome(); vi.resetModules(); });
afterEach(async () => { await tmp.cleanup(); });

describe('search index', () => {
  it('fuses lexical and fuzzy matches without interpreting FTS punctuation', async () => {
    await createTestSkill('javascript-helper', { name: 'JavaScript Helper', description: 'Browser tooling', tags: ['web'] });
    await createTestSkill('python-helper', { name: 'Python Helper', description: 'Data tooling', tags: ['data'] });
    const { searchSkills } = await import('../../src/core/search.js');
    expect((await searchSkills('javascript')).map((hit) => hit.slug)).toContain('javascript-helper');
    expect((await searchSkills('javscript')).map((hit) => hit.slug)).toContain('javascript-helper');
    await expect(searchSkills('javascript OR *')).resolves.toBeDefined();
  });
});
