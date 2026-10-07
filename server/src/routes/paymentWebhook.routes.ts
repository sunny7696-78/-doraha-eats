import crypto from 'node:crypto';
import type { RequestHandler } from 'express';
import { env } from '../config/env.js';
import { verifyWebhookSignature } from '../adapters/payments/razorpay.js';
import { processRazorpayWebhook } from '../services/payment.service.js';

/**
 * Razorpay webhook. Mounted in app.ts with express.raw() BEFORE express.json(),
 * because the signature is computed over the exact bytes Razorpay sent —
 * re-serialising parsed JSON would break it.
 *
 * Responses: 400 bad signature/body (no retry value), 5xx on our own failure
 * (Razorpay retries), 200 once recorded or recognised as a duplicate.
 */
export const razorpayWebhook: RequestHandler = async (req, res) => {
  const secret = env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) { res.status(503).json({ error: { code: 'WEBHOOK_NOT_CONFIGURED', message: 'Not configured.' } }); return; }

  const raw = req.body;
  const signature = req.header('x-razorpay-signature') ?? '';
  if (!Buffer.isBuffer(raw) || !verifyWebhookSignature(raw, signature, secret)) {
    console.warn(JSON.stringify({ at: 'webhook', msg: 'rejected: bad signature' }));
    res.status(400).json({ error: { code: 'INVALID_SIGNATURE', message: 'Invalid signature.' } });
    return;
  }

  let event: { event?: string };
  try { event = JSON.parse(raw.toString('utf8')); }
  catch { res.status(400).json({ error: { code: 'INVALID_BODY', message: 'Invalid body.' } }); return; }
  if (!event?.event) { res.status(400).json({ error: { code: 'INVALID_BODY', message: 'Invalid body.' } }); return; }

  // Razorpay sends a unique id per event; fall back to a body hash so retries still dedupe.
  const eventId = req.header('x-razorpay-event-id') || crypto.createHash('sha256').update(raw).digest('hex');

  try {
    const r = await processRazorpayWebhook(eventId, event as never);
    console.log(JSON.stringify({ at: 'webhook', eventId, type: event.event, duplicate: r.duplicate }));
    res.json({ ok: true });
  } catch (e) {
    console.error(JSON.stringify({ at: 'webhook', eventId, type: event.event, err: String((e as Error)?.message ?? e) }));
    res.status(500).json({ error: { code: 'WEBHOOK_FAILED', message: 'Try again.' } });
  }
};
