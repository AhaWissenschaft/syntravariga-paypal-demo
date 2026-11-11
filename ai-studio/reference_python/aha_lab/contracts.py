from __future__ import annotations

import copy
import hashlib
import json
import re
from pathlib import Path
from typing import Any

EXPERIMENT_SCHEMA = "aha.lab.experiment.v1"
DATASET_SCHEMA = "aha.lab.dataset.v1"
RUN_PLAN_SCHEMA = "aha.lab.run-plan.v1"
RUN_RECORD_SCHEMA = "aha.lab.run-record.v1"
BUNDLE_SCHEMA = "aha.lab.repro-bundle.v1"
WORKSPACE_SCHEMA = "aha.lab.workspace.v1"

EXPERIMENT_ID_RE = re.compile(r"^EXP-[A-Z0-9][A-Z0-9._-]{2,}$")
DATASET_ID_RE = re.compile(r"^DS-[A-Z0-9][A-Z0-9._-]{2,}$")
PLAN_ID_RE = re.compile(r"^PLAN-[A-Z0-9][A-Z0-9._-]{2,}$")
RUN_ID_RE = re.compile(r"^RUN-[A-Z0-9][A-Z0-9._-]{2,}$")
NODE_ID_RE = re.compile(r"^N-[A-Z0-9][A-Z0-9._-]{2,}$")
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")

OUTCOME_STATES = {
    "OBSERVATION",
    "COUNTER_EVIDENCE",
    "NO_ROBUST_SIGNAL",
    "BLOCKED",
    "ERROR",
}
CLAIM_DISPOSITIONS = {"SUPPORTS", "CONTRADICTS", "NO_DIRECT_CLAIM"}


class LabContractError(ValueError):
    """Raised when a laboratory record violates a fail-closed contract."""


def canonical_json(value: Any) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")


def sha256_value(value: Any) -> str:
    return hashlib.sha256(canonical_json(value)).hexdigest()


def file_sha256(path: str | Path) -> str:
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def seal(value: dict[str, Any], hash_field: str) -> dict[str, Any]:
    result = copy.deepcopy(value)
    result.pop(hash_field, None)
    result[hash_field] = sha256_value(result)
    return result


def verify_seal(value: dict[str, Any], hash_field: str) -> None:
    claimed = value.get(hash_field)
    if not isinstance(claimed, str) or not SHA256_RE.fullmatch(claimed):
        raise LabContractError(f"invalid or missing {hash_field}")
    unsigned = copy.deepcopy(value)
    unsigned.pop(hash_field, None)
    if sha256_value(unsigned) != claimed:
        raise LabContractError(f"{hash_field} mismatch")


def _nonempty_string(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise LabContractError(f"{label} must be a non-empty string")
    return value.strip()


def _string_list(value: Any, label: str, *, allow_empty: bool = False) -> list[str]:
    if not isinstance(value, list) or (not value and not allow_empty):
        raise LabContractError(f"{label} must be {'a' if allow_empty else 'a non-empty'} string array")
    if not all(isinstance(item, str) and item.strip() for item in value):
        raise LabContractError(f"{label} must contain non-empty strings")
    return [item.strip() for item in value]


def validate_experiment_spec(spec: dict[str, Any], *, sealed: bool = True) -> None:
    if not isinstance(spec, dict) or spec.get("schema") != EXPERIMENT_SCHEMA:
        raise LabContractError("unsupported experiment schema")
    experiment_id = _nonempty_string(spec.get("experiment_id"), "experiment_id")
    if not EXPERIMENT_ID_RE.fullmatch(experiment_id):
        raise LabContractError("experiment_id must match EXP-*")
    _nonempty_string(spec.get("version"), "version")
    _nonempty_string(spec.get("created_at"), "created_at")
    _nonempty_string(spec.get("question"), "question")
    _string_list(spec.get("domain"), "domain")
    if spec.get("state") != "FROZEN":
        raise LabContractError("experiment state must be FROZEN")

    hypothesis = spec.get("hypothesis")
    if not isinstance(hypothesis, dict):
        raise LabContractError("hypothesis must be an object")
    node_id = _nonempty_string(hypothesis.get("node_id"), "hypothesis.node_id")
    if not NODE_ID_RE.fullmatch(node_id):
        raise LabContractError("hypothesis.node_id must match N-*")
    _nonempty_string(hypothesis.get("label"), "hypothesis.label")
    _nonempty_string(hypothesis.get("statement"), "hypothesis.statement")

    scope = spec.get("scope")
    if not isinstance(scope, dict):
        raise LabContractError("scope must be an object")
    _nonempty_string(scope.get("dataset_boundary"), "scope.dataset_boundary")
    _string_list(scope.get("limitations"), "scope.limitations")
    _string_list(spec.get("forbidden_inferences"), "forbidden_inferences")

    if not isinstance(spec.get("preregistered"), bool):
        raise LabContractError("preregistered must be boolean")

    analysis = spec.get("analysis")
    if not isinstance(analysis, dict):
        raise LabContractError("analysis must be an object")
    _nonempty_string(analysis.get("input_kind"), "analysis.input_kind")
    objectives = analysis.get("objectives", [])
    adapters = analysis.get("adapters", [])
    _string_list(objectives, "analysis.objectives", allow_empty=True)
    _string_list(adapters, "analysis.adapters", allow_empty=True)
    if not objectives and not adapters:
        raise LabContractError("analysis requires objectives or adapters")
    configs = analysis.get("config_by_adapter", {})
    if not isinstance(configs, dict) or not all(isinstance(key, str) and isinstance(value, dict) for key, value in configs.items()):
        raise LabContractError("analysis.config_by_adapter must map adapter ids to objects")
    seed = analysis.get("seed")
    if isinstance(seed, bool) or not isinstance(seed, int):
        raise LabContractError("analysis.seed must be an integer")
    dispositions = analysis.get("claim_disposition_by_adapter")
    if not isinstance(dispositions, dict) or not dispositions:
        raise LabContractError("analysis.claim_disposition_by_adapter must be a non-empty object")
    for adapter_id, disposition in dispositions.items():
        _nonempty_string(adapter_id, "claim disposition adapter id")
        if disposition not in CLAIM_DISPOSITIONS:
            raise LabContractError(f"unsupported claim disposition for {adapter_id}: {disposition!r}")
    weights = analysis.get("weight_by_adapter", {})
    if not isinstance(weights, dict):
        raise LabContractError("analysis.weight_by_adapter must be an object")
    for adapter_id, weight in weights.items():
        if adapter_id not in dispositions:
            raise LabContractError(f"weight provided without disposition: {adapter_id}")
        if isinstance(weight, bool) or not isinstance(weight, (int, float)) or not 0 <= float(weight) <= 0.5:
            raise LabContractError("screening evidence weights must lie in [0, 0.5]")

    multiplicity = spec.get("multiplicity")
    if not isinstance(multiplicity, dict):
        raise LabContractError("multiplicity must be an object")
    _nonempty_string(multiplicity.get("family_id"), "multiplicity.family_id")
    confirmatory = multiplicity.get("confirmatory")
    if not isinstance(confirmatory, bool):
        raise LabContractError("multiplicity.confirmatory must be boolean")
    correction = multiplicity.get("correction")
    if correction is not None and not isinstance(correction, str):
        raise LabContractError("multiplicity.correction must be string or null")
    if confirmatory and (not spec["preregistered"] or not correction):
        raise LabContractError("confirmatory experiment requires preregistration and declared correction")

    controls = spec.get("controls")
    if not isinstance(controls, dict):
        raise LabContractError("controls must be an object")
    for key in ("negative_required", "null_model_required", "positive_control_required"):
        if not isinstance(controls.get(key), bool):
            raise LabContractError(f"controls.{key} must be boolean")

    if sealed:
        verify_seal(spec, "spec_sha256")


def validate_dataset_record(record: dict[str, Any], *, sealed: bool = True) -> None:
    if not isinstance(record, dict) or record.get("schema") != DATASET_SCHEMA:
        raise LabContractError("unsupported dataset schema")
    dataset_id = _nonempty_string(record.get("dataset_id"), "dataset_id")
    if not DATASET_ID_RE.fullmatch(dataset_id):
        raise LabContractError("dataset_id must match DS-*")
    _nonempty_string(record.get("created_at"), "created_at")
    _nonempty_string(record.get("input_kind"), "input_kind")
    _nonempty_string(record.get("media_type"), "media_type")
    digest = record.get("payload_sha256")
    if not isinstance(digest, str) or not SHA256_RE.fullmatch(digest):
        raise LabContractError("payload_sha256 must be a SHA-256 digest")
    source = record.get("source")
    if not isinstance(source, dict):
        raise LabContractError("source must be an object")
    for key in ("type", "reference", "license"):
        _nonempty_string(source.get(key), f"source.{key}")
    parents = record.get("parents", [])
    if not isinstance(parents, list) or not all(isinstance(item, str) and DATASET_ID_RE.fullmatch(item) for item in parents):
        raise LabContractError("parents must contain DS-* ids")
    metadata = record.get("metadata", {})
    if not isinstance(metadata, dict):
        raise LabContractError("metadata must be an object")
    if sealed:
        verify_seal(record, "record_sha256")


def validate_run_plan(plan: dict[str, Any], *, sealed: bool = True) -> None:
    if not isinstance(plan, dict) or plan.get("schema") != RUN_PLAN_SCHEMA:
        raise LabContractError("unsupported run plan schema")
    if not PLAN_ID_RE.fullmatch(str(plan.get("plan_id", ""))):
        raise LabContractError("plan_id must match PLAN-*")
    if not EXPERIMENT_ID_RE.fullmatch(str(plan.get("experiment_id", ""))):
        raise LabContractError("invalid experiment_id in plan")
    if not DATASET_ID_RE.fullmatch(str(plan.get("dataset_id", ""))):
        raise LabContractError("invalid dataset_id in plan")
    for key in ("experiment_spec_sha256", "dataset_payload_sha256"):
        if not SHA256_RE.fullmatch(str(plan.get(key, ""))):
            raise LabContractError(f"invalid {key}")
    _nonempty_string(plan.get("created_at"), "created_at")
    _nonempty_string(plan.get("input_kind"), "input_kind")
    selected = _string_list(plan.get("selected_adapters"), "selected_adapters")
    dispositions = plan.get("claim_disposition_by_adapter")
    if not isinstance(dispositions, dict) or set(dispositions) != set(selected):
        raise LabContractError("claim dispositions must cover exactly the frozen selected adapters")
    if any(value not in CLAIM_DISPOSITIONS for value in dispositions.values()):
        raise LabContractError("run plan contains unsupported claim disposition")
    if not isinstance(plan.get("config_by_adapter"), dict):
        raise LabContractError("config_by_adapter must be an object")
    seed = plan.get("seed")
    if isinstance(seed, bool) or not isinstance(seed, int):
        raise LabContractError("seed must be integer")
    if sealed:
        verify_seal(plan, "plan_sha256")


def validate_run_record(record: dict[str, Any], *, sealed: bool = True) -> None:
    if not isinstance(record, dict) or record.get("schema") != RUN_RECORD_SCHEMA:
        raise LabContractError("unsupported run record schema")
    if not RUN_ID_RE.fullmatch(str(record.get("run_id", ""))):
        raise LabContractError("run_id must match RUN-*")
    if not PLAN_ID_RE.fullmatch(str(record.get("plan_id", ""))):
        raise LabContractError("invalid plan_id")
    outcome = record.get("outcome")
    if outcome not in OUTCOME_STATES:
        raise LabContractError(f"unsupported scientific outcome: {outcome!r}")
    if record.get("status") not in {"COMPLETED", "BLOCKED", "ERROR"}:
        raise LabContractError("unsupported run status")
    authorization = record.get("scientific_authorization")
    if not isinstance(authorization, dict):
        raise LabContractError("scientific_authorization must be an object")
    for key in ("domain_truth", "robust_signal", "external_validation"):
        if authorization.get(key) is not False:
            raise LabContractError(f"Virtual Lab Kernel V1 cannot authorize {key}")
    if sealed:
        verify_seal(record, "run_sha256")


def validate_bundle_manifest(bundle: dict[str, Any], *, sealed: bool = True) -> None:
    if not isinstance(bundle, dict) or bundle.get("schema") != BUNDLE_SCHEMA:
        raise LabContractError("unsupported reproducibility bundle schema")
    if not RUN_ID_RE.fullmatch(str(bundle.get("run_id", ""))):
        raise LabContractError("invalid bundle run_id")
    components = bundle.get("components")
    if not isinstance(components, list) or not components:
        raise LabContractError("bundle components must be a non-empty array")
    seen: set[str] = set()
    for component in components:
        if not isinstance(component, dict):
            raise LabContractError("bundle component must be object")
        path = _nonempty_string(component.get("path"), "bundle component path")
        if path in seen:
            raise LabContractError(f"duplicate bundle component path: {path}")
        seen.add(path)
        if not SHA256_RE.fullmatch(str(component.get("sha256", ""))):
            raise LabContractError(f"invalid bundle component hash: {path}")
    ledger = bundle.get("ledger_prefix")
    if not isinstance(ledger, dict):
        raise LabContractError("ledger_prefix must be an object")
    if not isinstance(ledger.get("event_count"), int) or ledger["event_count"] < 1:
        raise LabContractError("ledger_prefix.event_count must be positive")
    if not SHA256_RE.fullmatch(str(ledger.get("head_hash", ""))):
        raise LabContractError("invalid ledger prefix head hash")
    if sealed:
        verify_seal(bundle, "bundle_sha256")
