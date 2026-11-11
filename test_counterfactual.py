import unittest
from counterfactual import compare_examples

class CounterfactualTests(unittest.TestCase):
    def test_altered_values_trigger_findings_without_mutation(self):
        x=dict(expected_vendor='Demo',vendor='Demo',expected_amount='119.00',amount='119.00',net_amount='100.00',tax_amount='19.00',gross_amount='119.00',invoice_number='I1')
        before=x.copy(); out=compare_examples(x)
        self.assertEqual(x,before)
        self.assertEqual([case['status'] for case in out['cases']], ['FIELDS_CONSISTENT','REVIEW_REQUIRED','REVIEW_REQUIRED'])
        self.assertIn('EXPECTED_AMOUNT_MISMATCH',out['cases'][1]['finding_codes'])
        self.assertIn('VENDOR_MISMATCH',out['cases'][2]['finding_codes'])

    def test_invalid_amount_does_not_create_amount_example(self):
        result=compare_examples({'amount':'invalid'})
        self.assertEqual(len(result['cases']),2)
        self.assertEqual(result['cases'][0]['status'],'REVIEW_REQUIRED')
