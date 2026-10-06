/**
 * Doraha Eats - production bootstrap (REAL data, no demo rows).
 *
 * Creates, only if missing: platform settings, the food categories, one delivery zone
 * (Doraha) and one ADMIN account. Safe to run more than once. It never deletes anything.
 *
 *   ADMIN_EMAIL=you@example.com ADMIN_PHONE=+919876543210 ADMIN_PASSWORD='long-secret' npm run bootstrap
 *
 * Run it from your own computer with DATABASE_URL pointing at the Render *External* database URL.
 * Vendors and riders are real people: they register in the apps and you approve them in the admin panel.
 */
import { eq, or } from 'drizzle-orm';
import { db, pool } from './index.js';
import { users, deliveryZones, categories, settings } from './schema.js';
import { hashPassword } from '../lib/password.js';
import { DEFAULT_SETTINGS } from '../services/settings.service.js';

const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
const phone = process.env.ADMIN_PHONE?.trim();
const password = process.env.ADMIN_PASSWORD;
const fullName = process.env.ADMIN_NAME?.trim() || 'Admin';

async function main() {
  if (!email || !phone || !password) {
    throw new Error('Set ADMIN_EMAIL, ADMIN_PHONE (like +919876543210) and ADMIN_PASSWORD first.');
  }
  if (password.length < 10) throw new Error('ADMIN_PASSWORD must be at least 10 characters.');
  if (!/^\+91\d{10}$/.test(phone)) throw new Error('ADMIN_PHONE must look like +919876543210.');

  const [hasSettings] = await db.select().from(settings).where(eq(settings.key, 'platform')).limit(1);
  if (!hasSettings) {
    await db.insert(settings).values({ key: 'platform', value: DEFAULT_SETTINGS });
    console.log('  settings         created');
  }

  const existingCats = await db.select({ id: categories.id }).from(categories).limit(1);
  if (existingCats.length === 0) {
    await db.insert(categories).values([
      { slug: 'burger', name: 'Burgers', icon: '🍔', sortOrder: 1 },
      { slug: 'pizza', name: 'Pizza', icon: '🍕', sortOrder: 2 },
      { slug: 'momos', name: 'Momos', icon: '🥟', sortOrder: 3 },
      { slug: 'rolls', name: 'Rolls', icon: '🌯', sortOrder: 4 },
      { slug: 'chinese', name: 'Chinese', icon: '🍜', sortOrder: 5 },
      { slug: 'snacks', name: 'Snacks', icon: '🍟', sortOrder: 6 },
      { slug: 'drinks', name: 'Drinks', icon: '🥤', sortOrder: 7 },
      { slug: 'chicken', name: 'Chicken', icon: '🍗', sortOrder: 8 },
      { slug: 'tea', name: 'Tea', icon: '☕', sortOrder: 9 },
      { slug: 'desserts', name: 'Desserts', icon: '🍰', sortOrder: 10 },
    ]);
    console.log('  categories       created');
  }

  const existingZone = await db.select({ id: deliveryZones.id }).from(deliveryZones).limit(1);
  if (existingZone.length === 0) {
    await db.insert(deliveryZones).values({
      name: 'Doraha', description: 'Doraha town and nearby areas',
      latitude: 30.7996, longitude: 76.0236, radiusMeters: 3000,
      deliveryFeePaise: 2000, minOrderPaise: 9900, etaMinutes: 35, priority: 10, isActive: true,
    });
    console.log('  zone             created (edit radius/fees in the admin panel)');
  }

  const [admin] = await db.select().from(users).where(or(eq(users.email, email), eq(users.phone, phone))).limit(1);
  if (admin) {
    console.log(`  admin            already exists (${admin.email ?? admin.phone}) - not changed`);
  } else {
    await db.insert(users).values({
      role: 'ADMIN', email, phone, fullName, passwordHash: await hashPassword(password), status: 'ACTIVE',
    });
    console.log(`  admin            created (${email})`);
  }
  console.log('\nDone. Log in to the admin panel with that email and password.');
}

main().catch((e) => { console.error(e.message ?? e); process.exitCode = 1; }).finally(() => pool.end());
