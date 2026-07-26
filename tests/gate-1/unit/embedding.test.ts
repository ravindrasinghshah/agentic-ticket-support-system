import { describe, expect, it } from 'vitest';
import {
  EmbeddingDimensionError,
  PLACEHOLDER,
  assertEmbeddingLength,
  createConfig,
  embeddingDim,
  isEmbeddingModelSpecified,
} from '@ats/core';
import { GOOD_ENV } from '../helpers/fake-context.ts';

describe('the embedding dimension is a single source, and the Gate 6 decision is not pre-made', () => {
  it('reports the model as unspecified while either half is still a placeholder', () => {
    expect(isEmbeddingModelSpecified(createConfig(GOOD_ENV))).toBe(false);

    expect(
      isEmbeddingModelSpecified(
        createConfig({ ...GOOD_ENV, EMBEDDING_MODEL_ID: 'x', EMBEDDING_DIM: PLACEHOLDER }),
      ),
    ).toBe(false);

    expect(
      isEmbeddingModelSpecified(
        createConfig({ ...GOOD_ENV, EMBEDDING_MODEL_ID: PLACEHOLDER, EMBEDDING_DIM: '1024' }),
      ),
    ).toBe(false);
  });

  it('reports it specified only when both the model and the dimension are real', () => {
    const config = createConfig({
      ...GOOD_ENV,
      EMBEDDING_MODEL_ID: 'some.embedding-model',
      EMBEDDING_DIM: '1024',
    });
    expect(isEmbeddingModelSpecified(config)).toBe(true);
    expect(embeddingDim(config)).toBe(1024);
  });

  it('refuses to hand out a dimension before Gate 6 supplies one', () => {
    expect(() => embeddingDim(createConfig(GOOD_ENV))).toThrowError(/EMBEDDING_DIM/);
  });

  it('rejects a non-positive dimension', () => {
    const config = createConfig({ ...GOOD_ENV, EMBEDDING_DIM: '0' });
    expect(() => embeddingDim(config)).toThrowError(/positive integer/);
  });
});

describe('the runtime length assertion', () => {
  it('accepts a vector of exactly the expected length', () => {
    expect(() => assertEmbeddingLength([0.1, 0.2, 0.3], 3)).not.toThrow();
  });

  it('rejects a short vector, and says why it matters', () => {
    // Silent corruption is the failure mode this exists to prevent: a wrong-dimension
    // vector does not error at query time, it just makes retrieval quietly worse.
    try {
      assertEmbeddingLength([0.1, 0.2], 3);
      expect.unreachable('expected an EmbeddingDimensionError');
    } catch (error) {
      expect(error).toBeInstanceOf(EmbeddingDimensionError);
      expect((error as Error).message).toContain('expected 3');
      expect((error as Error).message).toContain('returned 2');
      expect((error as Error).message).toContain('Refusing to write');
    }
  });

  it('rejects a long vector too', () => {
    expect(() => assertEmbeddingLength([1, 2, 3, 4], 3)).toThrowError(EmbeddingDimensionError);
  });
});
