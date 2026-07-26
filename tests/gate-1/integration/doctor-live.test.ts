/**
 * Gate 1 pass criterion (a): `pnpm doctor` all-green against real infrastructure.
 *
 * Opt-in only — runs when RUN_INTEGRATION=1, which `pnpm test:integration 1` sets. The
 * default `pnpm test:gate 1` never reaches this file, so the offline suite stays green with
 * zero credentials and zero network (pass criterion (b)).
 *
 * This is the one test that is allowed to touch real infrastructure, and it deliberately
 * asserts on the *report*, not on individual services: the doctor is the thing being proven.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { createConfig } from '@ats/core';
import {
  createLiveContext,
  formatReport,
  readEnvFile,
  runChecks,
  validateReport,
} from '@ats/doctor';

// Same resolution order as the CLI: .env for the values, shell environment wins.
const envFile = readEnvFile(fileURLToPath(new URL('../../../.env', import.meta.url)));
const config = createConfig({ ...envFile, ...process.env });
const ctx = createLiveContext(config, 1);

afterAll(async () => {
  await ctx.dispose();
});

describe('pnpm doctor against real infrastructure', () => {
  it('is all-green', async () => {
    const report = await runChecks(ctx);

    if (!report.ok) {
      // Print the real report, remediation and all — the failure message should be the
      // instruction, not "expected true to be false".
      console.error(formatReport(report, { color: false }));
    }

    expect(validateReport(report)).toEqual([]);
    expect(
      report.checks.filter((check) => check.status === 'FAIL').map((check) => check.id),
    ).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('reports the embedding-model check as SKIPPED until Gate 6 specifies the model', async () => {
    const report = await runChecks(ctx, { only: ['bedrock-embedding-model-access'] });
    const check = report.checks[0];

    // If this has become a PASS, someone configured an embedding model without the Gate 6
    // conversation happening. That is the silent, expensive decision this build is
    // specifically structured to avoid — so it is worth failing loudly here.
    expect(check?.status).toBe('SKIPPED');
    expect(check?.remediation).toContain('Gate 6');
  });

  it('leaves the cluster with no schema — Gate 1 creates nothing', async () => {
    const db = await ctx.cockroach();
    const rows = await db.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
    );

    expect(
      rows.map((row) => row.table_name),
      'Gate 1 must leave the cluster empty; the vector probe table should have been dropped',
    ).toEqual([]);
  });
});
