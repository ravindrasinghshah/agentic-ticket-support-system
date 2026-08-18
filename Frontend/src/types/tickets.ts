export const ticketCategories = [
  'delivery',
  'returns',
  'billing',
  'account',
  'product',
  'other',
] as const;

export type TicketCategory = (typeof ticketCategories)[number];
export type TicketStatus =
  | 'open'
  | 'processing'
  | 'awaiting_customer'
  | 'resolved'
  | 'escalated';
export type JobStatus = 'queued' | 'running' | 'completed' | 'escalated' | 'failed';

export interface CreateTicketInput {
  subject: string;
  description: string;
  category: TicketCategory;
}

export interface CreatedTicket {
  ticketId: string;
  conversationId: string;
  jobId: string;
  status: 'queued';
}

export interface JobResult {
  jobId: string;
  conversationId: string;
  status: JobStatus;
  response?: string;
}

export interface TicketSummary extends CreateTicketInput {
  ticketId: string;
  conversationId: string;
  status: TicketStatus;
  createdAt: string;
  updatedAt: string;
  jobId: string | null;
  jobStatus: JobStatus | null;
  response: string | null;
}

export interface TicketListResponse {
  tickets: TicketSummary[];
  count: number;
}
