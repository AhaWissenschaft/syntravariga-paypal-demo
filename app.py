"""Local sandbox review server. No real payments or payment authorization."""
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import threading
import urllib.parse

from invoice_guard import analyze_invoice
from counterfactual import compare_examples
from ai_extractor import extract_invoice_fields
from ai_explainer import explain_findings
from aha_lab.contracts import sha256_value
from aha_lab.ledger import append_event, read_events, verify_ledger, LedgerError
from payment_store import (
    PaymentStateError,
    register_review,
    begin_order_creation,
    complete_order_creation,
    reset_order_to_reviewed,
    begin_capture,
    finish_capture,
)

PAGE_TEMPLATE = Path(__file__).with_name('index.html').read_text(encoding='utf-8')
LEDGER_PATH = Path(os.environ.get('SYNTRA_DEMO_LEDGER', '/tmp/syntravariga_paypal_demo.jsonl'))
LEDGER_LOCK = threading.Lock()
ALLOWED_LEDGER_VIEW_KEYS = ('finding_codes', 'status', 'scope', 'paypal_status', 'receipt_hash', 'amount_commitment', 'extraction_mode')


def _db_path() -> Path:
    return LEDGER_PATH.with_suffix('.sqlite3')


class Handler(BaseHTTPRequestHandler):
    def _valid_host(self):
        host = self.headers.get('Host', '')
        return host in {f'127.0.0.1:{self.server.server_address[1]}', f'localhost:{self.server.server_address[1]}'}

    def do_GET(self):
        if not self._valid_host():
            self.send_error(400, 'Invalid host')
            return
        if self.path == '/':
            client_id = urllib.parse.quote(os.environ.get('PAYPAL_CLIENT_ID', 'sb').strip() or 'sb', safe='')
            page = PAGE_TEMPLATE.replace('client-id=sb', f'client-id={client_id}').encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            self.wfile.write(page)
            return
        if self.path == '/ledger':
            try:
                with LEDGER_LOCK:
                    report = verify_ledger(LEDGER_PATH)
                    events = read_events(LEDGER_PATH)
                payload = {
                    'verification': {
                        'status': report['status'],
                        'event_count': report['event_count'],
                        'head_hash': report['head_hash'],
                        'errors': report['errors'],
                    },
                    'events': [
                        {
                            'index': e.get('index'),
                            'event_type': e.get('event_type'),
                            'timestamp': e.get('timestamp'),
                            'event_hash': e.get('event_hash'),
                            'payload': {
                                k: v for k, v in e.get('payload', {}).items()
                                if k in ALLOWED_LEDGER_VIEW_KEYS
                            },
                        }
                        for e in events
                    ],
                }
                body = json.dumps(payload).encode('utf-8')
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Cache-Control', 'no-store')
                self.end_headers()
                self.wfile.write(body)
                return
            except (OSError, LedgerError):
                self.send_error(503, 'Ledger invalid or unreadable')
                return
        self.send_error(404)

    def _body(self, limit=8192):
        if self.headers.get_content_type() != 'application/json':
            raise ValueError('application/json required')
        host = self.headers.get('Host', '')
        if not self._valid_host():
            raise ValueError('invalid host')
        origin = self.headers.get('Origin')
        if origin and origin != 'http://' + host:
            raise ValueError('invalid origin')
        length = int(self.headers.get('Content-Length', '0'))
        if length <= 0 or length > limit:
            raise ValueError('size')
        value = json.loads(self.rfile.read(length))
        if not isinstance(value, dict):
            raise ValueError('object required')
        return value

    def do_POST(self):
        if self.path not in ('/extract', '/review', '/counterfactual', '/explain', '/paypal/order', '/paypal/capture'):
            self.send_error(404)
            return
        try:
            data = self._body()
            if self.path == '/extract':
                result = extract_invoice_fields(data.get('invoice_text', ''))
                with LEDGER_LOCK:
                    append_event(
                        LEDGER_PATH,
                        event_type='invoice_extraction_proposal',
                        timestamp=datetime.now(timezone.utc).isoformat(),
                        payload={
                            'extraction_mode': result['mode'],
                            'finding_codes': result['warnings'],
                            'scope': 'unconfirmed_proposal_only',
                        },
                    )
            elif self.path == '/counterfactual':
                result = compare_examples(data)
            elif self.path == '/explain':
                receipt = data.get('receipt')
                if not isinstance(receipt, dict) or not isinstance(receipt.get('index'), int) or not isinstance(receipt.get('event_hash'), str):
                    raise ValueError('receipt')
                with LEDGER_LOCK:
                    report = verify_ledger(LEDGER_PATH)
                    index = receipt['index']
                    if report['status'] != 'PASS' or index < 1 or index > report['event_count'] or report['event_hashes'][index-1] != receipt['event_hash']:
                        raise LedgerError('invalid receipt')
                    event = read_events(LEDGER_PATH)[index-1]
                    if event.get('event_type') != 'invoice_review':
                        raise ValueError('not a review')
                    payload = event.get('payload', {})
                result = explain_findings(payload.get('finding_codes', []), payload.get('status'))
                with LEDGER_LOCK:
                    append_event(LEDGER_PATH, event_type='ai_explanation', timestamp=datetime.now(timezone.utc).isoformat(), payload={'receipt_hash': receipt['event_hash'], 'scope': 'ai_explanation_informational', 'ai_source': result['source'], 'ai_model': result['model']})
            elif self.path == '/review':
                result = analyze_invoice(data)
                with LEDGER_LOCK:
                    report = verify_ledger(LEDGER_PATH)
                    if report['status'] != 'PASS':
                        raise LedgerError('Ledger verification failed')
                    next_index = report['event_count'] + 1
                    commitment = None
                    if result['status'] == 'FIELDS_CONSISTENT' and result.get('approved_amount'):
                        commitment = sha256_value({
                            'index': next_index,
                            'currency': result['currency'],
                            'approved_amount': result['approved_amount'],
                        })
                    ledger_payload = {
                        'finding_codes': [f['code'] for f in result['findings']],
                        'status': result['status'],
                        'scope': 'deterministic_demo_review',
                    }
                    if commitment:
                        ledger_payload['amount_commitment'] = commitment
                    event = append_event(
                        LEDGER_PATH,
                        event_type='invoice_review',
                        timestamp=datetime.now(timezone.utc).isoformat(),
                        payload=ledger_payload,
                    )
                    if commitment:
                        register_review(
                            _db_path(),
                            receipt_hash=event['event_hash'],
                            receipt_index=event['index'],
                            approved_amount=result['approved_amount'],
                            currency=result['currency'],
                            amount_commitment=commitment,
                        )
                result['receipt'] = {'index': event['index'], 'event_hash': event['event_hash']}
            else:
                receipt = data.get('receipt')
                if not isinstance(receipt, dict) or not isinstance(receipt.get('index'), int) or not isinstance(receipt.get('event_hash'), str):
                    raise ValueError('receipt')
                with LEDGER_LOCK:
                    report = verify_ledger(LEDGER_PATH)
                    if report['status'] != 'PASS' or receipt['index'] < 1 or receipt['index'] > report['event_count'] or report['event_hashes'][receipt['index'] - 1] != receipt['event_hash']:
                        raise LedgerError('invalid receipt')
                    event = read_events(LEDGER_PATH)[receipt['index'] - 1]
                if event.get('event_type') != 'invoice_review' or event.get('payload', {}).get('status') != 'FIELDS_CONSISTENT':
                    raise ValueError('invoice review is not consistent')

                from paypal_sandbox import create_order, capture_order, PayPalSandboxError

                if self.path == '/paypal/order':
                    session = begin_order_creation(_db_path(), receipt['event_hash'])
                    expected_comm = sha256_value({
                        'index': session['receipt_index'],
                        'currency': session['currency'],
                        'approved_amount': session['approved_amount'],
                    })
                    if event.get('payload', {}).get('amount_commitment') != expected_comm:
                        reset_order_to_reviewed(_db_path(), receipt['event_hash'])
                        raise LedgerError('amount commitment mismatch')
                    try:
                        result = create_order(receipt['event_hash'], session['approved_amount'], session['currency'])
                        if not isinstance(result, dict) or result.get('status') != 'CREATED' or not isinstance(result.get('id'), str) or not result['id']:
                            raise PayPalSandboxError('Unexpected order response', uncertain=True)
                        complete_order_creation(_db_path(), receipt['event_hash'], result['id'])
                    except Exception:
                        # Keep ORDER_PENDING: an order may exist after a lost response.
                        raise
                    with LEDGER_LOCK:
                        append_event(
                            LEDGER_PATH,
                            event_type='paypal_sandbox_order',
                            timestamp=datetime.now(timezone.utc).isoformat(),
                            payload={
                                'receipt_hash': receipt['event_hash'],
                                'paypal_status': result.get('status'),
                                'order_id': result.get('id'),
                            },
                        )
                else:
                    order_id = data.get('order_id')
                    if not isinstance(order_id, str):
                        raise ValueError('order_id')
                    session = begin_capture(_db_path(), receipt['event_hash'], order_id)
                    try:
                        result = capture_order(order_id, receipt['event_hash'], session['approved_amount'], session['currency'])
                        capture_id = result.get('purchase_units', [{}])[0].get('payments', {}).get('captures', [{}])[0].get('id') or result.get('id')
                        finish_capture(_db_path(), receipt['event_hash'], new_state='COMPLETED', capture_id=capture_id)
                    except PayPalSandboxError as exc:
                        finish_capture(
                            _db_path(),
                            receipt['event_hash'],
                            new_state='RECONCILIATION_REQUIRED' if exc.uncertain else 'ORDER_CREATED',
                        )
                        raise
                    with LEDGER_LOCK:
                        append_event(
                            LEDGER_PATH,
                            event_type='paypal_sandbox_capture',
                            timestamp=datetime.now(timezone.utc).isoformat(),
                            payload={
                                'receipt_hash': receipt['event_hash'],
                                'paypal_status': result.get('status'),
                                'order_id': result.get('id'),
                            },
                        )

            body = json.dumps(result).encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            self.wfile.write(body)
        except PaymentStateError:
            self.send_error(409, 'Payment state conflict or replay blocked')
        except (OSError, LedgerError):
            self.send_error(503, 'Ledger invalid or PayPal sandbox unavailable')
        except (ValueError, UnicodeError, json.JSONDecodeError):
            self.send_error(400, 'Invalid request')
        except Exception:
            self.send_error(502, 'PayPal sandbox request failed')


if __name__ == '__main__':
    server = ThreadingHTTPServer(('127.0.0.1', 8787), Handler)
    print('SyntraVariga sandbox demo at http://127.0.0.1:8787', flush=True)
    server.serve_forever()
