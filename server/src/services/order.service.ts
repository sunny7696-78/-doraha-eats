import { and, desc, eq, inArray, or, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  orders, orderItems, orderItemOptions, orderStatusEvents, payments, addresses,
  vendors, users, deliveryAssignments, deliveryPartners, reviews,
} from '../db/schema.js';
import { Errors } from '../lib/errors.js';
import { generateOrderCode } from '../lib/orderCode.js';
import { getPaymentProvider } from '../adapters/payments/index.js';
import { quoteCart, clearCart } from './cart.service.js';
import { notifyVendorOfNewOrder } from './orderNotify.js';
import { buildCheckout, refundOrderPayment } from './payment.service.js';
import { getSettings } from './settings.service.js';
import { notify, ORDER_NOTIFICATIONS } from './notification.service.js';
import {
  actorCanSet, canTransition, STATUS_LABEL, type Actor, type OrderStatus,
} from './orderStatus.js';

const isUniqueViolation = (e: unknown, constraint: string): boolean => {
  const err = e as { code?: string; constraint?: string; cause?: { code?: string; constraint?: string } };
  const code = err?.code ?? err?.cause?.code;
  const name = err?.constraint ?? err?.cause?.constraint;
  return code === '23505' && name === constraint;
};

/** The order as the app should see it, plus Razorpay checkout details when payment is still due. */
async function orderWithCheckout(orderId: string) {
  const detail = await getOrderDetail(orderId);
  const pay = detail.payment;
  const needsCheckout = !!pay && pay.provider === 'razorpay' && !!pay.providerOrderId
    && detail.status === 'PLACED' && ['PENDING', 'AWAITING_VERIFICATION', 'FAILED'].includes(pay.status);
  return { ...detail, paymentCheckout: needsCheckout ? buildCheckout(pay!, detail.code) : null };
}

export async function placeOrder(userId: string, input: {
  addressId: string;
  paymentMethod: 'COD' | 'UPI';
  cookingNote?: string;
  idempotencyKey?: string;
}) {
  // Double-tap / network retry: the same key always returns the same order.
  if (input.idempotencyKey) {
    const [dup] = await db.select({ id: orders.id }).from(orders)
      .where(and(eq(orders.customerId, userId), eq(orders.idempotencyKey, input.idempotencyKey))).limit(1);
    if (dup) return orderWithCheckout(dup.id);
  }

  const [address] = await db
    .select().from(addresses)
    .where(and(eq(addresses.id, input.addressId), eq(addresses.userId, userId))).limit(1);
  if (!address) throw Errors.notFound('Address');
  if (!address.zoneId) throw Errors.outOfZone();

  const quote = await quoteCart(userId, address.zoneId);
  if (!quote.canPlaceOrder) {
    const first = quote.blockers[0];
    throw Errors.badRequest(first.message, first.code, { blockers: quote.blockers });
  }
  if (!quote.cart.vendor) throw Errors.emptyCart();

  const [customer] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  const b = quote.breakdown;
  const code = generateOrderCode();
  const isOnline = input.paymentMethod === 'UPI';
  // Throws (instead of falling back to a mock) when production payments are misconfigured.
  const provider = getPaymentProvider(input.paymentMethod);

  let order: typeof orders.$inferSelect;
  try {
    order = await db.transaction(async (tx) => {
      const [created] = await tx.insert(orders).values({
        code,
        customerId: userId,
        vendorId: quote.cart.vendor!.id,
        zoneId: address.zoneId!,
        addressId: address.id,
        status: 'PLACED',
        addressLine: address.line1,
        addressArea: address.area,
        addressLandmark: address.landmark,
        addressLatitude: address.latitude,
        addressLongitude: address.longitude,
        contactPhone: customer?.phone ?? '',
        subtotalPaise: b.subtotalPaise,
        deliveryFeePaise: b.deliveryFeePaise,
        platformFeePaise: b.platformFeePaise,
        taxPaise: b.taxPaise,
        discountPaise: b.discountPaise,
        totalPaise: b.totalPaise,
        commissionPaise: b.commissionPaise,
        paymentMethod: input.paymentMethod,
        paymentStatus: 'PENDING',
        etaMinutes: b.etaMinutes,
        cookingNote: input.cookingNote ?? null,
        idempotencyKey: input.idempotencyKey ?? null,
      }).returning();

      for (const item of quote.cart.items) {
        const [oi] = await tx.insert(orderItems).values({
          orderId: created.id,
          foodItemId: item.foodItemId,
          nameSnapshot: item.name,
          basePricePaise: item.basePricePaise,
          unitPricePaise: item.unitPricePaise,
          quantity: item.quantity,
          instructions: item.instructions,
        }).returning();

        if (item.options.length) {
          await tx.insert(orderItemOptions).values(item.options.map((o) => ({
            orderItemId: oi.id, nameSnapshot: o.name, priceDeltaPaise: o.priceDeltaPaise,
          })));
        }
      }

      await tx.insert(orderStatusEvents).values({
        orderId: created.id, status: 'PLACED', actorId: userId, note: 'Order placed by customer',
      });

      // The payment row always starts PENDING. Network calls to the gateway happen
      // AFTER this transaction commits, never while it holds locks.
      await tx.insert(payments).values({
        orderId: created.id,
        provider: provider.name,
        status: 'PENDING',
        amountPaise: b.totalPaise,
        providerRef: isOnline ? null : `COD-${code}`,
        raw: {},
      });

      return created;
    });
  } catch (e) {
    if (input.idempotencyKey && isUniqueViolation(e, 'orders_customer_idem_uniq')) {
      const [dup] = await db.select({ id: orders.id }).from(orders)
        .where(and(eq(orders.customerId, userId), eq(orders.idempotencyKey, input.idempotencyKey))).limit(1);
      if (dup) return orderWithCheckout(dup.id);
    }
    throw e;
  }

  if (!isOnline) {
    // COD: nothing to collect online. Cart is cleared and the vendor hears about it now.
    await clearCart(userId);
    await notifyVendorOfNewOrder(order.id);
    return orderWithCheckout(order.id);
  }

  // Online: the amount comes from the server-calculated order, never from the app.
  try {
    const intent = await provider.createIntent({ orderCode: code, amountPaise: b.totalPaise });
    await db.update(payments).set({
      providerOrderId: intent.providerOrderId ?? null,
      providerRef: intent.reference,
      status: 'AWAITING_VERIFICATION',
      raw: { instructions: intent.instructions, upiUri: intent.upiUri ?? null },
      updatedAt: new Date(),
    }).where(eq(payments.orderId, order.id));
    await db.update(orders).set({ paymentStatus: 'AWAITING_VERIFICATION', updatedAt: new Date() })
      .where(eq(orders.id, order.id));
  } catch (e) {
    // Could not start the payment: cancel the unpaid order so nothing is left dangling.
    // The cart is untouched, so the customer can simply try again.
    await changeStatus({
      orderId: order.id, to: 'CANCELLED', actor: 'SYSTEM', note: 'Payment could not be started',
    }).catch(() => undefined);
    throw e;
  }
  // Cart and vendor notification wait until the payment is confirmed (see payment.service).
  return orderWithCheckout(order.id);
}

export async function getOrderDetail(orderId: string) {
  const order = await db.query.orders.findFirst({
    where: eq(orders.id, orderId),
    with: {
      items: { with: { options: true } },
      vendor: true,
      zone: true,
      events: { orderBy: (t, { asc }) => [asc(t.createdAt)] },
      payment: true,
      customer: { columns: { id: true, fullName: true, phone: true } },
      review: true,
    },
  });
  if (!order) throw Errors.notFound('Order');

  const [assignment] = await db
    .select({ a: deliveryAssignments, p: deliveryPartners, u: users })
    .from(deliveryAssignments)
    .innerJoin(deliveryPartners, eq(deliveryAssignments.partnerId, deliveryPartners.id))
    .innerJoin(users, eq(deliveryPartners.userId, users.id))
    .where(and(eq(deliveryAssignments.orderId, orderId), inArray(deliveryAssignments.state, ['ACCEPTED', 'COMPLETED'])))
    .limit(1);

  return {
    ...order,
    statusLabel: STATUS_LABEL[order.status as OrderStatus],
    deliveryPartner: assignment
      ? {
          id: assignment.p.id, name: assignment.u.fullName, phone: assignment.u.phone,
          latitude: assignment.p.latitude, longitude: assignment.p.longitude,
          pickedUpAt: assignment.a.pickedUpAt,
        }
      : null,
  };
}

export async function listCustomerOrders(userId: string) {
  return db.query.orders.findMany({
    where: eq(orders.customerId, userId),
    with: { items: true, vendor: { columns: { id: true, name: true, slug: true, logoUrl: true } }, review: true },
    orderBy: [desc(orders.placedAt)],
    limit: 50,
  });
}

export async function listVendorOrders(vendorId: string, status?: OrderStatus) {
  // Online orders only reach the vendor once paid (COD is settled at the door).
  const visible = or(
    eq(orders.paymentMethod, 'COD'),
    inArray(orders.paymentStatus, ['PAID', 'REFUNDED']),
  );
  const rows = await db.query.orders.findMany({
    where: status
      ? and(eq(orders.vendorId, vendorId), eq(orders.status, status), visible)
      : and(eq(orders.vendorId, vendorId), visible),
    with: {
      items: { with: { options: true } },
      customer: { columns: { id: true, fullName: true, phone: true } },
    },
    orderBy: [desc(orders.placedAt)],
    limit: 100,
  });
  // The vendor app shows this as the status badge on every row.
  return rows.map((o) => ({ ...o, statusLabel: STATUS_LABEL[o.status as OrderStatus] }));
}

/**
 * The one place an order's status can change. Validates the transition, the
 * actor's right to make it, then writes the event and fires notifications.
 */
export async function changeStatus(input: {
  orderId: string;
  to: OrderStatus;
  actor: Actor;
  actorUserId?: string;
  note?: string;
  /**
   * For "claim" actions (rider accepts a delivery): require the order to still be in this exact
   * status. Without it, a repeat of an already-applied change is treated as a harmless no-op —
   * correct for double-taps, wrong when two different people are racing for one order.
   */
  expectFrom?: OrderStatus;
}) {
  const [order] = await db.select().from(orders).where(eq(orders.id, input.orderId)).limit(1);
  if (!order) throw Errors.notFound('Order');

  const from = order.status as OrderStatus;
  if (input.expectFrom && from !== input.expectFrom) {
    throw Errors.conflict('This order was just updated. Please refresh.', 'ORDER_CHANGED');
  }
  if (from === input.to) return getOrderDetail(order.id);
  if (!canTransition(from, input.to)) throw Errors.invalidTransition(from, input.to);
  if (!actorCanSet(input.actor, input.to)) {
    throw Errors.forbidden(`A ${input.actor.toLowerCase()} cannot set an order to ${input.to}.`);
  }
  // Nobody can accept (and start cooking) an online order that has not been paid.
  if (input.to === 'ACCEPTED' && order.paymentMethod === 'UPI' && order.paymentStatus !== 'PAID') {
    throw Errors.paymentPending();
  }

  const patch: Partial<typeof orders.$inferInsert> = { status: input.to, updatedAt: new Date() };
  if (input.to === 'ACCEPTED') patch.acceptedAt = new Date();
  if (input.to === 'READY') patch.readyAt = new Date();
  if (input.to === 'DELIVERED') {
    patch.deliveredAt = new Date();
    if (order.paymentMethod === 'COD') patch.paymentStatus = 'PAID';
  }
  if (input.to === 'CANCELLED') {
    patch.cancelReason = input.note ?? 'Cancelled';
    patch.cancelledById = input.actorUserId ?? null;
  }

  await db.transaction(async (tx) => {
    // Compare-and-set on the status we validated against, so two simultaneous
    // requests (e.g. vendor + customer cancelling) cannot both succeed.
    const moved = await tx.update(orders).set(patch)
      .where(and(eq(orders.id, order.id), eq(orders.status, from))).returning({ id: orders.id });
    if (!moved.length) throw Errors.conflict('This order was just updated. Please refresh.', 'ORDER_CHANGED');
    await tx.insert(orderStatusEvents).values({
      orderId: order.id, status: input.to, actorId: input.actorUserId ?? null, note: input.note ?? null,
    });
    if (input.to === 'DELIVERED' && order.paymentMethod === 'COD') {
      await tx.update(payments).set({ status: 'PAID', updatedAt: new Date() }).where(eq(payments.orderId, order.id));
    }
    if (input.to === 'CANCELLED' && order.paymentMethod === 'UPI') {
      // An unpaid payment can no longer succeed. A PAID one is refunded right after this commits.
      await tx.update(payments).set({ status: 'FAILED', failureReason: 'ORDER_CANCELLED', updatedAt: new Date() })
        .where(and(eq(payments.orderId, order.id), inArray(payments.status, ['PENDING', 'AWAITING_VERIFICATION'])));
      await tx.update(orders).set({ paymentStatus: 'FAILED' })
        .where(and(eq(orders.id, order.id), inArray(orders.paymentStatus, ['PENDING', 'AWAITING_VERIFICATION'])));
    }
  });

  if (input.to === 'CANCELLED' && order.paymentMethod === 'UPI') {
    // Cancellation is already committed; a refund hiccup must never undo it. A failed refund
    // is recorded (refundStatus=FAILED) and can be retried by an admin.
    await refundOrderPayment(order.id, input.note ?? 'Order cancelled')
      .catch((e) => console.error('[refund] failed after cancel', order.id, e));
  }

  const template = ORDER_NOTIFICATIONS[input.to];
  if (template) {
    await notify({
      userId: order.customerId, type: `ORDER_${input.to}`,
      title: template.title, body: `${template.body} (${order.code})`,
      data: { orderId: order.id },
    });
  }

  return getOrderDetail(order.id);
}

export async function cancelByCustomer(userId: string, orderId: string, reason?: string) {
  const [order] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
  if (!order) throw Errors.notFound('Order');
  if (order.customerId !== userId) throw Errors.forbidden();

  const settings = await getSettings();
  const elapsed = (Date.now() - new Date(order.placedAt).getTime()) / 1000;
  if (order.status !== 'PLACED') {
    throw Errors.conflict('This order can no longer be cancelled. Please contact support.', 'CANCEL_WINDOW_CLOSED');
  }
  if (elapsed > settings.cancelWindowSeconds) {
    throw Errors.conflict(
      `Orders can only be cancelled within ${Math.round(settings.cancelWindowSeconds / 60)} minutes of placing.`,
      'CANCEL_WINDOW_CLOSED',
    );
  }
  return changeStatus({ orderId, to: 'CANCELLED', actor: 'CUSTOMER', actorUserId: userId, note: reason });
}

/** Recomputes a vendor's rating from visible reviews. Called after each review. */
export async function refreshVendorRating(vendorId: string) {
  const [agg] = await db
    .select({
      avg: sql<number>`coalesce(avg(${reviews.rating}), 0)`,
      count: sql<number>`count(*)`,
    })
    .from(reviews)
    .where(and(eq(reviews.vendorId, vendorId), eq(reviews.isHidden, false)));

  await db.update(vendors).set({
    ratingAvg: Math.round(Number(agg.avg) * 10) / 10,
    ratingCount: Number(agg.count),
    updatedAt: new Date(),
  }).where(eq(vendors.id, vendorId));
}
