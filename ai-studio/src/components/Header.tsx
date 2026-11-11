import React from 'react';
import { ShieldCheck, ShieldAlert, Database, BookOpen } from 'lucide-react';
import { LedgerVerificationReport } from '../kernel/ledger';

export type ActiveTab = 'invoice-guard' | 'ledger' | 'docs';

interface HeaderProps {
  activeTab: ActiveTab;
  setActiveTab: (tab: ActiveTab) => void;
  ledgerReport: LedgerVerificationReport;
  eventCount: number;
}

export const Header: React.FC<HeaderProps> = ({
  activeTab,
  setActiveTab,
  ledgerReport,
  eventCount,
}) => {
  const isPass = ledgerReport.status === 'PASS';

  const navItems = [
    {
      id: 'invoice-guard',
      label: 'Invoice & Payment Guard',
      mobileLabel: 'Invoice & Payment Guard',
      icon: ShieldCheck,
    },
    {
      id: 'ledger',
      label: `Audit Ledger (${eventCount})`,
      mobileLabel: `Audit Ledger (${eventCount})`,
      icon: Database,
    },
    {
      id: 'docs',
      label: 'Documentation & Limits',
      mobileLabel: 'Documentation',
      icon: BookOpen,
    },
  ] as const;

  return (
    <header className="border-b border-slate-800 bg-slate-950/90 backdrop-blur sticky top-0 z-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between min-h-16 py-2.5 gap-3">
          {/* Logo & Brand */}
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 shrink-0 rounded-lg bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center text-indigo-400 font-mono font-bold">
              SV
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="font-semibold tracking-tight text-white text-sm sm:text-base leading-tight">
                  SyntraVariga Invoice &amp; Payment Guard
                </span>
                <span className="text-[11px] px-2 py-0.5 rounded bg-slate-800 text-slate-300 font-mono whitespace-nowrap shrink-0">
                  v1.4 Sandbox Demo
                </span>
              </div>
              <p className="text-xs text-slate-400 truncate">
                AhaWissenschaft · Cryptographic Invoice Audit &amp; PayPal Sandbox Guard
              </p>
            </div>
          </div>

          {/* Focused Hackathon Navigation Tabs */}
          <nav
            className="hidden lg:flex items-center gap-1 bg-slate-900/90 p-1 rounded-lg border border-slate-800 shrink-0"
            aria-label="Main Navigation"
          >
            {navItems.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                type="button"
                aria-current={activeTab === id ? 'page' : undefined}
                onClick={() => setActiveTab(id)}
                className={`px-3 py-1.5 rounded-md text-xs font-medium whitespace-nowrap transition-all flex items-center gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 ${
                  activeTab === id
                    ? 'bg-indigo-600 text-white shadow-sm'
                    : 'text-slate-300 hover:text-white hover:bg-slate-800'
                }`}
              >
                <Icon className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                {label}
              </button>
            ))}
          </nav>

          {/* Ledger Cryptographic Status Badge */}
          <div className="flex items-center gap-2 shrink-0">
            <div
              className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-mono font-medium border whitespace-nowrap ${
                isPass
                  ? 'bg-emerald-950/60 border-emerald-500/40 text-emerald-400'
                  : 'bg-rose-950/80 border-rose-500/50 text-rose-300 animate-pulse'
              }`}
              title={isPass ? 'All SHA-256 blocks valid' : ledgerReport.errors.join('; ')}
            >
              {isPass ? (
                <>
                  <ShieldCheck className="w-3.5 h-3.5 text-emerald-400 shrink-0" aria-hidden="true" />
                  <span>LEDGER: PASS</span>
                </>
              ) : (
                <>
                  <ShieldAlert className="w-3.5 h-3.5 text-rose-400 shrink-0" aria-hidden="true" />
                  <span>LEDGER: TAMPERED</span>
                </>
              )}
            </div>
          </div>
        </div>

        {/* Mobile / Tablet Navigation Strip */}
        <nav
          className="flex lg:hidden overflow-x-auto py-2 gap-1.5 border-t border-slate-900 scrollbar-none"
          aria-label="Mobile Navigation"
        >
          {navItems.map(({ id, mobileLabel, icon: Icon }) => (
            <button
              key={id}
              type="button"
              aria-current={activeTab === id ? 'page' : undefined}
              onClick={() => setActiveTab(id)}
              className={`px-3 py-1 rounded-md text-[11px] font-medium whitespace-nowrap transition-all flex items-center gap-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 ${
                activeTab === id
                  ? 'bg-indigo-600 text-white'
                  : 'text-slate-300 bg-slate-900'
              }`}
            >
              <Icon className="w-3 h-3 shrink-0" aria-hidden="true" />
              {mobileLabel}
            </button>
          ))}
        </nav>
      </div>
    </header>
  );
};
