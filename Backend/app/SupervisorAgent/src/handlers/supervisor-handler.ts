import type { SQSBatchResponse, SQSEvent, SQSRecord } from 'aws-lambda';
import type { ProcessJobDependencies } from '../application/process-job.js';
import { processJob } from '../application/process-job.js';
import { jobMessageSchema, type JobMessage } from '../domain/contracts.js';

function receiveCount(record: SQSRecord): number {
  const parsed = Number.parseInt(record.attributes.ApproximateReceiveCount ?? '1', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

export function createSupervisorHandler(dependencies: ProcessJobDependencies) {
  return async (event: SQSEvent): Promise<SQSBatchResponse> => {
    const failures: SQSBatchResponse['batchItemFailures'] = [];
    for (const record of event.Records) {
      let message: JobMessage | undefined;
      try {
        message = jobMessageSchema.parse(JSON.parse(record.body));
        await processJob(message, receiveCount(record), dependencies);
      } catch (error) {
        console.error(
          JSON.stringify({
            event: 'supervisor_job_failed',
            messageId: record.messageId,
            jobId: message?.jobId,
            ticketId: message?.ticketId,
            conversationId: message?.conversationId,
            error: error instanceof Error ? error.name : 'UnknownError',
          }),
        );
        failures.push({ itemIdentifier: record.messageId });
      }
    }
    return { batchItemFailures: failures };
  };
}

