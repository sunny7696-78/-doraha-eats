import { createApp } from './app.js';
import { env } from './config/env.js';
import { getSettings } from './services/settings.service.js';
import { startPaymentSweeper } from './services/paymentSweeper.js';

const app = createApp();
startPaymentSweeper();
if (env.NODE_ENV === 'production' && env.PUSH_PROVIDER === 'inapp') {
  console.warn('[config] PUSH_PROVIDER=inapp: customers/vendors/riders will NOT get background push notifications. Set PUSH_PROVIDER=expo.');
}

app.listen(env.PORT, async () => {
  const s = await getSettings().catch(() => null);
  console.log(`\n  ${s?.brandName ?? 'Doraha Eats'} API`);
  console.log(`  ${s?.brandTagline ?? ''}`);
  console.log(`  http://localhost:${env.PORT}/api/v1  [${env.NODE_ENV}]`);
  console.log(`  health: http://localhost:${env.PORT}/health\n`);
});
