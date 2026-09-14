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
    await expect(syncBifrost('http://bifrost.test')).resolves.toEqual({ pushed: 0, pulled: 0, deployed: 0, skipped: 0, conflicts: 0 });
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

  it('deploys a newly pulled skill to both user tool directories', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/api/skills/all/version')) return Response.json({ version: '1' });
      if (url.includes('/api/skills?')) return Response.json({
        skills: [{ id: '1', name: 'remote-skill', latest_version: '1', updated_at: new Date().toISOString() }], total: 1,
      });
      return Response.json({ id: '1', name: 'remote-skill', latest_version: '1', updated_at: new Date().toISOString(), skill_md_body: '# Remote\n' });
    }));

    const { CC_SKILLS_DIR, CODEX_SKILLS_DIR } = await import('../../src/fs/paths.js');
    const { syncBifrost } = await import('../../src/sources/bifrost.js');
    await expect(syncBifrost('http://bifrost.test')).resolves.toMatchObject({ pulled: 1, deployed: 2 });
    expect(await fs.pathExists(path.join(CC_SKILLS_DIR, 'remote-skill'))).toBe(true);
    expect(await fs.pathExists(path.join(CODEX_SKILLS_DIR, 'remote-skill'))).toBe(true);
  });

  it('pulls remote attachments from the serving endpoint', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/api/skills/all/version')) return Response.json({ version: '1' });
      if (url.includes('/api/skills?')) return Response.json({
        skills: [{ id: '1', name: 'remote-skill', latest_version: '1', updated_at: new Date().toISOString() }], total: 1,
      });
      if (url.includes('/api/skills/serve/remote-skill/files/references/example.md')) return new Response('# Attachment\n');
      return Response.json({ id: '1', name: 'remote-skill', latest_version: '1', updated_at: new Date().toISOString(), skill_md_body: '# Remote\n', files: [{ path: 'references/example.md' }] });
    }));

    const { skillDir } = await import('../../src/fs/paths.js');
    const { syncBifrost } = await import('../../src/sources/bifrost.js');
    await syncBifrost('http://bifrost.test');
    await expect(fs.readFile(path.join(skillDir('remote-skill'), 'references/example.md'), 'utf8')).resolves.toBe('# Attachment\n');
  });

  it('creates remote entries for local-only skills', async () => {
    const { skillDir } = await import('../../src/fs/paths.js');
    await fs.ensureDir(skillDir('local-only'));
    await fs.writeFile(path.join(skillDir('local-only'), 'SKILL.md'), '---\nname: local-only\n---\n# Local\n');
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/skills/all/version')) return Response.json({ version: '1' });
      if (url.includes('/api/skills?')) return Response.json({ skills: [], total: 0 });
      expect(init?.method).toBe('POST');
      return Response.json({ id: '1', name: 'local-only', latest_version: '1.0.0', updated_at: new Date().toISOString() });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { syncBifrost } = await import('../../src/sources/bifrost.js');
    await expect(syncBifrost('http://bifrost.test')).resolves.toMatchObject({ pushed: 1 });
  });

  it('skips server-reserved local-only names', async () => {
    const { skillDir } = await import('../../src/fs/paths.js');
    await fs.ensureDir(skillDir('claude-code'));
    await fs.writeFile(path.join(skillDir('claude-code'), 'SKILL.md'), '# Local\n');
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/api/skills/all/version')) return Response.json({ version: '1' });
      if (url.includes('/api/skills?')) return Response.json({ skills: [], total: 0 });
      return new Response('{"error":{"message":"reserved name"}}', { status: 400, statusText: 'Bad Request' });
    }));

    const { syncBifrost } = await import('../../src/sources/bifrost.js');
    await expect(syncBifrost('http://bifrost.test')).resolves.toMatchObject({ pushed: 0, skipped: 1 });
  });
});
