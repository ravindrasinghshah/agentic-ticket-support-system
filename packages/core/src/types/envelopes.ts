/**
 * Specialist tool payloads and the two refusal envelopes, transcribed from
 * ARCHITECTURE.md §4 and §5.
 *
 * The refusal envelopes are the observable form of the durable guards. They are defined at
 * Gate 1 so that Gates 2–5 all conform to one shape rather than each inventing its own — the
 * contract tests in every later gate assert against these types.
 */

import type { OrderStatus, ResolutionOutcome, ResolutionSource, TicketStatus } from './domain.ts';

/** §5 invariant 1 — a specialist was called before the context agent. */
export const CONTEXT_REQUIRED = 'CONTEXT_REQUIRED';
/** §5 invariant 2 — the 3-cycle cap was reached. */
export const CYCLE_LIMIT = 'CYCLE_LIMIT';

export type RefusalCode = typeof CONTEXT_REQUIRED | typeof CYCLE_LIMIT;

/**
 * What a specialist returns instead of doing work. The `instruction` field is addressed to
 * the supervisor, not the customer — it tells the agent what to do next.
 */
export interface RefusalEnvelope {
  error: RefusalCode;
  instruction: string;
}

export const CONTEXT_REQUIRED_ENVELOPE: RefusalEnvelope = {
  error: CONTEXT_REQUIRED,
  instruction: 'Call the context specialist first.',
};

export const CYCLE_LIMIT_ENVELOPE: RefusalEnvelope = {
  error: CYCLE_LIMIT,
  instruction: 'Escalate to a human and inform the customer.',
};

export function isRefusal(value: unknown): value is RefusalEnvelope {
  if (typeof value !== 'object' || value === null) return false;
  const error = (value as { error?: unknown }).error;
  return error === CONTEXT_REQUIRED || error === CYCLE_LIMIT;
}

// ── §4.1 Context agent ──────────────────────────────────────────────────────────────────

export interface SimilarResolution {
  id?: string;
  summary: string;
  outcome: ResolutionOutcome;
  source: ResolutionSource;
  similarity: number;
}

/**
 * §4.1. Shape is complete from Gate 2, but partially populated until later gates:
 * `order` is null until Gate 3 creates order_history, and `similarResolutions` is empty
 * until Gate 6 creates the vector index. Consumers must tolerate both.
 */
export interface ContextPayload {
  ticket: {
    id: string;
    title: string;
    description: string;
    status: TicketStatus;
  };
  customer: {
    id: string;
    name: string;
    email: string;
  };
  order: {
    id: string;
    status: OrderStatus;
    orderValueCents: number;
    createdAt: string;
    shippedAt: string | null;
    receivedAt: string | null;
  } | null;
  similarResolutions: SimilarResolution[];
}

// ── §4.2 Tracking specialist ────────────────────────────────────────────────────────────

/** Reports state only. Makes no policy decisions — money rules belong to the other two. */
export interface TrackingPayload {
  orderId: string | null;
  status: OrderStatus | null;
  shippedAt: string | null;
  estimatedNarrative: string;
}

// ── §4.3 Refund specialist ──────────────────────────────────────────────────────────────

export type RefundVerdict = 'auto_approve' | 'escalate';

export const REFUND_REASON_CODES = [
  'WITHIN_7_DAYS_PRE_SHIPMENT',
  'RETURNED_UNDER_300_WITHIN_30_DAYS',
  'REFUND_POLICY_ESCALATION',
] as const;
export type RefundReasonCode = (typeof REFUND_REASON_CODES)[number];

export interface RefundPayload {
  verdict: RefundVerdict;
  reasonCode: RefundReasonCode;
  policyCitation: string;
  /** The only field the LLM writes. It explains the verdict; it never decides it. */
  explanation: string;
}

// ── §4.4 Dispute specialist ─────────────────────────────────────────────────────────────

export type DisputeVerdict = 'auto_resolve' | 'escalate';

export const DISPUTE_REASON_CODES = ['UNDER_300_THRESHOLD', 'OVER_300_THRESHOLD'] as const;
export type DisputeReasonCode = (typeof DISPUTE_REASON_CODES)[number];

export interface DisputePayload {
  verdict: DisputeVerdict;
  reasonCode: DisputeReasonCode;
  /** The only field the LLM writes. */
  draftResponse: string;
  /** Resolution IDs the draft was informed by. Present on auto_resolve, absent on escalate. */
  informedBy?: string[];
}

/** Any specialist either returns its payload or refuses. */
export type SpecialistResult<T> = T | RefusalEnvelope;
