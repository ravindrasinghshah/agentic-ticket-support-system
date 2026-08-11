import { randomUUID } from 'node:crypto';
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
  Context,
} from 'aws-lambda';
import { requiredEnvironment } from './src/config/environment.js';
import { createApiHandler } from './src/handlers/job-api-handler.js';
import { SqsJobQueue } from './src/infrastructure/aws/sqs-job-queue.js';
import { createMcpDataClient } from './src/infrastructure/mcp/cockroach-mcp-data-client.js';

let configuredHandler: ReturnType<typeof createApiHandler> | undefined;

export async function handler(
  event: APIGatewayProxyEventV2,
  context: Context,
): Promise<APIGatewayProxyStructuredResultV2> {
  configuredHandler ??= createApiHandler({
    createDataClient: createMcpDataClient,
    queue: new SqsJobQueue(requiredEnvironment('JOB_QUEUE_URL')),
    createId: randomUUID,
    allowedOrigin: requiredEnvironment('CORS_ALLOWED_ORIGIN'),
  });
  return configuredHandler(event, context);
}

