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
    number=data.get('invoice_number','')
    number=number.strip() if isinstance(number,str) else ''
    if number and len(number)>100:
        findings.append({'code':'INVALID_INVOICE_NUMBER','field':'invoice_number','message':'Invoice number is too long.'})
    return {'status':'REVIEW_REQUIRED' if findings else 'FIELDS_CONSISTENT', 'findings':findings,
            'explanation': 'Review the listed arithmetic and supplied-field comparisons manually. Consistency does not establish invoice validity or payment safety.'}
