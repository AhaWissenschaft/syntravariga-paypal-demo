/**
 * @license
 * SyntraVariga / AhaWissenschaft Research Framework
 * Module: AI Invoice Text Extractor & Uncertainty Detector (Section 3 & 6.1)
 *
 * Why this file exists:
 * Translates free-form fictitious invoice text into structured field proposals
 * (`vendor`, `invoice_number`, `net_amount`, `tax_amount`, `gross_amount`, `amount`)
 * while surfacing explicit uncertainty flags:
 * - "Field not found"
 * - "Multiple candidate amounts found"
 * - "Manual review required"
 *
 * Architectural Boundary:
 * Output from this module is strictly a PROPOSAL (`requires_human_confirmation: true`).
 * The human user must inspect and confirm/edit the proposed fields before the
 * deterministic rules (`invoiceGuard.ts`) evaluate them.
 */

import { sha256Canonical, sha256Hex } from './crypto';

export interface ProposedInvoiceFields {
  vendor: string;
  invoice_number: string;
  net_amount: string;
  tax_amount: string;
  gross_amount: string;
  amount: string;
}

export interface AmbiguousFieldNotice {
  field: string;
  candidates: string[];
  note: string;
}

export interface AiInvoiceExtractionResult {
  schema: 'aha.syntravariga.ai-invoice-proposal.v1';
  provider_mode: 'LIVE_GEMINI_API' | 'LOCAL_DETERMINISTIC_PARSER_FALLBACK';
  model_id: string;
  requires_human_confirmation: true;
  input_text_sha256: string;
  proposal_sha256: string;
  proposed_fields: ProposedInvoiceFields;
  warnings: string[];
  missing_fields: string[];
  ambiguous_fields: AmbiguousFieldNotice[];
  extractor_notes: string;
}

/**
 * Built-in fictitious demo scenarios in English for hackathon judging.
 */
export const INVOICE_TEXT_SCENARIOS = {
  sceneB_consistent: {
    label: 'Scenario B: Consistent Sample (119.00 EUR)',
    expected_vendor: 'Beispieltechnik GmbH',
    expected_amount: '119.00',
    raw_text: [
      'Invoice No.: R-1042',
      '',
      'Supplier: Beispieltechnik GmbH',
      'Description: Server Rack Maintenance Fee Q4 (Fictitious Demo)',
      'Net Amount: 100.00 EUR',
      'VAT (19%): 19.00 EUR',
      'Total Amount (Gross): 119.00 EUR',
    ].join('\n'),
  },
  sceneA_discrepancy: {
    label: 'Scenario A: Discrepancy (Invoice 149.00 EUR vs. Order 119.00 EUR)',
    expected_vendor: 'Beispieltechnik GmbH',
    expected_amount: '119.00',
    raw_text: [
      'Invoice No.: R-1043',
      '',
      'Supplier: Beispieltechnik GmbH',
      'Description: Server Rack Maintenance incl. Unapproved Express Surcharge',
      'Net Amount: 125.21 EUR',
      'VAT (19%): 23.79 EUR',
      'Total Amount (Gross): 149.00 EUR',
    ].join('\n'),
  },
  missingAmount: {
    label: 'Edge Case 1: Missing Field (VAT Amount Missing)',
    expected_vendor: 'Beispieltechnik GmbH',
    expected_amount: '119.00',
    raw_text: [
      'Invoice No.: R-1044',
      '',
      'Supplier: Beispieltechnik GmbH',
      'Net Amount: 100.00 EUR',
      'VAT / Tax: ---',
      'Total Amount (Gross): 119.00 EUR',
    ].join('\n'),
  },
  ambiguousTotals: {
    label: 'Edge Case 2: Conflicting Total Amounts in Invoice Text',
    expected_vendor: 'Beispieltechnik GmbH',
    expected_amount: '119.00',
    raw_text: [
      'Invoice No.: R-1045',
      '',
      'Supplier: Beispieltechnik GmbH',
      'Net Amount: 100.00 EUR',
      'VAT (19%): 19.00 EUR',
      'Total Amount (Gross): 119.00 EUR',
      'Revised Payable Amount (Gross): 149.00 EUR',
    ].join('\n'),
  },
};

/**
 * Normalizes German or English currency strings like "119,00 EUR", "1.250,50", or "1,250.50" -> "119.00" / "1250.50".
 */
export function normalizeExtractedAmount(raw: string): string {
  const cleaned = raw
    .replace(/EUR|€|\s/gi, '')
    .trim();
  if (!cleaned) return '';

  // Handle English thousands comma + decimal dot (e.g. 1,250.50 -> 1250.50)
  if (/^\d{1,3}(,\d{3})+\.\d{1,2}$/.test(cleaned)) {
    const [whole, frac] = cleaned.replace(/,/g, '').split('.');
    return `${whole}.${frac.padEnd(2, '0')}`;
  }

  // Handle German thousands dot + decimal comma (e.g. 1.250,50 -> 1250.50)
  if (/^\d{1,3}(\.\d{3})+,\d{1,2}$/.test(cleaned)) {
    const [whole, frac] = cleaned.replace(/\./g, '').split(',');
    return `${whole}.${frac.padEnd(2, '0')}`;
  }

  // Handle simple decimal comma (e.g. 119,00 -> 119.00)
  if (/^\d+,\d{1,2}$/.test(cleaned)) {
    const [whole, frac] = cleaned.split(',');
    return `${whole}.${frac.padEnd(2, '0')}`;
  }

  // Handle standard dot decimal (e.g. 119.00)
  if (/^\d+(\.\d{1,2})?$/.test(cleaned)) {
    const [whole, frac] = cleaned.split('.');
    return `${whole}.${(frac || '00').padEnd(2, '0')}`;
  }

  return cleaned;
}

/**
 * Deterministic invoice text extractor & uncertainty auditor.
 * Supports both English and German structured invoice text labels.
 * Used both as a safety guardrail on AI outputs (to guarantee missing/ambiguous amounts are never hidden)
 * and as a clearly labeled non-AI fallback when external AI opt-in is off or no API key is configured.
 */
export function extractInvoiceFieldsDeterministic(rawText: string): Omit<
  AiInvoiceExtractionResult,
  'provider_mode' | 'model_id' | 'proposal_sha256'
> {
  if (typeof rawText !== 'string' || !rawText.trim()) {
    throw new Error('Invoice text must not be empty.');
  }

  const lines = rawText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  let vendor = '';
  let invoiceNumber = '';
  const netCandidates: string[] = [];
  const taxCandidates: string[] = [];
  const grossCandidates: string[] = [];

  for (const line of lines) {
    // Invoice number patterns (EN + DE)
    const invMatch = line.match(
      /(?:Rechnung\s*(?:Nr\.?|Nummer)?|Invoice\s*(?:No\.?|Number|#)?|Beleg(?:-Nr\.?)?)\s*[:#]?\s*([A-Za-z0-9._/-]{2,64})/i
    );
    if (invMatch && !invoiceNumber) {
      invoiceNumber = invMatch[1].trim();
      continue;
    }

    // Supplier / Vendor patterns (EN + DE)
    const vendorMatch = line.match(
      /(?:Lieferant|Aussteller|Rechnungssteller|Vendor|Supplier|Firma)\s*[:]\s*(.+)$/i
    );
    if (vendorMatch && !vendor) {
      vendor = vendorMatch[1].trim();
      continue;
    }

    // Net amount patterns (EN + DE)
    if (/(?:^|\b)(?:Netto|Nettobetrag|Net(?:\s*Amount)?|Subtotal|Zwischensumme)\b/i.test(line)) {
      const m = line.match(/(\d[\d.,]*)\s*(?:EUR|€)?/i);
      if (m) {
        const norm = normalizeExtractedAmount(m[1]);
        if (norm) netCandidates.push(norm);
      }
      continue;
    }

    // Tax amount patterns (ignore percentage inside parentheses like "(19%)")
    if (/(?:^|\b)(?:Umsatzsteuer|MwSt\.?|Steuer|Steuerbetrag|VAT|Tax)\b/i.test(line)) {
      const withoutPct = line.replace(/\(\s*\d+(?:[.,]\d+)?\s*%\s*\)/g, '');
      const m =
        withoutPct.match(/[:]\s*(\d[\d.,]*)\s*(?:EUR|€)?/i) ||
        withoutPct.match(/(\d[\d.,]*\d)\s*(?:EUR|€)?/i);
      if (m) {
        const norm = normalizeExtractedAmount(m[1]);
        if (norm) taxCandidates.push(norm);
      }
      continue;
    }

    // Gross / Total amount patterns (EN + DE)
    if (
      /(?:^|\b)(?:Gesamtbetrag|Brutto|Bruttobetrag|Rechnungsbetrag|Zahlbetrag|Total(?:\s*Amount)?|Payable(?:\s*Amount)?|Gross(?:\s*Amount)?)\b/i.test(
        line
      )
    ) {
      const m = line.match(/(\d[\d.,]*)\s*(?:EUR|€)?/i);
      if (m) {
        const norm = normalizeExtractedAmount(m[1]);
        if (norm) grossCandidates.push(norm);
      }
      continue;
    }
  }

  const uniqueNet = Array.from(new Set(netCandidates));
  const uniqueTax = Array.from(new Set(taxCandidates));
  const uniqueGross = Array.from(new Set(grossCandidates));

  const missingFields: string[] = [];
  const ambiguousFields: AmbiguousFieldNotice[] = [];
  const warningSet = new Set<string>();

  if (!vendor) missingFields.push('vendor');
  if (!invoiceNumber) missingFields.push('invoice_number');
  if (uniqueNet.length === 0) missingFields.push('net_amount');
  if (uniqueTax.length === 0) missingFields.push('tax_amount');
  if (uniqueGross.length === 0) missingFields.push('gross_amount');

  if (missingFields.length > 0) {
    warningSet.add('Field not found');
    warningSet.add('Manual review required');
  }

  if (uniqueNet.length > 1) {
    ambiguousFields.push({
      field: 'net_amount',
      candidates: uniqueNet,
      note: `Multiple net amounts detected in text: ${uniqueNet.join(' EUR vs. ')} EUR`,
    });
  }
  if (uniqueTax.length > 1) {
    ambiguousFields.push({
      field: 'tax_amount',
      candidates: uniqueTax,
      note: `Multiple tax amounts detected in text: ${uniqueTax.join(' EUR vs. ')} EUR`,
    });
  }
  if (uniqueGross.length > 1) {
    ambiguousFields.push({
      field: 'gross_amount',
      candidates: uniqueGross,
      note: `Multiple conflicting total/gross amounts detected in text: ${uniqueGross.join(' EUR vs. ')} EUR`,
    });
  }

  if (ambiguousFields.length > 0) {
    warningSet.add('Multiple candidate amounts found');
    warningSet.add('Manual review required');
  }

  // If gross is ambiguous, do NOT silently pick one as unambiguous; leave empty to require explicit selection
  const grossVal = uniqueGross.length === 1 ? uniqueGross[0] : '';
  const netVal = uniqueNet.length === 1 ? uniqueNet[0] : '';
  const taxVal = uniqueTax.length === 1 ? uniqueTax[0] : '';

  const proposedFields: ProposedInvoiceFields = {
    vendor,
    invoice_number: invoiceNumber,
    net_amount: netVal,
    tax_amount: taxVal,
    gross_amount: grossVal,
    amount: grossVal,
  };

  const warnings = Array.from(warningSet);
  const extractorNotes =
    warnings.length === 0
      ? 'All structured invoice fields were unambiguously proposed. Please verify and confirm manually before deterministic rule evaluation.'
      : `Uncertainties detected (${warnings.join(' · ')}). Missing or ambiguous values were flagged and require manual completion or selection before rule evaluation.`;

  return {
    schema: 'aha.syntravariga.ai-invoice-proposal.v1',
    requires_human_confirmation: true,
    input_text_sha256: sha256Hex(rawText),
    proposed_fields: proposedFields,
    warnings,
    missing_fields: missingFields,
    ambiguous_fields: ambiguousFields,
    extractor_notes: extractorNotes,
  };
}

/**
 * Builds the Gemini prompt for extracting structured invoice fields and uncertainty warnings.
 */
export function buildAiInvoiceExtractionPrompt(rawText: string): {
  systemInstruction: string;
  userPrompt: string;
} {
  const systemInstruction = [
    'You are a precision invoice-field extraction assistant in the SyntraVariga Invoice & Payment Guard framework.',
    'Your task is to propose structured fields from a user-supplied fictitious invoice text (English or German):',
    '- vendor (Supplier name)',
    '- invoice_number (Invoice reference number)',
    '- net_amount (Net amount as decimal string with dot, e.g. "100.00", or "" if missing/ambiguous)',
    '- tax_amount (Tax/VAT amount as decimal string with dot, e.g. "19.00", or "" if missing/ambiguous)',
    '- gross_amount (Total/Gross amount as decimal string with dot, e.g. "119.00", or "" if missing/ambiguous)',
    '- amount (Payable invoice amount as decimal string with dot, e.g. "119.00", or "" if missing/ambiguous)',
    '',
    'STRICT ANTI-HALLUCINATION RULES:',
    '1. NEVER invent or infer values that are not explicitly stated in the text (for example, do not compute missing VAT from Net and Gross).',
    '2. If any field is missing or marked "---" / "N/A", leave that field as "" and include "Field not found" and "Manual review required" in warnings.',
    '3. If multiple conflicting gross/total amounts appear in the text, do NOT silently pick one; leave gross_amount and amount as "", and include "Multiple candidate amounts found" and "Manual review required" in warnings.',
    '4. Respond with English extractor_notes summarizing what was extracted and what requires human review.',
  ].join('\n');

  return {
    systemInstruction,
    userPrompt: rawText,
  };
}
