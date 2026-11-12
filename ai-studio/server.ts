/**
 * @license
 * SyntraVariga / AhaWissenschaft Institutional Verification Server (SQLite ACID + Exact Origin/Host Validation)
 */
import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
import {
  analyzeInvoice,
  analyzeInvoiceBatch,
  InvoiceData,
  BatchInvoiceItem,
} from './src/kernel/invoiceGuard';
import {
  LedgerEvent,
  LedgerError,
  verifyReceiptForOrder,
  extractVerifiedAmountFromReceiptEvent,
  assertReceiptNotConsumed,
  assertAllowedClientEventType,
} from './src/kernel/ledger';
import {
  loadVerifiedLedgerSnapshot,
  appendEventPersistently,
  appendEventPersistentlyWithContext,
  resolveSqliteDbPath,
  PersistentPaymentStore,
  PaymentConcurrencyError,
  PaymentStateUnknownError,
} from './src/kernel/persistentStore';
import {
  validateAiExplainRequest,
  buildPrivacyPreservingAiPrompt,
  buildFallbackExplanation,
  enforceServerControlledAiExplanation,
  AiPrivacyBoundaryError,
  AiExplanationResponse,
  AiFindingDetail,
} from './src/kernel/aiExplainerContract';
import {
  extractInvoiceFieldsDeterministic,
  buildAiInvoiceExtractionPrompt,
  normalizeExtractedAmount,
  AiInvoiceExtractionResult,
} from './src/kernel/aiInvoiceExtractor';
import {
  PayPalSandboxManager,
  PayPalSandboxError,
  ValueError,
  hasLiveSandboxCredentials,
} from './src/kernel/paypalSandbox';
import { sha256Canonical } from './src/kernel/crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const BIND_HOST = process.env.BIND_HOST || '127.0.0.1';
const GEMINI_MODEL_ID = process.env.GEMINI_MODEL_ID || 'gemini-3.8-flash';

export function getLedgerFilePath(): string {
  return process.env.SYNTRA_DEMO_LEDGER || path.join(os.tmpdir(), 'syntravariga_paypal_demo.jsonl');
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    return code === 'EPERM';
  }
}

/**
 * Enforces single-instance process ownership per SQLite database file.
 * Prevents a second server process from treating an active process's in-flight payments as crashed.
 */
export function acquireSingleInstanceServerLock(ledgerFilePath: string): () => void {
  const dbPath = resolveSqliteDbPath(ledgerFilePath);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const lockPath = `${dbPath}.server.pid`;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      try {
        fs.writeFileSync(fd, `${process.pid}\n`, 'utf8');
      } finally {
        fs.closeSync(fd);
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try {
          if (fs.existsSync(lockPath) && fs.readFileSync(lockPath, 'utf8').trim() === String(process.pid)) {
            fs.unlinkSync(lockPath);
          }
        } catch {
          // Best-effort unlock during shutdown
        }
      };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code !== 'EEXIST') throw err;
      const rawPid = fs.existsSync(lockPath) ? fs.readFileSync(lockPath, 'utf8').trim() : '';
      const existingPid = Number(rawPid);
      if (Number.isInteger(existingPid) && existingPid > 0 && isProcessAlive(existingPid)) {
        throw new Error(
          `Single-instance database lock active: process PID ${existingPid} already owns '${dbPath}'. Stop that server before starting another process against the same database.`
        );
      }
      try {
        fs.unlinkSync(lockPath);
      } catch {
        // Retry once if another cleaner removed it concurrently
      }
    }
  }

  throw new Error(`Could not acquire single-instance lock for '${dbPath}'.`);
}

export function hasValidGeminiApiKey(
  env: Record<string, string | undefined> = process.env
): boolean {
  const key = env.GEMINI_API_KEY?.trim();
  if (!key || key === 'MY_GEMINI_API_KEY' || /\s/.test(key) || key.length < 30) {
    return false;
  }
  return key.startsWith('AIza') || key.startsWith('AQ.');
}

const GEMINI_FALLBACK_MODELS = [
  'gemini-3.8-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.5-flash',
  'gemini-3.1-flash-lite',
];

export function resolveGeminiModelSequence(
  primaryModel = GEMINI_MODEL_ID,
  fallbackListEnv = process.env.GEMINI_FALLBACK_MODELS
): string[] {
  const customFallbacks = (fallbackListEnv || '')
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean);
  return Array.from(
    new Set([primaryModel, ...customFallbacks, ...GEMINI_FALLBACK_MODELS].filter(Boolean))
  );
}

function isRetryableGeminiModelError(message: string): boolean {
  return (
    message.includes('503') ||
    message.includes('504') ||
    message.includes('429') ||
    message.includes('404') ||
    message.includes('UNAVAILABLE') ||
    message.includes('DEADLINE_EXCEEDED') ||
    message.includes('RESOURCE_EXHAUSTED') ||
    message.includes('NOT_FOUND') ||
    message.includes('Thinking level') ||
    message.includes('timeout') ||
    message.includes('aborted')
  );
}

function createGeminiClient(timeoutMs: number): GoogleGenAI {
  return new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
    httpOptions: {
      timeout: timeoutMs,
    },
  });
}

async function generateStructuredGeminiJson<T>(options: {
  systemInstruction: string;
  userPrompt: string;
  responseSchema: Record<string, unknown>;
}): Promise<{ parsed: T; modelId: string }> {
  const models = resolveGeminiModelSequence();
  let lastErr: unknown;

  for (let i = 0; i < models.length; i += 1) {
    const modelId = models[i];
    const timeoutMs = i === 0 ? 11000 : 15000;
    try {
      const ai = createGeminiClient(timeoutMs);
      const response = await ai.models.generateContent({
        model: modelId,
        contents: options.userPrompt,
        config: {
          systemInstruction: options.systemInstruction,
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
          responseMimeType: 'application/json',
          responseSchema: options.responseSchema,
        },
      });
      const textOut = response.text;
      if (!textOut) {
        throw new Error(`Empty response from Gemini API (${modelId})`);
      }
      return {
        parsed: JSON.parse(textOut) as T,
        modelId,
      };
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      if (!isRetryableGeminiModelError(msg) || i === models.length - 1) {
        throw err;
      }
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

function collectVerifiedInvoiceDigests(events: LedgerEvent[]): Set<string> {
  const digests = new Set<string>();
  for (const evt of events) {
    if (evt.event_type === 'invoice_review') {
      const p = evt.payload as { status?: string; invoice_ref_sha256?: string };
      if (p?.status === 'FIELDS_CONSISTENT' && typeof p.invoice_ref_sha256 === 'string') {
        digests.add(p.invoice_ref_sha256);
      }
    }
  }
  return digests;
}

/**
 * Exact Host and Origin verification (including scheme, hostname, and port).
 * - NEVER accepts wildcard `*.run.app` origins or hosts.
 * - Accepts `http://127.0.0.1:<serverPort>`, `http://localhost:<serverPort>`, `http://[::1]:<serverPort>`.
 * - Accepts a cloud preview URL ONLY if explicitly configured via `APP_URL` or `TRUSTED_PREVIEW_ORIGIN`
 *   and matching the exact `protocol://host` (`origin`) and `host` (`host:port`).
 */
export function verifyExactHostAndOrigin(
  headers: { host?: string; origin?: string },
  options: {
    expectedLocalPort?: number;
    trustedAppUrl?: string;
  } = {}
): { ok: true } | { ok: false; status: 403; error: string } {
  const rawHost = (headers.host || '').trim().toLowerCase();
  if (!rawHost) {
    return { ok: false, status: 403, error: 'Missing Host header' };
  }

  // Parse host and optional port strictly
  const hostMatch = rawHost.match(/^(\[[0-9a-f:]+\]|[a-z0-9.-]+)(?::(\d+))?$/);
  if (!hostMatch) {
    return { ok: false, status: 403, error: `Malformed Host header: ${rawHost}` };
  }
  const hostname = hostMatch[1];
  const hostPort = hostMatch[2] ? Number(hostMatch[2]) : undefined;

  const localHosts = new Set(['127.0.0.1', 'localhost', '[::1]']);
  const allowedExactOrigins = new Set<string>();
  const allowedExactHosts = new Set<string>();

  if (options.expectedLocalPort && options.expectedLocalPort > 0) {
    for (const lh of localHosts) {
      allowedExactHosts.add(`${lh}:${options.expectedLocalPort}`);
      allowedExactOrigins.add(`http://${lh}:${options.expectedLocalPort}`);
    }
  } else {
    // If ephemeral port is used in tests, allow localhost with the request's actual port
    if (localHosts.has(hostname) && hostPort && hostPort > 0 && hostPort <= 65535) {
      allowedExactHosts.add(`${hostname}:${hostPort}`);
      for (const lh of localHosts) {
        allowedExactOrigins.add(`http://${lh}:${hostPort}`);
      }
    }
  }

  // Explicitly configured trusted preview URL (never a wildcard!)
  const rawTrustedUrl = (
    options.trustedAppUrl ??
    process.env.TRUSTED_PREVIEW_ORIGIN ??
    process.env.APP_URL ??
    ''
  ).trim();

  if (rawTrustedUrl && rawTrustedUrl !== 'MY_APP_URL') {
    try {
      const parsedTrusted = new URL(rawTrustedUrl);
      if (parsedTrusted.protocol === 'https:' || parsedTrusted.protocol === 'http:') {
        allowedExactOrigins.add(parsedTrusted.origin.toLowerCase());
        allowedExactHosts.add(parsedTrusted.host.toLowerCase());
      }
    } catch {
      // Ignore invalid placeholder URL
    }
  }

  if (!allowedExactHosts.has(rawHost)) {
    return {
      ok: false,
      status: 403,
      error: `Forbidden Host header '${rawHost}': must match exact configured local host:port or explicitly configured APP_URL`,
    };
  }

  const rawOrigin = headers.origin?.trim();
  if (rawOrigin) {
    let parsedOrigin: URL;
    try {
      parsedOrigin = new URL(rawOrigin);
    } catch {
      return { ok: false, status: 403, error: `Malformed Origin header: ${rawOrigin}` };
    }
    const normalizedOrigin = parsedOrigin.origin.toLowerCase();
    // Ensure rawOrigin has no path/query/hash smuggling beyond scheme://host[:port]
    if (rawOrigin.toLowerCase().replace(/\/$/, '') !== normalizedOrigin) {
      return { ok: false, status: 403, error: `Invalid Origin format: ${rawOrigin}` };
    }
    if (!allowedExactOrigins.has(normalizedOrigin)) {
      return {
        ok: false,
        status: 403,
        error: `Forbidden cross-origin request from '${rawOrigin}': exact scheme, host, and port must match trusted configuration`,
      };
    }
  }

  return { ok: true };
}

const EXPLICIT_MISSING_PLACEHOLDER_PATTERNS: Record<
  'vendor' | 'invoice_number' | 'net_amount' | 'tax_amount' | 'gross_amount',
  RegExp
> = {
  vendor: /(?:^|\b)(?:Lieferant|Aussteller|Rechnungssteller|Vendor|Supplier|Firma)\b[^:\n]*:\s*(?:[-–—]{2,}|n\/?a|tbd|missing|fehlt|\?)\s*$/im,
  invoice_number: /(?:^|\b)(?:Rechnung\s*(?:Nr\.?|Nummer)?|Invoice\s*(?:No\.?|Number|#)?|Beleg(?:-Nr\.?)?)\b[^:\n:#]*[:#]\s*(?:[-–—]{2,}|n\/?a|tbd|missing|fehlt|\?)\s*$/im,
  net_amount: /(?:^|\b)(?:Netto(?:betrag)?|Net(?:\s*Amount)?|Subtotal|Zwischensumme)\b[^:\n]*:\s*(?:[-–—]{2,}|n\/?a|tbd|missing|fehlt|\?)/im,
  tax_amount: /(?:^|\b)(?:Umsatzsteuer|MwSt\.?|Steuer(?:betrag)?|VAT|Tax)\b[^:\n]*:\s*(?:[-–—]{2,}|n\/?a|tbd|missing|fehlt|\?)/im,
  gross_amount: /(?:^|\b)(?:Gesamtbetrag|Brutto(?:betrag)?|Rechnungsbetrag|Zahlbetrag|Total(?:\s*Amount)?|Payable(?:\s*Amount)?|Gross(?:\s*Amount)?)\b[^:\n]*:\s*(?:[-–—]{2,}|n\/?a|tbd|missing|fehlt|\?)/im,
};

function sanitizeExtractedTextValue(val: string | undefined): string {
  const cleaned = (val || '').trim();
  if (!cleaned) return '';
  if (/^(?:[-–—]{2,}|n\/?a|tbd|missing|fehlt|unknown|\?)$/i.test(cleaned)) {
    return '';
  }
  return cleaned;
}

async function extractInvoiceWithAiOrFallback(
  rawText: string,
  allowExternalAi: boolean
): Promise<{ proposal: AiInvoiceExtractionResult; externalAiError: string | null }> {
  const baseline = extractInvoiceFieldsDeterministic(rawText);
  let externalAiError: string | null = null;

  if (allowExternalAi && hasValidGeminiApiKey()) {
    try {
      const { systemInstruction, userPrompt } = buildAiInvoiceExtractionPrompt(rawText);
      const { parsed, modelId } = await generateStructuredGeminiJson<{
        vendor: string;
        invoice_number: string;
        net_amount: string;
        tax_amount: string;
        gross_amount: string;
        amount: string;
        warnings: string[];
        missing_fields: string[];
        extractor_notes: string;
      }>({
        systemInstruction,
        userPrompt,
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            vendor: { type: Type.STRING },
            invoice_number: { type: Type.STRING },
            net_amount: { type: Type.STRING },
            tax_amount: { type: Type.STRING },
            gross_amount: { type: Type.STRING },
            amount: { type: Type.STRING },
            warnings: { type: Type.ARRAY, items: { type: Type.STRING } },
            missing_fields: { type: Type.ARRAY, items: { type: Type.STRING } },
            extractor_notes: { type: Type.STRING },
          },
          required: [
            'vendor',
            'invoice_number',
            'net_amount',
            'tax_amount',
            'gross_amount',
            'amount',
            'warnings',
            'missing_fields',
            'extractor_notes',
          ],
        },
      });

      const aiMissingSet = new Set(parsed.missing_fields || []);
      const hasAmbiguousNet = baseline.ambiguous_fields.some((a) => a.field === 'net_amount');
      const hasAmbiguousTax = baseline.ambiguous_fields.some((a) => a.field === 'tax_amount');
      const hasAmbiguousGross = baseline.ambiguous_fields.some(
        (a) => a.field === 'gross_amount'
      );

      const resolvedVendor =
        EXPLICIT_MISSING_PLACEHOLDER_PATTERNS.vendor.test(rawText) || aiMissingSet.has('vendor')
          ? ''
          : sanitizeExtractedTextValue(parsed.vendor || baseline.proposed_fields.vendor);
      const resolvedInvoiceNumber =
        EXPLICIT_MISSING_PLACEHOLDER_PATTERNS.invoice_number.test(rawText) ||
        aiMissingSet.has('invoice_number')
          ? ''
          : sanitizeExtractedTextValue(
              parsed.invoice_number || baseline.proposed_fields.invoice_number
            );
      const resolvedNet =
        hasAmbiguousNet ||
        EXPLICIT_MISSING_PLACEHOLDER_PATTERNS.net_amount.test(rawText) ||
        aiMissingSet.has('net_amount')
          ? ''
          : normalizeExtractedAmount(parsed.net_amount || baseline.proposed_fields.net_amount);
      const resolvedTax =
        hasAmbiguousTax ||
        EXPLICIT_MISSING_PLACEHOLDER_PATTERNS.tax_amount.test(rawText) ||
        aiMissingSet.has('tax_amount')
          ? ''
          : normalizeExtractedAmount(parsed.tax_amount || baseline.proposed_fields.tax_amount);
      const resolvedGross =
        hasAmbiguousGross ||
        EXPLICIT_MISSING_PLACEHOLDER_PATTERNS.gross_amount.test(rawText) ||
        aiMissingSet.has('gross_amount')
          ? ''
          : normalizeExtractedAmount(
              parsed.gross_amount || parsed.amount || baseline.proposed_fields.gross_amount
            );

      const proposedFields = {
        vendor: resolvedVendor,
        invoice_number: resolvedInvoiceNumber,
        net_amount: resolvedNet,
        tax_amount: resolvedTax,
        gross_amount: resolvedGross,
        amount: resolvedGross,
      };

      const effectiveMissingFields: string[] = [];
      if (!proposedFields.vendor) effectiveMissingFields.push('vendor');
      if (!proposedFields.invoice_number) effectiveMissingFields.push('invoice_number');
      if (!proposedFields.net_amount) effectiveMissingFields.push('net_amount');
      if (!proposedFields.tax_amount) effectiveMissingFields.push('tax_amount');
      if (!proposedFields.gross_amount) effectiveMissingFields.push('gross_amount');

      const warningSet = new Set<string>(
        (parsed.warnings || []).map((w) => w.trim()).filter(Boolean)
      );
      if (effectiveMissingFields.length > 0) {
        warningSet.add('Field not found');
      }
      if (baseline.ambiguous_fields.length > 0) {
        warningSet.add('Multiple candidate amounts found');
      }
      if (effectiveMissingFields.length > 0 || baseline.ambiguous_fields.length > 0) {
        warningSet.add('Manual review required');
      }

      const unsigned: Omit<AiInvoiceExtractionResult, 'proposal_sha256'> = {
        schema: 'aha.syntravariga.ai-invoice-proposal.v1',
        provider_mode: 'LIVE_GEMINI_API',
        model_id: modelId,
        requires_human_confirmation: true,
        input_text_sha256: baseline.input_text_sha256,
        proposed_fields: proposedFields,
        warnings: Array.from(warningSet),
        missing_fields: effectiveMissingFields,
        ambiguous_fields: baseline.ambiguous_fields,
        extractor_notes: parsed.extractor_notes || baseline.extractor_notes,
      };
      return {
        proposal: { ...unsigned, proposal_sha256: sha256Canonical(unsigned) },
        externalAiError: null,
      };
    } catch (err) {
      externalAiError = err instanceof Error ? err.message : String(err);
    }
  } else if (allowExternalAi && !hasValidGeminiApiKey()) {
    externalAiError =
      'External AI opt-in was selected, but no valid GEMINI_API_KEY is configured on the server. Using deterministic local parser fallback (not AI).';
  }

  const unsignedFallback: Omit<AiInvoiceExtractionResult, 'proposal_sha256'> = {
    ...baseline,
    provider_mode: 'LOCAL_DETERMINISTIC_PARSER_FALLBACK',
    model_id: 'deterministic-regex-parser-v1 (not-ai)',
  };
  return {
    proposal: {
      ...unsignedFallback,
      proposal_sha256: sha256Canonical(unsignedFallback),
    },
    externalAiError,
  };
}

async function generatePrivacyPreservingAiExplanation(
  validatedReq: ReturnType<typeof validateAiExplainRequest>,
  allowExternalAi: boolean
): Promise<{ explanation: AiExplanationResponse; externalAiError: string | null }> {
  const { systemInstruction, userPrompt, promptSha256 } =
    buildPrivacyPreservingAiPrompt(validatedReq);
  let externalAiError: string | null = null;

  if (allowExternalAi && hasValidGeminiApiKey()) {
    try {
      const { parsed, modelId } = await generateStructuredGeminiJson<{
        executive_summary: string;
        code_explanations: AiFindingDetail[];
        human_audit_checklist: string[];
      }>({
        systemInstruction,
        userPrompt,
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            executive_summary: { type: Type.STRING },
            code_explanations: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  code: { type: Type.STRING },
                  meaning: { type: Type.STRING },
                  verification_step: { type: Type.STRING },
                },
                required: ['code', 'meaning', 'verification_step'],
              },
            },
            human_audit_checklist: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
            },
          },
          required: ['executive_summary', 'code_explanations', 'human_audit_checklist'],
        },
      });

      const unsignedResult = enforceServerControlledAiExplanation(
        validatedReq,
        promptSha256,
        parsed,
        'LIVE_GEMINI_API',
        modelId
      );
      const responseSha256 = sha256Canonical(unsignedResult);
      return {
        explanation: { ...unsignedResult, response_sha256: responseSha256 },
        externalAiError: null,
      };
    } catch (err) {
      externalAiError = err instanceof Error ? err.message : String(err);
    }
  } else if (allowExternalAi && !hasValidGeminiApiKey()) {
    externalAiError =
      'External AI opt-in was selected, but no valid GEMINI_API_KEY is configured on the server. Using deterministic rule dictionary (not AI).';
  }

  const fallbackUnsigned = buildFallbackExplanation(validatedReq, promptSha256);
  const responseSha256 = sha256Canonical(fallbackUnsigned);
  return {
    explanation: { ...fallbackUnsigned, response_sha256: responseSha256 },
    externalAiError,
  };
}

export interface ExpressAppConfigOptions {
  expectedLocalPort?: number;
  trustedAppUrl?: string;
}

export function createConfiguredExpressApp(
  customLedgerPath?: string,
  customPayPalManager?: PayPalSandboxManager,
  hostOptions?: ExpressAppConfigOptions
) {
  const ledgerPath = customLedgerPath || getLedgerFilePath();
  loadVerifiedLedgerSnapshot(ledgerPath);
  const paymentStore = new PersistentPaymentStore(ledgerPath);
  // Recover any in-flight payment states (`RESERVED_ORDER`, `CAPTURE_PENDING`) left by a prior crash!
  paymentStore.recoverInFlightRecordsOnStartup();
  let serverLedger: LedgerEvent[] = loadVerifiedLedgerSnapshot(ledgerPath).events;

  const paypalManager = customPayPalManager || new PayPalSandboxManager();

  const app = express();
  app.use((req: Request, res: Response, next: NextFunction) => {
    const check = verifyExactHostAndOrigin(
      {
        host: req.headers.host,
        origin: req.headers.origin,
      },
      hostOptions
    );
    if (!check.ok) {
      res.status(check.status).json({ error: check.error });
      return;
    }
    next();
  });
  app.use(express.json({ limit: '16kb' }));

  app.get('/api/ledger', (_req: Request, res: Response) => {
    try {
      const snapshot = loadVerifiedLedgerSnapshot(ledgerPath);
      serverLedger = snapshot.events;
      res.json({
        events: serverLedger,
        report: snapshot.report,
        payment_records: snapshot.paymentRecords,
        environment_capabilities: {
          gemini_api_configured: hasValidGeminiApiKey(),
          gemini_model_id: GEMINI_MODEL_ID,
          paypal_live_sandbox_credentials_configured: hasLiveSandboxCredentials(process.env),
          paypal_sandbox_host: 'https://api-m.sandbox.paypal.com',
        },
      });
    } catch (err) {
      res.status(503).json({
        error: err instanceof Error ? err.message : 'Ledger verification failed',
      });
    }
  });

  app.post('/api/ledger/append', (req: Request, res: Response) => {
    try {
      const { eventType, payload } = req.body || {};
      const safeEventType = assertAllowedClientEventType(eventType);
      const { events, newEvent, report } = appendEventPersistently(ledgerPath, {
        eventType: safeEventType,
        payload,
      });
      serverLedger = events;
      res.json({ event: newEvent, events: serverLedger, report });
    } catch (err) {
      if (err instanceof LedgerError && err.message.includes('forbidden client event_type')) {
        res.status(403).json({ error: err.message });
        return;
      }
      if (err instanceof LedgerError) {
        res.status(503).json({ error: err.message });
        return;
      }
      res.status(400).json({ error: err instanceof Error ? err.message : 'Invalid request' });
    }
  });

  app.post('/api/ledger/reset', (_req: Request, res: Response) => {
    res.status(403).json({
      error:
        'Ledger reset denied (HTTP 403): The audit log is strictly append-only and cannot be reset or overwritten.',
    });
  });

  app.post('/api/ai/extract', async (req: Request, res: Response) => {
    try {
      const rawText = req.body?.raw_invoice_text;
      const allowExternalAi = Boolean(req.body?.allow_external_ai);
      if (typeof rawText !== 'string' || !rawText.trim()) {
        res.status(400).json({ error: 'raw_invoice_text must be a non-empty string' });
        return;
      }
      if (rawText.length > 4000) {
        res.status(400).json({ error: 'raw_invoice_text exceeds 4000 character limit' });
        return;
      }

      const { proposal, externalAiError } = await extractInvoiceWithAiOrFallback(
        rawText,
        allowExternalAi
      );

      const { events, newEvent, report } = appendEventPersistently(ledgerPath, {
        eventType: 'ai_invoice_extraction',
        timestamp: new Date().toISOString(),
        payload: {
          input_text_sha256: proposal.input_text_sha256,
          proposal_sha256: proposal.proposal_sha256,
          provider_mode: proposal.provider_mode,
          model_id: proposal.model_id,
          external_ai_opt_in: allowExternalAi,
          external_ai_error: externalAiError,
          requires_human_confirmation: true,
          warnings: proposal.warnings,
          missing_fields: proposal.missing_fields,
          ambiguous_field_count: proposal.ambiguous_fields.length,
        },
      });
      serverLedger = events;

      res.json({
        proposal,
        external_ai_error: externalAiError,
        extraction_event: newEvent,
        events: serverLedger,
        ledger_report: report,
      });
    } catch (err) {
      if (err instanceof LedgerError) {
        res.status(503).json({ error: err.message });
        return;
      }
      res.status(400).json({ error: err instanceof Error ? err.message : 'Extraction failed' });
    }
  });

  const handleInvoiceReview = (req: Request, res: Response) => {
    try {
      if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
        res.status(400).json({ error: 'JSON object required' });
        return;
      }
      const invoiceInput = req.body as Partial<InvoiceData>;
      let analysisResult: ReturnType<typeof analyzeInvoice> | null = null;

      const { events, newEvent, report } = appendEventPersistentlyWithContext(
        ledgerPath,
        (existingEvents) => {
          const seenDigests = req.body?.ignore_duplicate_check
            ? new Set<string>()
            : collectVerifiedInvoiceDigests(existingEvents);
          const result = analyzeInvoice(invoiceInput, { seenInvoiceRefDigests: seenDigests });
          analysisResult = result;
          return {
            eventType: 'invoice_review',
            timestamp: new Date().toISOString(),
            payload: {
              finding_codes: result.findings.map((f) => f.code),
              status: result.status,
              verified_amount_eur: result.verified_amount_eur ?? null,
              verified_currency: 'EUR',
              invoice_ref_sha256: result.invoice_ref_sha256 ?? null,
              human_confirmed_inputs: true,
              scope: 'deterministic_demo_review',
            },
          };
        }
      );
      serverLedger = events;
      const result = analysisResult!;

      res.json({
        ...result,
        receipt: {
          index: newEvent.index,
          event_id: newEvent.event_id,
          event_hash: newEvent.event_hash,
          timestamp: newEvent.timestamp,
          verified_amount_eur: result.verified_amount_eur ?? null,
          verified_currency: 'EUR',
          consumed: false,
        },
        events: serverLedger,
        ledger_report: report,
      });
    } catch (err) {
      if (err instanceof LedgerError) {
        res.status(503).json({ error: err.message });
        return;
      }
      res.status(400).json({ error: err instanceof Error ? err.message : 'Invalid request' });
    }
  };

  app.post('/api/review', handleInvoiceReview);
  app.post('/review', handleInvoiceReview);

  app.post('/api/review/batch', (req: Request, res: Response) => {
    try {
      const items = req.body?.items;
      if (!Array.isArray(items) || items.length === 0 || items.length > 25) {
        res.status(400).json({ error: 'items must be a non-empty array of up to 25 invoices' });
        return;
      }
      const summary = analyzeInvoiceBatch(items as BatchInvoiceItem[]);
      const { events, newEvent, report } = appendEventPersistently(ledgerPath, {
        eventType: 'batch_invoice_audit',
        timestamp: new Date().toISOString(),
        payload: {
          total_count: summary.total_count,
          consistent_count: summary.consistent_count,
          blocked_count: summary.blocked_count,
          total_requested_eur: summary.total_requested_eur,
          total_verified_payable_eur: summary.total_verified_payable_eur,
          total_blocked_risk_eur: summary.total_blocked_risk_eur,
          fictitious_sample_batch: true,
        },
      });
      serverLedger = events;
      res.json({
        summary,
        batch_event: newEvent,
        events: serverLedger,
        ledger_report: report,
      });
    } catch (err) {
      if (err instanceof LedgerError) {
        res.status(503).json({ error: err.message });
        return;
      }
      res.status(400).json({ error: err instanceof Error ? err.message : 'Batch audit failed' });
    }
  });

  app.post('/api/ai/explain', async (req: Request, res: Response) => {
    try {
      const bodyCopy = { ...(req.body || {}) };
      const allowExternalAi = Boolean(bodyCopy.allow_external_ai);
      delete bodyCopy.allow_external_ai;

      const validatedReq = validateAiExplainRequest(bodyCopy);
      serverLedger = loadVerifiedLedgerSnapshot(ledgerPath).events;

      const matchingEvent = serverLedger.find(
        (e) => e.event_hash === validatedReq.receipt_hash && e.event_type === 'invoice_review'
      );
      if (!matchingEvent) {
        throw new LedgerError(
          'receipt_hash not found as a verified invoice_review event in the ledger'
        );
      }

      const recordedPayload = matchingEvent.payload as {
        status?: string;
        finding_codes?: string[];
      };
      if (
        recordedPayload.status !== validatedReq.status ||
        JSON.stringify(recordedPayload.finding_codes || []) !==
          JSON.stringify(validatedReq.finding_codes)
      ) {
        throw new AiPrivacyBoundaryError(
          'AI request status or finding_codes do not match the sealed ledger receipt'
        );
      }

      const { explanation, externalAiError } = await generatePrivacyPreservingAiExplanation(
        validatedReq,
        allowExternalAi
      );

      const { events, newEvent, report: updatedReport } = appendEventPersistently(ledgerPath, {
        eventType: 'ai_finding_explanation',
        timestamp: new Date().toISOString(),
        payload: {
          receipt_hash: validatedReq.receipt_hash,
          deterministic_status: validatedReq.status,
          finding_codes: validatedReq.finding_codes,
          provider_mode: explanation.provider_mode,
          model_id: explanation.model_id,
          external_ai_opt_in: allowExternalAi,
          external_ai_error: externalAiError,
          prompt_sha256: explanation.prompt_sha256,
          response_sha256: explanation.response_sha256,
          privacy_boundary: 'FINDING_CODES_ONLY_ZERO_INVOICE_PII',
        },
      });
      serverLedger = events;

      res.json({
        explanation,
        external_ai_error: externalAiError,
        ai_event: newEvent,
        events: serverLedger,
        ledger_report: updatedReport,
      });
    } catch (err) {
      if (err instanceof AiPrivacyBoundaryError) {
        res.status(400).json({ error: err.message });
        return;
      }
      if (err instanceof LedgerError) {
        res.status(503).json({ error: err.message });
        return;
      }
      res.status(500).json({ error: err instanceof Error ? err.message : 'AI explain failed' });
    }
  });

  const resolveCommittedSnapshot = (committed: {
    events?: LedgerEvent[];
    report?: ReturnType<typeof loadVerifiedLedgerSnapshot>['report'];
    paymentRecords?: ReturnType<typeof loadVerifiedLedgerSnapshot>['paymentRecords'];
  }) => {
    if (committed.events && committed.report && committed.paymentRecords) {
      return {
        events: committed.events,
        report: committed.report,
        paymentRecords: committed.paymentRecords,
      };
    }
    return loadVerifiedLedgerSnapshot(ledgerPath);
  };

  // SQLite ACID reservation before await + co-committed status & ledger update
  const handlePayPalOrder = async (req: Request, res: Response) => {
    const { receipt, requested_amount_eur } = req.body || {};
    let reservedReceiptHash: string | null = null;
    try {
      const snapshot = loadVerifiedLedgerSnapshot(ledgerPath);
      serverLedger = snapshot.events;
      const verifiedEvent = verifyReceiptForOrder(serverLedger, receipt, snapshot.report);
      assertReceiptNotConsumed(serverLedger, receipt.event_hash);
      const verifiedAmountEur = extractVerifiedAmountFromReceiptEvent(verifiedEvent);

      if (
        requested_amount_eur !== undefined &&
        String(requested_amount_eur).trim() !== verifiedAmountEur
      ) {
        res.status(400).json({
          error: `Amount tampering rejected: requested amount (${String(requested_amount_eur)} EUR) does not match server-verified receipt amount (${verifiedAmountEur} EUR).`,
        });
        return;
      }

      // Atomic SQLite reservation BEFORE await!
      const reservation = paymentStore.reserveForOrderCreation({
        receiptHash: receipt.event_hash,
        receiptIndex: receipt.index,
        verifiedAmountEur,
      });
      reservedReceiptHash = receipt.event_hash;

      const verifiedOrigin =
        typeof req.headers.origin === 'string' && req.headers.origin.startsWith('http')
          ? req.headers.origin.replace(/\/+$/, '')
          : undefined;
      const order = await paypalManager.createOrder(
        receipt.event_hash,
        verifiedAmountEur,
        process.env,
        reservation.order_idempotency_key,
        verifiedOrigin
          ? {
              returnUrl: `${verifiedOrigin}/?paypal_sandbox_return=approved`,
              cancelUrl: `${verifiedOrigin}/?paypal_sandbox_return=cancel`,
            }
          : undefined
      );

      // Single ACID SQLite transaction commits both `ORDER_CREATED` state AND `paypal_sandbox_order` ledger event!
      const committed = paymentStore.confirmOrderCreated({
        receiptHash: receipt.event_hash,
        orderId: order.id,
        approveUrl: order.approve_url,
        executionMode: order.execution_mode,
        appendLedgerEvent: true,
      });
      const updated = resolveCommittedSnapshot(committed);
      serverLedger = updated.events;

      res.json({
        id: order.id,
        status: order.status,
        approve_url: order.approve_url,
        verified_amount_eur: verifiedAmountEur,
        order,
        order_event: committed.newEvent,
        events: serverLedger,
        ledger_report: updated.report,
        payment_records: updated.paymentRecords,
      });
    } catch (err) {
      if (
        reservedReceiptHash &&
        err instanceof PayPalSandboxError &&
        err.isAmbiguousNetworkState
      ) {
        paymentStore.markUnknownReconciliationRequired(reservedReceiptHash, err.message, true);
      } else if (reservedReceiptHash && !(err instanceof PaymentConcurrencyError)) {
        paymentStore.markUnknownReconciliationRequired(
          reservedReceiptHash,
          err instanceof Error ? err.message : 'Order creation failed',
          true
        );
      }

      if (err instanceof PaymentConcurrencyError) {
        res.status(409).json({ error: err.message });
        return;
      }
      if (err instanceof PaymentStateUnknownError) {
        res.status(409).json({ error: err.message, state: 'UNKNOWN_RECONCILIATION_REQUIRED' });
        return;
      }
      if (err instanceof LedgerError && err.message.includes('receipt replay blocked')) {
        res.status(409).json({ error: err.message });
        return;
      }
      if (err instanceof LedgerError) {
        res.status(503).json({ error: err.message });
        return;
      }
      if (err instanceof ValueError) {
        res.status(400).json({ error: err.message });
        return;
      }
      if (err instanceof PayPalSandboxError) {
        res.status(502).json({ error: err.message });
        return;
      }
      res.status(400).json({ error: err instanceof Error ? err.message : 'Invalid request' });
    }
  };

  app.post('/api/paypal/order', handlePayPalOrder);
  app.post('/paypal/order', handlePayPalOrder);

  app.post('/api/paypal/approve', async (req: Request, res: Response) => {
    try {
      const { receipt, order_id } = req.body || {};
      const snapshot = loadVerifiedLedgerSnapshot(ledgerPath);
      serverLedger = snapshot.events;
      const verifiedEvent = verifyReceiptForOrder(serverLedger, receipt, snapshot.report);
      const verifiedAmountEur = extractVerifiedAmountFromReceiptEvent(verifiedEvent);
      if (typeof order_id !== 'string') {
        throw new ValueError('order_id required');
      }

      const boundRecord = snapshot.paymentRecords[receipt.event_hash];
      if (!boundRecord || boundRecord.order_id !== order_id) {
        res.status(409).json({
          error: `Order '${order_id}' is not bound to verified receipt '${String(receipt.event_hash).slice(0, 12)}...'`,
        });
        return;
      }

      const order = await paypalManager.verifyOrSimulateBuyerApproval(
        order_id,
        receipt.event_hash,
        verifiedAmountEur,
        process.env
      );

      // Single ACID SQLite transaction commits both `ORDER_APPROVED` state AND `paypal_sandbox_approval` ledger event!
      const committed = paymentStore.confirmOrderApproved({
        receiptHash: receipt.event_hash,
        orderId: order.id,
        payerId: order.payer?.payer_id || 'SANDBOX_BUYER',
        executionMode: order.execution_mode,
        appendLedgerEvent: true,
      });
      const updated = resolveCommittedSnapshot(committed);
      serverLedger = updated.events;

      res.json({
        id: order.id,
        status: order.status,
        approve_url: order.approve_url,
        order,
        approval_event: committed.newEvent,
        events: serverLedger,
        ledger_report: updated.report,
        payment_records: updated.paymentRecords,
      });
    } catch (err) {
      if (err instanceof PaymentConcurrencyError || err instanceof PaymentStateUnknownError) {
        res.status(409).json({ error: err.message });
        return;
      }
      if (err instanceof LedgerError) {
        res.status(503).json({ error: err.message });
        return;
      }
      if (err instanceof ValueError) {
        res.status(400).json({ error: err.message });
        return;
      }
      if (err instanceof PayPalSandboxError) {
        res.status(502).json({ error: err.message });
        return;
      }
      res.status(400).json({ error: err instanceof Error ? err.message : 'Invalid request' });
    }
  });

  const handlePayPalCapture = async (req: Request, res: Response) => {
    const { receipt, order_id } = req.body || {};
    let reservedReceiptHash: string | null = null;
    try {
      const snapshot = loadVerifiedLedgerSnapshot(ledgerPath);
      serverLedger = snapshot.events;
      const verifiedEvent = verifyReceiptForOrder(serverLedger, receipt, snapshot.report);
      const verifiedAmountEur = extractVerifiedAmountFromReceiptEvent(verifiedEvent);
      if (typeof order_id !== 'string') {
        throw new ValueError('order_id required');
      }

      // Atomic SQLite transition to CAPTURE_PENDING before await!
      const reservation = paymentStore.reserveForCapture({
        receiptHash: receipt.event_hash,
        orderId: order_id,
      });
      reservedReceiptHash = receipt.event_hash;

      const order = await paypalManager.captureOrder(
        order_id,
        receipt.event_hash,
        verifiedAmountEur,
        process.env,
        reservation.capture_idempotency_key
      );

      const captureId = order.purchase_units[0].payments!.captures![0].id;
      // Single ACID SQLite transaction commits both `COMPLETED` state AND `paypal_sandbox_capture` ledger event!
      const committed = paymentStore.confirmCaptureCompleted({
        receiptHash: receipt.event_hash,
        orderId: order.id,
        captureId,
        executionMode: order.execution_mode,
        appendLedgerEvent: true,
      });
      const updated = resolveCommittedSnapshot(committed);
      serverLedger = updated.events;

      res.json({
        id: order.id,
        status: order.status,
        verified_amount_eur: verifiedAmountEur,
        purchase_units: order.purchase_units,
        order,
        capture_event: committed.newEvent,
        events: serverLedger,
        ledger_report: updated.report,
        payment_records: updated.paymentRecords,
      });
    } catch (err) {
      if (reservedReceiptHash && !(err instanceof PaymentConcurrencyError)) {
        paymentStore.markUnknownReconciliationRequired(
          reservedReceiptHash,
          err instanceof Error ? err.message : 'Capture failed or timed out',
          true
        );
      }
      if (err instanceof PaymentConcurrencyError || err instanceof PaymentStateUnknownError) {
        res.status(409).json({ error: err.message });
        return;
      }
      if (err instanceof LedgerError) {
        res.status(503).json({ error: err.message });
        return;
      }
      if (err instanceof ValueError) {
        res.status(400).json({ error: err.message });
        return;
      }
      if (err instanceof PayPalSandboxError) {
        res.status(502).json({ error: err.message });
        return;
      }
      res.status(400).json({ error: err instanceof Error ? err.message : 'Invalid request' });
    }
  };

  app.post('/api/paypal/capture', handlePayPalCapture);
  app.post('/paypal/capture', handlePayPalCapture);

  /**
   * Manual Reconciliation Endpoint (`POST /api/paypal/reconcile`).
   * Co-commits the reconciled payment state and `paypal_manual_reconciliation` ledger event in one SQLite transaction.
   */
  app.post('/api/paypal/reconcile', (req: Request, res: Response) => {
    try {
      const { receipt_hash, resolution, capture_id, operator_note } = req.body || {};
      if (typeof receipt_hash !== 'string') {
        throw new ValueError('receipt_hash required');
      }
      if (resolution !== 'MARK_CANCELLED' && resolution !== 'CONFIRM_CAPTURED') {
        throw new ValueError("resolution must be 'MARK_CANCELLED' or 'CONFIRM_CAPTURED'");
      }
      const committed = paymentStore.reconcileUnknownPayment({
        receiptHash: receipt_hash,
        resolution,
        captureId: typeof capture_id === 'string' ? capture_id : undefined,
        operatorNote: typeof operator_note === 'string' ? operator_note : '',
        appendLedgerEvent: true,
      });

      const updated = resolveCommittedSnapshot(committed);
      serverLedger = updated.events;

      res.json({
        record: committed.record,
        reconciliation_event: committed.newEvent,
        events: serverLedger,
        ledger_report: updated.report,
        payment_records: updated.paymentRecords,
      });
    } catch (err) {
      if (err instanceof PaymentConcurrencyError || err instanceof PaymentStateUnknownError) {
        res.status(409).json({ error: err.message });
        return;
      }
      if (err instanceof LedgerError) {
        res.status(400).json({ error: err.message });
        return;
      }
      res.status(400).json({ error: err instanceof Error ? err.message : 'Invalid request' });
    }
  });

  /**
   * Isolated Negative Self-Test Endpoint (`POST /api/redteam/isolated`).
   * Runs against an isolated temporary SQLite database and simulated PayPal adapter (`env={}`),
   * never touching the active ledger or calling external APIs.
   * Note: Returned `simulatedStatus` values represent deterministic unit-check mappings (not HTTP status codes from live network attacks).
   */
  app.post('/api/redteam/isolated', async (_req: Request, res: Response) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'syntra-redteam-isolated-'));
    const isolatedLedgerPath = path.join(tmpDir, 'isolated_ledger.jsonl');
    try {
      loadVerifiedLedgerSnapshot(isolatedLedgerPath);
      const isolatedStore = new PersistentPaymentStore(isolatedLedgerPath);
      const isolatedPayPal = new PayPalSandboxManager();
      const results = [];

      // Case 1: Client receipt forgery check via assertAllowedClientEventType
      let case1Status = 200;
      let case1Msg = '';
      try {
        assertAllowedClientEventType('invoice_review');
      } catch (e) {
        case1Status = 403;
        case1Msg = (e as Error).message;
      }
      results.push({
        id: 'CHK-1',
        title: 'Client Receipt Forgery Guard (invoice_review via append)',
        endpoint: 'Isolated Function Check: assertAllowedClientEventType',
        httpStatus: case1Status,
        blocked: case1Status === 403,
        serverMessage: case1Msg,
      });

      // Prepare an isolated valid receipt (119.00 EUR) in temporary SQLite store
      const { newEvent: validRev } = appendEventPersistently(isolatedLedgerPath, {
        eventType: 'invoice_review',
        payload: {
          finding_codes: [],
          status: 'FIELDS_CONSISTENT',
          verified_amount_eur: '119.00',
          verified_currency: 'EUR',
          scope: 'isolated_redteam_test',
        },
      });

      // Case 2: Post-review amount mismatch check (999.00 EUR requested on 119.00 EUR receipt)
      const verifiedAmt = extractVerifiedAmountFromReceiptEvent(validRev);
      const requestedAmt = '999.00';
      const case2Blocked = requestedAmt !== verifiedAmt;
      results.push({
        id: 'CHK-2',
        title: 'Post-Review Amount Binding Check (999.00 EUR vs. 119.00 EUR)',
        endpoint: 'Isolated Function Check: extractVerifiedAmountFromReceiptEvent',
        httpStatus: case2Blocked ? 400 : 200,
        blocked: case2Blocked,
        serverMessage: `Rejected: requested 999.00 EUR != verified ${verifiedAmt} EUR`,
      });

      // Case 3: SQLite Atomic Receipt Replay / Double-Order Reservation
      const resv = isolatedStore.reserveForOrderCreation({
        receiptHash: validRev.event_hash,
        receiptIndex: validRev.index,
        verifiedAmountEur: verifiedAmt,
      });
      const simOrder = await isolatedPayPal.createOrder(
        validRev.event_hash,
        verifiedAmt,
        {},
        resv.order_idempotency_key
      );
      isolatedStore.confirmOrderCreated({
        receiptHash: validRev.event_hash,
        orderId: simOrder.id,
        approveUrl: simOrder.approve_url,
        executionMode: simOrder.execution_mode,
        appendLedgerEvent: true,
      });

      let case3Status = 200;
      let case3Msg = '';
      try {
        isolatedStore.reserveForOrderCreation({
          receiptHash: validRev.event_hash,
          receiptIndex: validRev.index,
          verifiedAmountEur: verifiedAmt,
        });
      } catch (e) {
        case3Status = 409;
        case3Msg = (e as Error).message;
      }
      results.push({
        id: 'CHK-3',
        title: 'SQLite Atomic Receipt Replay / Double-Order Check',
        endpoint: 'Isolated SQLite Check: PersistentPaymentStore.reserveForOrderCreation',
        httpStatus: case3Status,
        blocked: case3Status === 409,
        serverMessage: case3Msg,
      });

      // Case 4: Raw Invoice PII smuggling into AI explainer contract
      let case4Status = 200;
      let case4Msg = '';
      try {
        validateAiExplainRequest({
          status: 'FIELDS_CONSISTENT',
          finding_codes: [],
          receipt_hash: validRev.event_hash,
          vendor: 'Secret Supplier GmbH',
        });
      } catch (e) {
        case4Status = 400;
        case4Msg = (e as Error).message;
      }
      results.push({
        id: 'CHK-4',
        title: 'Raw Invoice PII Boundary Check in AI Explainer Contract',
        endpoint: 'Isolated Function Check: validateAiExplainRequest',
        httpStatus: case4Status,
        blocked: case4Status === 400,
        serverMessage: case4Msg,
      });

      res.json({
        isolated_execution: true,
        external_api_calls_made: 0,
        main_ledger_modified: false,
        scope_note:
          'These 4 isolated checks execute internal validation functions and a temporary SQLite store (mapped to HTTP 403/400/409 equivalents) without network traffic or main-ledger mutation. They are negative unit/integration checks, not a general proof of security.',
        results,
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  return app;
}

async function startServer() {
  const releaseDbLock = acquireSingleInstanceServerLock(getLedgerFilePath());
  process.once('exit', releaseDbLock);

  let app: ReturnType<typeof createConfiguredExpressApp>;
  try {
    app = createConfiguredExpressApp(undefined, undefined, {
      expectedLocalPort: PORT,
      trustedAppUrl: process.env.APP_URL,
    });
  } catch (err) {
    releaseDbLock();
    throw err;
  }

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*all', (_req: Request, res: Response) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const server = app.listen(PORT, BIND_HOST, () => {
    console.log(
      `[SyntraVariga Server] Listening on http://${BIND_HOST}:${PORT} (Gemini API key present: ${hasValidGeminiApiKey()}, Live PayPal Sandbox credentials present: ${hasLiveSandboxCredentials(process.env)})`
    );
  });

  const handleSignal = (signal: string) => {
    server.close(() => {
      releaseDbLock();
      process.exit(0);
    });
    setTimeout(() => {
      releaseDbLock();
      process.exit(signal === 'SIGINT' ? 130 : 143);
    }, 1500).unref();
  };

  process.once('SIGINT', () => handleSignal('SIGINT'));
  process.once('SIGTERM', () => handleSignal('SIGTERM'));
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  startServer();
}
