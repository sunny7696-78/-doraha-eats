import { audit } from '../lib/audit.js';
import * as paymentService from '../services/payment.service.js';
import { Router } from 'express';
import { z } from 'zod';
import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { validate } from '../middleware/validate.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { db } from '../db/index.js';
import {
  users, vendors, deliveryPartners, orders, deliveryZones, categories,
  reviews, complaints, payments, foodItems,
} from '../db/schema.js';
import { Errors } from '../lib/errors.js';
import { getSettings, updateSettings } from '../services/settings.service.js';
import { resolveZone } from '../services/zone.service.js';
import * as delivery from '../services/delivery.service.js';
import * as orderService from '../services/order.service.js';

export const adminRouter = Router();
adminRouter.use(authenticate, requireRole('ADMIN'));

/* ----------------------------------------------------------------- zones */

adminRouter.get('/zones', async (_req, res, next) => {
  try { res.json({ zones: await db.select().from(deliveryZones).orderBy(desc(deliveryZones.priority)) }); }
  catch (e) { next(e); }
});

adminRouter.post('/zones', validate({
  body: z.object({
    name: z.string().min(2),
    description: z.string().optional(),
    city: z.string().default('Doraha'),
    district: z.string().default('Ludhiana'),
    state: z.string().default('Punjab'),
    latitude: z.number(),
    longitude: z.number(),
    radiusMeters: z.number().int().min(100).max(50_000),
    deliveryFeePaise: z.number().int().min(0),
    minOrderPaise: z.number().int().min(0).default(0),
    etaMinutes: z.number().int().min(5).max(180).default(35),
    priority: z.number().int().default(0),
    // Expansion is always opt-in: a new zone is inactive until an admin says otherwise.
    isActive: z.boolean().default(false),
  }),
}), async (req, res, next) => {
  try {
    const [zone] = await db.insert(deliveryZones).values(req.body).returning();
    res.status(201).json({ zone });
  } catch (e) { next(e); }
});

adminRouter.patch('/zones/:id', validate({
  body: z.object({
    name: z.string().min(2).optional(),
    description: z.string().optional(),
    latitude: z.number().optional(),
    longitude: z.number().optional(),
    radiusMeters: z.number().int().min(100).max(50_000).optional(),
    deliveryFeePaise: z.number().int().min(0).optional(),
    minOrderPaise: z.number().int().min(0).optional(),
    etaMinutes: z.number().int().min(5).max(180).optional(),
    priority: z.number().int().optional(),
    isActive: z.boolean().optional(),
  }),
}), async (req, res, next) => {
  try {
    const [zone] = await db.update(deliveryZones)
      .set({ ...req.body, updatedAt: new Date() }).where(eq(deliveryZones.id, req.params.id)).returning();
    if (!zone) throw Errors.notFound('Zone');
    res.json({ zone });
  } catch (e) { next(e); }
});

adminRouter.delete('/zones/:id', async (req, res, next) => {
  try {
    await db.delete(deliveryZones).where(eq(deliveryZones.id, req.params.id));
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/** Coordinate tester — confirm an address resolves to the zone you expect. */
adminRouter.post('/zones/test', validate({
  body: z.object({ latitude: z.number(), longitude: z.number() }),
}), async (req, res, next) => {
  try { res.json(await resolveZone(req.body.latitude, req.body.longitude)); } catch (e) { next(e); }
});

/* ------------------------------------------------------------- customers */

adminRouter.get('/customers', async (_req, res, next) => {
  try {
    const rows = await db.select({
      id: users.id, fullName: users.fullName, email: users.email, phone: users.phone,
      status: users.status, createdAt: users.createdAt, lastLoginAt: users.lastLoginAt,
      orderCount: sql<number>`(select count(*) from ${orders} where ${orders.customerId} = ${users.id})`,
    }).from(users).where(eq(users.role, 'CUSTOMER')).orderBy(desc(users.createdAt)).limit(200);
    res.json({ customers: rows });
  } catch (e) { next(e); }
});

adminRouter.patch('/users/:id/status', validate({
  body: z.object({ status: z.enum(['ACTIVE', 'SUSPENDED']) }),
}), async (req, res, next) => {
  try {
    const [target] = await db.select().from(users).where(eq(users.id, req.params.id)).limit(1);
    if (!target) throw Errors.notFound('User');
    if (target.id === req.user!.id) throw Errors.conflict('You cannot change your own account status.', 'SELF_ACTION');
    if (target.role === 'ADMIN') throw Errors.forbidden('Admin accounts cannot be suspended from here.');
    const [row] = await db.update(users)
      .set({ status: req.body.status, updatedAt: new Date() }).where(eq(users.id, target.id)).returning();
    await audit({ actorId: req.user!.id, action: 'USER_STATUS_CHANGED', entityType: 'user', entityId: target.id,
      before: { status: target.status }, after: { status: row.status } });
    res.json({ user: { id: row.id, status: row.status } });
  } catch (e) { next(e); }
});

/* --------------------------------------------------------------- vendors */

adminRouter.get('/vendors', async (_req, res, next) => {
  try {
    const rows = await db.query.vendors.findMany({
      with: { zone: { columns: { id: true, name: true } }, owner: { columns: { email: true, phone: true } } },
      orderBy: [desc(vendors.createdAt)],
    });
    res.json({ vendors: rows });
  } catch (e) { next(e); }
});

adminRouter.post('/vendors/:id/approve', async (req, res, next) => {
  try {
    const [v] = await db.update(vendors)
      .set({ status: 'ACTIVE', updatedAt: new Date() }).where(eq(vendors.id, req.params.id)).returning();
    if (!v) throw Errors.notFound('Vendor');
    await audit({ actorId: req.user!.id, action: 'VENDOR_APPROVED', entityType: 'vendor', entityId: v.id });
    res.json({ vendor: v });
  } catch (e) { next(e); }
});

adminRouter.post('/vendors/:id/reject', async (req, res, next) => {
  try {
    const [v] = await db.update(vendors)
      .set({ status: 'REJECTED', updatedAt: new Date() }).where(eq(vendors.id, req.params.id)).returning();
    if (!v) throw Errors.notFound('Vendor');
    await audit({ actorId: req.user!.id, action: 'VENDOR_REJECTED', entityType: 'vendor', entityId: v.id });
    res.json({ vendor: v });
  } catch (e) { next(e); }
});

adminRouter.patch('/vendors/:id', validate({
  body: z.object({
    status: z.enum(['PENDING', 'ACTIVE', 'SUSPENDED', 'REJECTED']).optional(),
    commissionPct: z.number().min(0).max(100).optional(),
    zoneId: z.string().uuid().optional(),
  }),
}), async (req, res, next) => {
  try {
    const [before] = await db.select().from(vendors).where(eq(vendors.id, req.params.id)).limit(1);
    if (!before) throw Errors.notFound('Vendor');
    const [v] = await db.update(vendors)
      .set({ ...req.body, updatedAt: new Date() }).where(eq(vendors.id, req.params.id)).returning();
    await audit({ actorId: req.user!.id, action: 'VENDOR_UPDATED', entityType: 'vendor', entityId: v.id,
      before: { status: before.status, commissionPct: before.commissionPct, zoneId: before.zoneId },
      after: { status: v.status, commissionPct: v.commissionPct, zoneId: v.zoneId } });
    res.json({ vendor: v });
  } catch (e) { next(e); }
});

/* ------------------------------------------------------ delivery partners */

adminRouter.get('/delivery-partners', async (_req, res, next) => {
  try {
    const rows = await db.query.deliveryPartners.findMany({
      with: { user: { columns: { id: true, fullName: true, phone: true, email: true } } },
      orderBy: [desc(deliveryPartners.createdAt)],
    });
    res.json({ partners: rows });
  } catch (e) { next(e); }
});

adminRouter.post('/delivery-partners/:id/approve', async (req, res, next) => {
  try {
    const [p] = await db.update(deliveryPartners)
      .set({ status: 'ACTIVE', updatedAt: new Date() }).where(eq(deliveryPartners.id, req.params.id)).returning();
    if (!p) throw Errors.notFound('Delivery partner');
    await db.update(users).set({ status: 'ACTIVE' }).where(eq(users.id, p.userId));
    await audit({ actorId: req.user!.id, action: 'RIDER_APPROVED', entityType: 'delivery_partner', entityId: p.id });
    res.json({ partner: p });
  } catch (e) { next(e); }
});

adminRouter.post('/delivery-partners/:id/reject', async (req, res, next) => {
  try {
    const [p] = await db.update(deliveryPartners)
      .set({ status: 'REJECTED', isOnline: false, updatedAt: new Date() })
      .where(eq(deliveryPartners.id, req.params.id)).returning();
    if (!p) throw Errors.notFound('Delivery partner');
    await audit({ actorId: req.user!.id, action: 'RIDER_REJECTED', entityType: 'delivery_partner', entityId: p.id });
    res.json({ partner: p });
  } catch (e) { next(e); }
});

/* ---------------------------------------------------------------- orders */

adminRouter.get('/orders', validate({
  query: z.object({
    status: z.string().optional(), zoneId: z.string().uuid().optional(), limit: z.coerce.number().default(100),
  }),
}), async (req, res, next) => {
  try {
    const conditions = [];
    if (req.query.status) conditions.push(eq(orders.status, req.query.status as never));
    if (req.query.zoneId) conditions.push(eq(orders.zoneId, req.query.zoneId as string));
    const rows = await db.query.orders.findMany({
      where: conditions.length ? and(...conditions) : undefined,
      with: {
        vendor: { columns: { id: true, name: true } },
        customer: { columns: { id: true, fullName: true, phone: true } },
        zone: { columns: { id: true, name: true } },
        items: true,
      },
      orderBy: [desc(orders.placedAt)],
      limit: Number(req.query.limit),
    });
    res.json({ orders: rows });
  } catch (e) { next(e); }
});

adminRouter.get('/orders/:id', async (req, res, next) => {
  try { res.json({ order: await orderService.getOrderDetail(req.params.id) }); } catch (e) { next(e); }
});

adminRouter.post('/orders/:id/assign', validate({
  body: z.object({ partnerId: z.string().uuid() }),
}), async (req, res, next) => {
  try {
    res.json({ order: await delivery.adminAssign(req.params.id, req.body.partnerId, req.user!.id) });
  } catch (e) { next(e); }
});

adminRouter.post('/orders/:id/cancel', validate({
  body: z.object({ reason: z.string().min(3).max(200) }),
}), async (req, res, next) => {
  try {
    const order = await orderService.changeStatus({
      orderId: req.params.id, to: 'CANCELLED', actor: 'ADMIN',
      actorUserId: req.user!.id, note: req.body.reason,
    });
    await audit({ actorId: req.user!.id, action: 'ORDER_CANCELLED_BY_ADMIN', entityType: 'order',
      entityId: req.params.id, after: { reason: req.body.reason } });
    res.json({ order });
  } catch (e) { next(e); }
});

/* -------------------------------------------------------------- payments */

adminRouter.get('/payments/pending', async (_req, res, next) => {
  try {
    const rows = await db.select({ p: payments, o: orders })
      .from(payments).innerJoin(orders, eq(payments.orderId, orders.id))
      .where(eq(payments.status, 'AWAITING_VERIFICATION')).orderBy(desc(payments.createdAt));
    res.json({ payments: rows });
  } catch (e) { next(e); }
});

/** Manual confirmation exists ONLY for the dev mock-UPI flow. Gateway payments are confirmed by Razorpay. */
adminRouter.post('/payments/:id/verify', async (req, res, next) => {
  try {
    const [p] = await db.select().from(payments).where(eq(payments.id, req.params.id)).limit(1);
    if (!p) throw Errors.notFound('Payment');
    if (p.provider !== 'upi_mock') {
      throw Errors.conflict('This payment is confirmed automatically by the payment gateway.', 'GATEWAY_PAYMENT');
    }
    await paymentService.markPaid({ paymentRowId: p.id, verifiedById: req.user!.id });
    await audit({ actorId: req.user!.id, action: 'PAYMENT_MANUALLY_VERIFIED', entityType: 'payment', entityId: p.id, after: { amountPaise: p.amountPaise } });
    const [fresh] = await db.select().from(payments).where(eq(payments.id, p.id)).limit(1);
    res.json({ payment: fresh });
  } catch (e) { next(e); }
});

/** Retry a refund that did not complete. Only for CANCELLED orders — it never refunds a live order. */
adminRouter.post('/payments/:id/refund', async (req, res, next) => {
  try {
    const [row] = await db.select({ p: payments, o: orders }).from(payments)
      .innerJoin(orders, eq(payments.orderId, orders.id)).where(eq(payments.id, req.params.id)).limit(1);
    if (!row) throw Errors.notFound('Payment');
    if (row.o.status !== 'CANCELLED') {
      throw Errors.conflict('Only cancelled orders can be refunded.', 'ORDER_NOT_CANCELLED');
    }
    const outcome = await paymentService.refundOrderPayment(row.o.id, 'Admin refund');
    await audit({ actorId: req.user!.id, action: 'REFUND_REQUESTED', entityType: 'payment', entityId: row.p.id,
      after: { outcome, amountPaise: row.p.amountPaise } });
    const [fresh] = await db.select().from(payments).where(eq(payments.id, row.p.id)).limit(1);
    res.json({ outcome, payment: fresh });
  } catch (e) { next(e); }
});

/* ------------------------------------------------ categories / moderation */

adminRouter.get('/categories', async (_req, res, next) => {
  try { res.json({ categories: await db.select().from(categories).orderBy(categories.sortOrder) }); }
  catch (e) { next(e); }
});

adminRouter.post('/categories', validate({
  body: z.object({
    slug: z.string().min(2), name: z.string().min(1),
    nameHi: z.string().optional(), namePa: z.string().optional(),
    icon: z.string().optional(), sortOrder: z.number().int().default(0),
  }),
}), async (req, res, next) => {
  try {
    const [row] = await db.insert(categories).values(req.body).returning();
    res.status(201).json({ category: row });
  } catch (e) { next(e); }
});

adminRouter.patch('/categories/:id', validate({
  body: z.object({
    name: z.string().optional(), nameHi: z.string().optional(), namePa: z.string().optional(),
    icon: z.string().optional(), sortOrder: z.number().int().optional(), isActive: z.boolean().optional(),
  }),
}), async (req, res, next) => {
  try {
    const [row] = await db.update(categories)
      .set({ ...req.body, updatedAt: new Date() }).where(eq(categories.id, req.params.id)).returning();
    res.json({ category: row });
  } catch (e) { next(e); }
});

adminRouter.get('/reviews', async (_req, res, next) => {
  try {
    const rows = await db.query.reviews.findMany({
      with: { vendor: { columns: { id: true, name: true } }, customer: { columns: { fullName: true } } },
      orderBy: [desc(reviews.createdAt)], limit: 200,
    });
    res.json({ reviews: rows });
  } catch (e) { next(e); }
});

adminRouter.patch('/reviews/:id', validate({
  body: z.object({ isHidden: z.boolean() }),
}), async (req, res, next) => {
  try {
    const [row] = await db.update(reviews)
      .set({ isHidden: req.body.isHidden, updatedAt: new Date() }).where(eq(reviews.id, req.params.id)).returning();
    if (!row) throw Errors.notFound('Review');
    await orderService.refreshVendorRating(row.vendorId);
    res.json({ review: row });
  } catch (e) { next(e); }
});

adminRouter.get('/complaints', async (_req, res, next) => {
  try {
    const rows = await db.query.complaints.findMany({
      with: { user: { columns: { fullName: true, phone: true } } },
      orderBy: [desc(complaints.createdAt)], limit: 200,
    });
    res.json({ complaints: rows });
  } catch (e) { next(e); }
});

adminRouter.patch('/complaints/:id', validate({
  body: z.object({
    status: z.enum(['OPEN', 'IN_PROGRESS', 'RESOLVED', 'REJECTED']),
    resolution: z.string().max(1000).optional(),
  }),
}), async (req, res, next) => {
  try {
    const [row] = await db.update(complaints).set({
      status: req.body.status, resolution: req.body.resolution ?? null,
      handledById: req.user!.id, updatedAt: new Date(),
    }).where(eq(complaints.id, req.params.id)).returning();
    res.json({ complaint: row });
  } catch (e) { next(e); }
});

/* -------------------------------------------------- settings / analytics */

adminRouter.get('/settings', async (_req, res, next) => {
  try { res.json({ settings: await getSettings() }); } catch (e) { next(e); }
});

adminRouter.put('/settings', validate({
  body: z.object({
    brandName: z.string().min(1).optional(),
    brandTagline: z.string().min(1).optional(),
    brandPrimaryColor: z.string().optional(),
    platformFeePaise: z.number().int().min(0).optional(),
    commissionPct: z.number().min(0).max(100).optional(),
    taxPct: z.number().min(0).max(100).optional(),
    riderPayoutPaise: z.number().int().min(0).optional(),
    cancelWindowSeconds: z.number().int().min(0).optional(),
    defaultLocale: z.enum(['en', 'hi', 'pa']).optional(),
    supportPhone: z.string().optional(),
  }),
}), async (req, res, next) => {
  try {
    const before = await getSettings();
    const after = await updateSettings(req.body);
    await audit({ actorId: req.user!.id, action: 'SETTINGS_CHANGED', entityType: 'settings', before, after });
    res.json({ settings: after });
  } catch (e) { next(e); }
});

adminRouter.get('/analytics', async (_req, res, next) => {
  try {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const since = new Date(Date.now() - 14 * 86_400_000);

    const [counts] = await db.select({
      customers: sql<number>`(select count(*) from ${users} where ${users.role} = 'CUSTOMER')`,
      vendors: sql<number>`(select count(*) from ${vendors})`,
      activeVendors: sql<number>`(select count(*) from ${vendors} where ${vendors.status} = 'ACTIVE')`,
      partners: sql<number>`(select count(*) from ${deliveryPartners} where ${deliveryPartners.status} = 'ACTIVE')`,
      onlinePartners: sql<number>`(select count(*) from ${deliveryPartners} where ${deliveryPartners.isOnline} = true)`,
      foodItems: sql<number>`(select count(*) from ${foodItems})`,
      pendingVendorApprovals: sql<number>`(select count(*) from ${vendors} where ${vendors.status} = 'PENDING')`,
      pendingRiderApprovals: sql<number>`(select count(*) from ${deliveryPartners} where ${deliveryPartners.status} = 'PENDING')`,
      failedPayments: sql<number>`(select count(*) from ${payments} where ${payments.status} = 'FAILED')`,
      refunds: sql<number>`(select count(*) from ${payments} where ${payments.refundStatus} is not null)`,
      pendingRefunds: sql<number>`(select count(*) from ${payments} where ${payments.refundStatus} in ('INITIATED','PENDING','FAILED'))`,
    }).from(users).limit(1);

    const [orderAgg] = await db.select({
      total: sql<number>`count(*)`,
      todayCount: sql<number>`count(*) filter (where ${orders.placedAt} >= ${today.toISOString()})`,
      pending: sql<number>`count(*) filter (where ${orders.status} not in ('DELIVERED','CANCELLED'))`,
      delivered: sql<number>`count(*) filter (where ${orders.status} = 'DELIVERED')`,
      cancelled: sql<number>`count(*) filter (where ${orders.status} = 'CANCELLED')`,
      activeDeliveries: sql<number>`count(*) filter (where ${orders.status} in ('ASSIGNED','PICKED_UP','ON_THE_WAY'))`,
      pendingPayments: sql<number>`count(*) filter (where ${orders.paymentMethod} = 'UPI' and ${orders.paymentStatus} in ('PENDING','AWAITING_VERIFICATION') and ${orders.status} <> 'CANCELLED')`,
      revenueToday: sql<number>`coalesce(sum(${orders.totalPaise}) filter (where ${orders.status} = 'DELIVERED' and ${orders.deliveredAt} >= ${today.toISOString()}), 0)`,
      revenue: sql<number>`coalesce(sum(${orders.totalPaise}) filter (where ${orders.status} = 'DELIVERED'), 0)`,
      commission: sql<number>`coalesce(sum(${orders.commissionPaise}) filter (where ${orders.status} = 'DELIVERED'), 0)`,
    }).from(orders);

    const daily = await db.select({
      day: sql<string>`to_char(${orders.placedAt}, 'YYYY-MM-DD')`,
      orders: sql<number>`count(*)`,
      revenue: sql<number>`coalesce(sum(${orders.totalPaise}), 0)`,
    }).from(orders).where(and(gte(orders.placedAt, since), sql`${orders.status} <> 'CANCELLED'`))
      .groupBy(sql`to_char(${orders.placedAt}, 'YYYY-MM-DD')`)
      .orderBy(sql`to_char(${orders.placedAt}, 'YYYY-MM-DD')`);

    const topVendors = await db.select({
      vendorId: vendors.id, name: vendors.name,
      orders: sql<number>`count(${orders.id})`,
      revenue: sql<number>`coalesce(sum(${orders.totalPaise}), 0)`,
    }).from(orders).innerJoin(vendors, eq(orders.vendorId, vendors.id))
      .where(sql`${orders.status} <> 'CANCELLED'`)
      .groupBy(vendors.id, vendors.name)
      .orderBy(sql`count(${orders.id}) desc`).limit(10);

    res.json({
      cards: {
        totalCustomers: Number(counts.customers),
        totalVendors: Number(counts.vendors),
        activeVendors: Number(counts.activeVendors),
        activeDeliveryPartners: Number(counts.partners),
        onlineDeliveryPartners: Number(counts.onlinePartners),
        totalFoodItems: Number(counts.foodItems),
        totalOrders: Number(orderAgg.total),
        todayOrders: Number(orderAgg.todayCount),
        pendingOrders: Number(orderAgg.pending),
        deliveredOrders: Number(orderAgg.delivered),
        cancelledOrders: Number(orderAgg.cancelled),
        activeDeliveries: Number(orderAgg.activeDeliveries),
        pendingPayments: Number(orderAgg.pendingPayments),
        revenueTodayPaise: Number(orderAgg.revenueToday),
        pendingVendorApprovals: Number(counts.pendingVendorApprovals),
        pendingRiderApprovals: Number(counts.pendingRiderApprovals),
        failedPayments: Number(counts.failedPayments),
        refunds: Number(counts.refunds),
        pendingRefunds: Number(counts.pendingRefunds),
        revenuePaise: Number(orderAgg.revenue),
        commissionPaise: Number(orderAgg.commission),
      },
      charts: {
        daily: daily.map((d) => ({ day: d.day, orders: Number(d.orders), revenuePaise: Number(d.revenue) })),
        topVendors: topVendors.map((v) => ({
          vendorId: v.vendorId, name: v.name, orders: Number(v.orders), revenuePaise: Number(v.revenue),
        })),
      },
    });
  } catch (e) { next(e); }
});
