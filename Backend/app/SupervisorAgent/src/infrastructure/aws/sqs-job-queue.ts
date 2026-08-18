import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { JobQueue } from '../../application/ports.js';
import type { JobMessage } from '../../domain/contracts.js';

export class SqsJobQueue implements JobQueue {
  constructor(
    private readonly queueUrl: string,
    private readonly client = new SQSClient({}),
  ) {}

  async send(message: JobMessage): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: JSON.stringify(message),
      }),
    );
  }
}

