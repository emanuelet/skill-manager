import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs-extra';
import path from 'node:path';
import { createTmpSmHome, type TmpSmHome } from '../helpers/tmpdir.js';

let tmp: TmpSmHome;

beforeEach(async () => {
  tmp = await createTmpSmHome();
  vi.resetModules();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await tmp.cleanup();
});

describe('syncBifrost', () => {
  it('does not resync when local frontmatter differs from the remote body', async () => {
    const { skillDir } = await import('../../src/fs/paths.js');
    const localDir = skillDir('example');
    await fs.ensureDir(localDir);
    await fs.writeFile(path.join(localDir, 'SKILL.md'), '---\nname: example\ndescription: local\n---\n# Example\n');

    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/skills/all/version')) return Response.json({ version: '1' });
      if (url.includes('/api/skills?')) return Response.json({
        skills: [{ id: '1', name: 'example', latest_version: '1', updated_at: new Date().toISOString() }], total: 1,
      });
      if (url.endsWith('/api/skills/1')) {
        expect(init?.method).toBeUndefined();
        return Response.json({ id: '1', name: 'example', latest_version: '1', updated_at: new Date().toISOString(), skill_md_body: '# Example\n' });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const { syncBifrost } = await import('../../src/sources/bifrost.js');
    await expect(syncBifrost('http://bifrost.test')).resolves.toEqual({ pushed: 0, pulled: 0, conflicts: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('rejects a remote skill name that escapes the canonical store', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/api/skills/all/version')) return Response.json({ version: '1' });
      return Response.json({
        skills: [{ id: '1', name: '../outside', latest_version: '1', updated_at: new Date().toISOString() }], total: 1,
      });
    }));

    const { syncBifrost } = await import('../../src/sources/bifrost.js');
    await expect(syncBifrost('http://bifrost.test')).rejects.toThrow('Unsafe Bifrost skill name');
  });
});
