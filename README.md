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


## Start here for the competition demo

SyntraVariga helps small businesses and freelancers review supplier invoices before paying. AI proposes invoice fields, a person confirms them, and deterministic checks keep checkout locked when the confirmed data fails the configured rules. The application records review and payment steps in an auditable ledger.

### Run the submitted application

Use Node.js 24 and npm. These commands select the competition branch and start its web application:

```bash
git clone -b feature/invoice-guard-public https://github.com/AhaWissenschaft/syntravariga-paypal-demo.git
cd syntravariga-paypal-demo/ai-studio
npm install
npm run dev
```

Open http://127.0.0.1:3000. Without credentials, extraction uses the local deterministic fallback and payment steps use local protocol simulation. Live Gemini and PayPal Sandbox calls require the configuration and explicit opt-in described in the [competition setup guide](https://github.com/AhaWissenschaft/syntravariga-paypal-demo/blob/feature/invoice-guard-public/ai-studio/README.md).

### Suggested evaluation walkthrough

1. Review a synthetic invoice against the expected purchase-order data. Inspect discrepancies and the checkout lock.
2. Correct and confirm the invoice fields, then run verification again.
3. Edit a verified field and check that the earlier verification receipt is invalidated.
4. Inspect the audit ledger and the isolated negative self-tests.
5. Use the demo video and the competition README to inspect the documented live Gemini and completed PayPal Sandbox flow. Local simulation alone does not demonstrate a live payment.

For reproducible automated checks, run `npm test`, `npm run lint`, and `npm run build` from `ai-studio/`. Optional Python reference tests use `npm run test:python`.

The competition guide identifies the pre-existing SyntraVariga components and the work added during the hackathon. Passing invoice checks establishes consistency with the configured rules; invoice authenticity and supplier identity require separate verification.

---

## Earlier standalone Python prototype

The remaining sections describe the earlier Python prototype on this branch. For evaluation of the submitted web application, use the competition links and instructions above.


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
