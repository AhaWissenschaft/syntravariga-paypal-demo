"""Minimal PayPal REST API adapter restricted to Sandbox. Credentials via environment only."""
import base64
import json
import os
import re
from urllib.parse import urlparse
import urllib.error
import urllib.request

BASE = os.environ.get('PAYPAL_API_BASE', 'https://api-m.sandbox.paypal.com').rstrip('/')
if urlparse(BASE).scheme != 'https' or urlparse(BASE).netloc != 'api-m.sandbox.paypal.com':
    raise RuntimeError('Only the PayPal sandbox API host is allowed')

AMOUNT_RE = re.compile(r'^\d{1,7}\.\d{2}$')


class PayPalSandboxError(RuntimeError):
    def __init__(self, message: str, *, uncertain: bool = False):
        super().__init__(message)
        self.uncertain = uncertain


def _request(method, path, body=None, headers_extra=None):
    client_id = os.environ.get('PAYPAL_CLIENT_ID')
    secret = os.environ.get('PAYPAL_CLIENT_SECRET')
    if not client_id or not secret:
        raise PayPalSandboxError('Sandbox credentials are not configured', uncertain=False)
    auth = base64.b64encode((client_id + ':' + secret).encode()).decode()
    token_req = urllib.request.Request(
        BASE + '/v1/oauth2/token',
        data=b'grant_type=client_credentials',
        method='POST',
        headers={
            'Authorization': 'Basic ' + auth,
            'Content-Type': 'application/x-www-form-urlencoded',
        },
    )
    try:
        with urllib.request.urlopen(token_req, timeout=12) as response:
            token = json.load(response)['access_token']
    except (urllib.error.URLError, TimeoutError, KeyError, ValueError) as exc:
        raise PayPalSandboxError('PayPal sandbox authentication failed', uncertain=False) from exc

    raw = json.dumps(body).encode() if body is not None else None
    req_headers = {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
    }
    if headers_extra:
        req_headers.update(headers_extra)
    req = urllib.request.Request(BASE + path, data=raw, method=method, headers=req_headers)
    try:
        with urllib.request.urlopen(req, timeout=20) as response:
            return json.load(response)
    except urllib.error.HTTPError as exc:
        raise PayPalSandboxError(f'PayPal sandbox HTTP {exc.code}', uncertain=(exc.code >= 500)) from exc
    except (urllib.error.URLError, TimeoutError, KeyError, ValueError) as exc:
        raise PayPalSandboxError('PayPal sandbox network or timeout error', uncertain=True) from exc


def create_order(receipt_hash: str, amount_value: str = '1.00', currency: str = 'EUR'):
    if not re.fullmatch(r'[0-9a-f]{64}', str(receipt_hash)):
        raise ValueError('Invalid receipt hash')
    if currency != 'EUR' or not AMOUNT_RE.fullmatch(str(amount_value)):
        raise ValueError('Invalid order amount or currency')
    return _request(
        'POST',
        '/v2/checkout/orders',
        {
            'intent': 'CAPTURE',
            'purchase_units': [
                {
                    'amount': {'currency_code': currency, 'value': amount_value},
                    'custom_id': receipt_hash,
                    'description': 'SyntraVariga sandbox test only',
                }
            ],
        },
        headers_extra={'PayPal-Request-Id': f'order-{receipt_hash[:32]}'},
    )


def capture_order(order_id: str, receipt_hash: str, expected_amount: str | None = None, currency: str = 'EUR'):
    if not re.fullmatch(r'[A-Z0-9-]{5,64}', str(order_id)):
        raise ValueError('Invalid order id')
    if not re.fullmatch(r'[0-9a-f]{64}', str(receipt_hash)):
        raise ValueError('Invalid receipt hash')
    if expected_amount is not None and not AMOUNT_RE.fullmatch(str(expected_amount)):
        raise ValueError('Invalid expected amount')

    order = _request('GET', '/v2/checkout/orders/' + order_id)
    units = order.get('purchase_units', [])
    if order.get('status') != 'APPROVED' or not units or units[0].get('custom_id') != receipt_hash:
        raise PayPalSandboxError('Order is not approved or receipt does not match', uncertain=False)
    unit_amount = units[0].get('amount', {})
    if expected_amount is not None:
        if unit_amount.get('value') != expected_amount or unit_amount.get('currency_code') != currency:
            raise PayPalSandboxError('Order amount or currency does not match approved review', uncertain=False)

    result = _request(
        'POST',
        '/v2/checkout/orders/' + order_id + '/capture',
        {},
        headers_extra={'PayPal-Request-Id': f'capture-{receipt_hash[:32]}'},
    )
    if result.get('status') != 'COMPLETED':
        raise PayPalSandboxError('Sandbox capture was not completed', uncertain=True)
    return result
