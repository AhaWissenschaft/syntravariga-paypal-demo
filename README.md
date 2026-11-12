# SyntraVariga Invoice & Payment Guard

AhaWissenschaft · SyntraVariga

> [!IMPORTANT]
> **PayPal AI Hackathon Jury Notice — Submitted Application & Links**
>
> The submitted React + TypeScript + Express + SQLite competition web application (**SyntraVariga Invoice & Payment Guard**, `ai-studio/`) lives on branch **[`feature/invoice-guard-public`](https://github.com/AhaWissenschaft/syntravariga-paypal-demo/tree/feature/invoice-guard-public)**. This default `main` branch intentionally preserves the earlier standalone Python prototype documented below.
>
> - **Competition Web App (`ai-studio/`):** https://github.com/AhaWissenschaft/syntravariga-paypal-demo/tree/feature/invoice-guard-public/ai-studio
> - **Submitted GitHub Branch (`feature/invoice-guard-public`):** https://github.com/AhaWissenschaft/syntravariga-paypal-demo/tree/feature/invoice-guard-public
> - **Demo Video (YouTube, 2:44):** https://youtu.be/GuKfCt4Cmb8
> - **Official Devpost Submission:** https://devpost.com/software/syntravariga-invoice-payment-guard

---

Experimental local prototype. It proposes fields from fictional invoice text, compares user-confirmed fields with expected order data and offers a PayPal Sandbox-only checkout. It is not a fraud detector, identity check, production payment system or proof that an invoice is authentic.

## Status

Local automated tests for the standalone Python prototype pass with mocked payment/AI responses. Live AI and end-to-end PayPal Sandbox verification are **not** claimed for this standalone Python prototype. The **submitted React/TypeScript competition application** in [`feature/invoice-guard-public/ai-studio`](https://github.com/AhaWissenschaft/syntravariga-paypal-demo/tree/feature/invoice-guard-public/ai-studio) separately documents verified live Gemini and PayPal Sandbox integration. The Python extraction fallback is deterministic and is not AI. The model provider determines charges: do not enable external calls without verifying cost and data terms.

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

The project combines an existing SyntraVariga hash-chain component with an experimental invoice checking and Sandbox checkout demo. Exact prior creation dates and competition eligibility must be substantiated. The contest requires meaningful PayPal and AI use, a working demo, open-source repository and a YouTube demo; see https://paypalaihackathon.devpost.com/rules . The standalone Python prototype does not claim a verified live AI call or completed Sandbox payment. The submitted `ai-studio/` competition application separately documents live verification on the linked competition branch. No prize is claimed.
