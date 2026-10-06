import crypto from 'node:crypto';
import type { RequestHandler } from 'express';
import { env } from '../config/env.js';

/**
 * Gives every request an id (returned in the X-Request-Id header and in error bodies, so a
 * customer's screenshot can be matched to a log line) and writes ONE structured access-log
 * line when the response finishes. It deliberately logs no headers, bodies or query strings,
 * so passwords, OTPs, tokens and payment data can never end up in the logs.
 */
export const requestContext: RequestHandler = (req, res, next) => {
  const incoming = req.header('x-request-id');
  const id = incoming && /^[A-Za-z0-9_-]{8,64}$/.test(incoming) ? incoming : crypto.randomUUID();
  res.locals.requestId = id;
  res.setHeader('X-Request-Id', id);
  const started = process.hrtime.bigint();

  res.on('finish', () => {
    if (env.NODE_ENV === 'test' || req.path === '/health') return;
    console.log(JSON.stringify({
      at: 'http', id, method: req.method,
      path: req.baseUrl + req.path,            // no query string
      status: res.statusCode,
      ms: Math.round(Number(process.hrtime.bigint() - started) / 1e6),
      uid: req.user?.id, role: req.user?.role,
    }));
  });
  next();
};
