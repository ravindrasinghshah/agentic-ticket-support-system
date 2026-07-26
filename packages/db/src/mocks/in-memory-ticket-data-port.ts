/**
 * In-memory `TicketDataPort` — the fake every later gate's unit tests bind to, so
 * `pnpm test` stays green with zero credentials and zero network.
 *
 * It is a fake, not a stub: it holds real state and honours the invariants the durable
 * guards depend on, so a test can genuinely exercise "context not called → refuse" and
 * "cycle_count reaches 3 → escalate" without a database. Integration tests against real
 * CockroachDB remain the authority (plan.md, "Database and schema policy").
 */

import type {
  ConversationRole,
  ConversationTurn,
  Customer,
  OrchestrationState,
  Order,
  Resolution,
  Ticket,
  TicketStatus,
} from '@ats/core';
import type {
  NewResolution,
  ResolutionSearchOptions,
  ScoredResolution,
  TicketDataPort,
} from '../ports/ticket-data-port.ts';

export interface InMemorySeed {
  customers?: Customer[];
  orders?: Order[];
  tickets?: Ticket[];
  conversation?: ConversationTurn[];
  orchestration?: OrchestrationState[];
  resolutions?: Array<Resolution & { embedding: readonly number[] }>;
}

/** Cosine similarity. Mirrors what the CockroachDB vector index computes at Gate 6. */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

let counter = 0;
function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}-${String(counter).padStart(6, '0')}`;
}

export class InMemoryTicketDataPort implements TicketDataPort {
  readonly customers = new Map<string, Customer>();
  readonly orders = new Map<string, Order>();
  readonly tickets = new Map<string, Ticket>();
  readonly conversation: ConversationTurn[] = [];
  readonly orchestration = new Map<string, OrchestrationState>();
  readonly resolutions: Array<Resolution & { embedding: readonly number[] }> = [];

  /** Every call recorded, so tests can assert a refused specialist did *no work*. */
  readonly calls: Array<{ method: string; args: unknown[] }> = [];

  constructor(
    seed: InMemorySeed = {},
    private readonly now: () => Date = () => new Date(),
  ) {
    for (const customer of seed.customers ?? []) this.customers.set(customer.id, customer);
    for (const order of seed.orders ?? []) this.orders.set(order.id, order);
    for (const ticket of seed.tickets ?? []) this.tickets.set(ticket.id, ticket);
    this.conversation.push(...(seed.conversation ?? []));
    for (const state of seed.orchestration ?? []) {
      this.orchestration.set(stateKey(state.ticketId, state.conversationId), state);
    }
    this.resolutions.push(...(seed.resolutions ?? []));
  }

  private record(method: string, ...args: unknown[]): void {
    this.calls.push({ method, args });
  }

  async getTicket(ticketId: string): Promise<Ticket | null> {
    this.record('getTicket', ticketId);
    return this.tickets.get(ticketId) ?? null;
  }

  async getCustomer(customerId: string): Promise<Customer | null> {
    this.record('getCustomer', customerId);
    return this.customers.get(customerId) ?? null;
  }

  async findCustomerByEmail(email: string): Promise<Customer | null> {
    this.record('findCustomerByEmail', email);
    const needle = email.trim().toLowerCase();
    for (const customer of this.customers.values()) {
      if (customer.email.toLowerCase() === needle) return customer;
    }
    return null;
  }

  async getOrder(orderId: string): Promise<Order | null> {
    this.record('getOrder', orderId);
    return this.orders.get(orderId) ?? null;
  }

  async listOrdersForCustomer(customerId: string): Promise<Order[]> {
    this.record('listOrdersForCustomer', customerId);
    return [...this.orders.values()].filter((order) => order.customerId === customerId);
  }

  async getConversationHistory(ticketId: string): Promise<ConversationTurn[]> {
    this.record('getConversationHistory', ticketId);
    return this.conversation
      .filter((turn) => turn.ticketId === ticketId)
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }

  async getOrchestrationState(
    ticketId: string,
    conversationId: string,
  ): Promise<OrchestrationState | null> {
    this.record('getOrchestrationState', ticketId, conversationId);
    return this.orchestration.get(stateKey(ticketId, conversationId)) ?? null;
  }

  async stampContextCalled(
    ticketId: string,
    conversationId: string,
  ): Promise<OrchestrationState> {
    this.record('stampContextCalled', ticketId, conversationId);
    const key = stateKey(ticketId, conversationId);
    const timestamp = this.now().toISOString();
    const existing = this.orchestration.get(key);
    const next: OrchestrationState = {
      ticketId,
      conversationId,
      contextCalledAt: existing?.contextCalledAt ?? timestamp,
      cycleCount: existing?.cycleCount ?? 0,
      updatedAt: timestamp,
    };
    this.orchestration.set(key, next);
    return next;
  }

  async incrementCycleCount(ticketId: string, conversationId: string): Promise<number> {
    this.record('incrementCycleCount', ticketId, conversationId);
    const key = stateKey(ticketId, conversationId);
    const timestamp = this.now().toISOString();
    const existing = this.orchestration.get(key);
    const next: OrchestrationState = {
      ticketId,
      conversationId,
      contextCalledAt: existing?.contextCalledAt ?? null,
      cycleCount: (existing?.cycleCount ?? 0) + 1,
      updatedAt: timestamp,
    };
    this.orchestration.set(key, next);
    return next.cycleCount;
  }

  async setTicketStatus(ticketId: string, status: TicketStatus): Promise<void> {
    this.record('setTicketStatus', ticketId, status);
    const ticket = this.tickets.get(ticketId);
    if (!ticket) throw new Error(`InMemoryTicketDataPort: unknown ticket '${ticketId}'`);
    this.tickets.set(ticketId, { ...ticket, status });
  }

  async appendConversationTurn(
    ticketId: string,
    role: ConversationRole,
    message: string,
  ): Promise<ConversationTurn> {
    this.record('appendConversationTurn', ticketId, role, message);
    const turn: ConversationTurn = {
      id: nextId('turn'),
      ticketId,
      role,
      message,
      timestamp: this.now().toISOString(),
    };
    this.conversation.push(turn);
    return turn;
  }

  async insertResolution(resolution: NewResolution): Promise<Resolution> {
    this.record('insertResolution', resolution);
    const row: Resolution & { embedding: readonly number[] } = {
      id: nextId('res'),
      ticketId: resolution.ticketId,
      content: resolution.content,
      outcome: resolution.outcome,
      source: resolution.source,
      rejectionComments: resolution.rejectionComments,
      createdAt: this.now().toISOString(),
      embedding: resolution.embedding,
    };
    this.resolutions.push(row);
    const { embedding: _embedding, ...stored } = row;
    return stored;
  }

  async searchResolutions(
    embedding: readonly number[],
    options: ResolutionSearchOptions,
  ): Promise<ScoredResolution[]> {
    this.record('searchResolutions', embedding, options);
    if (!Number.isInteger(options.limit) || options.limit <= 0) {
      // §9: unbounded scans of the embedding column are forbidden. The fake enforces it too,
      // so a caller that forgets a LIMIT fails in unit tests, not only against real SQL.
      throw new Error('searchResolutions requires a positive integer `limit`.');
    }
    return this.resolutions
      .filter((row) => (options.outcome ? row.outcome === options.outcome : true))
      .filter((row) => (options.source ? row.source === options.source : true))
      .map(({ embedding: stored, ...rest }) => ({
        ...rest,
        similarity: cosineSimilarity(embedding, stored),
      }))
      .sort((a, b) => b.similarity - a.similarity || b.createdAt.localeCompare(a.createdAt))
      .slice(0, options.limit);
  }
}

function stateKey(ticketId: string, conversationId: string): string {
  return `${ticketId}::${conversationId}`;
}
