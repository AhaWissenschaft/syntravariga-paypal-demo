"""Illustrative, local rule comparisons; not a payment or fraud prediction."""
from decimal import Decimal, InvalidOperation
from invoice_guard import analyze_invoice


def compare_examples(invoice):
    if not isinstance(invoice, dict):
        raise ValueError('invoice object required')
    base = analyze_invoice(invoice)
    cases = [{'label': 'Submitted fields', 'result': base}]
    amount = invoice.get('amount', '')
    try:
        amount = Decimal(str(amount))
        changed = amount + Decimal('1.00')
        if not amount.is_finite() or changed > Decimal('10000000'):
            raise ValueError('amount outside example range')
        data = dict(invoice, amount=f'{changed:.2f}')
        cases.append({'label': 'Invoice amount increased by 1.00 EUR', 'result': analyze_invoice(data)})
    except (InvalidOperation, ValueError, OverflowError):
        pass
    data = dict(invoice, vendor='Example Different Supplier')
    cases.append({'label': 'Supplier changed to example supplier', 'result': analyze_invoice(data)})
    return {'notice': 'Illustrative changes to supplied fields only; no payment or fraud prediction.',
            'cases': [{'label': c['label'], 'status': c['result']['status'],
                       'finding_codes': [f['code'] for f in c['result']['findings']]}
                      for c in cases]}
