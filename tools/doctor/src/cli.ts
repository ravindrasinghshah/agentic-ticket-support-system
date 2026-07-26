#!/usr/bin/env tsx
/**
 * `pnpm doctor` — infrastructure diagnostics.
 *
 * Advisory, never self-healing (plan.md working agreement 6): it diagnoses and prescribes;
 * the user performs every account and console action. It verifies but never creates.
 *
 *   pnpm doctor                      run every Gate 1 check
 *   pnpm doctor --gate 6             run everything required up to Gate 6
 *   pnpm doctor --only config-placeholders,aws-credentials
 *   pnpm doctor --json               machine-readable report on stdout
 *   pnpm doctor --out report.json    write the JSON report to a file as well
 *   pnpm check:config                shorthand for --only config-placeholders
 *
 * Exit code is 0 only when no check FAILed. SKIPPED does not fail the run.
 */

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createConfig } from '@ats/core';
import { ALL_CHECKS } from './checks/index.ts';
import { readEnvFile } from './env-file.ts';
import { formatReport } from './format.ts';
import { createLiveContext } from './live-context.ts';
import { runChecks } from './runner.ts';

interface CliOptions {
  gate: number;
  only: string[];
  json: boolean;
  out: string | null;
  color: boolean;
  envFile: string;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    gate: 1,
    only: [],
    json: false,
    out: null,
    color: process.stdout.isTTY === true,
    envFile: '.env',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--gate': {
        const value = Number(argv[++i]);
        if (!Number.isInteger(value) || value < 1) {
          exitWithUsage(`--gate expects a positive integer, got '${argv[i]}'`);
        }
        options.gate = value;
        break;
      }
      case '--only': {
        const value = argv[++i];
        if (!value) exitWithUsage('--only expects a comma-separated list of check ids');
        options.only = value.split(',').map((id) => id.trim()).filter(Boolean);
        break;
      }
      case '--json':
        options.json = true;
        break;
      case '--out': {
        const value = argv[++i];
        if (!value) exitWithUsage('--out expects a file path');
        options.out = value;
        break;
      }
      case '--no-color':
        options.color = false;
        break;
      case '--env-file': {
        const value = argv[++i];
        if (!value) exitWithUsage('--env-file expects a file path');
        options.envFile = value;
        break;
      }
      case '--list':
        for (const check of ALL_CHECKS) {
          process.stdout.write(`${check.id.padEnd(34)} gate ${check.gate}  ${check.title}\n`);
        }
        process.exit(0);
        break;
      case '--help':
      case '-h':
        printUsage();
        process.exit(0);
        break;
      default:
        exitWithUsage(`unknown argument '${arg}'`);
    }
  }

  const known = new Set(ALL_CHECKS.map((check) => check.id));
  const unknown = options.only.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    exitWithUsage(
      `unknown check id(s): ${unknown.join(', ')}. Run \`pnpm doctor --list\` to see them all.`,
    );
  }

  return options;
}

function printUsage(): void {
  process.stdout.write(
    [
      'Usage: pnpm doctor [options]',
      '',
      '  --gate <n>        Run everything required up to gate <n> (default 1)',
      '  --only <ids>      Comma-separated check ids',
      '  --list            List every check and the gate it belongs to',
      '  --json            Print the JSON report instead of the human-readable one',
      '  --out <path>      Also write the JSON report to <path>',
      '  --env-file <path> Read configuration from <path> instead of .env',
      '  --no-color        Disable ANSI colour',
      '',
      'Exit code 0 means no check FAILed. This tool verifies but never creates —',
      'every remediation is an instruction for you to perform.',
      '',
    ].join('\n'),
  );
}

function exitWithUsage(message: string): never {
  process.stderr.write(`pnpm doctor: ${message}\n\n`);
  printUsage();
  process.exit(2);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  // .env is the normal home for these values; the shell still wins, so
  // `AWS_PROFILE=other pnpm doctor` overrides the file.
  const fromFile = readEnvFile(resolve(process.cwd(), options.envFile));
  const config = createConfig({ ...fromFile, ...process.env });
  const ctx = createLiveContext(config, options.gate);

  try {
    const report = await runChecks(ctx, { only: options.only });

    if (options.json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      process.stdout.write(formatReport(report, { color: options.color }));
    }
    if (options.out) {
      writeFileSync(options.out, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
      if (!options.json) process.stdout.write(`  Report written to ${options.out}\n\n`);
    }

    process.exitCode = report.ok ? 0 : 1;
  } finally {
    await ctx.dispose();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `pnpm doctor failed before it could report: ${
      error instanceof Error ? error.stack ?? error.message : String(error)
    }\n`,
  );
  process.exit(1);
});
