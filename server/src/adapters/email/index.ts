import { env } from '../../config/env.js';

export interface EmailProvider {
  send(to: string, subject: string, body: string): Promise<void>;
}

/** Dev provider: prints the email to the server log. Swap for SMTP/SendGrid/etc in production. */
const consoleProvider: EmailProvider = {
  async send(to, subject, body) {
    console.log(`\n  [EMAIL] To: ${to}\n  Subject: ${subject}\n  ${body}\n`);
  },
};

export const emailProvider: EmailProvider =
  env.EMAIL_PROVIDER === 'console' ? consoleProvider : consoleProvider;