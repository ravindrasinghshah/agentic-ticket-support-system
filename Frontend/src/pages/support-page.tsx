import {
  ArrowRight,
  Check,
  Clipboard,
  Clock3,
  Headphones,
  LoaderCircle,
  Search,
  Send,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import { type FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError, createTicket, getJob, getTicket } from '../lib/api';
import { shortId } from '../lib/format';
import { loadLastTicket, saveLastTicket } from '../lib/tracking-storage';
import type { CreatedTicket, CreateTicketInput, JobResult, TicketCategory } from '../types/tickets';
import { ticketCategories } from '../types/tickets';
import { JobProgress } from '../components/job-progress';
import { StatusBadge } from '../components/status-badge';

const fieldClass =
  'mt-2 w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-teal focus:ring-4 focus:ring-teal/10';

const initialForm: CreateTicketInput = {
  subject: '',
  description: '',
  category: 'delivery',
};

function readableError(error: unknown): string {
  return error instanceof ApiError ? error.message : 'Something went wrong. Please try again.';
}

export function SupportPage() {
  const [form, setForm] = useState<CreateTicketInput>(initialForm);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState('');
  const [tracking, setTracking] = useState<CreatedTicket | null>(() => loadLastTicket());
  const [job, setJob] = useState<JobResult | null>(null);
  const [lookupId, setLookupId] = useState('');
  const [lookupError, setLookupError] = useState('');
  const [lookingUp, setLookingUp] = useState(false);
  const [copied, setCopied] = useState(false);

  const pollJob = useCallback(async (jobId: string) => {
    const result = await getJob(jobId);
    setJob(result);
    return result;
  }, []);

  useEffect(() => {
    if (!tracking) return;
    let cancelled = false;
    let timer: number | undefined;

    const poll = async () => {
      try {
        const result = await getJob(tracking.jobId);
        if (cancelled) return;
        setJob(result);
        if (result.status === 'queued' || result.status === 'running') {
          timer = window.setTimeout(poll, 4_000);
        }
      } catch (error) {
        if (!cancelled) setLookupError(readableError(error));
      }
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [tracking]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setFormError('');
    try {
      const created = await createTicket(form);
      saveLastTicket(created);
      setTracking(created);
      setJob({
        jobId: created.jobId,
        conversationId: created.conversationId,
        status: created.status,
      });
      setForm(initialForm);
    } catch (error) {
      setFormError(readableError(error));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleLookup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalized = lookupId.trim();
    if (!normalized) return;
    setLookingUp(true);
    setLookupError('');
    try {
      const ticket = await getTicket(normalized);
      if (!ticket.jobId || !ticket.jobStatus) {
        throw new ApiError('This ticket does not have an active support job yet.', 404);
      }
      const tracked: CreatedTicket = {
        ticketId: ticket.ticketId,
        conversationId: ticket.conversationId,
        jobId: ticket.jobId,
        status: 'queued',
      };
      saveLastTicket(tracked);
      setTracking(tracked);
      setJob({
        jobId: ticket.jobId,
        conversationId: ticket.conversationId,
        status: ticket.jobStatus,
        response: ticket.response ?? undefined,
      });
      await pollJob(ticket.jobId);
    } catch (error) {
      setLookupError(readableError(error));
    } finally {
      setLookingUp(false);
    }
  }

  async function copyTicketId() {
    if (!tracking) return;
    await navigator.clipboard.writeText(tracking.ticketId);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_500);
  }

  const currentStatus = job?.status ?? tracking?.status;
  const terminalResponse = job?.response;
  const responseTitle = useMemo(() => {
    if (job?.status === 'escalated') return 'A specialist is taking over';
    if (job?.status === 'failed') return 'We need another look';
    return 'Your support update';
  }, [job?.status]);

  return (
    <>
      <section className="relative overflow-hidden border-b border-slate-200 bg-white">
        <div className="hero-grid absolute inset-0 opacity-50" />
        <div className="relative mx-auto max-w-7xl px-5 py-14 sm:py-18 lg:px-8">
          <div className="max-w-3xl">
            <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-teal/20 bg-mint px-3 py-1.5 text-xs font-bold uppercase tracking-[0.14em] text-teal-dark">
              <Sparkles size={14} /> Agent-assisted support
            </div>
            <h1 className="font-display text-4xl font-bold leading-[1.08] tracking-[-0.04em] text-navy sm:text-6xl">
              Support, without<br className="hidden sm:block" /> the runaround.
            </h1>
            <p className="mt-5 max-w-2xl text-base leading-7 text-slate-600 sm:text-lg">
              Tell us what happened. Our support agent reviews the details, checks the right systems, and keeps your answer in one place.
            </p>
          </div>
          <div className="mt-8 flex flex-wrap gap-x-6 gap-y-3 text-sm font-semibold text-slate-600">
            <span className="flex items-center gap-2"><Clock3 className="text-teal" size={17} /> Live status updates</span>
            <span className="flex items-center gap-2"><ShieldCheck className="text-teal" size={17} /> Safe escalation to a person</span>
            <span className="flex items-center gap-2"><Headphones className="text-teal" size={17} /> One ticket, full context</span>
          </div>
        </div>
      </section>

      <section className="mx-auto grid max-w-7xl gap-6 px-5 py-10 lg:grid-cols-[1.15fr_0.85fr] lg:px-8 lg:py-14">
        <div className="surface-card p-6 sm:p-8">
          <div className="mb-7 flex items-start justify-between gap-4">
            <div>
              <p className="eyebrow">New request</p>
              <h2 className="mt-2 font-display text-2xl font-bold tracking-tight text-navy">How can we help?</h2>
              <p className="mt-2 text-sm leading-6 text-slate-500">Share enough detail for us to investigate without asking you to repeat yourself.</p>
            </div>
            <span className="hidden size-11 place-items-center rounded-xl bg-mint text-teal sm:grid"><Send size={19} /></span>
          </div>

          <form onSubmit={handleSubmit} className="space-y-5">
            <label className="block text-sm font-bold text-slate-700">
              What is this about?
              <input
                className={fieldClass}
                value={form.subject}
                onChange={(event) => setForm((current) => ({ ...current, subject: event.target.value }))}
                minLength={3}
                maxLength={120}
                placeholder="e.g. My package has not arrived"
                required
              />
            </label>

            <label className="block text-sm font-bold text-slate-700">
              Category
              <select
                className={fieldClass}
                value={form.category}
                onChange={(event) => setForm((current) => ({ ...current, category: event.target.value as TicketCategory }))}
              >
                {ticketCategories.map((category) => (
                  <option key={category} value={category}>{category[0].toUpperCase() + category.slice(1)}</option>
                ))}
              </select>
            </label>

            <label className="block text-sm font-bold text-slate-700">
              Tell us what happened
              <textarea
                className={`${fieldClass} min-h-36 resize-y`}
                value={form.description}
                onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))}
                minLength={10}
                maxLength={2_000}
                placeholder="Include what you expected, what happened, and any details that may help."
                required
              />
              <span className="mt-2 block text-right text-xs font-medium text-slate-400">{form.description.length} / 2,000</span>
            </label>

            {formError && <p role="alert" className="rounded-xl bg-rose-50 px-4 py-3 text-sm font-semibold text-rose-700">{formError}</p>}

            <button className="primary-button w-full sm:w-auto" disabled={submitting}>
              {submitting ? <LoaderCircle className="animate-spin" size={17} /> : <Send size={17} />}
              {submitting ? 'Submitting…' : 'Submit ticket'}
              {!submitting && <ArrowRight size={17} />}
            </button>
          </form>
        </div>

        <aside className="space-y-6">
          <div className="surface-card p-6 sm:p-8">
            <div className="mb-6">
              <p className="eyebrow">Track a request</p>
              <h2 className="mt-2 font-display text-2xl font-bold tracking-tight text-navy">Ticket status</h2>
            </div>

            <form onSubmit={handleLookup} className="flex gap-2">
              <label className="sr-only" htmlFor="ticket-lookup">Ticket ID</label>
              <div className="relative min-w-0 flex-1">
                <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" size={17} />
                <input
                  id="ticket-lookup"
                  className="w-full rounded-xl border border-slate-200 bg-white py-3 pl-10 pr-3 text-sm outline-none transition placeholder:text-slate-400 focus:border-teal focus:ring-4 focus:ring-teal/10"
                  value={lookupId}
                  onChange={(event) => setLookupId(event.target.value)}
                  placeholder="Paste your ticket ID"
                />
              </div>
              <button className="secondary-button" disabled={lookingUp} aria-label="Look up ticket">
                {lookingUp ? <LoaderCircle className="animate-spin" size={17} /> : 'Track'}
              </button>
            </form>
            {lookupError && <p role="alert" className="mt-3 text-sm font-semibold text-rose-600">{lookupError}</p>}

            {tracking && currentStatus ? (
              <div className="mt-7 border-t border-slate-100 pt-7">
                <div className="mb-7 flex items-center justify-between gap-3">
                  <div>
                    <span className="block text-xs font-bold uppercase tracking-[0.14em] text-slate-400">Ticket</span>
                    <span className="mt-1 block font-mono text-lg font-bold text-navy">#{shortId(tracking.ticketId)}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <StatusBadge status={currentStatus} />
                    <button onClick={copyTicketId} type="button" className="icon-button" aria-label="Copy full ticket ID">
                      {copied ? <Check size={16} /> : <Clipboard size={16} />}
                    </button>
                  </div>
                </div>
                <JobProgress status={currentStatus} />

                {(terminalResponse || job?.status === 'failed') && (
                  <div className="mt-7 rounded-2xl border border-teal/15 bg-mint/70 p-5">
                    <span className="flex items-center gap-2 text-sm font-bold text-teal-dark"><Sparkles size={16} /> {responseTitle}</span>
                    <p className="mt-3 whitespace-pre-line text-sm leading-6 text-slate-700">
                      {terminalResponse || 'We could not finish the automated review. A support specialist can continue from your saved ticket.'}
                    </p>
                  </div>
                )}
              </div>
            ) : (
              <div className="mt-7 rounded-2xl border border-dashed border-slate-200 bg-slate-50/70 px-6 py-10 text-center">
                <div className="mx-auto grid size-11 place-items-center rounded-full bg-white text-slate-400 shadow-sm"><Search size={19} /></div>
                <p className="mt-4 text-sm font-bold text-slate-700">No ticket selected</p>
                <p className="mt-1 text-sm leading-6 text-slate-500">Submit a new request or paste an existing ticket ID above.</p>
              </div>
            )}
          </div>

          <div className="rounded-2xl bg-navy p-6 text-white shadow-xl shadow-navy/10">
            <div className="flex gap-4">
              <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-white/10 text-teal-light"><ShieldCheck size={19} /></span>
              <div>
                <h3 className="font-display font-bold">You are never stuck with automation.</h3>
                <p className="mt-2 text-sm leading-6 text-slate-300">If the agent cannot safely resolve your request, the full context is preserved for a support specialist.</p>
              </div>
            </div>
          </div>
        </aside>
      </section>
    </>
  );
}
