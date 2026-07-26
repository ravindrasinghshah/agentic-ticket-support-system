/**
 * The doctor report shape.
 *
 * `fixtures/gate-1/expected/doctor-report.json` is the committed example of this shape, and
 * tests/gate-1/contract asserts every check conforms to it — including the rule that a
 * non-PASS result always carries non-empty remediation text. A check that fails silently is
 * itself a test failure: with no IaC, this report is the project's only drift detector, so a
 * failure that does not say what to do about it is worthless.
 */

export const REPORT_VERSION = 1 as const;

export type CheckStatus = 'PASS' | 'FAIL' | 'SKIPPED';

export type CheckCategory = 'config' | 'aws' | 'bedrock' | 'agentcore' | 'cockroachdb' | 's3';

/** What a check returns. The runner adds id/title/category/gate/durationMs around it. */
export interface CheckOutcome {
  status: CheckStatus;
  /** What was actually observed — the evidence, not a restatement of the title. */
  detail: string;
  /** The exact next step. Required on FAIL and SKIPPED; omitted on PASS. */
  remediation?: string;
}

export interface CheckResult {
  id: string;
  title: string;
  category: CheckCategory;
  /** The gate from which this check must pass. */
  gate: number;
  status: CheckStatus;
  detail: string;
  remediation: string | null;
  durationMs: number;
}

export interface DoctorReport {
  reportVersion: typeof REPORT_VERSION;
  generatedAt: string;
  /** The gate the run was scoped to; checks introduced later are reported as SKIPPED. */
  gate: number;
  region: string | null;
  /** True when no check FAILed. SKIPPED does not make a report unhealthy. */
  ok: boolean;
  summary: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
  };
  checks: CheckResult[];
}

export function pass(detail: string): CheckOutcome {
  return { status: 'PASS', detail };
}

export function fail(detail: string, remediation: string): CheckOutcome {
  return { status: 'FAIL', detail, remediation };
}

export function skip(detail: string, remediation: string): CheckOutcome {
  return { status: 'SKIPPED', detail, remediation };
}

/** Runtime validation of a single result against the documented shape. */
export function validateCheckResult(result: CheckResult): string[] {
  const problems: string[] = [];
  const requiredStrings: Array<keyof CheckResult> = ['id', 'title', 'category', 'detail'];
  for (const key of requiredStrings) {
    const value = result[key];
    if (typeof value !== 'string' || value.trim() === '') {
      problems.push(`check '${result.id}': '${String(key)}' must be a non-empty string`);
    }
  }
  if (!['PASS', 'FAIL', 'SKIPPED'].includes(result.status)) {
    problems.push(`check '${result.id}': unknown status '${result.status}'`);
  }
  if (typeof result.gate !== 'number' || result.gate < 1) {
    problems.push(`check '${result.id}': 'gate' must be a positive number`);
  }
  if (typeof result.durationMs !== 'number' || result.durationMs < 0) {
    problems.push(`check '${result.id}': 'durationMs' must be a non-negative number`);
  }
  if (result.status !== 'PASS') {
    if (typeof result.remediation !== 'string' || result.remediation.trim() === '') {
      problems.push(
        `check '${result.id}': status is ${result.status} but remediation is empty — ` +
          'every non-passing check must state the exact next step',
      );
    }
  }
  return problems;
}

export function validateReport(report: DoctorReport): string[] {
  const problems: string[] = [];
  if (report.reportVersion !== REPORT_VERSION) {
    problems.push(`reportVersion must be ${REPORT_VERSION}, got ${report.reportVersion}`);
  }
  if (Number.isNaN(Date.parse(report.generatedAt))) {
    problems.push(`generatedAt is not an ISO timestamp: '${report.generatedAt}'`);
  }
  const counted = {
    total: report.checks.length,
    passed: report.checks.filter((c) => c.status === 'PASS').length,
    failed: report.checks.filter((c) => c.status === 'FAIL').length,
    skipped: report.checks.filter((c) => c.status === 'SKIPPED').length,
  };
  for (const key of ['total', 'passed', 'failed', 'skipped'] as const) {
    if (report.summary[key] !== counted[key]) {
      problems.push(`summary.${key} is ${report.summary[key]} but ${counted[key]} were counted`);
    }
  }
  if (report.ok !== (counted.failed === 0)) {
    problems.push(`ok is ${report.ok} but ${counted.failed} checks failed`);
  }
  for (const check of report.checks) problems.push(...validateCheckResult(check));
  return problems;
}
