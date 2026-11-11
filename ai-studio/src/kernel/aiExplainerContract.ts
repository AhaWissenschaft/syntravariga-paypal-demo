/**
 * @license
 * SyntraVariga / AhaWissenschaft Research Framework
 * Module: Privacy-Preserving AI Finding Explainer Contract
 *
 * Why this file exists:
 * Enforces a strict cryptographic and structural firewall between raw invoice data
 * and the AI explanation model. Deterministic rules in `invoiceGuard.ts` remain
 * 100% responsible for the audit decision (`FIELDS_CONSISTENT` vs `REVIEW_REQUIRED`).
 *
 * Furthermore, the server enforces `SERVER_ENFORCED_BOUNDARY_DISCLAIMER` and the
 * authoritative `finding_codes` list itself (`enforceServerControlledAiExplanation`),
 * so the LLM can never alter the disclaimer, invent codes, or omit a finding code.
 */

import { LabContractError, SHA256_RE } from './contracts';
import { assertNoForbiddenPiiKeys } from './ledger';
import { sha256Canonical } from './crypto';
import { FindingCode } from './invoiceGuard';

export class AiPrivacyBoundaryError extends LabContractError {
  constructor(message: string) {
    super(message);
    this.name = 'AiPrivacyBoundaryError';
  }
}

export const ALLOWED_FINDING_CODES: ReadonlySet<FindingCode> = new Set<FindingCode>([
  'MISSING_FIELD',
  'VENDOR_MISMATCH',
  'EXPECTED_AMOUNT_MISMATCH',
  'TOTAL_MISMATCH',
  'INVALID_AMOUNT',
  'INVALID_INVOICE_NUMBER',
  'DUPLICATE_INVOICE',
]);

const ALLOWED_REQUEST_KEYS = new Set(['status', 'finding_codes', 'receipt_hash']);

export const SERVER_ENFORCED_BOUNDARY_DISCLAIMER =
  'The audit decision was made exclusively by deterministic rules. Only general finding codes (no invoice PII) were processed. Even FIELDS_CONSISTENT does not guarantee invoice authenticity or absence of fraud.';

export interface SanitizedAiExplainRequest {
  status: 'FIELDS_CONSISTENT' | 'REVIEW_REQUIRED';
  finding_codes: FindingCode[];
  receipt_hash: string;
}

export interface AiFindingDetail {
  code: string;
  meaning: string;
  verification_step: string;
}

export interface AiExplanationResponse {
  schema: 'aha.syntravariga.ai-explanation.v1';
  receipt_hash: string;
  deterministic_status: 'FIELDS_CONSISTENT' | 'REVIEW_REQUIRED';
  finding_codes: FindingCode[];
  provider_mode: 'LIVE_GEMINI_API' | 'DETERMINISTIC_FALLBACK_NO_API_KEY';
  model_id: string;
  prompt_sha256: string;
  response_sha256: string;
  executive_summary: string;
  code_explanations: AiFindingDetail[];
  human_audit_checklist: string[];
  boundary_disclaimer: string;
}

export const CODE_DICTIONARY: Record<
  FindingCode,
  { meaning: string; verification_step: string }
> = {
  MISSING_FIELD: {
    meaning:
      'At least one mandatory invoice verification field was empty or contained only whitespace.',
    verification_step:
      'Check the original invoice document to ensure supplier, invoice number, net, tax, and gross amounts are completely entered.',
  },
  INVALID_INVOICE_NUMBER: {
    meaning:
      'The invoice number exceeds the maximum length limit or violates the allowed format.',
    verification_step:
      'Inspect the invoice reference for invalid characters, excessive length, or formatting anomalies.',
  },
  VENDOR_MISMATCH: {
    meaning:
      'The supplier name on the invoice differs from the expected purchase order supplier after Unicode NFKC normalization.',
    verification_step:
      'Compare with master data and purchase order: verify whether a name change, different legal entity, or potential supplier spoofing occurred.',
  },
  INVALID_AMOUNT: {
    meaning:
      'At least one currency field could not be parsed as a positive EUR amount with up to two decimal places and no leading zeros.',
    verification_step:
      'Verify that all currency fields use valid decimal notation (e.g., 119.00 instead of 007.00 or negative values).',
  },
  EXPECTED_AMOUNT_MISMATCH: {
    meaning:
      'The billed gross amount differs in exact integer-cent arithmetic from the expected purchase order amount.',
    verification_step:
      'Compare invoice total against the purchase order for unapproved price changes, surcharges, or partial deliveries.',
  },
  TOTAL_MISMATCH: {
    meaning:
      'The mathematical tax identity (Net in cents + Tax in cents = Gross in cents = Billed Amount) is violated.',
    verification_step:
      'Recalculate net and tax line items on the original invoice; a discrepancy indicates a calculation error or a malformed invoice.',
  },
  DUPLICATE_INVOICE: {
    meaning:
      'An invoice with the identical supplier and invoice number has already been recorded as consistent in the audit log.',
    verification_step:
      'Check accounts payable records to verify whether this invoice was already submitted or paid to avoid a duplicate payment.',
  },
};

export function validateAiExplainRequest(input: unknown): SanitizedAiExplainRequest {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new AiPrivacyBoundaryError('AI explain request must be a JSON object');
  }

  try {
    assertNoForbiddenPiiKeys(input, 'ai_request');
  } catch (err) {
    throw new AiPrivacyBoundaryError(
      err instanceof Error ? err.message : 'Forbidden PII key in AI request'
    );
  }

  const record = input as Record<string, unknown>;
  const keys = Object.keys(record);

  for (const key of keys) {
    if (!ALLOWED_REQUEST_KEYS.has(key)) {
      throw new AiPrivacyBoundaryError(
        `unauthorized field '${key}' in AI request: only status, finding_codes, and receipt_hash are permitted`
      );
    }
  }

  const { status, finding_codes, receipt_hash } = record;

  if (status !== 'FIELDS_CONSISTENT' && status !== 'REVIEW_REQUIRED') {
    throw new AiPrivacyBoundaryError(
      'status must be FIELDS_CONSISTENT or REVIEW_REQUIRED'
    );
  }

  if (typeof receipt_hash !== 'string' || !SHA256_RE.test(receipt_hash)) {
    throw new AiPrivacyBoundaryError(
      'receipt_hash must be a valid 64-character lowercase SHA-256 hex digest'
    );
  }

  if (!Array.isArray(finding_codes) || finding_codes.length > 16) {
    throw new AiPrivacyBoundaryError('finding_codes must be an array of at most 16 codes');
  }

  const validatedCodes: FindingCode[] = [];
  for (const code of finding_codes) {
    if (typeof code !== 'string' || !ALLOWED_FINDING_CODES.has(code as FindingCode)) {
      throw new AiPrivacyBoundaryError(`invalid or unknown finding code: '${String(code)}'`);
    }
    validatedCodes.push(code as FindingCode);
  }

  if (status === 'FIELDS_CONSISTENT' && validatedCodes.length > 0) {
    throw new AiPrivacyBoundaryError(
      'contradictory state: FIELDS_CONSISTENT cannot have finding_codes'
    );
  }

  if (status === 'REVIEW_REQUIRED' && validatedCodes.length === 0) {
    throw new AiPrivacyBoundaryError(
      'contradictory state: REVIEW_REQUIRED requires at least one finding_code'
    );
  }

  return {
    status,
    finding_codes: validatedCodes,
    receipt_hash,
  };
}

export function buildPrivacyPreservingAiPrompt(req: SanitizedAiExplainRequest): {
  systemInstruction: string;
  userPrompt: string;
  promptSha256: string;
} {
  const systemInstruction = [
    'You are a technical audit explanation assistant in the SyntraVariga / AhaWissenschaft Framework.',
    'STRICT ARCHITECTURAL BOUNDARY:',
    '1. The deterministic rule engine (invoiceGuard) has already made the authoritative verification decision.',
    '2. For privacy protection, you receive ZERO raw invoice data (no supplier names, no amounts, no invoice numbers).',
    '3. You receive ONLY the deterministic status (FIELDS_CONSISTENT or REVIEW_REQUIRED) and general finding codes (finding_codes).',
    '4. Your task is strictly to explain in clear, factual English what these finding codes mean and what concrete verification steps the human reviewer should perform on the original document.',
    '5. The server enforces the code list and legal disclaimer itself; supply only factual explanations for the requested codes.',
  ].join('\n');

  const userPrompt = JSON.stringify({
    task: 'EXPLAIN_DETERMINISTIC_INVOICE_FINDINGS',
    deterministic_status: req.status,
    finding_codes: req.finding_codes,
    privacy_scope: 'FINDING_CODES_ONLY_ZERO_INVOICE_DATA',
  });

  const promptSha256 = sha256Canonical({
    system_instruction: systemInstruction,
    user_prompt: userPrompt,
  });

  return {
    systemInstruction,
    userPrompt,
    promptSha256,
  };
}

export function enforceServerControlledAiExplanation(
  req: SanitizedAiExplainRequest,
  promptSha256: string,
  modelOutput: {
    executive_summary?: string;
    code_explanations?: Array<{ code?: string; meaning?: string; verification_step?: string }>;
    human_audit_checklist?: string[];
  },
  providerMode: 'LIVE_GEMINI_API' | 'DETERMINISTIC_FALLBACK_NO_API_KEY',
  modelId: string
): Omit<AiExplanationResponse, 'response_sha256'> {
  const uniqueCodes = Array.from(new Set(req.finding_codes));
  const byCode = new Map<string, { meaning: string; verification_step: string }>();

  for (const item of modelOutput.code_explanations || []) {
    if (item && typeof item.code === 'string') {
      byCode.set(item.code.trim(), {
        meaning: typeof item.meaning === 'string' && item.meaning.trim() ? item.meaning.trim() : '',
        verification_step:
          typeof item.verification_step === 'string' && item.verification_step.trim()
            ? item.verification_step.trim()
            : '',
      });
    }
  }

  const controlledCodeExplanations: AiFindingDetail[] =
    uniqueCodes.length > 0
      ? uniqueCodes.map((code) => {
          const fromModel = byCode.get(code);
          const fallback = CODE_DICTIONARY[code];
          return {
            code,
            meaning: fromModel?.meaning || fallback.meaning,
            verification_step: fromModel?.verification_step || fallback.verification_step,
          };
        })
      : [
          {
            code: 'NO_FINDINGS',
            meaning:
              byCode.get('NO_FINDINGS')?.meaning ||
              'All inspected mandatory fields, supplier identities (NFKC), and integer-cent sums (Net + Tax = Gross = Expected Amount) are formally consistent.',
            verification_step:
              byCode.get('NO_FINDINGS')?.verification_step ||
              'Formal field consistency verified; before releasing any payment, verify delivery receipt, payee bank details, and business validity.',
          },
        ];

  const fallbackSummary =
    req.status === 'FIELDS_CONSISTENT'
      ? 'Deterministic rule evaluation returned FIELDS_CONSISTENT (0 finding codes). All formal sum and supplier comparison rules passed in integer-cent arithmetic.'
      : `Deterministic rule evaluation triggered REVIEW_REQUIRED (${req.finding_codes.length} finding code(s): ${uniqueCodes.join(', ')}). Downstream PayPal Sandbox checkout is blocked by rule.`;

  const controlledChecklist =
    Array.isArray(modelOutput.human_audit_checklist) &&
    modelOutput.human_audit_checklist.length > 0
      ? modelOutput.human_audit_checklist
          .filter((s) => typeof s === 'string' && s.trim().length > 0)
          .slice(0, 8)
      : req.status === 'FIELDS_CONSISTENT'
        ? [
            'Verify physical or digital delivery confirmation against the original invoice.',
            'Check payee account details against verified vendor master records.',
            'Initiate the optional PayPal Sandbox order only after explicit human sign-off.',
          ]
        : [
            ...uniqueCodes.map((c) => `[${c}] ${CODE_DICTIONARY[c].verification_step}`),
            'Keep invoice blocked from payment until all finding codes are resolved.',
          ];

  return {
    schema: 'aha.syntravariga.ai-explanation.v1',
    receipt_hash: req.receipt_hash,
    deterministic_status: req.status,
    finding_codes: req.finding_codes,
    provider_mode: providerMode,
    model_id: modelId,
    prompt_sha256: promptSha256,
    executive_summary:
      typeof modelOutput.executive_summary === 'string' && modelOutput.executive_summary.trim()
        ? modelOutput.executive_summary.trim()
        : fallbackSummary,
    code_explanations: controlledCodeExplanations,
    human_audit_checklist: controlledChecklist,
    boundary_disclaimer: SERVER_ENFORCED_BOUNDARY_DISCLAIMER,
  };
}

export function buildFallbackExplanation(
  req: SanitizedAiExplainRequest,
  promptSha256: string
): Omit<AiExplanationResponse, 'response_sha256'> {
  return enforceServerControlledAiExplanation(
    req,
    promptSha256,
    {},
    'DETERMINISTIC_FALLBACK_NO_API_KEY',
    'deterministic-rule-dictionary-v1 (not-ai)'
  );
}
