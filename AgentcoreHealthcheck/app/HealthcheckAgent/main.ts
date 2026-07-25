import { BedrockAgentCoreApp } from 'bedrock-agentcore/runtime';
import { Agent } from '@strands-agents/sdk';
import { BedrockModel } from '@strands-agents/sdk/models/bedrock';

const marker = 'AGENTCORE_HEALTHY';
const modelId = process.env.BEDROCK_MODEL_ID;

if (!modelId || modelId === 'REPLACE_ME') {
  throw new Error('BEDROCK_MODEL_ID must be configured before the AgentCore healthcheck runtime starts.');
}

const agent = new Agent({
  model: new BedrockModel({ modelId }),
  systemPrompt: [
    'You are the infrastructure healthcheck agent for the ticket support system.',
    `For every request, begin your answer with ${marker}.`,
    'Keep the answer to one short sentence. Do not call tools or request external data.'
  ].join(' '),
});

const app = new BedrockAgentCoreApp({
  invocationHandler: {
    async *process(payload: unknown) {
      const prompt = getPrompt(payload);

      for await (const event of agent.stream(prompt)) {
        if (
          event.type === 'modelStreamUpdateEvent' &&
          event.event?.type === 'modelContentBlockDeltaEvent' &&
          event.event.delta?.type === 'textDelta'
        ) {
          yield { data: event.event.delta.text };
        }
      }
    },
  },
});

function getPrompt(payload: unknown): string {
  if (
    typeof payload === 'object' &&
    payload !== null &&
    'prompt' in payload &&
    typeof payload.prompt === 'string' &&
    payload.prompt.trim().length > 0
  ) {
    return payload.prompt.trim();
  }

  return 'Run the healthcheck.';
}

app.run({ port: Number.parseInt(process.env.PORT ?? '8080', 10) });
