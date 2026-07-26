/**
 * `pnpm check:config`, absorbed into the doctor (plan.md, "The placeholder and config
 * system"). The activation checklist, executable.
 */

import { ConfigurationError } from '@ats/core';
import { fail, pass, type CheckOutcome } from '../report.ts';
import type { CheckDefinition } from './types.ts';
import { describeError } from './types.ts';

export const configPlaceholdersCheck: CheckDefinition = {
  id: 'config-placeholders',
  title: 'Every configuration value required by this gate is filled in',
  category: 'config',
  gate: 1,
  async run(ctx): Promise<CheckOutcome> {
    let audit;
    try {
      audit = ctx.config.audit(ctx.gate);
    } catch (error) {
      return fail(
        describeError(error),
        'The configuration manifest could not be read. This is a code fault in ' +
          'packages/core/src/manifest.ts, not an environment problem.',
      );
    }

    if (audit.outstanding.length === 0) {
      const skipped =
        audit.skipped.length > 0 ? ` (${audit.skipped.length} optional left unset)` : '';
      return pass(
        `${audit.satisfied.length} configuration values resolved, none outstanding${skipped}.`,
      );
    }

    const lines = audit.outstanding.map(
      (item) =>
        `  • ${item.key} — ${item.reason === 'placeholder' ? 'still REPLACE_ME' : 'not set'} ` +
        `(needed from Gate ${item.gate})\n      ${item.description}\n      Obtain it: ${item.source}`,
    );

    return fail(
      `${audit.outstanding.length} configuration value(s) outstanding: ` +
        audit.outstanding.map((item) => item.key).join(', '),
      `Fill these into .env (copy .env.example if you have not yet):\n${lines.join('\n')}\n` +
        '  Every one is documented in docs/CONFIGURATION.md, and the by-hand steps that ' +
        'produce them are in docs/PROVISIONING.md.',
    );
  },
};

/** Narrow re-export so the runner can special-case configuration failures if it wants to. */
export { ConfigurationError };
