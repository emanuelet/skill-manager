import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs-extra';
import path from 'node:path';
import { createTmpSmHome, type TmpSmHome } from '../helpers/tmpdir.js';

let tmp: TmpSmHome;
beforeEach(async () => {
  tmp = await createTmpSmHome();
  vi.resetModules();
  vi.stubEnv('BIFROST_URL', undefined);
});
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await tmp.cleanup();
});

async function saveAuth(
  auth: { type: 'basic'; username: string; password: string } | { type: 'bearer' | 'setup-token'; token: string },
) {
  const { loadConfig, saveConfig } = await import('../../src/core/config.js');
  await saveConfig({ ...(await loadConfig()), bifrost: { url: 'https://bifrost.test/gateway', auth } });
}

describe('authenticated Bifrost requests', () => {
  it('uses saved basic auth for version/list/detail/create/update/upload/download, preserving content types', async () => {
    await saveAuth({ type: 'basic', username: 'admin', password: 'private-password' });
    const { skillDir } = await import('../../src/fs/paths.js');
    await fs.outputFile(path.join(skillDir('local-only'), 'SKILL.md'), '# Local\n');
    await fs.outputFile(path.join(skillDir('local-only'), 'references/local.md'), '# Local attachment\n');
    await fs.outputFile(path.join(skillDir('local-update'), 'SKILL.md'), '# New local\n');
    const old = '2000-01-01T00:00:00.000Z';
    const summary = (name: string) => ({ id: name, name, latest_version: '1.0.0', updated_at: old });
    const seen: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        const headers = new Headers(init?.headers);
        expect(headers.get('authorization')).toBe(`Basic ${Buffer.from('admin:private-password').toString('base64')}`);
        expect(url.startsWith('https://bifrost.test/gateway/api/skills')).toBe(true);
        seen.push(`${init?.method ?? 'GET'} ${url}`);
        if (url.endsWith('/all/version')) return Response.json({ version: '1' });
        if (url.includes('?limit='))
          return Response.json({ skills: [summary('remote-skill'), summary('local-update')], total: 2 });
        if (url.endsWith('/files/upload')) {
          expect(init?.body).toBeInstanceOf(FormData);
          expect(headers.has('content-type')).toBe(false);
          return Response.json({ upload_id: 'upload1' });
        }
        if (init?.method === 'POST' || init?.method === 'PUT') {
          expect(headers.get('content-type')).toBe('application/json');
          const body = JSON.parse(String(init.body));
          return Response.json(summary(body.name));
        }
        if (url.includes('/serve/remote-skill/files/')) return new Response('# Remote attachment\n');
        if (url.endsWith('/remote-skill'))
          return Response.json({
            ...summary('remote-skill'),
            skill_md_body: '# Remote\n',
            files: [{ path: 'references/remote.md' }],
          });
        if (url.endsWith('/local-update'))
          return Response.json({ ...summary('local-update'), skill_md_body: '# Old\n' });
        throw new Error('Unexpected route');
      }),
    );
    const { syncBifrost } = await import('../../src/sources/bifrost.js');
    expect(await syncBifrost()).toMatchObject({ pushed: 2, pulled: 1 });
    expect(seen).toHaveLength(8);
    expect(await fs.readFile(path.join(skillDir('remote-skill'), 'references/remote.md'), 'utf8')).toBe(
      '# Remote attachment\n',
    );
  });

  it.each(['bearer', 'setup-token'] as const)('sends %s using the documented management header', async (type) => {
    await saveAuth({ type, token: 'private-token' });
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get(type === 'bearer' ? 'authorization' : 'x-bifrost-setup-token')).toBe(
        type === 'bearer' ? 'Bearer private-token' : 'private-token',
      );
      expect(init?.redirect).toBe('error');
      return Response.json({ skills: [], total: 0 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const { createBifrostClient } = await import('../../src/sources/bifrost-client.js');
    await (await createBifrostClient()).json('/api/skills');
  });

  it('keeps URL precedence and never forwards saved credentials to another endpoint', async () => {
    await saveAuth({ type: 'bearer', token: 'private-token' });
    const { createBifrostClient } = await import('../../src/sources/bifrost-client.js');
    vi.stubEnv('BIFROST_URL', 'https://environment.test');
    expect((await createBifrostClient()).baseUrl).toBe('https://environment.test');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        expect(new Headers(init?.headers).has('authorization')).toBe(false);
        return Response.json({});
      }),
    );
    const client = await createBifrostClient('https://override.test');
    expect(client.baseUrl).toBe('https://override.test');
    await client.json('/api/skills');
  });

  it.each([401, 403])('reports %s without exposing reflected credentials', async (status) => {
    await saveAuth({ type: 'bearer', token: 'private-token' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('private-token', { status })),
    );
    const { createBifrostClient } = await import('../../src/sources/bifrost-client.js');
    const client = await createBifrostClient();
    const error = await client.json('/api/skills').catch((value) => value as Error);
    expect(String(error)).toContain(String(status));
    expect(String(error)).not.toContain('private-token');
  });

  it('redacts basic credentials and encoded headers from generic server failures', async () => {
    const password = 'private-"password';
    await saveAuth({ type: 'basic', username: 'admin', password });
    const encoded = Buffer.from(`admin:${password}`).toString('base64');
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(`${password} ${encoded} ${JSON.stringify(password)}`, { status: 500, statusText: encoded }),
      ),
    );
    const { createBifrostClient } = await import('../../src/sources/bifrost-client.js');
    const error = await (await createBifrostClient()).json('/api/skills').catch((value) => value as Error);
    expect(String(error)).not.toContain(password);
    expect(String(error)).not.toContain(encoded);
    expect(String(error)).toContain('[redacted]');
  });

  it('still skips reserved skill names when the error message is redacted or truncated', async () => {
    await saveAuth({ type: 'basic', username: 'admin', password: 'name' });
    const { skillDir } = await import('../../src/fs/paths.js');
    await fs.outputFile(path.join(skillDir('claude-code'), 'SKILL.md'), '# Local\n');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url.endsWith('/all/version')) return Response.json({ version: '1' });
        if (url.includes('?limit=')) return Response.json({ skills: [], total: 0 });
        return new Response('prefix '.repeat(200) + 'reserved name', { status: 400 });
      }),
    );
    const { syncBifrost } = await import('../../src/sources/bifrost.js');
    await expect(syncBifrost()).resolves.toMatchObject({ pushed: 0, skipped: 1 });
  });
});
