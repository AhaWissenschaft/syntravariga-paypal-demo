"""Deterministic invoice checks; informational only, never authorizes payment."""
from decimal import Decimal, InvalidOperation


def _money(value, label, findings):
    try:
        amount = Decimal(str(value).strip())
        if not amount.is_finite() or amount < 0 or amount > Decimal('10000000') or amount.as_tuple().exponent < -2:
            raise ValueError
        return amount.quantize(Decimal('0.01'))
    except (InvalidOperation, ValueError, AttributeError):
        findings.append({'code': 'INVALID_AMOUNT', 'field': label, 'message': f'{label} must be a finite amount with at most two decimal places.'})
        return None


def analyze_invoice(data):
    if not isinstance(data, dict):
        raise ValueError('invoice data must be an object')
    findings = []
    required = ('expected_vendor', 'vendor', 'expected_amount', 'amount', 'net_amount', 'tax_amount', 'gross_amount', 'invoice_number')
    for field in required:
        if not isinstance(data.get(field), str) or not data[field].strip():
            findings.append({'code':'MISSING_FIELD', 'field':field, 'message':f'{field} is required.'})
    expected_vendor = data.get('expected_vendor','')
    vendor = data.get('vendor','')
    expected_vendor = expected_vendor.strip().casefold() if isinstance(expected_vendor,str) else ''
    vendor = vendor.strip().casefold() if isinstance(vendor,str) else ''
    if expected_vendor and vendor and expected_vendor != vendor:
        findings.append({'code':'VENDOR_MISMATCH','field':'vendor','message':'Supplier does not match the supplied expected supplier.'})
    amounts={key:_money(data.get(key,''),key,findings) for key in ('expected_amount','amount','net_amount','tax_amount','gross_amount')}
    if amounts['expected_amount'] is not None and amounts['amount'] is not None and amounts['expected_amount'] != amounts['amount']:
        findings.append({'code':'EXPECTED_AMOUNT_MISMATCH','field':'amount','message':'Invoice amount differs from the supplied expected amount.'})
    if all(amounts[k] is not None for k in ('net_amount','tax_amount','gross_amount')) and amounts['net_amount'] + amounts['tax_amount'] != amounts['gross_amount']:
        findings.append({'code':'TOTAL_MISMATCH','field':'gross_amount','message':'Net plus tax does not equal gross.'})
    if amounts['amount'] is not None and amounts['gross_amount'] is not None and amounts['amount'] != amounts['gross_amount']:
        findings.append({'code':'GROSS_AMOUNT_MISMATCH','field':'gross_amount','message':'Invoice amount does not equal gross amount.'})
    number=data.get('invoice_number','')
    number=number.strip() if isinstance(number,str) else ''
    if number and len(number)>100:
        findings.append({'code':'INVALID_INVOICE_NUMBER','field':'invoice_number','message':'Invoice number is too long.'})
    explanation = 'No listed discrepancy. This only checks supplied fields; it does not prove invoice validity or payment safety.'
    if findings:
        details=[]
        for item in findings:
            if item['code']=='EXPECTED_AMOUNT_MISMATCH' and amounts['expected_amount'] is not None and amounts['amount'] is not None:
                details.append(f"Invoice amount differs from expected amount by {amounts['amount']-amounts['expected_amount']:+.2f} EUR.")
            elif item['code']=='TOTAL_MISMATCH' and all(amounts[k] is not None for k in ('net_amount','tax_amount','gross_amount')):
                details.append(f"Net plus tax is {amounts['net_amount']+amounts['tax_amount']:.2f} EUR; stated gross is {amounts['gross_amount']:.2f} EUR.")
            elif item['code']=='GROSS_AMOUNT_MISMATCH' and amounts['amount'] is not None and amounts['gross_amount'] is not None:
                details.append(f"Invoice amount differs from gross by {amounts['amount']-amounts['gross_amount']:+.2f} EUR.")
            elif item['code']=='VENDOR_MISMATCH':
                details.append('Supplier text differs from the supplied expected supplier.')
            else:
                details.append(f"{item['field']}: {item['message']}")
        explanation=' '.join(details)+' Review manually; findings do not establish fraud or payment safety.'
    return {'status':'REVIEW_REQUIRED' if findings else 'FIELDS_CONSISTENT', 'findings':findings,
            'explanation': explanation}
