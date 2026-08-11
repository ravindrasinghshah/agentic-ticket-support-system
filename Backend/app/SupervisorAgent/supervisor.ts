import { positiveIntegerEnvironment } from './src/config/environment.js';
import { StrandsAgentRunner } from './src/agent/strands-agent-runner.js';
import { createSupervisorHandler } from './src/handlers/supervisor-handler.js';
import { loadBedrockModel } from './src/infrastructure/bedrock/model.js';
import { createMcpDataClient } from './src/infrastructure/mcp/cockroach-mcp-data-client.js';

export const handler = createSupervisorHandler({
  createDataClient: createMcpDataClient,
  agentRunner: new StrandsAgentRunner(loadBedrockModel),
  timeoutMs: positiveIntegerEnvironment('AGENT_TIMEOUT_MS', 780_000),
});
