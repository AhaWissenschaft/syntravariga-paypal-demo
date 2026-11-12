/**
 * @license
 * SyntraVariga / AhaWissenschaft Hardening & Security Integration Tests (v1.4)
 *
 * Verifies all 6 audit requirements:
 * 1. Transactional SQLite Co-Storage (`ledger_events` + `payment_records`) across restarts & fail-closed corruption detection without overwrite.
 * 2. Real Multi-Process Crash & Contention Tests (`child_process.spawnSync` / `spawn`):
 *    - Crash mid-SQLite transaction (between status update and ledger insert before COMMIT) -> automatic rollback, zero stale locks.
 *    - Crash between PayPal response and `confirmOrderCreated` / `confirmCaptureCompleted` -> startup `recoverInFlightRecordsOnStartup()` transitions `RESERVED_ORDER` / `CAPTURE_PENDING` to `UNKNOWN_RECONCILIATION_REQUIRED` co-committed with `paypal_crash_recovery_lock`.
 *    - Real multi-process parallel race on the same receipt -> exactly 1 child process reserves, 1 is rejected with `PaymentConcurrencyError`.
 * 3. Unknown PayPal State (`PayPalSandboxError` timeout / HTTP 502) -> co-commits `UNKNOWN_RECONCILIATION_REQUIRED` + `paypal_payment_state_unknown` ledger event, blocks retries, and reconciles via `reconcileUnknownPayment`.
 * 4. Strict PayPal Response Validation (`verifyStrictPayPalOrderPayload`, `verifyStrictPayPalCapturePayload`):
 *    - Rejects wrong currency, wrong order ID, extra `purchase_units`, extra `captures`, and missing `custom_id`.
 * 5. Exact Host & Origin Validation (`verifyExactHostAndOrigin` + HTTP integration):
 *    - Validates exact scheme (`http:` vs `https:`), hostname, and port.
 *    - Rejects arbitrary `*.run.app` origins/hosts unless explicitly configured via `trustedAppUrl` / `APP_URL`.
 * 6. Full HTTP End-to-End Integration Test (Review -> Order -> Approve -> Timeout Lock -> Reconcile -> Capture -> Isolated Red-Team Checks).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DatabaseSync } from 'node:sqlite';

import {
  loadAndVerifyPersistentLedger,
  loadVerifiedLedgerSnapshot,
  resolveSqliteDbPath,
  appendEventPersistently,
  PersistentPaymentStore,
  PaymentConcurrencyError,
  PaymentStateUnknownError,
} from './persistentStore';
import { LedgerError } from './ledger';
import {
  verifyStrictPayPalOrderPayload,
  verifyStrictPayPalCapturePayload,
  PayPalSandboxManager,
  PayPalSandboxError,
} from './paypalSandbox';
import {
  createConfiguredExpressApp,
  verifyExactHostAndOrigin,
  getLedgerFilePath,
  acquireSingleInstanceServerLock,
  hasValidGeminiApiKey,
  resolveGeminiModelSequence,
} from '../../server';

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `syntra-v14-${prefix}-`));
}

describe('Hardening Suite v1.4 (SQLite ACID Co-Storage, Multi-Process Crash Recovery, Exact Origin & PayPal Validation)', () => {
  it('1. Persists ledger & payment state transactionally across restarts and fails closed on corruption without overwriting', () => {
    const tmpDir = makeTempDir('persist');
    const ledgerPath = path.join(tmpDir, 'audit_ledger.jsonl');
    const sqlitePath = `${ledgerPath}.sqlite`;

    try {
      // First boot: initialize Genesis (1 entry) + append 2 events + co-commit 1 order creation (total 4 events)
      const initial = loadAndVerifyPersistentLedger(ledgerPath);
      assert.equal(initial.length, 1);

      const step1 = appendEventPersistently(ledgerPath, {
        eventType: 'ai_invoice_extraction',
        payload: { provider_mode: 'LOCAL_DETERMINISTIC_PARSER_FALLBACK', ok: true },
      });
      assert.equal(step1.events.length, 2);

      const step2 = appendEventPersistently(ledgerPath, {
        eventType: 'invoice_review',
        payload: {
          finding_codes: [],
          status: 'FIELDS_CONSISTENT',
          verified_amount_eur: '119.00',
          verified_currency: 'EUR',
        },
      });
      assert.equal(step2.events.length, 3);

      const store1 = new PersistentPaymentStore(ledgerPath);
      store1.reserveForOrderCreation({
        receiptHash: step2.newEvent.event_hash,
        receiptIndex: step2.newEvent.index,
        verifiedAmountEur: '119.00',
      });
      const coCommitted = store1.confirmOrderCreated({
        receiptHash: step2.newEvent.event_hash,
        orderId: 'SB-ORD-PERSIST01',
        approveUrl: 'https://www.sandbox.paypal.com/checkoutnow?token=SB-ORD-PERSIST01',
        executionMode: 'SANDBOX_PROTOCOL_SIMULATION',
        appendLedgerEvent: true,
      });
      assert.equal(coCommitted.events?.length, 4);

      // Simulate server restart: reload from disk -> must preserve all 4 ledger events AND payment record
      const afterRestart = loadAndVerifyPersistentLedger(ledgerPath);
      assert.equal(afterRestart.length, 4);
      assert.equal(afterRestart[2].event_hash, step2.newEvent.event_hash);
      assert.equal(afterRestart[3].event_type, 'paypal_sandbox_order');

      const store2 = new PersistentPaymentStore(ledgerPath);
      const persistedRec = store2.getRecord(step2.newEvent.event_hash);
      assert.ok(persistedRec);
      assert.equal(persistedRec.state, 'ORDER_CREATED');
      assert.equal(persistedRec.order_id, 'SB-ORD-PERSIST01');

      // Simulate tampering inside SQLite ledger_events table -> must fail closed and NEVER overwrite
      const rawDb = new DatabaseSync(sqlitePath);
      rawDb
        .prepare(`UPDATE ledger_events SET payload_json = ? WHERE idx = 3`)
        .run(
          JSON.stringify({
            finding_codes: [],
            status: 'FIELDS_CONSISTENT',
            verified_amount_eur: '999.00',
            verified_currency: 'EUR',
          })
        );
      rawDb.close();

      // Mirror the tampered payload to .jsonl as well or remove .jsonl so SQLite tampering is tested directly
      fs.rmSync(ledgerPath, { force: true });

      assert.throws(
        () => loadAndVerifyPersistentLedger(ledgerPath),
        LedgerError,
        'Tampered SQLite ledger must fail closed with LedgerError'
      );

      // Verify tampered row was NOT overwritten
      const checkDb = new DatabaseSync(sqlitePath);
      const rows = checkDb
        .prepare(`SELECT payload_json FROM ledger_events ORDER BY idx ASC`)
        .all() as Array<{ payload_json: string }>;
      checkDb.close();
      assert.equal(rows.length, 4);
      assert.match(rows[2].payload_json, /999\.00/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('2a. Real Child-Process Crash between PayPal response, status change, and ledger entry rolls back uncommitted writes and locks in-flight states on restart without stale locks', () => {
    const tmpDir = makeTempDir('crash-recovery');
    const ledgerPath = path.join(tmpDir, 'crash_ledger.jsonl');
    const sqlitePath = `${ledgerPath}.sqlite`;

    try {
      loadAndVerifyPersistentLedger(ledgerPath);
      const { newEvent: receiptEvt } = appendEventPersistently(ledgerPath, {
        eventType: 'invoice_review',
        payload: {
          finding_codes: [],
          status: 'FIELDS_CONSISTENT',
          verified_amount_eur: '119.00',
          verified_currency: 'EUR',
        },
      });

      const store = new PersistentPaymentStore(ledgerPath);
      // Step A: Reserve receipt before calling PayPal (`RESERVED_ORDER`)
      store.reserveForOrderCreation({
        receiptHash: receiptEvt.event_hash,
        receiptIndex: receiptEvt.index,
        verifiedAmountEur: '119.00',
      });

      // Step B: Simulate a real child process that receives a PayPal response, begins the SQLite transaction,
      // updates `payment_records` to `ORDER_CREATED`, and then crashes (`process.exit(1)`) BEFORE inserting
      // the ledger event and BEFORE `COMMIT`.
      const crashScript = `
        import { DatabaseSync } from 'node:sqlite';
        const db = new DatabaseSync(${JSON.stringify(sqlitePath)});
        db.exec('BEGIN IMMEDIATE;');
        db.prepare("UPDATE payment_records SET state = 'ORDER_CREATED', order_id = 'SB-ORD-CRASH99' WHERE receipt_hash = ?").run(${JSON.stringify(receiptEvt.event_hash)});
        process.exit(1);
      `;
      const crashRes = spawnSync(process.execPath, ['--input-type=module', '-e', crashScript], {
        encoding: 'utf8',
      });
      assert.equal(crashRes.status, 1);

      // Step C: Verify no stale lock file blocks immediate access and SQLite rolled back the partial `ORDER_CREATED` update!
      const recAfterRollback = store.getRecord(receiptEvt.event_hash);
      assert.ok(recAfterRollback);
      assert.equal(
        recAfterRollback.state,
        'RESERVED_ORDER',
        'Uncommitted ORDER_CREATED update must be rolled back by SQLite after process exit'
      );
      assert.equal(recAfterRollback.order_id, null);

      const eventsBeforeRecovery = loadAndVerifyPersistentLedger(ledgerPath);
      assert.equal(eventsBeforeRecovery.length, 2, 'Ledger must still have exactly 2 events');

      // Step D: Simulate server restart recovery (`recoverInFlightRecordsOnStartup`).
      // Since the process crashed after reserving `RESERVED_ORDER` (so PayPal may or may not have created the order),
      // startup recovery must atomically transition the record to `UNKNOWN_RECONCILIATION_REQUIRED` and append
      // a `paypal_crash_recovery_lock` event to the ledger!
      const recovered = store.recoverInFlightRecordsOnStartup();
      assert.equal(recovered.length, 1);
      assert.equal(recovered[0].receipt_hash, receiptEvt.event_hash);
      assert.equal(recovered[0].state, 'UNKNOWN_RECONCILIATION_REQUIRED');

      const eventsAfterRecovery = loadAndVerifyPersistentLedger(ledgerPath);
      assert.equal(eventsAfterRecovery.length, 3);
      assert.equal(eventsAfterRecovery[2].event_type, 'paypal_crash_recovery_lock');

      // Automatic retry is now blocked until manual operator reconciliation
      assert.throws(
        () =>
          store.reserveForOrderCreation({
            receiptHash: receiptEvt.event_hash,
            receiptIndex: receiptEvt.index,
            verifiedAmountEur: '119.00',
          }),
        PaymentStateUnknownError
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('2b. Real Multi-Process Contention: Two parallel child processes racing on the same receipt allow exactly 1 reservation', async () => {
    const tmpDir = makeTempDir('mp-race');
    const ledgerPath = path.join(tmpDir, 'mp_race.jsonl');

    try {
      loadAndVerifyPersistentLedger(ledgerPath);
      const { newEvent: receiptEvt } = appendEventPersistently(ledgerPath, {
        eventType: 'invoice_review',
        payload: {
          finding_codes: [],
          status: 'FIELDS_CONSISTENT',
          verified_amount_eur: '119.00',
          verified_currency: 'EUR',
        },
      });

      const workerScript = `
        import { PersistentPaymentStore } from './src/kernel/persistentStore.ts';
        const store = new PersistentPaymentStore(process.env.TEST_LEDGER_PATH);
        try {
          store.reserveForOrderCreation({
            receiptHash: process.env.TEST_RECEIPT_HASH,
            receiptIndex: Number(process.env.TEST_RECEIPT_INDEX),
            verifiedAmountEur: '119.00'
          });
          console.log('RESERVED_WIN');
          process.exit(0);
        } catch (err) {
          console.log('BLOCKED:' + err.name);
          process.exit(2);
        }
      `;

      const spawnWorker = () =>
        new Promise<{ code: number | null; out: string }>((resolve) => {
          const child = spawn(
            process.execPath,
            ['--import', 'tsx', '--input-type=module', '-e', workerScript],
            {
              cwd: process.cwd(),
              env: {
                ...process.env,
                TEST_LEDGER_PATH: ledgerPath,
                TEST_RECEIPT_HASH: receiptEvt.event_hash,
                TEST_RECEIPT_INDEX: String(receiptEvt.index),
              },
            }
          );
          let out = '';
          child.stdout.on('data', (d) => {
            out += d.toString();
          });
          child.stderr.on('data', (d) => {
            out += d.toString();
          });
          child.on('close', (code) => resolve({ code, out: out.trim() }));
        });

      const [w1, w2] = await Promise.all([spawnWorker(), spawnWorker()]);
      const exitCodes = [w1.code, w2.code].sort();
      assert.deepEqual(
        exitCodes,
        [0, 2],
        `Expected exactly one child process to win (0) and one to be blocked (2), got: ${JSON.stringify([w1, w2])}`
      );
      const combinedOut = [w1.out, w2.out];
      assert.ok(combinedOut.some((s) => s.includes('RESERVED_WIN')));
      assert.ok(combinedOut.some((s) => s.includes('BLOCKED:PaymentConcurrencyError')));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('3. Unknown PayPal State (Timeout / 502) co-commits ledger event, blocks retries, and reconciles transactionally', async () => {
    const tmpDir = makeTempDir('unknown-state');
    const ledgerPath = path.join(tmpDir, 'unknown_ledger.jsonl');

    try {
      loadAndVerifyPersistentLedger(ledgerPath);
      const { newEvent: receiptEvt } = appendEventPersistently(ledgerPath, {
        eventType: 'invoice_review',
        payload: {
          finding_codes: [],
          status: 'FIELDS_CONSISTENT',
          verified_amount_eur: '119.00',
          verified_currency: 'EUR',
        },
      });

      const store = new PersistentPaymentStore(ledgerPath);
      const paypal = new PayPalSandboxManager();

      const resv = store.reserveForOrderCreation({
        receiptHash: receiptEvt.event_hash,
        receiptIndex: receiptEvt.index,
        verifiedAmountEur: '119.00',
      });
      const order = await paypal.createOrder(
        receiptEvt.event_hash,
        '119.00',
        {},
        resv.order_idempotency_key
      );
      store.confirmOrderCreated({
        receiptHash: receiptEvt.event_hash,
        orderId: order.id,
        approveUrl: order.approve_url,
        executionMode: order.execution_mode,
        appendLedgerEvent: true,
      });

      await paypal.verifyOrSimulateBuyerApproval(order.id, receiptEvt.event_hash, '119.00', {});
      store.confirmOrderApproved({
        receiptHash: receiptEvt.event_hash,
        orderId: order.id,
        appendLedgerEvent: true,
      });

      // Reserve for capture, then simulate a network timeout during PayPal capture POST
      store.reserveForCapture({
        receiptHash: receiptEvt.event_hash,
        orderId: order.id,
      });
      const unknownCommit = store.markUnknownReconciliationRequired(
        receiptEvt.event_hash,
        'PayPal sandbox network/timeout error: Simulated 504 Gateway Timeout',
        true
      );
      assert.equal(unknownCommit.record.state, 'UNKNOWN_RECONCILIATION_REQUIRED');
      assert.equal(unknownCommit.newEvent?.event_type, 'paypal_payment_state_unknown');

      // Retrying order creation or capture while in UNKNOWN state MUST throw PaymentStateUnknownError
      assert.throws(
        () =>
          store.reserveForOrderCreation({
            receiptHash: receiptEvt.event_hash,
            receiptIndex: receiptEvt.index,
            verifiedAmountEur: '119.00',
          }),
        PaymentStateUnknownError
      );
      assert.throws(
        () =>
          store.reserveForCapture({
            receiptHash: receiptEvt.event_hash,
            orderId: order.id,
          }),
        PaymentStateUnknownError
      );

      // Operator reconciles after checking PayPal Sandbox dashboard
      const reconciled = store.reconcileUnknownPayment({
        receiptHash: receiptEvt.event_hash,
        resolution: 'CONFIRM_CAPTURED',
        captureId: 'SB-CAP-RECONCILED01',
        operatorNote: 'Verified capture SB-CAP-RECONCILED01 in PayPal Sandbox dashboard',
        appendLedgerEvent: true,
      });
      assert.equal(reconciled.record.state, 'COMPLETED');
      assert.equal(reconciled.record.capture_id, 'SB-CAP-RECONCILED01');
      assert.equal(reconciled.newEvent?.event_type, 'paypal_manual_reconciliation');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('4. Strictly validates PayPal Order & Capture payloads (rejects wrong currency, wrong order ID, extra units/captures, missing custom_id)', () => {
    const validHash = 'a'.repeat(64);

    // 4a. Wrong currency (USD instead of EUR) -> rejected
    assert.throws(
      () =>
        verifyStrictPayPalOrderPayload(
          {
            id: 'SB-ORD-12345',
            status: 'CREATED',
            purchase_units: [
              {
                custom_id: validHash,
                amount: { currency_code: 'USD', value: '119.00' },
              },
            ],
          },
          {
            expectedOrderId: 'SB-ORD-12345',
            expectedStatus: 'CREATED',
            expectedReceiptHash: validHash,
            expectedAmountEur: '119.00',
          }
        ),
      /currency mismatch/
    );

    // 4b. Wrong order ID -> rejected
    assert.throws(
      () =>
        verifyStrictPayPalOrderPayload(
          {
            id: 'SB-ORD-WRONG99',
            status: 'APPROVED',
            purchase_units: [
              {
                custom_id: validHash,
                amount: { currency_code: 'EUR', value: '119.00' },
              },
            ],
          },
          {
            expectedOrderId: 'SB-ORD-12345',
            expectedStatus: 'APPROVED',
            expectedReceiptHash: validHash,
            expectedAmountEur: '119.00',
          }
        ),
      /order id mismatch/
    );

    // 4c. Extra purchase_units (2 instead of 1) -> rejected
    assert.throws(
      () =>
        verifyStrictPayPalOrderPayload(
          {
            id: 'SB-ORD-12345',
            status: 'CREATED',
            purchase_units: [
              { custom_id: validHash, amount: { currency_code: 'EUR', value: '119.00' } },
              { custom_id: validHash, amount: { currency_code: 'EUR', value: '10.00' } },
            ],
          },
          {
            expectedOrderId: 'SB-ORD-12345',
            expectedStatus: 'CREATED',
            expectedReceiptHash: validHash,
            expectedAmountEur: '119.00',
          }
        ),
      /exactly 1 purchase_unit/
    );

    // 4d. Missing custom_id on capture -> rejected (never substituted with expected value!)
    assert.throws(
      () =>
        verifyStrictPayPalCapturePayload(
          {
            id: 'SB-ORD-12345',
            status: 'COMPLETED',
            purchase_units: [
              {
                amount: { currency_code: 'EUR', value: '119.00' },
                payments: {
                  captures: [
                    {
                      id: 'SB-CAP-99999',
                      status: 'COMPLETED',
                      amount: { currency_code: 'EUR', value: '119.00' },
                    },
                  ],
                },
              },
            ],
          },
          {
            expectedOrderId: 'SB-ORD-12345',
            expectedReceiptHash: validHash,
            expectedAmountEur: '119.00',
          }
        ),
      /custom_id is missing or does not match/
    );

    // 4e. Extra captures (2 instead of 1) -> rejected
    assert.throws(
      () =>
        verifyStrictPayPalCapturePayload(
          {
            id: 'SB-ORD-12345',
            status: 'COMPLETED',
            purchase_units: [
              {
                custom_id: validHash,
                amount: { currency_code: 'EUR', value: '119.00' },
                payments: {
                  captures: [
                    {
                      id: 'SB-CAP-11111',
                      status: 'COMPLETED',
                      amount: { currency_code: 'EUR', value: '119.00' },
                    },
                    {
                      id: 'SB-CAP-22222',
                      status: 'COMPLETED',
                      amount: { currency_code: 'EUR', value: '119.00' },
                    },
                  ],
                },
              },
            ],
          },
          {
            expectedOrderId: 'SB-ORD-12345',
            expectedReceiptHash: validHash,
            expectedAmountEur: '119.00',
          }
        ),
      /exactly 1 capture record/
    );

    // 4f. PayPal live POST /capture placing custom_id on captures[0] (without outer unit custom_id) is accepted strictly
    const validCaptureWithCapCustomId = verifyStrictPayPalCapturePayload(
      {
        id: 'SB-ORD-12345',
        status: 'COMPLETED',
        purchase_units: [
          {
            payments: {
              captures: [
                {
                  id: '3ND85370G4181781M',
                  status: 'COMPLETED',
                  custom_id: validHash,
                  amount: { currency_code: 'EUR', value: '119.00' },
                },
              ],
            },
          },
        ],
      },
      {
        expectedOrderId: 'SB-ORD-12345',
        expectedReceiptHash: validHash,
        expectedAmountEur: '119.00',
      }
    );
    assert.equal(validCaptureWithCapCustomId.captureId, '3ND85370G4181781M');
    assert.equal(validCaptureWithCapCustomId.unit.custom_id, validHash);

    // 4g. Reject contradictory unit vs capture custom_id or unit vs capture amount
    const altHash = 'b'.repeat(64);
    assert.throws(
      () =>
        verifyStrictPayPalCapturePayload(
          {
            id: 'SB-ORD-12345',
            status: 'COMPLETED',
            purchase_units: [
              {
                custom_id: validHash,
                payments: {
                  captures: [
                    {
                      id: '3ND85370G4181781M',
                      status: 'COMPLETED',
                      custom_id: altHash,
                      amount: { currency_code: 'EUR', value: '119.00' },
                    },
                  ],
                },
              },
            ],
          },
          {
            expectedOrderId: 'SB-ORD-12345',
            expectedReceiptHash: validHash,
            expectedAmountEur: '119.00',
          }
        ),
      /custom_id is missing or does not match verified receipt_hash/
    );

    assert.throws(
      () =>
        verifyStrictPayPalCapturePayload(
          {
            id: 'SB-ORD-12345',
            status: 'COMPLETED',
            purchase_units: [
              {
                custom_id: validHash,
                amount: { currency_code: 'EUR', value: '99.00' },
                payments: {
                  captures: [
                    {
                      id: '3ND85370G4181781M',
                      status: 'COMPLETED',
                      amount: { currency_code: 'EUR', value: '119.00' },
                    },
                  ],
                },
              },
            ],
          },
          {
            expectedOrderId: 'SB-ORD-12345',
            expectedReceiptHash: validHash,
            expectedAmountEur: '119.00',
          }
        ),
      /purchase_unit\[0\] amount mismatch/
    );
  });

  it('4h. captureOrder validates POST /capture BEFORE authoritative GET fallback and rejects GET/POST contradictions fail-closed', async () => {
    const validHash = 'c'.repeat(64);
    const otherOrderId = 'SB-ORD-98765';
    const mgr = new PayPalSandboxManager({
      PAYPAL_CLIENT_ID: 'sb-mock-client-1234567890',
      PAYPAL_CLIENT_SECRET: 'sb-mock-secret-1234567890',
      PAYPAL_API_BASE: 'https://api-m.sandbox.paypal.com',
    });

    const originalFetch = globalThis.fetch;
    const jsonRes = (payload: unknown) =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });

    const approvedOrderPayload = {
      id: otherOrderId,
      status: 'APPROVED',
      purchase_units: [
        {
          custom_id: validHash,
          amount: { currency_code: 'EUR', value: '119.00' },
        },
      ],
    };

    try {
      // (i) POST /capture omits custom_id cleanly, GET /orders/{id} confirms matching custom_id & captureId -> succeeds
      let orderGetCount = 0;
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        if (url.endsWith('/v1/oauth2/token')) {
          return jsonRes({ access_token: 'mock-access-token' });
        }
        if (url.endsWith(`/v2/checkout/orders/${otherOrderId}`) && (init?.method ?? 'GET') === 'GET') {
          orderGetCount += 1;
          if (orderGetCount === 1) return jsonRes(approvedOrderPayload);
          return jsonRes({
            id: otherOrderId,
            status: 'COMPLETED',
            purchase_units: [
              {
                custom_id: validHash,
                amount: { currency_code: 'EUR', value: '119.00' },
                payments: {
                  captures: [
                    {
                      id: '3ND85370G4181781M',
                      status: 'COMPLETED',
                      amount: { currency_code: 'EUR', value: '119.00' },
                    },
                  ],
                },
              },
            ],
          });
        }
        if (url.endsWith(`/v2/checkout/orders/${otherOrderId}/capture`) && init?.method === 'POST') {
          return jsonRes({
            id: otherOrderId,
            status: 'COMPLETED',
            purchase_units: [
              {
                payments: {
                  captures: [
                    {
                      id: '3ND85370G4181781M',
                      status: 'COMPLETED',
                      amount: { currency_code: 'EUR', value: '119.00' },
                    },
                  ],
                },
              },
            ],
          });
        }
        throw new Error(`Unexpected fetch URL: ${url}`);
      }) as typeof fetch;

      const captured = await mgr.captureOrder(otherOrderId, validHash, '119.00');
      assert.equal(orderGetCount, 2);
      assert.equal(captured.status, 'COMPLETED');
      assert.equal(captured.purchase_units[0].custom_id, validHash);
      assert.equal(captured.purchase_units[0].payments?.captures?.[0]?.id, '3ND85370G4181781M');

      // (ii) POST /capture returns PENDING without custom_id -> MUST reject BEFORE post-capture GET runs
      orderGetCount = 0;
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        if (url.endsWith('/v1/oauth2/token')) return jsonRes({ access_token: 'mock-access-token' });
        if (url.endsWith(`/v2/checkout/orders/${otherOrderId}`) && (init?.method ?? 'GET') === 'GET') {
          orderGetCount += 1;
          return jsonRes(orderGetCount === 1 ? approvedOrderPayload : { id: otherOrderId, status: 'COMPLETED' });
        }
        if (url.endsWith(`/v2/checkout/orders/${otherOrderId}/capture`) && init?.method === 'POST') {
          return jsonRes({
            id: otherOrderId,
            status: 'PENDING',
            purchase_units: [
              {
                payments: {
                  captures: [
                    {
                      id: '3ND85370G4181781M',
                      status: 'COMPLETED',
                      amount: { currency_code: 'EUR', value: '119.00' },
                    },
                  ],
                },
              },
            ],
          });
        }
        throw new Error(`Unexpected fetch URL: ${url}`);
      }) as typeof fetch;

      await assert.rejects(
        () => mgr.captureOrder(otherOrderId, validHash, '119.00'),
        /Capture response status is not COMPLETED/
      );
      assert.equal(orderGetCount, 1);

      // (iii) POST /capture has CAP-1, GET /orders/{id} has CAP-2 -> rejects fail-closed with isAmbiguous = true
      orderGetCount = 0;
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        if (url.endsWith('/v1/oauth2/token')) return jsonRes({ access_token: 'mock-access-token' });
        if (url.endsWith(`/v2/checkout/orders/${otherOrderId}`) && (init?.method ?? 'GET') === 'GET') {
          orderGetCount += 1;
          if (orderGetCount === 1) return jsonRes(approvedOrderPayload);
          return jsonRes({
            id: otherOrderId,
            status: 'COMPLETED',
            purchase_units: [
              {
                custom_id: validHash,
                amount: { currency_code: 'EUR', value: '119.00' },
                payments: {
                  captures: [
                    {
                      id: '9XY85370G4181782N',
                      status: 'COMPLETED',
                      amount: { currency_code: 'EUR', value: '119.00' },
                    },
                  ],
                },
              },
            ],
          });
        }
        if (url.endsWith(`/v2/checkout/orders/${otherOrderId}/capture`) && init?.method === 'POST') {
          return jsonRes({
            id: otherOrderId,
            status: 'COMPLETED',
            purchase_units: [
              {
                payments: {
                  captures: [
                    {
                      id: '3ND85370G4181781M',
                      status: 'COMPLETED',
                      amount: { currency_code: 'EUR', value: '119.00' },
                    },
                  ],
                },
              },
            ],
          });
        }
        throw new Error(`Unexpected fetch URL: ${url}`);
      }) as typeof fetch;

      await assert.rejects(
        () => mgr.captureOrder(otherOrderId, validHash, '119.00'),
        (err: unknown) =>
          err instanceof PayPalSandboxError &&
          err.isAmbiguousNetworkState === true &&
          /reconciliation mismatch/.test(err.message)
      );

      // (iv) Both POST /capture and GET /orders/{id} omit custom_id -> rejects fail-closed with isAmbiguous = true
      orderGetCount = 0;
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        if (url.endsWith('/v1/oauth2/token')) return jsonRes({ access_token: 'mock-access-token' });
        if (url.endsWith(`/v2/checkout/orders/${otherOrderId}`) && (init?.method ?? 'GET') === 'GET') {
          orderGetCount += 1;
          if (orderGetCount === 1) return jsonRes(approvedOrderPayload);
          return jsonRes({
            id: otherOrderId,
            status: 'COMPLETED',
            purchase_units: [
              {
                amount: { currency_code: 'EUR', value: '119.00' },
                payments: {
                  captures: [
                    {
                      id: '3ND85370G4181781M',
                      status: 'COMPLETED',
                      amount: { currency_code: 'EUR', value: '119.00' },
                    },
                  ],
                },
              },
            ],
          });
        }
        if (url.endsWith(`/v2/checkout/orders/${otherOrderId}/capture`) && init?.method === 'POST') {
          return jsonRes({
            id: otherOrderId,
            status: 'COMPLETED',
            purchase_units: [
              {
                payments: {
                  captures: [
                    {
                      id: '3ND85370G4181781M',
                      status: 'COMPLETED',
                      amount: { currency_code: 'EUR', value: '119.00' },
                    },
                  ],
                },
              },
            ],
          });
        }
        throw new Error(`Unexpected fetch URL: ${url}`);
      }) as typeof fetch;

      await assert.rejects(
        () => mgr.captureOrder(otherOrderId, validHash, '119.00'),
        (err: unknown) =>
          err instanceof PayPalSandboxError &&
          err.isAmbiguousNetworkState === true &&
          /custom_id is missing or does not match verified receipt_hash/.test(err.message)
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('5. Exact Host & Origin Verification rejects arbitrary *.run.app, wrong scheme, and wrong port, allowing only exact configured matches', () => {
    // 5a. Arbitrary *.run.app host/origin MUST be rejected when no trustedAppUrl is configured
    const unconfiguredRunApp = verifyExactHostAndOrigin(
      { host: 'arbitrary-attacker.run.app', origin: 'https://arbitrary-attacker.run.app' },
      { expectedLocalPort: 3000, trustedAppUrl: '' }
    );
    assert.equal(unconfiguredRunApp.ok, false);

    // 5b. Wrong port in Origin (http://127.0.0.1:9999 against port 3000) MUST be rejected
    const wrongPort = verifyExactHostAndOrigin(
      { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:9999' },
      { expectedLocalPort: 3000, trustedAppUrl: '' }
    );
    assert.equal(wrongPort.ok, false);

    // 5c. Wrong scheme in Origin (https://127.0.0.1:3000 against local http server) MUST be rejected
    const wrongScheme = verifyExactHostAndOrigin(
      { host: '127.0.0.1:3000', origin: 'https://127.0.0.1:3000' },
      { expectedLocalPort: 3000, trustedAppUrl: '' }
    );
    assert.equal(wrongScheme.ok, false);

    // 5d. Exact local match (http://127.0.0.1:3000 + Host: 127.0.0.1:3000) is allowed
    const exactLocal = verifyExactHostAndOrigin(
      { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000' },
      { expectedLocalPort: 3000, trustedAppUrl: '' }
    );
    assert.equal(exactLocal.ok, true);

    // 5e. Explicitly configured trustedAppUrl allows ONLY that exact origin & host, and rejects any other *.run.app
    const trustedCloud = verifyExactHostAndOrigin(
      {
        host: 'syntra-official-preview.run.app',
        origin: 'https://syntra-official-preview.run.app',
      },
      {
        expectedLocalPort: 3000,
        trustedAppUrl: 'https://syntra-official-preview.run.app',
      }
    );
    assert.equal(trustedCloud.ok, true);

    const otherRunApp = verifyExactHostAndOrigin(
      {
        host: 'syntra-official-preview.run.app',
        origin: 'https://other-untrusted-preview.run.app',
      },
      {
        expectedLocalPort: 3000,
        trustedAppUrl: 'https://syntra-official-preview.run.app',
      }
    );
    assert.equal(otherRunApp.ok, false);
  });

  it('6. HTTP Integration: End-to-End Lifecycle, Origin/Port/Scheme/Run.app Rejection, Simulated Timeout -> Reconcile -> Capture, and Isolated Red-Team Suite', async () => {
    const tmpDir = makeTempDir('http-e2e');
    const ledgerPath = path.join(tmpDir, 'http_e2e.jsonl');

    let simulateCaptureTimeout = false;
    class FaultInjectablePayPalManager extends PayPalSandboxManager {
      constructor() {
        super({ PAYPAL_API_BASE: 'https://api-m.sandbox.paypal.com' });
      }

      public override async captureOrder(
        orderId: string,
        receiptHash: string,
        expectedVerifiedAmountEur: string,
        env?: Record<string, string | undefined>,
        idempotencyKey?: string
      ) {
        if (simulateCaptureTimeout) {
          throw new PayPalSandboxError(
            'Simulated HTTP 504 Gateway Timeout from PayPal Sandbox during capture',
            true
          );
        }
        return super.captureOrder(
          orderId,
          receiptHash,
          expectedVerifiedAmountEur,
          env,
          idempotencyKey
        );
      }
    }

    const app = createConfiguredExpressApp(
      ledgerPath,
      new FaultInjectablePayPalManager(),
      { trustedAppUrl: '' }
    );
    const server: Server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });

    try {
      const addr = server.address() as AddressInfo;
      const baseUrl = `http://127.0.0.1:${addr.port}`;

      // A. Cross-origin request from untrusted domain MUST be rejected with HTTP 403
      const badOriginRes = await fetch(`${baseUrl}/api/review`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://evil-attacker.example',
        },
        body: JSON.stringify({}),
      });
      assert.equal(badOriginRes.status, 403);

      // B. Arbitrary *.run.app Origin MUST be rejected with HTTP 403
      const badRunAppRes = await fetch(`${baseUrl}/api/review`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://random-applet-123.run.app',
        },
        body: JSON.stringify({}),
      });
      assert.equal(badRunAppRes.status, 403);

      // C. Wrong port in Origin header MUST be rejected with HTTP 403
      const badPortRes = await fetch(`${baseUrl}/api/review`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'http://127.0.0.1:65432',
        },
        body: JSON.stringify({}),
      });
      assert.equal(badPortRes.status, 403);

      // D. Wrong scheme in Origin header MUST be rejected with HTTP 403
      const badSchemeRes = await fetch(`${baseUrl}/api/review`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: `https://127.0.0.1:${addr.port}`,
        },
        body: JSON.stringify({}),
      });
      assert.equal(badSchemeRes.status, 403);

      // E. Valid Review -> Seals receipt in SQLite
      const revRes = await fetch(`${baseUrl}/api/review`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: baseUrl,
        },
        body: JSON.stringify({
          expected_vendor: 'Beispieltechnik GmbH',
          vendor: 'Beispieltechnik GmbH',
          expected_amount: '119.00',
          amount: '119.00',
          net_amount: '100.00',
          tax_amount: '19.00',
          gross_amount: '119.00',
          invoice_number: 'R-1042',
        }),
      });
      assert.equal(revRes.status, 200);
      const revData = (await revRes.json()) as {
        status: string;
        receipt: { index: number; event_hash: string; verified_amount_eur: string };
      };
      assert.equal(revData.status, 'FIELDS_CONSISTENT');

      // F. Create Order -> Co-commits ORDER_CREATED + paypal_sandbox_order
      const orderRes = await fetch(`${baseUrl}/api/paypal/order`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: baseUrl },
        body: JSON.stringify({
          receipt: {
            index: revData.receipt.index,
            event_hash: revData.receipt.event_hash,
          },
          requested_amount_eur: '119.00',
        }),
      });
      assert.equal(orderRes.status, 200);
      const orderData = (await orderRes.json()) as { id: string; status: string };
      assert.equal(orderData.status, 'CREATED');

      // G. Duplicate Order creation for the same receipt MUST return HTTP 409
      const dupOrderRes = await fetch(`${baseUrl}/api/paypal/order`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: baseUrl },
        body: JSON.stringify({
          receipt: {
            index: revData.receipt.index,
            event_hash: revData.receipt.event_hash,
          },
          requested_amount_eur: '119.00',
        }),
      });
      assert.equal(dupOrderRes.status, 409);

      // H. Approve Order -> Co-commits ORDER_APPROVED + paypal_sandbox_approval
      const approveRes = await fetch(`${baseUrl}/api/paypal/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: baseUrl },
        body: JSON.stringify({
          receipt: {
            index: revData.receipt.index,
            event_hash: revData.receipt.event_hash,
          },
          order_id: orderData.id,
        }),
      });
      assert.equal(approveRes.status, 200);

      // I. Simulate PayPal Gateway Timeout during Capture -> HTTP 502 + UNKNOWN_RECONCILIATION_REQUIRED
      simulateCaptureTimeout = true;
      const timeoutCapRes = await fetch(`${baseUrl}/api/paypal/capture`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: baseUrl },
        body: JSON.stringify({
          receipt: {
            index: revData.receipt.index,
            event_hash: revData.receipt.event_hash,
          },
          order_id: orderData.id,
        }),
      });
      assert.equal(timeoutCapRes.status, 502);

      // J. Retrying Capture while in UNKNOWN_RECONCILIATION_REQUIRED MUST be blocked with HTTP 409
      simulateCaptureTimeout = false;
      const blockedCapRes = await fetch(`${baseUrl}/api/paypal/capture`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: baseUrl },
        body: JSON.stringify({
          receipt: {
            index: revData.receipt.index,
            event_hash: revData.receipt.event_hash,
          },
          order_id: orderData.id,
        }),
      });
      assert.equal(blockedCapRes.status, 409);

      // K. Manual Reconciliation via POST /api/paypal/reconcile
      const reconcileRes = await fetch(`${baseUrl}/api/paypal/reconcile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: baseUrl },
        body: JSON.stringify({
          receipt_hash: revData.receipt.event_hash,
          resolution: 'CONFIRM_CAPTURED',
          capture_id: 'SB-CAP-HTTPRECON01',
          operator_note: 'Confirmed capture in PayPal Sandbox merchant portal after timeout.',
        }),
      });
      assert.equal(reconcileRes.status, 200);

      // L. Isolated Red-Team endpoint runs without modifying the main ledger
      const ledgerBeforeRedTeam = loadAndVerifyPersistentLedger(ledgerPath);
      const rtRes = await fetch(`${baseUrl}/api/redteam/isolated`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: baseUrl },
      });
      assert.equal(rtRes.status, 200);
      const rtData = (await rtRes.json()) as {
        isolated_execution: boolean;
        external_api_calls_made: number;
        main_ledger_modified: boolean;
        results: Array<{ blocked: boolean }>;
      };
      assert.equal(rtData.isolated_execution, true);
      assert.equal(rtData.external_api_calls_made, 0);
      assert.equal(rtData.main_ledger_modified, false);
      assert.equal(rtData.results.length, 4);
      assert.ok(rtData.results.every((r) => r.blocked));

      const ledgerAfterRedTeam = loadAndVerifyPersistentLedger(ledgerPath);
      assert.equal(
        ledgerAfterRedTeam.length,
        ledgerBeforeRedTeam.length,
        'Isolated Red-Team suite must not append to the main ledger'
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('8. Uses os.tmpdir() default ledger path and enforces single-instance server lock per database', () => {
    const tmpDir = makeTempDir('single-lock');
    const prevEnvLedger = process.env.SYNTRA_DEMO_LEDGER;
    const ledgerPath = path.join(tmpDir, 'audit_ledger.jsonl');
    const lockPath = `${resolveSqliteDbPath(ledgerPath)}.server.pid`;

    try {
      delete process.env.SYNTRA_DEMO_LEDGER;
      const resolvedDefault = getLedgerFilePath();
      assert.equal(resolvedDefault, path.join(os.tmpdir(), 'syntravariga_paypal_demo.jsonl'));

      process.env.SYNTRA_DEMO_LEDGER = ledgerPath;
      assert.equal(getLedgerFilePath(), ledgerPath);

      // Acquire lock as live process -> second acquire must fail explicitly
      const release = acquireSingleInstanceServerLock(ledgerPath);
      assert.ok(fs.existsSync(lockPath), 'Lockfile must be written on acquire');

      assert.throws(
        () => acquireSingleInstanceServerLock(ledgerPath),
        /Single-instance database lock active/
      );

      release();
      assert.ok(!fs.existsSync(lockPath), 'Lockfile must be removed on release');

      // Stale lockfile from non-existent PID recovers cleanly
      fs.writeFileSync(lockPath, '99999999\n', 'utf8');
      const releaseRecovered = acquireSingleInstanceServerLock(ledgerPath);
      assert.equal(fs.readFileSync(lockPath, 'utf8').trim(), String(process.pid));
      releaseRecovered();
    } finally {
      if (prevEnvLedger === undefined) {
        delete process.env.SYNTRA_DEMO_LEDGER;
      } else {
        process.env.SYNTRA_DEMO_LEDGER = prevEnvLedger;
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('9. Single-pass loadVerifiedLedgerSnapshot returns verified report & persisted payment records cleanly', () => {
    const tmpDir = makeTempDir('snapshot');
    const ledgerPath = path.join(tmpDir, 'audit_ledger.jsonl');

    try {
      const bootSnap = loadVerifiedLedgerSnapshot(ledgerPath);
      assert.equal(bootSnap.events.length, 1);
      assert.equal(bootSnap.report.status, 'PASS');
      assert.deepEqual(bootSnap.paymentRecords, {});

      const { newEvent: rev } = appendEventPersistently(ledgerPath, {
        eventType: 'invoice_review',
        payload: {
          finding_codes: [],
          status: 'FIELDS_CONSISTENT',
          verified_amount_eur: '119.00',
          verified_currency: 'EUR',
        },
      });

      const store = new PersistentPaymentStore(ledgerPath);
      store.reserveForOrderCreation({
        receiptHash: rev.event_hash,
        receiptIndex: rev.index,
        verifiedAmountEur: '119.00',
      });
      const committed = store.confirmOrderCreated({
        receiptHash: rev.event_hash,
        orderId: 'SB-ORD-SNAP01',
        approveUrl: 'https://www.sandbox.paypal.com/checkoutnow?token=SB-ORD-SNAP01',
        executionMode: 'SANDBOX_PROTOCOL_SIMULATION',
        appendLedgerEvent: true,
      });

      assert.equal(committed.report?.status, 'PASS');
      assert.equal(committed.paymentRecords?.[rev.event_hash]?.order_id, 'SB-ORD-SNAP01');

      const snapAfter = loadVerifiedLedgerSnapshot(ledgerPath);
      assert.equal(snapAfter.events.length, 3);
      assert.equal(snapAfter.report.status, 'PASS');
      assert.equal(snapAfter.paymentRecords[rev.event_hash]?.state, 'ORDER_CREATED');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('10. hasValidGeminiApiKey and resolveGeminiModelSequence support AIza*/AQ.* keys and deduplicated Flash fallbacks', () => {
    assert.equal(hasValidGeminiApiKey({ GEMINI_API_KEY: '' }), false);
    assert.equal(hasValidGeminiApiKey({ GEMINI_API_KEY: 'MY_GEMINI_API_KEY' }), false);
    assert.equal(hasValidGeminiApiKey({ GEMINI_API_KEY: 'AIzaShortKey' }), false);
    assert.equal(hasValidGeminiApiKey({ GEMINI_API_KEY: 'AQ.short' }), false);
    assert.equal(hasValidGeminiApiKey({ GEMINI_API_KEY: 'AIza' + 'x'.repeat(35) }), true);
    assert.equal(hasValidGeminiApiKey({ GEMINI_API_KEY: 'AQ.' + 'Ab8R'.repeat(12) }), true);
    assert.equal(hasValidGeminiApiKey({ GEMINI_API_KEY: 'AQ.' + 'x'.repeat(30) + ' oops' }), false);

    assert.deepEqual(
      resolveGeminiModelSequence('gemini-3.8-flash', 'gemini-3.5-flash, gemini-3.8-flash'),
      ['gemini-3.8-flash', 'gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite']
    );
  });
});
