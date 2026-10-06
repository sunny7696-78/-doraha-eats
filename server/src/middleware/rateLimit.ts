import rateLimit from 'express-rate-limit';
import { env } from '../config/env.js';

const disabled = env.NODE_ENV === 'test';

export const generalLimiter = rateLimit({
  windowMs: 60_000, limit: 300, standardHeaders: true, legacyHeaders: false, skip: () => disabled,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many requests. Please slow down.' } },
});

export const authLimiter = rateLimit({
  windowMs: 15 * 60_000, limit: 20, standardHeaders: true, legacyHeaders: false, skip: () => disabled,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many attempts. Please try again later.' } },
});

export const otpLimiter = rateLimit({
  windowMs: 15 * 60_000, limit: 5, standardHeaders: true, legacyHeaders: false, skip: () => disabled,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many OTP requests. Please wait a few minutes.' } },
});

/**
 * Brute-force guard per ACCOUNT (email/phone), on top of the per-IP limit — an attacker
 * rotating IPs still cannot hammer one account's password.
 */
export const loginIdentifierLimiter = rateLimit({
  windowMs: 15 * 60_000, limit: 10, standardHeaders: true, legacyHeaders: false, skip: () => disabled,
  keyGenerator: (req) => {
    const b = (req.body ?? {}) as { email?: unknown; phone?: unknown };
    const id = String(b.email ?? b.phone ?? '').trim().toLowerCase();
    return id ? `acct:${id}` : `ip:${req.ip}`;
  },
  message: { error: { code: 'RATE_LIMITED', message: 'Too many attempts for this account. Please try again later.' } },
});
