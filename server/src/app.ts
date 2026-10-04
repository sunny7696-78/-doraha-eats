import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { corsOrigins, env } from './config/env.js';
import { generalLimiter } from './middleware/rateLimit.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import { authRouter } from './routes/auth.routes.js';
import { publicRouter } from './routes/public.routes.js';
import { customerRouter } from './routes/customer.routes.js';
import { vendorRouter } from './routes/vendor.routes.js';
import { deliveryRouter } from './routes/delivery.routes.js';
import { adminRouter } from './routes/admin.routes.js';
import { razorpayWebhook } from './routes/paymentWebhook.routes.js';

export function createApp() {
  const app = express();

  app.set('trust proxy', 1);
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(cors({ origin: corsOrigins, credentials: true }));
  // Webhook FIRST, with the raw body: its signature is computed over the exact bytes sent.
  app.post('/api/v1/payments/razorpay/webhook', express.raw({ type: 'application/json', limit: '512kb' }), razorpayWebhook);
  app.use(express.json({ limit: '1mb' }));
  app.use(generalLimiter);

  app.get('/health', (_req, res) => {
    res.json({ ok: true, service: 'doraha-eats-api', time: new Date().toISOString() });
  });

  const api = express.Router();
  // Order matters: the role-prefixed routers must be matched BEFORE the
  // customer router, which is mounted at '/' and would otherwise apply its
  // CUSTOMER role guard to /vendor, /delivery and /admin requests.
  api.use('/auth', authRouter);
  api.use('/vendor', vendorRouter);
  api.use('/delivery', deliveryRouter);
  api.use('/admin', adminRouter);
  api.use('/', publicRouter);
  api.use('/', customerRouter);

  app.use('/api/v1', api);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
