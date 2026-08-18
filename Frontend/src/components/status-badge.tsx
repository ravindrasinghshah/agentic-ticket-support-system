import { AlertTriangle, CheckCircle2, CircleDot, Clock3, LoaderCircle } from 'lucide-react';
import type { JobStatus, TicketStatus } from '../types/tickets';
import { sentenceCase } from '../lib/format';

type Status = JobStatus | TicketStatus;

const statusStyles: Record<Status, string> = {
  queued: 'bg-amber-50 text-amber-700 ring-amber-200',
  running: 'bg-sky-50 text-sky-700 ring-sky-200',
  completed: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  failed: 'bg-rose-50 text-rose-700 ring-rose-200',
  open: 'bg-violet-50 text-violet-700 ring-violet-200',
  processing: 'bg-sky-50 text-sky-700 ring-sky-200',
  awaiting_customer: 'bg-amber-50 text-amber-700 ring-amber-200',
  resolved: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  escalated: 'bg-orange-50 text-orange-700 ring-orange-200',
};

function StatusIcon({ status }: { status: Status }) {
  if (status === 'running' || status === 'processing') return <LoaderCircle className="animate-spin" size={13} />;
  if (status === 'completed' || status === 'resolved') return <CheckCircle2 size={13} />;
  if (status === 'failed' || status === 'escalated') return <AlertTriangle size={13} />;
  if (status === 'queued' || status === 'awaiting_customer') return <Clock3 size={13} />;
  return <CircleDot size={13} />;
}

export function StatusBadge({ status }: { status: Status }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-bold ring-1 ring-inset ${statusStyles[status]}`}>
      <StatusIcon status={status} />
      {sentenceCase(status)}
    </span>
  );
}
