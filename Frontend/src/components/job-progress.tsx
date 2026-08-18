import { Check, Circle, LoaderCircle } from 'lucide-react';
import type { JobStatus } from '../types/tickets';

const steps = [
  { key: 'submitted', label: 'Submitted', detail: 'Your ticket is safely in the queue.' },
  { key: 'reviewing', label: 'Reviewing', detail: 'Our support agent is working on it.' },
  { key: 'response', label: 'Response ready', detail: 'Your next step will appear here.' },
] as const;

function activeIndex(status: JobStatus): number {
  if (status === 'queued') return 0;
  if (status === 'running') return 1;
  return 2;
}

export function JobProgress({ status }: { status: JobStatus }) {
  const current = activeIndex(status);
  const pending = status === 'queued' || status === 'running';

  return (
    <ol className="space-y-0">
      {steps.map((step, index) => {
        const done = index < current || (!pending && index === current);
        const active = pending && index === current;
        return (
          <li key={step.key} className="relative flex gap-3 pb-7 last:pb-0">
            {index < steps.length - 1 && (
              <span className={`absolute left-[15px] top-8 h-[calc(100%-1.25rem)] w-px ${index < current ? 'bg-teal' : 'bg-slate-200'}`} />
            )}
            <span
              className={`relative z-10 grid size-8 shrink-0 place-items-center rounded-full ring-4 ring-white ${
                done ? 'bg-teal text-white' : active ? 'bg-navy text-white' : 'bg-slate-100 text-slate-400'
              }`}
            >
              {done ? <Check size={15} strokeWidth={3} /> : active ? <LoaderCircle className="animate-spin" size={15} /> : <Circle size={12} />}
            </span>
            <span className="pt-0.5">
              <span className={`block text-sm font-bold ${done || active ? 'text-slate-900' : 'text-slate-400'}`}>{step.label}</span>
              <span className="mt-0.5 block text-sm text-slate-500">{step.detail}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}
