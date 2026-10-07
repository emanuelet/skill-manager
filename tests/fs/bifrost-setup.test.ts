import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs-extra';
import path from 'node:path';
import { createTmpSmHome, type TmpSmHome } from '../helpers/tmpdir.js';

let tmp: TmpSmHome;
let tty: PropertyDescriptor | undefined;
beforeEach(async () => {
  tmp = await createTmpSmHome();
  vi.resetModules();
  vi.stubEnv('BIFROST_URL', undefined);
  tty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
});
afterEach(async () => {
  if (tty) Object.defineProperty(process.stdin, 'isTTY', tty);
  else Reflect.deleteProperty(process.stdin, 'isTTY');
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await tmp.cleanup();
});

describe('bifrost setup', () => {
  it('persists normalized URL/basic credentials, preserves other settings, and tightens existing permissions', async () => {
    const file = path.join(tmp.smHome, 'config.toml');
    await fs.writeFile(file, 'editor = "nano"\nlogLevel = "debug"\n', { mode: 0o644 });
    vi.stubEnv('TEST_BIFROST_PASSWORD', 'very-private-password');
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { bifrostSetupCommand } = await import('../../src/commands/bifrost.js');
    await bifrostSetupCommand({
      url: 'https://BIFROST.test/gateway///',
      auth: 'basic',
      username: 'admin',
      passwordEnv: 'TEST_BIFROST_PASSWORD',
    });
    const { loadConfig, resetConfigCache } = await import('../../src/core/config.js');
    resetConfigCache();
    expect(await loadConfig()).toMatchObject({
      editor: 'nano',
      logLevel: 'debug',
      bifrost: {
        url: 'https://bifrost.test/gateway',
        auth: { type: 'basic', username: 'admin', password: 'very-private-password' },
      },
    });
    if (process.platform !== 'win32') expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    expect(output.mock.calls.flat().join(' ')).not.toContain('very-private-password');
  });

  it.each(['bearer', 'setup-token'] as const)('persists %s auth without logging the token', async (auth) => {
    vi.stubEnv('TEST_BIFROST_TOKEN', 'private-token-123');
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { bifrostSetupCommand } = await import('../../src/commands/bifrost.js');
    await bifrostSetupCommand({ url: 'https://bifrost.test', auth, tokenEnv: 'TEST_BIFROST_TOKEN' });
    const { loadConfig } = await import('../../src/core/config.js');
    expect((await loadConfig()).bifrost?.auth).toEqual({ type: auth, token: 'private-token-123' });
    expect(output.mock.calls.flat().join(' ')).not.toContain('private-token-123');
  });

  it('retains same-endpoint credentials when only the URL spelling changes and clears them for a new endpoint', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubEnv('TEST_BIFROST_TOKEN', 'private-token');
    const { bifrostSetupCommand } = await import('../../src/commands/bifrost.js');
    const { loadConfig } = await import('../../src/core/config.js');
    await bifrostSetupCommand({ url: 'https://bifrost.test', auth: 'bearer', tokenEnv: 'TEST_BIFROST_TOKEN' });
    await bifrostSetupCommand({ url: 'https://bifrost.test/' });
    expect((await loadConfig()).bifrost?.auth).toEqual({ type: 'bearer', token: 'private-token' });
    await bifrostSetupCommand({ url: 'https://other.test' });
    expect((await loadConfig()).bifrost).toEqual({ url: 'https://other.test', auth: { type: 'none' } });
    expect(await fs.readFile(path.join(tmp.smHome, 'config.toml'), 'utf8')).not.toContain('private-token');
  });

  it('explicitly switches back to unauthenticated mode without retaining the old secret', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubEnv('TEST_BIFROST_TOKEN', 'private-token');
    const { bifrostSetupCommand } = await import('../../src/commands/bifrost.js');
    await bifrostSetupCommand({ url: 'https://bifrost.test', auth: 'bearer', tokenEnv: 'TEST_BIFROST_TOKEN' });
    await bifrostSetupCommand({ auth: 'none' });
    expect(await fs.readFile(path.join(tmp.smHome, 'config.toml'), 'utf8')).not.toContain('private-token');
  });

  it('does not hang or create a config when a secret is missing without a terminal', async () => {
    const { bifrostSetupCommand } = await import('../../src/commands/bifrost.js');
    await expect(
      bifrostSetupCommand({ url: 'https://bifrost.test', auth: 'basic', username: 'admin' }),
    ).rejects.toThrow('--password-env');
    expect(await fs.pathExists(path.join(tmp.smHome, 'config.toml'))).toBe(false);
  });

  it('rejects invalid URLs and contradictory auth options without changing config', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { bifrostSetupCommand } = await import('../../src/commands/bifrost.js');
    await bifrostSetupCommand({ url: 'https://bifrost.test', auth: 'none' });
    const before = await fs.readFile(path.join(tmp.smHome, 'config.toml'), 'utf8');
    for (const url of [
      'file:///tmp/bifrost',
      'https://admin:private@bifrost.test',
      'https://bifrost.test?token=private',
      'https://bifrost.test?',
      'https://bifrost.test#',
      'not-a-url',
    ]) {
      await expect(bifrostSetupCommand({ url, auth: 'none' })).rejects.toThrow('Bifrost URL');
    }
    await expect(bifrostSetupCommand({ auth: 'none', tokenEnv: 'TEST_BIFROST_TOKEN' })).rejects.toThrow('--token-env');
    await expect(bifrostSetupCommand({ auth: 'unknown' })).rejects.toThrow('Authentication must');
    expect(await fs.readFile(path.join(tmp.smHome, 'config.toml'), 'utf8')).toBe(before);
  });

  it('rejects missing secret variables and header injection without exposing values', async () => {
    const { bifrostSetupCommand } = await import('../../src/commands/bifrost.js');
    await expect(bifrostSetupCommand({ auth: 'bearer', tokenEnv: 'MISSING_BIFROST_TOKEN' })).rejects.toThrow(
      'empty or unset',
    );
    vi.stubEnv('TEST_BIFROST_TOKEN', 'secret\r\nInjected: header');
    const error = await bifrostSetupCommand({ auth: 'bearer', tokenEnv: 'TEST_BIFROST_TOKEN' }).catch(
      (value) => value as Error,
    );
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain('Injected');
    expect(String(error)).toContain('Invalid Bifrost authentication');
    expect(await fs.pathExists(path.join(tmp.smHome, 'config.toml'))).toBe(false);
  });

  it('rejects empty variable names instead of silently reusing saved credentials', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubEnv('TEST_BIFROST_PASSWORD', 'saved-password');
    vi.stubEnv('TEST_BIFROST_TOKEN', 'saved-token');
    const { bifrostSetupCommand } = await import('../../src/commands/bifrost.js');
    await bifrostSetupCommand({
      url: 'https://bifrost.test',
      auth: 'basic',
      username: 'admin',
      passwordEnv: 'TEST_BIFROST_PASSWORD',
    });
    await expect(bifrostSetupCommand({ auth: 'basic', passwordEnv: '' })).rejects.toThrow('environment-variable name');
    await expect(bifrostSetupCommand({ auth: 'basic', username: 'another-user' })).rejects.toThrow('--password-env');
    await bifrostSetupCommand({ auth: 'bearer', tokenEnv: 'TEST_BIFROST_TOKEN' });
    await expect(bifrostSetupCommand({ auth: 'bearer', tokenEnv: '' })).rejects.toThrow('environment-variable name');
  });
});
