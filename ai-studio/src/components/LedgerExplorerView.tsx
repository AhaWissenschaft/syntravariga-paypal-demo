import React, { useState } from 'react';
import {
  ShieldCheck,
  ShieldAlert,
  Download,
  Flame,
  RotateCcw,
  Copy,
  Check,
  ChevronRight,
  Clock,
} from 'lucide-react';
import {
  LedgerEvent,
  LedgerVerificationReport,
  GENESIS_HASH,
} from '../kernel/ledger';

interface LedgerExplorerViewProps {
  events: LedgerEvent[];
  verificationReport: LedgerVerificationReport;
  onSetEvents: (events: LedgerEvent[]) => void;
  onResetOriginal: () => void;
}

export const LedgerExplorerView: React.FC<LedgerExplorerViewProps> = ({
  events,
  verificationReport,
  onSetEvents,
  onResetOriginal,
}) => {
  const [copiedHash, setCopiedHash] = useState<string | null>(null);
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);

  const isPass = verificationReport.status === 'PASS';

  const handleCopy = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedHash(text);
    setTimeout(() => setCopiedHash(null), 2000);
  };

  const handleExportJsonl = () => {
    const lines = events.map((e) => JSON.stringify(e)).join('\n');
    const blob = new Blob([lines], { type: 'application/x-jsonlines' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `syntravariga_ledger_${Date.now()}.jsonl`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Client-side UI tamper simulation 1: Mutate payload in browser memory to demonstrate hash verification failure
  const handleTamperPayload = (indexToTamper: number) => {
    if (events.length === 0) return;
    const cloned = JSON.parse(JSON.stringify(events)) as LedgerEvent[];
    if (cloned[indexToTamper]) {
      cloned[indexToTamper].payload = {
        ...(cloned[indexToTamper].payload as Record<string, unknown>),
        _tampered_flag: 'CLIENT_MEMORY_MUTATION_DEMO',
        amount_cents: 99999999,
      };
      onSetEvents(cloned);
    }
  };

  // Client-side UI tamper simulation 2: Break hash chain in browser memory
  const handleTamperHashChain = (indexToTamper: number) => {
    if (events.length <= 1) return;
    const cloned = JSON.parse(JSON.stringify(events)) as LedgerEvent[];
    if (cloned[indexToTamper]) {
      cloned[indexToTamper].previous_hash = 'deadbeef'.repeat(8);
      onSetEvents(cloned);
    }
  };

  return (
    <div className="space-y-6">
      {/* Top Ledger Integrity Bar */}
      <div
        className={`rounded-xl border p-5 transition-all ${
          isPass
            ? 'bg-slate-900 border-slate-800'
            : 'bg-rose-950/60 border-rose-600/70 shadow-lg shadow-rose-950/50'
        }`}
      >
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div
              className={`p-2.5 rounded-lg border ${
                isPass
                  ? 'bg-emerald-950/60 border-emerald-500/30 text-emerald-400'
                  : 'bg-rose-900/80 border-rose-500 text-rose-200 animate-bounce'
              }`}
            >
              {isPass ? (
                <ShieldCheck className="w-6 h-6" />
              ) : (
                <ShieldAlert className="w-6 h-6" />
              )}
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-base font-semibold text-white">
                  Persistent Audit Ledger Status:
                </h3>
                <span
                  className={`text-xs font-mono font-bold px-2.5 py-0.5 rounded ${
                    isPass
                      ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                      : 'bg-rose-500/30 text-rose-200 border border-rose-400'
                  }`}
                >
                  {verificationReport.status}
                </span>
                <span className="text-xs text-slate-400 font-mono">
                  ({verificationReport.event_count} Entries)
                </span>
              </div>
              <p className="text-xs text-slate-400 mt-0.5">
                {isPass
                  ? 'All SHA-256 payload digests and previous_hash links pass FIPS 180-4 verification.'
                  : `Integrity violation detected in view! ${verificationReport.errors.length} error(s).`}
              </p>
            </div>
          </div>

          {/* Action Tools */}
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handleExportJsonl}
              className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-xs font-mono flex items-center gap-1.5 transition"
            >
              <Download className="w-3.5 h-3.5" />
              Export JSONL
            </button>
            <button
              type="button"
              onClick={onResetOriginal}
              className="px-3 py-1.5 rounded-lg bg-indigo-600/80 hover:bg-indigo-600 text-white text-xs font-mono flex items-center gap-1.5 transition"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              Reload Verified Server Ledger
            </button>
          </div>
        </div>

        {/* Errors list if tampered */}
        {!isPass && (
          <div className="mt-4 pt-4 border-t border-rose-800/60 space-y-1.5">
            <div className="text-xs font-bold font-mono text-rose-300 flex items-center gap-1.5">
              <Flame className="w-4 h-4 text-rose-400" />
              Detected Integrity Breaks (Fail-Closed Verification):
            </div>
            {verificationReport.errors.map((err, i) => (
              <div
                key={i}
                className="text-xs font-mono bg-rose-900/40 text-rose-200 px-2.5 py-1 rounded border border-rose-700/60"
              >
                {err}
              </div>
            ))}
          </div>
        )}

        {/* Head Hash & Genesis Info */}
        <div className="mt-4 pt-3 border-t border-slate-800/80 grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11px] font-mono text-slate-400">
          <div>
            <span className="text-slate-400">HEAD HASH: </span>
            <span className="text-indigo-400 select-all">
              {verificationReport.head_hash.substring(0, 32)}...
            </span>
          </div>
          <div className="sm:text-right">
            <span className="text-slate-400">GENESIS: </span>
            <span className="text-slate-400">64x 0x00</span>
          </div>
        </div>
      </div>

      {/* Interactive Tamper Simulation Box */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-3">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Flame className="w-4 h-4 text-amber-400" aria-hidden="true" />
            <h4 className="text-xs font-semibold uppercase tracking-wider font-mono text-slate-200">
              In-Browser Hash-Chain Tamper Simulation (UI Verification Demo)
            </h4>
          </div>
          <span className="text-xs font-mono text-slate-400">
            Client-Memory Simulation Only (Does Not Modify Disk Ledger)
          </span>
        </div>
        <p className="text-xs text-slate-400">
          Test how the verifier detects single-field mutations or broken hash links in browser memory.
          Note: The hash chain detects post-hoc edits to individual entries, but someone with full write access to the disk file could recompute the chain unless the head hash is anchored externally.
        </p>

        <div className="flex flex-wrap items-center gap-2 pt-1">
          <button
            type="button"
            onClick={() => handleTamperPayload(0)}
            disabled={events.length === 0}
            className="px-3 py-1.5 rounded bg-rose-950/80 hover:bg-rose-900 text-rose-300 border border-rose-800 text-xs font-mono transition disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400"
          >
            Simulate Payload Mutation in Block #1
          </button>
          <button
            type="button"
            onClick={() => handleTamperHashChain(events.length - 1)}
            disabled={events.length <= 1}
            className="px-3 py-1.5 rounded bg-amber-950/80 hover:bg-amber-900 text-amber-300 border border-amber-800 text-xs font-mono transition disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400"
          >
            Simulate Broken Previous-Hash Link
          </button>
        </div>
      </div>

      {/* Events Timeline / Cards */}
      <div className="space-y-3">
        <h4 className="text-xs font-semibold uppercase tracking-wider font-mono text-slate-400">
          Persistent Chained Event Log ({events.length} Entries)
        </h4>

        {events.length === 0 ? (
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-8 text-center text-slate-400 font-mono text-xs">
            The ledger is empty. Run an invoice verification to create sealed audit entries.
          </div>
        ) : (
          events.map((event, index) => {
            const isExpanded = expandedIndex === index;

            return (
              <div
                key={event.event_id + index}
                className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden transition"
              >
                {/* Keyboard-Accessible Event Summary Row */}
                <button
                  type="button"
                  aria-expanded={isExpanded}
                  onClick={() => setExpandedIndex(isExpanded ? null : index)}
                  className="w-full text-left p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 cursor-pointer hover:bg-slate-800/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-400"
                >
                  <div className="flex items-center gap-3">
                    <span className="w-8 h-8 rounded-lg bg-indigo-950 border border-indigo-500/30 text-indigo-400 font-mono font-bold text-xs flex items-center justify-center shrink-0">
                      #{event.index}
                    </span>
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono font-semibold text-white text-xs">
                          {event.event_id}
                        </span>
                        <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-slate-800 text-slate-300 border border-slate-700">
                          {event.event_type}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 text-[11px] font-mono text-slate-400 mt-0.5">
                        <Clock className="w-3 h-3 text-slate-400" aria-hidden="true" />
                        <span>{event.timestamp}</span>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 sm:text-right">
                    <div className="text-[11px] font-mono text-slate-400 hidden md:block">
                      <span className="text-slate-400">Hash: </span>
                      <span className="text-slate-300">{event.event_hash.substring(0, 16)}...</span>
                    </div>
                    <ChevronRight
                      aria-hidden="true"
                      className={`w-4 h-4 text-slate-400 transition-transform ${
                        isExpanded ? 'rotate-90' : ''
                      }`}
                    />
                  </div>
                </button>

                {/* Expanded Details */}
                {isExpanded && (
                  <div className="p-4 border-t border-slate-800 bg-slate-950/70 space-y-3 font-mono text-xs">
                    <div className="space-y-1">
                      <div className="flex items-center justify-between">
                        <span className="text-slate-400 text-[11px]">EVENT SHA-256 HASH:</span>
                        <button
                          type="button"
                          onClick={() => handleCopy(event.event_hash)}
                          className="text-[11px] text-indigo-400 hover:text-indigo-300 flex items-center gap-1"
                        >
                          {copiedHash === event.event_hash ? (
                            <Check className="w-3 h-3 text-emerald-400" />
                          ) : (
                            <Copy className="w-3 h-3" />
                          )}
                          Copy
                        </button>
                      </div>
                      <div className="bg-slate-900 px-3 py-1.5 rounded border border-slate-800 text-emerald-400 break-all select-all">
                        {event.event_hash}
                      </div>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      <div>
                        <span className="text-slate-400 text-[11px]">PREVIOUS HASH:</span>
                        <div className="bg-slate-900 px-3 py-1.5 rounded border border-slate-800 text-slate-300 break-all select-all text-[11px]">
                          {event.previous_hash === GENESIS_HASH ? (
                            <span className="text-slate-400">GENESIS (64x 0x00)</span>
                          ) : (
                            event.previous_hash
                          )}
                        </div>
                      </div>

                      <div>
                        <span className="text-slate-400 text-[11px]">PAYLOAD SHA-256:</span>
                        <div className="bg-slate-900 px-3 py-1.5 rounded border border-slate-800 text-slate-300 break-all select-all text-[11px]">
                          {event.payload_sha256}
                        </div>
                      </div>
                    </div>

                    <div>
                      <span className="text-slate-400 text-[11px]">PAYLOAD OBJECT:</span>
                      <pre className="bg-slate-900 p-3 rounded border border-slate-800 text-slate-200 text-[11px] overflow-x-auto">
                        {JSON.stringify(event.payload, null, 2)}
                      </pre>
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};
