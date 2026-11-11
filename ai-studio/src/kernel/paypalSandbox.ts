/**
 * @license
 * SyntraVariga / AhaWissenschaft Research Framework
 * Module: Strictly Validated PayPal Sandbox REST & Protocol State Machine (Fixes Point 3)
 */
import { sha256Hex } from './crypto';

export const ALLOWED_SANDBOX_HOST = 'https://api-m.sandbox.paypal.com';
const RECEIPT_HASH_RE = /^[0-9a-f]{64}$/;
const ORDER_ID_RE = /^[A-Z0-9-]{5,64}$/;
const EUR_AMOUNT_RE = /^(0|[1-9]\d*)\.\d{2}$/;

export class PayPalSandboxError extends Error {
  public readonly isAmbiguousNetworkState: boolean;
  constructor(message: string, isAmbiguousNetworkState = false) {
    super(message);
    this.name = 'PayPalSandboxError';
    this.isAmbiguousNetworkState = isAmbiguousNetworkState;
  }
}

export class ValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValueError';
  }
}

export interface PayPalLinkDescription {
  href: string;
  rel: string;
  method?: string;
}

export interface PayPalCaptureRecord {
  id: string;
  status: 'COMPLETED';
  amount: {
    currency_code: 'EUR';
    value: string;
  };
  create_time: string;
}

export interface PayPalOrderPurchaseUnit {
  amount: {
    currency_code: 'EUR';
    value: string;
  };
  custom_id: string;
  description?: string;
  payments?: {
    captures?: PayPalCaptureRecord[];
  };
}

export interface PayPalSandboxOrder {
  id: string;
  status: 'CREATED' | 'APPROVED' | 'COMPLETED';
  intent: 'CAPTURE';
  execution_mode: 'LIVE_PAYPAL_SANDBOX_REST' | 'SANDBOX_PROTOCOL_SIMULATION';
  approve_url: string;
  links?: PayPalLinkDescription[];
  create_time: string;
  approve_time?: string;
  capture_time?: string;
  payer?: {
    email_address: string;
    payer_id: string;
  };
  purchase_units: [PayPalOrderPurchaseUnit];
}

export function validateSandboxBaseUrl(rawBase?: string): string {
  const base = (rawBase || ALLOWED_SANDBOX_HOST).trim().replace(/\/+$/, '');
  let parsed: URL;
  try {
    parsed = new URL(base);
  } catch {
    throw new PayPalSandboxError('Only the PayPal sandbox API host is allowed');
  }
  if (parsed.protocol !== 'https:' || parsed.host !== 'api-m.sandbox.paypal.com') {
    throw new PayPalSandboxError('Only the PayPal sandbox API host is allowed');
  }
  return base;
}

export function hasLiveSandboxCredentials(env: Record<string, string | undefined>): boolean {
  const clientId = env.PAYPAL_CLIENT_ID?.trim();
  const secret = env.PAYPAL_CLIENT_SECRET?.trim();
  return Boolean(
    clientId &&
      secret &&
      clientId !== 'MY_PAYPAL_CLIENT_ID' &&
      secret !== 'MY_PAYPAL_CLIENT_SECRET'
  );
}

export function extractPayPalApproveUrl(
  orderId: string,
  links?: Array<{ href?: string; rel?: string; method?: string }>
): string {
  if (Array.isArray(links)) {
    const found = links.find(
      (l) => l && typeof l.href === 'string' && (l.rel === 'approve' || l.rel === 'payer-action')
    );
    if (found?.href) {
      return found.href;
    }
  }
  return `https://www.sandbox.paypal.com/checkoutnow?token=${encodeURIComponent(orderId)}`;
}

/**
 * Strictly validates a PayPal Order payload (GET or POST /v2/checkout/orders).
 * Never substitutes missing fields with expected values.
 */
export function verifyStrictPayPalOrderPayload(
  raw: Record<string, unknown>,
  expected: {
    expectedOrderId?: string;
    expectedStatus: 'CREATED' | 'APPROVED';
    expectedReceiptHash: string;
    expectedAmountEur: string;
  }
): {
  orderId: string;
  status: 'CREATED' | 'APPROVED';
  unit: PayPalOrderPurchaseUnit;
  links: PayPalLinkDescription[];
} {
  if (!raw || typeof raw !== 'object') {
    throw new PayPalSandboxError('PayPal response is not a valid JSON object');
  }
  const id = raw.id;
  if (typeof id !== 'string' || !ORDER_ID_RE.test(id)) {
    throw new PayPalSandboxError('PayPal response is missing a valid order id');
  }
  if (expected.expectedOrderId && id !== expected.expectedOrderId) {
    throw new PayPalSandboxError(
      `PayPal order id mismatch: expected '${expected.expectedOrderId}', got '${id}'`
    );
  }
  if (raw.status !== expected.expectedStatus) {
    throw new PayPalSandboxError(
      `PayPal order status mismatch: expected '${expected.expectedStatus}', got '${String(raw.status)}'`
    );
  }
  const units = raw.purchase_units;
  if (!Array.isArray(units) || units.length !== 1) {
    throw new PayPalSandboxError(
      `PayPal order must contain exactly 1 purchase_unit (got ${Array.isArray(units) ? units.length : 'none'})`
    );
  }
  const u = units[0] as Record<string, unknown>;
  if (!u || typeof u !== 'object') {
    throw new PayPalSandboxError('PayPal purchase_unit[0] is invalid');
  }
  if (u.custom_id !== expected.expectedReceiptHash) {
    throw new PayPalSandboxError(
      'PayPal purchase_unit[0].custom_id does not match verified receipt_hash'
    );
  }
  const amount = u.amount as Record<string, unknown> | undefined;
  if (!amount || typeof amount !== 'object') {
    throw new PayPalSandboxError('PayPal purchase_unit[0].amount is missing');
  }
  if (amount.currency_code !== 'EUR') {
    throw new PayPalSandboxError(
      `PayPal purchase_unit[0] currency mismatch: expected 'EUR', got '${String(amount.currency_code)}'`
    );
  }
  if (amount.value !== expected.expectedAmountEur) {
    throw new PayPalSandboxError(
      `PayPal purchase_unit[0] amount mismatch: expected '${expected.expectedAmountEur}', got '${String(amount.value)}'`
    );
  }
  const links = Array.isArray(raw.links) ? (raw.links as PayPalLinkDescription[]) : [];
  return {
    orderId: id,
    status: expected.expectedStatus,
    unit: {
      amount: { currency_code: 'EUR', value: amount.value },
      custom_id: u.custom_id,
      description: typeof u.description === 'string' ? u.description : undefined,
    },
    links,
  };
}

/**
 * Strictly validates a PayPal Capture response (POST /v2/checkout/orders/{id}/capture).
 * Requires exact Order ID, COMPLETED status, exactly 1 purchase_unit, matching custom_id,
 * and exactly 1 COMPLETED capture with matching EUR amount and non-empty capture ID.
 */
export function verifyStrictPayPalCapturePayload(
  raw: Record<string, unknown>,
  expected: {
    expectedOrderId: string;
    expectedReceiptHash: string;
    expectedAmountEur: string;
  }
): {
  orderId: string;
  captureId: string;
  unit: PayPalOrderPurchaseUnit;
  links: PayPalLinkDescription[];
} {
  if (!raw || typeof raw !== 'object') {
    throw new PayPalSandboxError('PayPal capture response is not a valid object');
  }
  if (raw.id !== expected.expectedOrderId) {
    throw new PayPalSandboxError(
      `Capture response order id mismatch: expected '${expected.expectedOrderId}', got '${String(raw.id)}'`
    );
  }
  if (raw.status !== 'COMPLETED') {
    throw new PayPalSandboxError(
      `Capture response status is not COMPLETED (got '${String(raw.status)}')`
    );
  }
  const units = raw.purchase_units;
  if (!Array.isArray(units) || units.length !== 1) {
    throw new PayPalSandboxError(
      `Capture response must contain exactly 1 purchase_unit (got ${Array.isArray(units) ? units.length : 'none'})`
    );
  }
  const u = units[0] as Record<string, unknown>;
  if (!u || typeof u !== 'object') {
    throw new PayPalSandboxError('Capture purchase_unit[0] is missing');
  }
  if (u.custom_id !== expected.expectedReceiptHash) {
    throw new PayPalSandboxError(
      'Capture purchase_unit[0].custom_id is missing or does not match verified receipt_hash'
    );
  }
  const payments = u.payments as Record<string, unknown> | undefined;
  const captures = payments?.captures;
  if (!Array.isArray(captures) || captures.length !== 1) {
    throw new PayPalSandboxError(
      `Capture response must contain exactly 1 capture record (got ${Array.isArray(captures) ? captures.length : 'none'})`
    );
  }
  const cap = captures[0] as Record<string, unknown>;
  if (!cap || typeof cap !== 'object') {
    throw new PayPalSandboxError('Capture record [0] is invalid');
  }
  if (typeof cap.id !== 'string' || !ORDER_ID_RE.test(cap.id)) {
    throw new PayPalSandboxError('Capture record [0] is missing a valid id');
  }
  if (cap.status !== 'COMPLETED') {
    throw new PayPalSandboxError(
      `Capture record [0] status must be COMPLETED (got '${String(cap.status)}')`
    );
  }
  const capAmount = cap.amount as Record<string, unknown> | undefined;
  if (!capAmount || typeof capAmount !== 'object') {
    throw new PayPalSandboxError('Capture record [0] is missing amount');
  }
  if (capAmount.currency_code !== 'EUR') {
    throw new PayPalSandboxError(
      `Capture record [0] currency must be EUR (got '${String(capAmount.currency_code)}')`
    );
  }
  if (capAmount.value !== expected.expectedAmountEur) {
    throw new PayPalSandboxError(
      `Capture record [0] amount mismatch: expected '${expected.expectedAmountEur}', got '${String(capAmount.value)}'`
    );
  }

  const links = Array.isArray(raw.links) ? (raw.links as PayPalLinkDescription[]) : [];
  return {
    orderId: expected.expectedOrderId,
    captureId: cap.id,
    unit: {
      amount: { currency_code: 'EUR', value: expected.expectedAmountEur },
      custom_id: expected.expectedReceiptHash,
      payments: {
        captures: [
          {
            id: cap.id,
            status: 'COMPLETED',
            amount: { currency_code: 'EUR', value: expected.expectedAmountEur },
            create_time:
              typeof cap.create_time === 'string' && cap.create_time
                ? cap.create_time
                : new Date().toISOString(),
          },
        ],
      },
    },
    links,
  };
}

async function requestLivePayPalSandbox(
  method: 'GET' | 'POST',
  path: string,
  env: Record<string, string | undefined>,
  body?: unknown,
  idempotencyKey?: string
): Promise<Record<string, unknown>> {
  const base = validateSandboxBaseUrl(env.PAYPAL_API_BASE);
  const clientId = env.PAYPAL_CLIENT_ID?.trim();
  const secret = env.PAYPAL_CLIENT_SECRET?.trim();
  if (!clientId || !secret) {
    throw new PayPalSandboxError('Sandbox credentials are not configured', false);
  }

  const basicAuth = Buffer.from(`${clientId}:${secret}`, 'utf8').toString('base64');
  let accessToken: string;
  try {
    const tokenRes = await fetch(`${base}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basicAuth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(12000),
    });
    if (!tokenRes.ok) {
      throw new PayPalSandboxError(`PayPal sandbox token error (${tokenRes.status})`, false);
    }
    const tokenJson = (await tokenRes.json()) as { access_token?: string };
    if (!tokenJson.access_token) {
      throw new PayPalSandboxError('PayPal sandbox token missing access_token', false);
    }
    accessToken = tokenJson.access_token;
  } catch (err) {
    if (err instanceof PayPalSandboxError) throw err;
    throw new PayPalSandboxError('PayPal sandbox token request failed', false);
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (method === 'POST' && idempotencyKey) {
    headers['PayPal-Request-Id'] = idempotencyKey;
  }

  try {
    const apiRes = await fetch(`${base}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000),
    });
    if (!apiRes.ok) {
      const isServerSideUncertain = apiRes.status >= 500 || apiRes.status === 429;
      throw new PayPalSandboxError(
        `PayPal sandbox API error (${apiRes.status})`,
        method === 'POST' && isServerSideUncertain
      );
    }
    return (await apiRes.json()) as Record<string, unknown>;
  } catch (err) {
    if (err instanceof PayPalSandboxError) throw err;
    // Timeout or connection drop during POST leaves remote state ambiguous -> mark UNKNOWN
    throw new PayPalSandboxError(
      `PayPal sandbox network/timeout error: ${(err as Error).message}`,
      method === 'POST'
    );
  }
}

export class PayPalSandboxManager {
  private readonly simulatedOrders = new Map<string, PayPalSandboxOrder>();
  private orderCounter = 0;

  public validateReceiptHash(receiptHash: string): void {
    if (typeof receiptHash !== 'string' || !RECEIPT_HASH_RE.test(receiptHash)) {
      throw new ValueError('Invalid receipt hash');
    }
  }

  public validateOrderId(orderId: string): void {
    if (typeof orderId !== 'string' || !ORDER_ID_RE.test(orderId)) {
      throw new ValueError('Invalid order id');
    }
  }

  public validateVerifiedAmount(amountEur: string): void {
    if (typeof amountEur !== 'string' || !EUR_AMOUNT_RE.test(amountEur)) {
      throw new ValueError('Invalid verified EUR amount format');
    }
    const numeric = Number(amountEur);
    if (!Number.isFinite(numeric) || numeric <= 0 || numeric > 10_000_000) {
      throw new ValueError('Verified EUR amount must be greater than 0.00');
    }
  }

  public async createOrder(
    receiptHash: string,
    verifiedAmountEur: string,
    env: Record<string, string | undefined> = process.env,
    idempotencyKey?: string
  ): Promise<PayPalSandboxOrder> {
    validateSandboxBaseUrl(env.PAYPAL_API_BASE);
    this.validateReceiptHash(receiptHash);
    this.validateVerifiedAmount(verifiedAmountEur);

    const requestId =
      idempotencyKey || `syntra-ord-${sha256Hex(`order:${receiptHash}`).slice(0, 32)}`;

    if (hasLiveSandboxCredentials(env)) {
      const raw = await requestLivePayPalSandbox(
        'POST',
        '/v2/checkout/orders',
        env,
        {
          intent: 'CAPTURE',
          purchase_units: [
            {
              amount: { currency_code: 'EUR', value: verifiedAmountEur },
              custom_id: receiptHash,
              description: `SyntraVariga verified invoice sandbox order (${verifiedAmountEur} EUR)`,
            },
          ],
          application_context: {
            user_action: 'PAY_NOW',
            shipping_preference: 'NO_SHIPPING',
          },
        },
        requestId
      );

      if (typeof raw.id !== 'string' || !ORDER_ID_RE.test(raw.id)) {
        throw new PayPalSandboxError('PayPal create order response is missing a valid id');
      }

      // If PayPal Create Order response includes purchase_units, validate strictly; otherwise fetch via GET to verify!
      const orderPayload = Array.isArray(raw.purchase_units)
        ? raw
        : await requestLivePayPalSandbox('GET', `/v2/checkout/orders/${raw.id}`, env);

      const verified = verifyStrictPayPalOrderPayload(orderPayload, {
        expectedOrderId: raw.id,
        expectedStatus: 'CREATED',
        expectedReceiptHash: receiptHash,
        expectedAmountEur: verifiedAmountEur,
      });

      const approveUrl = extractPayPalApproveUrl(verified.orderId, verified.links);
      return {
        id: verified.orderId,
        status: 'CREATED',
        intent: 'CAPTURE',
        execution_mode: 'LIVE_PAYPAL_SANDBOX_REST',
        approve_url: approveUrl,
        links: verified.links,
        create_time: new Date().toISOString(),
        purchase_units: [verified.unit],
      };
    }

    // Protocol simulation mode
    this.orderCounter += 1;
    const hashSuffix = sha256Hex(`${receiptHash}:${verifiedAmountEur}:${this.orderCounter}`)
      .substring(0, 12)
      .toUpperCase();
    const orderId = `SB-ORD-${hashSuffix}`;
    const approveUrl = extractPayPalApproveUrl(orderId, [
      {
        href: `https://www.sandbox.paypal.com/checkoutnow?token=${orderId}`,
        rel: 'approve',
        method: 'GET',
      },
    ]);

    const order: PayPalSandboxOrder = {
      id: orderId,
      status: 'CREATED',
      intent: 'CAPTURE',
      execution_mode: 'SANDBOX_PROTOCOL_SIMULATION',
      approve_url: approveUrl,
      links: [{ href: approveUrl, rel: 'approve', method: 'GET' }],
      create_time: new Date().toISOString(),
      purchase_units: [
        {
          amount: { currency_code: 'EUR', value: verifiedAmountEur },
          custom_id: receiptHash,
          description: `SyntraVariga verified invoice sandbox order (${verifiedAmountEur} EUR)`,
        },
      ],
    };

    this.simulatedOrders.set(orderId, order);
    return structuredClone(order);
  }

  public async verifyOrSimulateBuyerApproval(
    orderId: string,
    receiptHash: string,
    expectedVerifiedAmountEur: string,
    env: Record<string, string | undefined> = process.env
  ): Promise<PayPalSandboxOrder> {
    validateSandboxBaseUrl(env.PAYPAL_API_BASE);
    this.validateOrderId(orderId);
    this.validateReceiptHash(receiptHash);
    this.validateVerifiedAmount(expectedVerifiedAmountEur);

    if (hasLiveSandboxCredentials(env) && !this.simulatedOrders.has(orderId)) {
      const liveOrder = await requestLivePayPalSandbox(
        'GET',
        `/v2/checkout/orders/${orderId}`,
        env
      );
      const verified = verifyStrictPayPalOrderPayload(liveOrder, {
        expectedOrderId: orderId,
        expectedStatus: 'APPROVED',
        expectedReceiptHash: receiptHash,
        expectedAmountEur: expectedVerifiedAmountEur,
      });
      const approveUrl = extractPayPalApproveUrl(orderId, verified.links);
      const payerObj = liveOrder.payer as
        | { email_address?: string; payer_id?: string }
        | undefined;

      return {
        id: verified.orderId,
        status: 'APPROVED',
        intent: 'CAPTURE',
        execution_mode: 'LIVE_PAYPAL_SANDBOX_REST',
        approve_url: approveUrl,
        links: verified.links,
        create_time: new Date().toISOString(),
        approve_time: new Date().toISOString(),
        payer:
          payerObj && typeof payerObj.payer_id === 'string'
            ? {
                email_address: String(payerObj.email_address || ''),
                payer_id: payerObj.payer_id,
              }
            : undefined,
        purchase_units: [verified.unit],
      };
    }

    return this.approveSimulatedOrder(orderId, receiptHash, expectedVerifiedAmountEur);
  }

  public approveSimulatedOrder(
    orderId: string,
    receiptHash: string,
    expectedVerifiedAmountEur: string
  ): PayPalSandboxOrder {
    this.validateOrderId(orderId);
    this.validateReceiptHash(receiptHash);
    this.validateVerifiedAmount(expectedVerifiedAmountEur);
    const order = this.simulatedOrders.get(orderId);
    if (!order) {
      throw new PayPalSandboxError('Sandbox order not found');
    }
    const verified = verifyStrictPayPalOrderPayload(
      order as unknown as Record<string, unknown>,
      {
        expectedOrderId: orderId,
        expectedStatus: 'CREATED',
        expectedReceiptHash: receiptHash,
        expectedAmountEur: expectedVerifiedAmountEur,
      }
    );
    order.status = 'APPROVED';
    order.approve_time = new Date().toISOString();
    order.payer = {
      email_address: 'sb-buyer-audit@personal.example.com',
      payer_id: 'SBPAYER' + sha256Hex(orderId).substring(0, 8).toUpperCase(),
    };
    order.purchase_units = [verified.unit];
    return structuredClone(order);
  }

  public async captureOrder(
    orderId: string,
    receiptHash: string,
    expectedVerifiedAmountEur: string,
    env: Record<string, string | undefined> = process.env,
    idempotencyKey?: string
  ): Promise<PayPalSandboxOrder> {
    validateSandboxBaseUrl(env.PAYPAL_API_BASE);
    this.validateOrderId(orderId);
    this.validateReceiptHash(receiptHash);
    this.validateVerifiedAmount(expectedVerifiedAmountEur);

    const requestId =
      idempotencyKey ||
      `syntra-cap-${sha256Hex(`capture:${receiptHash}:${orderId}`).slice(0, 32)}`;

    if (hasLiveSandboxCredentials(env) && !this.simulatedOrders.has(orderId)) {
      const preCheck = await requestLivePayPalSandbox(
        'GET',
        `/v2/checkout/orders/${orderId}`,
        env
      );
      verifyStrictPayPalOrderPayload(preCheck, {
        expectedOrderId: orderId,
        expectedStatus: 'APPROVED',
        expectedReceiptHash: receiptHash,
        expectedAmountEur: expectedVerifiedAmountEur,
      });

      const rawCapture = await requestLivePayPalSandbox(
        'POST',
        `/v2/checkout/orders/${orderId}/capture`,
        env,
        {},
        requestId
      );

      // If capture response omits custom_id in purchase_units[0], verify against the preCheck custom_id only if preCheck already matched receiptHash
      const captureUnits = Array.isArray(rawCapture.purchase_units)
        ? (rawCapture.purchase_units as Array<Record<string, unknown>>)
        : [];
      if (captureUnits.length === 1 && captureUnits[0] && captureUnits[0].custom_id === undefined) {
        throw new PayPalSandboxError(
          'Capture response purchase_unit[0].custom_id is missing; refusing to substitute expected value'
        );
      }

      const verifiedCapture = verifyStrictPayPalCapturePayload(rawCapture, {
        expectedOrderId: orderId,
        expectedReceiptHash: receiptHash,
        expectedAmountEur: expectedVerifiedAmountEur,
      });

      return {
        id: verifiedCapture.orderId,
        status: 'COMPLETED',
        intent: 'CAPTURE',
        execution_mode: 'LIVE_PAYPAL_SANDBOX_REST',
        approve_url: extractPayPalApproveUrl(orderId, verifiedCapture.links),
        links: verifiedCapture.links,
        create_time: new Date().toISOString(),
        capture_time: new Date().toISOString(),
        purchase_units: [verifiedCapture.unit],
      };
    }

    const order = this.simulatedOrders.get(orderId);
    if (!order) {
      throw new PayPalSandboxError('Order is not approved or receipt does not match');
    }
    verifyStrictPayPalOrderPayload(order as unknown as Record<string, unknown>, {
      expectedOrderId: orderId,
      expectedStatus: 'APPROVED',
      expectedReceiptHash: receiptHash,
      expectedAmountEur: expectedVerifiedAmountEur,
    });

    const captureTime = new Date().toISOString();
    const captureId =
      'SB-CAP-' + sha256Hex(`${orderId}:${receiptHash}`).substring(0, 12).toUpperCase();

    const rawSimulatedCaptureResponse = {
      id: orderId,
      status: 'COMPLETED',
      purchase_units: [
        {
          custom_id: receiptHash,
          amount: { currency_code: 'EUR', value: expectedVerifiedAmountEur },
          payments: {
            captures: [
              {
                id: captureId,
                status: 'COMPLETED',
                amount: { currency_code: 'EUR', value: expectedVerifiedAmountEur },
                create_time: captureTime,
              },
            ],
          },
        },
      ],
    };

    const verifiedSim = verifyStrictPayPalCapturePayload(rawSimulatedCaptureResponse, {
      expectedOrderId: orderId,
      expectedReceiptHash: receiptHash,
      expectedAmountEur: expectedVerifiedAmountEur,
    });

    order.status = 'COMPLETED';
    order.capture_time = captureTime;
    order.purchase_units = [verifiedSim.unit];
    return structuredClone(order);
  }
}
