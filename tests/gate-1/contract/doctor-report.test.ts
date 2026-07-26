/**
 * The doctor's report contract.
 *
 * With no IaC, `pnpm doctor` is the project's only drift detector — so a check that fails
 * without saying what to do about it is worthless. That rule is enforced here rather than
 * left to reviewer discipline.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  ALL_CHECKS,
  REPORT_VERSION,
  runChecks,
  validateCheckResult,
  validateReport,
  type CheckDefinition,
} from '@ats/doctor';
import { awsError, createFakeContext, GOOD_ENV } from '../helpers/fake-context.ts';

const fixture = (relative: string) =>
  fileURLToPath(new URL(`../../../fixtures/gate-1/${relative}`, import.meta.url));

describe('report shape', () => {
  it('a healthy run validates and is all-green', async () => {
    const report = await runChecks(createFakeContext());

    expect(validateReport(report)).toEqual([]);
    expect(report.reportVersion).toBe(REPORT_VERSION);
    expect(report.gate).toBe(1);
    expect(report.region).toBe('us-east-1');
    expect(report.summary.failed).toBe(0);
    expect(report.ok).toBe(true);
  });

  it('every check returns the documented shape', async () => {
    const report = await runChecks(createFakeContext());

    expect(report.checks).toHaveLength(ALL_CHECKS.length);
    for (const check of report.checks) {
      expect(validateCheckResult(check), `check '${check.id}'`).toEqual([]);
    }
  });

  it('the committed fixture is a valid example of the shape', () => {
    const example = JSON.parse(readFileSync(fixture('expected/doctor-report.json'), 'utf8'));
    expect(validateReport(example)).toEqual([]);
  });

  it('check ids are unique and stable — they are a public interface for --only', () => {
    const ids = ALL_CHECKS.map((check) => check.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9-]+$/);
  });

  it('summary counts and ok always agree with the checks array', async () => {
    const report = await runChecks(
      createFakeContext({
        probes: { s3: { listObjects: async () => Promise.reject(awsError('NoSuchBucket', 'nope')) } },
      }),
    );

    expect(validateReport(report)).toEqual([]);
    expect(report.ok).toBe(false);
    expect(report.summary.failed).toBeGreaterThan(0);
    expect(report.summary.total).toBe(report.checks.length);
  });
});

describe('a failing check always carries remediation', () => {
  it('holds for every check, driven to failure one at a time', async () => {
    // Rather than trusting each check's own tests, break the world completely and assert
    // the invariant across the whole catalogue at once.
    const explode = async () => Promise.reject(awsError('AccessDeniedException', 'denied'));
    const report = await runChecks(
      createFakeContext({
        env: { ...GOOD_ENV, AWS_REGION: 'REPLACE_ME' },
        probes: {
          sts: { getCallerIdentity: explode },
          bedrock: { listFoundationModels: explode, invokeSmallest: explode },
          agentcore: {
            listAgentRuntimes: explode,
            listMemories: explode,
            listGateways: explode,
          },
          s3: { listObjects: explode, getObject: explode },
          cockroach: explode,
          mcp: { listTools: explode },
        },
      }),
    );

    expect(report.ok).toBe(false);
    for (const check of report.checks) {
      if (check.status === 'PASS') continue;
      expect(check.remediation ?? '', `check '${check.id}' failed silently`).not.toBe('');
      expect((check.remediation ?? '').length, `check '${check.id}'`).toBeGreaterThan(40);
    }
  });

  it('a check that throws is still reported with actionable advice, not a stack trace', async () => {
    const rogue: CheckDefinition = {
      id: 'rogue-check',
      title: 'A check with a bug in it',
      category: 'config',
      gate: 1,
      run: async () => {
        throw new Error('unhandled internal error');
      },
    };

    const report = await runChecks(createFakeContext(), { checks: [rogue] });

    expect(report.checks[0]?.status).toBe('FAIL');
    expect(report.checks[0]?.remediation).toContain('rogue-check');
    expect(report.checks[0]?.remediation).toContain('threw instead of returning');
    expect(validateReport(report)).toEqual([]);
  });

  it('remediation never leaks a stack trace into the user-facing advice', async () => {
    const report = await runChecks(
      createFakeContext({
        probes: {
          sts: {
            getCallerIdentity: async () =>
              Promise.reject(awsError('ExpiredTokenException', 'expired')),
          },
        },
      }),
    );

    for (const check of report.checks) {
      expect(check.remediation ?? '').not.toMatch(/\n\s+at .+:\d+:\d+/);
    }
  });
});

describe('gate scoping', () => {
  it('skips later-gate checks rather than omitting them, and stays ok', async () => {
    const report = await runChecks(createFakeContext({ gate: 1 }));
    const embedding = report.checks.find((c) => c.id === 'bedrock-embedding-model-access');

    expect(embedding?.status).toBe('SKIPPED');
    expect(embedding?.remediation).toContain('Gate 6');
    // A skip must not make the run unhealthy — Gate 1 can pass without a Gate 6 decision.
    expect(report.ok).toBe(true);
  });

  it('--only restricts the run to the named checks', async () => {
    const report = await runChecks(createFakeContext(), { only: ['config-placeholders'] });
    expect(report.checks.map((c) => c.id)).toEqual(['config-placeholders']);
  });
});
