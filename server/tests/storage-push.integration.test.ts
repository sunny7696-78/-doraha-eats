/**
 * Storage + push tests. Storage URL signing is checked offline (no AWS needed); push runs
 * against a real Postgres with a fake Expo. Needs TEST_DATABASE_URL for the DB-backed parts.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';

const URL_ = process.env.TEST_DATABASE_URL;

describe.skipIf(!URL_)('storage & push (integration)', () => {
  let app: any; let db: any; let schema: any; let dz: any; let storage: any; let push: any; let notif: any;
  const api = () => request(app);
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const T: Record<string, string> = {}; const ID: Record<string, string> = {};
  let vendor1: any; let vendor2: any; let item1: string;
  const expoCalls: any[] = [];
  let expoReply: (batch: any[]) => any = (b) => ({ data: b.map(() => ({ status: 'ok' })) });

  async function login(email: string) {
    const r = await api().post('/api/v1/auth/login').send({ email, password: 'Doraha@123' });
    expect(r.status, JSON.stringify(r.body)).toBe(200); return r.body;
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = URL_; process.env.NODE_ENV = 'test';
    process.env.JWT_SECRET = 'integration-test-secret-integration-test';
    process.env.STORAGE_PROVIDER = 's3'; process.env.S3_BUCKET = 'doraha-test';
    process.env.S3_REGION = 'ap-south-1'; process.env.S3_ACCESS_KEY_ID = 'AKIATESTKEY';
    process.env.S3_SECRET_ACCESS_KEY = 'secret-secret-secret'; process.env.S3_PUBLIC_BASE_URL = 'https://cdn.example.com/';
    process.env.PUSH_PROVIDER = 'expo';
    const real = globalThis.fetch;
    vi.stubGlobal('fetch', async (url: any, init: any = {}) => {
      if (String(url).startsWith('https://exp.host/')) {
        const batch = JSON.parse(init.body); expoCalls.push(batch);
        return new Response(JSON.stringify(expoReply(batch)), { status: 200 });
      }
      return real(url, init);
    });
    dz = await import('drizzle-orm');
    ({ db } = await import('../src/db/index.js'));
    schema = await import('../src/db/schema.js');
    storage = await import('../src/adapters/storage/index.js');
    push = await import('../src/adapters/push/index.js');
    notif = await import('../src/services/notification.service.js');
    app = (await import('../src/app.js')).createApp();

    for (const [k, e] of [['c1', 'customer@dorahaeats.local'], ['c2', 'customer2@dorahaeats.local']] as const) {
      const r = await login(e); T[k] = r.token; ID[k] = r.user.id;
    }
    [vendor1] = await db.select().from(schema.vendors).where(dz.like(schema.vendors.name, '%Sharma Burger%'));
    [vendor2] = await db.select().from(schema.vendors).where(dz.and(dz.ne(schema.vendors.id, vendor1.id), dz.eq(schema.vendors.status, 'ACTIVE')));
    const owner = async (id: string) => (await db.select().from(schema.users).where(dz.eq(schema.users.id, id)))[0].email;
    T.v1 = (await login(await owner(vendor1.ownerUserId))).token;
    T.v2 = (await login(await owner(vendor2.ownerUserId))).token;
    [{ id: item1 }] = await db.select().from(schema.foodItems).where(dz.eq(schema.foodItems.vendorId, vendor1.id)).limit(1);
  });
  afterAll(() => { vi.unstubAllGlobals(); });

  describe('S3 storage', () => {
    const sign = (token: string, body: object) => api().post('/api/v1/vendor/uploads/sign').set(auth(token)).send(body);

    it('returns a short-lived signed PUT whose signature covers content-type AND size', async () => {
      const r = await sign(T.v1, { filename: '../../x.png', contentType: 'image/png', sizeBytes: 123456 });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      const u = new URL(r.body.uploadUrl);
      expect(u.hostname).toContain('doraha-test');
      expect(u.searchParams.get('X-Amz-Expires')).toBe('300');
      expect(u.searchParams.get('X-Amz-SignedHeaders')).toMatch(/content-length/);
      expect(u.searchParams.get('X-Amz-SignedHeaders')).toMatch(/content-type/);
      expect(r.body.method).toBe('PUT');
      expect(r.body.headers['Content-Length']).toBe('123456');
      expect(r.body.publicUrl).toMatch(new RegExp(`^https://cdn\\.example\\.com/vendors/${vendor1.id}/[0-9a-f-]{36}\\.png$`));
      expect(JSON.stringify(r.body)).not.toContain('secret-secret-secret');
    });

    it('rejects missing, zero, oversized sizes and non-image types', async () => {
      expect((await sign(T.v1, { contentType: 'image/png' })).status).toBe(400);
      expect((await sign(T.v1, { contentType: 'image/png', sizeBytes: 0 })).status).toBe(400);
      expect((await sign(T.v1, { contentType: 'image/png', sizeBytes: 6 * 1024 * 1024 })).status).toBe(400);
      expect((await sign(T.v1, { contentType: 'text/html', sizeBytes: 100 })).status).toBe(400);
    });

    it('vendors can only save image URLs issued to them', async () => {
      const mine = (await sign(T.v1, { contentType: 'image/webp', sizeBytes: 5000 })).body.publicUrl;
      const ok = await api().patch(`/api/v1/vendor/menu/items/${item1}`).set(auth(T.v1)).send({ imageUrl: mine });
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);

      for (const evil of [
        'https://evil.example.org/x.png',
        `https://cdn.example.com/vendors/${vendor2.id}/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.png`,   // another vendor's folder
        `https://cdn.example.com/vendors/${vendor1.id}/../${vendor2.id}/x.png`,
        'javascript:alert(1)',
      ]) {
        const r = await api().patch(`/api/v1/vendor/menu/items/${item1}`).set(auth(T.v1)).send({ imageUrl: evil });
        expect(r.status, evil).toBe(400);
        expect(r.body.error.code).toBe('INVALID_IMAGE_URL');
      }
      const logo = await api().patch('/api/v1/vendor/me').set(auth(T.v1)).send({ logoUrl: 'https://evil.example.org/l.png' });
      expect(logo.status).toBe(400);
    });

    it("a vendor cannot put an item into another vendor's menu section", async () => {
      const [sec] = await db.select().from(schema.menuSections).where(dz.eq(schema.menuSections.vendorId, vendor2.id)).limit(1);
      if (!sec) return;
      const r = await api().patch(`/api/v1/vendor/menu/items/${item1}`).set(auth(T.v1)).send({ sectionId: sec.id });
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe('INVALID_SECTION');
    });

    it('isOwnUploadUrl: empty clears are allowed, prefix tricks are not', () => {
      expect(storage.isOwnUploadUrl('abc', '')).toBe(true);
      expect(storage.isOwnUploadUrl('abc', 'https://cdn.example.com/vendors/abcd/x.png')).toBe(false);
      expect(storage.isOwnUploadUrl('abc', 'https://cdn.example.com/vendors/abc/x.png')).toBe(true);
    });
  });

  describe('push notifications', () => {
    const reg = (t: string, token: string) =>
      api().post('/api/v1/auth/device-token').set(auth(t)).send({ token, platform: 'android' });
    const tokensOf = async (uid: string) =>
      (await db.select().from(schema.deviceTokens).where(dz.eq(schema.deviceTokens.userId, uid))).map((r: any) => r.token);
    const note = (uid: string) => notif.notify({ userId: uid, type: 'TEST', title: 'Hello', body: 'World', data: { orderId: 'o1' } });
    const TOKEN = 'ExponentPushToken[abc123_shared-phone]';

    it('sends via Expo in the right shape, with the order data', async () => {
      expoCalls.length = 0;
      await db.delete(schema.deviceTokens).where(dz.eq(schema.deviceTokens.userId, ID.c1));
      await reg(T.c1, 'ExponentPushToken[c1_device_1]');
      await note(ID.c1);
      expect(expoCalls).toHaveLength(1);
      expect(expoCalls[0][0]).toMatchObject({ to: 'ExponentPushToken[c1_device_1]', title: 'Hello', body: 'World', data: { orderId: 'o1' } });
    });

    it('a shared phone: the NEW user gets the token, the previous user stops receiving pushes on it', async () => {
      await reg(T.c1, TOKEN);
      expect(await tokensOf(ID.c1)).toContain(TOKEN);
      await reg(T.c2, TOKEN);                       // second account logs in on the same phone
      expect(await tokensOf(ID.c2)).toContain(TOKEN);
      expect(await tokensOf(ID.c1)).not.toContain(TOKEN);
      expoCalls.length = 0;
      await note(ID.c1);
      expect(expoCalls.flat().some((m: any) => m.to === TOKEN)).toBe(false);
    });

    it('ignores malformed tokens instead of sending them', async () => {
      expoCalls.length = 0;
      await db.insert(schema.deviceTokens).values({ userId: ID.c2, token: 'not-an-expo-token', platform: 'android' }).onConflictDoNothing();
      await note(ID.c2);
      expect(expoCalls.flat().some((m: any) => m.to === 'not-an-expo-token')).toBe(false);
      await db.delete(schema.deviceTokens).where(dz.eq(schema.deviceTokens.token, 'not-an-expo-token'));
    });

    it('removes a token when Expo reports DeviceNotRegistered', async () => {
      const dead = 'ExponentPushToken[dead_device_9]';
      await reg(T.c2, dead);
      expoReply = (batch) => ({ data: batch.map((m: any) => m.to === dead
        ? { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } } : { status: 'ok' }) });
      await note(ID.c2);
      expoReply = (b) => ({ data: b.map(() => ({ status: 'ok' })) });
      expect(await tokensOf(ID.c2)).not.toContain(dead);
      expect(await tokensOf(ID.c2)).toContain(TOKEN);   // healthy tokens are kept
    });

    it('a push outage never breaks the caller, and the in-app notification is still saved', async () => {
      expoReply = () => { throw new Error('expo is down'); };
      const before = (await db.select().from(schema.notifications).where(dz.eq(schema.notifications.userId, ID.c2))).length;
      await expect(note(ID.c2)).resolves.toBeUndefined();
      expoReply = (b) => ({ data: b.map(() => ({ status: 'ok' })) });
      const after = (await db.select().from(schema.notifications).where(dz.eq(schema.notifications.userId, ID.c2))).length;
      expect(after).toBe(before + 1);
    });

    it('logout removes the user\'s device tokens', async () => {
      const u = await login('customer3@dorahaeats.local');
      await reg(u.token, 'ExponentPushToken[c3_device_1]');
      expect(await tokensOf(u.user.id)).toHaveLength(1);
      await api().post('/api/v1/auth/logout').set(auth(u.token));
      expect(await tokensOf(u.user.id)).toHaveLength(0);
    });
  });
});
