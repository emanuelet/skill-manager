import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    'bin/sm': 'bin/sm.ts',
  },
  format: ['esm'],
  target: 'node24',
  platform: 'node',
  external: ['node:sqlite'],
  splitting: false,
  sourcemap: true,
  clean: true,
  dts: false,
  banner: {
    js: '#!/usr/bin/env node',
  },
  esbuildOptions(options) {
    options.jsx = 'automatic';
  },
});
