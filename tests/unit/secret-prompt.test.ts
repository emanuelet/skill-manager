import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { readSecret, readText } from '../../src/utils/secret-prompt.js';

function terminal() {
  const input = Object.assign(new PassThrough(), {
    isTTY: true,
    isRaw: false,
    setRawMode(mode: boolean) {
      this.isRaw = mode;
    },
  });
  input.pause();
  const output = new PassThrough();
  let displayed = '';
  output.on('data', (data) => {
    displayed += data.toString();
  });
  return { input, output, displayed: () => displayed };
}

describe('hidden credential prompt', () => {
  it('rejects ordinary-prompt EOF rather than leaving setup pending', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    output.resume();
    const result = readText(input, output, 'URL', 'http://localhost:8090');
    const rejection = expect(result).rejects.toThrow('cancelled before saving');
    input.end();
    await rejection;
  });
  it('reads secrets without echoing them and restores terminal state', async () => {
    const tty = terminal();
    const result = readSecret(tty.input, tty.output, 'Password');
    tty.input.write('private-password\r');
    expect(await result).toBe('private-password');
    expect(tty.displayed()).toBe('Password: \n');
    expect(tty.input.isRaw).toBe(false);
    expect(tty.input.isPaused()).toBe(true);
    expect(tty.input.listenerCount('keypress')).toBe(0);
  });

  it('supports backspace and keeping an existing secret without revealing it', async () => {
    const tty = terminal();
    const result = readSecret(tty.input, tty.output, 'Password');
    tty.input.write('wrong\u007fX\r');
    expect(await result).toBe('wronX');
    const keep = readSecret(tty.input, tty.output, 'Password', 'existing-secret');
    tty.input.write('\r');
    expect(await keep).toBe('existing-secret');
    expect(tty.displayed()).not.toContain('existing-secret');
  });

  it('restores raw mode on cancellation and rejects non-terminal input', async () => {
    const tty = terminal();
    const result = readSecret(tty.input, tty.output, 'Password');
    const rejection = expect(result).rejects.toThrow('cancelled before saving');
    tty.input.write('\u0003');
    await rejection;
    expect(tty.input.isRaw).toBe(false);
    expect(tty.input.listenerCount('keypress')).toBe(0);
    tty.input.isTTY = false;
    expect(() => readSecret(tty.input, tty.output, 'Password')).toThrow('--password-env');
  });
});
