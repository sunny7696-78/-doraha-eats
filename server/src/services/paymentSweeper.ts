import { and, eq, inArray, lt } from 'drizzle-orm';
import { db } from '../db/index.js';
import { orders, payments } from '../db/schema.js';
import { env } from '../config/env.js';
import { changeStatus } from './order.service.js';
import { reconcilePayment } from './payment.service.js';

/**
 * Cancels online orders whose payment never completed within PAYMENT_WINDOW_MINUTES,
 * so abandoned checkouts do not linger. Before cancelling it asks Razorpay directly
 * whether the money actually arrived (a webhook may have been missed).
 */
export async function expireUnpaidOnlineOrders(): Promise<number> {
  const cutoff = new Date(Date.now() - env.PAYMENT_WINDOW_MINUTES * 60_000);
  const stale = await db.select({ orderId: orders.id, paymentId: payments.id })
    .from(orders).innerJoin(payments, eq(payments.orderId, orders.id))
    .where(and(
      eq(orders.status, 'PLACED'), eq(payments.provider, 'razorpay'),
      inArray(payments.status, ['PENDING', 'AWAITING_VERIFICATION', 'FAILED']),
      lt(orders.placedAt, cutoff),
    )).limit(50);

  let cancelled = 0;
  for (const row of stale) {
    try {
      if (await reconcilePayment(row.paymentId)) continue; // actually paid — leave it alone
      await changeStatus({
        orderId: row.orderId, to: 'CANCELLED', actor: 'SYSTEM', note: 'Payment not completed in time',
      });
      cancelled++;
    } catch (e) {
      console.error(JSON.stringify({ at: 'sweeper', orderId: row.orderId, err: String((e as Error)?.message ?? e) }));
    }
  }
  return cancelled;
}

export function startPaymentSweeper() {
  if (env.PAYMENT_PROVIDER !== 'razorpay') return;
  const timer = setInterval(() => { void expireUnpaidOnlineOrders(); }, 5 * 60_000);
  timer.unref();
}
