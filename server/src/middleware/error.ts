import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { AppError } from '../lib/errors.js';
import { isProd } from '../config/env.js';

export const notFoundHandler: RequestHandler = (_req, res) => {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Endpoint not found.', requestId: res.locals.requestId } });
};

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const requestId = res.locals.requestId as string | undefined;
  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      error: { code: err.code, message: err.message, details: err.details, requestId },
    });
    return;
  }
  if (err instanceof ZodError) {
    res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Please check the details you entered.',
        details: err.flatten().fieldErrors,
        requestId,
      },
    });
    return;
  }
  // Malformed JSON body etc. from express.json — a client mistake, not a server fault.
  if ((err as { type?: string })?.type === 'entity.parse.failed') {
    res.status(400).json({ error: { code: 'BAD_JSON', message: 'The request body is not valid JSON.', requestId } });
    return;
  }
  if ((err as { type?: string })?.type === 'entity.too.large') {
    res.status(413).json({ error: { code: 'TOO_LARGE', message: 'The request is too large.', requestId } });
    return;
  }
  // Full detail goes to the server log only (with the request id); the client gets a safe message.
  console.error(JSON.stringify({
    at: 'error', id: requestId, method: req.method, path: req.baseUrl + req.path,
    err: String((err as Error)?.message ?? err), stack: (err as Error)?.stack,
  }));
  res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Something went wrong. Please try again.',
      requestId,
      ...(isProd ? {} : { debug: String((err as Error)?.message ?? err) }),
    },
  });
};
