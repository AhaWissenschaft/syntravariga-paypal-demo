import React, { useState } from 'react';
import { BookOpen, FileText, CheckCircle2 } from 'lucide-react';

const DOCS_LIST = [
  {
    id: 'status',
    title: 'Prototype status',
    subtitle: 'SQLite ACID Co-Storage, Single-Instance Lock, Origin Validation & Honest Verification',
    content: `
# PROJECT STATUS: SYNTRAVARIGA INVOICE & PAYMENT GUARD
**Version:** 1.4.0 | **Date:** 2026-11-12
**Reference Code:** Included in \`reference_python/\` (earlier snapshot; newer Python CLI demo sits at repo root)

## 1. Hardened Architecture & Security Controls (v1.4)
1. **Transactional SQLite Co-Storage (\`node:sqlite\` in \`persistentStore.ts\`)**:
   - Both the cryptographic audit ledger (\`ledger_events\`) and payment lifecycle state (\`payment_records\`) are stored together in a single SQLite database using \`PRAGMA journal_mode = WAL\`, \`PRAGMA synchronous = FULL\`, and \`BEGIN IMMEDIATE\` transactions.
   - Server-side ledger integrity verification uses native \`node:crypto\` SHA-256 while preserving identical canonical JSON (RFC 8785) digests.
   - Eliminates stale filesystem \`.lock\` files on process crash: OS-level SQLite locks are automatically released if a process terminates unexpectedly (\`SIGKILL\` / \`exit(1)\`), and uncommitted writes roll back cleanly.
   - Single-instance server ownership is enforced via \`<sqliteDbPath>.server.pid\` in \`startServer()\`: only one active Express server instance may run against a database at a time so crash recovery never flags an active sibling server's in-flight payments.
2. **Startup In-Flight Crash Recovery (\`recoverInFlightRecordsOnStartup\`)**:
   - On server startup, any payment record left in a transient state (\`RESERVED_ORDER\` or \`CAPTURE_PENDING\`) by an interrupted process is atomically transitioned to \`UNKNOWN_RECONCILIATION_REQUIRED\` along with a \`paypal_crash_recovery_lock\` ledger event, preventing automatic duplicate order/capture retries until manual reconciliation.
3. **Strict PayPal Response Validation (\`paypalSandbox.ts\`)**:
   - \`verifyStrictPayPalOrderPayload\` and \`verifyStrictPayPalCapturePayload\` verify exact Order ID, expected status (\`CREATED\`, \`APPROVED\`, \`COMPLETED\`), **exactly 1** \`purchase_unit\`, matching \`custom_id === receipt_hash\`, \`currency_code === 'EUR'\`, \`value === verified_amount_eur\`, and **exactly 1** \`COMPLETED\` capture record.
   - Missing or unexpected fields cause immediate failure; expected values are never substituted for missing PayPal fields.
4. **Exact Scheme + Host + Port Validation (\`verifyExactHostAndOrigin\` in \`server.ts\`)**:
   - Binds to \`127.0.0.1\` by default and validates \`Host\` and \`Origin\` headers including exact scheme (\`http:\` vs \`https:\`), hostname, and port (\`:3000\`).
   - Wildcard \`*.run.app\` domains are **never** accepted; a preview origin is permitted only if its exact \`protocol://host[:port]\` is explicitly configured via \`APP_URL\` or \`TRUSTED_PREVIEW_ORIGIN\`.
5. **Verified Gemini Model Name & Explicit Opt-In (\`gemini-3.8-flash\`)**:
   - Targets \`gemini-3.8-flash\` with a 15-second HTTP request timeout so slow or unavailable upstream responses fall back cleanly.
   - External AI calls require explicit user opt-in (\`allow_external_ai: true\`). Without opt-in or without a configured \`GEMINI_API_KEY\`, local deterministic non-AI fallbacks execute transparently.
6. **Isolated Negative Self-Test Suite (\`POST /api/redteam/isolated\`)**:
   - Executes 4 internal function and temporary SQLite negative checks mapped to HTTP 403/400/409 equivalents without live network traffic or main-ledger mutation.
`,
  },
  {
    id: 'limits',
    title: 'LIMITATIONS_AND_SCOPE.md',
    subtitle: 'Explicit Technical Boundaries & What This Prototype Does Not Prove',
    content: `
# EXPLICIT TECHNICAL BOUNDARIES & LIMITATIONS

## 1. No Proof of Invoice Authenticity or Absence of Fraud
- \`FIELDS_CONSISTENT\` only confirms that the human-confirmed fields satisfy the mathematical integer-cent rules (\`Net + Tax == Gross == Amount\`), Unicode NFKC supplier matching, and duplicate-hash checks.
- It does **not** prove that an invoice is genuine, legally valid, or free of fraud.

## 2. Single-Instance Runtime & Double-Payment Scope
- \`PersistentPaymentStore\` (SQLite \`BEGIN IMMEDIATE\`) and \`PayPal-Request-Id\` headers mitigate concurrent double-order and double-capture race conditions within one server process and lock timeouts/crashes in \`UNKNOWN_RECONCILIATION_REQUIRED\`.
- Supported deployment is **one Express server process per SQLite database** (enforced by \`acquireSingleInstanceServerLock\`).
- No single application can guarantee absolute protection against double payments initiated outside this system or under altered invoice metadata.

## 3. Tamper-Evident Hash Chain Scope
- The SHA-256 hash chain makes post-hoc modification of individual entries detectable (\`payload_sha256\`, \`previous_hash\`, \`index\`).
- However, an attacker with full write access to the local SQLite database file could recompute the entire chain from Genesis unless the latest \`head_hash\` is anchored externally.

## 4. External AI & Live Sandbox Credentials
- In environments without live \`GEMINI_API_KEY\` or \`PAYPAL_CLIENT_ID\` / \`PAYPAL_CLIENT_SECRET\`, the application transparently runs deterministic local fallbacks (not AI) and local PayPal Sandbox protocol simulation.
- Even when a Google AI Studio key is configured, API calls are subject to quota and billing terms of the account holder (not guaranteed free of charge) and are never triggered without explicit opt-in.
`,
  },
  {
    id: 'testing_audit',
    title: 'Automated tests',
    subtitle: 'Automated TypeScript & Python Reference Verification Suites',
    content: `
# AUTOMATED VERIFICATION & TEST MATRIX

## 1. Automated Test Suites
- \`src/kernel/crypto.test.ts\`: FIPS 180-4 SHA-256 & RFC 8785 canonical JSON with Unicode codepoint sorting.
- \`src/kernel/contracts.test.ts\`: Schema validation & fail-closed contract checks.
- \`src/kernel/invoiceGuard.test.ts\`: Integer-cent arithmetic, NFKC vendor normalization, duplicate detection, and batch analysis.
- \`src/kernel/ledger.test.ts\`: Hash-chain verification, recursive PII key blocker, receipt verification, and client event-type restrictions.
- \`src/kernel/aiExplainerContract.test.ts\`: Zero-PII request validation & server-enforced disclaimers.
- \`src/kernel/aiInvoiceExtractor.test.ts\`: English & German structured field extraction, ambiguity warnings, and missing-field alerts.
- \`src/kernel/paypalSandbox.test.ts\`: Sandbox URL validation, HATEOAS link extraction, and order->approval->capture state machine.
- \`src/kernel/hardening.test.ts\`:
  1. SQLite transactional persistence across restarts & fail-closed corruption detection without overwrite.
  2. Real child-process crash mid-transaction (\`process.exit(1)\` before \`COMMIT\`) rolling back cleanly + startup \`recoverInFlightRecordsOnStartup()\`.
  3. Real multi-process contention (\`child_process.spawn\`) with two parallel processes racing on the same receipt.
  4. Unknown PayPal state (\`UNKNOWN_RECONCILIATION_REQUIRED\`) co-committed with ledger event + manual operator reconciliation.
  5. Strict PayPal Order & Capture payload validation (wrong currency, wrong order ID, extra units/captures, missing \`custom_id\`).
  6. Exact \`Host\` & \`Origin\` unit verification & single-instance server DB lock verification.
  7. End-to-End HTTP integration test covering scheme/port/\`*.run.app\` rejection, order/approve/timeout-502/reconcile/capture lifecycle, and isolated Red-Team checks.
- \`reference_python/test_*.py\`: Python reference test suite.
`,
  },
];

export const DocumentationView: React.FC = () => {
  const [activeDocId, setActiveDocId] = useState<string>('status');

  const activeDoc = DOCS_LIST.find((d) => d.id === activeDocId) || DOCS_LIST[0];

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
      {/* Sidebar List (4 cols) */}
      <div className="lg:col-span-4 space-y-2">
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 mb-3">
          <h3 className="text-xs font-semibold uppercase tracking-wider font-mono text-slate-300 flex items-center gap-2">
            <BookOpen className="w-4 h-4 text-indigo-400" />
            Technical Documentation
          </h3>
          <p className="text-[11px] text-slate-400 mt-1">
            Architecture, Boundaries &amp; Verification Suites
          </p>
        </div>

        {DOCS_LIST.map((doc) => (
          <button
            key={doc.id}
            type="button"
            onClick={() => setActiveDocId(doc.id)}
            className={`w-full text-left p-3.5 rounded-xl border transition flex items-start justify-between focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 ${
              activeDocId === doc.id
                ? 'bg-indigo-950/40 border-indigo-500 shadow-sm'
                : 'bg-slate-900 border-slate-800 hover:border-slate-700'
            }`}
          >
            <div>
              <div
                className={`text-xs font-mono font-semibold ${
                  activeDocId === doc.id ? 'text-indigo-300' : 'text-slate-200'
                }`}
              >
                {doc.title}
              </div>
              <div className="text-[11px] text-slate-400 mt-0.5">
                {doc.subtitle}
              </div>
            </div>
            {activeDocId === doc.id && (
              <CheckCircle2 className="w-4 h-4 text-indigo-400 shrink-0 mt-0.5" />
            )}
          </button>
        ))}
      </div>

      {/* Main Document Content (8 cols) */}
      <div className="lg:col-span-8 bg-slate-900 border border-slate-800 rounded-xl p-6 font-mono text-xs">
        <div className="border-b border-slate-800 pb-3 mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <FileText className="w-4 h-4 text-indigo-400" />
            <span className="font-bold text-white text-sm">{activeDoc.title}</span>
          </div>
          <span className="text-[10px] bg-slate-800 px-2 py-0.5 rounded text-slate-300">
            Technical Specification
          </span>
        </div>

        <div className="prose prose-invert max-w-none text-slate-300 whitespace-pre-wrap leading-relaxed">
          {activeDoc.content.trim()}
        </div>
      </div>
    </div>
  );
};
