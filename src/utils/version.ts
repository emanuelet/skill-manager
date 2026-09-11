import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgPath = [
  path.resolve(__dirname, '../../package.json'),
  path.resolve(__dirname, '../package.json'),
].find(existsSync);

if (!pkgPath) throw new Error('Unable to locate package.json');

export const VERSION: string = JSON.parse(readFileSync(pkgPath, 'utf-8')).version;
