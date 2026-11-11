# SyntraVariga Invoice & Payment Guard (AhaWissenschaft)

**PayPal AI Hackathon Submission Prototype (v1.4 Hardened)**
**License:** MIT (see `/LICENSE`)
**Scope:** PayPal Sandbox & Demo Only · Fictitious Invoice Data · Human-in-the-Loop Verification

---

## 1. Overview & Judge Guide (English)

### Problem Statement
Small businesses and freelancers frequently inspect incoming supplier invoices manually before paying them:
1. Does the supplier name on the invoice match the purchase order?
2. Does the billed total match the expected purchase order amount?
3. Does `Net + Tax` equal `Gross` in exact integer cents?
4. Has an invoice with the same supplier and invoice number already been verified (`DUPLICATE_INVOICE`)?

### Architecture & Security Boundaries (v1.4)

| Component | Responsibility & Strict Boundary |
|---|---|
| **1. Invoice Field Proposal (`POST /api/ai/extract`)** | Proposes structured fields (`vendor`, `invoice_number`, `net_amount`, `tax_amount`, `gross_amount`, `amount`) from free-form fictitious invoice text and flags missing or conflicting amounts. **Privacy Default:** Runs **100% locally via a deterministic regex parser (not AI)** unless the user explicitly checks the consent box to transmit the fictitious demo text to Google Gemini (`gemini-3.8-flash`). Any model error is surfaced transparently in `external_ai_error`. |
| **2. Human Inspection & Confirmation** | A human reviewer inspects, edits, and confirms the proposed fields. Any subsequent edit immediately invalidates the active verification receipt. |
| **3. Deterministic Verification Rules (`invoiceGuard.ts`)** | Evaluates confirmed fields using integer-cent arithmetic ($Net_{cent} + Tax_{cent} \equiv Gross_{cent} \equiv Amount_{cent}$), Unicode `NFKC` normalization, and SHA-256 duplicate-invoice detection (`DUPLICATE_INVOICE`). Solely decides `FIELDS_CONSISTENT` vs. `REVIEW_REQUIRED`. |
| **4. Zero-PII Finding Code Explainer (`POST /api/ai/explain`)** | Runs a deterministic local rule dictionary (not AI) by default. Only when the user explicitly opts in (`allow_external_ai: true`) does it transmit `{ status, finding_codes }` (never raw invoice fields) to Google Gemini (`gemini-3.8-flash`). The server strictly enforces `SERVER_ENFORCED_BOUNDARY_DISCLAIMER` and locks the `finding_codes` list. |
| **5. Transactional SQLite Ledger & Payment Co-Storage (`persistentStore.ts`)** | Stores both the cryptographic audit ledger (`ledger_events`) and payment lifecycle state (`payment_records`) in a single ACID SQLite database (`node:sqlite`, `WAL`, `BEGIN IMMEDIATE`). Eliminates stale `.lock` files on process crash: OS-level SQLite locks release automatically on unexpected termination and uncommitted writes roll back cleanly. Payment state transitions (`ORDER_CREATED`, `ORDER_APPROVED`, `COMPLETED`, `UNKNOWN_RECONCILIATION_REQUIRED`) and their corresponding audit ledger events are committed together in a **single ACID SQLite transaction**. On server startup, `recoverInFlightRecordsOnStartup()` atomically transitions any interrupted `RESERVED_ORDER` or `CAPTURE_PENDING` record into `UNKNOWN_RECONCILIATION_REQUIRED` co-committed with a `paypal_crash_recovery_lock` ledger event. |
| **6. Strict PayPal Response Validation (`paypalSandbox.ts`)** | Validates Order ID, status, **exactly one** `purchase_unit`, `custom_id === receipt_hash`, `currency_code === 'EUR'`, `value === verified_amount_eur`, and **exactly one** `COMPLETED` capture record without substituting missing fields with expected values. |
| **7. Exact Host & Origin Validation (`verifyExactHostAndOrigin`)** | Validates `Host` and `Origin` headers including exact scheme (`http:` vs `https:`), hostname, and port (`:3000`). Never accepts wildcard `*.run.app` origins; a Cloud Preview origin is permitted only if its exact `protocol://host[:port]` is explicitly configured via `APP_URL` or `TRUSTED_PREVIEW_ORIGIN`. |
| **8. Isolated Negative Self-Test (`POST /api/redteam/isolated`)** | Executes 4 internal function and temporary SQLite negative checks mapped to HTTP 403/400/409 equivalents—making zero external API calls and zero modifications to the active ledger. |

### Explicit Limitations: What This Prototype Does NOT Claim
- **No Guarantee of Invoice Authenticity or Fraud Absence:** `FIELDS_CONSISTENT` only means the entered values satisfy the formal arithmetic and comparison rules.
- **No Absolute Guarantee Against All Double Payments:** SQLite `BEGIN IMMEDIATE` reservations and `PayPal-Request-Id` headers prevent concurrent race conditions within this service, and `UNKNOWN_RECONCILIATION_REQUIRED` blocks automatic retries after timeouts or crashes, but cannot prevent external out-of-band payments.
- **Hash Chain Scope:** The SHA-256 chain makes post-hoc edits to individual entries detectable, but someone with full write access to the local SQLite database file could recompute the chain from Genesis unless the head hash is anchored externally.
- **API Keys & Billing:** A Google AI Studio API key is not automatically free of charge; external Gemini calls require explicit opt-in in the UI. In environments without configured external credentials, no live external Gemini or PayPal Sandbox calls occur.

---

## 2. Quick Start for Judges

### Current verification status

Automated tests use simulations or mocked external responses. A live Gemini request and a completed PayPal Sandbox transaction have not been verified. Do not present this prototype as a submitted or production-ready system. Run only one server process per database: startup recovery cannot distinguish an interrupted operation from one still running in another process.

### Prerequisites
- **Node.js 24** and `npm` (verified with Node 24.22.1; Vite requires Node 22.12 or newer on the 22.x line)
- **Python 3** $\ge 3.10$ (optional, to run the 7 original Python reference tests in `reference_python/`)

### Installation & Local Startup
```bash
npm install
npm run dev
```
By default, the server binds to `http://127.0.0.1:3000` (`http://localhost:3000`) and validates exact `Host` and `Origin` headers (including scheme and port).

### Optional Environment Variables (`.env`)
Without external credentials, the app runs deterministically using local non-AI fallbacks and local PayPal Sandbox protocol simulation. To test with live external APIs, copy `.env.example` to `.env`:
```bash
GEMINI_API_KEY="your_gemini_api_key"
GEMINI_MODEL_ID="gemini-3.8-flash"
PAYPAL_CLIENT_ID="your_paypal_sandbox_client_id"
PAYPAL_CLIENT_SECRET="your_paypal_sandbox_client_secret"
PAYPAL_API_BASE="https://api-m.sandbox.paypal.com"
```

### Running All Automated Tests & Build Checks
```bash
# Run all 47 TypeScript Kernel, SQLite ACID, Multi-Process Crash & Hardening Tests
npm test

# Run the 7 Original Python Reference Tests
npm run test:python

# TypeScript Typecheck & Production Build
npm run lint
npm run build
```
