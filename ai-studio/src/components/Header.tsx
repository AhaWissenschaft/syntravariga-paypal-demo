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

  return (
    <header className="border-b border-slate-800 bg-slate-950/80 backdrop-blur sticky top-0 z-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          {/* Logo & Brand */}
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center text-indigo-400 font-mono font-bold">
              SV
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-semibold tracking-tight text-white text-base">
                  SyntraVariga
                </span>
                <span className="text-xs px-2 py-0.5 rounded bg-slate-800 text-slate-300 font-mono">
                  v1.3 Hackathon Demo
                </span>
              </div>
              <p className="text-xs text-slate-400">
                AhaWissenschaft · Invoice &amp; Payment Guard · Cryptographic Audit Kernel
              </p>
            </div>
          </div>

          {/* Focused Hackathon Navigation Tabs (Point 7: Invoice & Payment Guard, Audit Ledger, Documentation) */}
          <nav
            className="hidden md:flex items-center gap-1 bg-slate-900/90 p-1 rounded-lg border border-slate-800"
            aria-label="Main Navigation"
          >
            <button
              onClick={() => setActiveTab('invoice-guard')}
              className={`px-3.5 py-1.5 rounded-md text-xs font-medium transition-all flex items-center gap-1.5 ${
                activeTab === 'invoice-guard'
                  ? 'bg-indigo-600 text-white shadow-sm'
                  : 'text-slate-300 hover:text-white hover:bg-slate-800'
              }`}
            >
              <ShieldCheck className="w-3.5 h-3.5" />
              Invoice &amp; Payment Guard
            </button>

            <button
              onClick={() => setActiveTab('ledger')}
              className={`px-3.5 py-1.5 rounded-md text-xs font-medium transition-all flex items-center gap-1.5 ${
                activeTab === 'ledger'
                  ? 'bg-indigo-600 text-white shadow-sm'
                  : 'text-slate-300 hover:text-white hover:bg-slate-800'
              }`}
            >
              <Database className="w-3.5 h-3.5" />
              Audit Ledger ({eventCount})
            </button>

            <button
              onClick={() => setActiveTab('docs')}
              className={`px-3.5 py-1.5 rounded-md text-xs font-medium transition-all flex items-center gap-1.5 ${
                activeTab === 'docs'
                  ? 'bg-indigo-600 text-white shadow-sm'
                  : 'text-slate-300 hover:text-white hover:bg-slate-800'
              }`}
            >
              <BookOpen className="w-3.5 h-3.5" />
              Documentation &amp; Limits
            </button>
          </nav>

          {/* Ledger Cryptographic Status Badge */}
          <div className="flex items-center gap-2">
            <div
              className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-mono font-medium border ${
                isPass
                  ? 'bg-emerald-950/60 border-emerald-500/40 text-emerald-400'
                  : 'bg-rose-950/80 border-rose-500/50 text-rose-300 animate-pulse'
              }`}
              title={isPass ? 'All SHA-256 blocks valid' : ledgerReport.errors.join('; ')}
            >
              {isPass ? (
                <>
                  <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
                  <span>LEDGER: PASS</span>
                </>
              ) : (
                <>
                  <ShieldAlert className="w-3.5 h-3.5 text-rose-400" />
                  <span>LEDGER: TAMPERED</span>
                </>
              )}
            </div>
          </div>
        </div>

        {/* Mobile Navigation Strip */}
        <div
          className="flex md:hidden overflow-x-auto py-2 gap-1.5 border-t border-slate-900 scrollbar-none"
          aria-label="Mobile Navigation"
        >
          <button
            onClick={() => setActiveTab('invoice-guard')}
            className={`px-3 py-1 rounded-md text-[11px] font-medium whitespace-nowrap transition-all flex items-center gap-1 ${
              activeTab === 'invoice-guard'
                ? 'bg-indigo-600 text-white'
                : 'text-slate-300 bg-slate-900'
            }`}
          >
            <ShieldCheck className="w-3 h-3" />
            Invoice &amp; Payment Guard
          </button>
          <button
            onClick={() => setActiveTab('ledger')}
            className={`px-3 py-1 rounded-md text-[11px] font-medium whitespace-nowrap transition-all flex items-center gap-1 ${
              activeTab === 'ledger'
                ? 'bg-indigo-600 text-white'
                : 'text-slate-300 bg-slate-900'
            }`}
          >
            <Database className="w-3 h-3" />
            Audit Ledger ({eventCount})
          </button>
          <button
            onClick={() => setActiveTab('docs')}
            className={`px-3 py-1 rounded-md text-[11px] font-medium whitespace-nowrap transition-all flex items-center gap-1 ${
              activeTab === 'docs'
                ? 'bg-indigo-600 text-white'
                : 'text-slate-300 bg-slate-900'
            }`}
          >
            <BookOpen className="w-3 h-3" />
            Documentation
          </button>
        </div>
      </div>
    </header>
  );
};
