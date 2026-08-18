import { Headphones, LayoutDashboard, MessageSquareText, Sparkles } from 'lucide-react';
import type { PropsWithChildren } from 'react';
import { NavLink } from 'react-router-dom';

const navItems = [
  { to: '/', label: 'Customer support', icon: MessageSquareText },
  { to: '/admin', label: 'Admin overview', icon: LayoutDashboard },
];

export function AppShell({ children }: PropsWithChildren) {
  return (
    <div className="min-h-screen bg-canvas text-ink">
      <header className="sticky top-0 z-30 border-b border-slate-200/80 bg-white/90 backdrop-blur-xl">
        <div className="mx-auto flex h-18 max-w-7xl items-center justify-between px-5 lg:px-8">
          <NavLink to="/" className="group flex items-center gap-3" aria-label="Resolve home">
            <span className="grid size-10 place-items-center rounded-xl bg-navy text-white shadow-lg shadow-navy/15 transition-transform group-hover:-rotate-3">
              <Sparkles size={19} strokeWidth={2.3} />
            </span>
            <span>
              <span className="block font-display text-lg font-bold leading-none tracking-tight">Resolve</span>
              <span className="mt-1 block text-[10px] font-bold uppercase tracking-[0.2em] text-slate-400">
                Intelligent support
              </span>
            </span>
          </NavLink>

          <nav className="flex items-center gap-1 rounded-xl border border-slate-200 bg-slate-50 p-1" aria-label="Main navigation">
            {navItems.map(({ to, label, icon: Icon }) => (
              <NavLink
                key={to}
                to={to}
                end={to === '/'}
                className={({ isActive }) =>
                  `flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold transition-colors ${
                    isActive
                      ? 'bg-white text-navy shadow-sm ring-1 ring-slate-200/70'
                      : 'text-slate-500 hover:text-slate-900'
                  }`
                }
              >
                <Icon size={16} />
                <span className="hidden sm:inline">{label}</span>
              </NavLink>
            ))}
          </nav>
        </div>
      </header>

      <main>{children}</main>

      <footer className="border-t border-slate-200 bg-white">
        <div className="mx-auto flex max-w-7xl flex-col gap-3 px-5 py-6 text-sm text-slate-500 sm:flex-row sm:items-center sm:justify-between lg:px-8">
          <span className="flex items-center gap-2"><Headphones size={16} /> Support that keeps you in the loop.</span>
          <span>Responses may be assisted by AI and escalated when needed.</span>
        </div>
      </footer>
    </div>
  );
}
