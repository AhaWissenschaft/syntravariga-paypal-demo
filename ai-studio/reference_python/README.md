# SyntraVariga PayPal Demo

**AhaWissenschaft · SyntraVariga**

A local demonstration of deterministic invoice-field checks, a hash-chained review log, and optional PayPal Sandbox checkout. Experimental prototype, not a fraud detector or production payment control.

## Checks

- Supplier text against the expected supplier text supplied by the user.
- Invoice amount against the expected amount supplied by the user.
- Whether net plus tax equals gross.
- Presence and basic length of an invoice number.

A consistent result means only that entered fields pass these checks. It does not establish that a document, supplier, tax treatment, or invoice is authentic, or that a payment is safe. A person decides whether to proceed.

## PayPal Sandbox flow

When the checks return FIELDS_CONSISTENT, the page presents the PayPal JavaScript SDK Sandbox button. The server verifies the SyntraVariga ledger receipt before creating a EUR 1.00 test order and puts its SHA-256 event hash in PayPal custom_id. Before capture, the server retrieves the order and checks APPROVED status and receipt reference. It records a capture only when PayPal returns COMPLETED.

No successful PayPal transaction is claimed. Server REST credentials are read from PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET environment variables. Never put the secret in the browser or commit it. PAYPAL_API_BASE is restricted to PayPal Sandbox. Use test accounts only.

## Run locally

Tested with Python 3.12.14 on Linux. No extra Python packages required. Set Sandbox credentials in the environment, then run:

    python app.py

Open http://127.0.0.1:8787 and use fictional data.

Run tests:

    python -m unittest -v test_invoice test_ledger_integration

## Ledger and limits

The local ledger stores finding codes and result status, not invoice fields. A hash chain detects changes to entries when verified; hashes do not prove truth, identity, authorization, or payment. Someone able to rewrite the whole file can recompute it unless its head hash is preserved elsewhere. The lock coordinates threads in one process only. The default log path is temporary (/tmp).

The user must click the Sandbox button. This prototype has no production deployment, real-money flow, or external transaction validation.
