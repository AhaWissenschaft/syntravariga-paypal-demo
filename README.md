# SyntraVariga Invoice & Payment Guard

AhaWissenschaft · SyntraVariga

Experimental local prototype. It proposes fields from fictional invoice text, compares user-confirmed fields with expected order data and offers a PayPal Sandbox-only checkout. It is not a fraud detector, identity check, production payment system or proof that an invoice is authentic.

## Status

Automated offline checks pass with isolated/mocked adapters (**51 TypeScript tests**, **7 Python reference tests**, `tsc --noEmit`, Vite build), and live external integrations have also been verified with real credentials and fictitious invoice data:
- **Live Gemini API (`LIVE_GEMINI_API`):** Authenticated live calls to `/api/ai/extract` and zero-PII `/api/ai/explain` succeeded; when `gemini-3.8-flash` experienced transient capacity/deadline pressure (`503`/`504`), automatic model failover succeeded cleanly on `gemini-3.5-flash-lite` and logged the exact `model_id` in the audit ledger.
- **Live PayPal Sandbox (`LIVE_PAYPAL_SANDBOX_REST`, `https://api-m.sandbox.paypal.com`):** Real Sandbox order `8DH65564PK409905U` (`119.00 EUR`, bound via `custom_id` to receipt `f9cf4942ee729379d5ae016e24343d445196c435ceba2847b99abcda6a24ceed`) was created, explicitly approved by a `DE` Sandbox Personal test buyer, captured (`3ND85370G4181781M`, `COMPLETED`, `119.00 EUR`), reconciled in SQLite, and verified persistent across a full server restart (`LEDGER: PASS`).

The extraction fallback is deterministic and is not AI. The model provider determines charges: do not enable external calls without verifying cost and data terms. This project is still a Sandbox/hackathon demo and not a production payment system.

## Hackathon Web Candidate (`ai-studio/` on `feature/invoice-guard-public`)

The React + TypeScript + Express + SQLite competition candidate is in [`ai-studio/`](ai-studio/README.md) on branch **[`feature/invoice-guard-public`](https://github.com/AhaWissenschaft/syntravariga-paypal-demo/tree/feature/invoice-guard-public/ai-studio)**.  
It preserves the standalone Python demo below and has its own setup, UI, and **51 TypeScript hardening tests** (+ **7 legacy `reference_python/` snapshot tests**). Supported operation is one server process per SQLite database (enforced by a `.server.pid` lock).

## Run

Tested in Linux with Python 3.12. No additional Python packages are required.

    python -m unittest discover -v
    python app.py

Open http://127.0.0.1:8787. Use fictional data only. The app listens on loopback and is not suitable for public deployment. The extraction and explanation functions default to local fallback. To enable external AI, explicitly set `SYNTRA_ALLOW_EXTERNAL_AI=1` and configure the relevant provider key; entered invoice text is sent to the configured provider for extraction. The model's output requires human review. Do not enter secrets in source code or commit them.

The PayPal checkout requires `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET` from the same **Sandbox** application and a separate Sandbox buyer account. Use test accounts only. The application server enforces the PayPal Sandbox API host. A successful payment is not claimed.

## Intended flow

1. Enter a fictional invoice text or use a sample. Extraction generates unconfirmed proposed fields.
2. Check and edit those fields against a separately supplied expected order; submit them for deterministic review.
3. The optional comparison shows how two illustrative field changes affect the checks. It does not predict fraud or move money.
4. A matching review records a receipt and stores the approved amount and EUR currency server-side. An optional sandbox order uses these values and ties the receipt to PayPal's custom_id.
5. An explicit user approval in PayPal is required. The server checks the order status, reference, currency and amount before capture. Uncertain outcomes can block further attempts and require manual reconciliation.

## Limits

The locally generated receipt is a checksum-based reference, not proof of invoice truth, identity or authorization. A hash chain can be recomputed by a party with access to the files. Its unsalted amount commitment does not conceal a low-entropy amount from guessing. SQLite stores the approved amount in clear text; ledger and database live in local temporary storage by default. The ledger lock applies to a single server process; do not run multiple instances sharing it. A SQLite reservation guards simultaneous attempts for a single receipt; it does not deduplicate newly created reviews of the same invoice or guarantee exactly-once processing across crashes. No credentials are shipped in this repository.

## Competition and attribution

The project combines pre-existing SyntraVariga hash-chain and contract components (`aha_lab/ledger.py`, `aha_lab/contracts.py`) with an invoice checking and Sandbox checkout demo. The standalone root Python demo preserves the earlier CLI/HTTP prototype; the verified Hackathon web candidate with live Gemini and live PayPal Sandbox checks lives under [`ai-studio/`](ai-studio/README.md). Exact prior creation dates and competition eligibility must be substantiated. The contest requires meaningful PayPal and AI use, a working demo, open-source repository and a YouTube demo; see https://paypalaihackathon.devpost.com/rules . This repository does not claim contest submission or prize.
