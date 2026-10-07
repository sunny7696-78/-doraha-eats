import { env } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';

export interface EmailProvider {
  /** False when this provider cannot really deliver mail (e.g. console in production). */
  isConfigured(): boolean;
  send(to: string, subject: string, text: string): Promise<void>;
}

/** Dev provider: prints the email so you can click the reset link locally. Never used in production. */
const consoleProvider: EmailProvider = {
  isConfigured: () => env.NODE_ENV !== 'production',
  async send(to, subject, text) {
    if (env.NODE_ENV === 'production') throw new Error('Console email is disabled in production.');
    console.log(`\n  [EMAIL] To: ${to}\n  Subject: ${subject}\n  ${text}\n`);
  },
};

/** Resend (https://resend.com) over plain REST. Needs RESEND_API_KEY and EMAIL_FROM on a verified domain. */
const resendProvider: EmailProvider = {
  isConfigured: () => !!env.RESEND_API_KEY && !!env.EMAIL_FROM,
  async send(to, subject, text) {
    let res: Response;
    try {
      res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: env.EMAIL_FROM, to: [to], subject, text }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new AppError(502, 'EMAIL_FAILED', 'Could not send the email.');
    }
    if (!res.ok) {
      console.error(JSON.stringify({ at: 'email', provider: 'resend', status: res.status }));
      throw new AppError(502, 'EMAIL_FAILED', 'Could not send the email.');
    }
  },
};

export const emailProvider: EmailProvider = env.EMAIL_PROVIDER === 'resend' ? resendProvider : consoleProvider;
