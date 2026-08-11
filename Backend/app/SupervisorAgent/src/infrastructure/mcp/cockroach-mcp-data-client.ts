import { McpClient, type JSONValue as McpJsonValue } from '@strands-agents/sdk';
import { z } from 'zod';
import {
  agentJobSchema,
  conversationMessageSchema,
  jobStatusSchema,
  planSchema,
  type AgentJob,
  type ConversationMessage,
  type JobMessage,
  type ResolutionPlan,
} from '../../domain/contracts.js';
import type { AgentDataPort, ClaimResult, ToolCallPermit } from '../../application/ports.js';
import {
  positiveIntegerEnvironment,
  requiredEnvironment,
} from '../../config/environment.js';

type McpTool = Awaited<ReturnType<McpClient['listTools']>>[number];
export const COCKROACH_CLOUD_MCP_ENDPOINT = 'https://cockroachlabs.cloud/mcp';

const REQUIRED_TOOLS = new Set([
  'ticket_exists',
  'create_job',
  'get_job',
  'fail_job',
  'claim_job',
  'load_ticket_context',
  'load_conversation',
  'save_plan',
  'begin_tool_call',
  'record_tool_result',
  'get_tracking',
  'search_resolutions',
  'record_ticket_note',
  'append_message',
  'complete_job',
  'escalate_job',
]);

const claimResultSchema = z.object({
  claimed: z.boolean(),
  status: jobStatusSchema,
  currentPlan: planSchema.nullable().optional(),
  planRequired: z.boolean().optional(),
  cycleCount: z.number().int().nonnegative().optional(),
  toolResults: z.array(z.unknown()).optional(),
});

const toolCallPermitSchema = z.object({
  allowed: z.boolean(),
  cycleCount: z.number().int().nonnegative(),
  reason: z.enum(['PLAN_REQUIRED', 'CYCLE_LIMIT']).optional(),
});

const mutationResultSchema = z.object({ applied: z.boolean() });
const existenceSchema = z.object({ exists: z.boolean() });
const conversationSchema = z.object({ messages: z.array(conversationMessageSchema) });

function unwrapMcpResult(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  if ('isError' in value && (value as { isError?: unknown }).isError === true) {
    throw new Error('MCP tool returned an error');
  }
  if ('structuredContent' in value) {
    const structured = (value as { structuredContent?: unknown }).structuredContent;
    if (structured !== undefined) return structured;
  }
  if (!('content' in value)) return value;

  const content = (value as { content?: unknown }).content;
  if (!Array.isArray(content)) return value;

  const text = content
    .filter(
      (item): item is { type: 'text'; text: string } =>
        Boolean(item) &&
        typeof item === 'object' &&
        (item as { type?: unknown }).type === 'text' &&
        typeof (item as { text?: unknown }).text === 'string',
    )
    .map((item) => item.text)
    .join('\n');

  if (!text) return value;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export function cockroachCloudMcpHeaders(
  clusterId: string,
  apiKey: string,
): Record<string, string> {
  return {
    'mcp-cluster-id': clusterId,
    Authorization: `Bearer ${apiKey}`,
  };
}

export class CockroachMcpDataClient implements AgentDataPort {
  private tools: Map<string, McpTool> | undefined;

  constructor(
    private readonly client: McpClient,
    private readonly timeoutMs: number,
  ) {}

  async disconnect(): Promise<void> {
    await this.client.disconnect();
  }

  private async getTools(): Promise<Map<string, McpTool>> {
    if (this.tools) return this.tools;
    const listed = await this.client.listTools();
    const tools = new Map(listed.map((item) => [item.name, item]));
    const missing = [...REQUIRED_TOOLS].filter((name) => !tools.has(name));
    if (missing.length) {
      throw new Error(`MCP server is missing required tools: ${missing.join(', ')}`);
    }
    this.tools = tools;
    return tools;
  }

  private async call(name: string, input: Record<string, unknown>): Promise<unknown> {
    if (!REQUIRED_TOOLS.has(name)) throw new Error(`MCP tool is not allowlisted: ${name}`);
    const tool = (await this.getTools()).get(name);
    if (!tool) throw new Error(`MCP tool is unavailable: ${name}`);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const jsonInput = JSON.parse(JSON.stringify(input)) as McpJsonValue;
      return unwrapMcpResult(
        await this.client.callTool(tool, jsonInput, { signal: controller.signal }),
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async ticketExists(ticketId: string): Promise<boolean> {
    return existenceSchema.parse(await this.call('ticket_exists', { ticketId })).exists;
  }

  async createJob(message: JobMessage): Promise<AgentJob> {
    return agentJobSchema.parse(await this.call('create_job', message));
  }

  async getJob(jobId: string): Promise<AgentJob | null> {
    const value = await this.call('get_job', { jobId });
    if (value === null) return null;
    return agentJobSchema.parse(value);
  }

  async failJob(jobId: string, errorCode: string): Promise<void> {
    await this.call('fail_job', { jobId, errorCode });
  }

  async claimJob(jobId: string, attempt: number): Promise<ClaimResult> {
    return claimResultSchema.parse(await this.call('claim_job', { jobId, attempt }));
  }

  async loadTicketContext(ticketId: string, conversationId: string): Promise<unknown> {
    return this.call('load_ticket_context', { ticketId, conversationId });
  }

  async loadConversation(
    ticketId: string,
    conversationId: string,
  ): Promise<ConversationMessage[]> {
    return conversationSchema.parse(
      await this.call('load_conversation', { ticketId, conversationId }),
    ).messages;
  }

  async savePlan(jobId: string, plan: ResolutionPlan): Promise<void> {
    await this.call('save_plan', { jobId, plan });
  }

  async beginToolCall(jobId: string, toolName: string): Promise<ToolCallPermit> {
    return toolCallPermitSchema.parse(await this.call('begin_tool_call', { jobId, toolName }));
  }

  async recordToolResult(jobId: string, toolName: string, result: unknown): Promise<void> {
    await this.call('record_tool_result', { jobId, toolName, result });
  }

  async getTracking(jobId: string, orderId?: string): Promise<unknown> {
    return this.call('get_tracking', { jobId, ...(orderId ? { orderId } : {}) });
  }

  async searchResolutions(
    jobId: string,
    query: string,
    category: string | undefined,
    limit: number,
  ): Promise<unknown> {
    return this.call('search_resolutions', {
      jobId,
      query,
      ...(category ? { category } : {}),
      limit,
    });
  }

  async recordTicketNote(
    jobId: string,
    ticketId: string,
    note: string,
    visibility: 'internal' | 'customer',
  ): Promise<unknown> {
    return this.call('record_ticket_note', { jobId, ticketId, note, visibility });
  }

  async appendMessage(
    ticketId: string,
    conversationId: string,
    role: 'user' | 'assistant',
    message: string,
  ): Promise<void> {
    await this.call('append_message', { ticketId, conversationId, role, message });
  }

  async completeJob(jobId: string, response: string): Promise<boolean> {
    return mutationResultSchema.parse(await this.call('complete_job', { jobId, response })).applied;
  }

  async escalateJob(jobId: string, response: string, errorCode: string): Promise<boolean> {
    return mutationResultSchema.parse(
      await this.call('escalate_job', { jobId, response, errorCode }),
    ).applied;
  }
}

export async function createMcpDataClient(): Promise<AgentDataPort> {
  const configuredEndpoint =
    process.env.COCKROACH_CLOUD_MCP_ENDPOINT?.trim() ?? COCKROACH_CLOUD_MCP_ENDPOINT;
  if (configuredEndpoint !== COCKROACH_CLOUD_MCP_ENDPOINT) {
    throw new Error('COCKROACH_CLOUD_MCP_ENDPOINT must use the managed CockroachDB Cloud MCP service');
  }
  const clusterId = requiredEnvironment('COCKROACH_CLOUD_CLUSTER_ID');
  const apiKey = requiredEnvironment('COCKROACH_CLOUD_MCP_API_KEY');
  const client = new McpClient({
    url: COCKROACH_CLOUD_MCP_ENDPOINT,
    headers: cockroachCloudMcpHeaders(clusterId, apiKey),
  });
  const timeoutMs = positiveIntegerEnvironment(
    'COCKROACH_CLOUD_MCP_TOOL_TIMEOUT_MS',
    20_000,
  );
  return new CockroachMcpDataClient(client, timeoutMs);
}

export const mcpToolAllowlist = Object.freeze([...REQUIRED_TOOLS]);
