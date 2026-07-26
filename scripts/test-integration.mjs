#!/usr/bin/env node
// Runs the integration tier, which requires real infrastructure and real credentials.
//
//   pnpm test:integration           all gates' integration tests
//   pnpm test:integration 1         only gate 1's
//
// Everything else in the repo runs offline; RUN_INTEGRATION=1 is the single switch that lets
// a test touch the network. See docs/TESTING.md.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { resolveVitestBin } from './vitest-bin.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [gateArg, ...passthrough] = process.argv.slice(2);

const target = /^\d+$/.test(gateArg ?? '')
  ? join('tests', `gate-${gateArg}`, 'integration')
  : 'tests';

const child = spawn(process.execPath, [resolveVitestBin(), 'run', target, ...passthrough], {
  cwd: repoRoot,
  stdio: 'inherit',
  env: { ...process.env, RUN_INTEGRATION: '1' },
});

child.on('exit', (code) => process.exit(code ?? 1));
