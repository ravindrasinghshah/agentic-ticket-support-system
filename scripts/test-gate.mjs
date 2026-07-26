#!/usr/bin/env node
// Runs exactly one gate's test suite: `pnpm test:gate 1`.
//
// Per plan.md ("Verification bars"), a gate must be provable without running any
// other gate's suite. This script therefore scopes vitest to tests/gate-N/ only.
//
// Integration tests are excluded unless RUN_INTEGRATION=1, so the default run is
// fully offline with every boundary mocked (Gate 1 pass criterion (b)).

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { resolveVitestBin } from './vitest-bin.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [gateArg, ...passthrough] = process.argv.slice(2);

if (!/^\d+$/.test(gateArg ?? '')) {
  console.error('Usage: pnpm test:gate <N>      e.g. pnpm test:gate 1');
  console.error('       pnpm test:gate <N> --watch');
  process.exit(2);
}

const gateDir = join('tests', `gate-${gateArg}`);
if (!existsSync(join(repoRoot, gateDir))) {
  console.error(`No test suite found at ${gateDir}/ — gate ${gateArg} has not been built yet.`);
  process.exit(2);
}

// Invoked through node directly rather than `pnpm exec`, so no shell is involved and the
// script behaves identically on Windows and POSIX.
const child = spawn(
  process.execPath,
  [resolveVitestBin(), 'run', gateDir, ...passthrough],
  { cwd: repoRoot, stdio: 'inherit' },
);

child.on('exit', (code) => process.exit(code ?? 1));
