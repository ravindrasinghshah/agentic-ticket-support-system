import { describe, expect, it, vi } from 'vitest';
import { createHandler } from '../src/handler.js';

const runtimeArn = 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/healthcheck';

function event(body: string | undefined, method = 'POST') {
  return {
    body,
    requestContext: { requestId: 'request-123', http: { method } },
  } as any;
}

function makeHandler(reply = 'AGENTCORE_HEALTHY') {
  const send = vi.fn().mockResolvedValue({
    response: { transformToString: vi.fn().mockResolvedValue(reply) },
  });
  const handler = createHandler({
    client: { send },
    runtimeArn,
    requestId: () => 'generated-id',
    now: () => 10,
    log: { info: vi.fn(), error: vi.fn() },
  });
  return { handler, send };
}

describe('AgentCore healthcheck Lambda', () => {
  it('invokes AgentCore and returns the final response', async () => {
    const { handler, send } = makeHandler();
    const result = await handler(event('{"message":"healthcheck","sessionId":"healthcheck-001"}'));

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body!)).toMatchObject({
      requestId: 'request-123',
      sessionId: 'healthcheck-001',
      agentRuntimeArn: runtimeArn,
      reply: 'AGENTCORE_HEALTHY',
    });
    expect(send).toHaveBeenCalledOnce();
  });

  it('generates a valid session ID when none is supplied', async () => {
    const { handler } = makeHandler();
    const result = await handler(event('{"message":"healthcheck"}'));
    expect(JSON.parse(result.body!).sessionId).toMatch(/^healthcheck-[A-Za-z0-9-]+$/);
  });

  it.each([
    ['invalid JSON', '{'],
    ['missing message', '{}'],
    ['invalid session', '{"message":"ok","sessionId":"!"}'],
  ])('returns 400 for %s', async (_name, body) => {
    const { handler } = makeHandler();
    expect((await handler(event(body))).statusCode).toBe(400);
  });

  it('returns 405 for non-POST requests', async () => {
    const { handler } = makeHandler();
    expect((await handler(event(undefined, 'GET'))).statusCode).toBe(405);
  });

  it('returns 502 when AgentCore returns no final text', async () => {
    const { handler } = makeHandler('   ');
    expect((await handler(event('{"message":"healthcheck"}'))).statusCode).toBe(502);
  });

  it('returns 502 when the AgentCore client fails', async () => {
    const { handler, send } = makeHandler();
    send.mockRejectedValueOnce(new Error('Access denied'));
    expect((await handler(event('{"message":"healthcheck"}'))).statusCode).toBe(502);
  });
});
