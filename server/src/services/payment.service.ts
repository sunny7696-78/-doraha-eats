/**
 * Online-payment lifecycle (Razorpay). One rule runs through everything here:
 * an order is only PAID because Razorpay says so — via a verified checkout
 * signature + a server-side fetch of the payment, or via a signed webhook.
 * The mobile app's word is never enough.
 */
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { orders, payments, paymentEvents } from '../db/schema.js';
import { env } from '../config/env.js';
import { Errors } from '../lib/errors.js';
import { getPaymentProvider } from '../adapters/payments/index.js';
import { razorpayApi, verifyCheckoutSignature, type RzpPayment } from '../adapters/payments/razorpay.js';
import { clearCart } from './cart.service.js';
import { notify } from './notification.service.js';
import { notifyVendorOfNewOrder } from './orderNotify.js';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type PaymentRow = typeof payments.$inferSelect;

const UNPAID: PaymentRow['status'][] = ['PENDING', 'AWAITING_VERIFICATION', 'FAILED'];

export type Checkout = {
  keyId: string; razorpayOrderId: string; amountPaise: number; currency: string;
  name: string; description: string;
};

const log = (msg: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ at: 'payment', msg, ...extra }));

/* ------------------------------------------------------------- mark paid */

/**
 * Idempotent: only the call that actually flips the row to PAID returns
 * newlyPaid=true, so two webhooks / a webhook + a client callback cannot
 * double-process. Side effects (vendor notify, cart, refund) are returned as
 * afterCommit work so they never run inside — or roll back — the DB transaction.
 */
export async function markPaidTx(tx: Tx, input: {
  paymentRowId: string; providerPaymentId?: string | null; verifiedById?: string | null;
}): Promise<{ newlyPaid: boolean; orderId: string | null }> {
  const now = new Date();
  const [p] = await tx.update(payments).set({
    status: 'PAID',
    providerPaymentId: input.providerPaymentId ?? undefined,
    capturedAt: now, verifiedAt: now, verifiedById: input.verifiedById ?? undefined,
    failureReason: null, updatedAt: now,
  }).where(and(eq(payments.id, input.paymentRowId), inArray(payments.status, UNPAID))).returning();
  if (!p) return { newlyPaid: false, orderId: null };
  await tx.update(orders).set({ paymentStatus: 'PAID', updatedAt: now }).where(eq(orders.id, p.orderId));
  return { newlyPaid: true, orderId: p.orderId };
}

/** Work to do once a payment has newly become PAID (after the transaction commits). */
export async function afterPaid(orderId: string): Promise<void> {
  const [order] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
  if (!order) return;
  if (order.status === 'CANCELLED') {
    // Money arrived for an order that can no longer be fulfilled — give it back.
    log('paid-after-cancel, refunding', { orderId });
    await refundOrderPayment(orderId, 'Order was cancelled before payment completed');
    return;
  }
  await clearCart(order.customerId).catch((e) => log('clearCart failed', { orderId, err: String(e?.message ?? e) }));
  await notifyVendorOfNewOrder(orderId).catch((e) => log('vendor notify failed', { orderId, err: String(e?.message ?? e) }));
  await notify({
    userId: order.customerId, type: 'PAYMENT_PAID', title: 'Payment received',
    body: `We received your payment for order ${order.code}.`, data: { orderId },
  }).catch(() => undefined);
}

/** Convenience wrapper for callers that are not already inside a transaction. */
export async function markPaid(input: {
  paymentRowId: string; providerPaymentId?: string | null; verifiedById?: string | null;
}) {
  const r = await db.transaction((tx) => markPaidTx(tx, input));
  if (r.newlyPaid && r.orderId) await afterPaid(r.orderId);
  return r;
}

export async function markFailed(paymentRowId: string, reason: string) {
  const [p] = await db.update(payments).set({
    status: 'FAILED', failureReason: reason.slice(0, 300), updatedAt: new Date(),
  }).where(and(eq(payments.id, paymentRowId), inArray(payments.status, ['PENDING', 'AWAITING_VERIFICATION']))).returning();
  if (!p) return;
  // A FAILED online payment can be retried; the order itself stays PLACED and unpaid.
  await db.update(orders).set({ paymentStatus: 'FAILED', updatedAt: new Date() })
    .where(and(eq(orders.id, p.orderId), inArray(orders.paymentStatus, ['PENDING', 'AWAITING_VERIFICATION'])));
}

/* ---------------------------------------------------------- checkout info */

export const buildCheckout = (p: PaymentRow, orderCode: string): Checkout => ({
  keyId: env.RAZORPAY_KEY_ID!, razorpayOrderId: p.providerOrderId!, amountPaise: p.amountPaise,
  currency: p.currency, name: 'Doraha Eats', description: `Order ${orderCode}`,
});

/**
 * Called by the app to (re)open the Razorpay window for an unpaid order. Re-uses the
 * SAME Razorpay order, so a retry can never charge the customer twice.
 */
export async function getCheckoutForRetry(userId: string, orderId: string) {
  const [row] = await db.select({ o: orders, p: payments })
    .from(orders).innerJoin(payments, eq(payments.orderId, orders.id))
    .where(eq(orders.id, orderId)).limit(1);
  if (!row || row.o.customerId !== userId) throw Errors.notFound('Order');
  const { o: order, p: payment } = row;
  if (payment.provider !== 'razorpay') throw Errors.badRequest('This order is not an online-payment order.');
  if (payment.status === 'PAID' || payment.status === 'REFUNDED') throw Errors.paymentAlreadyCompleted();
  if (order.status !== 'PLACED') {
    throw Errors.conflict('This order can no longer be paid for.', 'ORDER_NOT_PAYABLE');
  }

  if (!payment.providerOrderId) {
    const intent = await getPaymentProvider('UPI').createIntent({ orderCode: order.code, amountPaise: payment.amountPaise });
    const [updated] = await db.update(payments).set({
      providerOrderId: intent.providerOrderId, providerRef: intent.reference,
      status: 'AWAITING_VERIFICATION', updatedAt: new Date(),
    }).where(and(eq(payments.id, payment.id), isNull(payments.providerOrderId))).returning();
    if (updated) return buildCheckout(updated, order.code);
    return getCheckoutForRetry(userId, orderId); // someone else created it first
  }

  // If Razorpay already has a captured payment for this order, settle it instead of charging again.
  const rzpOrder = await razorpayApi.fetchOrder(payment.providerOrderId);
  if (rzpOrder.status === 'paid') {
    await reconcilePayment(payment.id);
    throw Errors.paymentAlreadyCompleted();
  }
  if (payment.status === 'FAILED' || payment.status === 'PENDING') {
    await db.update(payments).set({ status: 'AWAITING_VERIFICATION', updatedAt: new Date() })
      .where(eq(payments.id, payment.id));
    await db.update(orders).set({ paymentStatus: 'AWAITING_VERIFICATION', updatedAt: new Date() })
      .where(eq(orders.id, order.id));
  }
  return buildCheckout(payment, order.code);
}

/* ----------------------------------------------- client-callback verification */

function assertPaymentMatches(rzp: RzpPayment, p: PaymentRow) {
  if (rzp.order_id !== p.providerOrderId) throw Errors.invalidPayment();
  if (rzp.amount !== p.amountPaise || rzp.currency !== p.currency) {
    log('amount mismatch', { paymentId: p.id, expected: p.amountPaise, got: rzp.amount });
    throw Errors.invalidPayment('The paid amount does not match this order.');
  }
}

/** Settles a payment from a Razorpay payment object. Returns true when it is now PAID. */
async function settleFromRazorpay(p: PaymentRow, rzp: RzpPayment): Promise<boolean> {
  assertPaymentMatches(rzp, p);
  if (rzp.status === 'authorized') {
    // Account is not on auto-capture: capture exactly the server-side amount.
    rzp = await razorpayApi.capturePayment(rzp.id, p.amountPaise);
  }
  if (rzp.status === 'captured') {
    await markPaid({ paymentRowId: p.id, providerPaymentId: rzp.id });
    return true;
  }
  if (rzp.status === 'failed') await markFailed(p.id, rzp.error_description ?? 'Payment failed');
  return false;
}

/**
 * Checkout callback from the app. The signature proves Razorpay's checkout issued
 * this payment id for this order id; we then FETCH the payment from Razorpay and
 * compare order, amount and currency ourselves before trusting anything.
 */
export async function verifyCheckout(userId: string, orderId: string, input: {
  razorpayOrderId: string; razorpayPaymentId: string; razorpaySignature: string;
}) {
  const [row] = await db.select({ o: orders, p: payments })
    .from(orders).innerJoin(payments, eq(payments.orderId, orders.id))
    .where(eq(orders.id, orderId)).limit(1);
  if (!row || row.o.customerId !== userId) throw Errors.notFound('Order');
  const { p: payment } = row;
  if (payment.provider !== 'razorpay') throw Errors.badRequest('This order is not an online-payment order.');
  if (payment.status === 'PAID' || payment.status === 'REFUNDED') return { verified: true };

  if (!env.RAZORPAY_KEY_SECRET) throw Errors.invalidPayment();
  if (!payment.providerOrderId || input.razorpayOrderId !== payment.providerOrderId) throw Errors.invalidPayment();
  const sigOk = verifyCheckoutSignature({
    orderId: input.razorpayOrderId, paymentId: input.razorpayPaymentId, signature: input.razorpaySignature,
  }, env.RAZORPAY_KEY_SECRET);
  if (!sigOk) {
    log('bad checkout signature', { paymentId: payment.id });
    throw Errors.invalidPayment('Payment signature check failed.');
  }

  const rzp = await razorpayApi.fetchPayment(input.razorpayPaymentId);
  const verified = await settleFromRazorpay(payment, rzp);
  // Not captured yet is fine: the webhook will finish the job.
  return { verified };
}

/** Pulls the truth from Razorpay when a webhook may have been missed (used by the sweeper too). */
export async function reconcilePayment(paymentRowId: string): Promise<boolean> {
  const [p] = await db.select().from(payments).where(eq(payments.id, paymentRowId)).limit(1);
  if (!p || p.provider !== 'razorpay' || !p.providerOrderId) return false;
  if (p.status === 'PAID' || p.status === 'REFUNDED') return true;
  const { items } = await razorpayApi.fetchOrderPayments(p.providerOrderId);
  const good = items.find((i) => i.status === 'captured' || i.status === 'authorized');
  return good ? settleFromRazorpay(p, good) : false;
}

/* ----------------------------------------------------------------- refunds */

/**
 * Refunds a PAID online payment in full. Never assumes success: the row is claimed
 * first (so concurrent callers can't double-refund), the provider's reply is stored,
 * and the payment only becomes REFUNDED when Razorpay reports the refund PROCESSED
 * (immediately, or later via the refund.processed webhook).
 */
export async function refundOrderPayment(orderId: string, reason: string): Promise<'SKIPPED' | 'INITIATED' | 'FAILED'> {
  const [p] = await db.select().from(payments).where(eq(payments.orderId, orderId)).limit(1);
  if (!p || p.provider !== 'razorpay' || p.status !== 'PAID' || !p.providerPaymentId) return 'SKIPPED';

  const [claimed] = await db.update(payments).set({
    refundStatus: 'INITIATED', refundAmountPaise: p.amountPaise, updatedAt: new Date(),
  }).where(and(
    eq(payments.id, p.id), eq(payments.status, 'PAID'),
    or(
      isNull(payments.refundStatus),
      eq(payments.refundStatus, 'FAILED'),
      and(eq(payments.refundStatus, 'INITIATED'), sql`${payments.updatedAt} < now() - interval '5 minutes'`),
    ),
  )).returning();
  if (!claimed) return 'SKIPPED';

  const [order] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
  try {
    const r = await getPaymentProvider('UPI').refund({
      reference: p.providerRef ?? p.id, amountPaise: p.amountPaise,
      providerPaymentId: p.providerPaymentId, idempotencyKey: `refund_${p.id}`, orderCode: order?.code,
    });
    await db.transaction(async (tx) => {
      await tx.update(payments).set({
        refundId: r.refundId ?? null, refundStatus: r.status ?? 'PENDING',
        failureReason: reason.slice(0, 300), updatedAt: new Date(),
      }).where(eq(payments.id, p.id));
      if (r.status === 'PROCESSED') await finishRefundTx(tx, p.id, orderId);
    });
    log('refund requested', { paymentId: p.id, orderId, status: r.status });
    return r.status === 'FAILED' ? 'FAILED' : 'INITIATED';
  } catch (e) {
    await db.update(payments).set({ refundStatus: 'FAILED', updatedAt: new Date() }).where(eq(payments.id, p.id));
    log('refund request failed', { paymentId: p.id, orderId, err: String((e as Error)?.message ?? e) });
    return 'FAILED';
  }
}

async function finishRefundTx(tx: Tx, paymentRowId: string, orderId: string) {
  const now = new Date();
  await tx.update(payments).set({ status: 'REFUNDED', refundStatus: 'PROCESSED', refundedAt: now, updatedAt: now })
    .where(eq(payments.id, paymentRowId));
  await tx.update(orders).set({ paymentStatus: 'REFUNDED', updatedAt: now }).where(eq(orders.id, orderId));
}

/* ------------------------------------------------------------------ webhook */

type WebhookEvent = {
  event: string;
  payload?: {
    payment?: { entity?: RzpPayment };
    refund?: { entity?: { id: string; payment_id: string; amount: number; status: string } };
  };
};

/**
 * Processes one verified webhook delivery. The event row and all state changes
 * share one transaction: if anything throws, the event is NOT recorded, we answer
 * 5xx, and Razorpay retries. A repeat of an already-recorded event is a no-op.
 */
export async function processRazorpayWebhook(eventId: string, event: WebhookEvent) {
  const afterCommit: Array<() => Promise<unknown>> = [];

  const result = await db.transaction(async (tx) => {
    const inserted = await tx.insert(paymentEvents).values({
      provider: 'razorpay', eventId, type: event.event, payload: event as never,
    }).onConflictDoNothing().returning({ id: paymentEvents.id });
    if (!inserted.length) return { duplicate: true as const };
    const eventRowId = inserted[0].id;

    const setOutcome = (outcome: string, paymentId?: string) =>
      tx.update(paymentEvents).set({ outcome, paymentId: paymentId ?? null }).where(eq(paymentEvents.id, eventRowId));

    const rzpPay = event.payload?.payment?.entity;
    const rzpRefund = event.payload?.refund?.entity;

    // Locate our payment row.
    let p: PaymentRow | undefined;
    if (rzpRefund?.payment_id) {
      [p] = await tx.select().from(payments).where(eq(payments.providerPaymentId, rzpRefund.payment_id)).limit(1);
    }
    if (!p && rzpPay?.order_id) {
      [p] = await tx.select().from(payments).where(eq(payments.providerOrderId, rzpPay.order_id)).limit(1);
    }
    if (!p) { await setOutcome('UNKNOWN_PAYMENT'); return { duplicate: false as const }; }

    switch (event.event) {
      case 'payment.captured':
      case 'order.paid': {
        if (!rzpPay) { await setOutcome('IGNORED_NO_PAYMENT', p.id); break; }
        if (rzpPay.amount !== p.amountPaise || rzpPay.currency !== p.currency) {
          log('webhook amount mismatch', { paymentId: p.id, eventId });
          await setOutcome('AMOUNT_MISMATCH', p.id);
          break;
        }
        if (p.status === 'PAID' && p.providerPaymentId && p.providerPaymentId !== rzpPay.id) {
          log('DUPLICATE CAPTURE on one order — needs manual refund', { paymentId: p.id, extra: rzpPay.id });
          await setOutcome('DUPLICATE_CAPTURE', p.id);
          break;
        }
        const r = await markPaidTx(tx, { paymentRowId: p.id, providerPaymentId: rzpPay.id });
        await setOutcome(r.newlyPaid ? 'PAID' : 'ALREADY_PAID', p.id);
        if (r.newlyPaid && r.orderId) afterCommit.push(() => afterPaid(r.orderId!));
        break;
      }
      case 'payment.failed': {
        // Never downgrade a payment that has already succeeded.
        if (p.status === 'PAID' || p.status === 'REFUNDED') { await setOutcome('IGNORED_ALREADY_PAID', p.id); break; }
        await tx.update(payments).set({
          status: 'FAILED', failureReason: (rzpPay?.error_description ?? 'Payment failed').slice(0, 300), updatedAt: new Date(),
        }).where(and(eq(payments.id, p.id), inArray(payments.status, ['PENDING', 'AWAITING_VERIFICATION', 'FAILED'])));
        await tx.update(orders).set({ paymentStatus: 'FAILED', updatedAt: new Date() })
          .where(and(eq(orders.id, p.orderId), inArray(orders.paymentStatus, ['PENDING', 'AWAITING_VERIFICATION'])));
        await setOutcome('FAILED', p.id);
        break;
      }
      case 'refund.processed': {
        await tx.update(payments).set({ refundId: rzpRefund?.id ?? p.refundId }).where(eq(payments.id, p.id));
        await finishRefundTx(tx, p.id, p.orderId);
        await setOutcome('REFUNDED', p.id);
        break;
      }
      case 'refund.failed': {
        await tx.update(payments).set({ refundStatus: 'FAILED', updatedAt: new Date() }).where(eq(payments.id, p.id));
        await setOutcome('REFUND_FAILED', p.id);
        break;
      }
      default:
        await setOutcome('IGNORED_EVENT', p.id);
    }
    return { duplicate: false as const };
  });

  for (const job of afterCommit) {
    await job().catch((e) => log('post-webhook job failed', { eventId, err: String(e?.message ?? e) }));
  }
  return result;
}
