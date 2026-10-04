import { env } from '../../config/env.js';

export interface SmsProvider {
  sendOtp(phone: string, code: string): Promise<void>;
}

/** Dev provider: prints the OTP to the server log so you can log in locally. */
const consoleProvider: SmsProvider = {
  async sendOtp(phone, code) {
    console.log(`\n  [OTP] ${phone} -> ${code}   (dev only; wire a real SMS provider for production)\n`);
  },
};

/** MSG91 is not wired up yet. Fail loudly instead of silently printing OTPs. */
const unconfiguredProvider: SmsProvider = {
  async sendOtp() { throw new Error(`SMS_PROVIDER=${env.SMS_PROVIDER} is not implemented yet.`); },
};

export const smsProvider: SmsProvider =
  env.SMS_PROVIDER === 'console' ? consoleProvider : unconfiguredProvider;
