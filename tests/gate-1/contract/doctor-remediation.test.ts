/**
 * Fault injection: every remediation path exercised, against real check code, without
 * breaking real infrastructure.
 *
 * The assertions are deliberately about *content* — does the advice name the actual fix? —
 * because "has some remediation text" is a bar any placeholder string would clear.
 * `fixtures/gate-1/inputs/faults/faults.json` is the catalogue these mirror.
 */

import { describe, expect, it } from 'vitest';
import {
  agentCoreAvailableCheck,
  awsCredentialsCheck,
  bedrockReachableCheck,
  cockroachConnectivityCheck,
  cockroachMcpCheck,
  cockroachVectorSupportCheck,
  configPlaceholdersCheck,
  s3PolicyBucketCheck,
  supervisorModelAccessCheck,
} from '@ats/doctor';
import type { CockroachProbe } from '@ats/doctor';
import { GOOD_ENV, awsError, createFakeContext, pgError } from '../helpers/fake-context.ts';

describe('configuration', () => {
  it('lists every outstanding value with where to get it', async () => {
    const outcome = await configPlaceholdersCheck.run(
      createFakeContext({ env: { ...GOOD_ENV, AWS_REGION: 'REPLACE_ME' } }),
    );

    expect(outcome.status).toBe('FAIL');
    expect(outcome.detail).toContain('AWS_REGION');
    expect(outcome.remediation).toContain('AWS_REGION');
    expect(outcome.remediation).toContain('still REPLACE_ME');
    expect(outcome.remediation).toContain('docs/CONFIGURATION.md');
    expect(outcome.remediation).toContain('docs/PROVISIONING.md');
  });

  it('passes when everything this gate needs is present', async () => {
    const outcome = await configPlaceholdersCheck.run(createFakeContext({ gate: 1 }));
    expect(outcome.status).toBe('PASS');
  });

  it('fails at Gate 6 for the same environment that passes at Gate 1', async () => {
    const outcome = await configPlaceholdersCheck.run(createFakeContext({ gate: 6 }));
    expect(outcome.status).toBe('FAIL');
    expect(outcome.remediation).toContain('EMBEDDING_MODEL_ID');
  });
});

describe('AWS credentials', () => {
  it('expired credentials → refresh them', async () => {
    const outcome = await awsCredentialsCheck.run(
      createFakeContext({
        probes: {
          sts: {
            getCallerIdentity: async () =>
              Promise.reject(
                awsError('ExpiredTokenException', 'The security token included is expired'),
              ),
          },
        },
      }),
    );

    expect(outcome.status).toBe('FAIL');
    expect(outcome.remediation).toContain('aws sso login');
    expect(outcome.remediation).toContain('aws configure');
  });

  it('no credentials at all → configure a profile', async () => {
    const outcome = await awsCredentialsCheck.run(
      createFakeContext({
        probes: {
          sts: {
            getCallerIdentity: async () =>
              Promise.reject(awsError('CredentialsProviderError', 'Could not load credentials')),
          },
        },
      }),
    );

    expect(outcome.status).toBe('FAIL');
    expect(outcome.remediation).toContain('AWS_PROFILE');
  });

  it('right credentials, wrong account → name both accounts', async () => {
    // Silent and expensive: every subsequent check would pass or fail against an
    // environment that is not the one being built.
    const outcome = await awsCredentialsCheck.run(
      createFakeContext({
        probes: {
          sts: {
            getCallerIdentity: async () => ({
              account: '999999999999',
              arn: 'arn:aws:iam::999999999999:user/someone-else',
            }),
          },
        },
      }),
    );

    expect(outcome.status).toBe('FAIL');
    expect(outcome.detail).toContain('999999999999');
    expect(outcome.detail).toContain('123456789012');
    expect(outcome.remediation).toContain('AWS_PROFILE');
    expect(outcome.remediation).toContain('AWS_ACCOUNT_ID');
  });

  it('unresolved region → surfaces the configuration error, not an SDK error', async () => {
    const outcome = await awsCredentialsCheck.run(
      createFakeContext({ env: { ...GOOD_ENV, AWS_REGION: 'REPLACE_ME' } }),
    );

    expect(outcome.status).toBe('FAIL');
    expect(outcome.remediation).toContain('AWS_REGION');
    expect(outcome.remediation).toContain('REPLACE_ME');
  });
});

describe('Bedrock', () => {
  it('the silent gap: API reachable but the model is not approved', async () => {
    const outcome = await supervisorModelAccessCheck.run(
      createFakeContext({
        probes: {
          bedrock: {
            invokeSmallest: async () =>
              Promise.reject(
                awsError('AccessDeniedException', "You don't have access to the model"),
              ),
          },
        },
      }),
    );

    expect(outcome.status).toBe('FAIL');
    expect(outcome.remediation).toContain('Model access');
    expect(outcome.remediation).toContain('bedrock:InvokeModel');
    expect(outcome.remediation).toContain('test.supervisor-model-v1');
  });

  it('an invalid model ID → resolve it from the live service, never memory', async () => {
    const outcome = await supervisorModelAccessCheck.run(
      createFakeContext({
        probes: {
          bedrock: {
            invokeSmallest: async () =>
              Promise.reject(awsError('ValidationException', 'invalid model identifier')),
          },
        },
      }),
    );

    expect(outcome.status).toBe('FAIL');
    expect(outcome.remediation).toContain('list-foundation-models');
    expect(outcome.remediation).toContain('BEDROCK_SUPERVISOR_MODEL_ID');
    expect(outcome.remediation).toContain('recalled from memory');
  });

  it('throttling → says access is unconfirmed rather than claiming denial', async () => {
    const outcome = await supervisorModelAccessCheck.run(
      createFakeContext({
        probes: {
          bedrock: {
            invokeSmallest: async () =>
              Promise.reject(awsError('ThrottlingException', 'Too many requests')),
          },
        },
      }),
    );

    expect(outcome.status).toBe('FAIL');
    expect(outcome.remediation).toContain('could not be confirmed');
  });

  it('a region with no Bedrock endpoint → change the region', async () => {
    const outcome = await bedrockReachableCheck.run(
      createFakeContext({
        probes: {
          bedrock: {
            listFoundationModels: async () =>
              Promise.reject(awsError('UnknownEndpoint', 'no endpoint')),
          },
        },
      }),
    );

    expect(outcome.status).toBe('FAIL');
    expect(outcome.remediation).toContain('AWS_REGION');
  });
});

describe('AgentCore', () => {
  it('unavailable in the region → blocks the build, and says so', async () => {
    const outcome = await agentCoreAvailableCheck.run(
      createFakeContext({
        probes: {
          agentcore: {
            listAgentRuntimes: async () =>
              Promise.reject(awsError('UnknownEndpoint', 'no endpoint in eu-west-3')),
          },
        },
      }),
    );

    expect(outcome.status).toBe('FAIL');
    expect(outcome.remediation).toContain('AgentCore is not available');
    expect(outcome.remediation).toContain('AWS_REGION');
    // The advice must not quietly sanction hosting the supervisor somewhere else.
    expect(outcome.remediation).toContain('architecture change');
  });

  it('a partial outage is caught — Memory failing is as fatal as Runtime failing', async () => {
    const outcome = await agentCoreAvailableCheck.run(
      createFakeContext({
        probes: {
          agentcore: {
            listMemories: async () => Promise.reject(awsError('AccessDeniedException', 'denied')),
          },
        },
      }),
    );

    expect(outcome.status).toBe('FAIL');
    expect(outcome.detail).toContain('Memory');
    expect(outcome.remediation).toContain('ListMemories');
  });

  it('empty lists are a PASS — nothing is provisioned yet at Gate 1', async () => {
    const outcome = await agentCoreAvailableCheck.run(createFakeContext());
    expect(outcome.status).toBe('PASS');
  });
});

describe('bad credentials are never misdiagnosed as a missing service', () => {
  // Caught by smoke-testing the live probes with invalid keys: every AWS call fails with
  // UnrecognizedClientException, and a check that folds that into its own domain failure
  // gives confidently wrong advice — "change your region" for an `aws configure` problem.
  // A misdiagnosis is worse than no diagnosis, so each of these is pinned.

  const credentialErrors = [
    'UnrecognizedClientException',
    'InvalidClientTokenId',
    'ExpiredTokenException',
    'InvalidSignatureException',
  ];

  it.each(credentialErrors)('AgentCore does not blame the region for %s', async (name) => {
    const outcome = await agentCoreAvailableCheck.run(
      createFakeContext({
        probes: {
          agentcore: {
            listAgentRuntimes: async () => Promise.reject(awsError(name, 'invalid token')),
          },
        },
      }),
    );

    expect(outcome.status).toBe('FAIL');
    expect(outcome.remediation).toContain('credentials failure');
    expect(outcome.remediation).toContain('Do not change AWS_REGION');
    expect(outcome.remediation).not.toContain('AgentCore is not available');
  });

  it.each(credentialErrors)('the model-access check does not blame model access for %s', async (name) => {
    const outcome = await supervisorModelAccessCheck.run(
      createFakeContext({
        probes: {
          bedrock: {
            invokeSmallest: async () => Promise.reject(awsError(name, 'invalid token')),
          },
        },
      }),
    );

    expect(outcome.status).toBe('FAIL');
    expect(outcome.remediation).toContain('credentials failure');
    expect(outcome.remediation).not.toContain('Model access');
  });

  it('a genuine AccessDeniedException is still reported as an access problem', async () => {
    // The credential branch must not swallow real authorization failures.
    const outcome = await supervisorModelAccessCheck.run(
      createFakeContext({
        probes: {
          bedrock: {
            invokeSmallest: async () =>
              Promise.reject(awsError('AccessDeniedException', 'no access to model')),
          },
        },
      }),
    );

    expect(outcome.remediation).toContain('Model access');
    expect(outcome.remediation).not.toContain('credentials failure');
  });
});

describe('CockroachDB', () => {
  it('a missing CA certificate → points at COCKROACH_SSL_ROOT_CERT', async () => {
    const outcome = await cockroachConnectivityCheck.run(
      createFakeContext({
        probes: {
          cockroach: async () =>
            Promise.reject(pgError('ENOENT', "no such file or directory, open 'cc-ca.crt'")),
        },
      }),
    );

    expect(outcome.status).toBe('FAIL');
    expect(outcome.remediation).toContain('COCKROACH_SSL_ROOT_CERT');
    expect(outcome.remediation).toContain('cc-ca.crt');
  });

  it('a bad password → regenerate it in SQL Users', async () => {
    const outcome = await cockroachConnectivityCheck.run(
      createFakeContext({
        probes: {
          cockroach: async () => Promise.reject(pgError('28P01', 'password authentication failed')),
        },
      }),
    );

    expect(outcome.status).toBe('FAIL');
    expect(outcome.remediation).toContain('SQL Users');
  });

  it('an unreachable host → re-copy the connection string', async () => {
    const outcome = await cockroachConnectivityCheck.run(
      createFakeContext({
        probes: {
          cockroach: async () => Promise.reject(pgError('ENOTFOUND', 'getaddrinfo ENOTFOUND')),
        },
      }),
    );

    expect(outcome.status).toBe('FAIL');
    expect(outcome.remediation).toContain('COCKROACH_DATABASE_URL');
  });

  it('a TLS failure → does not suggest disabling verification', async () => {
    const outcome = await cockroachConnectivityCheck.run(
      createFakeContext({
        probes: {
          cockroach: async () =>
            Promise.reject(new Error('unable to verify the first certificate')),
        },
      }),
    );

    expect(outcome.status).toBe('FAIL');
    expect(outcome.remediation).toContain('Do not');
    expect(outcome.remediation).toContain('disable certificate verification');
  });

  it('VECTOR type unsupported → names it a blocker for Gate 6', async () => {
    const outcome = await cockroachVectorSupportCheck.run(
      createFakeContext({ probes: { cockroach: vectorProbe({ failOn: /CREATE TABLE/i }) } }),
    );

    expect(outcome.status).toBe('FAIL');
    expect(outcome.detail).toContain('VECTOR column type was rejected');
    expect(outcome.remediation).toContain('vector support');
    expect(outcome.remediation).toContain('Gate 6');
  });

  it('CREATE VECTOR INDEX unsupported → distinguished from the type being missing', async () => {
    const outcome = await cockroachVectorSupportCheck.run(
      createFakeContext({ probes: { cockroach: vectorProbe({ failOn: /CREATE VECTOR INDEX/i }) } }),
    );

    expect(outcome.status).toBe('FAIL');
    expect(outcome.detail).toContain('VECTOR column type works');
    expect(outcome.remediation).toContain('full scan');
  });

  it('leaves no scratch table behind, on success or on failure', async () => {
    const executed: string[] = [];
    const probe = vectorProbe({ record: executed });

    await cockroachVectorSupportCheck.run(createFakeContext({ probes: { cockroach: probe } }));
    expectDropped(executed);

    const executedAfterFailure: string[] = [];
    await cockroachVectorSupportCheck.run(
      createFakeContext({
        probes: {
          cockroach: vectorProbe({ failOn: /CREATE VECTOR INDEX/i, record: executedAfterFailure }),
        },
      }),
    );
    expectDropped(executedAfterFailure);
  });

  it('MCP auth failure → sanctions the SqlAdapter fallback rather than blocking', async () => {
    // ARCHITECTURE.md §11 put data access behind an adapter precisely so this is a config
    // flip, not a gate. The remediation has to say that, or someone will treat it as fatal.
    const outcome = await cockroachMcpCheck.run(
      createFakeContext({
        probes: {
          mcp: { listTools: async () => Promise.reject(new Error('401 Unauthorized')) },
        },
      }),
    );

    expect(outcome.status).toBe('FAIL');
    expect(outcome.remediation).toContain('DB_ACCESS_MODE=sql');
    expect(outcome.remediation).toContain('COCKROACH_MCP_API_KEY');
    expect(outcome.remediation).toContain('docs/PROGRESS.md');
  });
});

describe('S3 policy bucket', () => {
  it('a missing bucket → create it or fix S3_POLICY_BUCKET', async () => {
    const outcome = await s3PolicyBucketCheck.run(
      createFakeContext({
        probes: {
          s3: {
            listObjects: async () => Promise.reject(awsError('NoSuchBucket', 'no such bucket')),
          },
        },
      }),
    );

    expect(outcome.status).toBe('FAIL');
    expect(outcome.remediation).toContain('S3_POLICY_BUCKET');
    expect(outcome.remediation).toContain('s3 mb');
  });

  it('a listable bucket with no probe object still fails — the permissions differ', async () => {
    const outcome = await s3PolicyBucketCheck.run(
      createFakeContext({
        probes: {
          s3: { getObject: async () => Promise.reject(awsError('NoSuchKey', 'no such key')) },
        },
      }),
    );

    expect(outcome.status).toBe('FAIL');
    expect(outcome.remediation).toContain('_doctor-probe.json');
    expect(outcome.remediation).toContain('separate permissions');
  });

  it('GetObject denied → names the exact permission the Lambdas will need', async () => {
    const outcome = await s3PolicyBucketCheck.run(
      createFakeContext({
        probes: {
          s3: { getObject: async () => Promise.reject(awsError('AccessDenied', 'Access Denied')) },
        },
      }),
    );

    expect(outcome.status).toBe('FAIL');
    expect(outcome.remediation).toContain('s3:GetObject');
  });

  it('a bucket in the wrong region → explains the region mismatch', async () => {
    const outcome = await s3PolicyBucketCheck.run(
      createFakeContext({
        probes: {
          s3: {
            listObjects: async () =>
              Promise.reject(awsError('PermanentRedirect', 'bucket is in another region')),
          },
        },
      }),
    );

    expect(outcome.status).toBe('FAIL');
    expect(outcome.remediation).toContain('region');
  });
});

// ── helpers ──────────────────────────────────────────────────────────────────────────────

function vectorProbe(options: { failOn?: RegExp; record?: string[] } = {}) {
  return async (): Promise<CockroachProbe> => ({
    async query<T>(sql: string): Promise<T[]> {
      options.record?.push(sql);
      if (options.failOn?.test(sql)) {
        throw pgError('0A000', `unimplemented: ${sql.slice(0, 40)}`);
      }
      return [] as T[];
    },
    close: async () => undefined,
  });
}

function expectDropped(executed: string[]): void {
  const created = executed.find((sql) => /^CREATE TABLE/i.test(sql));
  expect(created, 'the check should have created a scratch table').toBeDefined();
  const table = /CREATE TABLE (\S+)/i.exec(created ?? '')?.[1];
  expect(table).toMatch(/^_doctor_vector_probe_[0-9a-f]+$/);
  // Gate 1 creates no schema: the cluster must be left exactly as it was found.
  expect(executed.some((sql) => sql === `DROP TABLE IF EXISTS ${table}`)).toBe(true);
}
