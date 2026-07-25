import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { randomUUID } from 'node:crypto';

const MAX_MESSAGE_LENGTH = 2_000;
const SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]{2,100}$/;

interface RuntimeResponse {
  response?: { transformToString: () => Promise<string> };
}

interface RuntimeClient {
  send(command: InvokeAgentRuntimeCommand): Promise<RuntimeResponse>;
}

interface HealthcheckDependencies {
  client: RuntimeClient;
  runtimeArn: string;
  requestId: () => string;
  now: () => number;
  log: Pick<Console, 'info' | 'error'>;
}

interface RequestBody {
  message?: unknown;
  sessionId?: unknown;
}

export function createHandler(dependencies: HealthcheckDependencies) {
  return async function handler(
    event: APIGatewayProxyEventV2,
  ): Promise<APIGatewayProxyStructuredResultV2> {
    const requestId = event.requestContext.requestId || dependencies.requestId();
    const startedAt = dependencies.now();

    if (event.requestContext.http.method !== 'POST') {
      return response(405, { error: 'METHOD_NOT_ALLOWED' }, { Allow: 'POST' });
    }

    const parsed = parseBody(event.body);
    if (!parsed.ok) {
      return response(400, { error: parsed.error });
    }

    const validation = validateRequest(parsed.value);
    if (!validation.ok) {
      return response(400, { error: validation.error });
    }

    const { message, sessionId } = validation.value;

    try {
      const command = new InvokeAgentRuntimeCommand({
        agentRuntimeArn: dependencies.runtimeArn,
        runtimeSessionId: sessionId,
        qualifier: 'DEFAULT',
        contentType: 'application/json',
        accept: 'application/json',
        payload: JSON.stringify({ prompt: message }),
      });
      const runtimeResponse = await dependencies.client.send(command);
      const reply = (await runtimeResponse.response?.transformToString())?.trim();

      if (!reply) {
        dependencies.log.error({ requestId, sessionId, error: 'EMPTY_AGENTCORE_REPLY' });
        return response(502, { error: 'EMPTY_AGENTCORE_REPLY', requestId });
      }

      dependencies.log.info({
        requestId,
        sessionId,
        runtimeArn: dependencies.runtimeArn,
        durationMs: dependencies.now() - startedAt,
        statusCode: 200,
        replyLength: reply.length,
      });

      return response(200, {
        requestId,
        sessionId,
        agentRuntimeArn: dependencies.runtimeArn,
        reply,
      });
    } catch (error) {
      dependencies.log.error({
        requestId,
        sessionId,
        runtimeArn: dependencies.runtimeArn,
        durationMs: dependencies.now() - startedAt,
        errorName: error instanceof Error ? error.name : 'UnknownError',
      });
      return response(502, { error: 'AGENTCORE_UNAVAILABLE', requestId });
    }
  };
}

function parseBody(body: string | undefined): { ok: true; value: RequestBody } | { ok: false; error: string } {
  if (!body) return { ok: false, error: 'INVALID_JSON' };

  try {
    const value: unknown = JSON.parse(body);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return { ok: false, error: 'INVALID_JSON' };
    }
    return { ok: true, value: value as RequestBody };
  } catch {
    return { ok: false, error: 'INVALID_JSON' };
  }
}

function validateRequest(
  body: RequestBody,
): { ok: true; value: { message: string; sessionId: string } } | { ok: false; error: string } {
  if (typeof body.message !== 'string' || body.message.trim().length === 0) {
    return { ok: false, error: 'MESSAGE_REQUIRED' };
  }
  if (body.message.length > MAX_MESSAGE_LENGTH) {
    return { ok: false, error: 'MESSAGE_TOO_LONG' };
  }

  const sessionId = body.sessionId ?? `healthcheck-${randomUUID()}`;
  if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) {
    return { ok: false, error: 'INVALID_SESSION_ID' };
  }

  return { ok: true, value: { message: body.message.trim(), sessionId } };
}

function response(
  statusCode: number,
  body: Record<string, unknown>,
  additionalHeaders: Record<string, string> = {},
): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode,
    headers: {
      'content-type': 'application/json',
      ...additionalHeaders,
    },
    body: JSON.stringify(body),
  };
}

const client = new BedrockAgentCoreClient({ region: process.env.AWS_REGION });
export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> {
  return createHandler({
    client,
    runtimeArn: requiredRuntimeArn(),
    requestId: randomUUID,
    now: Date.now,
    log: console,
  })(event);
}

function requiredRuntimeArn(): string {
  const runtimeArn = process.env.AGENTCORE_RUNTIME_ARN;
  if (!runtimeArn || runtimeArn === 'REPLACE_ME') {
    throw new Error('AGENTCORE_RUNTIME_ARN must be configured before the Lambda starts.');
  }
  return runtimeArn;
}
