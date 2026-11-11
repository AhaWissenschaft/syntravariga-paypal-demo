import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from http.server import ThreadingHTTPServer

import app
from aha_lab.ledger import verify_ledger


class LedgerIntegrationTests(unittest.TestCase):
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

    def review(self):
        body = json.dumps({'expected_vendor': 'Demo supplier', 'vendor': 'Demo supplier',
                           'expected_amount': '119', 'amount': '119', 'net_amount':'100',
                           'tax_amount':'19', 'gross_amount':'119', 'invoice_number':'INV-1'}).encode()
        request = urllib.request.Request(f'http://127.0.0.1:{self.server.server_port}/review',
                                         data=body, headers={'Content-Type': 'application/json'})
        with urllib.request.urlopen(request) as response:
            return json.load(response)

    def test_review_records_receipt_without_invoice_content(self):
        response = self.review()
        self.assertEqual(response['receipt']['index'], 1)
        self.assertEqual(verify_ledger(app.LEDGER_PATH)['head_hash'], response['receipt']['event_hash'])
        self.assertEqual(response['status'],'FIELDS_CONSISTENT')
        self.assertNotIn('Demo supplier', app.LEDGER_PATH.read_text())
        self.assertNotIn('INV-1', app.LEDGER_PATH.read_text())

    def test_corrupted_ledger_stops_next_review(self):
        self.review()
        event = json.loads(app.LEDGER_PATH.read_text())
        event['payload']['warning_count'] = 999
        app.LEDGER_PATH.write_text(json.dumps(event) + '\n')
        self.assertEqual(verify_ledger(app.LEDGER_PATH)['status'], 'FAIL')
        with self.assertRaises(urllib.error.HTTPError) as error:
            self.review()
        self.assertEqual(error.exception.code, 503)


if __name__ == '__main__':
    unittest.main()
