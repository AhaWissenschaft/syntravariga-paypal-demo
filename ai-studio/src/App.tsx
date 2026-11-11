/**
 * @license
 * SyntraVariga / AhaWissenschaft Institutional Verification Framework
 * Version: 1.3.0
 */

import React, { useState, useMemo, useCallback, useEffect } from 'react';
import { Header, ActiveTab } from './components/Header';
import { InvoiceGuardView } from './components/InvoiceGuardView';
import { LedgerExplorerView } from './components/LedgerExplorerView';
import { DocumentationView } from './components/DocumentationView';
import {
  LedgerEvent,
  verifyLedgerEvents,
  appendEvent,
} from './kernel/ledger';
import { PersistentPaymentRecord } from './kernel/persistentStore';

function createInitialClientFallbackLedger(): LedgerEvent[] {
  const { updatedEvents } = appendEvent([], {
    eventType: 'genesis_kernel_anchor',
    timestamp: '2026-11-11T08:00:00.000Z',
    payload: {
      framework: 'SyntraVariga / AhaWissenschaft Kernel',
      version: '1.3.0',
      crypto_standard: 'NIST_FIPS_PUB_180_4_SHA256',
      status: 'INITIALIZED',
    },
  });
  return updatedEvents;
}

export interface EnvironmentCapabilities {
  gemini_api_configured: boolean;
  gemini_model_id?: string;
  paypal_live_sandbox_credentials_configured: boolean;
  paypal_sandbox_host: string;
}

export default function App() {
  const [activeTab, setActiveTab] = useState<ActiveTab>('invoice-guard');
  const [events, setEvents] = useState<LedgerEvent[]>(() => createInitialClientFallbackLedger());
  const [paymentRecords, setPaymentRecords] = useState<Record<string, PersistentPaymentRecord>>({});
  const [envCaps, setEnvCaps] = useState<EnvironmentCapabilities>({
    gemini_api_configured: false,
    gemini_model_id: 'gemini-3.8-flash',
    paypal_live_sandbox_credentials_configured: false,
    paypal_sandbox_host: 'https://api-m.sandbox.paypal.com',
  });

  const refreshServerState = useCallback(() => {
    fetch('/api/ledger')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data && Array.isArray(data.events)) {
          setEvents(data.events);
        }
        if (data && data.payment_records) {
          setPaymentRecords(data.payment_records);
        }
        if (data && data.environment_capabilities) {
          setEnvCaps(data.environment_capabilities);
        }
      })
      .catch(() => {
        // Offline / client-only fallback
      });
  }, []);

  useEffect(() => {
    refreshServerState();
  }, [refreshServerState]);

  const verificationReport = useMemo(() => {
    return verifyLedgerEvents(events);
  }, [events]);

  const handleReloadVerifiedLedger = useCallback(() => {
    refreshServerState();
  }, [refreshServerState]);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans selection:bg-indigo-500/30 selection:text-indigo-200">
      <Header
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        ledgerReport={verificationReport}
        eventCount={events.length}
      />

      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {activeTab === 'invoice-guard' && (
          <InvoiceGuardView
            events={events}
            onSyncEvents={setEvents}
            paymentRecords={paymentRecords}
            onSyncPaymentRecords={setPaymentRecords}
            envCaps={envCaps}
          />
        )}

        {activeTab === 'ledger' && (
          <LedgerExplorerView
            events={events}
            verificationReport={verificationReport}
            onSetEvents={setEvents}
            onResetOriginal={handleReloadVerifiedLedger}
          />
        )}

        {activeTab === 'docs' && <DocumentationView />}
      </main>

      <footer className="border-t border-slate-900 bg-slate-950 py-6 text-xs text-slate-500 font-mono">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex flex-col sm:flex-row items-center justify-between gap-3">
          <div>
            <span className="text-slate-400 font-semibold">SyntraVariga</span> · AhaWissenschaft
            Invoice &amp; Payment Guard · Demo &amp; PayPal Sandbox Only (Fictitious Data)
          </div>
          <div className="flex items-center gap-4 text-[11px]">
            <span>FIPS 180-4 SHA-256</span>
            <span>•</span>
            <span>RFC 8785 Canonical JSON</span>
            <span>•</span>
            <span className="text-amber-400">
              No Guarantee of Invoice Authenticity, Fraud Absence, or Zero Double-Payment
            </span>
          </div>
        </div>
      </footer>
    </div>
  );
}
