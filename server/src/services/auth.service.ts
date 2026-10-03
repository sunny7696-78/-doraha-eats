import { eq, or } from 'drizzle-orm';
import { db } from '../db/index.js';
import { users, customerProfiles, deliveryPartners, carts } from '../db/schema.js';
import { hashPassword, verifyPassword } from '../lib/password.js';
import { signToken } from '../lib/jwt.js';
import { Errors } from '../lib/errors.js';
import { smsProvider } from '../adapters/sms/index.js';
import { otpCodes } from '../db/schema.js';
import { OAuth2Client } from 'google-auth-library';
import { emailProvider } from '../adapters/email/index.js';
import { generateResetToken, verifyResetToken } from '../lib/resetToken.js';
import { env } from '../config/env.js';

const googleClient = env.GOOGLE_CLIENT_ID
  ? new OAuth2Client(env.GOOGLE_CLIENT_ID)
  : null;

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
}

export async function login(input: {
  email?: string;
  phone?: string;
  password: string;
}) {
  const conditions = [];

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