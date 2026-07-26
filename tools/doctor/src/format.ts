import type { DoctorReport } from './report.ts';

const GREEN = '\u001b[32m';
const RED = '\u001b[31m';
const YELLOW = '\u001b[33m';
const DIM = '\u001b[2m';
const BOLD = '\u001b[1m';
const RESET = '\u001b[0m';

export interface FormatOptions {
  color?: boolean;
}

/**
 * Human-readable report.
 *
 * The remediation text is the product here. With no IaC, `pnpm doctor` is the only
 * statement of what the infrastructure should look like, so a failure has to read as an
 * instruction — not as a diagnosis the reader still has to interpret.
 */
export function formatReport(report: DoctorReport, options: FormatOptions = {}): string {
  const color = options.color ?? true;
  const paint = (code: string, text: string) => (color ? `${code}${text}${RESET}` : text);

  const lines: string[] = [];
  lines.push('');
  lines.push(
    paint(BOLD, `Infrastructure doctor — Gate ${report.gate}`) +
      paint(DIM, `  ${report.region ?? 'region unresolved'}  ${report.generatedAt}`),
  );
  lines.push('');

  for (const check of report.checks) {
    const badge =
      check.status === 'PASS'
        ? paint(GREEN, 'PASS   ')
        : check.status === 'FAIL'
          ? paint(RED, 'FAIL   ')
          : paint(YELLOW, 'SKIPPED');
    lines.push(`  ${badge}  ${check.title}  ${paint(DIM, `(${check.durationMs}ms)`)}`);
    lines.push(`           ${paint(DIM, check.detail)}`);
    if (check.status !== 'PASS' && check.remediation) {
      const label = check.status === 'FAIL' ? 'Fix' : 'Note';
      lines.push(`           ${paint(BOLD, `${label}:`)} ${wrap(check.remediation, 11)}`);
    }
    lines.push('');
  }

  const { total, passed, failed, skipped } = report.summary;
  const verdict = report.ok
    ? paint(GREEN, `${passed}/${total} checks passed`)
    : paint(RED, `${failed} of ${total} checks FAILED`);
  lines.push(`  ${verdict}${skipped > 0 ? paint(DIM, `, ${skipped} skipped`) : ''}`);

  if (!report.ok) {
    lines.push('');
    lines.push(
      paint(
        DIM,
        '  A doctor failure is authoritative: fix the environment, do not loosen the check.',
      ),
    );
  }
  lines.push('');
  return lines.join('\n');
}

/** Hanging-indent wrap so multi-sentence remediation stays readable in a terminal. */
function wrap(text: string, indent: number, width = 88): string {
  const pad = ' '.repeat(indent);
  const out: string[] = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      if (line.length + word.length + 1 > width) {
        out.push(line);
        line = word;
      } else {
        line = line ? `${line} ${word}` : word;
      }
    }
    if (line) out.push(line);
  }
  return out.join(`\n${pad}      `);
}
