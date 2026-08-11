import { BedrockModel } from '@strands-agents/sdk/models/bedrock';

export function loadBedrockModel(): BedrockModel {
  return new BedrockModel({
    modelId:
      process.env.BEDROCK_MODEL_ID ??
      'global.anthropic.claude-sonnet-4-5-20250929-v1:0',
  });
}

