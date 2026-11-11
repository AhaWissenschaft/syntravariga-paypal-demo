import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  PayPalSandboxManager,
  PayPalSandboxError,
  ValueError,
  validateSandboxBaseUrl,
  extractPayPalApproveUrl,
} from './paypalSandbox';

const VALID_RECEIPT_HASH = 'b'.repeat(64);
const OTHER_RECEIPT_HASH = 'c'.repeat(64);

describe('PayPal Sandbox Protocol & State Machine', () => {
  it('enforces strict https://api-m.sandbox.paypal.com host restriction', () => {
    assert.equal(
      validateSandboxBaseUrl('https://api-m.sandbox.paypal.com/'),
      'https://api-m.sandbox.paypal.com'
    );
    assert.throws(
      () => validateSandboxBaseUrl('https://api-m.paypal.com'),
      PayPalSandboxError
    );
    assert.throws(
      () => validateSandboxBaseUrl('http://api-m.sandbox.paypal.com'),
      PayPalSandboxError
    );
  });

  it('extracts official approve_url from PayPal HATEOAS links array', () => {
    const url = extractPayPalApproveUrl('5O190127TN364715T', [
      { href: 'https://api-m.sandbox.paypal.com/v2/checkout/orders/5O190127TN364715T', rel: 'self' },
      { href: 'https://www.sandbox.paypal.com/checkoutnow?token=5O190127TN364715T', rel: 'approve' },
    ]);
    assert.equal(url, 'https://www.sandbox.paypal.com/checkoutnow?token=5O190127TN364715T');
  });

  it('rejects malformed receipt_hash, order_id, or verified_amount_eur', async () => {
    const manager = new PayPalSandboxManager();
    await assert.rejects(
      async () => manager.createOrder('not-a-valid-sha256', '119.00', {}),
      ValueError
    );
    await assert.rejects(
      async () => manager.createOrder(VALID_RECEIPT_HASH, '0.00', {}),
      ValueError
    );
    await assert.rejects(
      async () => manager.captureOrder('bad id!', VALID_RECEIPT_HASH, '119.00', {}),
      ValueError
    );
  });

  it('enforces CREATED -> APPROVED -> COMPLETED lifecycle and binds order to verified invoice amount and receipt', async () => {
    const manager = new PayPalSandboxManager();

    // Step 1: Create Order for confirmed 119.00 EUR invoice
    const created = await manager.createOrder(VALID_RECEIPT_HASH, '119.00', {});
    assert.equal(created.status, 'CREATED');
    assert.ok(created.approve_url.includes('sandbox.paypal.com/checkoutnow?token='));
    assert.equal(created.purchase_units[0].custom_id, VALID_RECEIPT_HASH);
    assert.equal(created.purchase_units[0].amount.value, '119.00');

    // Attempting capture before approval MUST fail closed
    await assert.rejects(
      async () => manager.captureOrder(created.id, VALID_RECEIPT_HASH, '119.00', {}),
      PayPalSandboxError
    );

    // Step 2: Approve Order via verifyOrSimulateBuyerApproval
    const approved = await manager.verifyOrSimulateBuyerApproval(
      created.id,
      VALID_RECEIPT_HASH,
      '119.00',
      {}
    );
    assert.equal(approved.status, 'APPROVED');

    // Attempting capture with a different receipt hash MUST fail closed
    await assert.rejects(
      async () => manager.captureOrder(created.id, OTHER_RECEIPT_HASH, '119.00', {}),
      PayPalSandboxError
    );

    // Attempting capture with a tampered amount (e.g. 149.00 instead of 119.00) MUST fail closed
    await assert.rejects(
      async () => manager.captureOrder(created.id, VALID_RECEIPT_HASH, '149.00', {}),
      PayPalSandboxError
    );

    // Step 3: Capture Order with matching receipt hash and verified amount
    const completed = await manager.captureOrder(created.id, VALID_RECEIPT_HASH, '119.00', {});
    assert.equal(completed.status, 'COMPLETED');
    assert.equal(completed.purchase_units[0].payments?.captures?.[0]?.amount.value, '119.00');
  });
});
