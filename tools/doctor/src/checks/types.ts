import type { DoctorContext } from '../context.ts';
import type { CheckCategory, CheckOutcome } from '../report.ts';

export interface CheckDefinition {
  id: string;
  title: string;
  category: CheckCategory;
  /** The gate from which this check must pass. */
  gate: number;
  /**
   * Checks must not throw — every failure path should return a FAIL with remediation. The
   * runner catches anything that escapes, but a caught throw means the check has no tailored
   * advice, which is the outcome this project is specifically trying to avoid.
   */
  run(ctx: DoctorContext): Promise<CheckOutcome>;
}

/** Extracts something loggable from an unknown thrown value. */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    const name = (error as { name?: string }).name ?? 'Error';
    return `${name}: ${error.message}`;
  }
  return String(error);
}

/** AWS SDK errors carry the API error code on `.name`. */
export function errorName(error: unknown): string {
  return error instanceof Error ? error.name : '';
}

/**
 * Error codes that mean "your credentials are bad", not "this service is missing".
 *
 * Worth naming explicitly: every AWS call fails with one of these when credentials are wrong,
 * so a check that lumps them in with its own domain failure will confidently give the wrong
 * advice — sending someone to change regions when the real fix is `aws configure`. The
 * misdiagnosis is more expensive than no diagnosis.
 */
const CREDENTIAL_ERROR_NAMES = new Set([
  'UnrecognizedClientException',
  'InvalidClientTokenId',
  'InvalidSignatureException',
  'ExpiredToken',
  'ExpiredTokenException',
  'CredentialsProviderError',
  'CredentialsError',
  'AuthFailure',
]);

export function isCredentialError(error: unknown): boolean {
  return CREDENTIAL_ERROR_NAMES.has(errorName(error));
}

/** Shared remediation for a credential-shaped failure, so every check says the same thing. */
export function credentialRemediation(): string {
  return (
    'This is a credentials failure, not a problem with the service being checked. Resolve ' +
    'the aws-credentials check first — refresh your session (`aws sso login --profile ' +
    '<your-profile>`) or re-issue keys (`aws configure --profile <name>`) — then re-run ' +
    '`pnpm doctor`. Do not change AWS_REGION or request service access on the basis of this ' +
    'error; it would not have worked with valid credentials either way.'
  );
}
