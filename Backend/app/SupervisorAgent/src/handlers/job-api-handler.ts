import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
  Context,
} from 'aws-lambda';
import { z } from 'zod';
import { jobMessageSchema, uuidSchema } from '../domain/contracts.js';
import type { AgentDataPort, JobQueue } from '../application/ports.js';

const createJobRequestSchema = z
  .object({
    ticketId: uuidSchema,
    conversationId: uuidSchema,
  })
  .strict();

const MAX_BODY_BYTES = 4_096;

export interface ApiDependencies {
  createDataClient(): Promise<AgentDataPort>;
  queue: JobQueue;
  createId(): string;
  allowedOrigin: string;
}

function jsonResponse(
  statusCode: number,
  body: unknown,
  allowedOrigin: string,
): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': allowedOrigin,
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': 'content-type',
    },
    body: JSON.stringify(body),
  };
}

function requestBody(event: APIGatewayProxyEventV2): string {
  if (!event.body) throw new Error('EMPTY_BODY');
  const buffer = Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf8');
  if (buffer.byteLength > MAX_BODY_BYTES) throw new Error('BODY_TOO_LARGE');
  return buffer.toString('utf8');
}

function jobIdFromPath(path: string): string | undefined {
  const match = /^\/?jobs\/([^/]+)\/?$/.exec(path);
  return match?.[1];
}

export function createApiHandler(dependencies: ApiDependencies) {
  return async (
    event: APIGatewayProxyEventV2,
    _context?: Context,
  ): Promise<APIGatewayProxyStructuredResultV2> => {
    const method = event.requestContext.http.method.toUpperCase();
    const path = event.rawPath || '/';

    if (method === 'OPTIONS') return jsonResponse(204, {}, dependencies.allowedOrigin);

    if (method === 'POST' && /^\/?jobs\/?$/.test(path)) {
      const contentType = event.headers['content-type']?.toLowerCase() ?? '';
      if (!contentType.startsWith('application/json')) {
        return jsonResponse(415, { error: 'Content-Type must be application/json' }, dependencies.allowedOrigin);
      }

      let request: z.infer<typeof createJobRequestSchema>;
      try {
        request = createJobRequestSchema.parse(JSON.parse(requestBody(event)));
      } catch {
        return jsonResponse(400, { error: 'Invalid request' }, dependencies.allowedOrigin);
      }

      let data: AgentDataPort;
      try {
        data = await dependencies.createDataClient();
      } catch (error) {
        console.error(
          JSON.stringify({
            event: 'job_api_connection_error',
            error: error instanceof Error ? error.name : 'UnknownError',
          }),
        );
        return jsonResponse(500, { error: 'Unable to process request' }, dependencies.allowedOrigin);
      }
      try {
        if (!(await data.ticketExists(request.ticketId))) {
          return jsonResponse(404, { error: 'Ticket not found' }, dependencies.allowedOrigin);
        }

        const message = jobMessageSchema.parse({
          schemaVersion: 1,
          jobId: dependencies.createId(),
          ...request,
        });
        await data.createJob(message);

        try {
          await dependencies.queue.send(message);
        } catch (error) {
          console.error(
            JSON.stringify({
              event: 'job_enqueue_failed',
              jobId: message.jobId,
              error: error instanceof Error ? error.name : 'UnknownError',
            }),
          );
          await data.failJob(message.jobId, 'QUEUE_PUBLISH_FAILED');
          return jsonResponse(500, { error: 'Unable to submit job' }, dependencies.allowedOrigin);
        }

        console.info(
          JSON.stringify({
            event: 'job_queued',
            jobId: message.jobId,
            ticketId: message.ticketId,
            conversationId: message.conversationId,
          }),
        );

        return jsonResponse(
          202,
          {
            jobId: message.jobId,
            conversationId: message.conversationId,
            status: 'queued',
          },
          dependencies.allowedOrigin,
        );
      } catch (error) {
        console.error(
          JSON.stringify({
            event: 'job_api_error',
            error: error instanceof Error ? error.name : 'UnknownError',
          }),
        );
        return jsonResponse(500, { error: 'Unable to process request' }, dependencies.allowedOrigin);
      } finally {
        await data.disconnect().catch(() => undefined);
      }
    }

    if (method === 'GET') {
      const jobId = jobIdFromPath(path);
      if (!jobId || !uuidSchema.safeParse(jobId).success) {
        return jsonResponse(404, { error: 'Job not found' }, dependencies.allowedOrigin);
      }

      let data: AgentDataPort;
      try {
        data = await dependencies.createDataClient();
      } catch (error) {
        console.error(
          JSON.stringify({
            event: 'job_status_connection_error',
            jobId,
            error: error instanceof Error ? error.name : 'UnknownError',
          }),
        );
        return jsonResponse(500, { error: 'Unable to process request' }, dependencies.allowedOrigin);
      }
      try {
        const job = await data.getJob(jobId);
        if (!job) return jsonResponse(404, { error: 'Job not found' }, dependencies.allowedOrigin);

        return jsonResponse(
          200,
          {
            jobId: job.jobId,
            conversationId: job.conversationId,
            status: job.status,
            ...(job.status === 'completed' || job.status === 'escalated'
              ? { response: job.response ?? '' }
              : {}),
          },
          dependencies.allowedOrigin,
        );
      } catch (error) {
        console.error(
          JSON.stringify({
            event: 'job_status_error',
            jobId,
            error: error instanceof Error ? error.name : 'UnknownError',
          }),
        );
        return jsonResponse(500, { error: 'Unable to process request' }, dependencies.allowedOrigin);
      } finally {
        await data.disconnect().catch(() => undefined);
      }
    }

    return jsonResponse(404, { error: 'Not found' }, dependencies.allowedOrigin);
  };
}
