import { z } from 'zod';
import { ConfigError } from '../utils/errors.js';

export const DEFAULT_BIFROST_URL = 'http://localhost:8090';

export function normalizeBifrostUrl(value: string): string {
  try {
    const url = new URL(value.trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || /[?#]/.test(url.href))
      throw new Error();
    return url.toString().replace(/\/+$/, '');
  } catch {
    throw new ConfigError(
      'Bifrost URL must be an absolute HTTP(S) URL without embedded credentials, query, or fragment.',
    );
  }
}

const urlSchema = z.string().transform((value, ctx) => {
  try {
    return normalizeBifrostUrl(value);
  } catch {
    ctx.addIssue({ code: 'custom', message: 'Invalid Bifrost base URL' });
    return z.NEVER;
  }
});
const tokenSchema = z
  .string()
  .min(1)
  .regex(/^[\x21-\x7e]+$/, 'Tokens must not contain whitespace or control characters');

export const BifrostAuthSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }),
  z.object({
    type: z.literal('basic'),
    username: z
      .string()
      .min(1)
      .refine((value) => !value.includes(':'), 'Basic auth usernames must not contain a colon'),
    password: z.string().min(1),
  }),
  z.object({ type: z.literal('bearer'), token: tokenSchema }),
  z.object({ type: z.literal('setup-token'), token: tokenSchema }),
]);

export const BifrostConfigSchema = z.object({
  url: urlSchema.default(DEFAULT_BIFROST_URL),
  auth: BifrostAuthSchema.default({ type: 'none' }),
});

export type BifrostAuth = z.infer<typeof BifrostAuthSchema>;
export type BifrostConfig = z.infer<typeof BifrostConfigSchema>;
