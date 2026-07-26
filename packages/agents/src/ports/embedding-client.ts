/**
 * `EmbeddingClient` — the boundary to whichever embedding model the user specifies at Gate 6.
 *
 * ARCHITECTURE.md §9.2: CockroachDB stores and searches vectors; it does not generate them.
 * The provider sits behind this interface so it is swappable without touching retrieval
 * logic — but the *stored dimension* is not swappable after the fact, which is why the model
 * is a blocking user decision rather than a default.
 *
 * `dimension` is declared here so `assertEmbeddingLength` can be applied on every call.
 */

export interface EmbeddingClient {
  readonly modelId: string;
  /** Must equal EMBEDDING_DIM. Asserted against the actual returned vector on every embed. */
  readonly dimension: number;
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
}

export const EMBEDDING_CLIENT_METHODS = ['embed', 'embedBatch'] as const;
