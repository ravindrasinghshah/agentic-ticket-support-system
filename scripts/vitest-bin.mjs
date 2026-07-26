// Resolves vitest's CLI entry point from its own package.json `bin` field, so the test
// scripts can invoke it with `node` directly — no shell, no `pnpm exec`, identical behaviour
// on Windows and POSIX.

import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

export function resolveVitestBin() {
  const require = createRequire(import.meta.url);
  const manifestPath = require.resolve('vitest/package.json');
  const manifest = require('vitest/package.json');

  const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.vitest;
  if (!bin) {
    throw new Error('Could not resolve the vitest CLI entry from its package.json `bin` field.');
  }

  return resolve(dirname(manifestPath), bin);
}
