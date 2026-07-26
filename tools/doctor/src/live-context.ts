/**
 * Live probes — the ones that actually talk to AWS and CockroachDB.
 *
 * Every client is constructed lazily, so `pnpm doctor --only config-placeholders` needs no
 * credentials at all, and a check whose configuration is still REPLACE_ME fails on the
 * config error rather than on a confusing SDK error.
 */

import { BedrockClient, ListFoundationModelsCommand } from '@aws-sdk/client-bedrock';
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import {
  BedrockAgentCoreControlClient,
  ListAgentRuntimesCommand,
  ListGatewaysCommand,
  ListMemoriesCommand,
} from '@aws-sdk/client-bedrock-agentcore-control';
import { GetObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { readFileSync } from 'node:fs';
import pg from 'pg';

import type { AppConfig } from '@ats/core';
import type {
  AgentCoreProbe,
  BedrockProbe,
  CockroachProbe,
  DoctorContext,
  McpProbe,
  S3Probe,
  StsProbe,
} from './context.ts';

export function createLiveContext(config: AppConfig, gate: number): DoctorContext {
  let cockroachProbe: CockroachProbe | undefined;

  return {
    config,
    gate,
    now: () => new Date(),

    sts(): StsProbe {
      const client = new STSClient({ region: config.awsRegion() });
      return {
        async getCallerIdentity() {
          const out = await client.send(new GetCallerIdentityCommand({}));
          return { account: out.Account ?? '', arn: out.Arn ?? '' };
        },
      };
    },

    bedrock(): BedrockProbe {
      const region = config.awsRegion();
      const control = new BedrockClient({ region });
      const runtime = new BedrockRuntimeClient({ region });
      return {
        async listFoundationModels() {
          const out = await control.send(new ListFoundationModelsCommand({}));
          return (out.modelSummaries ?? []).flatMap((m) => (m.modelId ? [m.modelId] : []));
        },
        async invokeSmallest(modelId: string) {
          await runtime.send(
            new ConverseCommand({
              modelId,
              messages: [{ role: 'user', content: [{ text: 'ping' }] }],
              inferenceConfig: { maxTokens: 1, temperature: 0 },
            }),
          );
        },
      };
    },

    agentcore(): AgentCoreProbe {
      const client = new BedrockAgentCoreControlClient({ region: config.awsRegion() });
      return {
        async listAgentRuntimes() {
          const out = await client.send(new ListAgentRuntimesCommand({ maxResults: 1 }));
          return out.agentRuntimes?.length ?? 0;
        },
        async listMemories() {
          const out = await client.send(new ListMemoriesCommand({ maxResults: 1 }));
          return out.memories?.length ?? 0;
        },
        async listGateways() {
          const out = await client.send(new ListGatewaysCommand({ maxResults: 1 }));
          return out.items?.length ?? 0;
        },
      };
    },

    s3(): S3Probe {
      const client = new S3Client({ region: config.awsRegion() });
      return {
        async listObjects(bucket: string) {
          const out = await client.send(
            new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 10 }),
          );
          return out.KeyCount ?? 0;
        },
        async getObject(bucket: string, key: string) {
          const out = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
          const body = await out.Body?.transformToByteArray();
          return body?.byteLength ?? 0;
        },
      };
    },

    async cockroach(): Promise<CockroachProbe> {
      if (cockroachProbe) return cockroachProbe;

      const client = new pg.Client({
        connectionString: config.cockroachDatabaseUrl(),
        ssl: {
          // verify-full: the CA certificate downloaded during provisioning must actually
          // validate the cluster. A doctor that accepted any certificate would not be
          // testing the connection the Lambdas will make.
          ca: readFileSync(config.cockroachSslRootCert(), 'utf8'),
          rejectUnauthorized: true,
        },
        connectionTimeoutMillis: 15_000,
      });
      await client.connect();

      cockroachProbe = {
        async query<T = Record<string, unknown>>(sql: string, params?: unknown[]) {
          const result = await client.query(sql, params);
          return result.rows as T[];
        },
        async close() {
          await client.end();
        },
      };
      return cockroachProbe;
    },

    mcp(): McpProbe {
      return {
        async listTools() {
          const endpoint = config.cockroachMcpEndpoint();
          const apiKey = config.cockroachMcpApiKey();
          const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
            requestInit: { headers: { Authorization: `Bearer ${apiKey}` } },
          });
          const client = new McpClient({ name: 'ats-doctor', version: '0.1.0' });
          try {
            await client.connect(transport);
            const result = await client.listTools();
            return result.tools.map((tool) => tool.name);
          } finally {
            await client.close().catch(() => undefined);
          }
        },
      };
    },

    async dispose() {
      await cockroachProbe?.close().catch(() => undefined);
      cockroachProbe = undefined;
    },
  };
}
