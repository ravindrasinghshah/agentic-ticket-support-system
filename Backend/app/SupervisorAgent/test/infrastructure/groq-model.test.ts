import { strict as assert } from 'node:assert';
import { afterEach, test } from 'node:test';
import {
  DEFAULT_GROQ_MODEL_ID,
  loadGroqModel,
} from '../../src/infrastructure/groq/model.js';

const originalApiKey = process.env.GROQ_API_KEY;
const originalModelId = process.env.GROQ_MODEL_ID;

afterEach(() => {
  if (originalApiKey === undefined) delete process.env.GROQ_API_KEY;
  else process.env.GROQ_API_KEY = originalApiKey;
  if (originalModelId === undefined) delete process.env.GROQ_MODEL_ID;
  else process.env.GROQ_MODEL_ID = originalModelId;
});

test('loads Groq through the OpenAI-compatible chat provider', () => {
  process.env.GROQ_API_KEY = 'test-groq-api-key';
  process.env.GROQ_MODEL_ID = 'test/groq-model';

  const model = loadGroqModel();

  assert.equal(model.api, 'chat');
  assert.equal(model.getConfig().modelId, 'test/groq-model');
});

test('uses the production Groq default and requires an API key', () => {
  delete process.env.GROQ_API_KEY;
  delete process.env.GROQ_MODEL_ID;
  assert.throws(() => loadGroqModel(), /GROQ_API_KEY/);

  process.env.GROQ_API_KEY = 'test-groq-api-key';
  assert.equal(loadGroqModel().getConfig().modelId, DEFAULT_GROQ_MODEL_ID);
});
