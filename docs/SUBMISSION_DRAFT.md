# SyntraVariga Invoice & Payment Guard — Devpost Submission Draft (`1296728`)

> **Status Note (Ready for Owner Review & Video):** Code, 50 TS + 7 Python tests, live Gemini calls, and live PayPal Sandbox end-to-end capture/persistence are verified. Existing Devpost draft ID `1296728` (`1/5 steps done`) has not been submitted yet. Pre-fill draft fields and attach the approved `<3 min` YouTube `Unlisted` video link before clicking Submit.

---

## 1. Devpost Step 2 — Project Overview (`/project-overview`)

### Project Name (max 60 chars — 37 chars used)
`SyntraVariga Invoice & Payment Guard`

### Elevator Pitch (max 200 chars — 193 chars used)
`Human-verified invoice guard and PayPal Sandbox checkout with optional Gemini 3.8 Flash extraction, deterministic integer-cent rules, and a tamper-evident SQLite SHA-256 audit ledger.`

---

## 2. Devpost Step 3 — Project Details (`/project_details/edit`)

### About the Project (Markdown Story)

```markdown
## Inspiration
Small businesses and freelancers regularly verify incoming supplier invoices by hand before sending money: Does the supplier match our purchase order? Do net + VAT add up to the billed gross total? Did someone already pay this invoice reference? Letting an autonomous LLM trigger payments directly creates unacceptable accounting and security risk—so we designed a strict separation between probabilistic AI assistance and deterministic payment authorization.

## What it does
**SyntraVariga Invoice & Payment Guard** runs a six-stage auditable workflow under branch [`feature/invoice-guard-public`](https://github.com/AhaWissenschaft/syntravariga-paypal-demo/tree/feature/invoice-guard-public) (`ai-studio/`):

1. **Structured Field Proposal (`POST /api/ai/extract`):** Extracts `vendor`, `invoice_number`, `net_amount`, `tax_amount`, `gross_amount`, and `amount` from fictitious English or German invoice text. Missing placeholders (`---`, `N/A`) and ambiguous conflicting totals are surfaced with explicit manual-review warnings rather than guessed. Uses a transparent local deterministic parser by default and calls Google Gemini (`gemini-3.8-flash`) only with explicit user opt-in.
2. **Human Inspection & Confirmation:** A reviewer inspects, edits, or selects ambiguous candidates manually. Any field edit immediately invalidates any prior sealed verification receipt.
3. **Deterministic Integer-Cent Verification (`invoiceGuard.ts`):** Evaluates confirmed fields strictly in integer cents (`Net + Tax === Gross === Payable Amount`), applies Unicode `NFKC` supplier comparison against the expected purchase order, and supports optional SHA-256 duplicate-invoice checks (`DUPLICATE_INVOICE`). Only deterministic rules decide `FIELDS_CONSISTENT` vs. `REVIEW_REQUIRED`.
4. **Tamper-Evident Audit Ledger & Zero-PII Explainer (`POST /api/ai/explain`):** Seals each review inside an append-only RFC 8785 canonical JSON + FIPS 180-4 SHA-256 chain stored in ACID SQLite. When explaining findings with optional Gemini opt-in, **only** `{ status, finding_codes }` leave the server—zero invoice vendor names, numbers, or amounts.
5. **Server-Bound PayPal Sandbox Checkout & Crash Recovery:** Reserves the verified one-time receipt in SQLite (`BEGIN IMMEDIATE`) with deterministic `PayPal-Request-Id` idempotency keys before calling `https://api-m.sandbox.paypal.com/v2/checkout/orders`, binds `EUR` currency, `verified_amount_eur`, and `custom_id` to the server-side receipt, enforces explicit buyer approval before capture, and transitions gateway timeouts or interrupted operations into `UNKNOWN_RECONCILIATION_REQUIRED` for manual reconciliation rather than blind retries.
6. **Batch Sample Triage & Isolated Negative Self-Tests:** Demonstrates deterministic triage across 5 synthetic invoices and executes 4 isolated negative checks (receipt forgery guard, post-review amount mismatch, atomic replay block, and Zero-PII payload guard) in a temporary SQLite store without touching the main audit ledger.

## How we built it
- **Frontend (`ai-studio/src/`):** React 19, TypeScript, Tailwind CSS, Lucide icons, WCAG contrast & keyboard-accessible Audit Ledger explorer, mobile-responsive layout, and persistent SQLite payment resume/reconciliation views.
- **Backend & Persistence (`ai-studio/server.ts`, `persistentStore.ts`):** Node 24 (`node:sqlite` WAL + native `node:crypto` SHA-256), Express with exact `scheme://host:port` validation and single-instance PID locking (`acquireSingleInstanceServerLock`), strict PayPal response verification (`paypalSandbox.ts`), and bounded request timeouts with resilient Flash model failover on external Gemini requests.

## Challenges we ran into & Honest Boundaries
- **No magic AI claims:** LLMs can misread numbers or hallucinate missing VAT fields. Blocking placeholders and keeping payment locks purely deterministic prevented prompt or model quirks from unlocking checkout.
- **Database recovery vs. multi-process safety:** Startup crash recovery locks transient `RESERVED_ORDER` and `CAPTURE_PENDING` rows into `UNKNOWN_RECONCILIATION_REQUIRED`, so supporting two Express processes on one database file would falsely lock sibling requests. We enforce a per-database `.server.pid` lock in `startServer()` and clearly scope supported deployment to one server process per database.
- **Explicit non-claims:** Passing deterministic rules confirms internal arithmetic and purchase-order consistency on user-confirmed fields—it is not proof of legal invoice authenticity, supplier identity verification, or absolute prevention of out-of-band double payments.

## Accomplishments & Verification
- **Automated Test Matrix:** 50 TypeScript tests (`npm test`—including multi-process child crash recovery, concurrent SQLite lock race checks, `AIza*`/`AQ.*` key & Flash failover checks, PayPal response validation, exact host/origin checks, and isolated HTTP end-to-end lifecycle) + 7 reference Python tests (`npm run test:python`), passing `tsc --noEmit` and Vite production build (0 warnings).
- **Performance Optimization:** Replaced repeated pure-JS full-ledger passes with single-transaction native `node:crypto` verification (`600` events: `GET /api/ledger` `87.51 ms -> 34.78 ms`, `POST /api/review` `173.50 ms -> 51.34 ms`).
- **Live External APIs Verified (Fictitious Data Only):**
  - **Google Gemini (`LIVE_GEMINI_API`):** Verified live `/api/ai/extract` and zero-PII `/api/ai/explain` calls via `AQ.*` auth key; automatic capacity failover succeeded on `gemini-3.5-flash-lite` when `gemini-3.8-flash` hit transient `503`/`504` limits and recorded the active `model_id` in SQLite.
  - **PayPal Sandbox REST (`LIVE_PAYPAL_SANDBOX_REST`, `https://api-m.sandbox.paypal.com`):** Verified live Sandbox order `8DH65564PK409905U` (`119.00 EUR`, bound to verified receipt via `custom_id`), real DE Sandbox Personal test-buyer approval, captured settlement (`3ND85370G4181781M`, `COMPLETED`, `119.00 EUR`), reconciliation handling, and SQLite state persistence across full server restart (`LEDGER: PASS`).

## What we learned & What's next
Separating probabilistic AI extraction from deterministic financial state machines makes AI workflows auditable. Next steps include external head-hash anchoring, multi-currency invoice rules, and webhook reconciliation with merchant accounting ledgers.
```

### Built With (Tags)
`typescript`, `react`, `node.js`, `sqlite`, `express`, `google-gemini`, `paypal`, `tailwindcss`, `vite`, `python`

### "Try it out" Links
1. **Competition Branch (`ai-studio/` Web App):** `https://github.com/AhaWissenschaft/syntravariga-paypal-demo/tree/feature/invoice-guard-public/ai-studio`
2. **Branch Root:** `https://github.com/AhaWissenschaft/syntravariga-paypal-demo/tree/feature/invoice-guard-public`

### Demonstration Video (YouTube)
- **Selected Visibility:** **Unlisted** with no password, strictly **< 3 minutes** (explicitly permitted on Devpost's submission form: `"Visibility: Set to public or unlisted with no password."`, `"Only the first 3 minutes will be reviewed"`).

---

## 3. Devpost Step 4 — Additional Info (`/additional-info/edit`)

- **Submitter Type:** `Individual`
- **Country of Residence:** `Germany` *(enter directly in Devpost form; avoid personal details beyond required dropdown)*
- **Is your project new, or did it exist before Oct 1, 2026 (9:15 am PT)?**  
  `Yes — Existing project significantly updated during the Hackathon Submission Period`
- **If it existed before, explain what already existed and what you built or changed during the Hackathon Submission Period:**  
  `Pre-existing SyntraVariga foundations included the general RFC 8785 canonical JSON & SHA-256 hash-ledger and contract primitives (aha_lab/ledger.py, aha_lab/contracts.py) alongside the TypeScript kernel port (crypto.ts, ledger.ts). During the hackathon submission period on branch feature/invoice-guard-public (inside ai-studio/), we built and hardened the entire React + TypeScript Jury web application, deterministic English/German invoice extraction guardrails & uncertainty flags, Zero-PII Gemini (gemini-3.8-flash + resilient Flash failover) explainer boundary, transactional SQLite ACID co-storage (ledger_events + payment_records), startup crash recovery, strict PayPal Sandbox REST integration (order -> explicit buyer approval -> capture -> reconciliation -> return_url redirect), single-instance PID lock, and the 50-test TypeScript hardening suite.`
- **Explain how your project meets the main technology requirement (PayPal + AI):**  
  `SyntraVariga pairs Google Gemini (gemini-3.8-flash, explicit opt-in) for unstructured invoice-field extraction and privacy-preserving finding explanations (transmitting only finding codes, zero PII) with a PayPal Sandbox REST integration (https://api-m.sandbox.paypal.com/v2/checkout/orders) where only server-verified invoice totals bound in SQLite can create, buyer-approve, and capture EUR Sandbox orders.`
- **Public Code Repository URL:**  
  `https://github.com/AhaWissenschaft/syntravariga-paypal-demo/tree/feature/invoice-guard-public`  
  *(Fallback if Devpost strictly requires root repo URL: `https://github.com/AhaWissenschaft/syntravariga-paypal-demo` + highlight `git checkout feature/invoice-guard-public && cd ai-studio` in Testing Instructions).*
- **Testing Instructions for Judges:**
  ```text
  IMPORTANT: The React/TypeScript/PayPal Hackathon application is on branch `feature/invoice-guard-public` inside subfolder `ai-studio/`:
  1. git clone -b feature/invoice-guard-public https://github.com/AhaWissenschaft/syntravariga-paypal-demo.git
  2. cd syntravariga-paypal-demo/ai-studio && npm install && npm run dev
  3. Open http://127.0.0.1:3000 in your browser (runs with deterministic local fallbacks & Sandbox simulation out of the box—no API keys required to test full workflow).
  4. Optional live API testing: copy .env.example to .env and supply your own GEMINI_API_KEY and PayPal Sandbox PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET + Sandbox Buyer test account.
  5. Run automated tests: `npm test` (50 TS tests), `npm run test:python` (7 Python tests), `npm run lint`, `npm run build`.
  ```

---

## 4. Under-3-Minute Demo Video Script (~2:30 min, English)

| Time | Screen Action | Narration |
|---|---|---|
| **0:00 – 0:25** | Show `SyntraVariga Invoice & Payment Guard` UI + Jury Value Strip + runtime status badges. | "Freelancers and SMB teams catch costly invoice errors manually before payout—yet letting an LLM pay invoices autonomously is too risky. SyntraVariga Invoice & Payment Guard pairs optional Gemini extraction, human review, deterministic rules, and a server-bound PayPal Sandbox checkout." |
| **0:25 – 0:55** | Select **Scenario A (149 vs 119 EUR)** -> **Step 1** -> **Step 2 (`REVIEW_REQUIRED`)**. Point at **PAYMENT PATH LOCKED**. | "First, let's test an overbilled 149 EUR invoice against a 119 EUR purchase order. Whether parsed locally or via opted-in Gemini 3.8 Flash, AI only proposes fields. Once confirmed, integer-cent rules flag `EXPECTED_AMOUNT_MISMATCH` and lock PayPal checkout." |
| **0:55 – 1:15** | Click **Step 3: Explain Finding Codes (Zero PII)**. Highlight `{ status, finding_codes }`. | "Even when explaining discrepancies, our zero-PII contract sends only status and anonymized finding codes—never supplier names, invoice numbers, or amounts." |
| **1:15 – 2:05** | Select **Scenario B (119.00 EUR)** -> **Step 1** -> **Step 2 (`FIELDS_CONSISTENT`)** -> **Create PayPal Sandbox Order** -> **Approve** -> **Capture**. Show Capture ID & `119.00 EUR` + reload page & click **Resume / Inspect**. | "With a matching 119.00 EUR invoice, rules seal a one-time audit receipt in ACID SQLite. Creating the order reserves the receipt with a `PayPal-Request-Id` key and binds 119.00 EUR on the server. After explicit Sandbox buyer approval, capture completes and returns the real Capture ID and EUR status—and persists across reloads." |
| **2:05 – 2:30** | Click **Evaluate 5 Sample Invoices** + **Run 4 Isolated Negative Checks** -> open **Audit Ledger** tab (`LEDGER: PASS`) -> wrap up honestly. | "In seconds we triage a 5-invoice sample batch, verify 4 isolated security guards, and inspect the SHA-256 audit ledger. SyntraVariga proves honest, recoverable, deterministic control over AI-assisted Sandbox payments." |
