import nodemailer from 'nodemailer';
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

/**
 * Plain SMTP (Gmail, Zoho, Brevo, any mail server). Needs no domain of your own: with Gmail you
 * send from your own address using an App Password. Fine for a pilot (Gmail allows roughly 500
 * mails a day); move to a domain + Resend when you grow.
 */
let transport: nodemailer.Transporter | null = null;
const smtpProvider: EmailProvider = {
  isConfigured: () => !!env.SMTP_HOST && !!env.SMTP_USER && !!env.SMTP_PASS,
  async send(to, subject, text) {
    transport ??= nodemailer.createTransport({
      host: env.SMTP_HOST, port: env.SMTP_PORT, secure: env.SMTP_PORT === 465,
      auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
      connectionTimeout: 10_000, socketTimeout: 15_000,
    });
    try {
      await transport.sendMail({ from: env.EMAIL_FROM || env.SMTP_USER, to, subject, text });
    } catch (e) {
      console.error(JSON.stringify({ at: 'email', provider: 'smtp', err: String((e as Error)?.message ?? e).slice(0, 200) }));
      throw new AppError(502, 'EMAIL_FAILED', 'Could not send the email.');
    }
  },
};

export const emailProvider: EmailProvider =
  env.EMAIL_PROVIDER === 'resend' ? resendProvider : env.EMAIL_PROVIDER === 'smtp' ? smtpProvider : consoleProvider;
