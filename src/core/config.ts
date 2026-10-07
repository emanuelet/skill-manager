import fs from 'fs-extra';
import TOML from '@iarna/toml';
import { z } from 'zod';
import { SM_CONFIG_FILE, SM_HOME } from '../fs/paths.js';
import { ConfigError } from '../utils/errors.js';
import { BifrostConfigSchema } from './bifrost-config.js';

const ConfigSchema = z.object({
  editor: z.string().optional(),
  defaultTools: z
    .array(z.enum(['cc', 'agents', 'codex']))
    .default(['cc', 'agents'])
    .transform((tools) => [...new Set(tools.map((tool) => (tool === 'codex' ? 'agents' : tool)))]),
  autoSync: z.boolean().default(true),
  autoAdopt: z.boolean().default(true),
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  bifrost: BifrostConfigSchema.optional(),
});

export type Config = z.infer<typeof ConfigSchema>;

const DEFAULT_CONFIG: Config = {
  defaultTools: ['cc', 'agents'],
  autoSync: true,
  autoAdopt: true,
  logLevel: 'info',
};

let cachedConfig: Config | null = null;

export async function loadConfig(): Promise<Config> {
  if (cachedConfig) return cachedConfig;

  await fs.ensureDir(SM_HOME);

  if (await fs.pathExists(SM_CONFIG_FILE)) {
    const raw = await fs.readFile(SM_CONFIG_FILE, 'utf-8');
    let parsed: TOML.JsonMap;
    try {
      parsed = TOML.parse(raw);
    } catch {
      throw new ConfigError('Config file is corrupted — check ~/.skill-manager/config.toml syntax');
    }
    try {
      cachedConfig = ConfigSchema.parse(parsed);
    } catch {
      throw new ConfigError('Config has invalid values — check ~/.skill-manager/config.toml');
    }
  } else {
    cachedConfig = { ...DEFAULT_CONFIG };
  }

  return cachedConfig;
}

export async function saveConfig(config: Config): Promise<void> {
  await fs.ensureDir(SM_HOME);
  const toml = TOML.stringify(config as unknown as TOML.JsonMap);
  // Tighten an existing file before writing secrets; mode only affects creation.
  if (await fs.pathExists(SM_CONFIG_FILE)) await fs.chmod(SM_CONFIG_FILE, 0o600);
  await fs.writeFile(SM_CONFIG_FILE, toml, { encoding: 'utf-8', mode: 0o600 });
  cachedConfig = config;
}

export function resetConfigCache(): void {
  cachedConfig = null;
}
