import { env } from '../../config/env.js';
import { razorpayProvider } from './razorpay.js';

export type PaymentIntent = {
  provider: string;
  reference: string;
  /** Razorpay order id (online payments only). */
  providerOrderId?: string;
  /** Exactly what the mobile app needs to open the Razorpay checkout. No secrets. */
  checkout?: {
    keyId: string; razorpayOrderId: string; amountPaise: number; currency: string;
    name: string; description: string;
  };
  amountPaise: number;
  /** For UPI: a deep link the mobile app can open. */
  upiUri?: string;
  qrPayload?: string;
  instructions: string;
};

export interface PaymentProvider {
  readonly name: string;
  createIntent(input: { orderCode: string; amountPaise: number }): Promise<PaymentIntent>;
  verify(input: { reference: string; upiRef?: string }): Promise<{ paid: boolean; providerRef?: string }>;
  refund(input: {
    reference: string; amountPaise: number;
    providerPaymentId?: string; idempotencyKey?: string; orderCode?: string;
  }): Promise<{ refunded: boolean; refundId?: string; status?: 'PROCESSED' | 'PENDING' | 'FAILED' }>;
}

/** Cash on delivery — settled by the rider, nothing external to call. */
export const codProvider: PaymentProvider = {
  name: 'cod',
  async createIntent({ orderCode, amountPaise }) {
    return {
      provider: 'cod', reference: `COD-${orderCode}`, amountPaise,
      instructions: 'Pay the delivery partner in cash when your order arrives.',
    };
  },
  async verify() { return { paid: false }; },
  async refund() { return { refunded: true }; },
};

/**
 * Mock UPI provider. Builds a real UPI deep link (works with any UPI app) and
 * accepts a UTR typed by the customer, which an admin then verifies.
 * Swap for RazorpayProvider later — nothing outside this folder changes.
 */
export const mockUpiProvider: PaymentProvider = {
  name: 'upi_mock',
  async createIntent({ orderCode, amountPaise }) {
    const amount = (amountPaise / 100).toFixed(2);
    const upiUri =
      `upi://pay?pa=${encodeURIComponent(env.UPI_VPA)}&pn=${encodeURIComponent('Doraha Eats')}` +
      `&am=${amount}&cu=INR&tn=${encodeURIComponent(orderCode)}`;
    return {
      provider: 'upi_mock', reference: `UPI-${orderCode}`, amountPaise, upiUri,
      qrPayload: upiUri,
      instructions: 'Pay using any UPI app, then enter the 12-digit UTR to confirm.',
    };
  },
  /** Dev rule: any 12-character UTR is treated as valid. Replace with gateway webhook. */
  async verify({ reference, upiRef }) {
    const paid = !!upiRef && upiRef.trim().length >= 6;
    return { paid, providerRef: paid ? `${reference}-VERIFIED` : undefined };
  },
  async refund() { return { refunded: true }; },
};

/**
 * Picks the provider for an order. Production NEVER falls back to the mock:
 * env.ts refuses to boot unless PAYMENT_PROVIDER=razorpay with all keys set,
 * and this function throws instead of returning the mock if that is violated.
 */
export function getPaymentProvider(method: 'COD' | 'UPI'): PaymentProvider {
  if (method === 'COD') return codProvider;
  if (env.PAYMENT_PROVIDER === 'razorpay') {
    if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET) {
      throw new Error('PAYMENT_PROVIDER=razorpay but RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET are missing.');
    }
    return razorpayProvider;
  }
  if (env.NODE_ENV === 'production') {
    throw new Error('Mock payments are not allowed in production.');
  }
  return mockUpiProvider;
}
