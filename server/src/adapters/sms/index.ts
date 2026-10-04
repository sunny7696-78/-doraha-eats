import { env, isProd } from '../../config/env.js';

export interface SmsProvider {
  sendOtp(phone: string, code: string): Promise<void>;
}

/** Dev provider: prints the OTP to the server log so you can log in locally. */
const consoleProvider: SmsProvider = {
  async sendOtp(phone, code) {
    console.log(`\n  [OTP] ${phone} -> ${code}   (dev only)\n`);
  },
};

/** MSG91 expects digits only with country code, e.g. 919876543210. */
const toMsisdn = (phone: string) => {
  const d = phone.replace(/\D/g, '');
  return d.length === 10 ? `91${d}` : d;
};

/**
 * MSG91 "Send OTP" (v5). India requires a DLT-approved sender + template; the
 * template must contain the OTP variable (##OTP##). Verify the exact request
 * shape against your MSG91 dashboard docs before going live.
 */
const msg91Provider: SmsProvider = {
  async sendOtp(phone, code) {
    const url = new URL('https://control.msg91.com/api/v5/otp');
    url.searchParams.set('template_id', env.MSG91_TEMPLATE_ID!);
    url.searchParams.set('mobile', toMsisdn(phone));
    url.searchParams.set('authkey', env.MSG91_AUTH_KEY!);
    url.searchParams.set('otp', code);
    url.searchParams.set('otp_expiry', '5');

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(8000),
    });
    const body = (await res.json().catch(() => ({}))) as { type?: string; message?: string };
    if (!res.ok || body.type === 'error') {
      // Never log the OTP or auth key.
      console.error('[sms] MSG91 send failed', res.status, body.message ?? '');
      throw new Error('SMS_SEND_FAILED');
    }
  },
};

export const smsProvider: SmsProvider = env.SMS_PROVIDER === 'msg91' ? msg91Provider : consoleProvider;

/** True when OTP codes can actually reach a customer's phone. */
export const otpDeliverable = !(isProd && env.SMS_PROVIDER === 'console');
