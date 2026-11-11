/**
 * @license
 * SyntraVariga / AhaWissenschaft Research Framework
 * Module: SQLite ACID Transactional Ledger & Payment State Store (`node:sqlite`)
 *
 * Why this file exists:
 * 1. Stores the cryptographic audit ledger (`ledger_events`) and payment lifecycle
 *    reservations (`payment_records`) in a single ACID SQLite database with WAL
 *    journaling and `BEGIN IMMEDIATE` transactions.
 * 2. Eliminates stale filesystem `.lock` files on process crash—SQLite automatically
 *    releases OS file locks and rolls back uncommitted transactions if a process
 *    terminates unexpectedly.
 * 3. Guarantees atomic co-commit of payment state transitions (`ORDER_CREATED`,
 *    `ORDER_APPROVED`, `COMPLETED`, `UNKNOWN_RECONCILIATION_REQUIRED`) and their
 *    corresponding audit ledger events (`paypal_sandbox_order`, `paypal_sandbox_approval`,
 *    `paypal_sandbox_capture`, `paypal_manual_reconciliation`), preventing split-brain
 *    divergence between payment status and audit log.
 */

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { canonicalJson, sha256Hex } from './crypto';
import {
  LEDGER_SCHEMA,
  LedgerEvent,
  LedgerError,
  verifyLedgerEvents,
  appendEvent,
} from './ledger';

export type PaymentLifecycleState =
  | 'RESERVED_ORDER'
  | 'ORDER_CREATED'
  | 'ORDER_APPROVED'
  | 'CAPTURE_PENDING'
  | 'COMPLETED'
  | 'UNKNOWN_RECONCILIATION_REQUIRED'
  | 'RECONCILED_CANCELLED';

export interface PersistentPaymentRecord {
  receipt_hash: string;
  receipt_index: number;
  verified_amount_eur: string;
  currency: 'EUR';
  state: PaymentLifecycleState;
  order_idempotency_key: string;
  capture_idempotency_key: string;
  order_id: string | null;
  approve_url: string | null;
  capture_id: string | null;
  execution_mode: 'LIVE_PAYPAL_SANDBOX_REST' | 'SANDBOX_PROTOCOL_SIMULATION' | null;
  last_error: string | null;
  reconciliation_note?: string | null;
  updated_at: string;
}

export class PaymentConcurrencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaymentConcurrencyError';
  }
}

export class PaymentStateUnknownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaymentStateUnknownError';
  }
}

function resolveSqliteDbPath(ledgerOrDbPath: string): string {
  const resolved = path.resolve(ledgerOrDbPath);
  if (resolved.endsWith('.sqlite') || resolved.endsWith('.db')) {
    return resolved;
  }
  return `${resolved}.sqlite`;
}

/**
 * Opens an ACID SQLite connection with `busy_timeout = 5000` and `WAL` mode,
 * executes `fn` inside a `BEGIN IMMEDIATE ... COMMIT / ROLLBACK` transaction
 * when `writeTransaction = true`, and always closes the descriptor cleanly.
 */
function withSqliteConnection<T>(
  ledgerOrDbPath: string,
  writeTransaction: boolean,
  fn: (db: DatabaseSync) => T
): T {
  const dbPath = resolveSqliteDbPath(ledgerOrDbPath);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  // Detect pre-existing 0-byte or non-SQLite corrupted file before SQLite touches it
  if (fs.existsSync(dbPath)) {
    const stat = fs.statSync(dbPath);
    if (stat.size === 0) {
      throw new LedgerError(`Existing SQLite store is empty (${dbPath}); refusing to overwrite`);
    }
    const headerBuf = Buffer.alloc(16);
    const fd = fs.openSync(dbPath, 'r');
    try {
      fs.readSync(fd, headerBuf, 0, 16, 0);
    } finally {
      fs.closeSync(fd);
    }
    const magic = headerBuf.toString('utf8', 0, 15);
    if (magic !== 'SQLite format 3') {
      throw new LedgerError(
        `Corrupted SQLite header in (${dbPath}); refusing to start or overwrite`
      );
    }
  }

  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA busy_timeout = 5000;');
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA synchronous = FULL;');
    db.exec('PRAGMA foreign_keys = ON;');

    db.exec(`
      CREATE TABLE IF NOT EXISTS ledger_events (
        idx INTEGER PRIMARY KEY,
        event_id TEXT NOT NULL UNIQUE,
        timestamp TEXT NOT NULL,
        event_type TEXT NOT NULL,
        previous_hash TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        payload_sha256 TEXT NOT NULL,
        event_hash TEXT NOT NULL UNIQUE
      ) STRICT;

      CREATE TABLE IF NOT EXISTS payment_records (
        receipt_hash TEXT PRIMARY KEY,
        receipt_index INTEGER NOT NULL UNIQUE,
        verified_amount_eur TEXT NOT NULL,
        currency TEXT NOT NULL CHECK (currency = 'EUR'),
        state TEXT NOT NULL,
        order_idempotency_key TEXT NOT NULL UNIQUE,
        capture_idempotency_key TEXT NOT NULL UNIQUE,
        order_id TEXT UNIQUE,
        approve_url TEXT,
        capture_id TEXT UNIQUE,
        execution_mode TEXT,
        last_error TEXT,
        reconciliation_note TEXT,
        updated_at TEXT NOT NULL
      ) STRICT;
    `);

    if (!writeTransaction) {
      return fn(db);
    }

    try {
      db.exec('BEGIN IMMEDIATE;');
    } catch (err) {
      const msg = (err as Error).message || '';
      if (msg.includes('SQLITE_BUSY') || msg.includes('database is locked')) {
        throw new PaymentConcurrencyError(
          'Database is locked by a concurrent transaction; operation rejected'
        );
      }
      throw new LedgerError(`Failed to start SQLite transaction: ${msg}`);
    }

    try {
      const result = fn(db);
      db.exec('COMMIT;');
      return result;
    } catch (err) {
      try {
        db.exec('ROLLBACK;');
      } catch {
        // Ignore rollback error if transaction already aborted
      }
      throw err;
    }
  } finally {
    try {
      db.close();
    } catch {
      // Ignore close error
    }
  }
}

function readAndVerifyLedgerFromDb(db: DatabaseSync): LedgerEvent[] {
  const rows = db
    .prepare(
      `SELECT idx, event_id, timestamp, event_type, previous_hash, payload_json, payload_sha256, event_hash
       FROM ledger_events
       ORDER BY idx ASC`
    )
    .all() as Array<{
    idx: number;
    event_id: string;
    timestamp: string;
    event_type: string;
    previous_hash: string;
    payload_json: string;
    payload_sha256: string;
    event_hash: string;
  }>;

  const events: LedgerEvent[] = rows.map((r, i) => {
    let parsedPayload: Record<string, unknown>;
    try {
      parsedPayload = JSON.parse(r.payload_json) as Record<string, unknown>;
    } catch (err) {
      throw new LedgerError(
        `Corrupted JSON in SQLite ledger_events at row ${i + 1}: ${(err as Error).message}`
      );
    }
    return {
      schema: LEDGER_SCHEMA,
      index: r.idx,
      event_id: r.event_id,
      timestamp: r.timestamp,
      event_type: r.event_type,
      previous_hash: r.previous_hash,
      payload: parsedPayload,
      payload_sha256: r.payload_sha256,
      event_hash: r.event_hash,
    };
  });

  const report = verifyLedgerEvents(events);
  if (report.status !== 'PASS') {
    throw new LedgerError(
      `Persistent ledger failed integrity check (${report.errors.join('; ')}); refusing to start or overwrite`
    );
  }
  return events;
}

function insertLedgerEventIntoDb<T extends Record<string, unknown>>(
  db: DatabaseSync,
  currentEvents: LedgerEvent[],
  params: { eventType: string; timestamp?: string; payload: T }
): { events: LedgerEvent[]; newEvent: LedgerEvent<T> } {
  const { updatedEvents, newEvent } = appendEvent(currentEvents, params);
  const report = verifyLedgerEvents(updatedEvents);
  if (report.status !== 'PASS') {
    throw new LedgerError(`Refusing to persist invalid ledger: ${report.errors.join('; ')}`);
  }

  db.prepare(
    `INSERT INTO ledger_events (
      idx, event_id, timestamp, event_type, previous_hash, payload_json, payload_sha256, event_hash
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    newEvent.index,
    newEvent.event_id,
    newEvent.timestamp,
    newEvent.event_type,
    newEvent.previous_hash,
    canonicalJson(newEvent.payload),
    newEvent.payload_sha256,
    newEvent.event_hash
  );

  return { events: updatedEvents, newEvent };
}

/**
 * Mirrors verified ledger events to a canonical `.jsonl` file if a `.jsonl` path was requested,
 * while keeping SQLite as the authoritative transactional store.
 */
function syncCanonicalJsonlExportIfRequested(
  ledgerOrDbPath: string,
  events: LedgerEvent[]
): void {
  const resolved = path.resolve(ledgerOrDbPath);
  if (!resolved.endsWith('.jsonl')) return;
  const tmpPath = `${resolved}.${process.pid}.${Date.now()}.tmp`;
  const serialized = events.map((e) => canonicalJson(e)).join('\n') + '\n';
  fs.writeFileSync(tmpPath, serialized, { encoding: 'utf8', flag: 'w' });
  fs.renameSync(tmpPath, resolved);
}

/**
 * Loads and verifies the persistent ledger on startup.
 * - If legacy `.jsonl` exists and `.sqlite` does not yet exist, imports and verifies the `.jsonl` once.
 * - If `.jsonl` is corrupted, aborts fail-closed without overwriting.
 * - If neither exists, initializes once with Genesis event.
 */
export function loadAndVerifyPersistentLedger(ledgerFilePath: string): LedgerEvent[] {
  const resolved = path.resolve(ledgerFilePath);
  const dbPath = resolveSqliteDbPath(ledgerFilePath);

  // If a raw .jsonl file exists and was tampered/corrupted on disk, check it before use!
  if (resolved.endsWith('.jsonl') && fs.existsSync(resolved)) {
    const rawContent = fs.readFileSync(resolved, 'utf8');
    const lines = rawContent
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length === 0) {
      throw new LedgerError(`Existing ledger file is empty (${resolved}); refusing to overwrite`);
    }
    const jsonlEvents: LedgerEvent[] = lines.map((line, i) => {
      try {
        return JSON.parse(line) as LedgerEvent;
      } catch (err) {
        throw new LedgerError(`Corrupted JSON at ledger line ${i + 1}: ${(err as Error).message}`);
      }
    });
    const report = verifyLedgerEvents(jsonlEvents);
    if (report.status !== 'PASS') {
      throw new LedgerError(
        `Persistent ledger failed integrity check (${report.errors.join('; ')}); refusing to start or overwrite`
      );
    }

    // If SQLite DB does not exist yet, migrate the verified JSONL events into SQLite transactionally
    if (!fs.existsSync(dbPath)) {
      return withSqliteConnection(ledgerFilePath, true, (db) => {
        const stmt = db.prepare(
          `INSERT INTO ledger_events (
            idx, event_id, timestamp, event_type, previous_hash, payload_json, payload_sha256, event_hash
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        );
        for (const ev of jsonlEvents) {
          stmt.run(
            ev.index,
            ev.event_id,
            ev.timestamp,
            ev.event_type,
            ev.previous_hash,
            canonicalJson(ev.payload),
            ev.payload_sha256,
            ev.event_hash
          );
        }
        return readAndVerifyLedgerFromDb(db);
      });
    }
  }

  return withSqliteConnection(ledgerFilePath, true, (db) => {
    const existing = readAndVerifyLedgerFromDb(db);
    if (existing.length > 0) {
      syncCanonicalJsonlExportIfRequested(ledgerFilePath, existing);
      return existing;
    }

    const { events } = insertLedgerEventIntoDb(db, [], {
      eventType: 'genesis_kernel_anchor',
      timestamp: new Date().toISOString(),
      payload: {
        framework: 'SyntraVariga / AhaWissenschaft Kernel',
        version: '1.4.0',
        crypto_standard: 'NIST_FIPS_PUB_180_4_SHA256',
        storage_engine: 'SQLITE_ACID_WAL',
        status: 'INITIALIZED',
      },
    });
    syncCanonicalJsonlExportIfRequested(ledgerFilePath, events);
    return events;
  });
}

/**
 * Atomically verifies the SQLite ledger, appends a new event in a `BEGIN IMMEDIATE` transaction,
 * and updates the canonical JSONL mirror if applicable.
 */
export function appendEventPersistently<T extends Record<string, unknown>>(
  ledgerFilePath: string,
  params: { eventType: string; timestamp?: string; payload: T }
): { events: LedgerEvent[]; newEvent: LedgerEvent<T> } {
  return withSqliteConnection(ledgerFilePath, true, (db) => {
    const currentEvents = readAndVerifyLedgerUnlocked(ledgerFilePath, db);
    const result = insertLedgerEventIntoDb(db, currentEvents, params);
    syncCanonicalJsonlExportIfRequested(ledgerFilePath, result.events);
    return result;
  });
}

function readAndVerifyLedgerUnlocked(ledgerFilePath: string, db: DatabaseSync): LedgerEvent[] {
  const resolved = path.resolve(ledgerFilePath);
  if (resolved.endsWith('.jsonl') && fs.existsSync(resolved)) {
    const rawContent = fs.readFileSync(resolved, 'utf8');
    const lines = rawContent
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length === 0) {
      throw new LedgerError(`Existing ledger file is empty (${resolved}); refusing to overwrite`);
    }
    const jsonlEvents = lines.map((l, i) => {
      try {
        return JSON.parse(l) as LedgerEvent;
      } catch (err) {
        throw new LedgerError(`Corrupted JSON at ledger line ${i + 1}: ${(err as Error).message}`);
      }
    });
    const rep = verifyLedgerEvents(jsonlEvents);
    if (rep.status !== 'PASS') {
      throw new LedgerError(
        `Persistent ledger failed integrity check (${rep.errors.join('; ')}); refusing to start or overwrite`
      );
    }
  }
  return readAndVerifyLedgerFromDb(db);
}

function mapRowToPaymentRecord(row: Record<string, unknown>): PersistentPaymentRecord {
  return {
    receipt_hash: String(row.receipt_hash),
    receipt_index: Number(row.receipt_index),
    verified_amount_eur: String(row.verified_amount_eur),
    currency: 'EUR',
    state: row.state as PaymentLifecycleState,
    order_idempotency_key: String(row.order_idempotency_key),
    capture_idempotency_key: String(row.capture_idempotency_key),
    order_id: row.order_id ? String(row.order_id) : null,
    approve_url: row.approve_url ? String(row.approve_url) : null,
    capture_id: row.capture_id ? String(row.capture_id) : null,
    execution_mode: row.execution_mode
      ? (String(row.execution_mode) as
          | 'LIVE_PAYPAL_SANDBOX_REST'
          | 'SANDBOX_PROTOCOL_SIMULATION')
      : null,
    last_error: row.last_error ? String(row.last_error) : null,
    reconciliation_note: row.reconciliation_note ? String(row.reconciliation_note) : null,
    updated_at: String(row.updated_at),
  };
}

/**
 * Transactional SQLite Store for Payment Reservations + Co-Committed Audit Ledger Events.
 * Uses SQLite UNIQUE constraints and `BEGIN IMMEDIATE` transactions.
 */
export class PersistentPaymentStore {
  private readonly ledgerFilePath: string;

  constructor(ledgerFilePath: string) {
    this.ledgerFilePath = path.resolve(ledgerFilePath);
  }

  public getRecord(receiptHash: string): PersistentPaymentRecord | null {
    return withSqliteConnection(this.ledgerFilePath, false, (db) => {
      const row = db
        .prepare('SELECT * FROM payment_records WHERE receipt_hash = ?')
        .get(receiptHash) as Record<string, unknown> | undefined;
      return row ? mapRowToPaymentRecord(row) : null;
    });
  }

  public getAllRecords(): Record<string, PersistentPaymentRecord> {
    return withSqliteConnection(this.ledgerFilePath, false, (db) => {
      const rows = db
        .prepare('SELECT * FROM payment_records ORDER BY receipt_index ASC')
        .all() as Array<Record<string, unknown>>;
      const out: Record<string, PersistentPaymentRecord> = {};
      for (const r of rows) {
        const mapped = mapRowToPaymentRecord(r);
        out[mapped.receipt_hash] = mapped;
      }
      return out;
    });
  }

  /**
   * Atomically reserves a receipt in SQLite BEFORE any network call to PayPal.
   * Enforces UNIQUE(receipt_hash) and UNIQUE(receipt_index).
   */
  public reserveForOrderCreation(params: {
    receiptHash: string;
    receiptIndex: number;
    verifiedAmountEur: string;
  }): PersistentPaymentRecord {
    return withSqliteConnection(this.ledgerFilePath, true, (db) => {
      const existingRow = db
        .prepare('SELECT * FROM payment_records WHERE receipt_hash = ?')
        .get(params.receiptHash) as Record<string, unknown> | undefined;

      if (existingRow) {
        const existing = mapRowToPaymentRecord(existingRow);
        if (existing.state === 'UNKNOWN_RECONCILIATION_REQUIRED') {
          throw new PaymentStateUnknownError(
            `Receipt ${params.receiptHash.slice(0, 12)}... is in state UNKNOWN_RECONCILIATION_REQUIRED (${existing.last_error || 'prior timeout/crash'}). Automatic retry is blocked; please reconcile manually.`
          );
        }
        throw new PaymentConcurrencyError(
          `Receipt replay/concurrency blocked: receipt '${params.receiptHash.slice(0, 12)}...' is already in state '${existing.state}' (order: ${existing.order_id || 'pending'})`
        );
      }

      const now = new Date().toISOString();
      const orderIdem = `syntra-ord-${sha256Hex(`order:${params.receiptHash}`).slice(0, 32)}`;
      const captureIdem = `syntra-cap-${sha256Hex(`capture:${params.receiptHash}`).slice(0, 32)}`;

      db.prepare(
        `INSERT INTO payment_records (
          receipt_hash, receipt_index, verified_amount_eur, currency, state,
          order_idempotency_key, capture_idempotency_key,
          order_id, approve_url, capture_id, execution_mode, last_error, reconciliation_note, updated_at
        ) VALUES (?, ?, ?, 'EUR', 'RESERVED_ORDER', ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, ?)`
      ).run(
        params.receiptHash,
        params.receiptIndex,
        params.verifiedAmountEur,
        orderIdem,
        captureIdem,
        now
      );

      const inserted = db
        .prepare('SELECT * FROM payment_records WHERE receipt_hash = ?')
        .get(params.receiptHash) as Record<string, unknown>;
      return mapRowToPaymentRecord(inserted);
    });
  }

  /**
   * Atomically updates payment state to `ORDER_CREATED` AND appends the `paypal_sandbox_order`
   * ledger event in a single SQLite `BEGIN IMMEDIATE` transaction (or updates state alone if no ledger payload is passed).
   */
  public confirmOrderCreated(params: {
    receiptHash: string;
    orderId: string;
    approveUrl: string;
    executionMode: 'LIVE_PAYPAL_SANDBOX_REST' | 'SANDBOX_PROTOCOL_SIMULATION';
    appendLedgerEvent?: boolean;
  }): {
    record: PersistentPaymentRecord;
    events?: LedgerEvent[];
    newEvent?: LedgerEvent;
  } {
    return withSqliteConnection(this.ledgerFilePath, true, (db) => {
      const existingRow = db
        .prepare('SELECT * FROM payment_records WHERE receipt_hash = ?')
        .get(params.receiptHash) as Record<string, unknown> | undefined;
      if (!existingRow) {
        throw new PaymentConcurrencyError('Invalid payment state transition to ORDER_CREATED');
      }
      const rec = mapRowToPaymentRecord(existingRow);
      if (rec.state !== 'RESERVED_ORDER') {
        throw new PaymentConcurrencyError(
          `Invalid payment state transition from ${rec.state} to ORDER_CREATED`
        );
      }

      const now = new Date().toISOString();
      db.prepare(
        `UPDATE payment_records
         SET state = 'ORDER_CREATED',
             order_id = ?,
             approve_url = ?,
             execution_mode = ?,
             updated_at = ?
         WHERE receipt_hash = ?`
      ).run(params.orderId, params.approveUrl, params.executionMode, now, params.receiptHash);

      const updatedRow = db
        .prepare('SELECT * FROM payment_records WHERE receipt_hash = ?')
        .get(params.receiptHash) as Record<string, unknown>;
      const updatedRecord = mapRowToPaymentRecord(updatedRow);

      if (params.appendLedgerEvent) {
        const currentEvents = readAndVerifyLedgerUnlocked(this.ledgerFilePath, db);
        const { events, newEvent } = insertLedgerEventIntoDb(db, currentEvents, {
          eventType: 'paypal_sandbox_order',
          timestamp: now,
          payload: {
            receipt_hash: params.receiptHash,
            paypal_status: 'CREATED',
            order_id: params.orderId,
            approve_url: params.approveUrl,
            execution_mode: params.executionMode,
            verified_amount_eur: updatedRecord.verified_amount_eur,
            currency: 'EUR',
            idempotency_key: updatedRecord.order_idempotency_key,
          },
        });
        syncCanonicalJsonlExportIfRequested(this.ledgerFilePath, events);
        return { record: updatedRecord, events, newEvent };
      }

      return { record: updatedRecord };
    });
  }

  /**
   * Atomically updates payment state to `ORDER_APPROVED` AND optionally appends `paypal_sandbox_approval`
   * in the same SQLite transaction.
   */
  public confirmOrderApproved(params: {
    receiptHash: string;
    orderId: string;
    payerId?: string;
    executionMode?: 'LIVE_PAYPAL_SANDBOX_REST' | 'SANDBOX_PROTOCOL_SIMULATION';
    appendLedgerEvent?: boolean;
  }): {
    record: PersistentPaymentRecord;
    events?: LedgerEvent[];
    newEvent?: LedgerEvent;
  } {
    return withSqliteConnection(this.ledgerFilePath, true, (db) => {
      const existingRow = db
        .prepare('SELECT * FROM payment_records WHERE receipt_hash = ?')
        .get(params.receiptHash) as Record<string, unknown> | undefined;
      if (!existingRow) {
        throw new PaymentConcurrencyError('Order ID does not match bound receipt record');
      }
      const rec = mapRowToPaymentRecord(existingRow);
      if (rec.order_id !== params.orderId) {
        throw new PaymentConcurrencyError('Order ID does not match bound receipt record');
      }
      if (rec.state === 'UNKNOWN_RECONCILIATION_REQUIRED') {
        throw new PaymentStateUnknownError('Payment is in UNKNOWN state; reconcile first');
      }
      if (rec.state !== 'ORDER_CREATED' && rec.state !== 'ORDER_APPROVED') {
        throw new PaymentConcurrencyError(`Cannot approve order in state ${rec.state}`);
      }

      const now = new Date().toISOString();
      db.prepare(
        `UPDATE payment_records
         SET state = 'ORDER_APPROVED',
             updated_at = ?
         WHERE receipt_hash = ?`
      ).run(now, params.receiptHash);

      const updatedRow = db
        .prepare('SELECT * FROM payment_records WHERE receipt_hash = ?')
        .get(params.receiptHash) as Record<string, unknown>;
      const updatedRecord = mapRowToPaymentRecord(updatedRow);

      if (params.appendLedgerEvent) {
        const currentEvents = readAndVerifyLedgerUnlocked(this.ledgerFilePath, db);
        const { events, newEvent } = insertLedgerEventIntoDb(db, currentEvents, {
          eventType: 'paypal_sandbox_approval',
          timestamp: now,
          payload: {
            receipt_hash: params.receiptHash,
            paypal_status: 'APPROVED',
            order_id: params.orderId,
            payer_id: params.payerId || 'SANDBOX_BUYER',
            verified_amount_eur: updatedRecord.verified_amount_eur,
            execution_mode:
              params.executionMode ||
              updatedRecord.execution_mode ||
              'SANDBOX_PROTOCOL_SIMULATION',
          },
        });
        syncCanonicalJsonlExportIfRequested(this.ledgerFilePath, events);
        return { record: updatedRecord, events, newEvent };
      }

      return { record: updatedRecord };
    });
  }

  /**
   * Atomically transitions from `ORDER_APPROVED` to `CAPTURE_PENDING` before calling PayPal Capture.
   */
  public reserveForCapture(params: {
    receiptHash: string;
    orderId: string;
  }): PersistentPaymentRecord {
    return withSqliteConnection(this.ledgerFilePath, true, (db) => {
      const existingRow = db
        .prepare('SELECT * FROM payment_records WHERE receipt_hash = ?')
        .get(params.receiptHash) as Record<string, unknown> | undefined;
      if (!existingRow) {
        throw new PaymentConcurrencyError('Order ID is not bound to this receipt');
      }
      const rec = mapRowToPaymentRecord(existingRow);
      if (rec.order_id !== params.orderId) {
        throw new PaymentConcurrencyError('Order ID is not bound to this receipt');
      }
      if (rec.state === 'UNKNOWN_RECONCILIATION_REQUIRED') {
        throw new PaymentStateUnknownError(
          `Order ${params.orderId} is in state UNKNOWN_RECONCILIATION_REQUIRED. Automatic retry is blocked.`
        );
      }
      if (rec.state === 'CAPTURE_PENDING' || rec.state === 'COMPLETED') {
        throw new PaymentConcurrencyError(
          `Duplicate capture blocked: order '${params.orderId}' is already in state '${rec.state}'`
        );
      }
      if (rec.state !== 'ORDER_APPROVED') {
        throw new PaymentConcurrencyError(
          `Order '${params.orderId}' must be in state ORDER_APPROVED before capture (current: ${rec.state})`
        );
      }

      const now = new Date().toISOString();
      db.prepare(
        `UPDATE payment_records
         SET state = 'CAPTURE_PENDING',
             updated_at = ?
         WHERE receipt_hash = ?`
      ).run(now, params.receiptHash);

      const updatedRow = db
        .prepare('SELECT * FROM payment_records WHERE receipt_hash = ?')
        .get(params.receiptHash) as Record<string, unknown>;
      return mapRowToPaymentRecord(updatedRow);
    });
  }

  /**
   * Atomically transitions from `CAPTURE_PENDING` to `COMPLETED` AND co-commits the
   * `paypal_sandbox_capture` ledger event in the same SQLite transaction.
   */
  public confirmCaptureCompleted(params: {
    receiptHash: string;
    orderId: string;
    captureId: string;
    executionMode?: 'LIVE_PAYPAL_SANDBOX_REST' | 'SANDBOX_PROTOCOL_SIMULATION';
    appendLedgerEvent?: boolean;
  }): {
    record: PersistentPaymentRecord;
    events?: LedgerEvent[];
    newEvent?: LedgerEvent;
  } {
    return withSqliteConnection(this.ledgerFilePath, true, (db) => {
      const existingRow = db
        .prepare('SELECT * FROM payment_records WHERE receipt_hash = ?')
        .get(params.receiptHash) as Record<string, unknown> | undefined;
      if (!existingRow) {
        throw new PaymentConcurrencyError('Invalid state transition to COMPLETED');
      }
      const rec = mapRowToPaymentRecord(existingRow);
      if (rec.order_id !== params.orderId || rec.state !== 'CAPTURE_PENDING') {
        throw new PaymentConcurrencyError('Invalid state transition to COMPLETED');
      }

      const now = new Date().toISOString();
      db.prepare(
        `UPDATE payment_records
         SET state = 'COMPLETED',
             capture_id = ?,
             updated_at = ?
         WHERE receipt_hash = ?`
      ).run(params.captureId, now, params.receiptHash);

      const updatedRow = db
        .prepare('SELECT * FROM payment_records WHERE receipt_hash = ?')
        .get(params.receiptHash) as Record<string, unknown>;
      const updatedRecord = mapRowToPaymentRecord(updatedRow);

      if (params.appendLedgerEvent) {
        const currentEvents = readAndVerifyLedgerUnlocked(this.ledgerFilePath, db);
        const { events, newEvent } = insertLedgerEventIntoDb(db, currentEvents, {
          eventType: 'paypal_sandbox_capture',
          timestamp: now,
          payload: {
            receipt_hash: params.receiptHash,
            paypal_status: 'COMPLETED',
            order_id: params.orderId,
            capture_id: params.captureId,
            verified_amount_eur: updatedRecord.verified_amount_eur,
            currency: 'EUR',
            execution_mode:
              params.executionMode ||
              updatedRecord.execution_mode ||
              'SANDBOX_PROTOCOL_SIMULATION',
            idempotency_key: updatedRecord.capture_idempotency_key,
          },
        });
        syncCanonicalJsonlExportIfRequested(this.ledgerFilePath, events);
        return { record: updatedRecord, events, newEvent };
      }

      return { record: updatedRecord };
    });
  }

  /**
   * Marks a payment operation as `UNKNOWN_RECONCILIATION_REQUIRED` upon network timeout,
   * crash recovery, or ambiguous failure, and atomically records an audit event if requested.
   */
  public markUnknownReconciliationRequired(
    receiptHash: string,
    reason: string,
    appendLedgerEvent = false
  ): {
    record: PersistentPaymentRecord;
    events?: LedgerEvent[];
    newEvent?: LedgerEvent;
  } {
    return withSqliteConnection(this.ledgerFilePath, true, (db) => {
      const existingRow = db
        .prepare('SELECT * FROM payment_records WHERE receipt_hash = ?')
        .get(receiptHash) as Record<string, unknown> | undefined;
      if (!existingRow) {
        throw new LedgerError('Payment record not found for reconciliation marking');
      }

      const now = new Date().toISOString();
      db.prepare(
        `UPDATE payment_records
         SET state = 'UNKNOWN_RECONCILIATION_REQUIRED',
             last_error = ?,
             updated_at = ?
         WHERE receipt_hash = ?`
      ).run(reason, now, receiptHash);

      const updatedRow = db
        .prepare('SELECT * FROM payment_records WHERE receipt_hash = ?')
        .get(receiptHash) as Record<string, unknown>;
      const updatedRecord = mapRowToPaymentRecord(updatedRow);

      if (appendLedgerEvent) {
        const currentEvents = readAndVerifyLedgerUnlocked(this.ledgerFilePath, db);
        const { events, newEvent } = insertLedgerEventIntoDb(db, currentEvents, {
          eventType: 'paypal_payment_state_unknown',
          timestamp: now,
          payload: {
            receipt_hash: receiptHash,
            order_id: updatedRecord.order_id,
            state: 'UNKNOWN_RECONCILIATION_REQUIRED',
            reason,
          },
        });
        syncCanonicalJsonlExportIfRequested(this.ledgerFilePath, events);
        return { record: updatedRecord, events, newEvent };
      }

      return { record: updatedRecord };
    });
  }

  /**
   * Startup / Crash Recovery Audit:
   * Any payment record left in an in-flight transient state (`RESERVED_ORDER` or `CAPTURE_PENDING`)
   * because the server process crashed mid-request is automatically transitioned to
   * `UNKNOWN_RECONCILIATION_REQUIRED` and logged in the audit ledger in the same SQLite transaction!
   */
  public recoverInFlightRecordsOnStartup(): PersistentPaymentRecord[] {
    return withSqliteConnection(this.ledgerFilePath, true, (db) => {
      const danglingRows = db
        .prepare(
          `SELECT * FROM payment_records
           WHERE state IN ('RESERVED_ORDER', 'CAPTURE_PENDING')`
        )
        .all() as Array<Record<string, unknown>>;

      if (danglingRows.length === 0) {
        return [];
      }

      let currentEvents = readAndVerifyLedgerUnlocked(this.ledgerFilePath, db);
      const recovered: PersistentPaymentRecord[] = [];
      const now = new Date().toISOString();

      for (const row of danglingRows) {
        const rec = mapRowToPaymentRecord(row);
        const reason = `Process terminated while payment was in transient state '${rec.state}'; automatic retry blocked until manual reconciliation`;
        db.prepare(
          `UPDATE payment_records
           SET state = 'UNKNOWN_RECONCILIATION_REQUIRED',
               last_error = ?,
               updated_at = ?
           WHERE receipt_hash = ?`
        ).run(reason, now, rec.receipt_hash);

        const res = insertLedgerEventIntoDb(db, currentEvents, {
          eventType: 'paypal_crash_recovery_lock',
          timestamp: now,
          payload: {
            receipt_hash: rec.receipt_hash,
            prior_transient_state: rec.state,
            new_state: 'UNKNOWN_RECONCILIATION_REQUIRED',
            order_id: rec.order_id,
            reason,
          },
        });
        currentEvents = res.events;

        const updatedRow = db
          .prepare('SELECT * FROM payment_records WHERE receipt_hash = ?')
          .get(rec.receipt_hash) as Record<string, unknown>;
        recovered.push(mapRowToPaymentRecord(updatedRow));
      }

      syncCanonicalJsonlExportIfRequested(this.ledgerFilePath, currentEvents);
      return recovered;
    });
  }

  /**
   * Manual reconciliation for an `UNKNOWN_RECONCILIATION_REQUIRED` record, co-committed with
   * a `paypal_manual_reconciliation` ledger event in the same SQLite transaction.
   */
  public reconcileUnknownPayment(params: {
    receiptHash: string;
    resolution: 'MARK_CANCELLED' | 'CONFIRM_CAPTURED';
    captureId?: string;
    operatorNote: string;
    appendLedgerEvent?: boolean;
  }): {
    record: PersistentPaymentRecord;
    events?: LedgerEvent[];
    newEvent?: LedgerEvent;
  } {
    return withSqliteConnection(this.ledgerFilePath, true, (db) => {
      const existingRow = db
        .prepare('SELECT * FROM payment_records WHERE receipt_hash = ?')
        .get(params.receiptHash) as Record<string, unknown> | undefined;
      if (!existingRow) {
        throw new LedgerError('Payment record not found for manual reconciliation');
      }
      const rec = mapRowToPaymentRecord(existingRow);
      if (rec.state !== 'UNKNOWN_RECONCILIATION_REQUIRED') {
        throw new PaymentConcurrencyError(
          `Only records in state UNKNOWN_RECONCILIATION_REQUIRED can be reconciled (current: ${rec.state})`
        );
      }
      if (!params.operatorNote || !params.operatorNote.trim()) {
        throw new LedgerError('operatorNote is required for manual reconciliation');
      }

      let newState: PaymentLifecycleState;
      let newCaptureId: string | null = rec.capture_id;

      if (params.resolution === 'CONFIRM_CAPTURED') {
        if (!params.captureId || !params.captureId.trim()) {
          throw new LedgerError('captureId is required when confirming a captured payment');
        }
        newState = 'COMPLETED';
        newCaptureId = params.captureId.trim();
      } else {
        newState = 'RECONCILED_CANCELLED';
      }

      const now = new Date().toISOString();
      db.prepare(
        `UPDATE payment_records
         SET state = ?,
             capture_id = ?,
             reconciliation_note = ?,
             updated_at = ?
         WHERE receipt_hash = ?`
      ).run(newState, newCaptureId, params.operatorNote.trim(), now, params.receiptHash);

      const updatedRow = db
        .prepare('SELECT * FROM payment_records WHERE receipt_hash = ?')
        .get(params.receiptHash) as Record<string, unknown>;
      const updatedRecord = mapRowToPaymentRecord(updatedRow);

      if (params.appendLedgerEvent) {
        const currentEvents = readAndVerifyLedgerUnlocked(this.ledgerFilePath, db);
        const { events, newEvent } = insertLedgerEventIntoDb(db, currentEvents, {
          eventType: 'paypal_manual_reconciliation',
          timestamp: now,
          payload: {
            receipt_hash: params.receiptHash,
            resolution: params.resolution,
            resulting_state: updatedRecord.state,
            capture_id: updatedRecord.capture_id,
            operator_note: updatedRecord.reconciliation_note || '',
          },
        });
        syncCanonicalJsonlExportIfRequested(this.ledgerFilePath, events);
        return { record: updatedRecord, events, newEvent };
      }

      return { record: updatedRecord };
    });
  }
}
