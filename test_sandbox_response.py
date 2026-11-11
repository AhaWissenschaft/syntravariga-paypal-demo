import unittest
from unittest.mock import patch
from paypal_sandbox import capture_order, PayPalSandboxError

class SandboxResponseTests(unittest.TestCase):
    def test_order_status_alone_does_not_prove_capture(self):
        review='a'*64
        order={'status':'APPROVED','purchase_units':[{'custom_id':review,'amount':{'value':'119.00','currency_code':'EUR'}}]}
        with patch('paypal_sandbox._request', side_effect=[order, {'id':'ORDER-12345','status':'COMPLETED'}]):
            with self.assertRaises(PayPalSandboxError) as exc:
                capture_order('ORDER-12345',review,'119.00','EUR')
        self.assertTrue(exc.exception.uncertain)

    def test_capture_amount_and_status_confirmed(self):
        review='a'*64
        order={'status':'APPROVED','purchase_units':[{'custom_id':review,'amount':{'value':'119.00','currency_code':'EUR'}}]}
        capture={'id':'ORDER-12345','status':'COMPLETED','purchase_units':[{'payments':{'captures':[{'id':'CAPTURE-123','status':'COMPLETED','amount':{'value':'119.00','currency_code':'EUR'}}]}}]}
        with patch('paypal_sandbox._request', side_effect=[order,capture]):
            self.assertEqual(capture_order('ORDER-12345',review,'119.00','EUR')['status'],'COMPLETED')
