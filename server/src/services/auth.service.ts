import crypto from 'node:crypto';
import { and, eq, gt, gte, isNull, or, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { users, customerProfiles, deliveryPartners, carts } from '../db/schema.js';
import { hashPassword, verifyPassword } from '../lib/password.js';
import { signToken } from '../lib/jwt.js';
import { Errors } from '../lib/errors.js';
import { smsProvider } from '../adapters/sms/index.js';
import { otpCodes } from '../db/schema.js';
<<<<<<< HEAD
import { OAuth2Client } from 'google-auth-library';
import { emailProvider } from '../adapters/email/index.js';
import { generateResetToken, verifyResetToken } from '../lib/resetToken.js';
import { env } from '../config/env.js';

const googleClient = env.GOOGLE_CLIENT_ID
  ? new OAuth2Client(env.GOOGLE_CLIENT_ID)
  : null;
=======
import { normalizeEmail, normalizeIndianPhone } from '../lib/phone.js';
import { verifyGoogleIdToken } from '../adapters/google/index.js';
>>>>>>> 27c0a9374784eadab3dd5f77b201c2a034349c2c

export type PublicUser = {
  id: string;
  role: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  locale: string;
  status: string;
};

const toPublic = (u: typeof users.$inferSelect): PublicUser => ({
  id: u.id,
  role: u.role,
  fullName: u.fullName,
  email: u.email,
  phone: u.phone,
  locale: u.locale,
  status: u.status,
});

const isUniqueViolation = (e: unknown): boolean => {
  const err = e as { code?: string; cause?: { code?: string } };
  return (err?.code ?? err?.cause?.code) === '23505';
};

const byEmail = (email: string) => sql`lower(${users.email}) = ${normalizeEmail(email)}`;

export async function register(input: {
  fullName: string;
  password: string;
  email?: string;
  phone?: string;
  role?: 'CUSTOMER' | 'DELIVERY';
  locale?: string;
}) {
  if (!input.email && !input.phone) {
    throw Errors.badRequest('Please provide an email or a phone number.');
  }
<<<<<<< HEAD

  const conditions = [];

  if (input.email) {
    conditions.push(eq(users.email, input.email));
  }

  if (input.phone) {
    conditions.push(eq(users.phone, input.phone));
  }

  const [existing] = await db
    .select()
    .from(users)
    .where(or(...conditions))
    .limit(1);

  if (existing) {
    throw Errors.conflict(
      'An account with these details already exists.',
      'ACCOUNT_EXISTS',
    );
  }

  const role = input.role ?? 'CUSTOMER';

  const [user] = await db
    .insert(users)
    .values({
      role,
      fullName: input.fullName,
      email: input.email ?? null,
      phone: input.phone ?? null,
      passwordHash: await hashPassword(input.password),
      locale: input.locale ?? 'en',

      // Delivery partners must be approved by an admin before they can work.
      status: role === 'DELIVERY' ? 'PENDING' : 'ACTIVE',
    })
    .returning();

  if (role === 'CUSTOMER') {
    await db.insert(customerProfiles).values({
      userId: user.id,
    });

    await db.insert(carts).values({
      userId: user.id,
    });
  }

  if (role === 'DELIVERY') {
    await db.insert(deliveryPartners).values({
      userId: user.id,
      status: 'PENDING',
    });
  }

  return {
    user: toPublic(user),
    token: signToken({
      sub: user.id,
      role: user.role,
    }),
  };
=======
  const email = input.email ? normalizeEmail(input.email) : null;
  let phone: string | null = null;
  if (input.phone) {
    phone = normalizeIndianPhone(input.phone);
    if (!phone) throw Errors.badRequest('Please enter a valid 10-digit Indian mobile number.', 'INVALID_PHONE');
  }

  const conditions = [];
  if (email) conditions.push(byEmail(email));
  if (phone) conditions.push(eq(users.phone, phone));
  const [existing] = await db.select().from(users).where(or(...conditions)).limit(1);
  if (existing) throw Errors.conflict('An account with these details already exists.', 'ACCOUNT_EXISTS');

  const role = input.role ?? 'CUSTOMER';
  const passwordHash = await hashPassword(input.password);
  try {
    // User + profile + cart are created together or not at all.
    const user = await db.transaction(async (tx) => {
      const [u] = await tx.insert(users).values({
        role, fullName: input.fullName, email, phone, passwordHash,
        locale: input.locale ?? 'en',
        // Delivery partners must be approved by an admin before they can work.
        status: role === 'DELIVERY' ? 'PENDING' : 'ACTIVE',
      }).returning();
      if (role === 'CUSTOMER') {
        await tx.insert(customerProfiles).values({ userId: u.id });
        await tx.insert(carts).values({ userId: u.id });
      }
      if (role === 'DELIVERY') await tx.insert(deliveryPartners).values({ userId: u.id, status: 'PENDING' });
      return u;
    });
    return { user: toPublic(user), token: signToken({ sub: user.id, role: user.role }) };
  } catch (e) {
    if (isUniqueViolation(e)) throw Errors.conflict('An account with these details already exists.', 'ACCOUNT_EXISTS');
    throw e;
  }
>>>>>>> 27c0a9374784eadab3dd5f77b201c2a034349c2c
}

export async function login(input: {
  email?: string;
  phone?: string;
  password: string;
}) {
  const conditions = [];
<<<<<<< HEAD
=======
  if (input.email) conditions.push(byEmail(input.email));
  if (input.phone) {
    const phone = normalizeIndianPhone(input.phone);
    if (phone) conditions.push(eq(users.phone, phone));
  }
  if (!conditions.length) throw Errors.badRequest('Please provide an email or a phone number.');
>>>>>>> 27c0a9374784eadab3dd5f77b201c2a034349c2c

  if (input.email) {
    conditions.push(eq(users.email, input.email));
  }

  if (input.phone) {
    conditions.push(eq(users.phone, input.phone));
  }

  if (!conditions.length) {
    throw Errors.badRequest(
      'Please provide an email or a phone number.',
    );
  }

  const [user] = await db
    .select()
    .from(users)
    .where(or(...conditions))
    .limit(1);

  // Same message for unknown account and wrong password
  // — no account enumeration.
  if (!user?.passwordHash) {
    throw Errors.unauthorized('Incorrect email or password.');
  }

  if (!(await verifyPassword(input.password, user.passwordHash))) {
    throw Errors.unauthorized('Incorrect email or password.');
  }

  if (user.status === 'SUSPENDED') {
    throw Errors.forbidden(
      'This account has been suspended.',
    );
  }

  await db
    .update(users)
    .set({
      lastLoginAt: new Date(),
    })
    .where(eq(users.id, user.id));

  return {
    user: toPublic(user),
    token: signToken({
      sub: user.id,
      role: user.role,
    }),
  };
}

export async function me(userId: string) {
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!user) {
    throw Errors.notFound('User');
  }

  return toPublic(user);
}

<<<<<<< HEAD
/** OTP login. Dev SMS provider prints the code to the server console. */
export async function requestOtp(phone: string) {
  const code = String(
    Math.floor(100000 + Math.random() * 900000),
  );

  const codeHash = await hashPassword(code);

  await db.insert(otpCodes).values({
    phone,
    codeHash,
    expiresAt: new Date(Date.now() + 5 * 60_000),
  });

  await smsProvider.sendOtp(phone, code);

  return {
    sent: true,
    expiresInSeconds: 300,
  };
}

export async function verifyOtp(
  phone: string,
  code: string,
  fullName?: string,
) {
  const rows = await db
    .select()
    .from(otpCodes)
    .where(eq(otpCodes.phone, phone))
    .orderBy(otpCodes.createdAt);

  const latest = rows
    .filter(
      (r) =>
        !r.consumed &&
        r.expiresAt > new Date(),
    )
    .pop();

  if (!latest) {
    throw Errors.badRequest(
      'This code has expired. Please request a new one.',
      'OTP_EXPIRED',
    );
  }

  if (latest.attempts >= 5) {
    throw Errors.badRequest(
      'Too many attempts. Please request a new code.',
      'OTP_LOCKED',
    );
  }

  const ok = await verifyPassword(
    code,
    latest.codeHash,
  );

  if (!ok) {
    await db
      .update(otpCodes)
      .set({
        attempts: latest.attempts + 1,
      })
      .where(eq(otpCodes.id, latest.id));

    throw Errors.badRequest(
      'That code is not correct.',
      'OTP_INVALID',
    );
=======
/* -------------------------------------------------------------------- OTP */

const OTP_TTL_MS = 5 * 60_000;
const OTP_RESEND_COOLDOWN_S = 60;
const OTP_MAX_PER_HOUR = 5;
const OTP_MAX_PER_DAY = 10;
const OTP_MAX_ATTEMPTS = 5;

/**
 * Sends a login code. Per-phone limits live in the database (not just per-IP) so one
 * attacker cannot spam a victim's phone or burn SMS credit from many IPs.
 */
export async function requestOtp(rawPhone: string) {
  const phone = normalizeIndianPhone(rawPhone);
  if (!phone) throw Errors.badRequest('Please enter a valid 10-digit Indian mobile number.', 'INVALID_PHONE');

  const now = Date.now();
  const recent = await db.select({ createdAt: otpCodes.createdAt }).from(otpCodes)
    .where(and(eq(otpCodes.phone, phone), gte(otpCodes.createdAt, new Date(now - 24 * 3600_000))));
  const last = recent.reduce((m, r) => Math.max(m, r.createdAt.getTime()), 0);
  if (last && now - last < OTP_RESEND_COOLDOWN_S * 1000) {
    throw Errors.tooManyRequests(
      `Please wait ${Math.ceil(OTP_RESEND_COOLDOWN_S - (now - last) / 1000)} seconds before asking for another code.`,
      'OTP_COOLDOWN');
  }
  if (recent.filter((r) => r.createdAt.getTime() > now - 3600_000).length >= OTP_MAX_PER_HOUR
      || recent.length >= OTP_MAX_PER_DAY) {
    throw Errors.tooManyRequests('Too many codes requested for this number. Please try again later.', 'OTP_LIMIT');
  }

  const code = String(crypto.randomInt(100000, 1000000)); // CSPRNG, not Math.random
  // A new code replaces any older unused ones.
  await db.update(otpCodes).set({ consumed: true })
    .where(and(eq(otpCodes.phone, phone), eq(otpCodes.consumed, false)));
  const [row] = await db.insert(otpCodes).values({
    phone, codeHash: await hashPassword(code), expiresAt: new Date(now + OTP_TTL_MS),
  }).returning({ id: otpCodes.id });
  try {
    await smsProvider.sendOtp(phone, code);
  } catch (e) {
    await db.update(otpCodes).set({ consumed: true }).where(eq(otpCodes.id, row.id));
    throw e;
  }
  return { sent: true, expiresInSeconds: OTP_TTL_MS / 1000, resendAfterSeconds: OTP_RESEND_COOLDOWN_S };
}

export async function verifyOtp(rawPhone: string, code: string, fullName?: string) {
  const phone = normalizeIndianPhone(rawPhone);
  if (!phone) throw Errors.badRequest('Please enter a valid 10-digit Indian mobile number.', 'INVALID_PHONE');

  const [latest] = await db.select().from(otpCodes)
    .where(and(eq(otpCodes.phone, phone), eq(otpCodes.consumed, false), gt(otpCodes.expiresAt, new Date())))
    .orderBy(sql`${otpCodes.createdAt} desc`).limit(1);
  if (!latest) throw Errors.badRequest('This code has expired. Please request a new one.', 'OTP_EXPIRED');

  // Count the attempt BEFORE checking the code, atomically, so parallel guesses can't exceed the limit.
  const [counted] = await db.update(otpCodes).set({ attempts: sql`${otpCodes.attempts} + 1` })
    .where(and(eq(otpCodes.id, latest.id), eq(otpCodes.consumed, false), sql`${otpCodes.attempts} < ${OTP_MAX_ATTEMPTS}`))
    .returning({ attempts: otpCodes.attempts });
  if (!counted) throw Errors.badRequest('Too many attempts. Please request a new code.', 'OTP_LOCKED');

  if (!(await verifyPassword(code, latest.codeHash))) {
    throw Errors.badRequest('That code is not correct.', 'OTP_INVALID');
  }
  // Single use: only the request that flips consumed=false wins.
  const [consumed] = await db.update(otpCodes).set({ consumed: true })
    .where(and(eq(otpCodes.id, latest.id), eq(otpCodes.consumed, false))).returning({ id: otpCodes.id });
  if (!consumed) throw Errors.badRequest('This code has already been used.', 'OTP_USED');

  let [user] = await db.select().from(users).where(eq(users.phone, phone)).limit(1);
  if (user) {
    // Phone codes are for customers and riders. Admin/vendor accounts need their password.
    if (user.role === 'ADMIN' || user.role === 'VENDOR') {
      throw Errors.forbidden('Please log in with your email and password.');
    }
    if (user.status === 'SUSPENDED') throw Errors.accountSuspended();
  } else {
    try {
      user = await db.transaction(async (tx) => {
        const [u] = await tx.insert(users).values({
          role: 'CUSTOMER', phone, fullName: fullName?.trim() || 'Doraha customer', status: 'ACTIVE',
        }).returning();
        await tx.insert(customerProfiles).values({ userId: u.id });
        await tx.insert(carts).values({ userId: u.id });
        return u;
      });
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      [user] = await db.select().from(users).where(eq(users.phone, phone)).limit(1); // lost a race
    }
>>>>>>> 27c0a9374784eadab3dd5f77b201c2a034349c2c
  }

  await db
    .update(otpCodes)
    .set({
      consumed: true,
    })
    .where(eq(otpCodes.id, latest.id));

  let [user] = await db
    .select()
    .from(users)
    .where(eq(users.phone, phone))
    .limit(1);

  if (!user) {
    [user] = await db
      .insert(users)
      .values({
        role: 'CUSTOMER',
        phone,
        fullName: fullName ?? 'Doraha customer',
        status: 'ACTIVE',
      })
      .returning();

    await db.insert(customerProfiles).values({
      userId: user.id,
    });

    await db.insert(carts).values({
      userId: user.id,
    });
  }

  await db
    .update(users)
    .set({
      lastLoginAt: new Date(),
    })
    .where(eq(users.id, user.id));

  return {
    user: toPublic(user),
    token: signToken({
      sub: user.id,
      role: user.role,
    }),
  };
}

<<<<<<< HEAD
/** Google sign-in. Links to an existing account by email if one exists; otherwise creates a new customer. */
export async function loginWithGoogle(idToken: string) {
  if (!googleClient) {
    throw Errors.badRequest(
      'Google sign-in is not configured on this server.',
      'GOOGLE_NOT_CONFIGURED',
    );
  }

  const ticket = await googleClient.verifyIdToken({
    idToken,
    audience: env.GOOGLE_CLIENT_ID,
  });

  const payload = ticket.getPayload();

  if (!payload?.email) {
    throw Errors.badRequest(
      'Could not verify this Google account.',
    );
  }

  const googleId = payload.sub;
  const googleEmail = payload.email;
  const name = payload.name ?? 'Doraha customer';

  // 1. Already linked by googleId
  let [user] = await db
    .select()
    .from(users)
    .where(eq(users.googleId, googleId))
    .limit(1);

  // 2. Not linked yet, but an account with this email already exists — link it safely.
  if (!user) {
    const [existing] = await db
      .select()
      .from(users)
      .where(eq(users.email, googleEmail))
      .limit(1);

    if (existing) {
      [user] = await db
        .update(users)
        .set({
          googleId,
          lastLoginAt: new Date(),
        })
        .where(eq(users.id, existing.id))
        .returning();
    }
  }

  // 3. Brand new account
  if (!user) {
    [user] = await db
      .insert(users)
      .values({
        role: 'CUSTOMER',
        email: googleEmail,
        googleId,
        fullName: name,
        status: 'ACTIVE',
      })
      .returning();

    await db.insert(customerProfiles).values({
      userId: user.id,
    });

    await db.insert(carts).values({
      userId: user.id,
    });
  }

  if (user.status === 'SUSPENDED') {
    throw Errors.forbidden(
      'This account has been suspended.',
    );
  }

  await db
    .update(users)
    .set({
      lastLoginAt: new Date(),
    })
    .where(eq(users.id, user.id));

  return {
    user: toPublic(user),
    token: signToken({
      sub: user.id,
      role: user.role,
    }),
  };
}

/** Step 1 of password reset: email a token if the account exists. Always returns success either way — never reveals whether an email is registered. */
export async function requestPasswordReset(email: string) {
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  if (user) {
    const { token, tokenHash } =
      generateResetToken();

    const expiresAt = new Date(
      Date.now() +
        env.PASSWORD_RESET_TOKEN_TTL_MIN * 60_000,
    );

    await db
      .update(users)
      .set({
        passwordResetTokenHash: tokenHash,
        passwordResetExpiresAt: expiresAt,
      })
      .where(eq(users.id, user.id));

    const resetLink =
      `${env.APP_URL}/reset-password?uid=${user.id}&token=${token}`;

    await emailProvider.send(
      email,
      'Reset your Doraha Eats password',
      `Click to reset your password (expires in ${env.PASSWORD_RESET_TOKEN_TTL_MIN} minutes): ${resetLink}`,
    );
  }

  return {
    sent: true,
  };
}

/** Step 2 of password reset: verify the token and set a new password. */
export async function resetPassword(
  userId: string,
  token: string,
  newPassword: string,
) {
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (
    !user?.passwordResetTokenHash ||
    !user.passwordResetExpiresAt
  ) {
    throw Errors.badRequest(
      'This reset link is invalid or has expired.',
      'RESET_INVALID',
    );
  }

  if (user.passwordResetExpiresAt < new Date()) {
    throw Errors.badRequest(
      'This reset link has expired. Please request a new one.',
      'RESET_EXPIRED',
    );
  }

  if (
    !verifyResetToken(
      token,
      user.passwordResetTokenHash,
    )
  ) {
    throw Errors.badRequest(
      'This reset link is invalid.',
      'RESET_INVALID',
    );
  }

  await db
    .update(users)
    .set({
      passwordHash: await hashPassword(newPassword),
      passwordResetTokenHash: null,
      passwordResetExpiresAt: null,
    })
    .where(eq(users.id, user.id));

  return {
    reset: true,
  };
}
=======
/* ------------------------------------------------------------------- Google */

/**
 * Google sign-in for CUSTOMERS. The ID token is verified server-side (signature, issuer,
 * audience, expiry) and only then are its claims used. The client never supplies an email,
 * name, role or googleId.
 *
 *  1. googleId already known            -> log in
 *  2. verified email matches a customer -> link Google to that account (no duplicate)
 *  3. no match                          -> create customer + profile + cart
 *  4. email belongs to admin/vendor/rider -> refused (never auto-linked or converted)
 */
export async function loginWithGoogle(idToken: string) {
  const g = await verifyGoogleIdToken(idToken);
  if (!g.email) throw Errors.googleEmailNotVerified();
  if (!g.emailVerified) throw Errors.googleEmailNotVerified();

  const finish = async (u: typeof users.$inferSelect) => {
    if (u.status === 'SUSPENDED') throw Errors.accountSuspended();
    await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, u.id));
    return { user: toPublic(u), token: signToken({ sub: u.id, role: u.role }) };
  };

  // Case 1
  const [byGoogle] = await db.select().from(users).where(eq(users.googleId, g.googleId)).limit(1);
  if (byGoogle) {
    if (byGoogle.role !== 'CUSTOMER') throw Errors.googleNotAllowed();
    return finish(byGoogle);
  }

  // Case 2 / 4
  const [byMail] = await db.select().from(users).where(byEmail(g.email)).limit(1);
  if (byMail) {
    if (byMail.role !== 'CUSTOMER') throw Errors.googleNotAllowed();
    if (byMail.googleId && byMail.googleId !== g.googleId) {
      throw Errors.conflict('This account is already linked to a different Google account.', 'GOOGLE_ALREADY_LINKED');
    }
    if (byMail.status === 'SUSPENDED') throw Errors.accountSuspended();
    const [linked] = await db.update(users).set({ googleId: g.googleId, updatedAt: new Date() })
      .where(and(eq(users.id, byMail.id), or(isNull(users.googleId), eq(users.googleId, g.googleId)))).returning();
    if (!linked) throw Errors.conflict('This account is already linked to a different Google account.', 'GOOGLE_ALREADY_LINKED');
    return finish(linked);
  }

  // Case 3 (concurrency-safe: a unique violation means another request just created it)
  try {
    const created = await db.transaction(async (tx) => {
      const [u] = await tx.insert(users).values({
        role: 'CUSTOMER', email: g.email, googleId: g.googleId,
        fullName: g.name?.trim() || g.email.split('@')[0], status: 'ACTIVE',
      }).returning();
      await tx.insert(customerProfiles).values({ userId: u.id });
      await tx.insert(carts).values({ userId: u.id });
      return u;
    });
    return finish(created);
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    const [again] = await db.select().from(users)
      .where(or(eq(users.googleId, g.googleId), byEmail(g.email))).limit(1);
    if (!again || again.role !== 'CUSTOMER') throw Errors.googleNotAllowed();
    return finish(again);
  }
}
>>>>>>> 27c0a9374784eadab3dd5f77b201c2a034349c2c
