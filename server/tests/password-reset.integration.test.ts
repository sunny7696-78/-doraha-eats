/**
 * Password reset against a real Postgres, with the email provider faked (captures the mail).
 *   TEST_DATABASE_URL=postgres://postgres@localhost:5433/doraha_test npm test
 */
import { describe, it, expect, beforeAll, vi, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import request from 'supertest';

const URL_ = process.env.TEST_DATABASE_URL;
const h = vi.hoisted(() => ({ mails: [] as Array<{ to: string; subject: string; text: string }>, configured: true, fail: false }));

vi.mock('../src/adapters/email/index.js', () => ({
  emailProvider: {
    isConfigured: () => h.configured,
    send: async (to: string, subject: string, text: string) => {
      if (h.fail) throw new Error('smtp down');
      h.mails.push({ to, subject, text });
    },
  },
}));

describe.skipIf(!URL_)('password reset (integration)', () => {
  let app: any; let db: any; let schema: any; let dz: any;
  const api = () => request(app);
  const uniq = () => crypto.randomBytes(5).toString('hex');
  const OLD = 'oldpassword123'; const NEW = 'brand-new-pass-456';

  async function newUser() {
    const email = `${uniq()}@example.com`;
    const r = await api().post('/api/v1/auth/register').send({ fullName: 'Reset Tester', email, password: OLD });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return { email, id: r.body.user.id as string, token: r.body.token as string };
  }
  const forgot = (email: string) => api().post('/api/v1/auth/password/forgot').send({ email });
  /** Pulls uid + token out of the link in the captured email. */
  const linkOf = (mail: { text: string }) => {
    const m = mail.text.match(/reset-password\?uid=([0-9a-f-]{36})&token=([a-f0-9]{64})/);
    expect(m, mail.text).toBeTruthy();
    return { uid: m![1], token: m![2] };
  };
  const reset = (uid: string, token: string, newPassword = NEW) =>
    api().post('/api/v1/auth/password/reset').send({ userId: uid, token, newPassword });
  const login = (email: string, password: string) => api().post('/api/v1/auth/login').send({ email, password });
  const row = async (id: string) => (await db.select().from(schema.users).where(dz.eq(schema.users.id, id)))[0];

  beforeAll(async () => {
    process.env.DATABASE_URL = URL_; process.env.NODE_ENV = 'test';
    process.env.JWT_SECRET = 'integration-test-secret-integration-test';
    process.env.APP_URL = 'https://api.example.com/';
    dz = await import('drizzle-orm');
    ({ db } = await import('../src/db/index.js'));
    schema = await import('../src/db/schema.js');
    app = (await import('../src/app.js')).createApp();
  });
  beforeEach(() => { h.mails.length = 0; h.configured = true; h.fail = false; });

  it('sends a link by email; only a hash of the token is stored', async () => {
    const u = await newUser();
    const r = await forgot(u.email);
    expect(r.status).toBe(200); expect(r.body).toEqual({ sent: true });
    expect(h.mails).toHaveLength(1);
    expect(h.mails[0].to).toBe(u.email);
    const { token } = linkOf(h.mails[0]);
    expect(h.mails[0].text).toContain('https://api.example.com/reset-password?uid=');
    const stored = await row(u.id);
    expect(stored.passwordResetTokenHash).not.toBe(token);
    expect(stored.passwordResetTokenHash).toBe(crypto.createHash('sha256').update(token).digest('hex'));
  });

  it('gives the SAME answer for unknown emails and sends nothing (no account enumeration)', async () => {
    const known = await newUser();
    const a = await forgot(known.email); const b = await forgot(`nobody-${uniq()}@example.com`);
    expect(b.status).toBe(a.status); expect(b.body).toEqual(a.body);
    expect(h.mails).toHaveLength(1);
  });

  it('email lookup is case-insensitive', async () => {
    const u = await newUser();
    await forgot(u.email.toUpperCase());
    expect(h.mails).toHaveLength(1);
  });

  it('a valid link resets the password: new works, old fails, old sessions are logged out', async () => {
    const u = await newUser();
    await forgot(u.email);
    const { uid, token } = linkOf(h.mails[0]);
    expect((await api().get('/api/v1/auth/me').set('Authorization', `Bearer ${u.token}`)).status).toBe(200);
    const r = await reset(uid, token);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await login(u.email, NEW)).status).toBe(200);
    expect((await login(u.email, OLD)).status).toBe(401);
    expect((await api().get('/api/v1/auth/me').set('Authorization', `Bearer ${u.token}`)).status).toBe(401);
  });

  it('a link works once; wrong token, wrong user and expired links are refused', async () => {
    const u = await newUser(); const other = await newUser();
    await forgot(u.email);
    const { uid, token } = linkOf(h.mails[0]);
    expect((await reset(uid, 'a'.repeat(64))).body.error.code).toBe('RESET_INVALID');
    expect((await reset(other.id, token)).status).toBe(400);
    expect((await reset(uid, token)).status).toBe(200);
    expect((await reset(uid, token, 'another-new-pass-789')).status).toBe(400);   // already used

    const e = await newUser(); h.mails.length = 0;
    await forgot(e.email);
    const l2 = linkOf(h.mails[0]);
    await db.update(schema.users).set({ passwordResetExpiresAt: new Date(Date.now() - 1000) }).where(dz.eq(schema.users.id, e.id));
    expect((await reset(l2.uid, l2.token)).body.error.code).toBe('RESET_EXPIRED');
  });

  it('two simultaneous uses of one link: exactly one wins', async () => {
    const u = await newUser(); await forgot(u.email);
    const { uid, token } = linkOf(h.mails[0]);
    const rs = await Promise.all([1, 2, 3].map((i) => reset(uid, token, `parallel-pass-${i}-xyz`)));
    expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
  });

  it('enforces the 8-character minimum and a one-email-per-minute cooldown', async () => {
    const u = await newUser(); await forgot(u.email);
    const { uid, token } = linkOf(h.mails[0]);
    expect((await reset(uid, token, 'short')).status).toBe(400);
    await forgot(u.email);                       // within a minute: silently ignored
    expect(h.mails).toHaveLength(1);
    // the original link is still valid after a rejected attempt
    expect((await reset(uid, token)).status).toBe(200);
  });

  it('suspended accounts get no email', async () => {
    const u = await newUser();
    await db.update(schema.users).set({ status: 'SUSPENDED' }).where(dz.eq(schema.users.id, u.id));
    await forgot(u.email);
    expect(h.mails).toHaveLength(0);
  });

  it('reports a setup problem (no email provider) without revealing anything about accounts', async () => {
    h.configured = false;
    const u = await newUser();
    expect((await forgot(u.email)).status).toBe(503);
    expect((await forgot(`nobody-${uniq()}@example.com`)).status).toBe(503);
  });

  it('an email outage does not change the answer or leak that the account exists', async () => {
    h.fail = true;
    const u = await newUser();
    const a = await forgot(u.email); const b = await forgot(`nobody-${uniq()}@example.com`);
    expect(a.status).toBe(200); expect(a.body).toEqual(b.body);
  });

  describe('the web page behind the email link', () => {
    it('shows the form, escapes input, and sets no-cache + no-referrer headers', async () => {
      const u = await newUser(); await forgot(u.email);
      const { uid, token } = linkOf(h.mails[0]);
      const page = await api().get(`/reset-password?uid=${uid}&token=${token}`);
      expect(page.status).toBe(200);
      expect(page.text).toContain('name="password"');
      expect(page.headers['cache-control']).toBe('no-store');
      expect(page.headers['referrer-policy']).toBe('no-referrer');
      const bad = await api().get('/reset-password?uid="><script>alert(1)</script>&token=x');
      expect(bad.status).toBe(400);
      expect(bad.text).not.toContain('<script>alert');
    });

    it('submitting the form resets the password', async () => {
      const u = await newUser(); await forgot(u.email);
      const { uid, token } = linkOf(h.mails[0]);
      const done = await api().post('/reset-password').type('form').send({ uid, token, password: NEW });
      expect(done.status).toBe(200);
      expect(done.text).toContain('Password updated');
      expect((await login(u.email, NEW)).status).toBe(200);
      const again = await api().post('/reset-password').type('form').send({ uid, token, password: 'x-another-pass-1' });
      expect(again.status).toBe(400);
    });

    it('a too-short password re-shows the form without using up the link', async () => {
      const u = await newUser(); await forgot(u.email);
      const { uid, token } = linkOf(h.mails[0]);
      const r = await api().post('/reset-password').type('form').send({ uid, token, password: 'short' });
      expect(r.status).toBe(400); expect(r.text).toContain('at least 8');
      expect((await reset(uid, token)).status).toBe(200);
    });
  });
});
