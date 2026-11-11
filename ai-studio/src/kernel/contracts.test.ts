import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EXPERIMENT_SCHEMA,
  DATASET_SCHEMA,
  RUN_PLAN_SCHEMA,
  RUN_RECORD_SCHEMA,
  BUNDLE_SCHEMA,
  seal,
  verifySeal,
  validateExperimentSpec,
  validateDatasetRecord,
  validateRunPlan,
  validateRunRecord,
  validateBundleManifest,
  LabContractError,
  ExperimentSpec,
  DatasetRecord,
  RunPlan,
  RunRecord,
  BundleManifest,
} from './contracts';

function createValidExperimentSpec(): ExperimentSpec {
  return {
    schema: EXPERIMENT_SCHEMA,
    experiment_id: 'EXP-MOMENTUM-001',
    version: '1.0.0',
    created_at: '2026-11-11T12:00:00Z',
    question: 'Does 12-1M cross-sectional momentum survive transaction costs and multiplicity correction?',
    domain: ['equities', 'factor_investing'],
    state: 'FROZEN',
    hypothesis: {
      node_id: 'N-HYP-001',
      label: 'Momentum Alpha Persistence',
      statement: '12-1 month return momentum exhibits statistically significant alpha post-FDR correction.',
    },
    scope: {
      dataset_boundary: 'Liquid European Equities 2010-2026',
      limitations: ['Survivorship bias controlled via point-in-time constituents', 'Excludes micro-caps'],
    },
    forbidden_inferences: [
      'Cannot claim unconditional future outperformance',
      'Cannot extrapolate to illiquid OTC derivatives',
    ],
    preregistered: true,
    analysis: {
      input_kind: 'timeseries.ohlcv',
      objectives: ['sharpe_eval', 'fdr_control'],
      adapters: ['quant_mom'],
      config_by_adapter: { quant_mom: { lookback: 252, skip: 21 } },
      seed: 42,
      claim_disposition_by_adapter: { quant_mom: 'SUPPORTS' },
      weight_by_adapter: { quant_mom: 0.35 },
    },
    multiplicity: {
      family_id: 'FAM-MOM-2026',
      confirmatory: true,
      correction: 'benjamini_hochberg',
    },
    controls: {
      negative_required: true,
      null_model_required: true,
      positive_control_required: true,
    },
  };
}

test('seal and verifySeal guarantee deterministic SHA-256 integrity', () => {
  const data = {
    schema: 'test.v1',
    value: 42,
    name: 'test experiment',
  };
  const sealed = seal(data, 'record_sha256');
  assert.ok(sealed.record_sha256);
  assert.doesNotThrow(() => verifySeal(sealed, 'record_sha256'));

  // Mutating value breaks seal
  const tampered = { ...sealed, value: 43 };
  assert.throws(() => verifySeal(tampered, 'record_sha256'), LabContractError);
});

test('validateExperimentSpec enforces FROZEN state, N-* node_id, weight <= 0.5, and confirmatory rules', () => {
  const validSpec = createValidExperimentSpec();
  const sealedSpec = seal(validSpec as unknown as Record<string, unknown>, 'spec_sha256');
  assert.doesNotThrow(() => validateExperimentSpec(sealedSpec, true));

  // 1. Non-FROZEN state must fail
  const draftSpec = { ...validSpec, state: 'DRAFT' };
  const sealedDraft = seal(draftSpec as unknown as Record<string, unknown>, 'spec_sha256');
  assert.throws(() => validateExperimentSpec(sealedDraft, true), /experiment state must be FROZEN/);

  // 2. Screening weight > 0.5 must fail
  const overweightSpec = {
    ...validSpec,
    analysis: { ...validSpec.analysis, weight_by_adapter: { quant_mom: 0.51 } },
  };
  const sealedOverweight = seal(overweightSpec as unknown as Record<string, unknown>, 'spec_sha256');
  assert.throws(
    () => validateExperimentSpec(sealedOverweight, true),
    /screening evidence weights must lie in \[0, 0.5\]/
  );

  // 3. Confirmatory without correction must fail
  const invalidConfirmatory = {
    ...validSpec,
    multiplicity: { ...validSpec.multiplicity, correction: null },
  };
  const sealedInvalid = seal(invalidConfirmatory as unknown as Record<string, unknown>, 'spec_sha256');
  assert.throws(
    () => validateExperimentSpec(sealedInvalid, true),
    /confirmatory experiment requires preregistration and declared correction/
  );
});

test('validateDatasetRecord enforces DS-* IDs, SHA-256 payload digest, and parent lineage', () => {
  const validDataset: DatasetRecord = {
    schema: DATASET_SCHEMA,
    dataset_id: 'DS-OHLCV-EU-2026',
    created_at: '2026-11-11T10:00:00Z',
    input_kind: 'timeseries.ohlcv',
    media_type: 'application/parquet',
    payload_sha256: 'a'.repeat(64),
    source: {
      type: 'institutional_feed',
      reference: 'Euronext_Xetra_Consolidated',
      license: 'Institutional-Research-Only',
    },
    parents: ['DS-RAW-TICK-2026'],
    metadata: { rows: 1250000, adjusted: true },
  };

  const sealedDs = seal(validDataset as unknown as Record<string, unknown>, 'record_sha256');
  assert.doesNotThrow(() => validateDatasetRecord(sealedDs, true));

  // Invalid parent ID format must fail
  const badParentDs = { ...validDataset, parents: ['INVALID-PARENT'] };
  const sealedBadParent = seal(badParentDs as unknown as Record<string, unknown>, 'record_sha256');
  assert.throws(() => validateDatasetRecord(sealedBadParent, true), /parents must contain DS-\* ids/);
});

test('validateRunPlan enforces adapter disposition coverage and SHA-256 links', () => {
  const validPlan: RunPlan = {
    schema: RUN_PLAN_SCHEMA,
    plan_id: 'PLAN-MOM-2026-001',
    experiment_id: 'EXP-MOMENTUM-001',
    dataset_id: 'DS-OHLCV-EU-2026',
    experiment_spec_sha256: 'b'.repeat(64),
    dataset_payload_sha256: 'a'.repeat(64),
    created_at: '2026-11-11T11:00:00Z',
    input_kind: 'timeseries.ohlcv',
    selected_adapters: ['quant_mom', 'null_baseline'],
    claim_disposition_by_adapter: {
      quant_mom: 'SUPPORTS',
      null_baseline: 'NO_DIRECT_CLAIM',
    },
    config_by_adapter: {
      quant_mom: { lookback: 252 },
      null_baseline: { bootstrap: 1000 },
    },
    seed: 42,
  };

  const sealedPlan = seal(validPlan as unknown as Record<string, unknown>, 'plan_sha256');
  assert.doesNotThrow(() => validateRunPlan(sealedPlan, true));

  // Mismatched adapter coverage must fail
  const incompletePlan = {
    ...validPlan,
    claim_disposition_by_adapter: { quant_mom: 'SUPPORTS' as const },
  };
  const sealedIncomplete = seal(incompletePlan as unknown as Record<string, unknown>, 'plan_sha256');
  assert.throws(
    () => validateRunPlan(sealedIncomplete, true),
    /claim dispositions must cover exactly the frozen selected adapters/
  );
});

test('validateRunRecord enforces fail-closed scientific authorization', () => {
  const validRun: RunRecord = {
    schema: RUN_RECORD_SCHEMA,
    run_id: 'RUN-2026-001',
    plan_id: 'PLAN-2026-001',
    experiment_id: 'EXP-MOMENTUM-001',
    outcome: 'OBSERVATION',
    status: 'COMPLETED',
    scientific_authorization: {
      domain_truth: false,
      robust_signal: false,
      external_validation: false,
    },
    created_at: '2026-11-11T12:00:00Z',
  };

  const sealedRun = seal(validRun as unknown as Record<string, unknown>, 'run_sha256');
  assert.doesNotThrow(() => validateRunRecord(sealedRun, true));

  // If a run claims unverified domain_truth = true, the Virtual Lab Kernel strictly rejects it
  for (const key of ['domain_truth', 'robust_signal', 'external_validation'] as const) {
    const fraudulentRun = {
      ...validRun,
      scientific_authorization: {
        domain_truth: false,
        robust_signal: false,
        external_validation: false,
        [key]: true,
      },
    };
    const sealedFraud = seal(fraudulentRun as unknown as Record<string, unknown>, 'run_sha256');
    assert.throws(
      () => validateRunRecord(sealedFraud, true),
      new RegExp(`Virtual Lab Kernel V1 cannot authorize ${key}`)
    );
  }
});

test('validateBundleManifest rejects duplicate component paths and invalid ledger prefixes', () => {
  const validBundle: BundleManifest = {
    schema: BUNDLE_SCHEMA,
    run_id: 'RUN-2026-001',
    components: [
      { path: 'experiment.json', sha256: '1'.repeat(64) },
      { path: 'dataset.json', sha256: '2'.repeat(64) },
      { path: 'run_record.json', sha256: '3'.repeat(64) },
    ],
    ledger_prefix: {
      event_count: 3,
      head_hash: '4'.repeat(64),
    },
  };

  const sealedBundle = seal(validBundle as unknown as Record<string, unknown>, 'bundle_sha256');
  assert.doesNotThrow(() => validateBundleManifest(sealedBundle, true));

  // Duplicate path must fail
  const dupBundle = {
    ...validBundle,
    components: [
      { path: 'experiment.json', sha256: '1'.repeat(64) },
      { path: 'experiment.json', sha256: '2'.repeat(64) },
    ],
  };
  const sealedDup = seal(dupBundle as unknown as Record<string, unknown>, 'bundle_sha256');
  assert.throws(
    () => validateBundleManifest(sealedDup, true),
    /duplicate bundle component path: experiment.json/
  );
});
