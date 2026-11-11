import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GENESIS_HASH,
  appendEvent,
  verifyLedgerEvents,
  verifyLedgerPrefix,
  verifyReceiptForOrder,
  LedgerEvent,
  LedgerError,
} from './ledger';

test('empty ledger verifies with PASS, count 0, and GENESIS_HASH', () => {
  const report = verifyLedgerEvents([]);
  assert.equal(report.status, 'PASS');
  assert.equal(report.event_count, 0);
  assert.equal(report.head_hash, GENESIS_HASH);
  assert.equal(report.errors.length, 0);
});

test('appendEvent creates chained events with valid previous_hash and sha256', () => {
  let events: LedgerEvent[] = [];
  const res1 = appendEvent(events, {
    eventType: 'invoice_review',
    timestamp: '2026-11-11T12:00:00Z',
    payload: { status: 'FIELDS_CONSISTENT', finding_codes: [] },
  });
  events = res1.updatedEvents;

  assert.equal(res1.newEvent.index, 1);
  assert.equal(res1.newEvent.event_id, 'EVT-00000001');
  assert.equal(res1.newEvent.previous_hash, GENESIS_HASH);

  const res2 = appendEvent(events, {
    eventType: 'quant_risk_eval',
    timestamp: '2026-11-11T12:01:00Z',
    payload: { sharpe_ratio: 2.14, var_95: -0.018 },
  });
  events = res2.updatedEvents;

  assert.equal(res2.newEvent.index, 2);
  assert.equal(res2.newEvent.event_id, 'EVT-00000002');
  assert.equal(res2.newEvent.previous_hash, res1.newEvent.event_hash);

  const report = verifyLedgerEvents(events);
  assert.equal(report.status, 'PASS');
  assert.equal(report.event_count, 2);
  assert.equal(report.head_hash, res2.newEvent.event_hash);
});

test('tampering with a payload, hash chain, or index reordering causes immediate verification failure', () => {
  let events: LedgerEvent[] = [];
  const r1 = appendEvent(events, {
    eventType: 'evt1',
    payload: { test: 123 },
  });
  const r2 = appendEvent(r1.updatedEvents, {
    eventType: 'evt2',
    payload: { test: 456 },
  });
  events = r2.updatedEvents;

  // 1. Tamper with payload of first event without updating hash
  const tamperedPayload = JSON.parse(JSON.stringify(events)) as LedgerEvent[];
  tamperedPayload[0].payload = { test: 999 };
  const failReport1 = verifyLedgerEvents(tamperedPayload);
  assert.equal(failReport1.status, 'FAIL');
  assert.ok(failReport1.errors.some((e) => e.includes('payload_sha256 mismatch')));

  // 2. Tamper with previous_hash of second event
  const tamperedChain = JSON.parse(JSON.stringify(events)) as LedgerEvent[];
  tamperedChain[1].previous_hash = '1'.repeat(64);
  const failReport2 = verifyLedgerEvents(tamperedChain);
  assert.equal(failReport2.status, 'FAIL');
  assert.ok(failReport2.errors.some((e) => e.includes('previous_hash mismatch')));

  // 3. Reordering or deleting first block breaks index, event_id, and previous_hash
  const deletedFirst = [events[1]];
  const failReport3 = verifyLedgerEvents(deletedFirst);
  assert.equal(failReport3.status, 'FAIL');
  assert.ok(failReport3.errors.some((e) => e.includes('index mismatch')));
  assert.ok(failReport3.errors.some((e) => e.includes('event_id mismatch')));
  assert.ok(failReport3.errors.some((e) => e.includes('previous_hash mismatch')));
});

test('appendEvent refuses to append to a corrupted ledger and recursively blocks nested & case-varied PII fields', () => {
  const r1 = appendEvent([], {
    eventType: 'invoice_review',
    payload: { status: 'FIELDS_CONSISTENT', finding_codes: [] },
  });
  const corrupted = JSON.parse(JSON.stringify(r1.updatedEvents)) as LedgerEvent[];
  corrupted[0].payload = { status: 'TAMPERED' };

  assert.throws(
    () =>
      appendEvent(corrupted, {
        eventType: 'next_event',
        payload: { ok: true },
      }),
    LedgerError
  );

  // Top-level PII
  assert.throws(
    () =>
      appendEvent([], {
        eventType: 'invoice_review',
        payload: { vendor: 'Secret Supplier GmbH' },
      }),
    /privacy violation/
  );

  // Case-insensitive PII: { Vendor: "ACME" }
  assert.throws(
    () =>
      appendEvent([], {
        eventType: 'invoice_review',
        payload: { Vendor: 'ACME' },
      }),
    /privacy violation/
  );

  // Nested object PII: { inner: { vendor: "ACME" } }
  assert.throws(
    () =>
      appendEvent([], {
        eventType: 'invoice_review',
        payload: { inner: { vendor: 'ACME' } },
      }),
    /privacy violation/
  );

  // Deep array-nested separator-varied PII: { items: [{ "expected-vendor": "ACME" }] }
  assert.throws(
    () =>
      appendEvent([], {
        eventType: 'invoice_review',
        payload: { items: [{ 'expected-vendor': 'ACME' }] },
      }),
    /privacy violation/
  );
});

test('verifyReceiptForOrder enforces receipt hash parity and FIELDS_CONSISTENT status', () => {
  const r1 = appendEvent([], {
    eventType: 'invoice_review',
    payload: { status: 'FIELDS_CONSISTENT', finding_codes: [] },
  });
  const r2 = appendEvent(r1.updatedEvents, {
    eventType: 'invoice_review',
    payload: { status: 'REVIEW_REQUIRED', finding_codes: ['VENDOR_MISMATCH'] },
  });
  const events = r2.updatedEvents;

  // Valid consistent receipt succeeds
  const verifiedEvt = verifyReceiptForOrder(events, {
    index: 1,
    event_hash: r1.newEvent.event_hash,
  });
  assert.equal(verifiedEvt.event_id, 'EVT-00000001');

  // Receipt pointing to REVIEW_REQUIRED event fails closed
  assert.throws(
    () =>
      verifyReceiptForOrder(events, {
        index: 2,
        event_hash: r2.newEvent.event_hash,
      }),
    /invoice review is not consistent/
  );

  // Forged hash fails closed
  assert.throws(
    () =>
      verifyReceiptForOrder(events, {
        index: 1,
        event_hash: 'a'.repeat(64),
      }),
    /invalid receipt or corrupted ledger/
  );
});

test('verifyLedgerPrefix enforces reproducible bundle commitment', () => {
  let events: LedgerEvent[] = [];
  const r1 = appendEvent(events, { eventType: 'evt1', payload: { a: 1 } });
  const r2 = appendEvent(r1.updatedEvents, { eventType: 'evt2', payload: { b: 2 } });
  events = r2.updatedEvents;

  // Valid prefix
  assert.doesNotThrow(() => {
    verifyLedgerPrefix(events, {
      event_count: 1,
      head_hash: r1.newEvent.event_hash,
    });
  });

  // Invalid hash
  assert.throws(() => {
    verifyLedgerPrefix(events, {
      event_count: 1,
      head_hash: 'f'.repeat(64),
    });
  });
});

test('prevents receipt replay (double-spend), enforces verified_amount_eur without fallback, and blocks client receipt forgery', async () => {
  const {
    assertReceiptNotConsumed,
    extractVerifiedAmountFromReceiptEvent,
    assertAllowedClientEventType,
  } = await import('./ledger');

  // 1. Client cannot forge invoice_review or paypal_sandbox_order via client append allowlist
  assert.equal(assertAllowedClientEventType('quant_risk_eval'), 'quant_risk_eval');
  assert.throws(
    () => assertAllowedClientEventType('invoice_review'),
    /forbidden client event_type/
  );
  assert.throws(
    () => assertAllowedClientEventType('paypal_sandbox_order'),
    /forbidden client event_type/
  );

  // 2. extractVerifiedAmountFromReceiptEvent rejects receipts missing verified_amount_eur (no magic fallback)
  const noAmountEvt = appendEvent([], {
    eventType: 'invoice_review',
    payload: { status: 'FIELDS_CONSISTENT', finding_codes: [] },
  }).newEvent;
  assert.throws(
    () => extractVerifiedAmountFromReceiptEvent(noAmountEvt),
    /does not contain a valid positive verified_amount_eur/
  );

  const validAmountRes = appendEvent([], {
    eventType: 'invoice_review',
    payload: {
      status: 'FIELDS_CONSISTENT',
      finding_codes: [],
      verified_amount_eur: '119.00',
    },
  });
  assert.equal(extractVerifiedAmountFromReceiptEvent(validAmountRes.newEvent), '119.00');

  // 3. First order creation is allowed; second attempt with the same receipt_hash is blocked (anti-replay)
  assert.doesNotThrow(() =>
    assertReceiptNotConsumed(validAmountRes.updatedEvents, validAmountRes.newEvent.event_hash)
  );

  const afterOrder = appendEvent(validAmountRes.updatedEvents, {
    eventType: 'paypal_sandbox_order',
    payload: {
      receipt_hash: validAmountRes.newEvent.event_hash,
      order_id: 'SB-ORD-123456',
      paypal_status: 'CREATED',
    },
  });

  assert.throws(
    () => assertReceiptNotConsumed(afterOrder.updatedEvents, validAmountRes.newEvent.event_hash),
    /receipt replay blocked/
  );
});
