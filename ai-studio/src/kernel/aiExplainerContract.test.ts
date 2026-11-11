import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateAiExplainRequest,
  buildPrivacyPreservingAiPrompt,
  AiPrivacyBoundaryError,
} from './aiExplainerContract';

const VALID_HASH = 'a'.repeat(64);

describe('AI Finding Explainer Privacy Boundary Contract', () => {
  it('accepts valid FIELDS_CONSISTENT request with empty finding_codes', () => {
    const res = validateAiExplainRequest({
      status: 'FIELDS_CONSISTENT',
      finding_codes: [],
      receipt_hash: VALID_HASH,
    });
    assert.equal(res.status, 'FIELDS_CONSISTENT');
    assert.deepEqual(res.finding_codes, []);
    assert.equal(res.receipt_hash, VALID_HASH);
  });

  it('accepts valid REVIEW_REQUIRED request with known finding_codes', () => {
    const res = validateAiExplainRequest({
      status: 'REVIEW_REQUIRED',
      finding_codes: ['VENDOR_MISMATCH', 'TOTAL_MISMATCH'],
      receipt_hash: VALID_HASH,
    });
    assert.equal(res.status, 'REVIEW_REQUIRED');
    assert.deepEqual(res.finding_codes, ['VENDOR_MISMATCH', 'TOTAL_MISMATCH']);
  });

  it('strictly blocks raw invoice fields (vendor, amount, invoice_number) from reaching AI', () => {
    assert.throws(
      () =>
        validateAiExplainRequest({
          status: 'REVIEW_REQUIRED',
          finding_codes: ['VENDOR_MISMATCH'],
          receipt_hash: VALID_HASH,
          vendor: 'Secret Supplier GmbH',
        }),
      AiPrivacyBoundaryError
    );

    assert.throws(
      () =>
        validateAiExplainRequest({
          status: 'REVIEW_REQUIRED',
          finding_codes: ['TOTAL_MISMATCH'],
          receipt_hash: VALID_HASH,
          amount: '119.00',
        }),
      AiPrivacyBoundaryError
    );

    assert.throws(
      () =>
        validateAiExplainRequest({
          status: 'REVIEW_REQUIRED',
          finding_codes: ['INVALID_INVOICE_NUMBER'],
          receipt_hash: VALID_HASH,
          invoice_number: 'INV-2026-999',
        }),
      AiPrivacyBoundaryError
    );
  });

  it('rejects unknown finding codes or contradictory status/code combinations', () => {
    assert.throws(
      () =>
        validateAiExplainRequest({
          status: 'REVIEW_REQUIRED',
          finding_codes: ['RAW_INVOICE_LEAK_CODE'],
          receipt_hash: VALID_HASH,
        }),
      AiPrivacyBoundaryError
    );

    assert.throws(
      () =>
        validateAiExplainRequest({
          status: 'FIELDS_CONSISTENT',
          finding_codes: ['VENDOR_MISMATCH'],
          receipt_hash: VALID_HASH,
        }),
      AiPrivacyBoundaryError
    );

    assert.throws(
      () =>
        validateAiExplainRequest({
          status: 'REVIEW_REQUIRED',
          finding_codes: [],
          receipt_hash: VALID_HASH,
        }),
      AiPrivacyBoundaryError
    );
  });

  it('builds a deterministic zero-PII prompt containing only status and finding_codes', () => {
    const req = validateAiExplainRequest({
      status: 'REVIEW_REQUIRED',
      finding_codes: ['VENDOR_MISMATCH', 'TOTAL_MISMATCH'],
      receipt_hash: VALID_HASH,
    });
    const prompt = buildPrivacyPreservingAiPrompt(req);
    assert.match(prompt.promptSha256, /^[0-9a-f]{64}$/);
    assert.ok(prompt.userPrompt.includes('VENDOR_MISMATCH'));
    assert.ok(prompt.userPrompt.includes('TOTAL_MISMATCH'));
    assert.ok(!prompt.userPrompt.includes(VALID_HASH));
  });

  it('enforces server-controlled boundary_disclaimer and code list regardless of model output', async () => {
    const {
      enforceServerControlledAiExplanation,
      SERVER_ENFORCED_BOUNDARY_DISCLAIMER,
    } = await import('./aiExplainerContract');

    const req = validateAiExplainRequest({
      status: 'REVIEW_REQUIRED',
      finding_codes: ['VENDOR_MISMATCH', 'TOTAL_MISMATCH'],
      receipt_hash: VALID_HASH,
    });

    const sanitized = enforceServerControlledAiExplanation(
      req,
      'f'.repeat(64),
      {
        executive_summary: 'Model summary text',
        // Model tries to inject a fake code and omit TOTAL_MISMATCH
        code_explanations: [
          {
            code: 'FAKE_HALLUCINATED_CODE',
            meaning: 'Should be dropped',
            verification_step: 'Should be dropped',
          },
          {
            code: 'VENDOR_MISMATCH',
            meaning: 'Custom model explanation for vendor mismatch',
            verification_step: 'Custom step',
          },
        ],
      },
      'LIVE_GEMINI_API',
      'gemini-3.8-flash'
    );

    assert.equal(sanitized.boundary_disclaimer, SERVER_ENFORCED_BOUNDARY_DISCLAIMER);
    assert.deepEqual(
      sanitized.code_explanations.map((c) => c.code),
      ['VENDOR_MISMATCH', 'TOTAL_MISMATCH']
    );
    assert.equal(
      sanitized.code_explanations[0].meaning,
      'Custom model explanation for vendor mismatch'
    );
  });
});
