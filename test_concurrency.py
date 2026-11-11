import tempfile, unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from payment_store import register_review, begin_order_creation, PaymentStateError

class PaymentConcurrencyTests(unittest.TestCase):
    def test_simultaneous_order_creation_reserves_once(self):
        with tempfile.TemporaryDirectory() as d:
            db = Path(d) / 'state.sqlite'
            register_review(db, receipt_hash='a'*64, receipt_index=1, approved_amount='119.00', currency='EUR', amount_commitment='b'*64)
            def attempt(_):
                try: begin_order_creation(db, 'a'*64); return True
                except PaymentStateError: return False
            with ThreadPoolExecutor(max_workers=8) as pool:
                results = list(pool.map(attempt, range(8)))
            self.assertEqual(sum(results), 1)

    def test_ambiguous_amount_does_not_autofill_total(self):
        from ai_extractor import extract_invoice_fields
        from unittest.mock import patch
        with patch.dict('os.environ', {'SYNTRA_ALLOW_EXTERNAL_AI':'0'}):
            result = extract_invoice_fields('Total: 119.00\nPayable: 116.62')
        self.assertIn('AMBIGUOUS_AMOUNT', result['warnings'])
        self.assertEqual(result['proposed_fields']['gross_amount'], '')
