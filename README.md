# SyntraVariga PayPal Demo

**AhaWissenschaft · SyntraVariga**

A local demonstration of deterministic invoice-field checks, a hash-chained review log, and optional PayPal Sandbox checkout. Experimental prototype, not a fraud detector or production payment control.

## Checks

- Supplier text against the expected supplier text supplied by the user.
- Invoice amount against expected amount and gross amount supplied by the user.
- Whether net plus tax equals gross.
- Presence and basic length of an invoice number.

A consistent result means only that entered fields pass these checks. It does not establish that a document, supplier, tax treatment, or invoice is authentic, or that a payment is safe. A person decides whether to proceed.

## PayPal Sandbox flow

Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET for the same PayPal Sandbox app. The server inserts the public client ID into the browser SDK at request time; the client secret remains server-side. When checks return FIELDS_CONSISTENT, the page presents the PayPal Sandbox button. The server verifies the SyntraVariga ledger receipt before creating a EUR 1.00 test order, then stores the event hash in PayPal custom_id. Before capture, it retrieves the order and checks APPROVED status and the matching receipt reference. It records a capture only when PayPal returns COMPLETED.

No successful PayPal transaction is claimed. PAYPAL_API_BASE is restricted to PayPal Sandbox. Never put the secret in the browser or commit it. Use test accounts only.

## Run locally

Tested with Python 3.12.14 on Linux. No extra Python packages required. Set Sandbox credentials in the environment, then run:

    python app.py

Open http://127.0.0.1:8787 and use fictional data. The /ledger view shows only event metadata and selected finding/status fields; it omits invoice content and PayPal order IDs.

Run tests:

    python -m unittest -v test_invoice test_ledger_integration

## Ledger and limits

The local ledger stores finding codes and result status, not invoice fields. A hash chain detects changes to entries when verified; hashes do not prove truth, identity, authorization, or payment. Someone able to rewrite the whole file can recompute it unless its head hash is preserved elsewhere. The lock coordinates threads in one process only. The default log path is temporary (/tmp).

The user must click the Sandbox button. This prototype has no production deployment, real-money flow, or external transaction validation.
