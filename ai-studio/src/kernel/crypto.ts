/**
 * @license
 * SyntraVariga / AhaWissenschaft Research Framework
 * Module: Cryptographic Primitives & Canonical Serialization
 *
 * Why this file exists:
 * Provides zero-dependency, deterministic SHA-256 hashing (FIPS PUB 180-4) and
 * Canonical JSON serialization for cross-language parity with Python's `aha_lab`:
 * json.dumps(val, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)
 *
 * Domain & Parity Guarantees:
 * 1. Object keys are sorted by Unicode code point order (matching Python `sort_keys=True`,
 *    correctly handling supplementary plane characters / emojis above U+FFFF).
 * 2. In JavaScript, `1.0` and `1` are identical IEEE-754 Numbers (`typeof 1.0 === 'number'`),
 *    whereas Python distinguishes `int(1)` from `float(1.0)`. To prevent cross-language hash
 *    divergence between `1` and `1.0`, canonicalJson enforces integer-only numbers or decimal
 *    strings in cross-language contracts (or explicitly rejects non-integer floats when
 *    strictIntegerOnly is enabled).
 * 3. Deterministic SHA-256 conforms to FIPS PUB 180-4.
 */

/**
 * Compares two strings by Unicode code point order (matching Python's `str < str` and `sort_keys=True`),
 * rather than JavaScript's default UTF-16 code unit order.
 */
export function compareCodePoints(a: string, b: string): number {
  const cpA = Array.from(a);
  const cpB = Array.from(b);
  const len = Math.min(cpA.length, cpB.length);
  for (let i = 0; i < len; i++) {
    const diff = cpA[i].codePointAt(0)! - cpB[i].codePointAt(0)!;
    if (diff !== 0) return diff;
  }
  return cpA.length - cpB.length;
}

export interface CanonicalJsonOptions {
  /**
   * When true, rejects non-integer floats to prevent JS `1.0 -> "1"` vs Python `1.0 -> "1.0"`
   * serialization divergence. Monetary and quantitative values in cross-language ledgers
   * should be encoded as integer cents/basis-points or decimal strings.
   */
  disallowFloats?: boolean;
}

/**
 * Deterministic Canonical JSON stringifier.
 * - Objects have sorted keys in lexicographical Unicode code-point order.
 * - Whitespace between separators is eliminated (no space after ':' or ',').
 * - Disallows NaN, Infinity, -0, and undefined.
 */
export function canonicalJson(value: unknown, options?: CanonicalJsonOptions): string {
  if (value === null || typeof value === 'boolean') {
    return String(value);
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('Canonical JSON prohibits NaN and Infinity');
    }
    if (options?.disallowFloats && !Number.isInteger(value)) {
      throw new TypeError(
        `Non-integer float ${value} is disallowed in strict cross-language canonical JSON; use integer cents or decimal strings`
      );
    }
    // Normalize -0 to 0
    return Object.is(value, -0) ? '0' : String(value);
  }

  if (typeof value === 'string') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    const elements = value.map((el) => canonicalJson(el, options));
    return '[' + elements.join(',') + ']';
  }

  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort(compareCodePoints);
    const pairs = keys.map((key) => {
      const propVal = (value as Record<string, unknown>)[key];
      if (propVal === undefined) {
        throw new TypeError(`Undefined property '${key}' is forbidden in canonical JSON`);
      }
      return JSON.stringify(key) + ':' + canonicalJson(propVal, options);
    });
    return '{' + pairs.join(',') + '}';
  }

  throw new TypeError(`Unsupported type in canonical JSON: ${typeof value}`);
}

// Pure FIPS 180-4 SHA-256 Implementation
function rotr(n: number, x: number): number {
  return (x >>> n) | (x << (32 - n));
}

function ch(x: number, y: number, z: number): number {
  return (x & y) ^ (~x & z);
}

function maj(x: number, y: number, z: number): number {
  return (x & y) ^ (x & z) ^ (y & z);
}

function sigma0(x: number): number {
  return rotr(2, x) ^ rotr(13, x) ^ rotr(22, x);
}

function sigma1(x: number): number {
  return rotr(6, x) ^ rotr(11, x) ^ rotr(25, x);
}

function gamma0(x: number): number {
  return rotr(7, x) ^ rotr(18, x) ^ (x >>> 3);
}

function gamma1(x: number): number {
  return rotr(17, x) ^ rotr(19, x) ^ (x >>> 10);
}

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const UTF8_ENCODER = new TextEncoder();

/**
 * Computes the SHA-256 hash as a 64-character lowercase hexadecimal string.
 * Conforms to FIPS PUB 180-4.
 */
export function sha256Hex(input: string | Uint8Array): string {
  const bytes = typeof input === 'string' ? UTF8_ENCODER.encode(input) : input;
  const bitLength = bytes.length * 8;

  // Pre-processing: padding
  const totalLength = ((bytes.length + 9 + 63) >>> 6) << 6;
  const padded = new Uint8Array(totalLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;

  // Append length in bits as a 64-bit big-endian integer
  const view = new DataView(padded.buffer);
  const highBits = Math.floor(bitLength / 0x100000000);
  const lowBits = bitLength >>> 0;
  view.setUint32(totalLength - 8, highBits, false);
  view.setUint32(totalLength - 4, lowBits, false);

  // Initialize hash state
  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  const w = new Uint32Array(64);

  for (let i = 0; i < totalLength; i += 64) {
    for (let t = 0; t < 16; t++) {
      w[t] = view.getUint32(i + t * 4, false);
    }
    for (let t = 16; t < 64; t++) {
      w[t] = (gamma1(w[t - 2]) + w[t - 7] + gamma0(w[t - 15]) + w[t - 16]) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let t = 0; t < 64; t++) {
      const t1 = (h + sigma1(e) + ch(e, f, g) + K[t] + w[t]) >>> 0;
      const t2 = (sigma0(a) + maj(a, b, c)) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  const out = [h0, h1, h2, h3, h4, h5, h6, h7]
    .map((v) => v.toString(16).padStart(8, '0'))
    .join('');

  return out;
}

/**
 * Computes the SHA-256 digest of any JSON-serializable structure after canonicalization.
 */
export function sha256Canonical(value: unknown, options?: CanonicalJsonOptions): string {
  const canonical = canonicalJson(value, options);
  return sha256Hex(canonical);
}
