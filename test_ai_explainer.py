import json, os, tempfile, threading, unittest, urllib.request
from pathlib import Path
from http.server import ThreadingHTTPServer
import ai_explainer, app

class AIExplainerTests(unittest.TestCase):
    def setUp(self):
        self.old = {k: os.environ.get(k) for k in ('ANTHROPIC_API_KEY', 'AI_MODEL', 'SYNTRA_ALLOW_EXTERNAL_AI')}
        os.environ['SYNTRA_ALLOW_EXTERNAL_AI'] = '1'
        self.orig_post = ai_explainer._post
    def tearDown(self):
        ai_explainer._post = self.orig_post
        for k, v in self.old.items():
            if v is None: os.environ.pop(k, None)
            else: os.environ[k] = v

    def test_no_key_uses_labelled_fallback(self):
        os.environ.pop('ANTHROPIC_API_KEY', None)
        r = ai_explainer.explain_findings(['VENDOR_MISMATCH'], 'REVIEW_REQUIRED')
        self.assertEqual(r['source'], 'fallback_no_api_key'); self.assertIsNone(r['model'])

    def test_model_gets_only_codes_and_unknown_codes_are_dropped(self):
        os.environ['ANTHROPIC_API_KEY'] = 'test-key'; seen = {}
        def fake(payload, key):
            seen['p'] = payload; seen['k'] = key
            return {'content': [{'type': 'text', 'text': 'Erklärung. Die Entscheidung trifft ein Mensch.'}]}
        ai_explainer._post = fake
        r = ai_explainer.explain_findings(['TOTAL_MISMATCH', 'Acme GmbH 119.00'], 'REVIEW_REQUIRED')
        self.assertEqual(r['source'], 'ai_model')
        sent = json.dumps(seen['p'])
        self.assertIn('TOTAL_MISMATCH', sent); self.assertNotIn('Acme', sent); self.assertNotIn('119.00', sent)

    def test_api_error_falls_back(self):
        os.environ['ANTHROPIC_API_KEY'] = 'test-key'
        def boom(payload, key): raise TimeoutError()
        ai_explainer._post = boom
        self.assertEqual(ai_explainer.explain_findings([], 'FIELDS_CONSISTENT')['source'], 'fallback_api_error')

class ExplainEndpointTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        app.LEDGER_PATH = Path(self.tmp.name) / 'e.jsonl'
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), app.Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        os.environ.pop('ANTHROPIC_API_KEY', None)
    def tearDown(self):
        self.server.shutdown(); self.server.server_close(); self.tmp.cleanup()
    def post(self, path, body):
        req = urllib.request.Request(f'http://127.0.0.1:{self.server.server_port}{path}', data=json.dumps(body).encode(), headers={'Content-Type': 'application/json'})
        with urllib.request.urlopen(req) as r: return json.load(r)
    def test_explain_logs_event_and_does_not_change_status(self):
        rev = self.post('/review', {'expected_vendor': 'A', 'vendor': 'B', 'expected_amount': '1', 'amount': '1', 'net_amount': '1', 'tax_amount': '0', 'gross_amount': '1', 'invoice_number': 'X1'})
        out = self.post('/explain', {'receipt': rev['receipt']})
        self.assertIn('text', out); self.assertEqual(rev['status'], 'REVIEW_REQUIRED')
        text = app.LEDGER_PATH.read_text()
        self.assertIn('ai_explanation', text); self.assertNotIn(out['text'], text)
    def test_forged_receipt_rejected(self):
        self.post('/review', {'expected_vendor': 'A', 'vendor': 'A', 'expected_amount': '1', 'amount': '1', 'net_amount': '1', 'tax_amount': '0', 'gross_amount': '1', 'invoice_number': 'X1'})
        with self.assertRaises(urllib.error.HTTPError): self.post('/explain', {'receipt': {'index': 1, 'event_hash': 'f' * 64}})

if __name__ == '__main__': unittest.main()
