import unittest
from unittest.mock import patch
from invoice_guard import analyze_invoice
from ai_extractor import extract_invoice_fields

class Changes(unittest.TestCase):
    def test_zero_tax_is_allowed(self):
        x = dict(expected_vendor="A", vendor="A", expected_amount="100.00", amount="100.00", net_amount="100.00", tax_amount="0.00", gross_amount="100.00", invoice_number="X")
        self.assertEqual(analyze_invoice(x)["status"], "FIELDS_CONSISTENT")

    @patch.dict("os.environ", {"GEMINI_API_KEY": "fake", "SYNTRA_ALLOW_EXTERNAL_AI": "0"})
    @patch("ai_extractor._call_gemini", side_effect=AssertionError("network must not run"))
    def test_external_ai_off_by_default(self, call):
        self.assertEqual(extract_invoice_fields("Invoice total 10.00")["mode"], "LOCAL_FALLBACK_NO_LIVE_AI")
        call.assert_not_called()
