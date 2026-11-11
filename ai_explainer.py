"""AI explanation layer. The rules in invoice_guard.py alone decide the review result.

The model only receives generic finding codes and the status -- never invoice
fields, supplier names, amounts, invoice numbers or PayPal data. Its text is
informational and can never change a status or authorize a payment.
"""
import json
import os
import urllib.error
import urllib.request

API_URL = 'https://api.anthropic.com/v1/messages'
DEFAULT_MODEL = 'claude-sonnet-5-5'

CODE_MEANINGS = {
    'MISSING_FIELD': 'A required input field was empty or missing.',
    'INVALID_AMOUNT': 'An amount was not a valid non-negative number with at most two decimals.',
    'VENDOR_MISMATCH': 'The supplier text differs from the expected supplier text.',
    'EXPECTED_AMOUNT_MISMATCH': 'The invoice amount differs from the expected amount.',
    'TOTAL_MISMATCH': 'Net plus tax does not equal the stated gross amount.',
    'GROSS_AMOUNT_MISMATCH': 'The invoice amount differs from the stated gross amount.',
    'INVALID_INVOICE_NUMBER': 'The invoice number is longer than allowed.',
}

SYSTEM = (
    'You explain results of a deterministic invoice field check to a non-expert. '
    'You receive only generic finding codes. Reply in German, in at most 120 words, plain prose. '
    'For each code say what it generally means and one concrete manual step a person could take. '
    'Never claim fraud, never say an invoice is authentic, safe or approved, never recommend paying or not paying, '
    'and never invent amounts, names or details. Finish with: "Die Entscheidung trifft ein Mensch."'
)


class AIExplainError(RuntimeError):
    pass


def _post(payload, api_key):
    req = urllib.request.Request(
        API_URL, data=json.dumps(payload).encode(), method='POST',
        headers={'x-api-key': api_key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json'})
    with urllib.request.urlopen(req, timeout=20) as response:
        return json.load(response)


def _fallback(codes):
    parts = [CODE_MEANINGS[c] for c in codes] or ['Keine Abweichung in den geprüften Feldern.']
    return ' '.join(parts) + ' Die Entscheidung trifft ein Mensch.'


def explain_findings(codes, status):
    """Return {'source','model','text'}. Falls back to fixed text when no key or on any API error."""
    codes = [c for c in dict.fromkeys(codes) if c in CODE_MEANINGS]
    api_key = os.environ.get('ANTHROPIC_API_KEY', '').strip()
    model = os.environ.get('AI_MODEL', DEFAULT_MODEL).strip() or DEFAULT_MODEL
    if not api_key or os.environ.get('SYNTRA_ALLOW_EXTERNAL_AI') != '1':
        return {'source': 'fallback_no_api_key', 'model': None, 'text': _fallback(codes)}
    user = 'Status: %s\nFinding codes with generic meanings:\n%s' % (
        status if status in ('FIELDS_CONSISTENT', 'REVIEW_REQUIRED') else 'UNKNOWN',
        '\n'.join('- %s: %s' % (c, CODE_MEANINGS[c]) for c in codes) or '- (none)')
    try:
        data = _post({'model': model, 'max_tokens': 400, 'system': SYSTEM,
                      'messages': [{'role': 'user', 'content': user}]}, api_key)
        text = ''.join(b.get('text', '') for b in data.get('content', []) if b.get('type') == 'text').strip()
        if not text:
            raise AIExplainError('empty response')
        return {'source': 'ai_model', 'model': model, 'text': text[:1500]}
    except (urllib.error.URLError, TimeoutError, ValueError, AIExplainError, AttributeError):
        return {'source': 'fallback_api_error', 'model': None, 'text': _fallback(codes)}
