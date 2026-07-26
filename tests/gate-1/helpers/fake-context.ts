/**
 * A fully-faked DoctorContext.
 *
 * Every probe is replaceable, so a test can drive the *real* check code down a specific
 * failure path — expired credentials, a denied model, a missing bucket, an unsupported
 * VECTOR type — and assert on the remediation text that results. No network, no credentials.
 */

import { createConfig, type AppConfig, type EnvSource } from '@ats/core';
import type {
  AgentCoreProbe,
  BedrockProbe,
  CockroachProbe,
  DoctorContext,
  McpProbe,
  S3Probe,
  StsProbe,
} from '@ats/doctor';

/** A complete, valid environment. Individual tests override the keys they care about. */
export const GOOD_ENV: EnvSource = {
  AWS_REGION: 'us-east-1',
  AWS_ACCOUNT_ID: '123456789012',
  BEDROCK_SUPERVISOR_MODEL_ID: 'test.supervisor-model-v1',
  AGENTCORE_RUNTIME_ARN: 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/test',
  AGENTCORE_MEMORY_ID: 'mem-test',
  AGENTCORE_GATEWAY_URL: 'https://gateway.example.invalid/mcp',
  COCKROACH_DATABASE_URL: 'postgresql://ats@test.cockroachlabs.cloud:26257/ats',
  COCKROACH_SSL_ROOT_CERT: '/tmp/cc-ca.crt',
  COCKROACH_MCP_ENDPOINT: 'https://mcp.example.invalid/mcp',
  COCKROACH_MCP_API_KEY: 'test-key',
  S3_POLICY_BUCKET: 'ats-policies-test',
  TICKET_HANDLER_FUNCTION_URL: 'https://fn.example.invalid/',
  WEB_QUEUE_PASSWORD: 'test-password',
  // EMBEDDING_MODEL_ID / EMBEDDING_DIM deliberately absent — Gate 6 decides them.
};

export interface FakeProbes {
  sts?: Partial<StsProbe>;
  bedrock?: Partial<BedrockProbe>;
  agentcore?: Partial<AgentCoreProbe>;
  s3?: Partial<S3Probe>;
  cockroach?: Partial<CockroachProbe> | (() => Promise<CockroachProbe>);
  mcp?: Partial<McpProbe>;
}

export interface FakeContextOptions {
  env?: EnvSource;
  gate?: number;
  probes?: FakeProbes;
}

/** An error shaped the way an AWS SDK error is: the API error code lives on `.name`. */
export function awsError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

/** An error shaped the way a pg/Node error is: a SQLSTATE or errno on `.code`. */
export function pgError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

const HEALTHY = {
  sts: (): StsProbe => ({
    getCallerIdentity: async () => ({
      account: '123456789012',
      arn: 'arn:aws:iam::123456789012:user/builder',
    }),
  }),
  bedrock: (): BedrockProbe => ({
    listFoundationModels: async () => ['test.supervisor-model-v1', 'test.embedding-model-v1'],
    invokeSmallest: async () => undefined,
  }),
  agentcore: (): AgentCoreProbe => ({
    listAgentRuntimes: async () => 0,
    listMemories: async () => 0,
    listGateways: async () => 0,
  }),
  s3: (): S3Probe => ({
    listObjects: async () => 1,
    getObject: async () => 42,
  }),
  cockroach: (): CockroachProbe => ({
    query: async <T>(sql: string): Promise<T[]> => {
      if (/SELECT 1 AS one/i.test(sql)) return [{ one: 1 }] as T[];
      if (/gen_random_uuid/i.test(sql)) {
        return [{ id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301' }] as T[];
      }
      if (/SELECT version/i.test(sql)) return [{ version: 'CockroachDB CCL v25.2.0' }] as T[];
      return [] as T[];
    },
    close: async () => undefined,
  }),
  mcp: (): McpProbe => ({
    listTools: async () => ['run_sql', 'list_tables', 'describe_table'],
  }),
};

export function createFakeContext(options: FakeContextOptions = {}): DoctorContext {
  const config: AppConfig = createConfig(options.env ?? GOOD_ENV);
  const probes = options.probes ?? {};
  let cockroachProbe: CockroachProbe | undefined;
  let disposed = false;

  return {
    config,
    gate: options.gate ?? 1,
    now: () => new Date('2026-07-26T00:00:00.000Z'),
    sts: () => ({ ...HEALTHY.sts(), ...probes.sts }),
    bedrock: () => ({ ...HEALTHY.bedrock(), ...probes.bedrock }),
    agentcore: () => ({ ...HEALTHY.agentcore(), ...probes.agentcore }),
    s3: () => ({ ...HEALTHY.s3(), ...probes.s3 }),
    async cockroach() {
      if (typeof probes.cockroach === 'function') return probes.cockroach();
      cockroachProbe ??= { ...HEALTHY.cockroach(), ...probes.cockroach };
      return cockroachProbe;
    },
    mcp: () => ({ ...HEALTHY.mcp(), ...probes.mcp }),
    async dispose() {
      disposed = true;
      await cockroachProbe?.close();
    },
    // Exposed for assertions about cleanup.
    get wasDisposed() {
      return disposed;
    },
  } as DoctorContext & { wasDisposed: boolean };
}
