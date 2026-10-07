import { loadConfig } from '../core/config.js';
import { DEFAULT_BIFROST_URL, normalizeBifrostUrl, type BifrostAuth } from '../core/bifrost-config.js';
import { SourceError } from '../utils/errors.js';

export interface BifrostClient {
  baseUrl: string;
  request(path: string, init?: RequestInit): Promise<Response>;
  json<T>(path: string, init?: RequestInit): Promise<T>;
}

export class BifrostHttpError extends SourceError {
  constructor(
    public readonly status: number,
    public readonly reservedName: boolean,
    message: string,
  ) {
    super(message);
  }
}

export async function createBifrostClient(overrideUrl?: string): Promise<BifrostClient> {
  const saved = (await loadConfig()).bifrost;
  const baseUrl = normalizeBifrostUrl(overrideUrl ?? process.env.BIFROST_URL ?? saved?.url ?? DEFAULT_BIFROST_URL);
  // Credentials belong to the configured endpoint, never an unrelated URL override.
  const auth: BifrostAuth = saved && baseUrl === normalizeBifrostUrl(saved.url) ? saved.auth : { type: 'none' };
  const authentication = new Headers();
  const secrets: string[] = [];
  if (auth.type === 'basic') {
    const encoded = Buffer.from(`${auth.username}:${auth.password}`, 'utf8').toString('base64');
    authentication.set('Authorization', `Basic ${encoded}`);
    secrets.push(auth.password, encoded, `Basic ${encoded}`);
  } else if (auth.type === 'bearer') {
    authentication.set('Authorization', `Bearer ${auth.token}`);
    secrets.push(auth.token, `Bearer ${auth.token}`);
  } else if (auth.type === 'setup-token') {
    authentication.set('X-Bifrost-Setup-Token', auth.token);
    secrets.push(auth.token);
  }
  const redactions = [
    ...new Set(secrets.flatMap((secret) => [secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)])),
  ]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  const redact = (value: string) => redactions.reduce((text, secret) => text.split(secret).join('[redacted]'), value);
  const request = async (route: string, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    authentication.forEach((value, name) => headers.set(name, value));
    let response: Response;
    try {
      response = await fetch(`${baseUrl}${route}`, {
        ...init,
        headers,
        redirect: auth.type === 'none' ? 'follow' : 'error',
      });
    } catch {
      throw new SourceError(
        `Could not reach Bifrost at ${baseUrl}. Check the URL and network; authenticated requests require the final URL, without redirects.`,
      );
    }
    if (response.status === 401)
      throw new SourceError(
        'Bifrost authentication rejected (401). Run sm source bifrost setup with management credentials.',
      );
    if (response.status === 403)
      throw new SourceError('Bifrost access denied (403). Check management permissions or the OSS setup token.');
    if (!response.ok) {
      const detail = await response.text();
      throw new BifrostHttpError(
        response.status,
        detail.includes('reserved name'),
        `Bifrost ${response.status} ${redact(response.statusText)}: ${redact(detail).slice(0, 1000)}`,
      );
    }
    return response;
  };
  return {
    baseUrl,
    request,
    async json<T>(route: string, init?: RequestInit): Promise<T> {
      const response = await request(route, init);
      try {
        return (await response.json()) as T;
      } catch {
        throw new SourceError(
          'Bifrost returned invalid JSON. Check that the configured URL points to the gateway API.',
        );
      }
    },
  };
}
