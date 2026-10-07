import chalk from 'chalk';
import { syncBifrost } from '../sources/bifrost.js';
import { loadConfig, saveConfig } from '../core/config.js';
import {
  BifrostConfigSchema,
  DEFAULT_BIFROST_URL,
  normalizeBifrostUrl,
  type BifrostAuth,
} from '../core/bifrost-config.js';
import { ConfigError } from '../utils/errors.js';
import { readSecret, readText } from '../utils/secret-prompt.js';
import { SM_CONFIG_FILE } from '../fs/paths.js';

interface BifrostSetupOptions {
  url?: string;
  auth?: string;
  username?: string;
  passwordEnv?: string;
  tokenEnv?: string;
}

async function question(label: string, fallback: string): Promise<string> {
  if (!process.stdin.isTTY) return fallback;
  return readText(process.stdin, process.stdout, label, fallback);
}

function environmentSecret(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new ConfigError('Invalid secret environment-variable name.');
  const value = process.env[name];
  if (!value) throw new ConfigError(`Environment variable ${name} is empty or unset.`);
  return value;
}

export async function bifrostSetupCommand(opts: BifrostSetupOptions): Promise<void> {
  const config = await loadConfig();
  const url = normalizeBifrostUrl(
    opts.url ??
      (await question('Bifrost base URL', process.env.BIFROST_URL ?? config.bifrost?.url ?? DEFAULT_BIFROST_URL)),
  );
  const existing = config.bifrost?.url === url ? config.bifrost.auth : undefined;
  const type =
    opts.auth ?? (await question('Authentication (none/basic/bearer/setup-token)', existing?.type ?? 'none'));
  if (!['none', 'basic', 'bearer', 'setup-token'].includes(type))
    throw new ConfigError('Authentication must be none, basic, bearer, or setup-token.');
  if (type !== 'basic' && (opts.username !== undefined || opts.passwordEnv !== undefined))
    throw new ConfigError('--username and --password-env require --auth basic.');
  if (!['bearer', 'setup-token'].includes(type) && opts.tokenEnv !== undefined)
    throw new ConfigError('--token-env requires bearer or setup-token authentication.');
  let auth: BifrostAuth;
  if (type === 'basic') {
    const previous = existing?.type === 'basic' ? existing : undefined;
    const username = opts.username ?? (await question('Admin username', previous?.username ?? ''));
    if (!username || username.includes(':'))
      throw new ConfigError('Basic authentication requires a non-empty admin username without a colon.');
    const password =
      opts.passwordEnv !== undefined
        ? environmentSecret(opts.passwordEnv)
        : previous?.username === username && !process.stdin.isTTY
          ? previous.password
          : await readSecret(
              process.stdin,
              process.stdout,
              'Admin password (hidden)',
              previous?.username === username ? previous.password : undefined,
            );
    auth = { type, username, password };
  } else if (type === 'bearer' || type === 'setup-token') {
    const previous = existing?.type === type ? existing.token : undefined;
    const token =
      opts.tokenEnv !== undefined
        ? environmentSecret(opts.tokenEnv)
        : previous && !process.stdin.isTTY
          ? previous
          : await readSecret(
              process.stdin,
              process.stdout,
              type === 'bearer' ? 'Management API key/session token (hidden)' : 'OSS setup token (hidden)',
              previous,
            );
    auth = { type, token };
  } else auth = { type: 'none' };
  const parsed = BifrostConfigSchema.safeParse({ url, auth });
  if (!parsed.success)
    throw new ConfigError(
      'Invalid Bifrost authentication settings. Check username/password or token; tokens must not contain whitespace or control characters.',
    );
  await saveConfig({ ...config, bifrost: parsed.data });
  console.log(chalk.green(`Bifrost configured: ${url} (${auth.type} authentication).`));
  console.log(`Settings saved in ${SM_CONFIG_FILE} with owner-only permissions. Run sm source bifrost sync.`);
}

export async function bifrostSyncCommand(opts: { url?: string; trust?: string[] }): Promise<void> {
  const result = await syncBifrost(opts.url, new Set(opts.trust ?? []));
  console.log(
    chalk.green(
      `Bifrost sync: ${result.pushed} pushed, ${result.pulled} pulled, ${result.deployed} deployed, ${result.skipped} skipped, ${result.conflicts} equal-time conflicts resolved to Bifrost.`,
    ),
  );
}
