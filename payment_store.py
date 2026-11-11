"""Atomic SQLite state machine binding confirmed review receipts to PayPal Sandbox orders."""
import sqlite3
from pathlib import Path


class PaymentStateError(ValueError):
    """Raised when a payment state transition is invalid or violates replay protection."""


def init_store(db_path: str | Path) -> None:
    path = Path(db_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(path, timeout=10.0) as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS payment_sessions (
                receipt_hash TEXT PRIMARY KEY,
                receipt_index INTEGER NOT NULL,
                approved_amount TEXT NOT NULL,
                currency TEXT NOT NULL,
                amount_commitment TEXT NOT NULL,
                state TEXT NOT NULL,
                order_id TEXT,
                capture_id TEXT
            )
            """
        )


def register_review(
    db_path: str | Path,
    *,
    receipt_hash: str,
    receipt_index: int,
    approved_amount: str,
    currency: str,
    amount_commitment: str,
) -> None:
    init_store(db_path)
    with sqlite3.connect(db_path, timeout=10.0, isolation_level=None) as conn:
        conn.execute("BEGIN IMMEDIATE")
        conn.execute(
            """
            INSERT INTO payment_sessions
            (receipt_hash, receipt_index, approved_amount, currency, amount_commitment, state)
            VALUES (?, ?, ?, ?, ?, 'REVIEWED')
            """,
            (receipt_hash, receipt_index, approved_amount, currency, amount_commitment),
        )
        conn.execute("COMMIT")


def begin_order_creation(db_path: str | Path, receipt_hash: str) -> dict:
    init_store(db_path)
    with sqlite3.connect(db_path, timeout=10.0, isolation_level=None) as conn:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute(
            "SELECT receipt_index, approved_amount, currency, amount_commitment, state, order_id FROM payment_sessions WHERE receipt_hash = ?",
            (receipt_hash,),
        ).fetchone()
        if not row:
            conn.execute("ROLLBACK")
            raise PaymentStateError("Unknown or unapproved receipt")
        index, amount, currency, commitment, state, order_id = row
        if state != "REVIEWED":
            conn.execute("ROLLBACK")
            raise PaymentStateError(f"Receipt cannot create order in state {state}")
        conn.execute(
            "UPDATE payment_sessions SET state = 'ORDER_PENDING' WHERE receipt_hash = ?",
            (receipt_hash,),
        )
        conn.execute("COMMIT")
        return {
            "receipt_index": index,
            "approved_amount": amount,
            "currency": currency,
            "amount_commitment": commitment,
        }


def complete_order_creation(db_path: str | Path, receipt_hash: str, order_id: str) -> None:
    with sqlite3.connect(db_path, timeout=10.0, isolation_level=None) as conn:
        conn.execute("BEGIN IMMEDIATE")
        conn.execute(
            "UPDATE payment_sessions SET state = 'ORDER_CREATED', order_id = ? WHERE receipt_hash = ? AND state = 'ORDER_PENDING'",
            (order_id, receipt_hash),
        )
        conn.execute("COMMIT")


def reset_order_to_reviewed(db_path: str | Path, receipt_hash: str) -> None:
    with sqlite3.connect(db_path, timeout=10.0, isolation_level=None) as conn:
        conn.execute("BEGIN IMMEDIATE")
        conn.execute(
            "UPDATE payment_sessions SET state = 'REVIEWED' WHERE receipt_hash = ? AND state = 'ORDER_PENDING'",
            (receipt_hash,),
        )
        conn.execute("COMMIT")


def begin_capture(db_path: str | Path, receipt_hash: str, order_id: str) -> dict:
    init_store(db_path)
    with sqlite3.connect(db_path, timeout=10.0, isolation_level=None) as conn:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute(
            "SELECT approved_amount, currency, state, order_id FROM payment_sessions WHERE receipt_hash = ?",
            (receipt_hash,),
        ).fetchone()
        if not row:
            conn.execute("ROLLBACK")
            raise PaymentStateError("Unknown receipt")
        amount, currency, state, stored_order_id = row
        if state != "ORDER_CREATED" or stored_order_id != order_id:
            conn.execute("ROLLBACK")
            raise PaymentStateError(f"Cannot capture order in state {state}")
        conn.execute(
            "UPDATE payment_sessions SET state = 'CAPTURE_PENDING' WHERE receipt_hash = ?",
            (receipt_hash,),
        )
        conn.execute("COMMIT")
        return {"approved_amount": amount, "currency": currency, "order_id": stored_order_id}


def finish_capture(db_path: str | Path, receipt_hash: str, *, new_state: str, capture_id: str | None = None) -> None:
    if new_state not in ("COMPLETED", "RECONCILIATION_REQUIRED", "ORDER_CREATED"):
        raise ValueError("Invalid post-capture state")
    with sqlite3.connect(db_path, timeout=10.0, isolation_level=None) as conn:
        conn.execute("BEGIN IMMEDIATE")
        conn.execute(
            "UPDATE payment_sessions SET state = ?, capture_id = ? WHERE receipt_hash = ? AND state = 'CAPTURE_PENDING'",
            (new_state, capture_id, receipt_hash),
        )
        conn.execute("COMMIT")
