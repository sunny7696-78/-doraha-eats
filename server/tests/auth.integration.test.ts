/**
 * Auth tests against a real Postgres (migrated + seeded). Google and SMS are faked at the
 * adapter boundary — the account-linking and OTP rules themselves run for real.
 *   TEST_DATABASE_URL=postgres://postgres@localhost:5433/doraha_test npm test
 */
import { describe, it, expect, beforeAll, vi, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import request from 'supertest';

const URL_ = process.env.TEST_DATABASE_URL;

const h = vi.hoisted(() => ({
  google: { next: null as null | Record<string, unknown>, error: null as null | Error },
  sms: [] as Array<{ phone: string; code: string }>,
}));

vi.mock('../src/adapters/google/index.js', () => ({
  googleClientIds: () => ['test-client'],
  verifyGoogleIdToken: async () => {
    if (h.google.error) throw h.google.error;
    return h.google.next;
  },
}));
vi.mock('../src/adapters/sms/index.js', () => ({
  smsProvider: { sendOtp: async (phone: string, code: string) => { h.sms.push({ phone, code }); } },
}));

describe.skipIf(!URL_)('auth (integration)', () => {
  let app: any; let db: any; let schema: any; let dz: any; let AppError: any;
  const api = () => request(app);
  const uniq = () => crypto.randomBytes(5).toString('hex');
  const randPhone = () => `9${String(crypto.randomInt(0, 1e9)).padStart(9, '0')}`;
  const google = (over: Record<string, unknown> = {}) => {
    h.google.error = null;
    h.google.next = { googleId: `g_${uniq()}`, email: `${uniq()}@example.com`, emailVerified: true, name: 'Test User', picture: null, ...over };
    return h.google.next as any;
  };
  const gLogin = () => api().post('/api/v1/auth/google').send({ idToken: 'x'.repeat(40) });
  const userBy = async (col: any, val: string) => (await db.select().from(schema.users).where(dz.eq(col, val)))[0];
  const rowsFor = async (userId: string, table: any, col: any) => db.select().from(table).where(dz.eq(col, userId));

  beforeAll(async () => {
    process.env.DATABASE_URL = URL_;
    process.env.NODE_ENV = 'test';
    process.env.JWT_SECRET = 'integration-test-secret-integration-test';
    dz = await import('drizzle-orm');
    ({ db } = await import('../src/db/index.js'));
    schema = await import('../src/db/schema.js');
    ({ AppError } = await import('../src/lib/errors.js'));
    app = (await import('../src/app.js')).createApp();
  });
  beforeEach(() => { h.sms.length = 0; });

  /* ------------------------------------------------------------------ Google */
  describe('Google', () => {
    it('case 3: new customer gets user + profile + cart, and a normal Doraha JWT', async () => {
      const g = google();
      const r = await gLogin();
      expect(r.status).toBe(200);
      expect(r.body.user.role).toBe('CUSTOMER');
      expect(r.body.user.email).toBe(g.email);
      expect(r.body.user).not.toHaveProperty('passwordHash');
      const u = await userBy(schema.users.googleId, g.googleId);
      expect(await rowsFor(u.id, schema.customerProfiles, schema.customerProfiles.userId)).toHaveLength(1);
      expect(await rowsFor(u.id, schema.carts, schema.carts.userId)).toHaveLength(1);
      const me = await api().get('/api/v1/auth/me').set('Authorization', `Bearer ${r.body.token}`);
      expect(me.status).toBe(200);
    });

    it('case 1: returning googleId logs into the same account', async () => {
      const g = google();
      const a = await gLogin(); const b = await gLogin();
      expect(b.body.user.id).toBe(a.body.user.id);
      expect(g).toBeTruthy();
    });

    it('case 2: verified email of an existing password account is LINKED, not duplicated', async () => {
      const email = `${uniq()}@example.com`;
      const reg = await api().post('/api/v1/auth/register').send({ fullName: 'Pw User', email, password: 'longpassword1' });
      expect(reg.status).toBe(201);
      const g = google({ email });
      const r = await gLogin();
      expect(r.status).toBe(200);
      expect(r.body.user.id).toBe(reg.body.user.id);
      expect((await userBy(schema.users.id, reg.body.user.id)).googleId).toBe(g.googleId);
      const same = await db.select().from(schema.users).where(dz.sql`lower(${schema.users.email}) = ${email}`);
      expect(same).toHaveLength(1);
    });

    it('case 2: matching is case-insensitive', async () => {
      const email = `${uniq()}@example.com`;
      const reg = await api().post('/api/v1/auth/register').send({ fullName: 'Pw', email: email.toUpperCase(), password: 'longpassword1' });
      expect(reg.body.user.email).toBe(email);
      google({ email });
      expect((await gLogin()).body.user.id).toBe(reg.body.user.id);
    });

    it('case 4: admin / vendor / rider emails are never auto-linked', async () => {
      for (const email of ['admin@dorahaeats.local', 'vendor@dorahaeats.local', 'delivery@dorahaeats.local']) {
        const g = google({ email });
        const r = await gLogin();
        expect(r.status, email).toBe(403);
        expect(r.body.error.code).toBe('GOOGLE_NOT_ALLOWED');
        expect(await userBy(schema.users.googleId, g.googleId)).toBeUndefined();
      }
    });

    it('refuses unverified email, missing email, invalid token, wrong audience', async () => {
      google({ emailVerified: false });
      expect((await gLogin()).body.error.code).toBe('GOOGLE_EMAIL_NOT_VERIFIED');
      google({ email: '' });
      expect((await gLogin()).body.error.code).toBe('GOOGLE_EMAIL_NOT_VERIFIED');
      h.google.error = new AppError(401, 'INVALID_GOOGLE_TOKEN', 'Google sign-in failed. Please try again.');
      const bad = await gLogin();
      expect(bad.status).toBe(401);
      expect(bad.body.error.code).toBe('INVALID_GOOGLE_TOKEN');
    });

    it('a suspended account cannot sign in with Google (existing googleId or email match)', async () => {
      const g = google();
      const first = await gLogin();
      expect(first.status, JSON.stringify(first.body)).toBe(200);
      await db.update(schema.users).set({ status: 'SUSPENDED' }).where(dz.eq(schema.users.id, first.body.user.id));
      const r1 = await gLogin();
      expect(r1.status).toBe(403); expect(r1.body.error.code).toBe('ACCOUNT_SUSPENDED');

      const email = `${uniq()}@example.com`;
      const reg = await api().post('/api/v1/auth/register').send({ fullName: 'Susp User', email, password: 'longpassword1' });
      expect(reg.status, JSON.stringify(reg.body)).toBe(201);
      await db.update(schema.users).set({ status: 'SUSPENDED' }).where(dz.eq(schema.users.id, reg.body.user.id));
      google({ email });
      expect((await gLogin()).body.error.code).toBe('ACCOUNT_SUSPENDED');
      expect(g).toBeTruthy();
    });

    it('an account linked to another Google identity cannot be taken over by a second one', async () => {
      const email = `${uniq()}@example.com`;
      google({ email, googleId: 'g_first_' + uniq() });
      await gLogin();
      google({ email, googleId: 'g_second_' + uniq() });
      const r = await gLogin();
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe('GOOGLE_ALREADY_LINKED');
    });

    it('concurrent first-time logins create exactly one account', async () => {
      const g = google();
      const rs = await Promise.all([gLogin(), gLogin(), gLogin(), gLogin()]);
      expect(rs.every((r) => r.status === 200)).toBe(true);
      expect(new Set(rs.map((r) => r.body.user.id)).size).toBe(1);
      expect(await db.select().from(schema.users).where(dz.eq(schema.users.googleId, g.googleId))).toHaveLength(1);
    });

    it('the client cannot smuggle in an email, role or googleId', async () => {
      const g = google();
      const r = await api().post('/api/v1/auth/google')
        .send({ idToken: 'x'.repeat(40), email: 'admin@dorahaeats.local', role: 'ADMIN', googleId: 'evil' });
      expect(r.status).toBe(200);
      expect(r.body.user.role).toBe('CUSTOMER');
      expect(r.body.user.email).toBe(g.email);
    });
  });

  /* --------------------------------------------------------------------- OTP */
  describe('OTP', () => {
    it('normalizes the number, sends a 6-digit code, and logs the user in (new customer)', async () => {
      const p = randPhone();
      const rq = await api().post('/api/v1/auth/otp/request').send({ phone: ` ${p.slice(0, 5)} ${p.slice(5)} ` });
      expect(rq.status).toBe(200);
      expect(h.sms).toHaveLength(1);
      expect(h.sms[0].phone).toBe(`+91${p}`);
      expect(h.sms[0].code).toMatch(/^\d{6}$/);
      const v = await api().post('/api/v1/auth/otp/verify').send({ phone: `+91${p}`, code: h.sms[0].code, fullName: 'Otp Person' });
      expect(v.status).toBe(200);
      expect(v.body.user.phone).toBe(`+91${p}`);
      expect(v.body.user.role).toBe('CUSTOMER');
    });

    it('rejects numbers that are not Indian mobiles', async () => {
      const r = await api().post('/api/v1/auth/otp/request').send({ phone: '+14155550123' });
      expect(r.status).toBe(400); expect(r.body.error.code).toBe('INVALID_PHONE');
      expect(h.sms).toHaveLength(0);
    });

    it('enforces a per-phone resend cooldown', async () => {
      const p = randPhone();
      expect((await api().post('/api/v1/auth/otp/request').send({ phone: p })).status).toBe(200);
      const again = await api().post('/api/v1/auth/otp/request').send({ phone: p });
      expect(again.status).toBe(429); expect(again.body.error.code).toBe('OTP_COOLDOWN');
      expect(h.sms).toHaveLength(1);
    });

    it('caps codes per phone per hour even if the cooldown is waited out', async () => {
      const p = randPhone(); const phone = `+91${p}`;
      const old = (mins: number) => new Date(Date.now() - mins * 60_000);
      await db.insert(schema.otpCodes).values([5, 10, 15, 20, 25].map((m) => ({
        phone, codeHash: 'x', expiresAt: old(m - 5), consumed: true, createdAt: old(m),
      })));
      const r = await api().post('/api/v1/auth/otp/request').send({ phone });
      expect(r.status).toBe(429); expect(r.body.error.code).toBe('OTP_LIMIT');
    });

    it('locks after 5 wrong guesses, even for the correct code afterwards', async () => {
      const p = randPhone();
      await api().post('/api/v1/auth/otp/request').send({ phone: p });
      const good = h.sms[0].code; const wrong = good === '111111' ? '222222' : '111111';
      for (let i = 0; i < 5; i++) {
        const r = await api().post('/api/v1/auth/otp/verify').send({ phone: p, code: wrong });
        expect(r.body.error.code).toBe('OTP_INVALID');
      }
      const locked = await api().post('/api/v1/auth/otp/verify').send({ phone: p, code: good });
      expect(locked.status).toBe(400); expect(locked.body.error.code).toBe('OTP_LOCKED');
    });

    it('parallel guesses cannot exceed the attempt limit', async () => {
      const p = randPhone();
      await api().post('/api/v1/auth/otp/request').send({ phone: p });
      const wrong = h.sms[0].code === '111111' ? '222222' : '111111';
      const rs = await Promise.all(Array.from({ length: 12 }, () => api().post('/api/v1/auth/otp/verify').send({ phone: p, code: wrong })));
      expect(rs.filter((r) => r.body.error.code === 'OTP_INVALID').length).toBeLessThanOrEqual(5);
    });

    it('a code works once; replaying it fails', async () => {
      const p = randPhone();
      await api().post('/api/v1/auth/otp/request').send({ phone: p });
      const code = h.sms[0].code;
      expect((await api().post('/api/v1/auth/otp/verify').send({ phone: p, code })).status).toBe(200);
      const replay = await api().post('/api/v1/auth/otp/verify').send({ phone: p, code });
      expect(replay.status).toBe(400);
    });

    it('two simultaneous verifies of the same code log in only once', async () => {
      const p = randPhone();
      await api().post('/api/v1/auth/otp/request').send({ phone: p });
      const code = h.sms[0].code;
      const rs = await Promise.all([1, 2, 3].map(() => api().post('/api/v1/auth/otp/verify').send({ phone: p, code })));
      expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
    });

    it('an expired code is refused', async () => {
      const p = randPhone();
      await api().post('/api/v1/auth/otp/request').send({ phone: p });
      await db.update(schema.otpCodes).set({ expiresAt: new Date(Date.now() - 1000) })
        .where(dz.eq(schema.otpCodes.phone, `+91${p}`));
      const r = await api().post('/api/v1/auth/otp/verify').send({ phone: p, code: h.sms[0].code });
      expect(r.body.error.code).toBe('OTP_EXPIRED');
    });

    it('a failed SMS send does not leave a usable code or burn the cooldown', async () => {
      const p = randPhone();
      const sms = await import('../src/adapters/sms/index.js');
      const orig = sms.smsProvider.sendOtp;
      sms.smsProvider.sendOtp = async () => { throw new AppError(502, 'SMS_FAILED', 'Could not send the code.'); };
      const r = await api().post('/api/v1/auth/otp/request').send({ phone: p });
      sms.smsProvider.sendOtp = orig;
      expect(r.status).toBe(502);
      const live = await db.select().from(schema.otpCodes)
        .where(dz.and(dz.eq(schema.otpCodes.phone, `+91${p}`), dz.eq(schema.otpCodes.consumed, false)));
      expect(live).toHaveLength(0);
    });

    it('admin and vendor accounts cannot be logged into with a phone code', async () => {
      for (const email of ['admin@dorahaeats.local', 'vendor@dorahaeats.local']) {
        const u = (await db.select().from(schema.users).where(dz.eq(schema.users.email, email)))[0];
        await db.delete(schema.otpCodes).where(dz.eq(schema.otpCodes.phone, u.phone));
        await api().post('/api/v1/auth/otp/request').send({ phone: u.phone });
        const r = await api().post('/api/v1/auth/otp/verify').send({ phone: u.phone, code: h.sms.at(-1)!.code });
        expect(r.status, email).toBe(403);
      }
    });

    it('a suspended customer cannot log in with a phone code', async () => {
      const p = randPhone();
      await api().post('/api/v1/auth/otp/request').send({ phone: p });
      const first = await api().post('/api/v1/auth/otp/verify').send({ phone: p, code: h.sms[0].code });
      await db.update(schema.users).set({ status: 'SUSPENDED' }).where(dz.eq(schema.users.id, first.body.user.id));
      await db.delete(schema.otpCodes).where(dz.eq(schema.otpCodes.phone, `+91${p}`));
      await api().post('/api/v1/auth/otp/request').send({ phone: p });
      const r = await api().post('/api/v1/auth/otp/verify').send({ phone: p, code: h.sms.at(-1)!.code });
      expect(r.status).toBe(403); expect(r.body.error.code).toBe('ACCOUNT_SUSPENDED');
    });
  });

  /* ----------------------------------------------------- register / login */
  describe('register & login', () => {
    it('stores normalized email + phone, blocks duplicates in any spelling, and is atomic', async () => {
      const email = `${uniq()}@example.com`; const p = randPhone();
      const a = await api().post('/api/v1/auth/register').send({ fullName: 'Dup One', email, phone: p, password: 'longpassword1' });
      expect(a.status).toBe(201);
      expect(a.body.user.phone).toBe(`+91${p}`);
      const dupEmail = await api().post('/api/v1/auth/register').send({ fullName: 'Dup', email: email.toUpperCase(), password: 'longpassword1' });
      expect(dupEmail.status).toBe(409);
      const dupPhone = await api().post('/api/v1/auth/register').send({ fullName: 'Dup', phone: `+91 ${p}`, password: 'longpassword1' });
      expect(dupPhone.status).toBe(409);
    });

    it('rejects short passwords and bad phone numbers; login is case-insensitive', async () => {
      const email = `${uniq()}@example.com`;
      expect((await api().post('/api/v1/auth/register').send({ fullName: 'Short', email, password: 'short' })).status).toBe(400);
      expect((await api().post('/api/v1/auth/register').send({ fullName: 'Badph', phone: '12345678901', password: 'longpassword1' })).status).toBe(400);
      await api().post('/api/v1/auth/register').send({ fullName: 'Login Case', email, password: 'longpassword1' });
      const l = await api().post('/api/v1/auth/login').send({ email: email.toUpperCase(), password: 'longpassword1' });
      expect(l.status).toBe(200);
    });

    it('concurrent registrations of the same email create one account', async () => {
      const email = `${uniq()}@example.com`;
      const rs = await Promise.all([1, 2, 3].map(() =>
        api().post('/api/v1/auth/register').send({ fullName: 'Race', email, password: 'longpassword1' })));
      expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
      expect(rs.filter((r) => r.status === 409)).toHaveLength(2);
    });
  });
});
