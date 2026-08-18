import type { CreatedTicket } from '../types/tickets';

const STORAGE_KEY = 'resolve:last-ticket';

export function saveLastTicket(ticket: CreatedTicket): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(ticket));
}

export function loadLastTicket(): CreatedTicket | null {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    if (!value) return null;
    const parsed = JSON.parse(value) as Partial<CreatedTicket>;
    if (!parsed.ticketId || !parsed.conversationId || !parsed.jobId) return null;
    return { ...parsed, status: 'queued' } as CreatedTicket;
  } catch {
    return null;
  }
}
