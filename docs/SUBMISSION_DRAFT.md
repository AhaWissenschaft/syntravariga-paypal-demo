# SyntraVariga Invoice & Payment Guard — submission draft

**Not submitted.** Live AI, a full PayPal Sandbox checkout, current contest rules and eligibility still require verification. This document is preparation, not evidence of a working contest entry.

## Description

SyntraVariga helps a small business examine fictional invoice fields before an explicitly approved PayPal Sandbox checkout. A model adapter can propose invoice fields; a human must check them against separately supplied expected order data. Deterministic rules compare supplier text, amounts and arithmetic. A local audit log records the review, and SQLite binds its receipt to a server-held EUR amount and Sandbox order.

The default extraction mode is a deterministic local fallback, clearly labelled as not live AI. The prototype does not establish invoice authenticity, supplier identity, fraud prevention or payment safety. It never uses production PayPal endpoints.

## Demonstration script for approval before recording

1. Show the fictional-data and Sandbox boundaries and the current extraction mode.
2. Select a fictional invoice; propose fields. If live AI is enabled, identify the provider and data transfer before sending the text.
3. Manually verify proposed fields and enter expected order data independently.
4. Change an amount and show the resulting discrepancy. Restore matching values and review again.
5. Show the receipt and ledger verification. Explain that hashes do not establish truth or identity.
6. With configured Sandbox test accounts, explicitly approve checkout as the test buyer. Show the returned capture ID, amount, EUR currency and status. Do not show credentials or personal account details.
7. Explain timeout reconciliation and the limit of receipt-level replay protection: a new review can still create another receipt.

Do not record or upload a video before the project owner accepts the result. Do not publicly list a video without authorization. Whether an unlisted YouTube video meets the current rules has not been verified.

## Evidence and attribution

The starting public commit was f28c8249079d14f44e30f6b2d88f4449be015b41. Existing code includes the invoice rules, hash-chain component, AI adapters, UI and SQLite payment state machine; do not claim all were created in this session or during the contest. Their original creation dates and eligibility need substantiation.

On 2026-11-11, three new mocked-response regression tests demonstrated that additional purchase units, a different order identity and extra capture records could pass the previous adapter checks. The correction restricts capture validation to one matching approved order unit and one capture result. These tests show an improvement over this repository's prior behavior, not superiority to other products. No competing source code was used.

Validation: Python 3.12.14, `python -m unittest discover -q`: 33 tests passed. External payment/AI responses were simulated. Local HTTP checks verified the page, deterministic extraction and ledger PASS. No live model call, completed Sandbox payment, registration or submission is evidenced.

## Required before submission

- Verify the live official deadline, timezone, eligibility, license, video and submission requirements at https://paypalaihackathon.devpost.com/rules. The inherited deadline claim of 12 November 2026 at 21:00 Europe/Berlin is unverified here: the network proxy denied access.
- Verify public descriptions and licenses for ProofPowers Pay, Tamper, Railguard and ClaimPack before making comparisons. No independent head-to-head comparison has been performed.
- Configure only a confirmed free AI route; do not assume an API key implies free usage. Use fictional data, an explicit transfer notice and no paid calls.
- Supply credentials from the same PayPal Sandbox application securely through environment settings; use a separate Sandbox buyer. Complete and document create, explicit buyer approval and capture. Do not enter passwords or keys in chat.
- Verify timeout/restart reconciliation with real Sandbox responses. Never treat a timeout as payment success or blindly retry an unknown capture.
- The project owner must handle any required account sign-in and buyer approval. Do not revisit or bypass the previously rejected personal PayPal account page.
- Approve the demo before recording, settle YouTube visibility against official rules, then complete the Devpost entry only with accurate evidence.

No new accounts, fees, real payments, video uploads, messages, GitHub Actions, merges or force-pushes are authorized by this draft.
