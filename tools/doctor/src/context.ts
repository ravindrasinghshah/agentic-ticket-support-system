/**
 * The probe interfaces every doctor check runs against, and the live implementations.
 *
 * Checks never construct an AWS or database client themselves — they take one from the
 * context. That is what makes the fault-injection fixtures possible: a test binds a probe
 * that throws `ExpiredTokenException` or `AccessDeniedException` and exercises the real
 * check code and its real remediation text, without touching (or breaking) live
 * infrastructure.
 */

import type { AppConfig } from '@ats/core';

export interface CallerIdentity {
  account: string;
  arn: string;
}

export interface StsProbe {
  getCallerIdentity(): Promise<CallerIdentity>;
}

export interface BedrockProbe {
  /** Control-plane reachability + IAM. */
  listFoundationModels(): Promise<string[]>;
  /**
   * A minimal Converse call. This is the only way to prove access is actually *granted* —
   * ListFoundationModels succeeds happily for models the account cannot invoke, which is
   * the classic silent gap this check exists to catch.
   */
  invokeSmallest(modelId: string): Promise<void>;
}

export interface AgentCoreProbe {
  listAgentRuntimes(): Promise<number>;
  listMemories(): Promise<number>;
  listGateways(): Promise<number>;
}

export interface S3Probe {
  listObjects(bucket: string): Promise<number>;
  getObject(bucket: string, key: string): Promise<number>;
}

export interface CockroachProbe {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  close(): Promise<void>;
}

export interface McpProbe {
  listTools(): Promise<string[]>;
}

export interface DoctorContext {
  config: AppConfig;
  /**
   * The gate this run is scoped to. Checks introduced by a later gate report SKIPPED, and
   * the config check only demands values that gate actually needs.
   */
  gate: number;
  now: () => Date;
  sts(): StsProbe;
  bedrock(): BedrockProbe;
  agentcore(): AgentCoreProbe;
  s3(): S3Probe;
  /** Memoized — the three CockroachDB checks share one connection. */
  cockroach(): Promise<CockroachProbe>;
  mcp(): McpProbe;
  /** Releases anything the context opened. Always called by the runner. */
  dispose(): Promise<void>;
}
