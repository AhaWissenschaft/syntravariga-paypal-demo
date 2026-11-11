import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { canonicalJson, sha256Hex, sha256Canonical, compareCodePoints } from './crypto';

test('canonicalJson sorts keys lexicographically and strips extraneous whitespace', () => {
  const input = {
    z: 1,
    a: 'hello',
    m: [3, 2, 1],
    nested: { b: true, a: null },
  };
  const expected = '{"a":"hello","m":[3,2,1],"nested":{"a":null,"b":true},"z":1}';
  assert.equal(canonicalJson(input), expected);
});

test('compareCodePoints sorts supplementary plane emojis (U+1F600) after U+FFFD like Python sort_keys=True', () => {
  // In UTF-16 code units, "\uD83D\uDE00" (0xD83D) < "\uFFFD" (0xFFFD).
  // In Unicode code points (Python sort_keys=True), U+FFFD (65533) < U+1F600 (128512).
  const emoji = '😀'; // U+1F600
  const replacement = '\uFFFD'; // U+FFFD
  assert.ok(compareCodePoints(replacement, emoji) < 0);

  const obj = { [emoji]: 1, [replacement]: 2 };
  assert.equal(canonicalJson(obj), `{"\uFFFD":2,"😀":1}`);
});

test('canonicalJson disallowFloats option prevents JS 1.0 vs Python 1.0 float serialization ambiguity', () => {
  assert.doesNotThrow(() => canonicalJson({ amount_cents: 11900 }, { disallowFloats: true }));
  assert.throws(
    () => canonicalJson({ ratio: 1.25 }, { disallowFloats: true }),
    /Non-integer float 1.25 is disallowed/
  );
});

test('sha256Hex matches Node.js crypto for standard strings, umlauts, EUR, and emojis', () => {
  const testCases = [
    '',
    'abc',
    'SyntraVariga Quant & Verification Framework',
    'AhaWissenschaft · 2026 · €119.00 · ÄÖÜäöüß',
    '😀🚀🔬📊🧪',
    'The quick brown fox jumps over the lazy dog',
  ];

  for (const tc of testCases) {
    const expected = crypto.createHash('sha256').update(tc, 'utf8').digest('hex');
    const actual = sha256Hex(tc);
    assert.equal(actual, expected, `Mismatch for: "${tc}"`);
  }
});

test('sha256Canonical produces exact 64-char hex digest of canonically ordered structure', () => {
  const obj1 = { b: 2, a: 1 };
  const obj2 = { a: 1, b: 2 };
  assert.equal(sha256Canonical(obj1), sha256Canonical(obj2));
  assert.match(sha256Canonical(obj1), /^[0-9a-f]{64}$/);
});

test('sha256Canonical matches Python aha_lab reference test vector for integer/string/array payloads', () => {
  const payload = { status: 'FIELDS_CONSISTENT', finding_codes: [] };
  const expectedPayloadHash = '912095a96074ed323d32f13e98f9acf1866e360bca84e09438c17aa87f5368b6';
  assert.equal(sha256Canonical(payload), expectedPayloadHash);

  const unsignedEvent = {
    schema: 'aha.lab.ledger-event.v1',
    index: 1,
    event_id: 'EVT-00000001',
    event_type: 'invoice_review',
    timestamp: '2026-11-11T12:00:00Z',
    previous_hash: '0'.repeat(64),
    payload_sha256: expectedPayloadHash,
    payload,
  };
  const expectedEventHash = '931210477fa0cc575731a11efe555870d6b2c87752ef48c4cb21d2a91f4876f0';
  assert.equal(sha256Canonical(unsignedEvent), expectedEventHash);
});
