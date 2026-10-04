/**
 * Creates the first REAL admin. Safe: never deletes anything.
 *   ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='long-random-pass' ADMIN_NAME='Your Name' npm run create-admin
 */
import { eq } from 'drizzle-orm';
import { db, pool } from './index.js';
import { users } from './schema.js';
import { hashPassword } from '../lib/password.js';

const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
const password = process.env.ADMIN_PASSWORD;
const fullName = process.env.ADMIN_NAME?.trim() || 'Admin';

async function main() {
  if (!email || !/^\S+@\S+\.\S+$/.test(email)) throw new Error('Set ADMIN_EMAIL to a valid email.');
  if (!password || password.length < 12) throw new Error('Set ADMIN_PASSWORD (12+ characters).');
  const [existing] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (existing) throw new Error(`A user with ${email} already exists.`);
  await db.insert(users).values({
    role: 'ADMIN', email, fullName, passwordHash: await hashPassword(password), status: 'ACTIVE',
  });
  console.log(`Admin created: ${email}`);
}

main().catch((e) => { console.error(e.message); process.exitCode = 1; }).finally(() => pool.end());
