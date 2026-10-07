import { emitKeypressEvents } from 'node:readline';
import { ConfigError } from './errors.js';
import { createInterface } from 'node:readline/promises';

export async function readText(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
  label: string,
  fallback: string,
): Promise<string> {
  const rl = createInterface({ input, output });
  const abort = new AbortController();
  const onClose = () => abort.abort();
  rl.once('close', onClose);
  try {
    return (await rl.question(`${label} [${fallback}]: `, { signal: abort.signal })).trim() || fallback;
  } catch {
    throw new ConfigError('Bifrost setup cancelled before saving.');
  } finally {
    rl.removeListener('close', onClose);
    rl.close();
  }
}

interface SecretInput extends NodeJS.ReadableStream {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode(mode: boolean): unknown;
  isPaused(): boolean;
}

/** Read a secret without echoing input, restoring the terminal even on cancellation. */
export function readSecret(
  input: SecretInput,
  output: NodeJS.WritableStream,
  label: string,
  previous?: string,
): Promise<string> {
  if (!input.isTTY)
    throw new ConfigError(
      'Secret input requires a terminal. Use --password-env or --token-env for non-interactive setup.',
    );
  return new Promise((resolve, reject) => {
    const wasRaw = input.isRaw ?? false;
    const wasPaused = input.isPaused();
    let value = '';
    const cleanup = () => {
      input.removeListener('keypress', onKey);
      input.removeListener('end', onEnd);
      input.removeListener('close', onEnd);
      input.setRawMode(wasRaw);
      if (wasPaused) input.pause();
      output.write('\n');
    };
    const onEnd = () => {
      cleanup();
      reject(new ConfigError('Bifrost setup cancelled before saving.'));
    };
    const onKey = (text: string | undefined, key: { name?: string; ctrl?: boolean; sequence?: string }) => {
      if (key.ctrl && ['c', 'd'].includes(key.name ?? '')) return onEnd();
      if (key.name === 'return' || key.name === 'enter') {
        cleanup();
        resolve(value || previous || '');
        return;
      }
      if (key.name === 'backspace') {
        value = Array.from(value).slice(0, -1).join('');
        return;
      }
      if (key.ctrl && key.name === 'u') {
        value = '';
        return;
      }
      if (key.ctrl || key.sequence?.startsWith('\u001b')) return;
      if (text) value += text.replace(/[\x00-\x1f\x7f]/g, '');
    };
    output.write(`${label}${previous ? ' [Enter to keep existing]' : ''}: `);
    emitKeypressEvents(input);
    input.on('keypress', onKey);
    input.once('end', onEnd);
    input.once('close', onEnd);
    input.setRawMode(true);
    input.resume();
  });
}
