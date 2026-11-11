import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractInvoiceFieldsDeterministic,
  INVOICE_TEXT_SCENARIOS,
} from './aiInvoiceExtractor';

describe('AI Invoice Text Extractor & Uncertainty Flags (Section 6.1 Acceptance)', () => {
  it('accurately proposes fields for a consistent English scenario invoice (Scene B)', () => {
    const res = extractInvoiceFieldsDeterministic(
      INVOICE_TEXT_SCENARIOS.sceneB_consistent.raw_text
    );
    assert.equal(res.requires_human_confirmation, true);
    assert.equal(res.proposed_fields.vendor, 'Beispieltechnik GmbH');
    assert.equal(res.proposed_fields.invoice_number, 'R-1042');
    assert.equal(res.proposed_fields.net_amount, '100.00');
    assert.equal(res.proposed_fields.tax_amount, '19.00');
    assert.equal(res.proposed_fields.gross_amount, '119.00');
    assert.equal(res.proposed_fields.amount, '119.00');
    assert.deepEqual(res.warnings, []);
    assert.deepEqual(res.missing_fields, []);
  });

  it('accurately proposes fields for Scene A discrepancy invoice (149.00 EUR) and German format invoices', () => {
    const res = extractInvoiceFieldsDeterministic(
      INVOICE_TEXT_SCENARIOS.sceneA_discrepancy.raw_text
    );
    assert.equal(res.proposed_fields.vendor, 'Beispieltechnik GmbH');
    assert.equal(res.proposed_fields.invoice_number, 'R-1043');
    assert.equal(res.proposed_fields.gross_amount, '149.00');
    assert.equal(res.proposed_fields.amount, '149.00');
    assert.deepEqual(res.warnings, []);

    const deRes = extractInvoiceFieldsDeterministic(
      [
        'Rechnung Nr. R-2099',
        'Lieferant: Beispieltechnik GmbH',
        'Netto: 1.000,00 EUR',
        'Umsatzsteuer (19%): 190,00 EUR',
        'Gesamtbetrag: 1.190,00 EUR',
      ].join('\n')
    );
    assert.equal(deRes.proposed_fields.net_amount, '1000.00');
    assert.equal(deRes.proposed_fields.tax_amount, '190.00');
    assert.equal(deRes.proposed_fields.gross_amount, '1190.00');
    assert.deepEqual(deRes.warnings, []);
  });

  it('flags missing amount as incomplete ("Field not found", "Manual review required") without inventing values', () => {
    const res = extractInvoiceFieldsDeterministic(
      INVOICE_TEXT_SCENARIOS.missingAmount.raw_text
    );
    assert.equal(res.proposed_fields.tax_amount, '');
    assert.ok(res.missing_fields.includes('tax_amount'));
    assert.ok(res.warnings.includes('Field not found'));
    assert.ok(res.warnings.includes('Manual review required'));
  });

  it('flags two conflicting total amounts ("Multiple candidate amounts found") without silently picking one', () => {
    const res = extractInvoiceFieldsDeterministic(
      INVOICE_TEXT_SCENARIOS.ambiguousTotals.raw_text
    );
    // Must not silently output a single amount when two conflicting totals exist
    assert.equal(res.proposed_fields.gross_amount, '');
    assert.equal(res.proposed_fields.amount, '');
    assert.ok(res.warnings.includes('Multiple candidate amounts found'));
    assert.ok(res.warnings.includes('Manual review required'));
    assert.equal(res.ambiguous_fields.length, 1);
    assert.deepEqual(res.ambiguous_fields[0].candidates, ['119.00', '149.00']);
  });
});
