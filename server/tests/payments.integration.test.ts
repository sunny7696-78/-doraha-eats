/**
 * End-to-end payment tests against a REAL Postgres (migrated + seeded) with a
 * fake Razorpay. Skipped unless TEST_DATABASE_URL is set, so `npm test` stays green
 * on machines without a database.
 *
 *   TEST_DATABASE_URL=postgres://postgres@localhost:5433/doraha_test npm test
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import crypto from 'node:crypto';
import request from 'supertest';

const URL_ = process.env.TEST_DATABASE_URL;
const KEY_SECRET = 'rzp_secret_for_tests';
const WH_SECRET = 'whsec_for_tests';

const hmac = (s: string, d: string | Buffer) => crypto.createHmac('sha256', s).update(d).digest('hex');

/* ---------------------------------------------------------- fake Razorpay */
type FOrder = { id: string; amount: number; currency: string; status: string; receipt: string };
type FPay = { id: string; order_id: string; amount: number; currency: string; status: string };
const RUN = crypto.randomBytes(4).toString('hex'); // keeps fake ids unique across runs on a persistent test DB
const fake = { orders: new Map<string, FOrder>(), payments: new Map<string, FPay>(), refunds: [] as any[], seq: 0, refundStatus: 'processed' };

function installFakeRazorpay() {
  const real = globalThis.fetch;
  vi.stubGlobal('fetch', async (url: any, init: any = {}) => {
    const u = String(url);
    if (!u.startsWith('https://api.razorpay.com/v1')) return real(url, init);
    const path = u.replace('https://api.razorpay.com/v1', '');
    const body = init.body ? JSON.parse(init.body) : {};
    const ok = (j: unknown) => new Response(JSON.stringify(j), { status: 200 });
    if (init.method === 'POST' && path === '/orders') {
      const o = { id: `order_${RUN}${++fake.seq}`, amount: body.amount, currency: body.currency, status: 'created', receipt: body.receipt };
      fake.orders.set(o.id, o); return ok(o);
    }
    let m;
    if ((m = path.match(/^\/orders\/([^/]+)\/payments$/))) {
      return ok({ items: [...fake.payments.values()].filter((p) => p.order_id === m![1]) });
    }
    if ((m = path.match(/^\/orders\/([^/]+)$/))) return ok(fake.orders.get(m[1]));
    if ((m = path.match(/^\/payments\/([^/]+)\/refund$/))) {
      const r = { id: `rfnd_${RUN}${++fake.seq}`, payment_id: m[1], amount: body.amount, status: fake.refundStatus };
      fake.refunds.push({ ...r, idem: init.headers['X-Refund-Idempotency'] }); return ok(r);
    }
    if ((m = path.match(/^\/payments\/([^/]+)\/capture$/))) {
      const p = fake.payments.get(m[1])!; p.status = 'captured'; return ok(p);
    }
    if ((m = path.match(/^\/payments\/([^/]+)$/))) return ok(fake.payments.get(m[1]));
    return new Response('{}', { status: 404 });
  });
}

/** Simulates the customer paying on Razorpay's side. */
const customerPays = (rzpOrderId: string, status = 'captured', amount?: number) => {
  const o = fake.orders.get(rzpOrderId)!;
  const p = { id: `pay_${RUN}${++fake.seq}`, order_id: rzpOrderId, amount: amount ?? o.amount, currency: 'INR', status };
  fake.payments.set(p.id, p); return p;
};

describe.skipIf(!URL_)('payments (integration)', () => {
  let app: any; let db: any; let schema: any; let drizzle: any; let sweeper: any;
  let customerToken = ''; let vendorToken = ''; let addressId = ''; let foodItemId = ''; let vendorId = '';
  let customerId = '';

  const api = () => request(app);
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  async function webhook(event: object, opts: { sig?: string; eventId?: string } = {}) {
    const raw = Buffer.from(JSON.stringify(event));
    return api().post('/api/v1/payments/razorpay/webhook')
      .set('Content-Type', 'application/json')
      .set('x-razorpay-signature', opts.sig ?? hmac(WH_SECRET, raw))
      .set('x-razorpay-event-id', opts.eventId ?? `evt_${crypto.randomUUID()}`)
      .send(raw.toString('utf8')); // string, not Buffer: superagent would JSON-encode a Buffer and break the signature
  }
  const capturedEvent = (p: FPay) => ({ event: 'payment.captured', payload: { payment: { entity: p } } });

  async function fillCart() {
    await api().delete('/api/v1/cart').set(auth(customerToken));
    const r = await api().post('/api/v1/cart/items').set(auth(customerToken)).send({ foodItemId, quantity: 5 });
    expect(r.status).toBe(201);
  }
  async function placeOnline(key?: string) {
    await fillCart();
    const r = await api().post('/api/v1/orders').set(auth(customerToken))
      .set(key ? { 'Idempotency-Key': key } : {}).send({ addressId, paymentMethod: 'UPI' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r;
  }
  const dbOrder = async (id: string) => (await db.select().from(schema.orders).where(drizzle.eq(schema.orders.id, id)))[0];
  const dbPay = async (orderId: string) => (await db.select().from(schema.payments).where(drizzle.eq(schema.payments.orderId, orderId)))[0];
  const vendorSees = async (orderId: string) => {
    const r = await api().get('/api/v1/vendor/orders').set(auth(vendorToken));
    return (r.body.orders as any[]).some((o) => o.id === orderId);
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = URL_;
    process.env.NODE_ENV = 'test';
    process.env.JWT_SECRET = 'integration-test-secret-integration-test';
    process.env.PAYMENT_PROVIDER = 'razorpay';
    process.env.RAZORPAY_KEY_ID = 'rzp_test_KEYID';
    process.env.RAZORPAY_KEY_SECRET = KEY_SECRET;
    process.env.RAZORPAY_WEBHOOK_SECRET = WH_SECRET;
    process.env.PAYMENT_WINDOW_MINUTES = '30';
    installFakeRazorpay();
    drizzle = await import('drizzle-orm');
    ({ db } = await import('../src/db/index.js'));
    schema = await import('../src/db/schema.js');
    sweeper = await import('../src/services/paymentSweeper.js');
    const { createApp } = await import('../src/app.js');
    app = createApp();

    const login = async (email: string) => {
      const r = await api().post('/api/v1/auth/login').send({ email, password: 'Doraha@123' });
      expect(r.status).toBe(200); return r.body;
    };
    const c = await login('customer@dorahaeats.local');
    customerToken = c.token; customerId = c.user.id;

    const [addr] = await db.select().from(schema.addresses)
      .where(drizzle.and(drizzle.eq(schema.addresses.userId, customerId), drizzle.eq(schema.addresses.isDefault, true)));
    addressId = addr.id;

    const [vendor] = await db.select().from(schema.vendors).where(drizzle.like(schema.vendors.name, '%Sharma Burger%'));
    vendorId = vendor.id;
    const [owner] = await db.select().from(schema.users).where(drizzle.eq(schema.users.id, vendor.ownerUserId));
    vendorToken = (await login(owner.email)).token;
    const [item] = await db.select().from(schema.foodItems).where(drizzle.eq(schema.foodItems.vendorId, vendorId)).limit(1);
    foodItemId = item.id;

    // Make the test independent of the time of day: open all day, every day.
    await db.delete(schema.vendorHours).where(drizzle.eq(schema.vendorHours.vendorId, vendorId));
    await db.insert(schema.vendorHours).values([0, 1, 2, 3, 4, 5, 6].map((d) =>
      ({ vendorId, dayOfWeek: d, opensAt: '00:00', closesAt: '23:59' })));
    await db.update(schema.vendors).set({ shopStatus: 'OPEN' }).where(drizzle.eq(schema.vendors.id, vendorId));
  });

  afterAll(() => { vi.unstubAllGlobals(); });

  it('COD still works: vendor is notified immediately, cart is cleared, payment stays pending', async () => {
    await fillCart();
    const r = await api().post('/api/v1/orders').set(auth(customerToken)).send({ addressId, paymentMethod: 'COD' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.order.paymentStatus).toBe('PENDING');
    expect(r.body.order.paymentCheckout).toBeNull();
    expect(await vendorSees(r.body.order.id)).toBe(true);
    const cart = await api().get('/api/v1/cart').set(auth(customerToken));
    expect(cart.body.cart.items).toHaveLength(0);
  });

  it('online order: server-calculated amount, checkout returned, hidden from vendor, cart kept, cannot be accepted', async () => {
    const r = await placeOnline();
    expect(r.status).toBe(201);
    const o = r.body.order;
    expect(o.paymentCheckout.amountPaise).toBe(o.totalPaise);
    expect(o.paymentCheckout.keyId).toBe('rzp_test_KEYID');
    expect(JSON.stringify(o)).not.toContain(KEY_SECRET);
    expect(fake.orders.get(o.paymentCheckout.razorpayOrderId)!.amount).toBe(o.totalPaise);
    expect(o.payment.status).toBe('AWAITING_VERIFICATION');

    expect(await vendorSees(o.id)).toBe(false);
    const cart = await api().get('/api/v1/cart').set(auth(customerToken));
    expect(cart.body.cart.items.length).toBeGreaterThan(0);

    const accept = await api().post(`/api/v1/vendor/orders/${o.id}/accept`).set(auth(vendorToken)).send({});
    expect(accept.status).toBe(409);
    expect(accept.body.error.code).toBe('PAYMENT_PENDING');
  });

  it('double-tap with the same Idempotency-Key creates ONE order and ONE Razorpay order', async () => {
    const before = fake.orders.size;
    const key = `idem-${crypto.randomUUID()}`;
    await fillCart();
    const body = { addressId, paymentMethod: 'UPI' };
    const [a, b] = await Promise.all([
      api().post('/api/v1/orders').set(auth(customerToken)).set('Idempotency-Key', key).send(body),
      api().post('/api/v1/orders').set(auth(customerToken)).set('Idempotency-Key', key).send(body),
    ]);
    expect([a.status, b.status].every((s) => s === 201)).toBe(true);
    expect(a.body.order.id).toBe(b.body.order.id);
    const rows = await db.select().from(schema.orders).where(drizzle.eq(schema.orders.idempotencyKey, key));
    expect(rows).toHaveLength(1);
    expect(fake.orders.size - before).toBeLessThanOrEqual(2); // a lost race may create at most one orphan Razorpay order, never a 2nd DB order
  });

  it('forged checkout callbacks and the manual UTR route cannot mark an order paid', async () => {
    const r = await placeOnline();
    const o = r.body.order; const rz = o.paymentCheckout.razorpayOrderId;
    const bad = await api().post(`/api/v1/orders/${o.id}/payment/verify`).set(auth(customerToken)).send({
      razorpay_order_id: rz, razorpay_payment_id: 'pay_FORGED1', razorpay_signature: 'a'.repeat(64),
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('INVALID_PAYMENT');

    const utr = await api().post(`/api/v1/orders/${o.id}/payment/upi-ref`).set(auth(customerToken)).send({ utr: '123456789012' });
    expect(utr.status).toBe(403);
    expect((await dbPay(o.id)).status).not.toBe('PAID');
  });

  it('valid checkout callback: verifies with Razorpay (order, amount) and marks PAID; vendor then sees it', async () => {
    const r = await placeOnline();
    const o = r.body.order; const rz = o.paymentCheckout.razorpayOrderId;
    const pay = customerPays(rz);
    const ok = await api().post(`/api/v1/orders/${o.id}/payment/verify`).set(auth(customerToken)).send({
      razorpay_order_id: rz, razorpay_payment_id: pay.id, razorpay_signature: hmac(KEY_SECRET, `${rz}|${pay.id}`),
    });
    expect(ok.status).toBe(200);
    expect(ok.body.verified).toBe(true);
    expect((await dbPay(o.id)).status).toBe('PAID');
    expect((await dbOrder(o.id)).paymentStatus).toBe('PAID');
    expect(await vendorSees(o.id)).toBe(true);
    expect((await api().get('/api/v1/cart').set(auth(customerToken))).body.cart.items).toHaveLength(0);
  });

  it('callback with a payment for the wrong amount is rejected', async () => {
    const r = await placeOnline();
    const o = r.body.order; const rz = o.paymentCheckout.razorpayOrderId;
    const pay = customerPays(rz, 'captured', 100);
    const res = await api().post(`/api/v1/orders/${o.id}/payment/verify`).set(auth(customerToken)).send({
      razorpay_order_id: rz, razorpay_payment_id: pay.id, razorpay_signature: hmac(KEY_SECRET, `${rz}|${pay.id}`),
    });
    expect(res.status).toBe(400);
    expect((await dbPay(o.id)).status).not.toBe('PAID');
  });

  it('webhook: rejects bad signatures; accepts a signed capture; duplicate delivery is a no-op', async () => {
    const r = await placeOnline();
    const o = r.body.order; const rz = o.paymentCheckout.razorpayOrderId;
    const pay = customerPays(rz);
    const ev = capturedEvent(pay);

    const forged = await webhook(ev, { sig: 'f'.repeat(64) });
    expect(forged.status).toBe(400);
    expect((await dbPay(o.id)).status).not.toBe('PAID');

    const id = `evt_${crypto.randomUUID()}`;
    expect((await webhook(ev, { eventId: id })).status).toBe(200);
    expect((await dbPay(o.id)).status).toBe('PAID');
    expect(await vendorSees(o.id)).toBe(true);

    const again = await webhook(ev, { eventId: id });
    expect(again.status).toBe(200);
    const events = await db.select().from(schema.paymentEvents).where(drizzle.eq(schema.paymentEvents.eventId, id));
    expect(events).toHaveLength(1);

    // A second delivery with a NEW event id for the same payment must not re-notify the vendor.
    await webhook(ev);
    const notes = await db.select().from(schema.notifications)
      .where(drizzle.sql`${schema.notifications.type} = 'NEW_ORDER' and ${schema.notifications.data}->>'orderId' = ${o.id}`);
    expect(notes).toHaveLength(1);
  });

  it('webhook with a mismatched amount does not mark the order paid', async () => {
    const r = await placeOnline();
    const o = r.body.order; const rz = o.paymentCheckout.razorpayOrderId;
    const pay = customerPays(rz, 'captured', 1);
    expect((await webhook(capturedEvent(pay))).status).toBe(200);
    expect((await dbPay(o.id)).status).not.toBe('PAID');
  });

  it('failed payment can be retried on the SAME Razorpay order; a late failure never downgrades PAID', async () => {
    const r = await placeOnline();
    const o = r.body.order; const rz = o.paymentCheckout.razorpayOrderId;
    const failed = customerPays(rz, 'failed');
    await webhook({ event: 'payment.failed', payload: { payment: { entity: { ...failed, error_description: 'Card declined' } } } });
    expect((await dbPay(o.id)).status).toBe('FAILED');
    expect((await dbOrder(o.id)).status).toBe('PLACED');

    const retry = await api().post(`/api/v1/orders/${o.id}/payment/retry`).set(auth(customerToken));
    expect(retry.status).toBe(200);
    expect(retry.body.paymentCheckout.razorpayOrderId).toBe(rz);
    expect((await dbPay(o.id)).status).toBe('AWAITING_VERIFICATION');

    const good = customerPays(rz);
    await webhook(capturedEvent(good));
    expect((await dbPay(o.id)).status).toBe('PAID');

    await webhook({ event: 'payment.failed', payload: { payment: { entity: failed } } });
    expect((await dbPay(o.id)).status).toBe('PAID');

    const again = await api().post(`/api/v1/orders/${o.id}/payment/retry`).set(auth(customerToken));
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('PAYMENT_ALREADY_COMPLETED');
  });

  it('cancelling a paid order refunds exactly once; refund.processed marks it REFUNDED', async () => {
    fake.refundStatus = 'pending';
    const r = await placeOnline();
    const o = r.body.order; const rz = o.paymentCheckout.razorpayOrderId;
    const pay = customerPays(rz);
    await webhook(capturedEvent(pay));
    const before = fake.refunds.length;

    const c1 = await api().post(`/api/v1/orders/${o.id}/cancel`).set(auth(customerToken)).send({ reason: 'changed mind' });
    expect(c1.status).toBe(200);
    expect(fake.refunds.length - before).toBe(1);
    expect(fake.refunds.at(-1).amount).toBe(o.totalPaise);
    let p = await dbPay(o.id);
    expect(p.status).toBe('PAID');            // NOT refunded until Razorpay confirms
    expect(p.refundStatus).toBe('PENDING');

    const c2 = await api().post(`/api/v1/orders/${o.id}/cancel`).set(auth(customerToken)).send({});
    expect([200, 409]).toContain(c2.status);
    expect(fake.refunds.length - before).toBe(1); // no second refund

    await webhook({ event: 'refund.processed', payload: { refund: { entity: { id: p.refundId, payment_id: pay.id, amount: o.totalPaise, status: 'processed' } } } });
    p = await dbPay(o.id);
    expect(p.status).toBe('REFUNDED');
    expect((await dbOrder(o.id)).paymentStatus).toBe('REFUNDED');
    fake.refundStatus = 'processed';
  });

  it('money that arrives for an already-cancelled order is refunded automatically', async () => {
    const r = await placeOnline();
    const o = r.body.order; const rz = o.paymentCheckout.razorpayOrderId;
    await api().post(`/api/v1/orders/${o.id}/cancel`).set(auth(customerToken)).send({});
    expect((await dbOrder(o.id)).status).toBe('CANCELLED');
    const before = fake.refunds.length;
    await webhook(capturedEvent(customerPays(rz)));
    expect(fake.refunds.length - before).toBe(1);
    expect((await dbPay(o.id)).status).toBe('REFUNDED');
  });

  it('sweeper cancels abandoned online orders but leaves ones that were actually paid', async () => {
    const abandoned = (await placeOnline()).body.order;
    const paid = (await placeOnline()).body.order;
    customerPays(paid.paymentCheckout.razorpayOrderId); // captured at Razorpay; our webhook "was missed"
    const old = new Date(Date.now() - 60 * 60_000);
    await db.update(schema.orders).set({ placedAt: old })
      .where(drizzle.inArray(schema.orders.id, [abandoned.id, paid.id]));

    await sweeper.expireUnpaidOnlineOrders();
    expect((await dbOrder(abandoned.id)).status).toBe('CANCELLED');
    expect((await dbOrder(paid.id)).status).toBe('PLACED');
    expect((await dbPay(paid.id)).status).toBe('PAID');
  });

  it('another customer cannot verify or retry someone else\'s order', async () => {
    const o = (await placeOnline()).body.order;
    const r2 = await api().post('/api/v1/auth/login').send({ email: 'customer2@dorahaeats.local', password: 'Doraha@123' });
    const t2 = r2.body.token;
    const res = await api().post(`/api/v1/orders/${o.id}/payment/retry`).set(auth(t2));
    expect(res.status).toBe(404);
  });
});
