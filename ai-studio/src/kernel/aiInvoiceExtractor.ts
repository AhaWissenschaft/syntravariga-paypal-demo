/**
 * @license
 * SyntraVariga / AhaWissenschaft Research Framework
 * Module: AI Invoice Text Extractor & Uncertainty Detector (Section 3 & 6.1)
 *
 * Why this file exists:
 * Translates free-form fictitious invoice text into structured field proposals
 * (`vendor`, `invoice_number`, `net_amount`, `tax_amount`, `gross_amount`, `amount`)
 * while surfacing explicit uncertainty flags:
 * - "Angabe nicht gefunden"
 * - "Mehrere mögliche Beträge gefunden"
 * - "Bitte manuell prüfen"
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
 * Built-in demo scenarios matching Section 3 & Section 4 of the Hackathon Plan.
 */
export const INVOICE_TEXT_SCENARIOS = {
  sceneB_consistent: {
    label: 'Szene B: Konsistentes Beispiel (119,00 EUR)',
    expected_vendor: 'Beispieltechnik GmbH',
    expected_amount: '119.00',
    raw_text: [
      'Rechnung Nr. R-1042',
      '',
      'Lieferant: Beispieltechnik GmbH',
      'Leistung: Wartungspauschale Server-Rack Q4',
      'Netto: 100,00 EUR',
      'Umsatzsteuer (19%): 19,00 EUR',
      'Gesamtbetrag: 119,00 EUR',
    ].join('\n'),
  },
  sceneA_discrepancy: {
    label: 'Szene A: Abweichung (Rechnung 149,00 € vs. Bestellung 119,00 €)',
    expected_vendor: 'Beispieltechnik GmbH',
    expected_amount: '119.00',
    raw_text: [
      'Rechnung Nr. R-1043',
      '',
      'Lieferant: Beispieltechnik GmbH',
      'Leistung: Wartungspauschale inkl. Express-Zuschlag',
      'Netto: 125,21 EUR',
      'Umsatzsteuer (19%): 23,79 EUR',
      'Gesamtbetrag: 149,00 EUR',
    ].join('\n'),
  },
  missingAmount: {
    label: 'Edge-Case 1: Fehlende Angabe (Steuerbetrag fehlt)',
    expected_vendor: 'Beispieltechnik GmbH',
    expected_amount: '119.00',
    raw_text: [
      'Rechnung Nr. R-1044',
      '',
      'Lieferant: Beispieltechnik GmbH',
      'Netto: 100,00 EUR',
      'Umsatzsteuer: ---',
      'Gesamtbetrag: 119,00 EUR',
    ].join('\n'),
  },
  ambiguousTotals: {
    label: 'Edge-Case 2: Mehrdeutige Gesamtbeträge im Text',
    expected_vendor: 'Beispieltechnik GmbH',
    expected_amount: '119.00',
    raw_text: [
      'Rechnung Nr. R-1045',
      '',
      'Lieferant: Beispieltechnik GmbH',
      'Netto: 100,00 EUR',
      'Umsatzsteuer: 19,00 EUR',
      'Gesamtbetrag: 119,00 EUR',
      'Zahlbetrag laut Nachtrag (Brutto): 149,00 EUR',
    ].join('\n'),
  },
};

/**
 * Normalizes German or English currency strings like "119,00 EUR" or "1.250,50" -> "119.00" / "1250.50".
 */
export function normalizeExtractedAmount(raw: string): string {
  const cleaned = raw
    .replace(/EUR|€|\s/gi, '')
    .trim();
  if (!cleaned) return '';

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
 * Used both as a safety guardrail on AI outputs (to guarantee missing/ambiguous amounts are never hidden)
 * and as a clearly labeled fallback if no external Gemini API key is configured.
 */
export function extractInvoiceFieldsDeterministic(rawText: string): Omit<
  AiInvoiceExtractionResult,
  'provider_mode' | 'model_id' | 'proposal_sha256'
> {
  if (typeof rawText !== 'string' || !rawText.trim()) {
    throw new Error('Rechnungstext darf nicht leer sein.');
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
    // Invoice number patterns
    const invMatch = line.match(
      /(?:Rechnung\s*(?:Nr\.?|Nummer)?|Invoice\s*(?:No\.?|#)?|Beleg(?:-Nr\.?)?)\s*[:#]?\s*([A-Za-z0-9._/-]{2,64})/i
    );
    if (invMatch && !invoiceNumber) {
      invoiceNumber = invMatch[1].trim();
      continue;
    }

    // Supplier / Vendor patterns
    const vendorMatch = line.match(
      /(?:Lieferant|Aussteller|Rechnungssteller|Vendor|Supplier|Firma)\s*[:]\s*(.+)$/i
    );
    if (vendorMatch && !vendor) {
      vendor = vendorMatch[1].trim();
      continue;
    }

    // Net amount patterns
    if (/(?:^|\b)(?:Netto|Nettobetrag|Net\s*Amount|Zwischensumme)/i.test(line)) {
      const m = line.match(/(\d+(?:[.,]\d{1,2})?)\s*(?:EUR|€)?/i);
      if (m) {
        const norm = normalizeExtractedAmount(m[1]);
        if (norm) netCandidates.push(norm);
      }
      continue;
    }

    // Tax amount patterns (ignore percentage inside parentheses like "(19%)")
    if (/(?:^|\b)(?:Umsatzsteuer|MwSt\.?|Steuer|Steuerbetrag|VAT|Tax)/i.test(line)) {
      const withoutPct = line.replace(/\(\s*\d+(?:[.,]\d+)?\s*%\s*\)/g, '');
      const m = withoutPct.match(/[:]\s*(\d+(?:[.,]\d{1,2})?)\s*(?:EUR|€)?/i) ||
        withoutPct.match(/(\d+[.,]\d{2})\s*(?:EUR|€)?/i);
      if (m) {
        const norm = normalizeExtractedAmount(m[1]);
        if (norm) taxCandidates.push(norm);
      }
      continue;
    }

    // Gross / Total amount patterns
    if (
      /(?:^|\b)(?:Gesamtbetrag|Brutto|Bruttobetrag|Rechnungsbetrag|Zahlbetrag|Total|Gross)/i.test(
        line
      )
    ) {
      const m = line.match(/(\d+(?:[.,]\d{1,2})?)\s*(?:EUR|€)?/i);
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
    warningSet.add('Angabe nicht gefunden');
    warningSet.add('Bitte manuell prüfen');
  }

  if (uniqueNet.length > 1) {
    ambiguousFields.push({
      field: 'net_amount',
      candidates: uniqueNet,
      note: `Mehrere Nettobeträge im Text erkannt: ${uniqueNet.join(' EUR vs. ')} EUR`,
    });
  }
  if (uniqueTax.length > 1) {
    ambiguousFields.push({
      field: 'tax_amount',
      candidates: uniqueTax,
      note: `Mehrere Steuerbeträge im Text erkannt: ${uniqueTax.join(' EUR vs. ')} EUR`,
    });
  }
  if (uniqueGross.length > 1) {
    ambiguousFields.push({
      field: 'gross_amount',
      candidates: uniqueGross,
      note: `Mehrere mögliche Gesamt-/Bruttobeträge im Text erkannt: ${uniqueGross.join(' EUR vs. ')} EUR`,
    });
  }

  if (ambiguousFields.length > 0) {
    warningSet.add('Mehrere mögliche Beträge gefunden');
    warningSet.add('Bitte manuell prüfen');
  }

  // If gross is ambiguous, do NOT silently pick one as unambiguous; leave empty or require explicit selection
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
      ? 'Alle strukturierten Rechnungsfelder wurden eindeutig als Vorschlag erkannt. Bitte vor der Regelprüfung menschlich kontrollieren und bestätigen.'
      : `Unsicherheiten erkannt (${warnings.join(' · ')}). Fehlende oder mehrdeutige Angaben wurden markiert und müssen vor der Regelprüfung manuell ergänzt bzw. entschieden werden.`;

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
    'Du bist ein präziser Extraktions-Assistent für Rechnungsentwürfe im SyntraVariga-Framework.',
    'Deine Aufgabe ist es, aus einem eingegebenen fiktiven Rechnungstext strukturierte Felder vorzuschlagen:',
    '- vendor (Lieferant)',
    '- invoice_number (Rechnungsnummer)',
    '- net_amount (Nettobetrag als Dezimalzahl mit Punkt, z. B. "100.00", oder "" falls fehlend/mehrdeutig)',
    '- tax_amount (Steuerbetrag als Dezimalzahl mit Punkt, z. B. "19.00", oder "" falls fehlend/mehrdeutig)',
    '- gross_amount (Brutto-/Gesamtbetrag als Dezimalzahl mit Punkt, z. B. "119.00", oder "" falls fehlend/mehrdeutig)',
    '- amount (Rechnungsbetrag als Dezimalzahl mit Punkt, z. B. "119.00", oder "" falls fehlend/mehrdeutig)',
    '',
    'STRIKTE REGELN GEGEN HALLUZINATIONEN:',
    '1. Erfinde NIEMALS Werte, die nicht im Text stehen.',
    '2. Wenn eine Angabe fehlt, lasse das Feld leer ("") und füge in warnings exakt "Angabe nicht gefunden" sowie "Bitte manuell prüfen" hinzu.',
    '3. Wenn im Text mehrere widersprüchliche Gesamt-/Bruttobeträge stehen, entscheide dich NICHT stillschweigend für einen, sondern lasse gross_amount/amount leer (""), liste die Kandidaten in ambiguous_fields auf und füge in warnings exakt "Mehrere mögliche Beträge gefunden" sowie "Bitte manuell prüfen" hinzu.',
  ].join('\n');

  return {
    systemInstruction,
    userPrompt: rawText,
  };
}
