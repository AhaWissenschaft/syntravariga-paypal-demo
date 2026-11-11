/**
 * @license
 * SyntraVariga / AhaWissenschaft Research Framework
 * Module: Cryptographic Audit Ledger (Tamper-Evident Hash-Chained Journal)
 *
 * Why this file exists:
 * Provides an append-only, tamper-evident event ledger.
 * Every event is linked via SHA-256 to the previous event's hash, forming
 * a verifiable hash chain starting from GENESIS_HASH = "0"*64.
 *
 * Scope & Security Boundaries:
 * - Tamper-evident (not magically immutable): modifying any historical entry invalidates
 *   its payload_sha256, event_hash, or subsequent previous_hash links upon verification.
 * - Anyone with full write access to the storage medium can recompute the entire chain from
 *   Genesis unless the latest head_hash is preserved or anchored externally.
 * - Enforces recursive, case-insensitive, normalized PII key blocking across all nested objects
 *   and arrays so raw invoice fields (vendor, invoice_number, iban, etc.) cannot be smuggled in.
 */

import { sha256Canonical } from './crypto';
import { LabContractError, SHA256_RE } from './contracts';

export const LEDGER_SCHEMA = 'aha.lab.ledger-event.v1';
export const GENESIS_HASH = '0'.repeat(64);

export class LedgerError extends LabContractError {
  constructor(message: string) {
    super(message);
    this.name = 'LedgerError';
  }
}

export interface LedgerEvent<T = Record<string, unknown>> {
  schema: typeof LEDGER_SCHEMA;
  index: number;
  event_id: string;
  event_type: string;
  timestamp: string;
  previous_hash: string;
  payload_sha256: string;
  payload: T;
  event_hash: string;
}

export interface LedgerVerificationReport {
  status: 'PASS' | 'FAIL';
  event_count: number;
  head_hash: string;
  event_hashes: string[];
  errors: string[];
}

/**
 * Normalized (lowercase, alphanumeric-only) set of forbidden PII / raw document keys.
 * E.g. "Vendor", "expected-vendor", "expected_vendor", "INVOICE_NUMBER" all normalize
 * into this set and are rejected at any nesting depth.
 */
const FORBIDDEN_NORMALIZED_KEYS = new Set([
  'vendor',
  'expectedvendor',
  'invoicenumber',
  'rawinvoice',
  'supplier',
  'expectedsupplier',
  'customername',
  'iban',
  'bic',
  'taxid',
  'vatid',
]);

function normalizeKey(key: string): string {
  return key.normalize('NFKC').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Recursively inspects an arbitrary payload (objects and arrays at any depth)
 * and throws LedgerError if any key matches a forbidden PII field.
 */
export function assertNoForbiddenPiiKeys(value: unknown, path = 'payload'): void {
  if (!value || typeof value !== 'object') {
    return;
  }

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      assertNoForbiddenPiiKeys(value[i], `${path}[${i}]`);
    }
    return;
  }

  for (const [key, childVal] of Object.entries(value as Record<string, unknown>)) {
    const norm = normalizeKey(key);
    if (FORBIDDEN_NORMALIZED_KEYS.has(norm)) {
      throw new LedgerError(
        `privacy violation: raw field '${key}' at '${path}.${key}' is forbidden in ledger payload`
      );
    }
    assertNoForbiddenPiiKeys(childVal, `${path}.${key}`);
  }
}

export type CanonicalHasher = (value: unknown) => string;

/**
 * Validates the cryptographic integrity of an array of ledger events.
 */
export function verifyLedgerEvents(
  events: LedgerEvent[],
  hashFn: CanonicalHasher = sha256Canonical
): LedgerVerificationReport {
  const errors: string[] = [];
  const hashes: string[] = [];
  let previousHash = GENESIS_HASH;

  for (let i = 0; i < events.length; i++) {
    const expectedIndex = i + 1;
    const event = events[i];

    if (!event || typeof event !== 'object') {
      errors.push(`event ${expectedIndex}: null or invalid object`);
      continue;
    }

    if (event.schema !== LEDGER_SCHEMA) {
      errors.push(`event ${expectedIndex}: invalid schema`);
    }

    if (event.index !== expectedIndex) {
      errors.push(`event ${expectedIndex}: index mismatch`);
    }

    const expectedId = `EVT-${String(expectedIndex).padStart(8, '0')}`;
    if (event.event_id !== expectedId) {
      errors.push(`event ${expectedIndex}: event_id mismatch`);
    }

    if (!event.event_type || typeof event.event_type !== 'string' || !event.event_type.trim()) {
      errors.push(`event ${expectedIndex}: invalid event_type`);
    }

    if (!event.timestamp || typeof event.timestamp !== 'string' || !event.timestamp.trim()) {
      errors.push(`event ${expectedIndex}: invalid timestamp`);
    }

    if (event.previous_hash !== previousHash) {
      errors.push(`event ${expectedIndex}: previous_hash mismatch`);
    }

    let payload = event.payload as Record<string, unknown>;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      errors.push(`event ${expectedIndex}: payload is not object`);
      payload = {};
    }

    const computedPayloadHash = hashFn(payload);
    if (event.payload_sha256 !== computedPayloadHash) {
      errors.push(`event ${expectedIndex}: payload_sha256 mismatch`);
    }

    let claimedEventHash = event.event_hash;
    if (typeof claimedEventHash !== 'string' || !SHA256_RE.test(claimedEventHash)) {
      errors.push(`event ${expectedIndex}: invalid event_hash`);
      claimedEventHash = '';
    }

    const unsigned = JSON.parse(JSON.stringify(event)) as Record<string, unknown>;
    delete unsigned.event_hash;
    const computedEventHash = hashFn(unsigned);

    if (claimedEventHash !== computedEventHash) {
      errors.push(`event ${expectedIndex}: event_hash mismatch`);
    }

    previousHash = claimedEventHash || computedEventHash;
    hashes.push(previousHash);
  }

  return {
    status: errors.length === 0 ? 'PASS' : 'FAIL',
    event_count: events.length,
    head_hash: hashes.length > 0 ? hashes[hashes.length - 1] : GENESIS_HASH,
    event_hashes: hashes,
    errors,
  };
}

/**
 * Creates a new unsigned event, calculates payload SHA-256 and event SHA-256,
 * and appends it to the given ledger events array after verifying integrity
 * and recursive PII key absence.
 */
export function appendEvent<T extends Record<string, unknown>>(
  existingEvents: LedgerEvent[],
  params: {
    eventType: string;
    timestamp?: string;
    payload: T;
  },
  hashFn: CanonicalHasher = sha256Canonical
): { updatedEvents: LedgerEvent[]; newEvent: LedgerEvent<T> } {
  const report = verifyLedgerEvents(existingEvents, hashFn);
  if (report.status !== 'PASS') {
    throw new LedgerError(`cannot append to invalid ledger: ${report.errors.join('; ')}`);
  }

  const { eventType, payload } = params;
  if (!eventType || typeof eventType !== 'string' || !eventType.trim()) {
    throw new LedgerError('event_type must be non-empty string');
  }
  const timestamp = params.timestamp !== undefined ? params.timestamp : new Date().toISOString();
  if (typeof timestamp !== 'string' || !timestamp.trim()) {
    throw new LedgerError('timestamp must be non-empty string');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new LedgerError('ledger payload must be object');
  }

  // Deep recursive, case-insensitive, separator-normalized PII key blocker
  assertNoForbiddenPiiKeys(payload);

  const index = report.event_count + 1;
  const previousHash = report.event_count > 0 ? report.head_hash : GENESIS_HASH;
  const clonedPayload = JSON.parse(JSON.stringify(payload));
  const payloadHash = hashFn(clonedPayload);

  const unsigned = {
    schema: LEDGER_SCHEMA as typeof LEDGER_SCHEMA,
    index,
    event_id: `EVT-${String(index).padStart(8, '0')}`,
    event_type: eventType.trim(),
    timestamp: timestamp.trim(),
    previous_hash: previousHash,
    payload_sha256: payloadHash,
    payload: clonedPayload,
  };

  const eventHash = hashFn(unsigned);

  const newEvent: LedgerEvent<T> = {
    ...unsigned,
    event_hash: eventHash,
  };

  return {
    updatedEvents: [...existingEvents, newEvent as LedgerEvent],
    newEvent,
  };
}

/**
 * Verifies that a given ledger matches an expected prefix commitment.
 */
export function verifyLedgerPrefix(
  events: LedgerEvent[],
  prefix: { event_count: number; head_hash: string },
  hashFn: CanonicalHasher = sha256Canonical
): void {
  if (!Number.isInteger(prefix.event_count) || prefix.event_count < 1) {
    throw new LedgerError('ledger prefix event_count must be positive');
  }
  const report = verifyLedgerEvents(events, hashFn);
  if (report.status !== 'PASS') {
    throw new LedgerError(`ledger verification failed: ${report.errors.join('; ')}`);
  }
  if (report.event_count < prefix.event_count) {
    throw new LedgerError('ledger is shorter than required bundle prefix');
  }
  const prefixHead = report.event_hashes[prefix.event_count - 1];
  if (prefixHead !== prefix.head_hash) {
    throw new LedgerError('ledger prefix head hash mismatch');
  }
}

/**
 * Validates a receipt against the current ledger before authorizing downstream Sandbox actions
 * (Parity with app.py /paypal/order and /paypal/capture receipt verification).
 */
export function verifyReceiptForOrder(
  events: LedgerEvent[],
  receipt: { index: number; event_hash: string },
  preverifiedReport?: LedgerVerificationReport
): LedgerEvent {
  if (
    !receipt ||
    typeof receipt !== 'object' ||
    typeof receipt.index !== 'number' ||
    !Number.isInteger(receipt.index) ||
    typeof receipt.event_hash !== 'string' ||
    !SHA256_RE.test(receipt.event_hash)
  ) {
    throw new LedgerError('invalid receipt format');
  }

  const report = preverifiedReport ?? verifyLedgerEvents(events);
  if (
    report.status !== 'PASS' ||
    receipt.index < 1 ||
    receipt.index > report.event_count ||
    report.event_hashes[receipt.index - 1] !== receipt.event_hash
  ) {
    throw new LedgerError('invalid receipt or corrupted ledger');
  }

  const targetEvent = events[receipt.index - 1];
  const payload = targetEvent.payload as Record<string, unknown>;
  if (
    targetEvent.event_type !== 'invoice_review' ||
    payload?.status !== 'FIELDS_CONSISTENT'
  ) {
    throw new LedgerError('invoice review is not consistent');
  }

  return targetEvent;
}

const EUR_AMOUNT_RE = /^(0|[1-9]\d*)\.\d{2}$/;

/**
 * Extracts and validates `verified_amount_eur` from a verified `invoice_review` ledger event.
 * Never falls back to a default magic amount; throws `LedgerError` if missing or invalid.
 */
export function extractVerifiedAmountFromReceiptEvent(event: LedgerEvent): string {
  const payload = event.payload as Record<string, unknown>;
  const rawAmount = payload?.verified_amount_eur;
  if (typeof rawAmount !== 'string' || !EUR_AMOUNT_RE.test(rawAmount) || Number(rawAmount) <= 0) {
    throw new LedgerError(
      'invoice_review receipt does not contain a valid positive verified_amount_eur'
    );
  }
  return rawAmount;
}

/**
 * Prevents replay / double-spend of an `invoice_review` receipt:
 * Rejects order creation if any `paypal_sandbox_order` or `paypal_sandbox_capture`
 * in the ledger already references `receiptHash`.
 */
export function assertReceiptNotConsumed(
  events: LedgerEvent[],
  receiptHash: string
): void {
  for (const evt of events) {
    if (
      evt.event_type === 'paypal_sandbox_order' ||
      evt.event_type === 'paypal_sandbox_capture'
    ) {
      const p = evt.payload as Record<string, unknown>;
      if (p?.receipt_hash === receiptHash) {
        throw new LedgerError(
          `receipt replay blocked: receipt '${receiptHash.slice(0, 12)}...' has already been used for order '${String(p?.order_id || '')}'`
        );
      }
    }
  }
}

export const ALLOWED_CLIENT_APPEND_EVENT_TYPES: ReadonlySet<string> = new Set([
  'quant_risk_eval',
  'research_bundle_seal',
]);

/**
 * Ensures external clients calling `/api/ledger/append` can never forge payment or review receipts
 * (`invoice_review`, `paypal_sandbox_*`, `ai_*`, `genesis_kernel_anchor`).
 */
export function assertAllowedClientEventType(eventType: unknown): string {
  if (typeof eventType !== 'string' || !ALLOWED_CLIENT_APPEND_EVENT_TYPES.has(eventType.trim())) {
    throw new LedgerError(
      `forbidden client event_type '${String(eventType)}': payment and review receipts can only be sealed by authoritative server routes`
    );
  }
  return eventType.trim();
}
