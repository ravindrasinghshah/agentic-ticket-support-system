/**
 * The single source of the embedding dimension.
 *
 * ARCHITECTURE.md §9.2: exactly one embedding model and one dimension for the whole
 * `resolutions` table. Vectors from different models are not comparable, and mixing them
 * corrupts similarity search *without erroring* — the only remedy is re-embedding every row.
 *
 * The model is **user-specified at Gate 6 and never assumed**, so the dimension cannot be a
 * literal constant today. It is a single resolver instead, consumed by both the migration
 * DDL (`VECTOR(n)`) and the embedding client — never written down twice. Until the user
 * supplies the model, `EMBEDDING_DIM` is REPLACE_ME and every path through here fails loudly.
 */

import type { AppConfig } from './config.ts';

export const EMBEDDING_DIM_VAR = 'EMBEDDING_DIM';
export const EMBEDDING_MODEL_VAR = 'EMBEDDING_MODEL_ID';

/**
 * Whether the Gate 6 decision has been made. Both the model ID and the dimension must be
 * present — one without the other is not a usable configuration.
 *
 * The doctor's embedding-model check reports SKIPPED while this is false, so a guessed model
 * can never become a de facto decision.
 */
export function isEmbeddingModelSpecified(config: AppConfig): boolean {
  return config.has(EMBEDDING_MODEL_VAR) && config.has(EMBEDDING_DIM_VAR);
}

/** The dimension every stored vector must have. Throws until Gate 6 supplies it. */
export function embeddingDim(config: AppConfig): number {
  const dim = config.getInt(EMBEDDING_DIM_VAR);
  if (dim <= 0) {
    throw new Error(
      `${EMBEDDING_DIM_VAR} must be a positive integer, got ${dim}. ` +
        'It is the output dimension of EMBEDDING_MODEL_ID — see docs/CONFIGURATION.md.',
    );
  }
  return dim;
}

export class EmbeddingDimensionError extends Error {
  override readonly name = 'EmbeddingDimensionError';
  constructor(
    readonly expected: number,
    readonly actual: number,
  ) {
    super(
      `Embedding dimension mismatch: expected ${expected}, model returned ${actual}. ` +
        'Every vector in `resolutions` must come from one model at one dimension ' +
        '(ARCHITECTURE.md §9.2). Refusing to write — a mismatched vector corrupts similarity ' +
        'search silently. Either EMBEDDING_MODEL_ID changed or EMBEDDING_DIM is wrong.',
    );
  }
}

/**
 * Runtime length assertion, applied to every vector before it is stored. This is what turns
 * a model or dimension swap into an immediate loud failure instead of silent corruption.
 */
export function assertEmbeddingLength(vector: readonly number[], expectedDim: number): void {
  if (vector.length !== expectedDim) {
    throw new EmbeddingDimensionError(expectedDim, vector.length);
  }
}
