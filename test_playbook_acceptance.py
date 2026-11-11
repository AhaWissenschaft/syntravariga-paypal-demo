import json
import tempfile
import threading
import unittest
from unittest.mock import patch
import urllib.error
import urllib.request
from pathlib import Path
from http.server import ThreadingHTTPServer

import app
from ai_extractor import extract_invoice_fields, validate_extraction_schema
from paypal_sandbox import PayPalSandboxError


class PlaybookAcceptanceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        app.LEDGER_PATH = Path(self.tmp.name) / 'events.jsonl'
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), app.Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.tmp.cleanup()

    def _post(self, path: str, payload: dict) -> dict:
        req = urllib.request.Request(
            f'http://127.0.0.1:{self.server.server_port}{path}',
            data=json.dumps(payload).encode('utf-8'),
            headers={'Content-Type': 'application/json'},
        )
        with urllib.request.urlopen(req) as resp:
            return json.load(resp)

    def test_ai_extractor_flags_ambiguous_amounts_and_blocks_expected_fields(self):
        text = (
            "Invoice No: INV-99\nSupplier: Demo GmbH\nNet: 100.00\nTax: 19.00\n"
            "Total Gross: 119.00\nPayable with discount: 116.62"
        )
        res = extract_invoice_fields(text)
        self.assertIn('AMBIGUOUS_AMOUNT', res['warnings'])
        self.assertNotIn('expected_amount', res['proposed_fields'])
        self.assertNotIn('expected_vendor', res['proposed_fields'])

    def test_ai_schema_rejects_injected_keys(self):
        with self.assertRaises(ValueError):
            validate_extraction_schema({
                'proposed_fields': {
                    'vendor': 'A', 'invoice_number': '1', 'net_amount': '10',
                    'tax_amount': '0', 'gross_amount': '10', 'amount': '10',
                    'expected_amount': '9999.00',
                },
                'warnings': [],
            })

    def test_payment_binds_exact_reviewed_amount_and_blocks_replay(self):
        review = self._post('/review', {
            'expected_vendor': 'Demo GmbH', 'vendor': 'Demo GmbH',
            'expected_amount': '238.00', 'amount': '238.00',
            'net_amount': '200.00', 'tax_amount': '38.00',
            'gross_amount': '238.00', 'invoice_number': 'INV-238',
        })
        self.assertEqual(review['approved_amount'], '238.00')
        receipt = review['receipt']

        with patch('paypal_sandbox.create_order') as mock_create, \
             patch('paypal_sandbox.capture_order') as mock_capture:
            mock_create.return_value = {'id': 'ORDER-ABC123', 'status': 'CREATED'}
            mock_capture.return_value = {'id': 'ORDER-ABC123', 'status': 'COMPLETED'}

            order_res = self._post('/paypal/order', {'receipt': receipt})
            self.assertEqual(order_res['id'], 'ORDER-ABC123')
            mock_create.assert_called_once_with(receipt['event_hash'], '238.00', 'EUR')

            # Second order attempt with same receipt must fail with HTTP 409
            with self.assertRaises(urllib.error.HTTPError) as err:
                self._post('/paypal/order', {'receipt': receipt})
            self.assertEqual(err.exception.code, 409)

            cap_res = self._post('/paypal/capture', {'receipt': receipt, 'order_id': 'ORDER-ABC123'})
            self.assertEqual(cap_res['status'], 'COMPLETED')
            mock_capture.assert_called_once_with('ORDER-ABC123', receipt['event_hash'], '238.00', 'EUR')

            # Replay capture attempt must fail with HTTP 409
            with self.assertRaises(urllib.error.HTTPError) as err2:
                self._post('/paypal/capture', {'receipt': receipt, 'order_id': 'ORDER-ABC123'})
            self.assertEqual(err2.exception.code, 409)

    def test_uncertain_capture_timeout_blocks_blind_retry(self):
        review = self._post('/review', {
            'expected_vendor': 'Demo GmbH', 'vendor': 'Demo GmbH',
            'expected_amount': '119.00', 'amount': '119.00',
            'net_amount': '100.00', 'tax_amount': '19.00',
            'gross_amount': '119.00', 'invoice_number': 'INV-119',
        })
        receipt = review['receipt']
        with patch('paypal_sandbox.create_order', return_value={'id': 'ORDER-TIMEOUT1', 'status': 'CREATED'}):
            self._post('/paypal/order', {'receipt': receipt})

        with patch('paypal_sandbox.capture_order', side_effect=PayPalSandboxError('Timeout', uncertain=True)):
            with self.assertRaises(urllib.error.HTTPError) as err:
                self._post('/paypal/capture', {'receipt': receipt, 'order_id': 'ORDER-TIMEOUT1'})
            self.assertEqual(err.exception.code, 502)

        # Subsequent blind retry must be blocked with 409 because state is RECONCILIATION_REQUIRED
        with self.assertRaises(urllib.error.HTTPError) as err2:
            self._post('/paypal/capture', {'receipt': receipt, 'order_id': 'ORDER-TIMEOUT1'})
        self.assertEqual(err2.exception.code, 409)


if __name__ == '__main__':
    unittest.main()
