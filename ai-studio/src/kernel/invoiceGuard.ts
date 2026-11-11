/**
 * @license
 * SyntraVariga / AhaWissenschaft Research Framework
 * Module: Deterministic Invoice & Transaction Verification Guard
 *
 * Why this file exists:
 * Performs deterministic, fail-closed comparison of invoice fields and arithmetic.
 * Uses integer-cents arithmetic to eliminate binary floating-point rounding drift
 * in monetary sums ($Netto_{cent} + Steuer_{cent} === Brutto_{cent}$).
 * Also detects duplicate invoice references (`DUPLICATE_INVOICE`) across batches
 * or against previously verified ledger entries to prevent double payments.
 * Informational and audit-oriented; does not authorize payments.
 */

import { sha256Hex } from './crypto';

export type FindingCode =
  | 'MISSING_FIELD'
  | 'VENDOR_MISMATCH'
  | 'EXPECTED_AMOUNT_MISMATCH'
  | 'TOTAL_MISMATCH'
  | 'INVALID_AMOUNT'
  | 'INVALID_INVOICE_NUMBER'
  | 'DUPLICATE_INVOICE';

export interface InvoiceFinding {
  code: FindingCode;
  field: string;
  message: string;
}

export interface InvoiceData {
  expected_vendor: string;
  vendor: string;
  expected_amount: string;
  amount: string;
  net_amount: string;
  tax_amount: string;
  gross_amount: string;
  invoice_number: string;
}

export interface InvoiceAnalysisResult {
  status: 'FIELDS_CONSISTENT' | 'REVIEW_REQUIRED';
  findings: InvoiceFinding[];
  explanation: string;
  verified_amount_eur?: string;
  invoice_ref_sha256?: string;
  parsed_amounts?: {
    expected_amount_cents: number;
    amount_cents: number;
    net_cents: number;
    tax_cents: number;
    gross_cents: number;
    difference_cents: number;
  };
}

export interface BatchInvoiceItem extends InvoiceData {
  id: string;
  label: string;
}

export interface BatchInvoiceAuditSummary {
  total_count: number;
  consistent_count: number;
  blocked_count: number;
  total_requested_eur: string;
  total_verified_payable_eur: string;
  total_blocked_risk_eur: string;
  results: Array<{
    id: string;
    label: string;
    invoice_number: string;
    vendor: string;
    amount: string;
    expected_amount: string;
    analysis: InvoiceAnalysisResult;
  }>;
}

const MAX_CENTS = 10_000_000 * 100; // €10,000,000 limit

/**
 * Formats integer cents as a strict 2-decimal EUR string (e.g. 11900 -> "119.00").
 */
export function formatCentsToEur(cents: number): string {
  const abs = Math.abs(Math.trunc(cents));
  const whole = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, '0');
  return `${cents < 0 ? '-' : ''}${whole}.${frac}`;
}

/**
 * Normalizes supplier / vendor strings using Unicode NFKC normalization,
 * whitespace collapsing, and case-folding before comparison.
 */
export function normalizeVendorText(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

/**
 * Computes a privacy-preserving SHA-256 fingerprint of (normalized vendor + normalized invoice_number)
 * so duplicate invoices can be detected in the ledger without storing raw vendor or invoice strings.
 */
export function computeInvoiceReferenceDigest(vendor: unknown, invoiceNumber: unknown): string {
  const normVendor = normalizeVendorText(vendor);
  const normInv =
    typeof invoiceNumber === 'string'
      ? invoiceNumber.normalize('NFKC').trim().toUpperCase()
      : '';
  return sha256Hex(`${normVendor}::${normInv}`);
}

/**
 * Parses a decimal string representation into integer cents.
 * Rejects leading zeros (like "007"), exponential notations, NaN, negatives, or >2 decimal places.
 */
export function parseCents(
  raw: unknown,
  fieldName: string,
  findings: InvoiceFinding[]
): number | null {
  if (typeof raw !== 'string') {
    findings.push({
      code: 'INVALID_AMOUNT',
      field: fieldName,
      message: `${fieldName} must be a valid numeric string.`,
    });
    return null;
  }

  const s = raw.trim();
  // Disallow leading zeros on whole numbers > 0 (e.g. "007" is rejected; "0" or "0.50" is allowed)
  if (!s || !/^(0|[1-9]\d*)(\.\d{1,2})?$/.test(s)) {
    findings.push({
      code: 'INVALID_AMOUNT',
      field: fieldName,
      message: `${fieldName} must be a non-negative finite amount without leading zeros and with at most two decimal places.`,
    });
    return null;
  }

  const parts = s.split('.');
  const whole = parseInt(parts[0], 10);
  const frac = parts[1] ? parts[1].padEnd(2, '0').slice(0, 2) : '00';
  const cents = whole * 100 + parseInt(frac, 10);

  if (cents < 0 || cents > MAX_CENTS || !Number.isSafeInteger(cents)) {
    findings.push({
      code: 'INVALID_AMOUNT',
      field: fieldName,
      message: `${fieldName} exceeds acceptable bounds (0 to 10,000,000 EUR).`,
    });
    return null;
  }

  return cents;
}

/**
 * Analyzes invoice data deterministically.
 * Optional `seenInvoiceRefDigests` allows detecting duplicate invoices (`DUPLICATE_INVOICE`).
 */
export function analyzeInvoice(
  data: Partial<InvoiceData>,
  options?: { seenInvoiceRefDigests?: ReadonlySet<string> }
): InvoiceAnalysisResult {
  if (!data || typeof data !== 'object') {
    throw new TypeError('Invoice data must be an object');
  }

  const findings: InvoiceFinding[] = [];
  const requiredFields: (keyof InvoiceData)[] = [
    'expected_vendor',
    'vendor',
    'expected_amount',
    'amount',
    'net_amount',
    'tax_amount',
    'gross_amount',
    'invoice_number',
  ];

  for (const field of requiredFields) {
    const val = data[field];
    if (typeof val !== 'string' || !val.trim()) {
      findings.push({
        code: 'MISSING_FIELD',
        field,
        message: `Mandatory field '${field}' is missing or empty.`,
      });
    }
  }

  const expectedVendor = normalizeVendorText(data.expected_vendor);
  const vendor = normalizeVendorText(data.vendor);

  if (expectedVendor && vendor && expectedVendor !== vendor) {
    findings.push({
      code: 'VENDOR_MISMATCH',
      field: 'vendor',
      message:
        'Supplier on invoice does not match the expected purchase order supplier. Please verify.',
    });
  }

  const expAmountCents = parseCents(data.expected_amount, 'expected_amount', findings);
  const amountCents = parseCents(data.amount, 'amount', findings);
  const netCents = parseCents(data.net_amount, 'net_amount', findings);
  const taxCents = parseCents(data.tax_amount, 'tax_amount', findings);
  const grossCents = parseCents(data.gross_amount, 'gross_amount', findings);

  if (expAmountCents !== null && amountCents !== null && expAmountCents !== amountCents) {
    const diffEur = formatCentsToEur(Math.abs(amountCents - expAmountCents));
    findings.push({
      code: 'EXPECTED_AMOUNT_MISMATCH',
      field: 'amount',
      message: `Billed invoice amount (${formatCentsToEur(amountCents)} EUR) differs by ${diffEur} EUR from the purchase order (${formatCentsToEur(expAmountCents)} EUR). Please verify.`,
    });
  }

  if (netCents !== null && taxCents !== null && grossCents !== null) {
    if (netCents + taxCents !== grossCents) {
      findings.push({
        code: 'TOTAL_MISMATCH',
        field: 'gross_amount',
        message: `Net plus tax (${formatCentsToEur(netCents + taxCents)} EUR) does not equal the stated gross amount (${formatCentsToEur(grossCents)} EUR). Please verify.`,
      });
    }
  }

  if (amountCents !== null && grossCents !== null && amountCents !== grossCents) {
    findings.push({
      code: 'TOTAL_MISMATCH',
      field: 'amount',
      message: `Payment amount (${formatCentsToEur(amountCents)} EUR) does not match stated invoice gross amount (${formatCentsToEur(grossCents)} EUR). Please verify.`,
    });
  }

  const invoiceNumber =
    typeof data.invoice_number === 'string' ? data.invoice_number.normalize('NFKC').trim() : '';
  if (invoiceNumber.length > 100) {
    findings.push({
      code: 'INVALID_INVOICE_NUMBER',
      field: 'invoice_number',
      message: 'Invoice number exceeds the 100-character limit.',
    });
  }

  const invoiceRefSha256 =
    vendor && invoiceNumber ? computeInvoiceReferenceDigest(data.vendor, invoiceNumber) : undefined;

  if (
    invoiceRefSha256 &&
    options?.seenInvoiceRefDigests &&
    options.seenInvoiceRefDigests.has(invoiceRefSha256)
  ) {
    findings.push({
      code: 'DUPLICATE_INVOICE',
      field: 'invoice_number',
      message: `Duplicate reference detected: an invoice with reference '${invoiceNumber}' for the same supplier has already been verified. Duplicate payment blocked.`,
    });
  }

  const status = findings.length === 0 ? 'FIELDS_CONSISTENT' : 'REVIEW_REQUIRED';

  const explanation =
    status === 'FIELDS_CONSISTENT'
      ? 'Confirmed fields pass all deterministic arithmetic and purchase-order rules. This formal consistency check does not prove invoice authenticity.'
      : 'Discrepancy or incomplete data detected in the confirmed fields. The downstream PayPal Sandbox payment path remains locked.';

  return {
    status,
    findings,
    explanation,
    verified_amount_eur:
      status === 'FIELDS_CONSISTENT' && amountCents !== null && amountCents > 0
        ? formatCentsToEur(amountCents)
        : undefined,
    invoice_ref_sha256: invoiceRefSha256,
    parsed_amounts:
      expAmountCents !== null &&
      amountCents !== null &&
      netCents !== null &&
      taxCents !== null &&
      grossCents !== null
        ? {
            expected_amount_cents: expAmountCents,
            amount_cents: amountCents,
            net_cents: netCents,
            tax_cents: taxCents,
            gross_cents: grossCents,
            difference_cents: amountCents - expAmountCents,
          }
        : undefined,
  };
}

/**
 * Evaluates a batch of SMB invoices simultaneously, automatically detecting
 * cross-batch duplicates (`DUPLICATE_INVOICE`), overbilling (`EXPECTED_AMOUNT_MISMATCH`),
 * tax calculation errors (`TOTAL_MISMATCH`), and supplier spoofing (`VENDOR_MISMATCH`).
 */
export function analyzeInvoiceBatch(
  items: BatchInvoiceItem[],
  existingLedgerDigests: ReadonlySet<string> = new Set()
): BatchInvoiceAuditSummary {
  const seenDigests = new Set<string>(existingLedgerDigests);
  let consistentCount = 0;
  let blockedCount = 0;
  let totalRequestedCents = 0;
  let totalVerifiedPayableCents = 0;
  let totalBlockedRiskCents = 0;

  const results = items.map((item) => {
    const analysis = analyzeInvoice(item, { seenInvoiceRefDigests: seenDigests });
    if (analysis.invoice_ref_sha256) {
      seenDigests.add(analysis.invoice_ref_sha256);
    }

    const itemCents = analysis.parsed_amounts?.amount_cents ?? 0;
    totalRequestedCents += itemCents;

    if (analysis.status === 'FIELDS_CONSISTENT') {
      consistentCount += 1;
      totalVerifiedPayableCents += itemCents;
    } else {
      blockedCount += 1;
      totalBlockedRiskCents += itemCents;
    }

    return {
      id: item.id,
      label: item.label,
      invoice_number: item.invoice_number,
      vendor: item.vendor,
      amount: item.amount,
      expected_amount: item.expected_amount,
      analysis,
    };
  });

  return {
    total_count: items.length,
    consistent_count: consistentCount,
    blocked_count: blockedCount,
    total_requested_eur: formatCentsToEur(totalRequestedCents),
    total_verified_payable_eur: formatCentsToEur(totalVerifiedPayableCents),
    total_blocked_risk_eur: formatCentsToEur(totalBlockedRiskCents),
    results,
  };
}
