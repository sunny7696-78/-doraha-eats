import { env } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';

export interface SmsProvider {
  sendOtp(phone: string, code: string): Promise<void>;
}

/** Dev provider: prints the OTP so you can log in locally. Refuses to run in production. */
const consoleProvider: SmsProvider = {
  async sendOtp(phone, code) {
    if (env.NODE_ENV === 'production') throw new Error('Console SMS is disabled in production.');
    console.log(`\n  [OTP] ${phone} -> ${code}   (dev only)\n`);
  },
};

/**
 * MSG91 "Flow" API. India requires a DLT-registered sender id + OTP template; the template
 * must contain a variable named "otp" (##otp##). Set MSG91_AUTH_KEY and MSG91_TEMPLATE_ID.
 * The OTP is never logged.
 */
const msg91Provider: SmsProvider = {
  async sendOtp(phone, code) {
    let res: Response;
    try {
      res = await fetch('https://control.msg91.com/api/v5/flow/', {
        method: 'POST',
        headers: { authkey: env.MSG91_AUTH_KEY!, 'Content-Type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          template_id: env.MSG91_TEMPLATE_ID,
          short_url: '0',
          recipients: [{ mobiles: phone.replace('+', ''), otp: code }],
        }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new AppError(502, 'SMS_FAILED', 'Could not send the code. Please try again.');
    }
    if (!res.ok) {
      console.error(JSON.stringify({ at: 'sms', provider: 'msg91', status: res.status }));
      throw new AppError(502, 'SMS_FAILED', 'Could not send the code. Please try again.');
    }
  },
};

export const smsProvider: SmsProvider = env.SMS_PROVIDER === 'msg91' ? msg91Provider : consoleProvider;
