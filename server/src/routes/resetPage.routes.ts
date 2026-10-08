import { Router } from 'express';
import express from 'express';
import { z } from 'zod';
import { AppError } from '../lib/errors.js';
import { authLimiter } from '../middleware/rateLimit.js';
import * as auth from '../services/auth.service.js';

/**
 * The page a customer lands on from the reset email. It is served by the API itself, so it needs
 * no changes to the mobile app or admin site. It is a plain HTML form (no scripts), so it works
 * under the API's strict security headers.
 */
export const resetPageRouter = Router();

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

const shell = (title: string, inner: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)}</title>
<style>body{font-family:system-ui,sans-serif;background:#FAF7F2;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center}
.card{background:#fff;border-radius:14px;padding:28px;max-width:380px;width:92%;box-shadow:0 2px 14px rgba(0,0,0,.08)}
h1{font-size:20px;margin:0 0 14px}input{width:100%;box-sizing:border-box;padding:12px;margin:6px 0 12px;border:1px solid #ccc;border-radius:8px;font-size:16px}
button{width:100%;padding:13px;border:0;border-radius:8px;background:#D4442A;color:#fff;font-size:16px;font-weight:600}
.err{color:#b00020;margin-bottom:10px}.ok{color:#1b6e2d}</style></head><body><div class="card">${inner}</div></body></html>`;

const form = (uid: string, token: string, error?: string) => shell('Reset password', `
<h1>Choose a new password</h1>${error ? `<div class="err">${esc(error)}</div>` : ''}
<form method="post" action="/reset-password" autocomplete="off">
<input type="hidden" name="uid" value="${esc(uid)}"><input type="hidden" name="token" value="${esc(token)}">
<label>New password (at least 8 characters)</label>
<input type="password" name="password" minlength="8" maxlength="128" required autocomplete="new-password">
<button type="submit">Save new password</button></form>`);

const noCache = (res: express.Response) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer'); // the token is in the URL: never leak it onward
};

resetPageRouter.get('/', (req, res) => {
  noCache(res);
  const q = z.object({ uid: z.string().uuid(), token: z.string().regex(/^[a-f0-9]{64}$/) }).safeParse(req.query);
  if (!q.success) { res.status(400).send(shell('Invalid link', '<h1>This link is not valid</h1><p>Please request a new password reset from the app.</p>')); return; }
  res.send(form(q.data.uid, q.data.token));
});

resetPageRouter.post('/', authLimiter, express.urlencoded({ extended: false, limit: '4kb' }), async (req, res) => {
  noCache(res);
  const b = z.object({
    uid: z.string().uuid(), token: z.string().regex(/^[a-f0-9]{64}$/), password: z.string().min(8).max(128),
  }).safeParse(req.body);
  if (!b.success) {
    const uid = typeof req.body?.uid === 'string' ? req.body.uid : '';
    const token = typeof req.body?.token === 'string' ? req.body.token : '';
    res.status(400).send(form(uid, token, 'Password must be at least 8 characters.'));
    return;
  }
  try {
    await auth.resetPassword(b.data.uid, b.data.token, b.data.password);
    res.send(shell('Password updated', '<h1 class="ok">Password updated</h1><p>You can now log in to Doraha Eats with your new password.</p>'));
  } catch (e) {
    if (e instanceof AppError && e.statusCode < 500) {
      res.status(400).send(shell('Link expired', `<h1>${esc(e.message)}</h1><p>Please request a new reset email from the app.</p>`));
      return;
    }
    console.error(JSON.stringify({ at: 'reset-page', err: String((e as Error)?.message ?? e) }));
    res.status(500).send(shell('Error', '<h1>Something went wrong</h1><p>Please try again.</p>'));
  }
});
