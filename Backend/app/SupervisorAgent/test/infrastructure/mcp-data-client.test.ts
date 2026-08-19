import assert from 'node:assert/strict';
import test from 'node:test';
import { CockroachMcpDataClient } from '../../src/infrastructure/mcp/cockroach-mcp-data-client.js';
import { sqlString } from '../../src/infrastructure/mcp/cockroach-sql.js';
import type {
  ManagedCockroachMcpClient,
  QueryRow,
} from '../../src/infrastructure/mcp/managed-cockroach-mcp-client.js';
import { JOB_MESSAGE } from '../support/fakes.js';

const TOKEN = '99999999-9999-4999-8999-999999999999';
const TICKET_ROW = {
  ticketId: JOB_MESSAGE.ticketId,
  conversationId: JOB_MESSAGE.conversationId,
  subject: 'Where is my order?',
  description: 'My delivery has not arrived yet.',
  category: 'delivery',
  status: 'open',
  createdAt: '2026-08-11T00:00:00Z',
  updatedAt: '2026-08-11T00:00:00Z',
  jobId: null,
  jobStatus: null,
  response: null,
};

class FakeManagedMcp implements ManagedCockroachMcpClient {
  readonly insertQueries: string[] = [];
  readonly selectQueries: string[] = [];
  readonly selectResults: QueryRow[][] = [];

  async select(query: string): Promise<QueryRow[]> {
    this.selectQueries.push(query);
    return this.selectResults.shift() ?? [];
  }

  async insert(query: string): Promise<void> {
    this.insertQueries.push(query);
  }

  async disconnect(): Promise<void> {}
}

function jobRow(overrides: QueryRow = {}): QueryRow {
  return {
    jobId: JOB_MESSAGE.jobId,
    ticketId: JOB_MESSAGE.ticketId,
    conversationId: JOB_MESSAGE.conversationId,
    status: 'running',
    currentPlan: null,
    planRequired: true,
    cycleCount: 0,
    response: null,
    errorCode: null,
    claimToken: null,
    toolCallToken: null,
    terminalToken: null,
    createdAt: '2026-08-11T00:00:00Z',
    updatedAt: '2026-08-11T00:00:00Z',
    ...overrides,
  };
}

test('managed MCP repository creates and reads a durable queued job', async () => {
  const mcp = new FakeManagedMcp();
  mcp.selectResults.push([jobRow({ status: 'queued' })]);
  const data = new CockroachMcpDataClient(mcp, () => TOKEN);

  const job = await data.createJob(JOB_MESSAGE);

  assert.equal(job.status, 'queued');
  assert.match(mcp.insertQueries[0], /^\s*INSERT INTO public\.agent_jobs/);
  assert.match(mcp.insertQueries[0], /ON CONFLICT \(job_id\) DO NOTHING/);
  assert.equal(mcp.selectQueries.length, 1);
});

test('managed MCP repository creates a ticket with its initial conversation message', async () => {
  const mcp = new FakeManagedMcp();
  mcp.selectResults.push([TICKET_ROW]);
  const data = new CockroachMcpDataClient(mcp, () => TOKEN);

  const ticket = await data.createTicket({
    ticketId: JOB_MESSAGE.ticketId,
    conversationId: JOB_MESSAGE.conversationId,
    subject: 'Where is my order?',
    description: 'My delivery has not arrived yet.',
    category: 'delivery',
  });

  assert.equal(ticket.status, 'open');
  assert.match(mcp.insertQueries[0], /^\s*WITH inserted_ticket AS/);
  assert.match(mcp.insertQueries[0], /INSERT INTO public\.conversation_messages/);
  assert.match(mcp.selectQueries[0], /LEFT JOIN LATERAL/);
});

test('managed MCP repository returns the most recent job with each admin ticket', async () => {
  const mcp = new FakeManagedMcp();
  mcp.selectResults.push([{ ...TICKET_ROW, jobId: JOB_MESSAGE.jobId, jobStatus: 'running' }]);
  const data = new CockroachMcpDataClient(mcp, () => TOKEN);

  const tickets = await data.listTickets(25);

  assert.equal(tickets[0]?.jobStatus, 'running');
  assert.match(mcp.selectQueries[0], /ORDER BY t\.created_at DESC/);
  assert.match(mcp.selectQueries[0], /LIMIT 25/);
});

test('claim and tool-call permits are tied to unique tokens and durable counters', async () => {
  const mcp = new FakeManagedMcp();
  mcp.selectResults.push(
    [jobRow({ claimToken: TOKEN, planRequired: false })],
    [{ toolName: 'get_tracking', cycleNumber: 1, result: '{"ok":true}' }],
    [jobRow({ toolCallToken: TOKEN, planRequired: true, cycleCount: 1 })],
  );
  const data = new CockroachMcpDataClient(mcp, () => TOKEN);

  const claim = await data.claimJob(JOB_MESSAGE.jobId, 1);
  const permit = await data.beginToolCall(JOB_MESSAGE.jobId, 'get_tracking');

  assert.equal(claim.claimed, true);
  assert.deepEqual(claim.toolResults, [
    { toolName: 'get_tracking', cycleNumber: 1, result: { ok: true } },
  ]);
  assert.deepEqual(permit, { allowed: true, cycleCount: 1 });
  assert.match(mcp.insertQueries[0], /excluded\.last_attempt > agent_jobs\.last_attempt/);
  assert.match(mcp.insertQueries[1], /agent_jobs\.cycle_count < 3/);
});

test('terminal transition updates the job and ticket in one conditional MCP insert', async () => {
  const mcp = new FakeManagedMcp();
  mcp.selectResults.push([
    jobRow({
      status: 'completed',
      response: 'Your order is out for delivery.',
      terminalToken: TOKEN,
    }),
  ]);
  const data = new CockroachMcpDataClient(mcp, () => TOKEN);

  const applied = await data.completeJob(JOB_MESSAGE.jobId, 'Your order is out for delivery.');

  assert.equal(applied, true);
  assert.match(mcp.insertQueries[0], /^\s*WITH transitioned_job AS/);
  assert.match(mcp.insertQueries[0], /INSERT INTO public\.tickets/);
  assert.match(mcp.insertQueries[0], /'awaiting_customer'/);
  assert.match(mcp.insertQueries[0], /agent_jobs\.status IN \('queued', 'running'\)/);
});

test('free-text values are escaped and cannot become executable SQL fragments', async () => {
  const mcp = new FakeManagedMcp();
  mcp.selectResults.push([]);
  const embedding = Array.from({ length: 384 }, (_, index) => index / 384);
  const data = new CockroachMcpDataClient(
    mcp,
    () => TOKEN,
    { embed: async () => embedding },
  );

  await data.searchResolutions(
    JOB_MESSAGE.jobId,
    "delivery%' OR true --",
    "shipping' OR true --",
    3,
  );

  assert.equal(sqlString("customer's order"), "'customer''s order'");
  assert.match(mcp.selectQueries[0], /shipping'' OR true --/);
  assert.doesNotMatch(mcp.selectQueries[0], /shipping' OR true --/);
  assert.match(mcp.selectQueries[0], /FROM public\.resolution_embeddings/);
  assert.match(mcp.selectQueries[0], /embedding <-> '\[0,0\.00260417/);
  assert.match(mcp.selectQueries[0], /ORDER BY distance/);
  assert.match(mcp.selectQueries[0], /LIMIT 15/);
  assert.match(mcp.selectQueries[0], /ORDER BY nearest\.distance/);
  assert.match(mcp.selectQueries[0], /LIMIT 3/);
  assert.ok(mcp.selectQueries[0].length < 16_384);
});
