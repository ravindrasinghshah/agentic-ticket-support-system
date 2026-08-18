import type {
  CreatedTicket,
  CreateTicketInput,
  JobResult,
  TicketListResponse,
  TicketSummary,
} from '../types/tickets';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

function configuredBaseUrl(): string {
  const value = import.meta.env.VITE_API_BASE_URL?.trim();
  if (!value) {
    throw new ApiError('The API URL is not configured. Add VITE_API_BASE_URL to Frontend/.env.', 0);
  }
  return value.replace(/\/+$/, '');
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${configuredBaseUrl()}${path}`, {
      ...init,
      headers: {
        ...(init?.body ? { 'content-type': 'application/json' } : {}),
        ...init?.headers,
      },
    });
  } catch {
    throw new ApiError('Unable to reach the support service. Please try again.', 0);
  }

  const payload = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) {
    throw new ApiError(payload.error || 'The support service could not complete the request.', response.status);
  }
  return payload as T;
}

export function createTicket(input: CreateTicketInput): Promise<CreatedTicket> {
  return request('/tickets', { method: 'POST', body: JSON.stringify(input) });
}

export function getTicket(ticketId: string): Promise<TicketSummary> {
  return request(`/tickets/${encodeURIComponent(ticketId)}`);
}

export function listTickets(): Promise<TicketListResponse> {
  return request('/tickets');
}

export function getJob(jobId: string): Promise<JobResult> {
  return request(`/jobs/${encodeURIComponent(jobId)}`);
}
