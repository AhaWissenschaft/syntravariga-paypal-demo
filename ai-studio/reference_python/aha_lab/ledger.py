from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any

from .contracts import LabContractError, SHA256_RE, sha256_value

LEDGER_SCHEMA = "aha.lab.ledger-event.v1"
GENESIS_HASH = "0" * 64


class LedgerError(LabContractError):
    """Raised when the append-only laboratory ledger is invalid."""


def _event_unsigned(
    *,
    index: int,
    event_type: str,
    timestamp: str,
    payload: dict[str, Any],
    previous_hash: str,
) -> dict[str, Any]:
    return {
        "schema": LEDGER_SCHEMA,
        "index": index,
        "event_id": f"EVT-{index:08d}",
        "event_type": event_type,
        "timestamp": timestamp,
        "previous_hash": previous_hash,
        "payload_sha256": sha256_value(payload),
        "payload": copy.deepcopy(payload),
    }


def append_event(
    ledger_path: str | Path,
    *,
    event_type: str,
    timestamp: str,
    payload: dict[str, Any],
) -> dict[str, Any]:
    path = Path(ledger_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    report = verify_ledger(path)
    if report["status"] != "PASS":
        raise LedgerError(f"cannot append to invalid ledger: {report['errors']}")
    if not isinstance(event_type, str) or not event_type.strip():
        raise LedgerError("event_type must be non-empty string")
    if not isinstance(timestamp, str) or not timestamp.strip():
        raise LedgerError("timestamp must be non-empty string")
    if not isinstance(payload, dict):
        raise LedgerError("ledger payload must be object")

    index = report["event_count"] + 1
    previous_hash = report["head_hash"] if report["event_count"] else GENESIS_HASH
    unsigned = _event_unsigned(
        index=index,
        event_type=event_type.strip(),
        timestamp=timestamp.strip(),
        payload=payload,
        previous_hash=previous_hash,
    )
    event = copy.deepcopy(unsigned)
    event["event_hash"] = sha256_value(unsigned)
    line = json.dumps(event, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)
    with path.open("a", encoding="utf-8", newline="\n") as handle:
        handle.write(line)
        handle.write("\n")
    return event


def read_events(ledger_path: str | Path) -> list[dict[str, Any]]:
    path = Path(ledger_path)
    if not path.exists():
        return []
    events: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, start=1):
            if not line.strip():
                continue
            try:
                value = json.loads(line)
            except json.JSONDecodeError as exc:
                raise LedgerError(f"invalid JSON at ledger line {line_number}: {exc}") from exc
            if not isinstance(value, dict):
                raise LedgerError(f"ledger line {line_number} is not an object")
            events.append(value)
    return events


def verify_ledger(ledger_path: str | Path) -> dict[str, Any]:
    path = Path(ledger_path)
    errors: list[str] = []
    if not path.exists():
        return {
            "status": "PASS",
            "event_count": 0,
            "head_hash": GENESIS_HASH,
            "event_hashes": [],
            "errors": [],
        }
    try:
        events = read_events(path)
    except LedgerError as exc:
        return {
            "status": "FAIL",
            "event_count": 0,
            "head_hash": GENESIS_HASH,
            "event_hashes": [],
            "errors": [str(exc)],
        }

    previous_hash = GENESIS_HASH
    hashes: list[str] = []
    for expected_index, event in enumerate(events, start=1):
        if event.get("schema") != LEDGER_SCHEMA:
            errors.append(f"event {expected_index}: invalid schema")
        if event.get("index") != expected_index:
            errors.append(f"event {expected_index}: index mismatch")
        if event.get("event_id") != f"EVT-{expected_index:08d}":
            errors.append(f"event {expected_index}: event_id mismatch")
        if not isinstance(event.get("event_type"), str) or not event["event_type"].strip():
            errors.append(f"event {expected_index}: invalid event_type")
        if not isinstance(event.get("timestamp"), str) or not event["timestamp"].strip():
            errors.append(f"event {expected_index}: invalid timestamp")
        if event.get("previous_hash") != previous_hash:
            errors.append(f"event {expected_index}: previous_hash mismatch")
        payload = event.get("payload")
        if not isinstance(payload, dict):
            errors.append(f"event {expected_index}: payload is not object")
            payload = {}
        claimed_payload_hash = event.get("payload_sha256")
        if claimed_payload_hash != sha256_value(payload):
            errors.append(f"event {expected_index}: payload_sha256 mismatch")
        claimed_event_hash = event.get("event_hash")
        if not isinstance(claimed_event_hash, str) or not SHA256_RE.fullmatch(claimed_event_hash):
            errors.append(f"event {expected_index}: invalid event_hash")
            claimed_event_hash = ""
        unsigned = copy.deepcopy(event)
        unsigned.pop("event_hash", None)
        computed = sha256_value(unsigned)
        if claimed_event_hash != computed:
            errors.append(f"event {expected_index}: event_hash mismatch")
        previous_hash = claimed_event_hash or computed
        hashes.append(previous_hash)

    return {
        "status": "PASS" if not errors else "FAIL",
        "event_count": len(events),
        "head_hash": hashes[-1] if hashes else GENESIS_HASH,
        "event_hashes": hashes,
        "errors": errors,
    }


def verify_ledger_prefix(ledger_path: str | Path, *, event_count: int, head_hash: str) -> None:
    if event_count < 1:
        raise LedgerError("ledger prefix event_count must be positive")
    report = verify_ledger(ledger_path)
    if report["status"] != "PASS":
        raise LedgerError(f"ledger verification failed: {report['errors']}")
    if report["event_count"] < event_count:
        raise LedgerError("ledger is shorter than required bundle prefix")
    if report["event_hashes"][event_count - 1] != head_hash:
        raise LedgerError("ledger prefix head hash mismatch")
