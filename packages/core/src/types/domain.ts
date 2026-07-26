/**
 * Domain types, transcribed from ARCHITECTURE.md §7 (lifecycle) and §10 (data model).
 *
 * These describe the shape of the data, not the storage. No table exists yet — Gate 1
 * creates no schema. Gates 2, 3, and 6 create the tables these types describe.
 */

/** ARCHITECTURE.md §7. `awaiting_customer` and `unresolved` are refinement #4 over the diagram. */
export const TICKET_STATUSES = [
  'open',
  'awaiting_customer',
  'resolved',
  'unresolved',
  'escalated',
] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

/** The human queue is exactly these two states (ARCHITECTURE.md §7). */
export const QUEUE_STATUSES = ['escalated', 'unresolved'] as const satisfies readonly TicketStatus[];

export const ORDER_STATUSES = [
  'processing',
  'shipped',
  'delivered',
  'shipped_back_to_sender',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const CONVERSATION_ROLES = ['customer', 'agent', 'human_agent', 'system'] as const;
export type ConversationRole = (typeof CONVERSATION_ROLES)[number];

export type ResolutionOutcome = 'resolved' | 'unresolved';
export type ResolutionSource = 'agent' | 'human';

export interface Customer {
  id: string;
  name: string;
  email: string;
  createdAt: string;
}

export interface Order {
  id: string;
  customerId: string;
  status: OrderStatus;
  orderValueCents: number;
  shippedAt: string | null;
  receivedAt: string | null;
  createdAt: string;
}

export interface Ticket {
  id: string;
  customerId: string;
  /** Null when the customer had no orders to pick from — order questions then escalate by rule. */
  orderId: string | null;
  title: string;
  description: string;
  /** Advisory, LLM-assigned. Nothing branches on it. */
  category: string | null;
  /** Advisory, LLM-assigned. Nothing branches on it. */
  priority: string | null;
  status: TicketStatus;
  assignedTo: string | null;
  accessToken: string;
  createdAt: string;
}

export interface ConversationTurn {
  id: string;
  ticketId: string;
  role: ConversationRole;
  message: string;
  timestamp: string;
}

/** ARCHITECTURE.md §5 — the durable authority for both orchestration invariants. */
export interface OrchestrationState {
  ticketId: string;
  conversationId: string;
  contextCalledAt: string | null;
  cycleCount: number;
  updatedAt: string;
}

export interface Resolution {
  id: string;
  ticketId: string;
  content: string;
  outcome: ResolutionOutcome;
  source: ResolutionSource;
  rejectionComments: string | null;
  createdAt: string;
}

/** One specialist call within a run. ARCHITECTURE.md §10, `agent_runs.steps`. */
export interface AgentRunStep {
  tool: string;
  reasonCode?: string;
  policyVersion?: number;
  ms: number;
}

/**
 * The reasoning trace. Written best-effort, off the critical path, and NEVER read by the §5
 * guards — archive only (ARCHITECTURE.md §9.1).
 */
export interface AgentRunTrace {
  ticketId: string;
  conversationId: string;
  planSummary: string;
  steps: AgentRunStep[];
  cyclesUsed: number;
  outcome: 'resolved' | 'unresolved' | 'escalated';
}
