import { InferenceClient } from '@huggingface/inference';
import { requiredEnvironment } from '../../config/environment.js';

export const EMBEDDING_MODEL = 'sentence-transformers/all-MiniLM-L6-v2';
export const EMBEDDING_DIMENSION = 384;

export interface EmbeddingClient {
  embed(text: string): Promise<number[]>;
}

function vectorFromResult(result: unknown): number[] {
  const candidate =
    Array.isArray(result) && result.length === 1 && Array.isArray(result[0])
      ? result[0]
      : result;
  if (
    !Array.isArray(candidate) ||
    candidate.some((value) => typeof value !== 'number' || !Number.isFinite(value))
  ) {
    throw new Error('Hugging Face returned an unexpected embedding shape');
  }
  if (candidate.length !== EMBEDDING_DIMENSION) {
    throw new Error(
      `Expected ${EMBEDDING_DIMENSION} embedding dimensions, received ${candidate.length}`,
    );
  }
  return candidate as number[];
}

export class HuggingFaceEmbeddingClient implements EmbeddingClient {
  constructor(private readonly token: () => string = () => requiredEnvironment('HF_TOKEN')) {}

  async embed(text: string): Promise<number[]> {
    const input = text.trim();
    if (!input) throw new Error('Embedding input cannot be empty');
    const result = await new InferenceClient(this.token()).featureExtraction({
      provider: 'hf-inference',
      model: EMBEDDING_MODEL,
      inputs: input,
      normalize: true,
    });
    return vectorFromResult(result);
  }
}

