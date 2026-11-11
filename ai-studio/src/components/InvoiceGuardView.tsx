import React, { useState, useMemo } from 'react';
import {
  AlertTriangle,
  FileCheck,
  CheckCircle2,
  Lock,
  ArrowRight,
  Sparkles,
  FileText,
  UserCheck,
  ShieldAlert,
  CreditCard,
  Info,
  ListChecks,
  ExternalLink,
  Layers,
  Swords,
  ShieldCheck,
  Wrench,
  Loader2,
  RotateCcw,
} from 'lucide-react';
import {
  analyzeInvoice,
  InvoiceData,
  InvoiceAnalysisResult,
  BatchInvoiceItem,
  BatchInvoiceAuditSummary,
} from '../kernel/invoiceGuard';
import { LedgerEvent } from '../kernel/ledger';
import {
  INVOICE_TEXT_SCENARIOS,
  AiInvoiceExtractionResult,
} from '../kernel/aiInvoiceExtractor';
import { AiExplanationResponse } from '../kernel/aiExplainerContract';
import { PayPalSandboxOrder } from '../kernel/paypalSandbox';
import { PersistentPaymentRecord } from '../kernel/persistentStore';
import { EnvironmentCapabilities } from '../App';

interface InvoiceGuardViewProps {
  events: LedgerEvent[];
  onSyncEvents: (events: LedgerEvent[]) => void;
  paymentRecords: Record<string, PersistentPaymentRecord>;
  onSyncPaymentRecords: (records: Record<string, PersistentPaymentRecord>) => void;
  envCaps: EnvironmentCapabilities;
}

interface SealedReceipt {
  index: number;
  event_id: string;
  event_hash: string;
  timestamp: string;
  verified_amount_eur: string | null;
  verified_currency: string;
  consumed?: boolean;
}

interface RedTeamAttackResult {
  id: string;
  title: string;
  endpoint: string;
  httpStatus: number;
  blocked: boolean;
  serverMessage: string;
}

const DEMO_BATCH_INVOICES: BatchInvoiceItem[] = [
  {
    id: 'BATCH-1',
    label: 'Server Rack Maintenance Q4 (Consistent Sample)',
    expected_vendor: 'Beispieltechnik GmbH',
    vendor: 'Beispieltechnik GmbH',
    expected_amount: '119.00',
    amount: '119.00',
    net_amount: '100.00',
    tax_amount: '19.00',
    gross_amount: '119.00',
    invoice_number: 'R-1042',
  },
  {
    id: 'BATCH-2',
    label: 'Maintenance with Unordered Express Surcharge (+30.00 EUR)',
    expected_vendor: 'Beispieltechnik GmbH',
    vendor: 'Beispieltechnik GmbH',
    expected_amount: '119.00',
    amount: '149.00',
    net_amount: '125.21',
    tax_amount: '23.79',
    gross_amount: '149.00',
    invoice_number: 'R-1043',
  },
  {
    id: 'BATCH-3',
    label: 'Duplicate Submission of Invoice R-1042',
    expected_vendor: 'Beispieltechnik GmbH',
    vendor: 'Beispieltechnik GmbH',
    expected_amount: '119.00',
    amount: '119.00',
    net_amount: '100.00',
    tax_amount: '19.00',
    gross_amount: '119.00',
    invoice_number: 'R-1042',
  },
  {
    id: 'BATCH-4',
    label: 'VAT Arithmetic Discrepancy (100.00 + 25.00 != 119.00)',
    expected_vendor: 'CloudHost Europe GmbH',
    vendor: 'CloudHost Europe GmbH',
    expected_amount: '119.00',
    amount: '119.00',
    net_amount: '100.00',
    tax_amount: '25.00',
    gross_amount: '119.00',
    invoice_number: 'CH-2026-88',
  },
  {
    id: 'BATCH-5',
    label: 'Different Supplier Name (Entity Mismatch)',
    expected_vendor: 'Beispieltechnik GmbH',
    vendor: 'Beispieltechnik International Trading Ltd',
    expected_amount: '119.00',
    amount: '119.00',
    net_amount: '100.00',
    tax_amount: '19.00',
    gross_amount: '119.00',
    invoice_number: 'R-1049',
  },
];

export const InvoiceGuardView: React.FC<InvoiceGuardViewProps> = ({
  events,
  onSyncEvents,
  paymentRecords,
  onSyncPaymentRecords,
  envCaps,
}) => {
  // Section 1: Raw Invoice Text & Expected Purchase Order State
  const [rawInvoiceText, setRawInvoiceText] = useState<string>(
    INVOICE_TEXT_SCENARIOS.sceneB_consistent.raw_text
  );
  const [expectedVendor, setExpectedVendor] = useState<string>(
    INVOICE_TEXT_SCENARIOS.sceneB_consistent.expected_vendor
  );
  const [expectedAmount, setExpectedAmount] = useState<string>(
    INVOICE_TEXT_SCENARIOS.sceneB_consistent.expected_amount
  );

  // Explicit Consent Flags (External AI only after explicit consent; provider & transmitted fields clearly disclosed)
  const [allowExternalAiForText, setAllowExternalAiForText] = useState<boolean>(false);
  const [allowExternalAiForExplain, setAllowExternalAiForExplain] = useState<boolean>(false);
  const [checkLedgerDuplicates, setCheckLedgerDuplicates] = useState<boolean>(false);

  // Honest Session-Level Live Execution Proof (only emerald green once actually verified live)
  const [liveGeminiVerifiedModel, setLiveGeminiVerifiedModel] = useState<string | null>(null);
  const [livePayPalVerifiedCaptureId, setLivePayPalVerifiedCaptureId] = useState<string | null>(
    null
  );

  // Step 1 Extraction Output & Error State
  const [extracting, setExtracting] = useState(false);
  const [aiProposal, setAiProposal] = useState<AiInvoiceExtractionResult | null>(null);
  const [extractAiError, setExtractAiError] = useState<string | null>(null);

  // Section 2: Human-Confirmed / Editable Fields
  const [formData, setFormData] = useState<InvoiceData>({
    expected_vendor: 'Beispieltechnik GmbH',
    vendor: 'Beispieltechnik GmbH',
    expected_amount: '119.00',
    amount: '119.00',
    net_amount: '100.00',
    tax_amount: '19.00',
    gross_amount: '119.00',
    invoice_number: 'R-1042',
  });

  // Section 3: Server-Side Sealed Review & Explanation
  const [reviewing, setReviewing] = useState(false);
  const [lastReceipt, setLastReceipt] = useState<SealedReceipt | null>(null);
  const [explaining, setExplaining] = useState(false);
  const [aiExplanation, setAiExplanation] = useState<AiExplanationResponse | null>(null);
  const [explainAiError, setExplainAiError] = useState<string | null>(null);

  // Section 4: PayPal Sandbox Checkout & Reconciliation State
  const [paypalStep, setPaypalStep] = useState<
    | 'idle'
    | 'creating_order'
    | 'order_created'
    | 'approving'
    | 'order_approved'
    | 'capturing'
    | 'completed'
  >('idle');
  const [activeOrder, setActiveOrder] = useState<PayPalSandboxOrder | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [reconciling, setReconciling] = useState(false);
  const [reconcileNote, setReconcileNote] = useState<string>(
    'Checked PayPal Sandbox dashboard manually; no capture executed.'
  );
  const [reconcileCaptureId, setReconcileCaptureId] = useState<string>('SB-CAP-MANUAL01');

  // Batch Sample Audit State
  const [batchLoading, setBatchLoading] = useState(false);
  const [batchSummary, setBatchSummary] = useState<BatchInvoiceAuditSummary | null>(null);

  // Isolated Red-Team Negative Test Suite State
  const [runningRedTeam, setRunningRedTeam] = useState(false);
  const [redTeamResults, setRedTeamResults] = useState<RedTeamAttackResult[] | null>(null);
  const [redTeamScopeNote, setRedTeamScopeNote] = useState<string | null>(null);

  // Live local preview of deterministic rules
  const localAnalysis: InvoiceAnalysisResult = useMemo(() => {
    return analyzeInvoice(formData);
  }, [formData]);

  const isConsistent = localAnalysis.status === 'FIELDS_CONSISTENT';
  const isPayPalBusy =
    paypalStep === 'creating_order' ||
    paypalStep === 'approving' ||
    paypalStep === 'capturing' ||
    reconciling;

  // Active payment record from persistent store if a receipt is active
  const currentPaymentRecord: PersistentPaymentRecord | null = useMemo(() => {
    if (!lastReceipt) return null;
    return paymentRecords[lastReceipt.event_hash] || null;
  }, [lastReceipt, paymentRecords]);

  const persistedPaymentList = useMemo(
    () =>
      Object.values(paymentRecords).sort((a, b) => b.receipt_index - a.receipt_index),
    [paymentRecords]
  );

  const refreshServerSnapshot = () => {
    fetch('/api/ledger')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (Array.isArray(d?.events)) onSyncEvents(d.events);
        if (d?.payment_records) onSyncPaymentRecords(d.payment_records);
      })
      .catch(() => {});
  };

  // Reset downstream state whenever any input changes (changes require a new review!)
  const invalidateConfirmedReview = () => {
    setLastReceipt(null);
    setAiExplanation(null);
    setExplainAiError(null);
    setPaypalStep('idle');
    setActiveOrder(null);
    setErrorMsg(null);
  };

  const handleResumePersistedRecord = (rec: PersistentPaymentRecord) => {
    const matchingReview = events.find(
      (e) => e.event_hash === rec.receipt_hash && e.event_type === 'invoice_review'
    );
    const verifiedAmt = rec.verified_amount_eur;
    setFormData((prev) => ({
      ...prev,
      expected_amount: verifiedAmt,
      amount: verifiedAmt,
      gross_amount: verifiedAmt,
    }));
    setExpectedAmount(verifiedAmt);
    setLastReceipt({
      index: rec.receipt_index,
      event_id: matchingReview?.event_id || `restored-${rec.receipt_index}`,
      event_hash: rec.receipt_hash,
      timestamp: matchingReview?.timestamp || rec.updated_at,
      verified_amount_eur: verifiedAmt,
      verified_currency: 'EUR',
      consumed: rec.state === 'COMPLETED',
    });
    setAiExplanation(null);
    setExplainAiError(null);
    setErrorMsg(null);

    const syntheticOrder: PayPalSandboxOrder | null = rec.order_id
      ? {
          id: rec.order_id,
          intent: 'CAPTURE',
          create_time: rec.updated_at,
          status:
            rec.state === 'COMPLETED'
              ? 'COMPLETED'
              : rec.state === 'ORDER_APPROVED' || rec.state === 'CAPTURE_PENDING'
                ? 'APPROVED'
                : 'CREATED',
          approve_url:
            rec.approve_url ||
            `https://www.sandbox.paypal.com/checkoutnow?token=${encodeURIComponent(rec.order_id)}`,
          execution_mode: rec.execution_mode || 'SANDBOX_PROTOCOL_SIMULATION',
          purchase_units: [
            {
              custom_id: rec.receipt_hash,
              description: `SyntraVariga Verified Invoice (${rec.receipt_hash.slice(0, 12)})`,
              amount: { currency_code: 'EUR', value: rec.verified_amount_eur },
              payments: rec.capture_id
                ? {
                    captures: [
                      {
                        id: rec.capture_id,
                        status: 'COMPLETED',
                        create_time: rec.updated_at,
                        amount: { currency_code: 'EUR', value: rec.verified_amount_eur },
                      },
                    ],
                  }
                : undefined,
            },
          ],
          payer:
            rec.state === 'ORDER_APPROVED' || rec.state === 'COMPLETED'
              ? { email_address: 'sandbox-buyer@aha-demo.example', payer_id: 'SANDBOX_BUYER' }
              : undefined,
        }
      : null;

    setActiveOrder(syntheticOrder);
    if (rec.state === 'COMPLETED') {
      setPaypalStep('completed');
    } else if (rec.state === 'ORDER_APPROVED') {
      setPaypalStep('order_approved');
    } else if (rec.state === 'ORDER_CREATED') {
      setPaypalStep('order_created');
    } else {
      setPaypalStep('idle');
    }
  };

  const handleSelectScenario = (key: keyof typeof INVOICE_TEXT_SCENARIOS) => {
    const sc = INVOICE_TEXT_SCENARIOS[key];
    setRawInvoiceText(sc.raw_text);
    setExpectedVendor(sc.expected_vendor);
    setExpectedAmount(sc.expected_amount);
    setFormData((prev) => ({
      ...prev,
      expected_vendor: sc.expected_vendor,
      expected_amount: sc.expected_amount,
    }));
    setAiProposal(null);
    setExtractAiError(null);
    invalidateConfirmedReview();
  };

  // Step 1: Call Invoice Text Extraction (`POST /api/ai/extract`)
  const handleRunAiExtraction = async () => {
    setExtracting(true);
    setErrorMsg(null);
    setExtractAiError(null);
    invalidateConfirmedReview();

    try {
      const res = await fetch('/api/ai/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          raw_invoice_text: rawInvoiceText,
          allow_external_ai: allowExternalAiForText,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Field extraction failed');
      }

      const proposal: AiInvoiceExtractionResult = data.proposal;
      setAiProposal(proposal);
      setExtractAiError(data.external_ai_error || null);
      if (proposal.provider_mode === 'LIVE_GEMINI_API') {
        setLiveGeminiVerifiedModel(proposal.model_id);
      }
      if (Array.isArray(data.events)) {
        onSyncEvents(data.events);
      }

      setFormData({
        expected_vendor: expectedVendor,
        expected_amount: expectedAmount,
        vendor: proposal.proposed_fields.vendor,
        invoice_number: proposal.proposed_fields.invoice_number,
        net_amount: proposal.proposed_fields.net_amount,
        tax_amount: proposal.proposed_fields.tax_amount,
        gross_amount: proposal.proposed_fields.gross_amount,
        amount: proposal.proposed_fields.amount,
      });
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setExtracting(false);
    }
  };

  const handleFieldChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
    if (name === 'expected_vendor') setExpectedVendor(value);
    if (name === 'expected_amount') setExpectedAmount(value);
    invalidateConfirmedReview();
  };

  // Step 2: Human confirms fields & triggers server-side deterministic rules + ledger sealing (`POST /api/review`)
  const handleConfirmAndSealReview = async () => {
    if (isPayPalBusy) return;
    setReviewing(true);
    setErrorMsg(null);
    setAiExplanation(null);
    setExplainAiError(null);
    setPaypalStep('idle');
    setActiveOrder(null);

    try {
      const res = await fetch('/api/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...formData, ignore_duplicate_check: !checkLedgerDuplicates }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Server rule verification failed');
      }

      setLastReceipt(data.receipt);
      if (Array.isArray(data.events)) {
        onSyncEvents(data.events);
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setReviewing(false);
    }
  };

  // Step 3: Privacy-preserving explanation of finding codes (`POST /api/ai/explain`)
  const handleRequestAiFindingExplanation = async () => {
    if (!lastReceipt) return;
    setExplaining(true);
    setErrorMsg(null);
    setExplainAiError(null);

    try {
      const findingCodes = localAnalysis.findings.map((f) => f.code);
      const res = await fetch('/api/ai/explain', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: localAnalysis.status,
          finding_codes: findingCodes,
          receipt_hash: lastReceipt.event_hash,
          allow_external_ai: allowExternalAiForExplain,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Finding explanation request failed');
      }

      setAiExplanation(data.explanation);
      if (data.explanation?.provider_mode === 'LIVE_GEMINI_API') {
        setLiveGeminiVerifiedModel(data.explanation.model_id);
      }
      setExplainAiError(data.external_ai_error || null);
      if (Array.isArray(data.events)) {
        onSyncEvents(data.events);
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setExplaining(false);
    }
  };

  // Step 4a: Create PayPal Sandbox Order bound to server-verified amount & receipt (`POST /api/paypal/order`)
  const handleCreateSandboxOrder = async () => {
    if (!lastReceipt || !isConsistent || isPayPalBusy) return;
    setPaypalStep('creating_order');
    setErrorMsg(null);

    try {
      const res = await fetch('/api/paypal/order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          receipt: {
            index: lastReceipt.index,
            event_hash: lastReceipt.event_hash,
          },
          requested_amount_eur: lastReceipt.verified_amount_eur,
        }),
      });
      const data = await res.json();
      if (data.payment_records) {
        onSyncPaymentRecords(data.payment_records);
      }
      if (!res.ok) {
        throw new Error(data.error || 'PayPal Sandbox Order could not be created');
      }

      setActiveOrder(data.order);
      setPaypalStep('order_created');
      if (Array.isArray(data.events)) {
        onSyncEvents(data.events);
      }
    } catch (err) {
      setPaypalStep('idle');
      setErrorMsg(err instanceof Error ? err.message : String(err));
      refreshServerSnapshot();
    }
  };

  // Step 4b: Buyer approves order in PayPal Sandbox (`POST /api/paypal/approve`)
  const handleApproveSandboxOrder = async () => {
    if (!lastReceipt || !activeOrder || isPayPalBusy) return;
    setPaypalStep('approving');
    setErrorMsg(null);

    try {
      const res = await fetch('/api/paypal/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          receipt: {
            index: lastReceipt.index,
            event_hash: lastReceipt.event_hash,
          },
          order_id: activeOrder.id,
        }),
      });
      const data = await res.json();
      if (data.payment_records) {
        onSyncPaymentRecords(data.payment_records);
      }
      if (!res.ok) {
        throw new Error(data.error || 'Buyer approval verification failed');
      }

      setActiveOrder(data.order);
      setPaypalStep('order_approved');
      if (Array.isArray(data.events)) {
        onSyncEvents(data.events);
      }
    } catch (err) {
      setPaypalStep('order_created');
      setErrorMsg(err instanceof Error ? err.message : String(err));
      refreshServerSnapshot();
    }
  };

  // Step 4c: Capture approved PayPal Sandbox Order (`POST /api/paypal/capture`)
  const handleCaptureSandboxOrder = async () => {
    if (!lastReceipt || !activeOrder || isPayPalBusy) return;
    setPaypalStep('capturing');
    setErrorMsg(null);

    try {
      const res = await fetch('/api/paypal/capture', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          receipt: {
            index: lastReceipt.index,
            event_hash: lastReceipt.event_hash,
          },
          order_id: activeOrder.id,
        }),
      });
      const data = await res.json();
      if (data.payment_records) {
        onSyncPaymentRecords(data.payment_records);
      }
      if (!res.ok) {
        throw new Error(data.error || 'PayPal Sandbox Capture failed');
      }

      setActiveOrder(data.order);
      const captureId = data.order?.purchase_units?.[0]?.payments?.captures?.[0]?.id;
      if (data.order?.execution_mode === 'LIVE_PAYPAL_SANDBOX_REST' && captureId) {
        setLivePayPalVerifiedCaptureId(captureId);
      }
      setPaypalStep('completed');
      if (Array.isArray(data.events)) {
        onSyncEvents(data.events);
      }
    } catch (err) {
      setPaypalStep('order_approved');
      setErrorMsg(err instanceof Error ? err.message : String(err));
      refreshServerSnapshot();
    }
  };

  // Manual Reconciliation Handler (`POST /api/paypal/reconcile`)
  const handleManualReconcile = async (resolution: 'MARK_CANCELLED' | 'CONFIRM_CAPTURED') => {
    if (!lastReceipt || reconciling) return;
    setReconciling(true);
    setErrorMsg(null);

    try {
      const res = await fetch('/api/paypal/reconcile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          receipt_hash: lastReceipt.event_hash,
          resolution,
          capture_id: resolution === 'CONFIRM_CAPTURED' ? reconcileCaptureId : undefined,
          operator_note: reconcileNote,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Manual reconciliation failed');
      }
      if (data.payment_records) {
        onSyncPaymentRecords(data.payment_records);
      }
      if (Array.isArray(data.events)) {
        onSyncEvents(data.events);
      }
      if (resolution === 'CONFIRM_CAPTURED') {
        setPaypalStep('completed');
      } else {
        setPaypalStep('idle');
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setReconciling(false);
    }
  };

  // Fictitious Sample Batch Audit (`POST /api/review/batch`)
  const handleRunBatchAudit = async () => {
    setBatchLoading(true);
    try {
      const res = await fetch('/api/review/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: DEMO_BATCH_INVOICES }),
      });
      const data = await res.json();
      if (res.ok && data.summary) {
        setBatchSummary(data.summary);
        if (Array.isArray(data.events)) {
          onSyncEvents(data.events);
        }
      }
    } finally {
      setBatchLoading(false);
    }
  };

  // Isolated Red-Team Negative Test Suite (`POST /api/redteam/isolated`)
  const handleRunRedTeamSuite = async () => {
    setRunningRedTeam(true);
    try {
      const res = await fetch('/api/redteam/isolated', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const data = await res.json();
      if (res.ok && Array.isArray(data.results)) {
        setRedTeamResults(data.results);
        setRedTeamScopeNote(data.scope_note || null);
      }
    } finally {
      setRunningRedTeam(false);
    }
  };

  // Human-readable protocol summary
  const readableProtocolSteps = useMemo(() => {
    return events.slice(-6).map((evt) => {
      const p = evt.payload as Record<string, unknown>;
      switch (evt.event_type) {
        case 'ai_invoice_extraction':
          return {
            index: evt.index,
            title: '1. Structured Field Proposal Created',
            detail: `Mode: ${String(p.provider_mode)} · Opt-In: ${String(Boolean(p.external_ai_opt_in))}`,
            hash: evt.event_hash,
          };
        case 'invoice_review':
          return {
            index: evt.index,
            title:
              p.status === 'FIELDS_CONSISTENT'
                ? `2. Fields Confirmed & Rules Verified: Consistent (${String(p.verified_amount_eur)} EUR)`
                : `2. Fields Confirmed & Rules Verified: Discrepancy (${((p.finding_codes as string[]) || []).join(', ')})`,
            detail: `Status: ${String(p.status)} · Human Sign-Off: Yes`,
            hash: evt.event_hash,
          };
        case 'batch_invoice_audit':
          return {
            index: evt.index,
            title: `Fictitious Batch Evaluation: ${String(p.consistent_count)}/${String(p.total_count)} Consistent`,
            detail: `Flagged Sample Discrepancies: ${String(p.total_blocked_risk_eur)} EUR`,
            hash: evt.event_hash,
          };
        case 'ai_finding_explanation':
          return {
            index: evt.index,
            title: '3. Finding Code Explanation Recorded (Zero-PII)',
            detail: `Engine: ${String(p.model_id)} (${String(p.provider_mode)})`,
            hash: evt.event_hash,
          };
        case 'paypal_sandbox_order':
          return {
            index: evt.index,
            title: `4. PayPal Sandbox Order Created (${String(p.verified_amount_eur)} EUR)`,
            detail: `Order ID: ${String(p.order_id)} · Status: ${String(p.paypal_status)}`,
            hash: evt.event_hash,
          };
        case 'paypal_sandbox_approval':
          return {
            index: evt.index,
            title: '5. Sandbox Order Approved by Buyer',
            detail: `Order ID: ${String(p.order_id)} · Payer: ${String(p.payer_id)} · Status: APPROVED`,
            hash: evt.event_hash,
          };
        case 'paypal_sandbox_capture':
          return {
            index: evt.index,
            title: `6. Sandbox Capture Completed (${String(p.verified_amount_eur)} EUR)`,
            detail: `Order ID: ${String(p.order_id)} · Capture ID: ${String(p.capture_id)}`,
            hash: evt.event_hash,
          };
        case 'paypal_manual_reconciliation':
          return {
            index: evt.index,
            title: `Manual Reconciliation Recorded (${String(p.resolution)})`,
            detail: `Resulting State: ${String(p.resulting_state)}`,
            hash: evt.event_hash,
          };
        default:
          return {
            index: evt.index,
            title: `System Event: ${evt.event_type}`,
            detail: `Event ID: ${evt.event_id}`,
            hash: evt.event_hash,
          };
      }
    });
  }, [events]);

  return (
    <div className="space-y-6">
      {/* Top Banner: 30-Second Jury Value Strip & Honest Provider Transparency */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 shadow-sm space-y-4">
        <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-4">
          <div className="space-y-2.5 max-w-3xl">
            <div className="flex flex-wrap items-center gap-2">
              <span className="p-1.5 rounded-lg bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
                <FileCheck className="w-5 h-5" aria-hidden="true" />
              </span>
              <h2 className="text-lg font-semibold text-white">
                SyntraVariga Invoice &amp; Payment Guard
              </h2>
              <span className="px-2.5 py-0.5 text-[11px] font-mono font-semibold rounded bg-amber-500/15 text-amber-300 border border-amber-500/30">
                DEMO &amp; PAYPAL SANDBOX ONLY (FICTITIOUS DATA)
              </span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-[11px] leading-snug">
              <div className="bg-slate-950/80 border border-slate-800 rounded-lg px-3 py-2">
                <span className="font-mono text-indigo-300 font-semibold block">Target Audience</span>
                <span className="text-slate-300">
                  Freelancers &amp; SMB finance teams verifying incoming supplier invoices before checkout.
                </span>
              </div>
              <div className="bg-slate-950/80 border border-slate-800 rounded-lg px-3 py-2">
                <span className="font-mono text-indigo-300 font-semibold block">Problem Solved</span>
                <span className="text-slate-300">
                  Catches supplier mismatches, VAT math errors, overcharges, and duplicate references before payment.
                </span>
              </div>
              <div className="bg-slate-950/80 border border-slate-800 rounded-lg px-3 py-2">
                <span className="font-mono text-indigo-300 font-semibold block">Guarded Pipeline</span>
                <span className="text-slate-300">
                  AI proposal &rarr; human confirm &rarr; deterministic rules &rarr; SHA-256 log &rarr; PayPal Sandbox check.
                </span>
              </div>
            </div>

            <p className="text-xs text-slate-300 leading-relaxed">
              <strong>Architecture &amp; Honest Limits:</strong> Deterministic integer-cent rules
              alone decide <code>FIELDS_CONSISTENT</code> vs. <code>REVIEW_REQUIRED</code>.
              External AI calls require explicit user opt-in; otherwise deterministic local
              fallbacks (not AI) run. Verified receipts are atomically reserved in SQLite to reduce
              concurrent double-processing risk, while manual PayPal reconciliation covers network ambiguity.
            </p>
          </div>

          {/* Transparent Runtime Status Badges (Emerald green only once actually verified live) */}
          <div className="flex flex-col sm:flex-row lg:flex-col gap-1.5 text-[11px] font-mono shrink-0">
            <div className="px-2.5 py-1.5 rounded bg-slate-950 border border-slate-800 flex items-center justify-between gap-3">
              <span className="text-slate-400">Gemini API:</span>
              <span
                className={
                  liveGeminiVerifiedModel
                    ? 'text-emerald-400'
                    : envCaps.gemini_api_configured
                      ? 'text-sky-300'
                      : 'text-amber-300'
                }
              >
                {liveGeminiVerifiedModel
                  ? `Live Verified (${liveGeminiVerifiedModel})`
                  : envCaps.gemini_api_configured
                    ? `Key Configured (Opt-In · Unverified Live)`
                    : 'Not Configured (Deterministic Non-AI Mode)'}
              </span>
            </div>
            <div className="px-2.5 py-1.5 rounded bg-slate-950 border border-slate-800 flex items-center justify-between gap-3">
              <span className="text-slate-400">PayPal Sandbox:</span>
              <span
                className={
                  livePayPalVerifiedCaptureId
                    ? 'text-emerald-400'
                    : envCaps.paypal_live_sandbox_credentials_configured
                      ? 'text-sky-300'
                      : 'text-amber-300'
                }
              >
                {livePayPalVerifiedCaptureId
                  ? `Live Capture Verified (${livePayPalVerifiedCaptureId})`
                  : envCaps.paypal_live_sandbox_credentials_configured
                    ? 'Live Sandbox Keys Set (Unverified Live)'
                    : 'Local Sandbox Protocol Simulation'}
              </span>
            </div>
          </div>
        </div>

        {/* Demo Scenario Selector Buttons */}
        <div className="pt-3 border-t border-slate-800/80 flex flex-wrap items-center gap-2">
          <span className="text-xs font-mono text-slate-400 mr-1">
            Load Fictitious Scenario:
          </span>
          {(
            [
              {
                key: 'sceneB_consistent',
                label: 'Scenario B: Consistent Invoice (119.00 EUR)',
                cls: 'bg-emerald-950/60 hover:bg-emerald-900/60 text-emerald-200 border-emerald-700/50',
              },
              {
                key: 'sceneA_discrepancy',
                label: 'Scenario A: Amount Discrepancy (149.00 EUR vs. 119.00 EUR)',
                cls: 'bg-rose-950/60 hover:bg-rose-900/60 text-rose-200 border-rose-700/50',
              },
              {
                key: 'missingAmount',
                label: 'Edge Case: Missing Tax Amount',
                cls: 'bg-amber-950/60 hover:bg-amber-900/60 text-amber-200 border-amber-700/50',
              },
              {
                key: 'ambiguousTotals',
                label: 'Edge Case: Two Conflicting Total Amounts',
                cls: 'bg-purple-950/60 hover:bg-purple-900/60 text-purple-200 border-purple-700/50',
              },
            ] as const
          ).map(({ key, label, cls }) => (
            <button
              key={key}
              type="button"
              disabled={isPayPalBusy}
              onClick={() => handleSelectScenario(key)}
              className={`px-3 py-1.5 text-xs rounded-lg border font-mono transition disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 ${cls}`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {errorMsg && (
        <div className="bg-rose-950/80 border border-rose-500/70 rounded-xl p-4 text-xs font-mono text-rose-200 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0" />
          <div>
            <strong className="text-rose-400">FAIL-CLOSED BLOCK:</strong> {errorMsg}
          </div>
        </div>
      )}

      {/* Main 4-Step Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* LEFT COLUMN (7 Cols): Section 1 & Section 2 */}
        <div className="lg:col-span-7 space-y-6">
          {/* SECTION 1: Enter Invoice Text & Expected Purchase Order Data */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div className="flex items-center gap-2">
                <span className="w-6 h-6 rounded-full bg-indigo-500/20 border border-indigo-500/40 text-indigo-300 text-xs font-mono font-bold flex items-center justify-center">
                  1
                </span>
                <h3 className="text-sm font-semibold text-white">
                  Enter Fictitious Invoice Text &amp; Expected Purchase Order Data
                </h3>
              </div>
              <span className="text-[11px] font-mono text-emerald-400 flex items-center gap-1">
                <ShieldCheck className="w-3.5 h-3.5" />
                {allowExternalAiForText
                  ? 'External Gemini Opt-In Active'
                  : 'Local Deterministic Parser (Not AI)'}
              </span>
            </div>

            {/* Expected Order Values */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 bg-slate-950/70 p-3.5 rounded-lg border border-slate-800">
              <div>
                <label
                  htmlFor="po-expected-vendor"
                  className="block text-xs font-medium text-slate-300 mb-1"
                >
                  Expected Supplier (Purchase Order)
                </label>
                <input
                  id="po-expected-vendor"
                  type="text"
                  name="expected_vendor"
                  value={formData.expected_vendor}
                  onChange={handleFieldChange}
                  disabled={isPayPalBusy}
                  className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-white font-mono focus:outline-none focus:ring-2 focus:ring-indigo-400 disabled:opacity-50"
                />
              </div>
              <div>
                <label
                  htmlFor="po-expected-amount"
                  className="block text-xs font-medium text-slate-300 mb-1"
                >
                  Expected Order Gross Amount (EUR)
                </label>
                <input
                  id="po-expected-amount"
                  type="text"
                  name="expected_amount"
                  value={formData.expected_amount}
                  onChange={handleFieldChange}
                  disabled={isPayPalBusy}
                  className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-white font-mono focus:outline-none focus:ring-2 focus:ring-indigo-400 disabled:opacity-50"
                />
              </div>
            </div>

            {/* Fictitious Invoice Textarea */}
            <div>
              <label
                htmlFor="raw-invoice-textarea"
                className="block text-xs font-medium text-slate-300 mb-1"
              >
                Fictitious Invoice Text (For Field Proposal &amp; Uncertainty Detection)
              </label>
              <textarea
                id="raw-invoice-textarea"
                rows={5}
                value={rawInvoiceText}
                disabled={isPayPalBusy}
                onChange={(e) => {
                  setRawInvoiceText(e.target.value);
                  setAiProposal(null);
                  setExtractAiError(null);
                  invalidateConfirmedReview();
                }}
                className="w-full bg-slate-950 border border-slate-700 rounded-lg p-3 text-xs text-slate-100 font-mono focus:outline-none focus:ring-2 focus:ring-indigo-400 disabled:opacity-50"
              />
            </div>

            {/* Privacy & Consent Control for Step 1 */}
            <div className="bg-slate-950 border border-slate-800 rounded-lg p-3 text-[11px] text-slate-300 space-y-2">
              <div className="flex items-start gap-2">
                <Info className="w-4 h-4 text-indigo-400 shrink-0 mt-0.5" aria-hidden="true" />
                <div>
                  <strong>Privacy &amp; External AI Consent (Step 1):</strong> By default, field
                  extraction runs <strong>100% locally via a deterministic regex parser (not AI)</strong>{' '}
                  so zero invoice data leaves the server. If you check the opt-in box below, the{' '}
                  <strong>full fictitious invoice text</strong> entered above will be transmitted to{' '}
                  <strong>Google Gemini ({envCaps.gemini_model_id || 'gemini-3.8-flash'})</strong>.
                  Note: API calls may incur costs depending on your Google API key billing tier.
                </div>
              </div>
              <label
                htmlFor="optin-extract-gemini"
                className="flex items-center gap-2 text-[11px] font-mono text-indigo-300 cursor-pointer pt-1"
              >
                <input
                  id="optin-extract-gemini"
                  type="checkbox"
                  checked={allowExternalAiForText}
                  onChange={(e) => setAllowExternalAiForText(e.target.checked)}
                  className="rounded border-slate-700 bg-slate-900 text-indigo-600 focus:ring-2 focus:ring-indigo-400"
                />
                <span>
                  Explicit Consent: Transmit fictitious invoice text above to Google Gemini API
                </span>
              </label>
            </div>

            <div className="flex justify-end">
              <button
                type="button"
                onClick={handleRunAiExtraction}
                disabled={extracting || isPayPalBusy}
                aria-busy={extracting}
                className="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-xs font-semibold font-mono flex items-center gap-2 shadow-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
              >
                {extracting ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                ) : (
                  <FileText className="w-3.5 h-3.5" aria-hidden="true" />
                )}
                {extracting
                  ? 'Extracting Fields...'
                  : 'Step 1: Propose Structured Fields from Text'}
              </button>
            </div>

            {extractAiError && (
              <div className="bg-amber-950/60 border border-amber-600/50 rounded-lg p-3 text-[11px] font-mono text-amber-200">
                <strong>External AI Call Notice:</strong> {extractAiError}
              </div>
            )}

            {/* Extraction Proposal Banner & Warnings */}
            {aiProposal && (
              <div className="bg-slate-950 border border-indigo-500/40 rounded-lg p-3.5 space-y-2.5 text-xs">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-mono font-semibold text-indigo-300 flex items-center gap-1.5">
                    <Sparkles className="w-3.5 h-3.5 text-indigo-400" />
                    Field Proposal Generated (Human Inspection Required)
                  </span>
                  <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-slate-900 text-slate-300 border border-slate-700">
                    {aiProposal.provider_mode} · {aiProposal.model_id}
                  </span>
                </div>

                <p className="text-slate-300 text-[11px]">{aiProposal.extractor_notes}</p>

                {aiProposal.warnings.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    {aiProposal.warnings.map((w, idx) => (
                      <span
                        key={idx}
                        className="px-2 py-0.5 rounded bg-amber-500/20 border border-amber-500/40 text-amber-200 font-mono text-[11px] flex items-center gap-1"
                      >
                        <AlertTriangle className="w-3 h-3 text-amber-400" />
                        {w}
                      </span>
                    ))}
                  </div>
                )}

                {aiProposal.ambiguous_fields.length > 0 && (
                  <div className="bg-amber-950/40 border border-amber-700/50 rounded p-2.5 space-y-1.5">
                    {aiProposal.ambiguous_fields.map((amb, idx) => (
                      <div key={idx} className="text-[11px] font-mono text-amber-200 space-y-1">
                        <div>{amb.note}</div>
                        <div className="flex items-center gap-2">
                          <span className="text-slate-400">Select candidate manually:</span>
                          {amb.candidates.map((cand) => (
                            <button
                              key={cand}
                              type="button"
                              onClick={() => {
                                setFormData((prev) => ({
                                  ...prev,
                                  gross_amount: cand,
                                  amount: cand,
                                }));
                                invalidateConfirmedReview();
                              }}
                              className="px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-amber-300 border border-amber-600/40"
                            >
                              {cand} EUR
                            </button>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* SECTION 2: Inspect & Confirm Proposed Fields */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div className="flex items-center gap-2">
                <span className="w-6 h-6 rounded-full bg-indigo-500/20 border border-indigo-500/40 text-indigo-300 text-xs font-mono font-bold flex items-center justify-center">
                  2
                </span>
                <h3 className="text-sm font-semibold text-white">
                  Inspect, Edit &amp; Confirm Proposed Invoice Fields
                </h3>
              </div>
              <span className="text-[11px] font-mono text-amber-300 flex items-center gap-1">
                <UserCheck className="w-3.5 h-3.5" />
                Human Confirmation Before Rule Check
              </span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
              {(
                [
                  {
                    name: 'vendor',
                    label: 'Supplier on Invoice (Actual)',
                    placeholder: 'Missing – please inspect',
                  },
                  {
                    name: 'invoice_number',
                    label: 'Invoice Number',
                    placeholder: 'Missing – please inspect',
                  },
                  {
                    name: 'net_amount',
                    label: 'Net Amount (EUR)',
                    placeholder: 'Missing – please inspect',
                  },
                  {
                    name: 'tax_amount',
                    label: 'VAT / Tax Amount (EUR)',
                    placeholder: 'Missing – please inspect',
                  },
                  {
                    name: 'gross_amount',
                    label: 'Gross Amount on Invoice (EUR)',
                    placeholder: 'Please inspect / select',
                  },
                  {
                    name: 'amount',
                    label: 'Payment Amount to Verify (EUR)',
                    placeholder: 'Please inspect / select',
                  },
                ] as const
              ).map(({ name, label, placeholder }) => (
                <div key={name}>
                  <label
                    htmlFor={`field-${name}`}
                    className="block text-xs font-medium text-slate-300 mb-1"
                  >
                    {label}
                  </label>
                  <input
                    id={`field-${name}`}
                    type="text"
                    name={name}
                    value={formData[name]}
                    onChange={handleFieldChange}
                    disabled={isPayPalBusy}
                    placeholder={placeholder}
                    className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-xs text-white font-mono focus:outline-none focus:ring-2 focus:ring-indigo-400 disabled:opacity-50"
                  />
                </div>
              ))}
            </div>

            <div className="pt-2 flex flex-col gap-3 border-t border-slate-800">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                <label
                  htmlFor="toggle-ledger-duplicate-check"
                  className="flex items-center gap-2 text-[11px] font-mono text-slate-300 cursor-pointer"
                >
                  <input
                    id="toggle-ledger-duplicate-check"
                    type="checkbox"
                    checked={checkLedgerDuplicates}
                    onChange={(e) => setCheckLedgerDuplicates(e.target.checked)}
                    disabled={isPayPalBusy}
                    className="rounded border-slate-700 bg-slate-900 text-indigo-600 focus:ring-2 focus:ring-indigo-400"
                  />
                  <span>
                    Check against previously verified ledger invoice numbers (
                    <code>DUPLICATE_INVOICE</code>)
                  </span>
                </label>
                <span className="text-[11px] text-slate-400">
                  Any edit invalidates the active receipt.
                </span>
              </div>
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={handleConfirmAndSealReview}
                  disabled={reviewing || isPayPalBusy}
                  aria-busy={reviewing}
                  className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-slate-950 font-semibold text-xs font-mono flex items-center justify-center gap-2 shadow-sm transition shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300"
                >
                  {reviewing ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                  ) : (
                    <Lock className="w-3.5 h-3.5" aria-hidden="true" />
                  )}
                  {reviewing
                    ? 'Verifying Rules...'
                    : 'Step 2: Confirm Fields & Run Deterministic Rules'}
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* RIGHT COLUMN (5 Cols): Section 3 & Section 4 */}
        <div className="lg:col-span-5 space-y-6">
          {/* SECTION 3: Deterministic Rule Result & Zero-PII Finding Explanation */}
          <div
            className={`rounded-xl border p-5 space-y-4 ${
              isConsistent
                ? 'bg-emerald-950/30 border-emerald-500/40'
                : 'bg-rose-950/30 border-rose-500/40'
            }`}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="w-6 h-6 rounded-full bg-slate-900 border border-slate-700 text-slate-200 text-xs font-mono font-bold flex items-center justify-center">
                  3
                </span>
                <h3 className="text-sm font-semibold text-white">
                  Rule Result &amp; Zero-PII Code Explanation
                </h3>
              </div>
              <span
                className={`px-2.5 py-0.5 rounded text-xs font-mono font-bold ${
                  isConsistent
                    ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                    : 'bg-rose-500/20 text-rose-300 border border-rose-500/30'
                }`}
              >
                {localAnalysis.status}
              </span>
            </div>

            <div className="bg-slate-950/80 border border-slate-800 rounded-lg p-3 text-xs text-slate-200 leading-relaxed">
              {localAnalysis.explanation}
            </div>

            {/* Findings List */}
            <div className="space-y-2">
              <div className="text-xs font-mono font-semibold text-slate-400 uppercase tracking-wider">
                Rule Findings ({localAnalysis.findings.length}):
              </div>
              {localAnalysis.findings.length === 0 ? (
                <div className="text-xs font-mono text-emerald-300 bg-emerald-950/60 p-3 rounded-lg border border-emerald-800/60 flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                  <span>
                    No discrepancy detected in supplier, order amount ({formData.amount} EUR), or
                    tax sum.
                  </span>
                </div>
              ) : (
                localAnalysis.findings.map((finding, idx) => (
                  <div
                    key={idx}
                    className="text-xs font-mono bg-rose-950/80 border border-rose-800/80 p-3 rounded-lg text-rose-100 space-y-1"
                  >
                    <div className="font-bold text-rose-300">
                      [{finding.code}] · Field: {finding.field}
                    </div>
                    <div className="text-rose-100">{finding.message}</div>
                  </div>
                ))
              )}
            </div>

            {/* Sealed Receipt Info & Zero-PII Finding Explanation */}
            {lastReceipt ? (
              <div className="pt-3 border-t border-slate-800/80 space-y-3">
                <div className="bg-slate-950 rounded-lg p-3 border border-indigo-500/30 text-[11px] font-mono space-y-1 text-slate-300">
                  <div className="flex items-center justify-between text-indigo-300 font-semibold">
                    <span>Sealed Audit Receipt (#{lastReceipt.index})</span>
                    <span>
                      Verified Amount:{' '}
                      {lastReceipt.verified_amount_eur
                        ? `${lastReceipt.verified_amount_eur} EUR`
                        : 'BLOCKED'}
                    </span>
                  </div>
                  <div className="truncate text-slate-400">
                    Receipt Hash: <span className="text-slate-200">{lastReceipt.event_hash}</span>
                  </div>
                </div>

                {/* Explicit Consent Box for Step 3 Explainer */}
                <div className="bg-slate-950 border border-slate-800 rounded-lg p-3 text-[11px] text-slate-300 space-y-1.5">
                  <div>
                    <strong>Privacy &amp; External AI Consent (Step 3):</strong> By default,
                    finding explanations use a{' '}
                    <strong>deterministic local rule dictionary (not AI)</strong>. If you opt in
                    below, <strong>only</strong> <code>status</code> (
                    <code>{localAnalysis.status}</code>) and <code>finding_codes</code> (
                    <code>
                      [{localAnalysis.findings.map((f) => f.code).join(', ') || 'NONE'}]
                    </code>
                    ) are sent to{' '}
                    <strong>Google Gemini ({envCaps.gemini_model_id || 'gemini-3.8-flash'})</strong>{' '}
                    (zero invoice PII).
                  </div>
                  <label
                    htmlFor="optin-explain-gemini"
                    className="flex items-center gap-2 text-[11px] font-mono text-indigo-300 cursor-pointer"
                  >
                    <input
                      id="optin-explain-gemini"
                      type="checkbox"
                      checked={allowExternalAiForExplain}
                      onChange={(e) => setAllowExternalAiForExplain(e.target.checked)}
                      className="rounded border-slate-700 bg-slate-900 text-indigo-600 focus:ring-2 focus:ring-indigo-400"
                    />
                    <span>
                      Explicit Consent: Send status &amp; finding_codes to Google Gemini API
                    </span>
                  </label>
                </div>

                <button
                  type="button"
                  onClick={handleRequestAiFindingExplanation}
                  disabled={explaining}
                  aria-busy={explaining}
                  className="w-full py-2 px-3 rounded-lg bg-indigo-950/80 hover:bg-indigo-900/80 disabled:opacity-50 text-indigo-200 border border-indigo-500/40 text-xs font-mono flex items-center justify-center gap-1.5 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
                >
                  {explaining ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin text-indigo-400" aria-hidden="true" />
                  ) : (
                    <Sparkles className="w-3.5 h-3.5 text-indigo-400" aria-hidden="true" />
                  )}
                  {explaining
                    ? 'Generating Zero-PII Finding Explanation...'
                    : 'Step 3: Explain Finding Codes (Zero Invoice PII)'}
                </button>

                {explainAiError && (
                  <div className="bg-amber-950/60 border border-amber-600/50 rounded-lg p-3 text-[11px] font-mono text-amber-200">
                    <strong>External AI Call Notice:</strong> {explainAiError}
                  </div>
                )}

                {aiExplanation && (
                  <div className="bg-slate-950 border border-indigo-500/30 rounded-lg p-3.5 space-y-2.5 text-xs">
                    <div className="flex items-center justify-between text-[10px] font-mono text-slate-400">
                      <span>
                        Zero-PII Payload: [{aiExplanation.finding_codes.join(', ') || 'NONE'}]
                      </span>
                      <span className="text-indigo-300">
                        {aiExplanation.provider_mode} · {aiExplanation.model_id}
                      </span>
                    </div>
                    <p className="text-slate-200 text-[11px] leading-relaxed">
                      {aiExplanation.executive_summary}
                    </p>
                    <div className="space-y-1.5">
                      {aiExplanation.code_explanations.map((ce, i) => (
                        <div
                          key={i}
                          className="bg-slate-900 border border-slate-800 rounded p-2 text-[11px] font-mono"
                        >
                          <div className="text-indigo-300 font-semibold">[{ce.code}]</div>
                          <div className="text-slate-300">{ce.meaning}</div>
                          <div className="text-emerald-300/90 mt-0.5">
                            Verification Step: {ce.verification_step}
                          </div>
                        </div>
                      ))}
                    </div>
                    <div className="text-[10px] font-mono text-amber-300/90 border-t border-slate-800 pt-2">
                      <strong>Server-Enforced Disclaimer:</strong>{' '}
                      {aiExplanation.boundary_disclaimer}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="text-[11px] font-mono text-amber-300/90 bg-amber-950/40 border border-amber-800/40 rounded-lg p-2.5">
                Please click{' '}
                <strong>“Step 2: Confirm Fields &amp; Run Deterministic Rules”</strong> in Section 2
                to seal the verification receipt in the persistent audit ledger.
              </div>
            )}
          </div>

          {/* SECTION 4: Deliberately Initiate & Confirm PayPal Sandbox Payment */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div className="flex items-center gap-2">
                <span className="w-6 h-6 rounded-full bg-amber-500/20 border border-amber-500/40 text-amber-300 text-xs font-mono font-bold flex items-center justify-center">
                  4
                </span>
                <h3 className="text-sm font-semibold text-white">
                  PayPal Sandbox Payment (Atomic Reservation &amp; Strict Verification)
                </h3>
              </div>
              <span className="text-[11px] font-mono text-amber-400 flex items-center gap-1">
                <CreditCard className="w-3.5 h-3.5" />
                Persistent Lock · Server-Bound
              </span>
            </div>

            {!lastReceipt ? (
              <div className="bg-slate-950 border border-slate-800 rounded-lg p-4 text-xs text-slate-400 font-mono flex items-center gap-2.5">
                <Lock className="w-4 h-4 text-slate-400 shrink-0" aria-hidden="true" />
                <span>
                  Payment path locked: Confirm and verify the proposed invoice fields in Step 2
                  first (or resume a persisted Sandbox record below).
                </span>
              </div>
            ) : !isConsistent ? (
              <div className="bg-rose-950/60 border border-rose-700/60 rounded-lg p-4 text-xs text-rose-200 font-mono flex items-start gap-2.5">
                <ShieldAlert className="w-5 h-5 text-rose-400 shrink-0 mt-0.5" aria-hidden="true" />
                <div className="space-y-1">
                  <div className="font-bold text-rose-300">
                    PAYMENT PATH LOCKED (STATUS: REVIEW_REQUIRED)
                  </div>
                  <div>
                    Discrepancies were detected for this invoice. The server refuses to create a
                    PayPal Sandbox order.
                  </div>
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="bg-slate-950 border border-slate-800 rounded-lg p-3 text-xs font-mono space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="text-slate-400">Server-Bound Amount:</span>
                    <span className="text-emerald-400 font-bold">
                      {lastReceipt.verified_amount_eur} {lastReceipt.verified_currency}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="text-slate-400">One-Time Receipt:</span>
                    <span className="text-slate-300">
                      #{lastReceipt.index} ({lastReceipt.event_hash.slice(0, 12)}…)
                    </span>
                  </div>
                  {currentPaymentRecord && (
                    <div className="flex items-center justify-between text-[11px] pt-1 border-t border-slate-800/80">
                      <span className="text-slate-400">Persistent Payment State:</span>
                      <span className="text-indigo-300 font-semibold">
                        {currentPaymentRecord.state}
                      </span>
                    </div>
                  )}
                </div>

                {/* Explicit Payment Lock & Progress Banner while PayPal Sandbox request is in flight */}
                {isPayPalBusy && !reconciling && (
                  <div
                    role="status"
                    aria-live="polite"
                    className="bg-indigo-950/60 border border-indigo-500/50 rounded-lg p-3 text-xs font-mono text-indigo-200 flex items-center gap-2.5"
                  >
                    <Loader2 className="w-4 h-4 animate-spin text-indigo-300 shrink-0" aria-hidden="true" />
                    <div>
                      {paypalStep === 'creating_order' &&
                        'Creating PayPal Sandbox Order (payment actions locked to prevent double execution)...'}
                      {paypalStep === 'approving' &&
                        'Verifying Sandbox Buyer Approval via PayPal API (payment actions locked)...'}
                      {paypalStep === 'capturing' &&
                        'Capturing Approved PayPal Sandbox Order (payment actions locked; awaiting final confirmation)...'}
                    </div>
                  </div>
                )}

                {/* Manual Reconciliation UI when state is UNKNOWN_RECONCILIATION_REQUIRED */}
                {currentPaymentRecord?.state === 'UNKNOWN_RECONCILIATION_REQUIRED' && (
                  <div className="bg-amber-950/60 border border-amber-500/60 rounded-lg p-3.5 space-y-2.5 text-xs font-mono">
                    <div className="font-bold text-amber-300 flex items-center gap-1.5">
                      <Wrench className="w-4 h-4 text-amber-400" aria-hidden="true" />
                      STATE UNKNOWN — MANUAL RECONCILIATION REQUIRED
                    </div>
                    <p className="text-[11px] text-amber-100">
                      A prior network timeout or error left this operation in an ambiguous state (
                      {currentPaymentRecord.last_error}). Automatic retries are blocked to avoid
                      accidental double processing. Please inspect the PayPal Sandbox dashboard and
                      reconcile manually:
                    </p>
                    <div>
                      <label htmlFor="reconcile-note-input" className="sr-only">
                        Operator reconciliation note
                      </label>
                      <input
                        id="reconcile-note-input"
                        type="text"
                        value={reconcileNote}
                        onChange={(e) => setReconcileNote(e.target.value)}
                        placeholder="Operator reconciliation note..."
                        className="w-full bg-slate-900 border border-slate-700 rounded px-2.5 py-1.5 text-[11px] text-white focus:outline-none focus:ring-2 focus:ring-amber-400"
                      />
                    </div>
                    <div className="flex flex-wrap gap-2 items-center">
                      <button
                        type="button"
                        disabled={reconciling}
                        onClick={() => handleManualReconcile('MARK_CANCELLED')}
                        className="px-2.5 py-1.5 rounded bg-rose-800 hover:bg-rose-700 disabled:opacity-50 text-white text-[11px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-300"
                      >
                        {reconciling ? 'Updating...' : 'Mark Cancelled / Not Executed'}
                      </button>
                      <label htmlFor="reconcile-capture-id" className="sr-only">
                        PayPal Sandbox Capture ID
                      </label>
                      <input
                        id="reconcile-capture-id"
                        type="text"
                        value={reconcileCaptureId}
                        onChange={(e) => setReconcileCaptureId(e.target.value)}
                        placeholder="Capture ID (if captured)"
                        className="bg-slate-900 border border-slate-700 rounded px-2 py-1 text-[11px] text-white w-36 focus:outline-none focus:ring-2 focus:ring-amber-400"
                      />
                      <button
                        type="button"
                        disabled={reconciling}
                        onClick={() => handleManualReconcile('CONFIRM_CAPTURED')}
                        className="px-2.5 py-1.5 rounded bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 text-white text-[11px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300"
                      >
                        {reconciling ? 'Updating...' : 'Confirm Captured in Sandbox'}
                      </button>
                    </div>
                  </div>
                )}

                {paypalStep === 'idle' &&
                  currentPaymentRecord?.state !== 'UNKNOWN_RECONCILIATION_REQUIRED' &&
                  currentPaymentRecord?.state !== 'COMPLETED' && (
                    <button
                      type="button"
                      disabled={isPayPalBusy}
                      onClick={handleCreateSandboxOrder}
                      className="w-full py-2.5 px-4 rounded-lg bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-slate-950 font-bold text-xs font-mono flex items-center justify-center gap-2 shadow transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300"
                    >
                      <span>
                        1. Create PayPal Sandbox Order for {lastReceipt.verified_amount_eur} EUR
                      </span>
                      <ArrowRight className="w-4 h-4" aria-hidden="true" />
                    </button>
                  )}

                {paypalStep === 'order_created' && activeOrder && (
                  <div className="bg-amber-950/40 border border-amber-600/40 rounded-lg p-3.5 space-y-3">
                    <div className="text-xs font-mono text-amber-200 space-y-1">
                      <div className="font-bold text-amber-300">
                        Sandbox Order Created: {activeOrder.id} (Status: {activeOrder.status})
                      </div>
                      <div className="text-[11px] text-slate-300">
                        Amount: {activeOrder.purchase_units[0]?.amount.value} EUR · Custom ID:{' '}
                        {activeOrder.purchase_units[0]?.custom_id.slice(0, 14)}…
                      </div>
                      <div className="pt-1">
                        <a
                          href={activeOrder.approve_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-[11px] text-amber-300 hover:text-amber-200 underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300 rounded"
                        >
                          <span>Official PayPal Sandbox Buyer Approval Link ({activeOrder.id})</span>
                          <ExternalLink className="w-3 h-3" aria-hidden="true" />
                        </a>
                      </div>
                    </div>
                    <button
                      type="button"
                      disabled={isPayPalBusy}
                      onClick={handleApproveSandboxOrder}
                      className="w-full py-2 px-3 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white font-semibold text-xs font-mono flex items-center justify-center gap-2 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300"
                    >
                      <UserCheck className="w-3.5 h-3.5" aria-hidden="true" />
                      <span>
                        {activeOrder.execution_mode === 'LIVE_PAYPAL_SANDBOX_REST'
                          ? '2. Verify Buyer Approval via PayPal Sandbox (GET Order)'
                          : '2. Simulate Sandbox Buyer Approval'}
                      </span>
                    </button>
                  </div>
                )}

                {paypalStep === 'order_approved' && activeOrder && (
                  <div className="bg-indigo-950/50 border border-indigo-500/40 rounded-lg p-3.5 space-y-3">
                    <div className="text-xs font-mono text-indigo-200 space-y-1">
                      <div className="font-bold text-indigo-300">
                        Buyer Approval Verified (Status: {activeOrder.status})
                      </div>
                      <div className="text-[11px] text-slate-300">
                        Sandbox Buyer: {activeOrder.payer?.email_address} (
                        {activeOrder.payer?.payer_id})
                      </div>
                    </div>
                    <button
                      type="button"
                      disabled={isPayPalBusy}
                      onClick={handleCaptureSandboxOrder}
                      className="w-full py-2 px-3 rounded-lg bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-slate-950 font-bold text-xs font-mono flex items-center justify-center gap-2 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300"
                    >
                      <CheckCircle2 className="w-3.5 h-3.5" aria-hidden="true" />
                      <span>
                        3. Capture Approved Sandbox Order ({lastReceipt.verified_amount_eur} EUR)
                      </span>
                    </button>
                  </div>
                )}

                {paypalStep === 'completed' && activeOrder && (
                  <div className="bg-emerald-950/60 border border-emerald-500/50 rounded-lg p-3.5 text-xs font-mono text-emerald-200 space-y-1.5">
                    <div className="font-bold text-emerald-300 flex items-center gap-1.5">
                      <CheckCircle2 className="w-4 h-4 text-emerald-400" aria-hidden="true" />
                      PayPal Sandbox Status: {activeOrder.status}
                    </div>
                    <div className="text-[11px] text-slate-200">
                      Order ID: <span className="text-white">{activeOrder.id}</span> · Capture ID:{' '}
                      <span className="text-white">
                        {activeOrder.purchase_units[0]?.payments?.captures?.[0]?.id ||
                          currentPaymentRecord?.capture_id ||
                          activeOrder.id}
                      </span>
                    </div>
                    <div className="text-[11px] text-emerald-300">
                      Captured Amount: {activeOrder.purchase_units[0]?.amount.value} EUR (
                      {activeOrder.execution_mode})
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Persisted SQLite Payment Records (Survives Reloads & Server Restarts) */}
            {persistedPaymentList.length > 0 && (
              <div className="pt-3 border-t border-slate-800 space-y-2">
                <div className="flex items-center justify-between text-[11px] font-mono text-slate-400">
                  <span>Persisted Sandbox Payment Records (SQLite)</span>
                  <span>{persistedPaymentList.length} total</span>
                </div>
                <div className="space-y-1.5 max-h-48 overflow-y-auto pr-1">
                  {persistedPaymentList.slice(0, 6).map((rec) => (
                    <div
                      key={rec.receipt_hash}
                      className="bg-slate-950 border border-slate-800 rounded-lg p-2.5 text-[11px] font-mono flex flex-col sm:flex-row sm:items-center justify-between gap-2"
                    >
                      <div className="space-y-0.5 min-w-0">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="text-slate-200 font-semibold">
                            #{rec.receipt_index} · {rec.verified_amount_eur} EUR
                          </span>
                          <span
                            className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                              rec.state === 'COMPLETED'
                                ? 'bg-emerald-500/20 text-emerald-300'
                                : rec.state === 'UNKNOWN_RECONCILIATION_REQUIRED'
                                  ? 'bg-amber-500/20 text-amber-300'
                                  : 'bg-indigo-500/20 text-indigo-300'
                            }`}
                          >
                            {rec.state}
                          </span>
                        </div>
                        <div className="text-[10px] text-slate-400 truncate">
                          Receipt {rec.receipt_hash.slice(0, 12)}…
                          {rec.order_id ? ` · Order ${rec.order_id}` : ''}
                          {rec.capture_id ? ` · Capture ${rec.capture_id}` : ''}
                        </div>
                      </div>
                      <button
                        type="button"
                        disabled={isPayPalBusy}
                        onClick={() => handleResumePersistedRecord(rec)}
                        className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-200 border border-slate-700 flex items-center gap-1 shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
                      >
                        <RotateCcw className="w-3 h-3" aria-hidden="true" />
                        Resume / Inspect
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* JURY SHOWCASE SECTION: Fictitious Batch Inbox Sample & Isolated Red-Team Self-Test */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Fictitious Batch Invoice Sample (7 Cols) */}
        <div className="lg:col-span-7 bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-800 pb-3">
            <div className="flex items-center gap-2">
              <Layers className="w-5 h-5 text-indigo-400" />
              <div>
                <h3 className="text-sm font-semibold text-white">
                  Fictitious Sample Batch Evaluation (5 Synthetic Invoices)
                </h3>
                <p className="text-[11px] text-slate-400">
                  Evaluates 5 synthetic test invoices against deterministic rules (amount
                  discrepancies, duplicate invoice numbers, tax math mismatches, and supplier
                  mismatches). Note: Rejected sample amounts represent synthetic rule hits, not
                  proven real-world savings or confirmed fraud.
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={handleRunBatchAudit}
              disabled={batchLoading}
              aria-busy={batchLoading}
              className="px-3.5 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-xs font-mono font-semibold shrink-0 transition flex items-center gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
            >
              {batchLoading && <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />}
              {batchLoading ? 'Evaluating Batch...' : 'Evaluate 5 Fictitious Sample Invoices'}
            </button>
          </div>

          {batchSummary ? (
            <div className="space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs font-mono">
                <div className="bg-slate-950 border border-slate-800 rounded-lg p-3">
                  <div className="text-slate-400 text-[10px]">Sample Batch Total</div>
                  <div className="text-sm font-bold text-white mt-0.5">
                    {batchSummary.total_requested_eur} EUR
                  </div>
                </div>
                <div className="bg-emerald-950/40 border border-emerald-700/40 rounded-lg p-3">
                  <div className="text-emerald-300 text-[10px]">
                    Consistent ({batchSummary.consistent_count} Sample)
                  </div>
                  <div className="text-sm font-bold text-emerald-400 mt-0.5">
                    {batchSummary.total_verified_payable_eur} EUR
                  </div>
                </div>
                <div className="bg-rose-950/40 border border-rose-700/40 rounded-lg p-3">
                  <div className="text-rose-300 text-[10px]">
                    Flagged for Review ({batchSummary.blocked_count} Samples)
                  </div>
                  <div className="text-sm font-bold text-rose-400 mt-0.5">
                    {batchSummary.total_blocked_risk_eur} EUR
                  </div>
                </div>
              </div>

              <div className="space-y-2">
                {batchSummary.results.map((item) => (
                  <div
                    key={item.id}
                    className="bg-slate-950 border border-slate-800 rounded-lg p-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs font-mono"
                  >
                    <div className="space-y-0.5">
                      <div className="flex items-center gap-2">
                        <span
                          className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                            item.analysis.status === 'FIELDS_CONSISTENT'
                              ? 'bg-emerald-500/20 text-emerald-300'
                              : 'bg-rose-500/20 text-rose-300'
                          }`}
                        >
                          {item.analysis.status === 'FIELDS_CONSISTENT'
                            ? 'CONSISTENT'
                            : 'REVIEW_REQUIRED'}
                        </span>
                        <span className="text-white font-semibold">
                          {item.invoice_number} · {item.label}
                        </span>
                      </div>
                      <div className="text-[11px] text-slate-400">
                        {item.analysis.findings.length === 0
                          ? `Consistent (${item.amount} EUR)`
                          : item.analysis.findings.map((f) => `[${f.code}] ${f.message}`).join(' ')}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="bg-slate-950 border border-slate-800 rounded-lg p-4 text-xs text-slate-400 font-mono">
              Click <strong>“Evaluate 5 Fictitious Sample Invoices”</strong> to run a synthetic
              batch check demonstrating how the deterministic rules separate consistent entries from
              entries requiring human review.
            </div>
          )}
        </div>

        {/* Isolated Negative Self-Test Suite (5 Cols) */}
        <div className="lg:col-span-5 bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-800 pb-3">
            <div className="flex items-center gap-2">
              <Swords className="w-5 h-5 text-rose-400" />
              <div>
                <h3 className="text-sm font-semibold text-white">
                  Isolated Negative Self-Test Suite (Mocked Sandbox)
                </h3>
                <p className="text-[11px] text-slate-400">
                  Executes 4 isolated negative test cases in a temporary sandbox with mocked
                  adapters—zero external API calls and zero modification of the active ledger.
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={handleRunRedTeamSuite}
              disabled={runningRedTeam}
              aria-busy={runningRedTeam}
              className="px-3 py-2 rounded-lg bg-rose-600 hover:bg-rose-500 disabled:opacity-50 text-white text-xs font-mono font-semibold shrink-0 transition flex items-center gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-300"
            >
              {runningRedTeam && <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />}
              {runningRedTeam ? 'Running Isolated Checks...' : 'Run 4 Isolated Negative Checks'}
            </button>
          </div>

          {redTeamResults ? (
            <div className="space-y-2.5">
              {redTeamScopeNote && (
                <div className="bg-amber-950/40 border border-amber-700/40 rounded p-2 text-[10px] font-mono text-amber-200">
                  <strong>Scope Disclaimer:</strong> {redTeamScopeNote}
                </div>
              )}
              {redTeamResults.map((atk) => (
                <div
                  key={atk.id}
                  className="bg-slate-950 border border-emerald-700/40 rounded-lg p-3 text-xs font-mono space-y-1"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-emerald-300">✔ {atk.title}</span>
                    <span className="px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300 text-[10px]">
                      MAPPED {atk.httpStatus} REJECTED (ISOLATED)
                    </span>
                  </div>
                  <div className="text-[10px] text-slate-400">Check: {atk.endpoint}</div>
                  <div className="text-[11px] text-slate-300 break-words">{atk.serverMessage}</div>
                </div>
              ))}
            </div>
          ) : (
            <div className="bg-slate-950 border border-slate-800 rounded-lg p-4 text-xs text-slate-400 font-mono space-y-1.5">
              <div>
                Verifies 4 specific negative test cases via isolated internal function and SQLite
                checks in a temporary directory (mapped to HTTP 403/400/409 equivalents; not live
                HTTP network traffic and not a general proof of security):
              </div>
              <ul className="list-disc list-inside text-[11px] text-slate-300 space-y-1">
                <li>Client receipt forgery attempt via <code>assertAllowedClientEventType</code> (403)</li>
                <li>Post-review amount mismatch check (999.00 EUR vs. 119.00 EUR) (400)</li>
                <li>Persistent atomic receipt replay / double-order reservation check (409)</li>
                <li>Raw invoice PII field rejection in <code>validateAiExplainRequest</code> (400)</li>
              </ul>
            </div>
          )}
        </div>
      </div>

      {/* SECTION 6.6: Human-Readable Audit Trail */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-slate-800 pb-3">
          <div className="flex items-center gap-2">
            <ListChecks className="w-5 h-5 text-indigo-400" />
            <h3 className="text-sm font-semibold text-white">
              Persistent Audit Trail (Recent Steps &amp; SHA-256 Chain)
            </h3>
          </div>
          <span className="text-[11px] font-mono text-slate-400">
            Note: The hash chain makes post-hoc edits to individual entries detectable, but does not
            prove the truth of initial inputs.
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {readableProtocolSteps.map((step) => (
            <div
              key={step.index}
              className="bg-slate-950 border border-slate-800 rounded-lg p-3 space-y-1 font-mono text-xs"
            >
              <div className="flex items-center justify-between text-[10px] text-slate-400">
                <span>Entry #{step.index}</span>
                <span>SHA-256: {step.hash.slice(0, 10)}…</span>
              </div>
              <div className="font-semibold text-slate-100">{step.title}</div>
              <div className="text-[11px] text-slate-400">{step.detail}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
