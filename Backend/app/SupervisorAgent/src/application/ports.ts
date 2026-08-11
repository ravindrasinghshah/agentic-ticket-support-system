import type {
  AgentJob,
  AgentOutcome,
  ConversationMessage,
  JobMessage,
  JsonValue,
  ResolutionPlan,
} from '../domain/contracts.js';

export interface ClaimResult {
  claimed: boolean;
  status: AgentJob['status'];
  currentPlan?: ResolutionPlan | null;
  planRequired?: boolean;
  cycleCount?: number;
  toolResults?: unknown[];
}

export interface ToolCallPermit {
  allowed: boolean;
  cycleCount: number;
  reason?: 'PLAN_REQUIRED' | 'CYCLE_LIMIT';
}

export interface AgentDataPort {
  disconnect(): Promise<void>;
  ticketExists(ticketId: string): Promise<boolean>;
  createJob(message: JobMessage): Promise<AgentJob>;
  getJob(jobId: string): Promise<AgentJob | null>;
  failJob(jobId: string, errorCode: string): Promise<void>;
  claimJob(jobId: string, attempt: number): Promise<ClaimResult>;
  loadTicketContext(ticketId: string, conversationId: string): Promise<unknown>;
  loadConversation(ticketId: string, conversationId: string): Promise<ConversationMessage[]>;
  savePlan(jobId: string, plan: ResolutionPlan): Promise<void>;
  beginToolCall(jobId: string, toolName: string): Promise<ToolCallPermit>;
  recordToolResult(jobId: string, toolName: string, result: unknown): Promise<void>;
  getTracking(jobId: string, orderId?: string): Promise<unknown>;
  searchResolutions(
    jobId: string,
    query: string,
    category: string | undefined,
    limit: number,
  ): Promise<unknown>;
  recordTicketNote(
    jobId: string,
    ticketId: string,
    note: string,
    visibility: 'internal' | 'customer',
  ): Promise<unknown>;
  appendMessage(
    ticketId: string,
    conversationId: string,
    role: 'user' | 'assistant',
    message: string,
  ): Promise<void>;
  completeJob(jobId: string, response: string): Promise<boolean>;
  escalateJob(jobId: string, response: string, errorCode: string): Promise<boolean>;
}

export interface JobQueue {
  send(message: JobMessage): Promise<void>;
}

export interface OrchestrationTools {
  savePlan(plan: ResolutionPlan): Promise<{ saved: true }>;
  getTracking(input: { orderId?: string }): Promise<JsonValue>;
  searchResolutions(input: {
    query: string;
    category?: string;
    limit: number;
  }): Promise<JsonValue>;
  recordTicketNote(input: {
    note: string;
    visibility: 'internal' | 'customer';
  }): Promise<JsonValue>;
}

export interface AgentRunInput {
  context: unknown;
  conversation: ConversationMessage[];
  priorToolResults: unknown[];
  tools: OrchestrationTools;
  timeoutMs: number;
}

export interface AgentRunner {
  run(input: AgentRunInput): Promise<AgentOutcome>;
}
