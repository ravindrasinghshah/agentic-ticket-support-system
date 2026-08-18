import type { SQSEvent } from 'aws-lambda';
import { jobMessageSchema, SAFE_ESCALATION_RESPONSE } from '../domain/contracts.js';
import type { AgentDataPort } from '../application/ports.js';

export interface DeadLetterDependencies {
  createDataClient(): Promise<AgentDataPort>;
}

export function createDeadLetterHandler(dependencies: DeadLetterDependencies) {
  return async (event: SQSEvent): Promise<void> => {
    for (const record of event.Records) {
      let body: unknown;
      try {
        body = JSON.parse(record.body);
      } catch {
        console.error(JSON.stringify({ event: 'invalid_dlq_message', messageId: record.messageId }));
        continue;
      }
      const parsed = jobMessageSchema.safeParse(body);
      if (!parsed.success) {
        console.error(JSON.stringify({ event: 'invalid_dlq_message', messageId: record.messageId }));
        continue;
      }

      const data = await dependencies.createDataClient();
      try {
        await data.escalateJob(
          parsed.data.jobId,
          SAFE_ESCALATION_RESPONSE,
          'RETRIES_EXHAUSTED',
        );
        console.warn(
          JSON.stringify({
            event: 'job_escalated_from_dlq',
            jobId: parsed.data.jobId,
            ticketId: parsed.data.ticketId,
            conversationId: parsed.data.conversationId,
          }),
        );
      } finally {
        await data.disconnect().catch(() => undefined);
      }
    }
  };
}
