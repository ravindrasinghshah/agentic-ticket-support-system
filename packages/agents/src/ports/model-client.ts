/**
 * `ModelClient` — the Bedrock foundation model the supervisor reasons with, and that the
 * refund and dispute specialists use to *explain* (never decide) a verdict.
 *
 * Behind an interface so every unit test runs with zero credentials and zero network.
 */

export interface ModelMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ModelRequest {
  /** System prompt. For specialists this carries the current policy prose, never thresholds. */
  system?: string;
  messages: ModelMessage[];
  maxTokens?: number;
  temperature?: number;
}

export interface ModelResponse {
  text: string;
  stopReason: string;
  usage: { inputTokens: number; outputTokens: number };
}

export interface ModelClient {
  /** The resolved model ID, so log lines and traces can record which model produced what. */
  readonly modelId: string;
  complete(request: ModelRequest): Promise<ModelResponse>;
}

export const MODEL_CLIENT_METHODS = ['complete'] as const;
