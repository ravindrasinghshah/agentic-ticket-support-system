import { OpenAIModel } from '@strands-agents/sdk/models/openai';
import { requiredEnvironment } from '../../config/environment.js';

export const GROQ_API_BASE_URL = 'https://api.groq.com/openai/v1';
export const DEFAULT_GROQ_MODEL_ID = 'openai/gpt-oss-120b';

/**
 * Groq implements the OpenAI Chat Completions protocol. Keeping this adapter behind the Strands
 * Model interface leaves the orchestration loop independent of the inference provider.
 */
export function loadGroqModel(): OpenAIModel {
  return new OpenAIModel({
    api: 'chat',
    apiKey: requiredEnvironment('GROQ_API_KEY'),
    modelId: process.env.GROQ_MODEL_ID?.trim() || DEFAULT_GROQ_MODEL_ID,
    maxTokens: 4_096,
    temperature: 0.1,
    params: {
      parallel_tool_calls: false,
      reasoning_effort: 'low',
    },
    clientConfig: {
      baseURL: GROQ_API_BASE_URL,
      maxRetries: 1,
      timeout: 120_000,
    },
  });
}
