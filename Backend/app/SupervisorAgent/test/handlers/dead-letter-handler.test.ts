import assert from 'node:assert/strict';
import test from 'node:test';
import type { SQSEvent, SQSRecord } from 'aws-lambda';
import { createDeadLetterHandler } from '../../src/handlers/dead-letter-handler.js';
import { FakeDataPort, JOB_MESSAGE } from '../support/fakes.js';

function record(body: string): SQSRecord {
  return {
    messageId: 'message-id',
    receiptHandle: 'receipt',
    body,
    attributes: {
      ApproximateReceiveCount: '4',
      SentTimestamp: '0',
      SenderId: 'sender',
      ApproximateFirstReceiveTimestamp: '0',
    },
    messageAttributes: {},
    md5OfBody: '',
    eventSource: 'aws:sqs',
    eventSourceARN: 'arn:aws:sqs:us-east-1:123456789012:dlq',
    awsRegion: 'us-east-1',
  };
}

test('DLQ delivery records a customer-safe terminal escalation', async () => {
  const data = new FakeDataPort();
  const handler = createDeadLetterHandler({ createDataClient: async () => data });
  await handler({ Records: [record(JSON.stringify(JOB_MESSAGE))] } as SQSEvent);
  assert.ok(data.calls.includes('escalateJob:RETRIES_EXHAUSTED'));
  assert.equal(data.calls.at(-1), 'disconnect');
});

test('malformed DLQ messages are logged and ignored without database access', async () => {
  let opened = false;
  const handler = createDeadLetterHandler({
    createDataClient: async () => {
      opened = true;
      return new FakeDataPort();
    },
  });
  await handler({ Records: [record('{}')] } as SQSEvent);
  assert.equal(opened, false);
});
