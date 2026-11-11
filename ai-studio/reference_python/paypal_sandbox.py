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

class PayPalSandboxError(RuntimeError):
    pass

def _request(method, path, body=None):
    client_id=os.environ.get('PAYPAL_CLIENT_ID')
    secret=os.environ.get('PAYPAL_CLIENT_SECRET')
    if not client_id or not secret:
        raise PayPalSandboxError('Sandbox credentials are not configured')
    token_req=urllib.request.Request(BASE+'/v1/oauth2/token',data=b'grant_type=client_credentials',method='POST',headers={'Authorization':'Basic '+base64.b64encode((client_id+':'+secret).encode()).decode(),'Content-Type':'application/x-www-form-urlencoded'})
    try:
        with urllib.request.urlopen(token_req,timeout=12) as response: token=json.load(response)['access_token']
        raw=json.dumps(body).encode() if body is not None else None
        req=urllib.request.Request(BASE+path,data=raw,method=method,headers={'Authorization':'Bearer '+token,'Content-Type':'application/json','Accept':'application/json'})
        with urllib.request.urlopen(req,timeout=20) as response: return json.load(response)
    except (urllib.error.URLError,TimeoutError,KeyError,ValueError) as exc:
        raise PayPalSandboxError('PayPal sandbox request failed') from exc

def create_order(receipt_hash):
    if not re.fullmatch(r'[0-9a-f]{64}',str(receipt_hash)): raise ValueError('Invalid receipt hash')
    return _request('POST','/v2/checkout/orders',{'intent':'CAPTURE','purchase_units':[{'amount':{'currency_code':'EUR','value':'1.00'},'custom_id':receipt_hash,'description':'SyntraVariga sandbox test only'}]})

def capture_order(order_id,receipt_hash):
    if not re.fullmatch(r'[A-Z0-9-]{5,64}',str(order_id)): raise ValueError('Invalid order id')
    if not re.fullmatch(r'[0-9a-f]{64}',str(receipt_hash)): raise ValueError('Invalid receipt hash')
    order=_request('GET','/v2/checkout/orders/'+order_id)
    units=order.get('purchase_units',[])
    if order.get('status')!='APPROVED' or not units or units[0].get('custom_id')!=receipt_hash:
        raise PayPalSandboxError('Order is not approved or receipt does not match')
    result=_request('POST','/v2/checkout/orders/'+order_id+'/capture',{})
    if result.get('status')!='COMPLETED': raise PayPalSandboxError('Sandbox capture was not completed')
    return result
