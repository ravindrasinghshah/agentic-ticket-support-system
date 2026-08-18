import { createDeadLetterHandler } from './src/handlers/dead-letter-handler.js';
import { createMcpDataClient } from './src/infrastructure/mcp/cockroach-mcp-data-client.js';

export const handler = createDeadLetterHandler({ createDataClient: createMcpDataClient });
