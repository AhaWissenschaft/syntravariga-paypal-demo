import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeInvoice, InvoiceData } from './invoiceGuard';

function createValidInvoice(): InvoiceData {
  return {
    expected_vendor: 'Acme Research Corp',
    vendor: 'Acme Research Corp',
    expected_amount: '119.00',
    amount: '119.00',
    net_amount: '100.00',
    tax_amount: '19.00',
    gross_amount: '119.00',
    invoice_number: 'INV-2026-001',
  };
}

test('valid matching invoice returns FIELDS_CONSISTENT with 0 findings', () => {
  const inv = createValidInvoice();
  const res = analyzeInvoice(inv);
  assert.equal(res.status, 'FIELDS_CONSISTENT');
  assert.equal(res.findings.length, 0);
  assert.ok(res.parsed_amounts);
  assert.equal(res.parsed_amounts.gross_cents, 11900);
});

test('Unicode NFKC normalization matches canonically equivalent supplier names (e.g. NFD vs NFC)', () => {
  const inv = createValidInvoice();
  // "Müller GmbH" in NFC vs NFD ("Mu\u0308ller GmbH")
  inv.expected_vendor = 'M\u00FCller GmbH';
  inv.vendor = 'Mu\u0308ller  GmbH';
  const res = analyzeInvoice(inv);
  assert.equal(res.status, 'FIELDS_CONSISTENT');
  assert.equal(res.findings.length, 0);
});

test('vendor mismatch triggers VENDOR_MISMATCH and REVIEW_REQUIRED', () => {
  const inv = createValidInvoice();
  inv.vendor = 'Malicious Impersonator Ltd';
  const res = analyzeInvoice(inv);
  assert.equal(res.status, 'REVIEW_REQUIRED');
  assert.ok(res.findings.some((f) => f.code === 'VENDOR_MISMATCH'));
});

test('arithmetic mismatch net + tax != gross triggers TOTAL_MISMATCH', () => {
  const inv = createValidInvoice();
  inv.gross_amount = '125.00';
  inv.amount = '125.00';
  inv.expected_amount = '125.00';
  // net 100 + tax 19 != gross 125
  const res = analyzeInvoice(inv);
  assert.equal(res.status, 'REVIEW_REQUIRED');
  assert.ok(res.findings.some((f) => f.code === 'TOTAL_MISMATCH'));
});

test('expected amount mismatch triggers EXPECTED_AMOUNT_MISMATCH', () => {
  const inv = createValidInvoice();
  inv.amount = '120.00';
  const res = analyzeInvoice(inv);
  assert.equal(res.status, 'REVIEW_REQUIRED');
  assert.ok(res.findings.some((f) => f.code === 'EXPECTED_AMOUNT_MISMATCH'));
});

test('negative, non-numeric, and leading-zero ("007") amounts fail closed', () => {
  const invNeg = createValidInvoice();
  invNeg.amount = '-50.00';
  const resNeg = analyzeInvoice(invNeg);
  assert.equal(resNeg.status, 'REVIEW_REQUIRED');
  assert.ok(resNeg.findings.some((f) => f.code === 'INVALID_AMOUNT'));

  const invLeadingZero = createValidInvoice();
  invLeadingZero.amount = '007.00';
  const resLZ = analyzeInvoice(invLeadingZero);
  assert.equal(resLZ.status, 'REVIEW_REQUIRED');
  assert.ok(resLZ.findings.some((f) => f.code === 'INVALID_AMOUNT'));
});

test('detects duplicate invoices (DUPLICATE_INVOICE) and audits multi-invoice batches', async () => {
  const { analyzeInvoiceBatch, computeInvoiceReferenceDigest } = await import('./invoiceGuard');
  const inv = createValidInvoice();
  const digest = computeInvoiceReferenceDigest(inv.vendor, inv.invoice_number);

  const dupRes = analyzeInvoice(inv, { seenInvoiceRefDigests: new Set([digest]) });
  assert.equal(dupRes.status, 'REVIEW_REQUIRED');
  assert.ok(dupRes.findings.some((f) => f.code === 'DUPLICATE_INVOICE'));

  const batchSummary = analyzeInvoiceBatch([
    { ...inv, id: '1', label: 'Original' },
    { ...inv, id: '2', label: 'Duplicate in same batch' },
  ]);
  assert.equal(batchSummary.total_count, 2);
  assert.equal(batchSummary.consistent_count, 1);
  assert.equal(batchSummary.blocked_count, 1);
  assert.equal(batchSummary.total_verified_payable_eur, '119.00');
  assert.equal(batchSummary.total_blocked_risk_eur, '119.00');
});
