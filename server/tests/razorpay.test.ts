import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { verifyCheckoutSignature, verifyWebhookSignature } from '../src/adapters/payments/razorpay.js';

const hmac = (secret: string, data: string | Buffer) => crypto.createHmac('sha256', secret).update(data).digest('hex');

describe('Razorpay checkout signature', () => {
  const secret = 'key_secret_123';
  const input = { orderId: 'order_ABC123', paymentId: 'pay_XYZ789' };

  it('accepts a correct signature', () => {
    expect(verifyCheckoutSignature({ ...input, signature: hmac(secret, 'order_ABC123|pay_XYZ789') }, secret)).toBe(true);
  });
  it('rejects a signature made with another secret', () => {
    expect(verifyCheckoutSignature({ ...input, signature: hmac('other', 'order_ABC123|pay_XYZ789') }, secret)).toBe(false);
  });
  it('rejects a signature for a different payment id', () => {
    expect(verifyCheckoutSignature({ ...input, signature: hmac(secret, 'order_ABC123|pay_OTHER') }, secret)).toBe(false);
  });
  it('rejects empty / malformed signatures without throwing', () => {
    expect(verifyCheckoutSignature({ ...input, signature: '' }, secret)).toBe(false);
    expect(verifyCheckoutSignature({ ...input, signature: 'abc' }, secret)).toBe(false);
  });
});

describe('Razorpay webhook signature', () => {
  const secret = 'whsec_test';
  const body = Buffer.from(JSON.stringify({ event: 'payment.captured', payload: {} }));

  it('accepts a signature over the exact raw bytes', () => {
    expect(verifyWebhookSignature(body, hmac(secret, body), secret)).toBe(true);
  });
  it('rejects when the body was altered after signing', () => {
    const tampered = Buffer.from(body.toString().replace('captured', 'failed'));
    expect(verifyWebhookSignature(tampered, hmac(secret, body), secret)).toBe(false);
  });
  it('rejects a missing signature or missing secret', () => {
    expect(verifyWebhookSignature(body, '', secret)).toBe(false);
    expect(verifyWebhookSignature(body, hmac(secret, body), '')).toBe(false);
  });
});
