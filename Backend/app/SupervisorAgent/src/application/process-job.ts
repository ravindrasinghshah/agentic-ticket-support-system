import { createOrchestrationTools } from './orchestration-tools.js';
import {
  SAFE_ESCALATION_RESPONSE,
  type JobMessage,
} from '../domain/contracts.js';
import type { AgentDataPort, AgentRunner } from './ports.js';

export interface ProcessJobDependencies {
  createDataClient(): Promise<AgentDataPort>;
  agentRunner: AgentRunner;
  timeoutMs: number;
}

export async function processJob(
  message: JobMessage,
  attempt: number,
  dependencies: ProcessJobDependencies,
): Promise<void> {
  const data = await dependencies.createDataClient();
  try {
    const claim = await data.claimJob(message.jobId, attempt);
    if (!claim.claimed) {
      console.info(
        JSON.stringify({
          event: 'job_duplicate_skipped',
          jobId: message.jobId,
          ticketId: message.ticketId,
          conversationId: message.conversationId,
          status: claim.status,
        }),
      );
      return;
    }

    console.info(
      JSON.stringify({
        event: 'job_processing_started',
        jobId: message.jobId,
        ticketId: message.ticketId,
        conversationId: message.conversationId,
        attempt,
      }),
    );

    // Context is deliberately loaded before an agent exists or a plan can be formed.
    const context = await data.loadTicketContext(
      message.jobId,
      message.ticketId,
      message.conversationId,
    );
    const conversation = await data.loadConversation(message.ticketId, message.conversationId);
    const orchestration = createOrchestrationTools(
      data,
      message,
      claim.currentPlan,
      claim.planRequired ?? false,
    );

    const outcome = await dependencies.agentRunner.run({
      context,
      conversation,
      priorToolResults: claim.toolResults ?? [],
      tools: orchestration.tools,
      timeoutMs: dependencies.timeoutMs,
    });

    if (!orchestration.hasCurrentPlan()) {
      await data.escalateJob(message.jobId, SAFE_ESCALATION_RESPONSE, 'PLAN_REVIEW_REQUIRED');
      logEscalation(message, 'PLAN_REVIEW_REQUIRED');
      return;
    }

    const response = outcome.response.trim();
    if (!response || orchestration.mustEscalate() || outcome.outcome === 'escalated') {
      const reason = orchestration.mustEscalate() ? 'CYCLE_LIMIT' : 'AGENT_ESCALATED';
      await data.escalateJob(message.jobId, response || SAFE_ESCALATION_RESPONSE, reason);
      logEscalation(message, reason);
      return;
    }

    await data.appendMessage(
      message.jobId,
      message.ticketId,
      message.conversationId,
      'assistant',
      response,
    );
    await data.completeJob(message.jobId, response);
    console.info(
      JSON.stringify({
        event: 'job_completed',
        jobId: message.jobId,
        ticketId: message.ticketId,
        conversationId: message.conversationId,
      }),
    );
  } finally {
    await data.disconnect().catch(() => undefined);
  }
}

function logEscalation(message: JobMessage, reason: string): void {
  console.warn(
    JSON.stringify({
      event: 'job_escalated',
      jobId: message.jobId,
      ticketId: message.ticketId,
      conversationId: message.conversationId,
      reason,
    }),
  );
}
