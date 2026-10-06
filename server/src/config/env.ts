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
  TRUST_PROXY: z.coerce.number().int().min(0).max(5).default(1),
  JWT_EXPIRES_IN: z.string().default('7d'),
  DEMO_PASSWORD: z.string().default('Doraha@123'),
  SEED_DEMO_DATA: bool(true),
  GOOGLE_CLIENT_IDS: z.string().optional(), // comma-separated web/android/ios OAuth client ids
  MSG91_AUTH_KEY: z.string().optional(),
  MSG91_TEMPLATE_ID: z.string().optional(),
  PAYMENT_PROVIDER: z.enum(['mock', 'razorpay']).default('mock'),
  SMS_PROVIDER: z.enum(['console', 'msg91']).default('console'),
  PUSH_PROVIDER: z.enum(['inapp', 'expo']).default('inapp'),
  EXPO_ACCESS_TOKEN: z.string().optional(), // optional: only if you enabled Expo "enhanced push security"
  STORAGE_PROVIDER: z.enum(['local', 's3']).default('local'),
  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().optional(),
  S3_ENDPOINT: z.string().optional(),       // leave empty for AWS S3; set for R2 / B2 / Spaces
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_PUBLIC_BASE_URL: z.string().optional(), // e.g. https://cdn.example.com or the bucket's public URL
  MAPS_PROVIDER: z.enum(['manual', 'osm', 'google']).default('manual'),
  GOOGLE_MAPS_API_KEY: z.string().optional(),
  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),
  /** Minutes a customer has to finish an online payment before the order is auto-cancelled. */
  PAYMENT_WINDOW_MINUTES: z.coerce.number().int().min(5).max(180).default(30),
  UPI_VPA: z.string().default('dorahaeats@demoupi'),
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
  if (e.STORAGE_PROVIDER === 's3' && (!e.S3_BUCKET || !e.S3_ACCESS_KEY_ID || !e.S3_SECRET_ACCESS_KEY || !e.S3_PUBLIC_BASE_URL)) {
    p.push('S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY and S3_PUBLIC_BASE_URL are required for STORAGE_PROVIDER=s3.');
  }
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
