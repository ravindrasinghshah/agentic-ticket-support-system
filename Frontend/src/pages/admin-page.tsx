import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  CheckCircle2,
  Inbox,
  LoaderCircle,
  RefreshCw,
  Search,
  Sparkles,
  TicketCheck,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError, listTickets } from '../lib/api';
import { formatDate, sentenceCase, shortId } from '../lib/format';
import type { JobStatus, TicketSummary } from '../types/tickets';
import { StatusBadge } from '../components/status-badge';

type Filter = 'all' | JobStatus;

function metricPercent(part: number, whole: number): string {
  return whole ? `${Math.round((part / whole) * 100)}%` : '0%';
}

export function AdminPage() {
  const [tickets, setTickets] = useState<TicketSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');

  const load = useCallback(async (quiet = false) => {
    quiet ? setRefreshing(true) : setLoading(true);
    setError('');
    try {
      const result = await listTickets();
      setTickets(result.tickets);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Unable to load tickets.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(true), 15_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const metrics = useMemo(() => {
    const active = tickets.filter((ticket) => ticket.jobStatus === 'queued' || ticket.jobStatus === 'running').length;
    const completed = tickets.filter((ticket) => ticket.jobStatus === 'completed').length;
    const escalated = tickets.filter((ticket) => ticket.jobStatus === 'escalated').length;
    return { active, completed, escalated };
  }, [tickets]);

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return tickets.filter((ticket) => {
      const matchesFilter = filter === 'all' || ticket.jobStatus === filter;
      const matchesSearch =
        !normalized ||
        ticket.subject.toLowerCase().includes(normalized) ||
        ticket.ticketId.toLowerCase().includes(normalized) ||
        ticket.category.toLowerCase().includes(normalized);
      return matchesFilter && matchesSearch;
    });
  }, [filter, query, tickets]);

  const categoryCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const ticket of tickets) counts.set(ticket.category, (counts.get(ticket.category) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  }, [tickets]);

  return (
    <section className="mx-auto min-h-[calc(100vh-9rem)] max-w-7xl px-5 py-10 lg:px-8 lg:py-12">
      <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="mb-3 inline-flex items-center gap-2 text-xs font-bold uppercase tracking-[0.16em] text-teal-dark">
            <Activity size={15} /> Operations overview
          </div>
          <h1 className="font-display text-3xl font-bold tracking-[-0.035em] text-navy sm:text-4xl">Ticket command center</h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-500 sm:text-base">Monitor the queue, spot escalation patterns, and see where the support agent is making progress.</p>
        </div>
        <button className="secondary-button self-start sm:self-auto" onClick={() => void load(true)} disabled={refreshing}>
          <RefreshCw className={refreshing ? 'animate-spin' : ''} size={16} />
          Refresh
        </button>
      </div>

      {error && (
        <div role="alert" className="mt-7 flex items-center gap-3 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-semibold text-rose-700">
          <AlertTriangle size={18} /> {error}
        </div>
      )}

      <div className="mt-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard icon={Inbox} label="Total tickets" value={tickets.length.toString()} detail="Latest 100 requests" tone="navy" />
        <MetricCard icon={Activity} label="In progress" value={metrics.active.toString()} detail={`${metricPercent(metrics.active, tickets.length)} of total`} tone="sky" />
        <MetricCard icon={CheckCircle2} label="Completed by agent" value={metrics.completed.toString()} detail={`${metricPercent(metrics.completed, tickets.length)} completion rate`} tone="teal" />
        <MetricCard icon={AlertTriangle} label="Escalated" value={metrics.escalated.toString()} detail={`${metricPercent(metrics.escalated, tickets.length)} need human review`} tone="orange" />
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-[1fr_300px]">
        <div className="surface-card overflow-hidden">
          <div className="flex flex-col gap-3 border-b border-slate-100 p-5 sm:flex-row sm:items-center sm:justify-between">
            <div className="relative w-full sm:max-w-xs">
              <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
              <input
                className="w-full rounded-xl border border-slate-200 bg-slate-50 py-2.5 pl-10 pr-3 text-sm outline-none transition placeholder:text-slate-400 focus:border-teal focus:bg-white focus:ring-4 focus:ring-teal/10"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search ticket, ID, or category"
              />
            </div>
            <select
              className="rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm font-semibold text-slate-600 outline-none focus:border-teal focus:ring-4 focus:ring-teal/10"
              value={filter}
              onChange={(event) => setFilter(event.target.value as Filter)}
              aria-label="Filter by agent status"
            >
              <option value="all">All agent statuses</option>
              <option value="queued">Queued</option>
              <option value="running">Running</option>
              <option value="completed">Completed</option>
              <option value="escalated">Escalated</option>
              <option value="failed">Failed</option>
            </select>
          </div>

          {loading ? (
            <div className="grid min-h-80 place-items-center text-slate-500">
              <span className="flex items-center gap-2 text-sm font-semibold"><LoaderCircle className="animate-spin text-teal" size={18} /> Loading tickets…</span>
            </div>
          ) : filtered.length === 0 ? (
            <div className="grid min-h-80 place-items-center px-6 text-center">
              <div>
                <span className="mx-auto grid size-12 place-items-center rounded-full bg-slate-100 text-slate-400"><TicketCheck size={20} /></span>
                <h2 className="mt-4 font-display text-lg font-bold text-slate-800">No matching tickets</h2>
                <p className="mt-1 text-sm text-slate-500">New requests will appear here automatically.</p>
              </div>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[800px] border-collapse text-left">
                <thead>
                  <tr className="bg-slate-50/80 text-[11px] font-bold uppercase tracking-[0.12em] text-slate-400">
                    <th className="px-5 py-3">Ticket</th>
                    <th className="px-5 py-3">Category</th>
                    <th className="px-5 py-3">Ticket status</th>
                    <th className="px-5 py-3">Agent status</th>
                    <th className="px-5 py-3">Created</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filtered.map((ticket) => (
                    <tr key={ticket.ticketId} className="group transition hover:bg-mint/25">
                      <td className="max-w-sm px-5 py-4">
                        <div className="flex items-start gap-3">
                          <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-lg bg-slate-100 text-slate-500 transition group-hover:bg-white group-hover:text-teal"><TicketCheck size={16} /></span>
                          <div className="min-w-0">
                            <p className="truncate text-sm font-bold text-slate-800">{ticket.subject}</p>
                            <p className="mt-1 font-mono text-[11px] font-semibold text-slate-400">#{shortId(ticket.ticketId)}</p>
                          </div>
                        </div>
                      </td>
                      <td className="px-5 py-4 text-sm font-semibold text-slate-600">{sentenceCase(ticket.category)}</td>
                      <td className="px-5 py-4"><StatusBadge status={ticket.status} /></td>
                      <td className="px-5 py-4">{ticket.jobStatus ? <StatusBadge status={ticket.jobStatus} /> : <span className="text-sm text-slate-400">Not started</span>}</td>
                      <td className="whitespace-nowrap px-5 py-4 text-sm text-slate-500">{formatDate(ticket.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="flex items-center justify-between border-t border-slate-100 px-5 py-3 text-xs font-semibold text-slate-400">
            <span>Showing {filtered.length} of {tickets.length}</span>
            <span className="flex items-center gap-1.5"><span className="size-1.5 rounded-full bg-teal" /> Auto-refreshes every 15 seconds</span>
          </div>
        </div>

        <aside className="space-y-6">
          <div className="surface-card p-5">
            <div className="flex items-center justify-between">
              <div>
                <p className="eyebrow">Request mix</p>
                <h2 className="mt-2 font-display text-lg font-bold text-navy">Top categories</h2>
              </div>
              <Sparkles className="text-teal" size={18} />
            </div>
            <div className="mt-6 space-y-4">
              {categoryCounts.length ? categoryCounts.map(([category, count]) => (
                <div key={category}>
                  <div className="mb-1.5 flex items-center justify-between text-xs font-bold">
                    <span className="text-slate-600">{sentenceCase(category)}</span>
                    <span className="text-slate-400">{count}</span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-slate-100">
                    <div className="h-full rounded-full bg-teal" style={{ width: metricPercent(count, tickets.length) }} />
                  </div>
                </div>
              )) : <p className="text-sm leading-6 text-slate-500">Category insights appear after tickets are submitted.</p>}
            </div>
          </div>

          <div className="rounded-2xl border border-navy/10 bg-navy p-5 text-white shadow-lg shadow-navy/10">
            <span className="grid size-9 place-items-center rounded-lg bg-white/10 text-teal-light"><ArrowUpRight size={17} /></span>
            <h2 className="mt-4 font-display text-lg font-bold">Operational note</h2>
            <p className="mt-2 text-sm leading-6 text-slate-300">Escalated and failed tickets should be reviewed by a human. Internal failure details remain in structured AWS logs.</p>
          </div>
        </aside>
      </div>
    </section>
  );
}

const metricTones = {
  navy: 'bg-navy text-white',
  sky: 'bg-sky-50 text-sky-700',
  teal: 'bg-mint text-teal-dark',
  orange: 'bg-orange-50 text-orange-700',
};

function MetricCard({
  icon: Icon,
  label,
  value,
  detail,
  tone,
}: {
  icon: typeof Inbox;
  label: string;
  value: string;
  detail: string;
  tone: keyof typeof metricTones;
}) {
  return (
    <div className="surface-card p-5">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.12em] text-slate-400">{label}</p>
          <p className="mt-3 font-display text-3xl font-bold tracking-tight text-navy">{value}</p>
          <p className="mt-1 text-xs font-medium text-slate-400">{detail}</p>
        </div>
        <span className={`grid size-10 place-items-center rounded-xl ${metricTones[tone]}`}><Icon size={18} /></span>
      </div>
    </div>
  );
}
