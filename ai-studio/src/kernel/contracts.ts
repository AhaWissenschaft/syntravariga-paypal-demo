/**
 * @license
 * SyntraVariga / AhaWissenschaft Institutional Kernel
 * Module: Scientific Contracts & Reproducibility Schemas (Exact Parity with aha_lab/contracts.py)
 *
 * Why this file exists:
 * Enforces fail-closed validation of all 5 scientific research artifacts:
 * 1. ExperimentSpec (aha.lab.experiment.v1)
 * 2. DatasetRecord (aha.lab.dataset.v1)
 * 3. RunPlan (aha.lab.run-plan.v1)
 * 4. RunRecord (aha.lab.run-record.v1)
 * 5. BundleManifest (aha.lab.repro-bundle.v1)
 *
 * Guarantees:
 * - 100% schema and validation parity with AhaWissenschaft/syntravariga-paypal-demo
 * - Screening evidence weights strictly bounded in [0, 0.5]
 * - Fail-closed scientific_authorization gates (domain_truth, robust_signal, external_validation === false)
 */

import { sha256Canonical } from './crypto';

export const EXPERIMENT_SCHEMA = 'aha.lab.experiment.v1';
export const DATASET_SCHEMA = 'aha.lab.dataset.v1';
export const RUN_PLAN_SCHEMA = 'aha.lab.run-plan.v1';
export const RUN_RECORD_SCHEMA = 'aha.lab.run-record.v1';
export const BUNDLE_SCHEMA = 'aha.lab.repro-bundle.v1';
export const WORKSPACE_SCHEMA = 'aha.lab.workspace.v1';

export const EXPERIMENT_ID_RE = /^EXP-[A-Z0-9][A-Z0-9._-]{2,}$/;
export const DATASET_ID_RE = /^DS-[A-Z0-9][A-Z0-9._-]{2,}$/;
export const PLAN_ID_RE = /^PLAN-[A-Z0-9][A-Z0-9._-]{2,}$/;
export const RUN_ID_RE = /^RUN-[A-Z0-9][A-Z0-9._-]{2,}$/;
export const NODE_ID_RE = /^N-[A-Z0-9][A-Z0-9._-]{2,}$/;
export const SHA256_RE = /^[0-9a-f]{64}$/;

export const OUTCOME_STATES = [
  'OBSERVATION',
  'COUNTER_EVIDENCE',
  'NO_ROBUST_SIGNAL',
  'BLOCKED',
  'ERROR',
] as const;
export type OutcomeState = (typeof OUTCOME_STATES)[number];

export const CLAIM_DISPOSITIONS = [
  'SUPPORTS',
  'CONTRADICTS',
  'NO_DIRECT_CLAIM',
] as const;
export type ClaimDisposition = (typeof CLAIM_DISPOSITIONS)[number];

export class LabContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LabContractError';
  }
}

function assertNonEmptyString(val: unknown, label: string): string {
  if (typeof val !== 'string' || !val.trim()) {
    throw new LabContractError(`${label} must be a non-empty string`);
  }
  return val.trim();
}

function assertStringList(
  val: unknown,
  label: string,
  options: { allowEmpty?: boolean } = {}
): string[] {
  const allowEmpty = options.allowEmpty ?? false;
  if (!Array.isArray(val) || (val.length === 0 && !allowEmpty)) {
    throw new LabContractError(
      `${label} must be ${allowEmpty ? 'a' : 'a non-empty'} string array`
    );
  }
  for (const item of val) {
    if (typeof item !== 'string' || !item.trim()) {
      throw new LabContractError(`${label} must contain non-empty strings`);
    }
  }
  return val.map((item) => item.trim());
}

/**
 * Seals an object with a deterministic SHA-256 digest under hashField.
 * Performs deep clone before removing existing hashField to guarantee zero mutation.
 */
export function seal<T extends Record<string, unknown>>(
  value: T,
  hashField: string
): T & Record<string, string> {
  const cloned = JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  delete cloned[hashField];
  const digest = sha256Canonical(cloned);
  cloned[hashField] = digest;
  return cloned as T & Record<string, string>;
}

/**
 * Verifies that the claimed hashField matches the recomputed canonical digest.
 */
export function verifySeal(value: Record<string, unknown>, hashField: string): void {
  const claimed = value[hashField];
  if (typeof claimed !== 'string' || !SHA256_RE.test(claimed)) {
    throw new LabContractError(`invalid or missing ${hashField}`);
  }
  const unsigned = JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  delete unsigned[hashField];
  const expected = sha256Canonical(unsigned);
  if (claimed !== expected) {
    throw new LabContractError(`${hashField} mismatch`);
  }
}

export interface ExperimentSpec {
  schema: typeof EXPERIMENT_SCHEMA;
  experiment_id: string;
  version: string;
  created_at: string;
  question: string;
  domain: string[];
  state: 'FROZEN';
  hypothesis: {
    node_id: string;
    label: string;
    statement: string;
  };
  scope: {
    dataset_boundary: string;
    limitations: string[];
  };
  forbidden_inferences: string[];
  preregistered: boolean;
  analysis: {
    input_kind: string;
    objectives?: string[];
    adapters?: string[];
    config_by_adapter?: Record<string, Record<string, unknown>>;
    seed: number;
    claim_disposition_by_adapter: Record<string, ClaimDisposition>;
    weight_by_adapter?: Record<string, number>;
  };
  multiplicity: {
    family_id: string;
    confirmatory: boolean;
    correction: string | null;
  };
  controls: {
    negative_required: boolean;
    null_model_required: boolean;
    positive_control_required: boolean;
  };
  spec_sha256?: string;
}

export function validateExperimentSpec(
  spec: Record<string, unknown>,
  sealed = true
): void {
  if (!spec || typeof spec !== 'object' || spec.schema !== EXPERIMENT_SCHEMA) {
    throw new LabContractError('unsupported experiment schema');
  }
  const experimentId = assertNonEmptyString(spec.experiment_id, 'experiment_id');
  if (!EXPERIMENT_ID_RE.test(experimentId)) {
    throw new LabContractError('experiment_id must match EXP-*');
  }
  assertNonEmptyString(spec.version, 'version');
  assertNonEmptyString(spec.created_at, 'created_at');
  assertNonEmptyString(spec.question, 'question');
  assertStringList(spec.domain, 'domain');
  if (spec.state !== 'FROZEN') {
    throw new LabContractError('experiment state must be FROZEN');
  }

  const hypothesis = spec.hypothesis as Record<string, unknown> | undefined;
  if (!hypothesis || typeof hypothesis !== 'object' || Array.isArray(hypothesis)) {
    throw new LabContractError('hypothesis must be an object');
  }
  const nodeId = assertNonEmptyString(hypothesis.node_id, 'hypothesis.node_id');
  if (!NODE_ID_RE.test(nodeId)) {
    throw new LabContractError('hypothesis.node_id must match N-*');
  }
  assertNonEmptyString(hypothesis.label, 'hypothesis.label');
  assertNonEmptyString(hypothesis.statement, 'hypothesis.statement');

  const scope = spec.scope as Record<string, unknown> | undefined;
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) {
    throw new LabContractError('scope must be an object');
  }
  assertNonEmptyString(scope.dataset_boundary, 'scope.dataset_boundary');
  assertStringList(scope.limitations, 'scope.limitations');
  assertStringList(spec.forbidden_inferences, 'forbidden_inferences');

  if (typeof spec.preregistered !== 'boolean') {
    throw new LabContractError('preregistered must be boolean');
  }

  const analysis = spec.analysis as Record<string, unknown> | undefined;
  if (!analysis || typeof analysis !== 'object' || Array.isArray(analysis)) {
    throw new LabContractError('analysis must be an object');
  }
  assertNonEmptyString(analysis.input_kind, 'analysis.input_kind');
  const objectives = analysis.objectives ?? [];
  const adapters = analysis.adapters ?? [];
  const objList = assertStringList(objectives, 'analysis.objectives', { allowEmpty: true });
  const adpList = assertStringList(adapters, 'analysis.adapters', { allowEmpty: true });
  if (objList.length === 0 && adpList.length === 0) {
    throw new LabContractError('analysis requires objectives or adapters');
  }

  const configs = analysis.config_by_adapter ?? {};
  if (
    !configs ||
    typeof configs !== 'object' ||
    Array.isArray(configs) ||
    !Object.entries(configs).every(
      ([k, v]) => typeof k === 'string' && v !== null && typeof v === 'object' && !Array.isArray(v)
    )
  ) {
    throw new LabContractError('analysis.config_by_adapter must map adapter ids to objects');
  }

  const seed = analysis.seed;
  if (typeof seed !== 'number' || !Number.isInteger(seed)) {
    throw new LabContractError('analysis.seed must be an integer');
  }

  const dispositions = analysis.claim_disposition_by_adapter as Record<string, string> | undefined;
  if (
    !dispositions ||
    typeof dispositions !== 'object' ||
    Array.isArray(dispositions) ||
    Object.keys(dispositions).length === 0
  ) {
    throw new LabContractError('analysis.claim_disposition_by_adapter must be a non-empty object');
  }
  for (const [adapterId, disposition] of Object.entries(dispositions)) {
    assertNonEmptyString(adapterId, 'claim disposition adapter id');
    if (!CLAIM_DISPOSITIONS.includes(disposition as ClaimDisposition)) {
      throw new LabContractError(`unsupported claim disposition for ${adapterId}: ${disposition}`);
    }
  }

  const weights = (analysis.weight_by_adapter ?? {}) as Record<string, unknown>;
  if (!weights || typeof weights !== 'object' || Array.isArray(weights)) {
    throw new LabContractError('analysis.weight_by_adapter must be an object');
  }
  for (const [adapterId, weight] of Object.entries(weights)) {
    if (!(adapterId in dispositions)) {
      throw new LabContractError(`weight provided without disposition: ${adapterId}`);
    }
    if (typeof weight !== 'number' || Number.isNaN(weight) || weight < 0 || weight > 0.5) {
      throw new LabContractError('screening evidence weights must lie in [0, 0.5]');
    }
  }

  const multiplicity = spec.multiplicity as Record<string, unknown> | undefined;
  if (!multiplicity || typeof multiplicity !== 'object' || Array.isArray(multiplicity)) {
    throw new LabContractError('multiplicity must be an object');
  }
  assertNonEmptyString(multiplicity.family_id, 'multiplicity.family_id');
  const confirmatory = multiplicity.confirmatory;
  if (typeof confirmatory !== 'boolean') {
    throw new LabContractError('multiplicity.confirmatory must be boolean');
  }
  const correction = multiplicity.correction;
  if (correction !== null && typeof correction !== 'string') {
    throw new LabContractError('multiplicity.correction must be string or null');
  }
  if (confirmatory && (!spec.preregistered || !correction)) {
    throw new LabContractError(
      'confirmatory experiment requires preregistration and declared correction'
    );
  }

  const controls = spec.controls as Record<string, unknown> | undefined;
  if (!controls || typeof controls !== 'object' || Array.isArray(controls)) {
    throw new LabContractError('controls must be an object');
  }
  for (const key of ['negative_required', 'null_model_required', 'positive_control_required']) {
    if (typeof controls[key] !== 'boolean') {
      throw new LabContractError(`controls.${key} must be boolean`);
    }
  }

  if (sealed) {
    verifySeal(spec, 'spec_sha256');
  }
}

export interface DatasetRecord {
  schema: typeof DATASET_SCHEMA;
  dataset_id: string;
  created_at: string;
  input_kind: string;
  media_type: string;
  payload_sha256: string;
  source: {
    type: string;
    reference: string;
    license: string;
  };
  parents?: string[];
  metadata?: Record<string, unknown>;
  record_sha256?: string;
}

export function validateDatasetRecord(
  record: Record<string, unknown>,
  sealed = true
): void {
  if (!record || typeof record !== 'object' || record.schema !== DATASET_SCHEMA) {
    throw new LabContractError('unsupported dataset schema');
  }
  const datasetId = assertNonEmptyString(record.dataset_id, 'dataset_id');
  if (!DATASET_ID_RE.test(datasetId)) {
    throw new LabContractError('dataset_id must match DS-*');
  }
  assertNonEmptyString(record.created_at, 'created_at');
  assertNonEmptyString(record.input_kind, 'input_kind');
  assertNonEmptyString(record.media_type, 'media_type');
  const digest = record.payload_sha256;
  if (typeof digest !== 'string' || !SHA256_RE.test(digest)) {
    throw new LabContractError('payload_sha256 must be a SHA-256 digest');
  }
  const source = record.source as Record<string, unknown> | undefined;
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new LabContractError('source must be an object');
  }
  for (const key of ['type', 'reference', 'license']) {
    assertNonEmptyString(source[key], `source.${key}`);
  }
  const parents = record.parents ?? [];
  if (
    !Array.isArray(parents) ||
    !parents.every((item) => typeof item === 'string' && DATASET_ID_RE.test(item))
  ) {
    throw new LabContractError('parents must contain DS-* ids');
  }
  const metadata = record.metadata ?? {};
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new LabContractError('metadata must be an object');
  }
  if (sealed) {
    verifySeal(record, 'record_sha256');
  }
}

export interface RunPlan {
  schema: typeof RUN_PLAN_SCHEMA;
  plan_id: string;
  experiment_id: string;
  dataset_id: string;
  experiment_spec_sha256: string;
  dataset_payload_sha256: string;
  created_at: string;
  input_kind: string;
  selected_adapters: string[];
  claim_disposition_by_adapter: Record<string, ClaimDisposition>;
  config_by_adapter: Record<string, Record<string, unknown>>;
  seed: number;
  plan_sha256?: string;
}

export function validateRunPlan(plan: Record<string, unknown>, sealed = true): void {
  if (!plan || typeof plan !== 'object' || plan.schema !== RUN_PLAN_SCHEMA) {
    throw new LabContractError('unsupported run plan schema');
  }
  if (!PLAN_ID_RE.test(String(plan.plan_id ?? ''))) {
    throw new LabContractError('plan_id must match PLAN-*');
  }
  if (!EXPERIMENT_ID_RE.test(String(plan.experiment_id ?? ''))) {
    throw new LabContractError('invalid experiment_id in plan');
  }
  if (!DATASET_ID_RE.test(String(plan.dataset_id ?? ''))) {
    throw new LabContractError('invalid dataset_id in plan');
  }
  for (const key of ['experiment_spec_sha256', 'dataset_payload_sha256']) {
    if (!SHA256_RE.test(String(plan[key] ?? ''))) {
      throw new LabContractError(`invalid ${key}`);
    }
  }
  assertNonEmptyString(plan.created_at, 'created_at');
  assertNonEmptyString(plan.input_kind, 'input_kind');
  const selected = assertStringList(plan.selected_adapters, 'selected_adapters');
  const dispositions = plan.claim_disposition_by_adapter as Record<string, string> | undefined;
  if (!dispositions || typeof dispositions !== 'object' || Array.isArray(dispositions)) {
    throw new LabContractError('claim dispositions must cover exactly the frozen selected adapters');
  }
  const dispKeys = Object.keys(dispositions).sort();
  const selKeys = [...new Set(selected)].sort();
  if (
    dispKeys.length !== selKeys.length ||
    !dispKeys.every((k, i) => k === selKeys[i])
  ) {
    throw new LabContractError('claim dispositions must cover exactly the frozen selected adapters');
  }
  if (Object.values(dispositions).some((v) => !CLAIM_DISPOSITIONS.includes(v as ClaimDisposition))) {
    throw new LabContractError('run plan contains unsupported claim disposition');
  }
  if (
    !plan.config_by_adapter ||
    typeof plan.config_by_adapter !== 'object' ||
    Array.isArray(plan.config_by_adapter)
  ) {
    throw new LabContractError('config_by_adapter must be an object');
  }
  const seed = plan.seed;
  if (typeof seed !== 'number' || !Number.isInteger(seed)) {
    throw new LabContractError('seed must be integer');
  }
  if (sealed) {
    verifySeal(plan, 'plan_sha256');
  }
}

export interface RunRecord {
  schema: typeof RUN_RECORD_SCHEMA;
  run_id: string;
  plan_id: string;
  experiment_id?: string;
  outcome: OutcomeState;
  status: 'COMPLETED' | 'BLOCKED' | 'ERROR';
  scientific_authorization: {
    domain_truth: boolean;
    robust_signal: boolean;
    external_validation: boolean;
  };
  metrics?: Record<string, number>;
  notes?: string;
  created_at?: string;
  run_sha256?: string;
}

export function validateRunRecord(record: Record<string, unknown>, sealed = true): void {
  if (!record || typeof record !== 'object' || record.schema !== RUN_RECORD_SCHEMA) {
    throw new LabContractError('unsupported run record schema');
  }
  if (!RUN_ID_RE.test(String(record.run_id ?? ''))) {
    throw new LabContractError('run_id must match RUN-*');
  }
  if (!PLAN_ID_RE.test(String(record.plan_id ?? ''))) {
    throw new LabContractError('invalid plan_id');
  }
  const outcome = record.outcome as OutcomeState;
  if (!OUTCOME_STATES.includes(outcome)) {
    throw new LabContractError(`unsupported scientific outcome: ${String(outcome)}`);
  }
  if (!['COMPLETED', 'BLOCKED', 'ERROR'].includes(record.status as string)) {
    throw new LabContractError('unsupported run status');
  }

  const auth = record.scientific_authorization as Record<string, boolean> | undefined;
  if (!auth || typeof auth !== 'object' || Array.isArray(auth)) {
    throw new LabContractError('scientific_authorization must be an object');
  }
  for (const key of ['domain_truth', 'robust_signal', 'external_validation']) {
    if (auth[key] !== false) {
      throw new LabContractError(`Virtual Lab Kernel V1 cannot authorize ${key}`);
    }
  }

  if (sealed) {
    verifySeal(record, 'run_sha256');
  }
}

export interface BundleManifest {
  schema: typeof BUNDLE_SCHEMA;
  run_id: string;
  components: {
    path: string;
    sha256: string;
  }[];
  ledger_prefix: {
    event_count: number;
    head_hash: string;
  };
  bundle_sha256?: string;
}

export function validateBundleManifest(
  bundle: Record<string, unknown>,
  sealed = true
): void {
  if (!bundle || typeof bundle !== 'object' || bundle.schema !== BUNDLE_SCHEMA) {
    throw new LabContractError('unsupported reproducibility bundle schema');
  }
  if (!RUN_ID_RE.test(String(bundle.run_id ?? ''))) {
    throw new LabContractError('invalid bundle run_id');
  }
  const components = bundle.components;
  if (!Array.isArray(components) || components.length === 0) {
    throw new LabContractError('bundle components must be a non-empty array');
  }
  const seen = new Set<string>();
  for (const comp of components) {
    if (!comp || typeof comp !== 'object' || Array.isArray(comp)) {
      throw new LabContractError('bundle component must be object');
    }
    const c = comp as Record<string, unknown>;
    const path = assertNonEmptyString(c.path, 'bundle component path');
    if (seen.has(path)) {
      throw new LabContractError(`duplicate bundle component path: ${path}`);
    }
    seen.add(path);
    if (!SHA256_RE.test(String(c.sha256 ?? ''))) {
      throw new LabContractError(`invalid bundle component hash: ${path}`);
    }
  }
  const ledger = bundle.ledger_prefix as Record<string, unknown> | undefined;
  if (!ledger || typeof ledger !== 'object' || Array.isArray(ledger)) {
    throw new LabContractError('ledger_prefix must be an object');
  }
  if (typeof ledger.event_count !== 'number' || !Number.isInteger(ledger.event_count) || ledger.event_count < 1) {
    throw new LabContractError('ledger_prefix.event_count must be positive');
  }
  if (!SHA256_RE.test(String(ledger.head_hash ?? ''))) {
    throw new LabContractError('invalid ledger prefix head hash');
  }
  if (sealed) {
    verifySeal(bundle, 'bundle_sha256');
  }
}
