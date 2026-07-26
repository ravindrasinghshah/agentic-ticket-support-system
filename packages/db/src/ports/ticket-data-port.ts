/**
 * `TicketDataPort` — the single interface for all agent-side data access
 * (ARCHITECTURE.md §11).
 *
 * Two implementations arrive at Gate 3, selected by DB_ACCESS_MODE:
 *   - SqlAdapter (default) — pooled pg connection cached at module scope
 *   - McpAdapter          — the CockroachDB managed MCP server (diagram note 14)
 *
 * Whether a Lambda can authenticate to the managed MCP server is the project's largest
 * technical unknown. Defining the port up front turns that unknown into a config flip
 * instead of a build blocker, which is why the interface exists at Gate 1 while neither
 * real implementation does.
 *
 * The web app's list/detail reads always use direct pooled SQL regardless of mode — MCP is
 * the agent's tool surface, not a CRUD API.
 */

import type {
  ConversationRole,
  ConversationTurn,
  Customer,
  OrchestrationState,
  Order,
  Resolution,
  ResolutionOutcome,
  ResolutionSource,
  Ticket,
  TicketStatus,
} from '@ats/core';

export interface ResolutionSearchOptions {
  /** Always bounded. Unbounded scans of the embedding column are forbidden (§9). */
  limit: number;
  outcome?: ResolutionOutcome;
  source?: ResolutionSource;
}

export interface ScoredResolution extends Resolution {
  similarity: number;
}

export interface NewResolution {
  ticketId: string;
  content: string;
  outcome: ResolutionOutcome;
  source: ResolutionSource;
  rejectionComments: string | null;
  embedding: readonly number[];
}

export interface TicketDataPort {
  // ── Reads ─────────────────────────────────────────────────────────────────────────
  getTicket(ticketId: string): Promise<Ticket | null>;
  getCustomer(customerId: string): Promise<Customer | null>;
  findCustomerByEmail(email: string): Promise<Customer | null>;
  getOrder(orderId: string): Promise<Order | null>;
  listOrdersForCustomer(customerId: string): Promise<Order[]>;
  getConversationHistory(ticketId: string): Promise<ConversationTurn[]>;

  // ── Orchestration state — the durable authority for both §5 invariants ────────────
  getOrchestrationState(
    ticketId: string,
    conversationId: string,
  ): Promise<OrchestrationState | null>;
  /** Idempotently creates the row if absent. Called by the context clerk. */
  stampContextCalled(ticketId: string, conversationId: string): Promise<OrchestrationState>;
  /** Atomically increments and returns the new count. Called on every specialist invocation. */
  incrementCycleCount(ticketId: string, conversationId: string): Promise<number>;

  // ── Writes ────────────────────────────────────────────────────────────────────────
  setTicketStatus(ticketId: string, status: TicketStatus): Promise<void>;
  appendConversationTurn(
    ticketId: string,
    role: ConversationRole,
    message: string,
  ): Promise<ConversationTurn>;

  // ── Learning memory (Gate 6) ──────────────────────────────────────────────────────
  insertResolution(resolution: NewResolution): Promise<Resolution>;
  searchResolutions(
    embedding: readonly number[],
    options: ResolutionSearchOptions,
  ): Promise<ScoredResolution[]>;
}

/** Method names the contract tests assert every implementation exposes. */
export const TICKET_DATA_PORT_METHODS = [
  'getTicket',
  'getCustomer',
  'findCustomerByEmail',
  'getOrder',
  'listOrdersForCustomer',
  'getConversationHistory',
  'getOrchestrationState',
  'stampContextCalled',
  'incrementCycleCount',
  'setTicketStatus',
  'appendConversationTurn',
  'insertResolution',
  'searchResolutions',
] as const satisfies readonly (keyof TicketDataPort)[];
