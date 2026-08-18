import { randomUUID } from 'node:crypto';
import { McpClient } from '@strands-agents/sdk';
import { z } from 'zod';
import type { AgentDataPort, ClaimResult, ToolCallPermit } from '../../application/ports.js';
import {
  agentJobSchema,
  conversationMessageSchema,
  jobStatusSchema,
  newTicketSchema,
  planSchema,
  ticketSummarySchema,
  type AgentJob,
  type ConversationMessage,
  type JobMessage,
  type NewTicket,
  type ResolutionPlan,
  type TicketSummary,
} from '../../domain/contracts.js';
import { positiveIntegerEnvironment, requiredEnvironment } from '../../config/environment.js';
import {
  cockroachCloudMcpHeaders,
  CockroachCloudMcpClient,
  COCKROACH_CLOUD_MCP_ENDPOINT,
  nativeMcpToolAllowlist,
  type ManagedCockroachMcpClient,
  type QueryRow,
} from './managed-cockroach-mcp-client.js';
import {
  parseJsonColumn,
  sqlJson,
  sqlString,
  sqlUuid,
  validateDatabaseName,
} from './cockroach-sql.js';

export {
  cockroachCloudMcpHeaders,
  COCKROACH_CLOUD_MCP_ENDPOINT,
  nativeMcpToolAllowlist,
};

/** These are application operations. Only the four orchestration tools are model-facing. */
export const applicationOperationAllowlist = Object.freeze([
  'ticket_exists',
  'create_ticket',
  'get_ticket',
  'list_tickets',
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

const booleanFromDatabase = z.preprocess((value) => {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
}, z.boolean());

const internalJobRowSchema = z.object({
  jobId: z.string().uuid(),
  ticketId: z.string().uuid(),
  conversationId: z.string().uuid(),
  status: jobStatusSchema,
  currentPlan: z.preprocess(parseJsonColumn, planSchema.nullable().optional()),
  planRequired: booleanFromDatabase,
  cycleCount: z.coerce.number().int().nonnegative(),
  response: z.string().nullable().optional(),
  errorCode: z.string().nullable().optional(),
  claimToken: z.string().uuid().nullable().optional(),
  toolCallToken: z.string().uuid().nullable().optional(),
  terminalToken: z.string().uuid().nullable().optional(),
  createdAt: z.coerce.string().optional(),
  updatedAt: z.coerce.string().optional(),
});

const conversationRowSchema = z.object({
  role: z.enum(['user', 'assistant']),
  message: z.string(),
  timestamp: z.coerce.string().optional(),
});

const TICKET_COLUMNS = `
  t.ticket_id::STRING AS "ticketId",
  t.conversation_id::STRING AS "conversationId",
  t.subject,
  t.description,
  t.category,
  t.status,
  t.created_at::STRING AS "createdAt",
  t.updated_at::STRING AS "updatedAt",
  latest_job.job_id::STRING AS "jobId",
  latest_job.status AS "jobStatus",
  latest_job.response`;

function publicTicket(row: QueryRow): TicketSummary {
  return ticketSummarySchema.parse(row);
}

const JOB_COLUMNS = `
  job_id::STRING AS "jobId",
  ticket_id::STRING AS "ticketId",
  conversation_id::STRING AS "conversationId",
  status,
  current_plan::STRING AS "currentPlan",
  plan_required AS "planRequired",
  cycle_count AS "cycleCount",
  response,
  error_code AS "errorCode",
  claim_token::STRING AS "claimToken",
  last_tool_call_token::STRING AS "toolCallToken",
  terminal_token::STRING AS "terminalToken",
  created_at::STRING AS "createdAt",
  updated_at::STRING AS "updatedAt"`;

function publicJob(row: z.infer<typeof internalJobRowSchema>): AgentJob {
  return agentJobSchema.parse({
    jobId: row.jobId,
    ticketId: row.ticketId,
    conversationId: row.conversationId,
    status: row.status,
    currentPlan: row.currentPlan,
    cycleCount: row.cycleCount,
    response: row.response,
    errorCode: row.errorCode,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

function firstRow(rows: QueryRow[], operation: string): QueryRow {
  const row = rows[0];
  if (!row) throw new Error(`CockroachDB MCP returned no row for ${operation}`);
  return row;
}

/**
 * Implements the application's typed data port over only the managed MCP select_query and
 * insert_rows tools. SQL is assembled exclusively from fixed templates and escaped literals;
 * neither the Strands agent nor a request payload can supply a SQL fragment.
 */
export class CockroachMcpDataClient implements AgentDataPort {
  constructor(
    private readonly mcp: ManagedCockroachMcpClient,
    private readonly createToken: () => string = randomUUID,
  ) {}

  disconnect(): Promise<void> {
    return this.mcp.disconnect();
  }

  async ticketExists(ticketId: string): Promise<boolean> {
    const rows = await this.mcp.select(`
      SELECT ticket_id::STRING AS "ticketId"
      FROM public.tickets
      WHERE ticket_id = ${sqlUuid(ticketId)}
      LIMIT 1`);
    return rows.length === 1;
  }

  async createTicket(ticket: NewTicket): Promise<TicketSummary> {
    const validated = newTicketSchema.parse(ticket);
    await this.mcp.insert(`
      WITH inserted_ticket AS (
        INSERT INTO public.tickets (
          ticket_id, conversation_id, subject, description, category, status
        )
        VALUES (
          ${sqlUuid(validated.ticketId)},
          ${sqlUuid(validated.conversationId)},
          ${sqlString(validated.subject)},
          ${sqlString(validated.description)},
          ${sqlString(validated.category)},
          'open'
        )
        ON CONFLICT (ticket_id) DO NOTHING
        RETURNING ticket_id, conversation_id
      )
      INSERT INTO public.conversation_messages (
        message_id, ticket_id, conversation_id, role, message
      )
      SELECT
        gen_random_uuid(), ticket_id, conversation_id, 'user',
        ${sqlString(validated.description)}
      FROM inserted_ticket`);

    const created = await this.getTicket(validated.ticketId);
    if (!created) throw new Error('CockroachDB MCP did not create the ticket');
    return created;
  }

  async getTicket(ticketId: string): Promise<TicketSummary | null> {
    const rows = await this.mcp.select(`
      SELECT ${TICKET_COLUMNS}
      FROM public.tickets t
      LEFT JOIN LATERAL (
        SELECT job_id, status, response
        FROM public.agent_jobs
        WHERE ticket_id = t.ticket_id
        ORDER BY created_at DESC
        LIMIT 1
      ) AS latest_job ON true
      WHERE t.ticket_id = ${sqlUuid(ticketId)}
      LIMIT 1`);
    return rows[0] ? publicTicket(rows[0]) : null;
  }

  async listTickets(limit: number): Promise<TicketSummary[]> {
    const boundedLimit = z.number().int().min(1).max(100).parse(limit);
    const rows = await this.mcp.select(`
      SELECT ${TICKET_COLUMNS}
      FROM public.tickets t
      LEFT JOIN LATERAL (
        SELECT job_id, status, response
        FROM public.agent_jobs
        WHERE ticket_id = t.ticket_id
        ORDER BY created_at DESC
        LIMIT 1
      ) AS latest_job ON true
      ORDER BY t.created_at DESC
      LIMIT ${boundedLimit}`);
    return rows.map(publicTicket);
  }

  async createJob(message: JobMessage): Promise<AgentJob> {
    await this.mcp.insert(`
      INSERT INTO public.agent_jobs (job_id, ticket_id, conversation_id, status)
      VALUES (
        ${sqlUuid(message.jobId)},
        ${sqlUuid(message.ticketId)},
        ${sqlUuid(message.conversationId)},
        'queued'
      )
      ON CONFLICT (job_id) DO NOTHING`);
    const job = await this.getJob(message.jobId);
    if (!job) throw new Error('CockroachDB MCP did not create the job');
    return job;
  }

  async getJob(jobId: string): Promise<AgentJob | null> {
    const row = await this.getInternalJob(jobId);
    return row ? publicJob(row) : null;
  }

  async failJob(jobId: string, errorCode: string): Promise<void> {
    await this.mcp.insert(`
      INSERT INTO public.agent_jobs (
        job_id, ticket_id, conversation_id, status, error_code, updated_at
      )
      SELECT job_id, ticket_id, conversation_id, 'failed', ${sqlString(errorCode)}, now()
      FROM public.agent_jobs
      WHERE job_id = ${sqlUuid(jobId)}
      ON CONFLICT (job_id) DO UPDATE SET
        status = 'failed',
        error_code = excluded.error_code,
        updated_at = excluded.updated_at
      WHERE agent_jobs.status = 'queued'`);
  }

  async claimJob(jobId: string, attempt: number): Promise<ClaimResult> {
    const claimToken = this.createToken();
    const safeAttempt = z.number().int().positive().parse(attempt);
    await this.mcp.insert(`
      INSERT INTO public.agent_jobs (
        job_id, ticket_id, conversation_id, status, last_attempt,
        claim_token, claimed_at, updated_at
      )
      SELECT
        job_id, ticket_id, conversation_id, 'running', ${safeAttempt},
        ${sqlUuid(claimToken)}, now(), now()
      FROM public.agent_jobs
      WHERE job_id = ${sqlUuid(jobId)}
      ON CONFLICT (job_id) DO UPDATE SET
        status = 'running',
        last_attempt = excluded.last_attempt,
        claim_token = excluded.claim_token,
        claimed_at = excluded.claimed_at,
        updated_at = excluded.updated_at
      WHERE agent_jobs.status = 'queued'
         OR (agent_jobs.status = 'running' AND excluded.last_attempt > agent_jobs.last_attempt)`);

    const job = await this.getInternalJob(jobId);
    if (!job) throw new Error('Cannot claim a job that does not exist');
    const toolResults = await this.mcp.select(`
      SELECT tool_name AS "toolName", cycle_number AS "cycleNumber", result::STRING AS result
      FROM public.agent_tool_results
      WHERE job_id = ${sqlUuid(jobId)}
      ORDER BY cycle_number ASC
      LIMIT 3`);

    return {
      claimed: job.claimToken === claimToken && job.status === 'running',
      status: job.status,
      currentPlan: job.currentPlan,
      planRequired: job.planRequired,
      cycleCount: job.cycleCount,
      toolResults: toolResults.map((row) => ({
        toolName: row.toolName,
        cycleNumber: Number(row.cycleNumber),
        result: parseJsonColumn(row.result),
      })),
    };
  }

  async loadTicketContext(
    jobId: string,
    ticketId: string,
    conversationId: string,
  ): Promise<unknown> {
    await this.mcp.insert(`
      INSERT INTO public.agent_context_loads (job_id, ticket_id, conversation_id)
      SELECT job_id, ticket_id, conversation_id
      FROM public.agent_jobs
      WHERE job_id = ${sqlUuid(jobId)}
        AND ticket_id = ${sqlUuid(ticketId)}
        AND conversation_id = ${sqlUuid(conversationId)}
      ON CONFLICT (job_id) DO NOTHING`);

    const rows = await this.mcp.select(`
      SELECT
        t.ticket_id::STRING AS "ticketId",
        t.conversation_id::STRING AS "conversationId",
        t.subject,
        t.description,
        t.category,
        t.status AS "ticketStatus",
        t.order_id::STRING AS "orderId",
        o.customer_name AS "customerName",
        o.item_description AS "itemDescription",
        o.order_status AS "orderStatus",
        o.ordered_at::STRING AS "orderedAt"
      FROM public.agent_jobs j
      JOIN public.tickets t
        ON t.ticket_id = j.ticket_id AND t.conversation_id = j.conversation_id
      LEFT JOIN public.orders o ON o.order_id = t.order_id
      WHERE j.job_id = ${sqlUuid(jobId)}
        AND j.ticket_id = ${sqlUuid(ticketId)}
        AND j.conversation_id = ${sqlUuid(conversationId)}
      LIMIT 1`);
    return firstRow(rows, 'load_ticket_context');
  }

  async loadConversation(
    ticketId: string,
    conversationId: string,
  ): Promise<ConversationMessage[]> {
    const rows = await this.mcp.select(`
      SELECT role, message, created_at::STRING AS timestamp
      FROM public.conversation_messages
      WHERE ticket_id = ${sqlUuid(ticketId)}
        AND conversation_id = ${sqlUuid(conversationId)}
      ORDER BY created_at ASC
      LIMIT 100`);
    return rows.map((row) => conversationMessageSchema.parse(conversationRowSchema.parse(row)));
  }

  async savePlan(jobId: string, plan: ResolutionPlan): Promise<void> {
    const validated = planSchema.parse(plan);
    await this.mcp.insert(`
      INSERT INTO public.agent_jobs (
        job_id, ticket_id, conversation_id, status, current_plan,
        plan_required, cycle_count, last_attempt, updated_at
      )
      SELECT
        job_id, ticket_id, conversation_id, status, ${sqlJson(validated)},
        false, cycle_count, last_attempt, now()
      FROM public.agent_jobs
      WHERE job_id = ${sqlUuid(jobId)}
      ON CONFLICT (job_id) DO UPDATE SET
        current_plan = excluded.current_plan,
        plan_required = false,
        updated_at = excluded.updated_at
      WHERE agent_jobs.status = 'running'`);
  }

  async beginToolCall(jobId: string, toolName: string): Promise<ToolCallPermit> {
    const toolCallToken = this.createToken();
    await this.mcp.insert(`
      INSERT INTO public.agent_jobs (
        job_id, ticket_id, conversation_id, status, current_plan,
        plan_required, cycle_count, last_attempt, last_tool_call_token, updated_at
      )
      SELECT
        job_id, ticket_id, conversation_id, status, current_plan,
        true, cycle_count + 1, last_attempt, ${sqlUuid(toolCallToken)}, now()
      FROM public.agent_jobs
      WHERE job_id = ${sqlUuid(jobId)}
        AND status = 'running'
        AND plan_required = false
        AND cycle_count < 3
      ON CONFLICT (job_id) DO UPDATE SET
        plan_required = true,
        cycle_count = excluded.cycle_count,
        last_tool_call_token = excluded.last_tool_call_token,
        updated_at = excluded.updated_at
      WHERE agent_jobs.status = 'running'
        AND agent_jobs.plan_required = false
        AND agent_jobs.cycle_count < 3`);

    const job = await this.getInternalJob(jobId);
    if (!job) throw new Error('Cannot call a tool for a job that does not exist');
    const allowed = job.toolCallToken === toolCallToken;
    return {
      allowed,
      cycleCount: job.cycleCount,
      ...(!allowed
        ? { reason: job.cycleCount >= 3 ? ('CYCLE_LIMIT' as const) : ('PLAN_REQUIRED' as const) }
        : {}),
    };
  }

  async recordToolResult(jobId: string, toolName: string, result: unknown): Promise<void> {
    await this.mcp.insert(`
      INSERT INTO public.agent_tool_results (job_id, tool_name, cycle_number, result)
      SELECT job_id, ${sqlString(toolName)}, cycle_count, ${sqlJson(result)}
      FROM public.agent_jobs
      WHERE job_id = ${sqlUuid(jobId)}
        AND status = 'running'
        AND cycle_count BETWEEN 1 AND 3
      ON CONFLICT (job_id, cycle_number) DO NOTHING`);
  }

  async getTracking(jobId: string, orderId?: string): Promise<unknown> {
    const rows = await this.mcp.select(`
      SELECT
        o.order_id::STRING AS "orderId",
        o.order_status AS "orderStatus",
        e.tracking_status AS "trackingStatus",
        e.carrier,
        e.location,
        e.details,
        e.event_at::STRING AS "eventAt"
      FROM public.agent_jobs j
      JOIN public.tickets t ON t.ticket_id = j.ticket_id
      JOIN public.orders o ON o.order_id = t.order_id
      LEFT JOIN public.tracking_events e ON e.order_id = o.order_id
      WHERE j.job_id = ${sqlUuid(jobId)}
        ${orderId ? `AND o.order_id = ${sqlUuid(orderId)}` : ''}
      ORDER BY e.event_at DESC
      LIMIT 25`);
    return { tracking: rows };
  }

  async searchResolutions(
    jobId: string,
    query: string,
    category: string | undefined,
    limit: number,
  ): Promise<unknown> {
    // Turn free text into escaped values only; it can never become a SQL identifier or operator.
    const terms = [...new Set(query.toLowerCase().match(/[a-z0-9]{2,}/g) ?? [])].slice(0, 8);
    const textConditions = terms.length
      ? terms
          .map(
            (term) =>
              `lower(concat_ws(' ', r.title, r.summary, r.category)) LIKE ${sqlString(`%${term}%`)}`,
          )
          .join(' OR ')
      : 'false';
    const boundedLimit = z.number().int().min(1).max(5).parse(limit);
    const rows = await this.mcp.select(`
      SELECT
        r.resolution_id::STRING AS "resolutionId",
        r.category,
        r.title,
        r.summary
      FROM public.resolution_articles r
      JOIN public.agent_jobs j ON j.job_id = ${sqlUuid(jobId)}
      WHERE r.active = true
        AND (${textConditions})
        ${category ? `AND lower(r.category) = lower(${sqlString(category)})` : ''}
      ORDER BY r.updated_at DESC
      LIMIT ${boundedLimit}`);
    return { resolutions: rows };
  }

  async recordTicketNote(
    jobId: string,
    ticketId: string,
    note: string,
    visibility: 'internal' | 'customer',
  ): Promise<unknown> {
    const validatedVisibility = z.enum(['internal', 'customer']).parse(visibility);
    const validatedNote = z.string().min(1).max(4_000).parse(note);
    await this.mcp.insert(`
      INSERT INTO public.ticket_notes (
        id, ticket_id, job_id, cycle_number, note, visibility
      )
      SELECT
        gen_random_uuid(), j.ticket_id, j.job_id, j.cycle_count,
        ${sqlString(validatedNote)}, ${sqlString(validatedVisibility)}
      FROM public.agent_jobs j
      WHERE j.job_id = ${sqlUuid(jobId)}
        AND j.ticket_id = ${sqlUuid(ticketId)}
        AND j.status = 'running'
        AND j.cycle_count BETWEEN 1 AND 3
      ON CONFLICT (job_id, cycle_number) DO NOTHING`);
    const rows = await this.mcp.select(`
      SELECT id::STRING AS id
      FROM public.ticket_notes
      WHERE job_id = ${sqlUuid(jobId)}
      ORDER BY created_at DESC
      LIMIT 1`);
    return { recorded: rows.length > 0 };
  }

  async appendMessage(
    jobId: string,
    ticketId: string,
    conversationId: string,
    role: 'user' | 'assistant',
    message: string,
  ): Promise<void> {
    const validatedRole = z.enum(['user', 'assistant']).parse(role);
    const validatedMessage = z.string().min(1).max(20_000).parse(message);
    await this.mcp.insert(`
      INSERT INTO public.conversation_messages (
        message_id, ticket_id, conversation_id, job_id, role, message
      )
      SELECT
        gen_random_uuid(), j.ticket_id, j.conversation_id, j.job_id,
        ${sqlString(validatedRole)}, ${sqlString(validatedMessage)}
      FROM public.agent_jobs j
      WHERE j.job_id = ${sqlUuid(jobId)}
        AND j.ticket_id = ${sqlUuid(ticketId)}
        AND j.conversation_id = ${sqlUuid(conversationId)}
      ON CONFLICT (job_id, role) DO NOTHING`);
  }

  async completeJob(jobId: string, response: string): Promise<boolean> {
    return this.terminalTransition(jobId, 'completed', response, null);
  }

  async escalateJob(jobId: string, response: string, errorCode: string): Promise<boolean> {
    return this.terminalTransition(jobId, 'escalated', response, errorCode);
  }

  private async terminalTransition(
    jobId: string,
    status: 'completed' | 'escalated',
    response: string,
    errorCode: string | null,
  ): Promise<boolean> {
    const terminalToken = this.createToken();
    const validatedResponse = z.string().min(1).max(20_000).parse(response);
    await this.mcp.insert(`
      WITH transitioned_job AS (
        INSERT INTO public.agent_jobs (
          job_id, ticket_id, conversation_id, status, response,
          error_code, terminal_token, completed_at, updated_at
        )
        SELECT
          job_id, ticket_id, conversation_id, ${sqlString(status)},
          ${sqlString(validatedResponse)},
          ${errorCode ? sqlString(errorCode) : 'NULL'},
          ${sqlUuid(terminalToken)}, now(), now()
        FROM public.agent_jobs
        WHERE job_id = ${sqlUuid(jobId)}
        ON CONFLICT (job_id) DO UPDATE SET
          status = excluded.status,
          response = excluded.response,
          error_code = excluded.error_code,
          terminal_token = excluded.terminal_token,
          completed_at = excluded.completed_at,
          updated_at = excluded.updated_at
        WHERE agent_jobs.status IN ('queued', 'running')
        RETURNING ticket_id
      )
      INSERT INTO public.tickets (
        ticket_id, conversation_id, order_id, subject, description,
        category, status, created_at, updated_at
      )
      SELECT
        t.ticket_id, t.conversation_id, t.order_id, t.subject, t.description,
        t.category, ${sqlString(status === 'completed' ? 'awaiting_customer' : 'escalated')},
        t.created_at, now()
      FROM public.tickets t
      JOIN transitioned_job j ON j.ticket_id = t.ticket_id
      ON CONFLICT (ticket_id) DO UPDATE SET
        status = excluded.status,
        updated_at = excluded.updated_at`);
    const job = await this.getInternalJob(jobId);
    return job?.terminalToken === terminalToken && job.status === status;
  }

  private async getInternalJob(
    jobId: string,
  ): Promise<z.infer<typeof internalJobRowSchema> | null> {
    const rows = await this.mcp.select(`
      SELECT ${JOB_COLUMNS}
      FROM public.agent_jobs
      WHERE job_id = ${sqlUuid(jobId)}
      LIMIT 1`);
    return rows[0] ? internalJobRowSchema.parse(rows[0]) : null;
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
  const database = validateDatabaseName(requiredEnvironment('COCKROACH_CLOUD_DATABASE'));
  const client = new McpClient({
    url: COCKROACH_CLOUD_MCP_ENDPOINT,
    headers: cockroachCloudMcpHeaders(clusterId, apiKey),
  });
  const timeoutMs = positiveIntegerEnvironment('COCKROACH_CLOUD_MCP_TOOL_TIMEOUT_MS', 20_000);
  return new CockroachMcpDataClient(
    new CockroachCloudMcpClient(client, database, timeoutMs),
  );
}
