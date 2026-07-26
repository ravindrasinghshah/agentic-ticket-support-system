/**
 * `PrecedentSource` — "similar past resolutions", the learning memory the context clerk and
 * the dispute specialist read.
 *
 * This interface is the clearest test of the modularity contract in the whole build. It is
 * backed by *fixtures* at Gates 2 and 5, and by real embedding-based retrieval over the
 * CockroachDB vector index at Gate 6 — and swapping them must require **no change to any
 * specialist**. If Gate 6 forces a specialist edit, this interface was wrong (plan.md,
 * "Verification bars").
 */

import type { ResolutionOutcome, ResolutionSource } from '@ats/core';

export interface Precedent {
  id: string;
  summary: string;
  outcome: ResolutionOutcome;
  source: ResolutionSource;
  similarity: number;
  createdAt: string;
}

export interface PrecedentQuery {
  /** Free text describing the customer's problem — the ticket, typically. */
  text: string;
  /** Always bounded. Unbounded scans of the embedding column are forbidden (§9). */
  limit: number;
  outcome?: ResolutionOutcome;
  source?: ResolutionSource;
}

export interface PrecedentSource {
  findSimilar(query: PrecedentQuery): Promise<Precedent[]>;
}

export const PRECEDENT_SOURCE_METHODS = ['findSimilar'] as const;
