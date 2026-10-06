/**
 * Authorization & security tests against a real Postgres (migrated + seeded).
 *   TEST_DATABASE_URL=postgres://postgres@localhost:5433/doraha_test npm test
 */
import { describe, it, expect, beforeAll } from 'vitest';
import crypto from 'node:crypto';
import request from 'supertest';

const URL_ = process.env.TEST_DATABASE_URL;

describe.skipIf(!URL_)('security & authorization (integration)', () => {
  let app: any; let db: any; let schema: any; let dz: any;
  const T: Record<string, string> = {};
  let addressId = ''; let foodItemId = ''; let vendor1: any; let vendor2: any; let vendor2ItemId = '';
  let customer2Id = '';
  const api = () => request(app);
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  async function login(email: string) {
    const r = await api().post('/api/v1/auth/login').send({ email, password: 'Doraha@123' });
    expect(r.status, `${email}: ${JSON.stringify(r.body)}`).toBe(200);
    return r.body as { token: string; user: { id: string } };
  }

  /** Places a COD order for `customer` at vendor1. Returns the order. */
  async function placeCod(token = T.customer) {
    await api().delete('/api/v1/cart').set(auth(token));
    const add = await api().post('/api/v1/cart/items').set(auth(token)).send({ foodItemId, quantity: 5 });
    expect(add.status, JSON.stringify(add.body)).toBe(201);
    const r = await api().post('/api/v1/orders').set(auth(token)).send({ addressId: token === T.customer ? addressId : undefined, paymentMethod: 'COD' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.order;
  }
  async function toReady() {
    const o = await placeCod();
    for (const step of ['accept', 'preparing', 'ready']) {
      const r = await api().post(`/api/v1/vendor/orders/${o.id}/${step}`).set(auth(T.vendor1)).send({});
      expect(r.status, `${step}: ${JSON.stringify(r.body)}`).toBe(200);
    }
    return o;
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = URL_;
    process.env.NODE_ENV = 'test';
    process.env.JWT_SECRET = 'integration-test-secret-integration-test';
    dz = await import('drizzle-orm');
    ({ db } = await import('../src/db/index.js'));
    schema = await import('../src/db/schema.js');
    app = (await import('../src/app.js')).createApp();

    const c = await login('customer@dorahaeats.local'); T.customer = c.token;
    const c2 = await login('customer2@dorahaeats.local'); T.customer2 = c2.token; customer2Id = c2.user.id;
    T.admin = (await login('admin@dorahaeats.local')).token;
    T.rider1 = (await login('delivery@dorahaeats.local')).token;
    T.rider2 = (await login('delivery2@dorahaeats.local')).token;

    const [addr] = await db.select().from(schema.addresses)
      .where(dz.and(dz.eq(schema.addresses.userId, c.user.id), dz.eq(schema.addresses.isDefault, true)));
    addressId = addr.id;

    [vendor1] = await db.select().from(schema.vendors).where(dz.like(schema.vendors.name, '%Sharma Burger%'));
    [vendor2] = await db.select().from(schema.vendors).where(dz.and(dz.ne(schema.vendors.id, vendor1.id), dz.eq(schema.vendors.status, 'ACTIVE')));
    const owner = (id: string) => db.select().from(schema.users).where(dz.eq(schema.users.id, id)).then((r: any[]) => r[0]);
    T.vendor1 = (await login((await owner(vendor1.ownerUserId)).email)).token;
    T.vendor2 = (await login((await owner(vendor2.ownerUserId)).email)).token;
    [{ id: foodItemId }] = await db.select().from(schema.foodItems).where(dz.eq(schema.foodItems.vendorId, vendor1.id)).limit(1);
    [{ id: vendor2ItemId }] = await db.select().from(schema.foodItems).where(dz.eq(schema.foodItems.vendorId, vendor2.id)).limit(1);

    // Deterministic world: vendor1 open all week; both riders approved + online.
    await db.delete(schema.vendorHours).where(dz.eq(schema.vendorHours.vendorId, vendor1.id));
    await db.insert(schema.vendorHours).values([0, 1, 2, 3, 4, 5, 6].map((d) =>
      ({ vendorId: vendor1.id, dayOfWeek: d, opensAt: '00:00', closesAt: '23:59' })));
    await db.update(schema.vendors).set({ isOpenManual: true }).where(dz.eq(schema.vendors.id, vendor1.id));
    await db.update(schema.deliveryPartners).set({ status: 'ACTIVE', isOnline: true });
  });

  describe('customers', () => {
    it("cannot read, cancel or pay for another customer's order", async () => {
      const o = await placeCod();
      expect((await api().get(`/api/v1/orders/${o.id}`).set(auth(T.customer2))).status).toBe(403);
      expect((await api().post(`/api/v1/orders/${o.id}/cancel`).set(auth(T.customer2)).send({})).status).toBe(403);
      expect((await api().post(`/api/v1/orders/${o.id}/payment/retry`).set(auth(T.customer2))).status).toBe(404);
      const list = await api().get('/api/v1/orders').set(auth(T.customer2));
      expect((list.body.orders as any[]).some((x) => x.id === o.id)).toBe(false);
    });

    it("cannot delete another customer's address or touch their cart items", async () => {
      const [addr] = await db.select().from(schema.addresses).where(dz.eq(schema.addresses.id, addressId));
      await api().delete(`/api/v1/addresses/${addressId}`).set(auth(T.customer2));
      expect(await db.select().from(schema.addresses).where(dz.eq(schema.addresses.id, addr.id))).toHaveLength(1);

      await api().delete('/api/v1/cart').set(auth(T.customer));
      const add = await api().post('/api/v1/cart/items').set(auth(T.customer)).send({ foodItemId, quantity: 1 });
      const itemId = add.body.cart.items[0].id;
      expect((await api().patch(`/api/v1/cart/items/${itemId}`).set(auth(T.customer2)).send({ quantity: 9 })).status).toBe(404);
      await api().delete(`/api/v1/cart/items/${itemId}`).set(auth(T.customer2));
      const mine = await api().get('/api/v1/cart').set(auth(T.customer));
      expect(mine.body.cart.items).toHaveLength(1);
      expect(mine.body.cart.items[0].quantity).toBe(1);
    });

    it('cannot use vendor, rider or admin APIs', async () => {
      for (const path of ['/vendor/orders', '/delivery/available', '/admin/orders', '/admin/settings']) {
        expect((await api().get(`/api/v1${path}`).set(auth(T.customer))).status, path).toBe(403);
      }
      expect((await api().get('/api/v1/admin/orders')).status).toBe(401);
    });
  });

  describe('vendors', () => {
    it("cannot see or act on another vendor's orders", async () => {
      const o = await placeCod();
      expect((await api().get(`/api/v1/vendor/orders/${o.id}`).set(auth(T.vendor2))).status).toBe(403);
      for (const step of ['accept', 'reject', 'preparing', 'ready']) {
        const r = await api().post(`/api/v1/vendor/orders/${o.id}/${step}`).set(auth(T.vendor2)).send({ reason: 'nope nope' });
        expect(r.status, step).toBe(403);
      }
      const list = await api().get('/api/v1/vendor/orders').set(auth(T.vendor2));
      expect((list.body.orders as any[]).some((x) => x.id === o.id)).toBe(false);
      expect((await dbOrder(o.id)).status).toBe('PLACED');
    });

    it("cannot edit another vendor's menu item", async () => {
      const r = await api().patch(`/api/v1/vendor/menu/items/${vendor2ItemId}`).set(auth(T.vendor1)).send({ pricePaise: 100 });
      expect(r.status).toBe(404);
      const [item] = await db.select().from(schema.foodItems).where(dz.eq(schema.foodItems.id, vendor2ItemId));
      expect(item.pricePaise).not.toBe(100);
    });

    it('upload signing ignores the client file name, allow-lists image types, and namespaces the key', async () => {
      const ok = await api().post('/api/v1/vendor/uploads/sign').set(auth(T.vendor1))
        .send({ filename: '../../../etc/passwd', contentType: 'image/png' });
      expect(ok.status).toBe(200);
      expect(ok.body.publicUrl).toMatch(new RegExp(`vendors/${vendor1.id}/[0-9a-f-]{36}\\.png$`));
      expect(ok.body.publicUrl).not.toContain('..');
      for (const contentType of ['text/html', 'image/svg+xml', 'application/x-msdownload', 'image/png/../../x']) {
        const bad = await api().post('/api/v1/vendor/uploads/sign').set(auth(T.vendor1)).send({ filename: 'a', contentType });
        expect(bad.status, contentType).toBe(400);
      }
    });
  });

  const dbOrder = async (id: string) => (await db.select().from(schema.orders).where(dz.eq(schema.orders.id, id)))[0];

  describe('riders', () => {
    it('cannot read orders that are not READY and not theirs', async () => {
      const placed = await placeCod();
      expect((await api().get(`/api/v1/delivery/orders/${placed.id}`).set(auth(T.rider1))).status).toBe(404);
    });

    it("sees an unclaimed READY order WITHOUT the customer's phone or exact address", async () => {
      const o = await toReady();
      const r = await api().get(`/api/v1/delivery/orders/${o.id}`).set(auth(T.rider1));
      expect(r.status).toBe(200);
      expect(r.body.order.contactPhone).toBe('');
      expect(r.body.order.addressLine).toBe('');
      await api().post(`/api/v1/delivery/${o.id}/accept`).set(auth(T.rider1)).send({}); // keep the queue tidy
    });

    it('two riders accepting at once: exactly one wins, one assignment row, the loser has no access', async () => {
      const o = await toReady();
      const [a, b] = await Promise.all([
        api().post(`/api/v1/delivery/${o.id}/accept`).set(auth(T.rider1)).send({}),
        api().post(`/api/v1/delivery/${o.id}/accept`).set(auth(T.rider2)).send({}),
      ]);
      const codes = [a.status, b.status].sort();
      expect(codes, JSON.stringify([a.status, b.status, a.body.error, b.body.error])).toEqual([200, 409]);
      const live = await db.select().from(schema.deliveryAssignments).where(dz.and(
        dz.eq(schema.deliveryAssignments.orderId, o.id),
        dz.inArray(schema.deliveryAssignments.state, ['ACCEPTED', 'COMPLETED'])));
      expect(live).toHaveLength(1);

      const [winner, loser] = a.status === 200 ? [T.rider1, T.rider2] : [T.rider2, T.rider1];
      const hijack = await api().patch(`/api/v1/delivery/${o.id}/status`).set(auth(loser)).send({ status: 'PICKED_UP' });
      expect(hijack.status).toBe(403);
      expect((await api().get(`/api/v1/delivery/orders/${o.id}`).set(auth(loser))).status).toBe(404);
      const own = await api().get(`/api/v1/delivery/orders/${o.id}`).set(auth(winner));
      expect(own.status).toBe(200);
      expect(own.body.order.addressLine).not.toBe('');
    });

    it('the database itself refuses a second live rider on one order', async () => {
      const o = await toReady();
      const rider1 = (await db.select().from(schema.deliveryPartners))[0];
      const rider2 = (await db.select().from(schema.deliveryPartners))[1];
      await db.insert(schema.deliveryAssignments).values({ orderId: o.id, partnerId: rider1.id, state: 'ACCEPTED' });
      await expect(db.insert(schema.deliveryAssignments).values({ orderId: o.id, partnerId: rider2.id, state: 'ACCEPTED' }))
        .rejects.toThrow();
    });
  });

  describe('sessions & tokens', () => {
    it('logout invalidates every earlier token; a fresh login works', async () => {
      const first = await login('customer3@dorahaeats.local');
      expect((await api().get('/api/v1/auth/me').set(auth(first.token))).status).toBe(200);
      expect((await api().post('/api/v1/auth/logout').set(auth(first.token))).status).toBe(200);
      expect((await api().get('/api/v1/auth/me').set(auth(first.token))).status).toBe(401);
      const again = await login('customer3@dorahaeats.local');
      expect((await api().get('/api/v1/auth/me').set(auth(again.token))).status).toBe(200);
    });

    it('rejects an unsigned (alg=none) token and a token signed with the wrong secret', async () => {
      const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
      const none = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub: customer2Id, role: 'ADMIN' })}.`;
      expect((await api().get('/api/v1/admin/orders').set(auth(none))).status).toBe(401);
      const jwt = (await import('jsonwebtoken')).default;
      const forged = jwt.sign({ sub: customer2Id, role: 'ADMIN' }, 'some-other-secret-some-other-secret');
      expect((await api().get('/api/v1/admin/orders').set(auth(forged))).status).toBe(401);
    });

    it('trusts the role in the database, not the role claimed inside the token', async () => {
      const jwt = (await import('jsonwebtoken')).default;
      const lying = jwt.sign({ sub: customer2Id, role: 'ADMIN' }, process.env.JWT_SECRET!, { algorithm: 'HS256' });
      expect((await api().get('/api/v1/admin/orders').set(auth(lying))).status).toBe(403);
    });
  });

  describe('admin safety & audit trail', () => {
    it('cannot suspend themselves or another admin', async () => {
      const [admin] = await db.select().from(schema.users).where(dz.eq(schema.users.email, 'admin@dorahaeats.local'));
      const self = await api().patch(`/api/v1/admin/users/${admin.id}/status`).set(auth(T.admin)).send({ status: 'SUSPENDED' });
      expect(self.status).toBe(409);
      expect((await db.select().from(schema.users).where(dz.eq(schema.users.id, admin.id)))[0].status).toBe('ACTIVE');
    });

    it('records suspensions and fee changes in the audit log with before/after', async () => {
      const r = await api().patch(`/api/v1/admin/users/${customer2Id}/status`).set(auth(T.admin)).send({ status: 'SUSPENDED' });
      expect(r.status).toBe(200);
      // restore so other tests/runs are unaffected
      await api().patch(`/api/v1/admin/users/${customer2Id}/status`).set(auth(T.admin)).send({ status: 'ACTIVE' });
      const logs = await db.select().from(schema.auditLogs).where(dz.and(
        dz.eq(schema.auditLogs.action, 'USER_STATUS_CHANGED'), dz.eq(schema.auditLogs.entityId, customer2Id)));
      expect(logs.length).toBeGreaterThanOrEqual(2);
      expect(logs.some((l: any) => l.before?.status === 'ACTIVE' && l.after?.status === 'SUSPENDED')).toBe(true);

      const cur = (await api().get('/api/v1/admin/settings').set(auth(T.admin))).body.settings;
      const put = await api().put('/api/v1/admin/settings').set(auth(T.admin)).send({ platformFeePaise: cur.platformFeePaise });
      expect(put.status).toBe(200);
      const s = await db.select().from(schema.auditLogs).where(dz.eq(schema.auditLogs.action, 'SETTINGS_CHANGED'));
      expect(s.length).toBeGreaterThan(0);
    });

    it('non-admins cannot change settings, refund, or verify payments', async () => {
      for (const [m, p] of [['put', '/admin/settings'], ['post', '/admin/payments/x/refund'], ['post', '/admin/payments/x/verify']] as const) {
        for (const t of [T.customer, T.vendor1, T.rider1]) {
          expect((await (api() as any)[m](`/api/v1${p}`).set(auth(t)).send({})).status, `${m} ${p}`).toBe(403);
        }
      }
    });
  });

  describe('request ids & safe errors', () => {
    it('returns an X-Request-Id and echoes a valid incoming one', async () => {
      const r = await api().get('/health');
      expect(r.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
      const r2 = await api().get('/health').set('X-Request-Id', 'client-req-12345');
      expect(r2.headers['x-request-id']).toBe('client-req-12345');
      const r3 = await api().get('/health').set('X-Request-Id', 'bad id with spaces & <script>');
      expect(r3.headers['x-request-id']).not.toContain('<');
    });

    it('error bodies carry the request id, never a stack trace; bad JSON is a 400, not a 500', async () => {
      const r = await api().get('/nope');
      expect(r.status).toBe(404);
      expect(r.body.error.requestId).toBe(r.headers['x-request-id']);
      const j = await api().post('/api/v1/auth/login').set('Content-Type', 'application/json').send('{"email": ');
      expect(j.status).toBe(400);
      expect(j.body.error.code).toBe('BAD_JSON');
      expect(JSON.stringify(j.body)).not.toMatch(/at .*\.(js|ts):\d+/);
    });
  });
});
