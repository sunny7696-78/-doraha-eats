/**
 * Razorpay provider — plain REST (no SDK), so there is nothing extra to install
 * and every request is easy to audit. Amounts are always integer paise.
 *
 * Security notes:
 *  - The key secret never leaves the server; only the public key id is sent to the app.
 *  - Signatures are checked with HMAC-SHA256 and a constant-time comparison.
 */
import crypto from 'node:crypto';
import { env } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';
import type { PaymentProvider } from './index.js';

const API = 'https://api.razorpay.com/v1';

/* ------------------------------------------------------- pure crypto helpers */

const safeEqualHex = (a: string, b: string): boolean => {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
};

/** Checkout callback signature: HMAC_SHA256(orderId + "|" + paymentId, keySecret). */
export function verifyCheckoutSignature(
  input: { orderId: string; paymentId: string; signature: string },
  keySecret: string,
): boolean {
  if (!input.orderId || !input.paymentId || !input.signature) return false;
  const expected = crypto.createHmac('sha256', keySecret)
    .update(`${input.orderId}|${input.paymentId}`).digest('hex');
  return safeEqualHex(expected, input.signature);
}

/** Webhook signature: HMAC_SHA256(RAW request body, webhookSecret). */
export function verifyWebhookSignature(rawBody: Buffer | string, signature: string, webhookSecret: string): boolean {
  if (!signature || !webhookSecret) return false;
  const expected = crypto.createHmac('sha256', webhookSecret).update(rawBody).digest('hex');
  return safeEqualHex(expected, signature);
}

/* --------------------------------------------------------------- REST client */

type RzpError = { error?: { code?: string; description?: string } };

function creds() {
  if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET) {
    throw new AppError(500, 'PAYMENT_NOT_CONFIGURED', 'Online payments are not available right now.');
  }
  return { id: env.RAZORPAY_KEY_ID, secret: env.RAZORPAY_KEY_SECRET };
}

async function rzp<T>(
  method: 'GET' | 'POST', path: string, body?: unknown, extraHeaders: Record<string, string> = {},
): Promise<T> {
  const { id, secret } = creds();
  let res: Response;
  try {
    res = await fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`,
        'Content-Type': 'application/json',
        ...extraHeaders,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new AppError(502, 'PAYMENT_PROVIDER_ERROR', 'Could not reach the payment provider. Please try again.');
  }
  const json = (await res.json().catch(() => ({}))) as T & RzpError;
  if (!res.ok) {
    console.error('[razorpay] API error', { path, status: res.status, code: json.error?.code });
    throw new AppError(502, 'PAYMENT_PROVIDER_ERROR', 'The payment provider rejected the request. Please try again.');
  }
  return json;
}

export type RzpOrder = { id: string; amount: number; currency: string; status: 'created' | 'attempted' | 'paid'; receipt?: string };
export type RzpPayment = {
  id: string; order_id: string; amount: number; currency: string;
  status: 'created' | 'authorized' | 'captured' | 'refunded' | 'failed';
  error_description?: string | null;
};
export type RzpRefund = { id: string; payment_id: string; amount: number; status: 'pending' | 'processed' | 'failed' };

export const razorpayApi = {
  createOrder: (input: { amountPaise: number; receipt: string; notes?: Record<string, string> }) =>
    rzp<RzpOrder>('POST', '/orders', {
      amount: input.amountPaise, currency: 'INR', receipt: input.receipt, notes: input.notes ?? {},
    }),
  fetchOrder: (orderId: string) => rzp<RzpOrder>('GET', `/orders/${encodeURIComponent(orderId)}`),
  fetchOrderPayments: (orderId: string) =>
    rzp<{ items: RzpPayment[] }>('GET', `/orders/${encodeURIComponent(orderId)}/payments`),
  fetchPayment: (paymentId: string) => rzp<RzpPayment>('GET', `/payments/${encodeURIComponent(paymentId)}`),
  capturePayment: (paymentId: string, amountPaise: number) =>
    rzp<RzpPayment>('POST', `/payments/${encodeURIComponent(paymentId)}/capture`, { amount: amountPaise, currency: 'INR' }),
  refundPayment: (paymentId: string, amountPaise: number, idempotencyKey: string, notes: Record<string, string>) =>
    rzp<RzpRefund>('POST', `/payments/${encodeURIComponent(paymentId)}/refund`,
      { amount: amountPaise, speed: 'normal', notes },
      { 'X-Refund-Idempotency': idempotencyKey }),
};

/* ----------------------------------------------------------------- provider */

export const razorpayProvider: PaymentProvider = {
  name: 'razorpay',

  async createIntent({ orderCode, amountPaise }) {
    const order = await razorpayApi.createOrder({
      amountPaise, receipt: orderCode, notes: { orderCode },
    });
    return {
      provider: 'razorpay',
      reference: order.id,
      providerOrderId: order.id,
      amountPaise,
      checkout: {
        keyId: creds().id,
        razorpayOrderId: order.id,
        amountPaise,
        currency: 'INR',
        name: 'Doraha Eats',
        description: `Order ${orderCode}`,
      },
      instructions: 'Complete the payment in the secure Razorpay window.',
    };
  },

  /** Not used for Razorpay — confirmation goes through verifyCheckout + the webhook. */
  async verify() { return { paid: false }; },

  async refund({ providerPaymentId, amountPaise, idempotencyKey, orderCode }) {
    if (!providerPaymentId) return { refunded: false, status: 'FAILED' };
    const r = await razorpayApi.refundPayment(
      providerPaymentId, amountPaise, idempotencyKey ?? `refund_${providerPaymentId}`,
      { orderCode: orderCode ?? '' },
    );
    return {
      refunded: r.status === 'processed',
      refundId: r.id,
      status: r.status === 'processed' ? 'PROCESSED' : r.status === 'failed' ? 'FAILED' : 'PENDING',
    };
  },
};
