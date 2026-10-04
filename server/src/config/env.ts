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
  SEED_DEMO_DATA: bool(true),
  PAYMENT_PROVIDER: z.enum(['mock', 'razorpay']).default('mock'),
  SMS_PROVIDER: z.enum(['console', 'msg91']).default('console'),
  PUSH_PROVIDER: z.enum(['inapp', 'expo', 'fcm']).default('inapp'),
  STORAGE_PROVIDER: z.enum(['local', 's3', 'cloudinary']).default('local'),
  MAPS_PROVIDER: z.enum(['manual', 'osm', 'google']).default('manual'),
  GOOGLE_MAPS_API_KEY: z.string().optional(),
  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  UPI_VPA: z.string().default('dorahaeats@demoupi'),
  MSG91_AUTH_KEY: z.string().optional(),
  MSG91_TEMPLATE_ID: z.string().optional(),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:');
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;

if (env.NODE_ENV === 'production') {
  const problems: string[] = [];
  if (env.CORS_ORIGINS === '*') problems.push('CORS_ORIGINS must list your real domains, not "*"');
  if (/change-me|secret|password/i.test(env.JWT_SECRET) || env.JWT_SECRET.length < 32) {
    problems.push('JWT_SECRET must be a random string of 32+ characters');
  }
  if (env.SEED_DEMO_DATA) problems.push('SEED_DEMO_DATA must be false in production');
  if (env.DEMO_PASSWORD === 'Doraha@123') problems.push('DEMO_PASSWORD must be changed or unused in production');
  if (env.PAYMENT_PROVIDER === 'mock') console.warn('[config] PAYMENT_PROVIDER=mock: UPI is admin-verified manually.');
  if (env.SMS_PROVIDER === 'console') {
    console.warn('[config] SMS_PROVIDER=console: phone-OTP login is DISABLED in production. Set SMS_PROVIDER=msg91 to enable it.');
  }
  if (env.SMS_PROVIDER === 'msg91' && (!env.MSG91_AUTH_KEY || !env.MSG91_TEMPLATE_ID)) {
    problems.push('SMS_PROVIDER=msg91 needs MSG91_AUTH_KEY and MSG91_TEMPLATE_ID');
  }
  if (env.UPI_VPA === 'dorahaeats@demoupi') problems.push('UPI_VPA is still the demo value; set your real UPI ID');
  if (problems.length) {
    console.error('Refusing to start in production:\n - ' + problems.join('\n - '));
    process.exit(1);
  }
}
export const isProd = env.NODE_ENV === 'production';
export const corsOrigins =
  env.CORS_ORIGINS === '*' ? true : env.CORS_ORIGINS.split(',').map((s) => s.trim());
