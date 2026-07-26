/**
 * Every external boundary has a mock, and every mock satisfies its interface.
 *
 * TypeScript proves conformance at compile time; this asserts it at runtime too, because
 * these mocks are the seams five later gates test against. A mock that quietly loses a
 * method would surface as a confusing failure inside whichever gate happened to call it.
 */

import { describe, expect, it } from 'vitest';
import {
  EMBEDDING_CLIENT_METHODS,
  AGENT_RUNTIME_CLIENT_METHODS,
  GATEWAY_TOOL_CLIENT_METHODS,
  MEMORY_STORE_METHODS,
  MODEL_CLIENT_METHODS,
  POLICY_DOCUMENT_SOURCE_METHODS,
  PRECEDENT_SOURCE_METHODS,
  TRACE_SINK_METHODS,
  FixturePrecedentSource,
  InMemoryMemoryStore,
  InMemoryTraceSink,
  MockAgentRuntimeClient,
  MockEmbeddingClient,
  MockGatewayToolClient,
  MockModelClient,
  MockPolicyDocumentSource,
} from '@ats/agents';
import { InMemoryTicketDataPort, TICKET_DATA_PORT_METHODS } from '@ats/db';
import type { Customer, Order, Ticket } from '@ats/core';

const BOUNDARIES: Array<{ name: string; instance: object; methods: readonly string[] }> = [
  { name: 'ModelClient', instance: new MockModelClient(), methods: MODEL_CLIENT_METHODS },
  {
    name: 'AgentRuntimeClient',
    instance: new MockAgentRuntimeClient(),
    methods: AGENT_RUNTIME_CLIENT_METHODS,
  },
  { name: 'MemoryStore', instance: new InMemoryMemoryStore(), methods: MEMORY_STORE_METHODS },
  {
    name: 'GatewayToolClient',
    instance: new MockGatewayToolClient(),
    methods: GATEWAY_TOOL_CLIENT_METHODS,
  },
  {
    name: 'EmbeddingClient',
    instance: new MockEmbeddingClient(),
    methods: EMBEDDING_CLIENT_METHODS,
  },
  {
    name: 'PolicyDocumentSource',
    instance: new MockPolicyDocumentSource(),
    methods: POLICY_DOCUMENT_SOURCE_METHODS,
  },
  {
    name: 'PrecedentSource',
    instance: new FixturePrecedentSource(),
    methods: PRECEDENT_SOURCE_METHODS,
  },
  { name: 'TraceSink', instance: new InMemoryTraceSink(), methods: TRACE_SINK_METHODS },
  {
    name: 'TicketDataPort',
    instance: new InMemoryTicketDataPort(),
    methods: TICKET_DATA_PORT_METHODS,
  },
];

describe('every external boundary has a conforming mock', () => {
  it.each(BOUNDARIES)('$name', ({ instance, methods }) => {
    for (const method of methods) {
      expect(typeof (instance as Record<string, unknown>)[method]).toBe('function');
    }
  });

  it('covers all nine boundaries the architecture names', () => {
    // Bedrock model, AgentCore Runtime, AgentCore Memory, AgentCore Gateway, embeddings,
    // S3 policy documents, precedents, the trace sink, and the data port.
    expect(BOUNDARIES).toHaveLength(9);
  });
});

describe('InMemoryTicketDataPort behaves like the thing it stands in for', () => {
  const customer: Customer = {
    id: 'cus-1',
    name: 'Ada',
    email: 'Ada@Example.com',
    createdAt: '2026-01-01T00:00:00.000Z',
  };
  const order: Order = {
    id: 'ord-1',
    customerId: 'cus-1',
    status: 'shipped',
    orderValueCents: 24999,
    shippedAt: '2026-07-01T00:00:00.000Z',
    receivedAt: null,
    createdAt: '2026-06-28T00:00:00.000Z',
  };
  const ticket: Ticket = {
    id: 'tkt-1',
    customerId: 'cus-1',
    orderId: 'ord-1',
    title: 'Where is my order?',
    description: 'It has been a while.',
    category: null,
    priority: null,
    status: 'open',
    assignedTo: null,
    accessToken: 'token',
    createdAt: '2026-07-20T00:00:00.000Z',
  };

  function seeded() {
    return new InMemoryTicketDataPort({ customers: [customer], orders: [order], tickets: [ticket] });
  }

  it('matches customer email case-insensitively, as the submit flow requires', async () => {
    const port = seeded();
    expect(await port.findCustomerByEmail('ADA@example.COM')).toEqual(customer);
    expect(await port.findCustomerByEmail('  ada@example.com  ')).toEqual(customer);
    expect(await port.findCustomerByEmail('nobody@example.com')).toBeNull();
  });

  it('starts with no orchestration row — context has not been called', async () => {
    const port = seeded();
    expect(await port.getOrchestrationState('tkt-1', 'conv-1')).toBeNull();
  });

  it('stamps context_called_at idempotently', async () => {
    const port = seeded();
    const first = await port.stampContextCalled('tkt-1', 'conv-1');
    const second = await port.stampContextCalled('tkt-1', 'conv-1');

    expect(first.contextCalledAt).not.toBeNull();
    // Re-running context must not reset the stamp, or the guard becomes re-armable.
    expect(second.contextCalledAt).toBe(first.contextCalledAt);
    expect(second.cycleCount).toBe(0);
  });

  it('increments cycle_count independently per conversation', async () => {
    const port = seeded();
    expect(await port.incrementCycleCount('tkt-1', 'conv-1')).toBe(1);
    expect(await port.incrementCycleCount('tkt-1', 'conv-1')).toBe(2);
    expect(await port.incrementCycleCount('tkt-1', 'conv-1')).toBe(3);
    expect(await port.incrementCycleCount('tkt-1', 'conv-2')).toBe(1);
  });

  it('increments without inventing a context stamp', async () => {
    // The two invariants are independent: reaching the cycle cap must never look like
    // context having been called.
    const port = seeded();
    await port.incrementCycleCount('tkt-1', 'conv-1');
    expect((await port.getOrchestrationState('tkt-1', 'conv-1'))?.contextCalledAt).toBeNull();
  });

  it('records every call, so a test can prove a refused specialist did no work', async () => {
    const port = seeded();
    await port.getTicket('tkt-1');
    expect(port.calls.map((c) => c.method)).toEqual(['getTicket']);
  });

  it('refuses an unbounded similarity search', async () => {
    const port = seeded();
    await expect(port.searchResolutions([1, 0, 0], { limit: 0 })).rejects.toThrow(/limit/);
  });

  it('ranks by similarity and honours the limit and filters', async () => {
    const port = new InMemoryTicketDataPort({
      resolutions: [
        {
          id: 'res-a',
          ticketId: 'tkt-1',
          content: 'a',
          outcome: 'resolved',
          source: 'agent',
          rejectionComments: null,
          createdAt: '2026-01-01T00:00:00.000Z',
          embedding: [1, 0, 0],
        },
        {
          id: 'res-b',
          ticketId: 'tkt-2',
          content: 'b',
          outcome: 'unresolved',
          source: 'agent',
          rejectionComments: 'not what I asked',
          createdAt: '2026-01-02T00:00:00.000Z',
          embedding: [0, 1, 0],
        },
      ],
    });

    const all = await port.searchResolutions([1, 0, 0], { limit: 5 });
    expect(all[0]?.id).toBe('res-a');
    expect(all[0]?.similarity).toBeCloseTo(1);

    const onlyResolved = await port.searchResolutions([0, 1, 0], { limit: 5, outcome: 'resolved' });
    expect(onlyResolved.map((r) => r.id)).toEqual(['res-a']);

    expect(await port.searchResolutions([1, 0, 0], { limit: 1 })).toHaveLength(1);
  });
});

describe('the mocks that stand in for later-gate behaviour', () => {
  it('InMemoryTraceSink swallows a simulated failure — trace writes are best-effort', async () => {
    // ARCHITECTURE.md §9.1: a failed agent_runs insert must never invalidate a ticket
    // outcome, so record() resolves even when the write fails.
    const sink = new InMemoryTraceSink(true);
    await expect(
      sink.record({
        ticketId: 'tkt-1',
        conversationId: 'conv-1',
        planSummary: 'plan',
        steps: [],
        cyclesUsed: 1,
        outcome: 'escalated',
      }),
    ).resolves.toBeUndefined();
    expect(sink.traces).toHaveLength(0);
    expect(sink.failures).toHaveLength(1);
  });

  it('MockEmbeddingClient returns vectors of its declared dimension, deterministically', async () => {
    const client = new MockEmbeddingClient(8);
    const first = await client.embed('order never arrived');
    const second = await client.embed('order never arrived');
    expect(first).toHaveLength(8);
    expect(first).toEqual(second);
    expect(await client.embed('completely different text')).not.toEqual(first);
  });

  it('FixturePrecedentSource refuses an unbounded query', async () => {
    await expect(
      new FixturePrecedentSource().findSimilar({ text: 'anything', limit: 0 }),
    ).rejects.toThrow(/limit/);
  });

  it('MockPolicyDocumentSource can simulate an edit and an outage', async () => {
    const source = new MockPolicyDocumentSource({
      'refund-policy.json': { version: 1, updatedAt: 'x', params: { a: 1 }, prose: 'v1' },
    });
    expect((await source.load('refund-policy.json')).document.version).toBe(1);

    source.put('refund-policy.json', { version: 2, updatedAt: 'y', params: { a: 2 }, prose: 'v2' });
    expect((await source.load('refund-policy.json')).document.version).toBe(2);

    source.failNext('refund-policy.json', new Error('S3 unavailable'));
    await expect(source.load('refund-policy.json')).rejects.toThrow(/S3 unavailable/);
    // …and recovers afterwards, so last-known-good fallback can be tested at Gate 4.
    expect((await source.load('refund-policy.json')).document.version).toBe(2);
  });

  it('InMemoryMemoryStore round-trips session state without aliasing it', async () => {
    const store = new InMemoryMemoryStore();
    const state = {
      ticketId: 'tkt-1',
      conversationId: 'conv-1',
      plan: { steps: ['context'] },
      contextLoaded: true,
      specialistOutputs: {},
      cycleCount: 0,
    };
    await store.save('conv-1', state);

    const loaded = await store.load('conv-1');
    expect(loaded).toEqual(state);
    // A caller mutating what it loaded must not corrupt the store.
    (loaded as { cycleCount: number }).cycleCount = 99;
    expect((await store.load('conv-1'))?.cycleCount).toBe(0);

    await store.clear('conv-1');
    expect(await store.load('conv-1')).toBeNull();
  });
});
