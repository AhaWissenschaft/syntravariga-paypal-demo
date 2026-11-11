import unittest
from invoice_guard import analyze_invoice

def valid(): return {'expected_vendor':'Acme','vendor':'Acme','expected_amount':'119','amount':'119','net_amount':'100','tax_amount':'19','gross_amount':'119','invoice_number':'INV-1'}

class InvoiceTests(unittest.TestCase):
 def test_consistent_input_is_only_fields_consistent(self): self.assertEqual(analyze_invoice(valid())['status'],'FIELDS_CONSISTENT')
 def test_supplier_mismatch_requires_review(self):
  x=valid();x['vendor']='Other';self.assertIn('VENDOR_MISMATCH',[f['code'] for f in analyze_invoice(x)['findings']])
 def test_amount_and_arithmetic_mismatch(self):
  x=valid();x['amount']='120';x['gross_amount']='120';self.assertEqual({f['code'] for f in analyze_invoice(x)['findings']},{'EXPECTED_AMOUNT_MISMATCH','TOTAL_MISMATCH'})
 def test_missing_and_invalid_fields_fail_closed(self):
  x=valid();x['invoice_number']='';x['amount']='NaN';self.assertEqual(analyze_invoice(x)['status'],'REVIEW_REQUIRED')
 def test_negative_amount_fails_closed(self):
  x=valid();x['amount']='-1';self.assertIn('INVALID_AMOUNT',[f['code'] for f in analyze_invoice(x)['findings']])

if __name__=='__main__': unittest.main()
