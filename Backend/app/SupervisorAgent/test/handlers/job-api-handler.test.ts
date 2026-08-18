import assert from 'node:assert/strict';
import test from 'node:test';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { createApiHandler } from '../../src/handlers/job-api-handler.js';
import type { JobQueue } from '../../src/application/ports.js';
import type { JobMessage } from '../../src/domain/contracts.js';
import { FakeDataPort, JOB_MESSAGE } from '../support/fakes.js';

function event(method: string, path: string, body?: unknown): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: '$default',
    rawPath: path,
    rawQueryString: '',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    requestContext: {
      accountId: 'anonymous',
      apiId: 'function-url',
      domainName: 'example.test',
      domainPrefix: 'example',
      http: { method, path, protocol: 'HTTP/1.1', sourceIp: '127.0.0.1', userAgent: 'test' },
      requestId: 'request-id',
      routeKey: '$default',
      stage: '$default',
      time: 'now',
      timeEpoch: 0,
    },
    isBase64Encoded: false,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

test('POST creates durable state before publishing and GET returns completed response', async () => {
  const data = new FakeDataPort();
  const published: JobMessage[] = [];
  const queue: JobQueue = { async send(message) { published.push(message); } };
  const handler = createApiHandler({
    createDataClient: async () => data,
    queue,
    createId: () => JOB_MESSAGE.jobId,
    allowedOrigin: 'https://frontend.example',
  });

  const post = await handler(
    event('POST', '/jobs', {
      ticketId: JOB_MESSAGE.ticketId,
      conversationId: JOB_MESSAGE.conversationId,
    }),
  );
  assert.equal(post.statusCode, 202);
  assert.deepEqual(data.calls.slice(0, 2), ['ticketExists', 'createJob']);
  assert.equal(published.length, 1);

  data.jobs.set(JOB_MESSAGE.jobId, {
    ...JOB_MESSAGE,
    status: 'completed',
    cycleCount: 1,
    response: 'Your order is on the way.',
  });
  const get = await handler(event('GET', `/jobs/${JOB_MESSAGE.jobId}`));
  assert.equal(get.statusCode, 200);
  assert.deepEqual(JSON.parse(get.body ?? '{}'), {
    jobId: JOB_MESSAGE.jobId,
    conversationId: JOB_MESSAGE.conversationId,
    status: 'completed',
    response: 'Your order is on the way.',
  });
});

test('POST /tickets creates a ticket and job before publishing, then exposes ticket views', async () => {
  const data = new FakeDataPort();
  const published: JobMessage[] = [];
  const ids = [JOB_MESSAGE.ticketId, JOB_MESSAGE.conversationId, JOB_MESSAGE.jobId];
  const handler = createApiHandler({
    createDataClient: async () => data,
    queue: { async send(message) { published.push(message); } },
    createId: () => ids.shift() ?? JOB_MESSAGE.jobId,
    allowedOrigin: 'https://frontend.example',
  });

  const created = await handler(
    event('POST', '/tickets', {
      subject: 'Where is my order?',
      description: 'My delivery has not arrived yet.',
      category: 'delivery',
    }),
  );

  assert.equal(created.statusCode, 202);
  assert.deepEqual(JSON.parse(created.body ?? '{}'), {
    ticketId: JOB_MESSAGE.ticketId,
    conversationId: JOB_MESSAGE.conversationId,
    jobId: JOB_MESSAGE.jobId,
    status: 'queued',
  });
  assert.deepEqual(data.calls.slice(0, 2), ['createTicket', 'createJob']);
  assert.deepEqual(published, [JOB_MESSAGE]);

  const one = await handler(event('GET', `/tickets/${JOB_MESSAGE.ticketId}`));
  assert.equal(one.statusCode, 200);
  assert.equal(JSON.parse(one.body ?? '{}').subject, 'Where is my order?');

  const all = await handler(event('GET', '/tickets'));
  assert.equal(all.statusCode, 200);
  assert.equal(JSON.parse(all.body ?? '{}').count, 1);
});

test('POST /tickets validates the customer payload before opening an MCP connection', async () => {
  let opened = false;
  const handler = createApiHandler({
    createDataClient: async () => {
      opened = true;
      return new FakeDataPort();
    },
    queue: { async send() {} },
    createId: () => JOB_MESSAGE.jobId,
    allowedOrigin: 'https://frontend.example',
  });

  const response = await handler(
    event('POST', '/tickets', {
      subject: 'Hi',
      description: 'Too short',
      category: 'anything',
    }),
  );
  assert.equal(response.statusCode, 400);
  assert.equal(opened, false);
});

test('POST rejects invalid input before opening an MCP connection', async () => {
  let opened = false;
  const handler = createApiHandler({
    createDataClient: async () => {
      opened = true;
      return new FakeDataPort();
    },
    queue: { async send() {} },
    createId: () => JOB_MESSAGE.jobId,
    allowedOrigin: 'https://frontend.example',
  });

  const response = await handler(event('POST', '/jobs', { ticketId: 'not-a-uuid' }));
  assert.equal(response.statusCode, 400);
  assert.equal(opened, false);
});

test('GET exposes every public status and responses only for terminal answer states', async () => {
  const data = new FakeDataPort();
  const handler = createApiHandler({
    createDataClient: async () => data,
    queue: { async send() {} },
    createId: () => JOB_MESSAGE.jobId,
    allowedOrigin: 'https://frontend.example',
  });

  for (const status of ['queued', 'running', 'completed', 'escalated', 'failed'] as const) {
    data.jobs.set(JOB_MESSAGE.jobId, {
      ...JOB_MESSAGE,
      status,
      cycleCount: 0,
      response: status === 'completed' || status === 'escalated' ? `${status} response` : null,
      errorCode: status === 'failed' ? 'INTERNAL_CODE' : null,
    });
    const response = await handler(event('GET', `/jobs/${JOB_MESSAGE.jobId}`));
    const body = JSON.parse(response.body ?? '{}') as Record<string, unknown>;
    assert.equal(body.status, status);
    assert.equal(
      'response' in body,
      status === 'completed' || status === 'escalated',
    );
    assert.equal('errorCode' in body, false);
  }
});

test('queue publication failure moves the durable job to failed', async () => {
  const data = new FakeDataPort();
  const handler = createApiHandler({
    createDataClient: async () => data,
    queue: { async send() { throw new Error('offline'); } },
    createId: () => JOB_MESSAGE.jobId,
    allowedOrigin: 'https://frontend.example',
  });

  const response = await handler(
    event('POST', '/jobs', {
      ticketId: JOB_MESSAGE.ticketId,
      conversationId: JOB_MESSAGE.conversationId,
    }),
  );
  assert.equal(response.statusCode, 500);
  assert.ok(data.calls.includes('failJob:QUEUE_PUBLISH_FAILED'));
});
