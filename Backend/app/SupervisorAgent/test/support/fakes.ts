import type {
  AgentJob,
  ConversationMessage,
  JobMessage,
  NewTicket,
  ResolutionPlan,
  TicketSummary,
} from '../../src/domain/contracts.js';
import type {
  AgentDataPort,
  ClaimResult,
  ToolCallPermit,
} from '../../src/application/ports.js';

export const JOB_MESSAGE: JobMessage = {
  schemaVersion: 1,
  jobId: '11111111-1111-4111-8111-111111111111',
  ticketId: '22222222-2222-4222-8222-222222222222',
  conversationId: '33333333-3333-4333-8333-333333333333',
};

export class FakeDataPort implements AgentDataPort {
  readonly calls: string[] = [];
  readonly jobs = new Map<string, AgentJob>();
  readonly tickets = new Map<string, TicketSummary>();
  claimResult: ClaimResult = { claimed: true, status: 'running', currentPlan: null };
  permitResults: ToolCallPermit[] = [];
  resolutionSearchResult: unknown = [];

  async disconnect(): Promise<void> {
    this.calls.push('disconnect');
  }

  async ticketExists(_ticketId: string): Promise<boolean> {
    this.calls.push('ticketExists');
    return true;
  }

  async createTicket(ticket: NewTicket): Promise<TicketSummary> {
    this.calls.push('createTicket');
    const created: TicketSummary = {
      ...ticket,
      status: 'open',
      createdAt: '2026-08-11T00:00:00.000Z',
      updatedAt: '2026-08-11T00:00:00.000Z',
      jobId: null,
      jobStatus: null,
      response: null,
    };
    this.tickets.set(ticket.ticketId, created);
    return created;
  }

  async getTicket(ticketId: string): Promise<TicketSummary | null> {
    this.calls.push('getTicket');
    return this.tickets.get(ticketId) ?? null;
  }

  async listTickets(limit: number): Promise<TicketSummary[]> {
    this.calls.push('listTickets');
    return [...this.tickets.values()].slice(0, limit);
  }

  async createJob(message: JobMessage): Promise<AgentJob> {
    this.calls.push('createJob');
    const job: AgentJob = { ...message, status: 'queued', cycleCount: 0 };
    this.jobs.set(message.jobId, job);
    const ticket = this.tickets.get(message.ticketId);
    if (ticket) {
      this.tickets.set(message.ticketId, {
        ...ticket,
        jobId: message.jobId,
        jobStatus: 'queued',
      });
    }
    return job;
  }

  async getJob(jobId: string): Promise<AgentJob | null> {
    this.calls.push('getJob');
    return this.jobs.get(jobId) ?? null;
  }

  async failJob(jobId: string, errorCode: string): Promise<void> {
    this.calls.push(`failJob:${errorCode}`);
    const job = this.jobs.get(jobId);
    if (job) this.jobs.set(jobId, { ...job, status: 'failed', errorCode });
  }

  async claimJob(_jobId: string, _attempt: number): Promise<ClaimResult> {
    this.calls.push('claimJob');
    return this.claimResult;
  }

  async loadTicketContext(
    _jobId: string,
    _ticketId: string,
    _conversationId: string,
  ): Promise<unknown> {
    this.calls.push('loadTicketContext');
    return { ticket: { title: 'Where is my order?' }, order: { id: JOB_MESSAGE.ticketId } };
  }

  async loadConversation(
    _ticketId: string,
    _conversationId: string,
  ): Promise<ConversationMessage[]> {
    this.calls.push('loadConversation');
    return [{ role: 'user', message: 'Where is it?' }];
  }

  async savePlan(_jobId: string, _plan: ResolutionPlan): Promise<void> {
    this.calls.push('savePlan');
  }

  async beginToolCall(_jobId: string, toolName: string): Promise<ToolCallPermit> {
    this.calls.push(`beginToolCall:${toolName}`);
    return this.permitResults.shift() ?? { allowed: true, cycleCount: 1 };
  }

  async recordToolResult(_jobId: string, toolName: string, _result: unknown): Promise<void> {
    this.calls.push(`recordToolResult:${toolName}`);
  }

  async getTracking(_jobId: string, _orderId?: string): Promise<unknown> {
    this.calls.push('getTracking');
    return { status: 'shipped' };
  }

  async searchResolutions(
    _jobId: string,
    _query: string,
    _category: string | undefined,
    _limit: number,
  ): Promise<unknown> {
    this.calls.push('searchResolutions');
    return this.resolutionSearchResult;
  }

  async recordTicketNote(
    _jobId: string,
    _ticketId: string,
    _note: string,
    _visibility: 'internal' | 'customer',
  ): Promise<unknown> {
    this.calls.push('recordTicketNote');
    return { recorded: true };
  }

  async appendMessage(
    _jobId: string,
    _ticketId: string,
    _conversationId: string,
    role: 'user' | 'assistant',
    _message: string,
  ): Promise<void> {
    this.calls.push(`appendMessage:${role}`);
  }

  async completeJob(_jobId: string, _response: string): Promise<boolean> {
    this.calls.push('completeJob');
    return true;
  }

  async escalateJob(_jobId: string, _response: string, errorCode: string): Promise<boolean> {
    this.calls.push(`escalateJob:${errorCode}`);
    return true;
  }
}
