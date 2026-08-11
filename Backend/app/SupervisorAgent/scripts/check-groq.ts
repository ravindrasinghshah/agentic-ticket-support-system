import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import OpenAI from 'openai';
import {
  DEFAULT_GROQ_MODEL_ID,
  GROQ_API_BASE_URL,
} from '../src/infrastructure/groq/model.js';

function loadConfiguration(): { apiKey: string; modelId: string } {
  const filePath = process.env.CDK_ENV_FILE?.trim()
    ? resolve(process.env.CDK_ENV_FILE)
    : resolve(process.cwd(), '../../infrastructure/.env');
  const file = parseEnv(readFileSync(filePath, 'utf8'));
  const apiKey = process.env.GROQ_API_KEY?.trim() || file.GROQ_API_KEY?.trim();
  if (!apiKey) throw new Error(`GROQ_API_KEY must be configured in the shell or ${filePath}`);
  const modelId =
    process.env.GROQ_MODEL_ID?.trim() ||
    file.GROQ_MODEL_ID?.trim() ||
    DEFAULT_GROQ_MODEL_ID;
  return { apiKey, modelId };
}

async function main(): Promise<void> {
  const { apiKey, modelId } = loadConfiguration();
  const client = new OpenAI({
    apiKey,
    baseURL: GROQ_API_BASE_URL,
    maxRetries: 0,
    timeout: 30_000,
  });
  const result = await client.chat.completions.create({
    model: modelId,
    messages: [{ role: 'user', content: 'Reply with OK.' }],
    max_completion_tokens: 32,
    temperature: 0,
  });
  if (!result.id || result.choices.length === 0) {
    throw new Error('Groq returned an invalid model response');
  }
  console.log(`Groq model preflight passed: ${modelId}`);
}

await main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unknown Groq preflight failure';
  console.error(`Groq model preflight failed: ${message}`);
  process.exitCode = 1;
});
