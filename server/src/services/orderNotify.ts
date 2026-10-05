import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { orders, vendors, orderItems } from '../db/schema.js';
import { notify } from './notification.service.js';

/**
 * Tells the vendor about a new order. COD orders call this right after placing;
 * online orders call it only once the payment is confirmed, so a vendor never
 * starts cooking something that was never paid for.
 */
export async function notifyVendorOfNewOrder(orderId: string): Promise<void> {
  const [order] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
  if (!order) return;
  const [vendor] = await db.select().from(vendors).where(eq(vendors.id, order.vendorId)).limit(1);
  if (!vendor) return;
  const items = await db.select({ q: orderItems.quantity }).from(orderItems).where(eq(orderItems.orderId, orderId));
  const count = items.reduce((n, i) => n + i.q, 0);
  await notify({
    userId: vendor.ownerUserId, type: 'NEW_ORDER',
    title: 'New order received',
    body: `Order ${order.code} — ${count} item(s).`,
    data: { orderId: order.id },
  });
}
