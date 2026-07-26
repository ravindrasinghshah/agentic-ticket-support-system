import { ALL_CHECKS, type CheckDefinition } from './checks/index.ts';
import { describeError } from './checks/types.ts';
import type { DoctorContext } from './context.ts';
import {
  REPORT_VERSION,
  type CheckResult,
  type DoctorReport,
} from './report.ts';

export interface RunOptions {
  /** Restrict the run to these check ids. */
  only?: string[];
  /** Checks to use. Defaults to ALL_CHECKS; tests substitute their own. */
  checks?: readonly CheckDefinition[];
}

export async function runChecks(
  ctx: DoctorContext,
  options: RunOptions = {},
): Promise<DoctorReport> {
  const catalogue = options.checks ?? ALL_CHECKS;
  const selected = options.only?.length
    ? catalogue.filter((check) => options.only?.includes(check.id))
    : catalogue;

  const results: CheckResult[] = [];

  for (const check of selected) {
    const startedAt = Date.now();
    let outcome;

    if (check.gate > ctx.gate) {
      // A check belonging to a later gate is reported, not silently omitted — so the
      // report always shows the full inventory and what is not yet being enforced.
      outcome = {
        status: 'SKIPPED' as const,
        detail: `Not required until Gate ${check.gate}; this run is scoped to Gate ${ctx.gate}.`,
        remediation:
          `Nothing to do now. Re-run with \`pnpm doctor --gate ${check.gate}\` once you ` +
          `start Gate ${check.gate}, when this becomes a hard check.`,
      };
    } else {
      try {
        outcome = await check.run(ctx);
      } catch (error) {
        // A check should handle its own failures and give tailored advice. Reaching here
        // means it did not, so say so plainly rather than printing a stack trace and
        // leaving the user to guess.
        outcome = {
          status: 'FAIL' as const,
          detail: `Check threw instead of reporting: ${describeError(error)}`,
          remediation:
            `The '${check.id}' check has a bug — it threw instead of returning a FAIL with ` +
            'remediation. Fix the check in tools/doctor/src/checks/ so this failure mode ' +
            'produces actionable advice. The underlying environment problem is in the ' +
            'detail above.',
        };
      }
    }

    results.push({
      id: check.id,
      title: check.title,
      category: check.category,
      gate: check.gate,
      status: outcome.status,
      detail: outcome.detail,
      remediation: outcome.remediation ?? null,
      durationMs: Date.now() - startedAt,
    });
  }

  const failed = results.filter((r) => r.status === 'FAIL').length;

  return {
    reportVersion: REPORT_VERSION,
    generatedAt: ctx.now().toISOString(),
    gate: ctx.gate,
    region: safeRegion(ctx),
    ok: failed === 0,
    summary: {
      total: results.length,
      passed: results.filter((r) => r.status === 'PASS').length,
      failed,
      skipped: results.filter((r) => r.status === 'SKIPPED').length,
    },
    checks: results,
  };
}

function safeRegion(ctx: DoctorContext): string | null {
  try {
    return ctx.config.awsRegion();
  } catch {
    return null;
  }
}
