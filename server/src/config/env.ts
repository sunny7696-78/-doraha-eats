import 'dotenv/config';
import { z } from 'zod';

const bool = (d: boolean) =>
  z.string().optional().transform((v) => (v === undefined ? d : v === 'true'));

const schema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  PORT: z.coerce.number().default(4000),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  CORS_ORIGINS: z.string().default('*'),
  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
  JWT_EXPIRES_IN: z.string().default('7d'),
  DEMO_PASSWORD: z.string().default('Doraha@123'),
  SEED_DEMO_DATA: bool(false), // opt-in only: seed script refuses to run unless this is "true"
  GOOGLE_CLIENT_IDS: z.string().optional(), // comma-separated web/android/ios OAuth client ids
  MSG91_AUTH_KEY: z.string().optional(),
  MSG91_TEMPLATE_ID: z.string().optional(),
  PAYMENT_PROVIDER: z.enum(['mock', 'razorpay']).default('mock'),
  SMS_PROVIDER: z.enum(['console', 'msg91']).default('console'),
  PUSH_PROVIDER: z.enum(['inapp', 'expo', 'fcm']).default('inapp'),
  STORAGE_PROVIDER: z.enum(['local', 's3', 'cloudinary']).default('local'),
  MAPS_PROVIDER: z.enum(['manual', 'osm', 'google']).default('manual'),
  GOOGLE_MAPS_API_KEY: z.string().optional(),
  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),
  /** Minutes a customer has to finish an online payment before the order is auto-cancelled. */
  PAYMENT_WINDOW_MINUTES: z.coerce.number().int().min(5).max(180).default(30),
  UPI_VPA: z.string().default('dorahaeats@demoupi'),
  EMAIL_PROVIDER: z.enum(['console', 'smtp']).default('console'),
  GOOGLE_CLIENT_ID: z.string().optional(),
  APP_URL: z.string().default('http://localhost:4000'),
  PASSWORD_RESET_TOKEN_TTL_MIN: z.coerce.number().default(30),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:');
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

/**
 * Production fail-fast: refuse to boot rather than silently run on mocks,
 * wildcard CORS, demo accounts or a weak signing secret.
 */
function productionProblems(e: z.infer<typeof schema>): string[] {
  if (e.NODE_ENV !== 'production') return [];
  const p: string[] = [];
  if (e.PAYMENT_PROVIDER !== 'razorpay') p.push('PAYMENT_PROVIDER must be "razorpay" (mock payments are not allowed).');
  if (!e.RAZORPAY_KEY_ID || !e.RAZORPAY_KEY_SECRET) p.push('RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET are required.');
  if (!e.RAZORPAY_WEBHOOK_SECRET) p.push('RAZORPAY_WEBHOOK_SECRET is required (payments cannot be confirmed without it).');
  if (e.CORS_ORIGINS.trim() === '*' || !e.CORS_ORIGINS.trim()) p.push('CORS_ORIGINS must list explicit origins, not "*".');
  if (e.JWT_SECRET.length < 32) p.push('JWT_SECRET must be at least 32 characters in production.');
  if (e.SEED_DEMO_DATA) p.push('SEED_DEMO_DATA must be "false" in production.');
  if (e.DEMO_PASSWORD === 'Doraha@123') p.push('Do not run production with the default DEMO_PASSWORD.');
  if (e.SMS_PROVIDER === 'msg91' && (!e.MSG91_AUTH_KEY || !e.MSG91_TEMPLATE_ID)) p.push('MSG91_AUTH_KEY and MSG91_TEMPLATE_ID are required for SMS_PROVIDER=msg91.');
  if (e.SMS_PROVIDER === 'console') p.push('SMS_PROVIDER=console is not allowed in production.');
  if (e.STORAGE_PROVIDER === 'local') p.push('STORAGE_PROVIDER=local is not allowed in production.');
  return p;
}
const problems = productionProblems(parsed.data);
if (problems.length) {
  console.error('Refusing to start in production:');
  for (const m of problems) console.error(`  - ${m}`);
  process.exit(1);
}

export const env = parsed.data;
export const isProd = env.NODE_ENV === 'production';
export const corsOrigins =
  env.CORS_ORIGINS === '*' ? true : env.CORS_ORIGINS.split(',').map((s) => s.trim());
