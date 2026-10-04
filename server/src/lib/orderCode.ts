import { randomInt } from 'node:crypto';

/** Human-readable order code shown to customer, vendor and rider alike. */
export function generateOrderCode(): string {
  const n = randomInt(1000, 10000);
  const t = Date.now().toString(36).slice(-3).toUpperCase();
  return `DE-${t}${n}`;
}
