# SyntraVariga Invoice & Payment Guard (AhaWissenschaft)

> **SyntraVariga helps small businesses review supplier invoices before paying.**  
> AI proposes invoice fields, a person confirms them, and deterministic checks keep PayPal Sandbox checkout locked when the confirmed data fails the configured checks. Each review and payment step is recorded in an auditable ledger.

**PayPal AI Hackathon Candidate (`ai-studio/`) — Branch [`feature/invoice-guard-public`](https://github.com/AhaWissenschaft/syntravariga-paypal-demo/tree/feature/invoice-guard-public)**  
**License:** MIT (see [`LICENSE`](../LICENSE) and [`ai-studio/LICENSE`](LICENSE))  
**Scope:** PayPal Sandbox & Demo Only · Fictitious Invoice Data · Human-in-the-Loop Verification

> **For Hackathon Judges:**  
> The React + TypeScript + Express + SQLite application lives in [`ai-studio/`](https://github.com/AhaWissenschaft/syntravariga-paypal-demo/tree/feature/invoice-guard-public/ai-studio) on branch **`feature/invoice-guard-public`**. The earlier standalone Python demo remains preserved at the repository root, while [`reference_python/`](reference_python/) inside `ai-studio/` is an older reference snapshot preserved for regression comparison.

---

## 1. Overview & Judge Guide (English)

### Target Audience & Problem Statement
Small businesses and freelancers often inspect incoming supplier invoices manually before triggering a payout:
1. Does the supplier name on the invoice match the purchase order?
2. Does the billed total match the expected purchase order amount?
3. Does exact integer-cent math hold (`Net + Tax === Gross === Payable Amount`)?
4. Has the same supplier and invoice number already been verified in the audit log (`DUPLICATE_INVOICE`)?

### End-to-End Guarded Pipeline
1. **Field Proposal (`POST /api/ai/extract`):** Extracts structured fields from English or German invoice text (`vendor`, `invoice_number`, `net_amount`, `tax_amount`, `gross_amount`, `amount`) and flags missing placeholders or conflicting totals.
2. **Human Inspection & Confirmation:** A human reviewer edits/confirms fields. Any edit invalidates any prior verification receipt.
3. **Deterministic Integer-Cent Rules (`invoiceGuard.ts`):** Solely decides `FIELDS_CONSISTENT` vs. `REVIEW_REQUIRED` (`VENDOR_MISMATCH`, `EXPECTED_AMOUNT_MISMATCH`, `TAX_MISMATCH` / `TOTAL_MISMATCH`, `DUPLICATE_INVOICE`).
4. **Tamper-Evident Audit Ledger & Zero-PII Explainer (`POST /api/ai/explain`):** Seals the decision in an append-only SHA-256 chain. When explaining findings, only `{ status, finding_codes }` (zero raw invoice fields) leave the server if external AI opt-in is enabled.
5. **Atomic Payment Reservation & Server-Bound PayPal Sandbox Checkout:** Binds one-time receipt -> `verified_amount_eur` -> `EUR` -> `PayPal-Request-Id` idempotency keys in SQLite (`BEGIN IMMEDIATE`) before any PayPal API request, then requires explicit buyer approval before capture.
6. **Live Sandbox Status & Timeout Reconciliation:** Surfaces actual `order_id`, `capture_id`, `EUR` amount, and `COMPLETED` status; timeouts move strictly into `UNKNOWN_RECONCILIATION_REQUIRED` to block blind retries.

### Architecture & Security Boundaries (v1.4)

| Component | Responsibility & Strict Boundary |
|---|---|
| **1. Invoice Field Proposal (`POST /api/ai/extract`)** | Proposes structured fields from free-form fictitious invoice text and flags missing/ambiguous totals. **Privacy Default:** Runs **100% locally via a deterministic regex parser (not AI)** unless the user explicitly checks the consent box to transmit the fictitious demo text to Google Gemini (configured `gemini-3.8-flash` primary with automatic Flash failover—verified live on `gemini-3.5-flash-lite`). Any model error or timeout falls back cleanly and surfaces in `external_ai_error`. |
| **2. Human Inspection & Confirmation** | A human reviewer inspects, edits, and confirms the proposed fields. Any subsequent edit immediately invalidates the active verification receipt. |
| **3. Deterministic Verification Rules (`invoiceGuard.ts`)** | Evaluates confirmed fields using integer-cent arithmetic (`Net + Tax === Gross === Amount`), Unicode `NFKC` normalization, and optional SHA-256 duplicate-invoice detection (`DUPLICATE_INVOICE`). Solely decides `FIELDS_CONSISTENT` vs. `REVIEW_REQUIRED`. |
| **4. Zero-PII Finding Code Explainer (`POST /api/ai/explain`)** | Runs a deterministic local rule dictionary (not AI) by default. Only when the user explicitly opts in (`allow_external_ai: true`) does it transmit `{ status, finding_codes }` (never raw invoice fields) to Google Gemini (`gemini-3.8-flash` primary / Flash failover). Server-enforced contract locks `finding_codes` and appends `boundary_disclaimer`. |
| **5. Transactional SQLite Ledger & Payment Co-Storage (`persistentStore.ts`)** | Stores `ledger_events` and `payment_records` together in SQLite (`node:sqlite`, `WAL`, `synchronous=FULL`, `BEGIN IMMEDIATE`). Server-side integrity checks verify every entry using native `node:crypto` SHA-256 (matching RFC 8785 canonical JSON). Supports **Resume / Inspect** of persisted records across reloads and restarts. On startup, `recoverInFlightRecordsOnStartup()` transitions interrupted `RESERVED_ORDER` or `CAPTURE_PENDING` records to `UNKNOWN_RECONCILIATION_REQUIRED`. |
| **6. Single-Instance Process Ownership Lock (`startServer`)** | Acquires `<sqliteDbPath>.server.pid` (`acquireSingleInstanceServerLock`) at startup so only **one Express process** runs per SQLite database file, preventing crash recovery from falsely flagging another active process's in-flight payments. |
| **7. Strict PayPal Response Validation (`paypalSandbox.ts`)** | Enforces `https://api-m.sandbox.paypal.com`, exact Order ID, expected status (`CREATED`, `APPROVED`, `COMPLETED`), **exactly one** `purchase_unit`, matching `custom_id === receipt_hash` (on `purchase_units[0]` or `payments.captures[0]`, rejecting mismatches), `currency_code === 'EUR'`, `value === verified_amount_eur` (on both unit amount when present and capture amount), and **exactly one** `COMPLETED` capture record. Raw `POST /capture` is strictly validated **before** querying `GET /v2/checkout/orders/{id}` when `custom_id` is omitted, and any capture ID mismatch or lookup failure locks fail-closed (`isAmbiguousNetworkState = true`). |
| **8. Exact Host & Origin Validation (`verifyExactHostAndOrigin`)** | Validates `Host` and `Origin` headers including scheme (`http:` / `https:`), hostname, and port (`:3000`). Wildcard `*.run.app` domains are rejected unless explicitly matching `APP_URL` or `TRUSTED_PREVIEW_ORIGIN`. |
| **9. Isolated Negative Self-Test (`POST /api/redteam/isolated`)** | Executes 4 isolated negative checks in a temporary SQLite directory mapped to HTTP 403/400/409 equivalents—zero external network calls and zero main-ledger mutations. |

### Pre-Existing vs. Hackathon Work Attribution
- **Pre-existing SyntraVariga components (prior to hackathon submission period):** Core cryptographic hash-chain and contract primitives (`aha_lab/ledger.py`, `aha_lab/contracts.py`), canonical JSON test vectors, and the older Python snapshot in `reference_python/`.
- **Hackathon-period development & hardening (`ai-studio/`):** React + TypeScript Jury UI (`src/App.tsx`, `src/components/`), invoice extraction/guard contracts & batch sample demo, Zero-PII Gemini explainer contract & automatic Flash fallback resilience (`AQ.*` & `AIza*` keys), SQLite ACID payment co-storage & single-instance PID lock, strict single-unit PayPal Sandbox REST/protocol state machine, Express security server (`server.ts`), and the 51-test TypeScript hardening & multi-process test suite.

### Explicit Limitations: What This Prototype Does NOT Claim
- **No Proof of Invoice Authenticity or Fraud Absence:** `FIELDS_CONSISTENT` only means entered values satisfy the formal arithmetic, supplier comparison, and duplicate rules. Discrepancy sample amounts are not proven financial savings or detected fraud.
- **Single-Instance Supported Deployment:** Supported operation is strictly **one Express server process per SQLite database** (enforced by `acquireSingleInstanceServerLock`).
- **No Absolute Guarantee Against Double Payments:** SQLite `BEGIN IMMEDIATE` reservations and `PayPal-Request-Id` headers mitigate concurrent race conditions on one receipt, and `UNKNOWN_RECONCILIATION_REQUIRED` blocks blind retries, but a newly sealed review receipt or external payout outside this app can still initiate a separate payment.
- **Hash Chain Scope:** The SHA-256 chain makes post-hoc edits to individual rows detectable, but anyone with direct write access to the SQLite file could recompute the entire chain from Genesis unless `head_hash` is anchored externally.
- **API Keys & Billing:** A Google AI Studio API key is not guaranteed free of charge; external Gemini calls never occur without explicit opt-in.

---

## 2. Quick Start for Judges

### Current Verification Status
- **Automated Offline Verification (Node `v24.18.0` & Python `3.14`):**
  - `npm test`: **51 TypeScript tests passing** (including multi-process child-process SQLite crash recovery, contention race checks, strict PayPal response validation & POST-before-GET capture reconciliation contradiction guards, exact host/origin rejection, `AIza*`/`AQ.*` key validation, and single-instance server lock tests). Isolated unit/integration tests use mocked/simulated adapters even if `.env` is configured locally.
  - `npm run test:python`: **7 Python reference tests passing** (`reference_python/`).
  - `npm run lint`: **`tsc --noEmit` passing** with 0 errors.
  - `npm run build`: **Vite production build passing** with 0 warnings.
  - **Measured Local Benchmark (`600` ledger events):** `GET /api/ledger` reduced from `87.51 ms` to `34.78 ms` and `POST /api/review` reduced from `173.50 ms` to `51.34 ms` while keeping 100% end-to-end SHA-256 verification.
- **Live External API Verification (Executed with Fictitious Data):**
  - **Live Google Gemini API (`LIVE_GEMINI_API`):** Authenticated live calls to `/api/ai/extract` (`119.00 EUR` fictional invoice) and Zero-PII `/api/ai/explain` (`REVIEW_REQUIRED`, `["EXPECTED_AMOUNT_MISMATCH"]`) succeeded via modern `AQ.*` key; when `gemini-3.8-flash` hit transient `503`/`504` high-demand limits, resilient Flash failover succeeded on `gemini-3.5-flash-lite` and logged the exact `model_id` in the audit ledger.
  - **Live PayPal Sandbox REST (`LIVE_PAYPAL_SANDBOX_REST`, `https://api-m.sandbox.paypal.com`):** Real Sandbox Order **`8DH65564PK409905U`** (`119.00 EUR`, `custom_id` = receipt hash) was created -> buyer-approved by a `DE` Sandbox Personal test buyer -> captured at PayPal (**Capture ID `3ND85370G4181781M`**, `status: COMPLETED`, `119.00 EUR`) -> verified reconciled into SQLite `COMPLETED` -> persisted cleanly across full server restart (`LEDGER: PASS`). Live testing also uncovered and fixed two real-world PayPal API quirks (`captures[0].custom_id` parsing on `POST /capture` and `return_url` redirect context).

### Prerequisites
- **Node.js 24** (`v24.18.0` verified) and `npm`
- **Python 3** $\ge 3.10$ (optional, for the 7 Python reference tests in `reference_python/`)

### Installation & Local Startup
```bash
git clone -b feature/invoice-guard-public https://github.com/AhaWissenschaft/syntravariga-paypal-demo.git
cd syntravariga-paypal-demo/ai-studio
npm install
npm run build
NODE_ENV=production node --import tsx server.ts
# Or development mode with Vite middleware:
npm run dev
```
Default URL: `http://127.0.0.1:3000` (`http://localhost:3000`). Default ledger/SQLite database resides under the OS temporary directory (`os.tmpdir()/syntravariga_paypal_demo.jsonl[.sqlite]`, cross-platform Windows/Linux) unless overridden with `SYNTRA_DEMO_LEDGER`.

### Optional Live Sandbox & Gemini Environment Variables (`.env`)
Without credentials, the application runs deterministically using local non-AI fallbacks and local PayPal Sandbox protocol simulation. To enable live APIs, copy `.env.example` to `.env` inside `ai-studio/` (never commit `.env`):
```bash
GEMINI_API_KEY="your_gemini_api_key"
GEMINI_MODEL_ID="gemini-3.8-flash"
PAYPAL_CLIENT_ID="your_paypal_sandbox_client_id"
PAYPAL_CLIENT_SECRET="your_paypal_sandbox_client_secret"
PAYPAL_API_BASE="https://api-m.sandbox.paypal.com"
```

### Running All Automated Tests & Build Checks
```bash
npm test             # 51 TypeScript kernel, SQLite ACID, crash recovery & hardening tests
npm run test:python  # 7 earlier Python reference tests
npm run lint         # TypeScript strict typecheck (tsc --noEmit)
npm run build        # Vite production bundle
```
