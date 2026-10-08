import { describe, it, expect, vi, beforeEach } from 'vitest';

const sent: any[] = [];
let failSend = false;
vi.mock('nodemailer', () => ({
  default: { createTransport: vi.fn(() => ({ sendMail: async (m: any) => { if (failSend) throw new Error('auth failed'); sent.push(m); } })) },
}));

async function load(env: Record<string, string | undefined>) {
  vi.resetModules();
  for (const k of ['EMAIL_PROVIDER', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'EMAIL_FROM', 'RESEND_API_KEY']) delete process.env[k];
  Object.assign(process.env, env);
  return (await import('../src/adapters/email/index.js')).emailProvider;
}

describe('email providers', () => {
  beforeEach(() => { sent.length = 0; failSend = false; });

  it('smtp: not configured until host, user and password are all set', async () => {
    expect((await load({ EMAIL_PROVIDER: 'smtp' })).isConfigured()).toBe(false);
    expect((await load({ EMAIL_PROVIDER: 'smtp', SMTP_HOST: 'smtp.gmail.com', SMTP_USER: 'a@gmail.com' })).isConfigured()).toBe(false);
    expect((await load({ EMAIL_PROVIDER: 'smtp', SMTP_HOST: 'smtp.gmail.com', SMTP_USER: 'a@gmail.com', SMTP_PASS: 'abcdabcdabcdabcd' })).isConfigured()).toBe(true);
  });

  it('smtp: sends from the account address by default, or from EMAIL_FROM when set', async () => {
    const p = await load({ EMAIL_PROVIDER: 'smtp', SMTP_HOST: 'smtp.gmail.com', SMTP_USER: 'shop@gmail.com', SMTP_PASS: 'x'.repeat(16) });
    await p.send('cust@example.com', 'Hello', 'Body');
    expect(sent[0]).toMatchObject({ from: 'shop@gmail.com', to: 'cust@example.com', subject: 'Hello', text: 'Body' });
    const p2 = await load({ EMAIL_PROVIDER: 'smtp', SMTP_HOST: 'h', SMTP_USER: 'shop@gmail.com', SMTP_PASS: 'x'.repeat(16), EMAIL_FROM: 'Doraha Eats <shop@gmail.com>' });
    await p2.send('c@example.com', 'S', 'B');
    expect(sent[1].from).toBe('Doraha Eats <shop@gmail.com>');
  });

  it('smtp: a failed send becomes a safe EMAIL_FAILED error without leaking the SMTP message', async () => {
    const p = await load({ EMAIL_PROVIDER: 'smtp', SMTP_HOST: 'h', SMTP_USER: 'u@gmail.com', SMTP_PASS: 'x'.repeat(16) });
    failSend = true;
    await expect(p.send('c@example.com', 'S', 'B')).rejects.toMatchObject({ code: 'EMAIL_FAILED' });
  });

  it('console is only usable outside production', async () => {
    expect((await load({ EMAIL_PROVIDER: 'console', NODE_ENV: 'test' })).isConfigured()).toBe(true);
  });
});
