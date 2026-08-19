import type { AgentDataPort, OrchestrationTools } from './ports.js';
import {
  type JsonValue,
  planSchema,
  SAFE_ESCALATION_RESPONSE,
  type JobMessage,
  type ResolutionPlan,
} from '../domain/contracts.js';

const MAX_SPECIALIST_CALLS = 3;

export interface OrchestrationToolState {
  tools: OrchestrationTools;
  mustEscalate(): boolean;
  hasCurrentPlan(): boolean;
}

function toJsonValue(value: unknown): JsonValue {
  const encoded = JSON.stringify(value);
  return encoded === undefined ? null : (JSON.parse(encoded) as JsonValue);
}

function toolError(code: string, instruction: string): JsonValue {
  return { error: code, instruction };
}

export function createOrchestrationTools(
  data: AgentDataPort,
  message: JobMessage,
  initialPlan: ResolutionPlan | null | undefined,
  initialPlanRequired: boolean,
): OrchestrationToolState {
  let planSaved = Boolean(initialPlan);
  let planNeedsReview = initialPlanRequired;
  let forcedEscalation = false;

  async function runDomainTool(
    toolName: string,
    operation: () => Promise<unknown>,
  ): Promise<JsonValue> {
    if (!planSaved || planNeedsReview) {
      return toolError('PLAN_REQUIRED', 'Call save_plan before any domain tool.');
    }

    const permit = await data.beginToolCall(message.jobId, toolName);
    if (!permit.allowed && permit.reason === 'PLAN_REQUIRED') {
      planNeedsReview = true;
      return toolError('PLAN_REQUIRED', 'Review and save the plan before another domain tool.');
    }
    if (!permit.allowed || permit.cycleCount > MAX_SPECIALIST_CALLS) {
      forcedEscalation = true;
      await data.escalateJob(message.jobId, SAFE_ESCALATION_RESPONSE, 'CYCLE_LIMIT');
      return toolError('CYCLE_LIMIT', 'Stop using tools and return an escalation.');
    }

    planNeedsReview = true;
    try {
      const result = await operation();
      await data.recordToolResult(message.jobId, toolName, result);
      return toJsonValue(result);
    } catch (error) {
      const errorMessage = error instanceof Error
        ? error.message.replace(/[\r\n]+/g, ' ').slice(0, 500)
        : 'Unknown tool error';
      await data.recordToolResult(message.jobId, toolName, {
        error: 'TOOL_FAILED',
        type: error instanceof Error ? error.name : 'UnknownError',
        message: errorMessage,
      });
      throw error;
    }
  }

  return {
    tools: {
      async savePlan(plan) {
        const validated = planSchema.parse(plan);
        await data.savePlan(message.jobId, validated);
        planSaved = true;
        planNeedsReview = false;
        return { saved: true };
      },
      getTracking(input) {
        return runDomainTool('get_tracking', () =>
          data.getTracking(message.jobId, input.orderId),
        );
      },
      searchResolutions(input) {
        return runDomainTool('search_resolutions', () =>
          data.searchResolutions(message.jobId, input.query, input.category, input.limit),
        );
      },
      recordTicketNote(input) {
        return runDomainTool('record_ticket_note', () =>
          data.recordTicketNote(
            message.jobId,
            message.ticketId,
            input.note,
            input.visibility,
          ),
        );
      },
    },
    mustEscalate: () => forcedEscalation,
    hasCurrentPlan: () => planSaved && !planNeedsReview,
  };
}
