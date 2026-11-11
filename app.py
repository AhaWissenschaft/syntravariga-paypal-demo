"""Local sandbox review server. No real payments or payment authorization."""
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import threading
import urllib.parse
from invoice_guard import analyze_invoice
from aha_lab.ledger import append_event, read_events, verify_ledger, LedgerError

PAGE_TEMPLATE = Path(__file__).with_name('index.html').read_text(encoding='utf-8')
LEDGER_PATH = Path(os.environ.get('SYNTRA_DEMO_LEDGER', '/tmp/syntravariga_paypal_demo.jsonl'))
LEDGER_LOCK = threading.Lock()

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == '/':
            client_id=urllib.parse.quote(os.environ.get('PAYPAL_CLIENT_ID','sb').strip() or 'sb',safe='')
            page=PAGE_TEMPLATE.replace('client-id=sb',f'client-id={client_id}').encode('utf-8')
            self.send_response(200); self.send_header('Content-Type','text/html; charset=utf-8'); self.send_header('Cache-Control','no-store'); self.end_headers(); self.wfile.write(page); return
        if self.path == '/ledger':
            try:
                with LEDGER_LOCK:
                    report=verify_ledger(LEDGER_PATH)
                    events=read_events(LEDGER_PATH)
                payload={'verification':{'status':report['status'],'event_count':report['event_count'],'head_hash':report['head_hash'],'errors':report['errors']},
                         'events':[{'index':e.get('index'),'event_type':e.get('event_type'),'timestamp':e.get('timestamp'),'event_hash':e.get('event_hash'),'payload':{k:v for k,v in e.get('payload',{}).items() if k in ('finding_codes','status','scope','paypal_status','receipt_hash')}} for e in events]}
                body=json.dumps(payload).encode('utf-8')
                self.send_response(200); self.send_header('Content-Type','application/json'); self.send_header('Cache-Control','no-store'); self.end_headers(); self.wfile.write(body); return
            except (OSError,LedgerError):
                self.send_error(503,'Ledger invalid or unreadable'); return
        self.send_error(404)

    def _body(self, limit=8192):
        length=int(self.headers.get('Content-Length','0'))
        if length<=0 or length>limit: raise ValueError('size')
        value=json.loads(self.rfile.read(length))
        if not isinstance(value,dict): raise ValueError('object required')
        return value

    def do_POST(self):
        if self.path not in ('/review','/paypal/order','/paypal/capture'):
            self.send_error(404); return
        try:
            data=self._body()
            if self.path=='/review':
                result=analyze_invoice(data)
                with LEDGER_LOCK:
                    event=append_event(LEDGER_PATH,event_type='invoice_review',timestamp=datetime.now(timezone.utc).isoformat(),payload={'finding_codes':[f['code'] for f in result['findings']],'status':result['status'],'scope':'deterministic_demo_review'})
                result['receipt']={'index':event['index'],'event_hash':event['event_hash']}
            else:
                receipt=data.get('receipt')
                if not isinstance(receipt,dict) or not isinstance(receipt.get('index'),int) or not isinstance(receipt.get('event_hash'),str): raise ValueError('receipt')
                report=verify_ledger(LEDGER_PATH)
                if report['status']!='PASS' or receipt['index']<1 or receipt['index']>report['event_count'] or report['event_hashes'][receipt['index']-1]!=receipt['event_hash']: raise LedgerError('invalid receipt')
                event=read_events(LEDGER_PATH)[receipt['index']-1]
                if event.get('event_type')!='invoice_review' or event.get('payload',{}).get('status')!='FIELDS_CONSISTENT': raise ValueError('invoice review is not consistent')
                from paypal_sandbox import create_order, capture_order
                if self.path=='/paypal/order': result=create_order(receipt['event_hash'])
                else:
                    order_id=data.get('order_id')
                    if not isinstance(order_id,str): raise ValueError('order_id')
                    result=capture_order(order_id,receipt['event_hash'])
                with LEDGER_LOCK:
                    append_event(LEDGER_PATH,event_type='paypal_sandbox_'+('order' if self.path.endswith('/order') else 'capture'),timestamp=datetime.now(timezone.utc).isoformat(),payload={'receipt_hash':receipt['event_hash'],'paypal_status':result.get('status'),'order_id':result.get('id')})
            body=json.dumps(result).encode()
            self.send_response(200); self.send_header('Content-Type','application/json'); self.send_header('Cache-Control','no-store'); self.end_headers(); self.wfile.write(body)
        except (OSError, LedgerError): self.send_error(503,'Ledger invalid or PayPal sandbox unavailable')
        except (ValueError, UnicodeError, json.JSONDecodeError): self.send_error(400,'Invalid request')
        except Exception: self.send_error(502,'PayPal sandbox request failed')

if __name__=='__main__':
    server=ThreadingHTTPServer(('127.0.0.1',8787),Handler)
    print('SyntraVariga sandbox demo at http://127.0.0.1:8787',flush=True)
    server.serve_forever()
