import { OAuth2Client } from 'google-auth-library';
import { env } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';

export type GoogleIdentity = {
  googleId: string; email: string; emailVerified: boolean; name: string | null; picture: string | null;
};

export const googleClientIds = (): string[] =>
  (env.GOOGLE_CLIENT_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean);

let client: OAuth2Client | null = null;

/**
 * Verifies a Google ID token the official way (google-auth-library): signature against
 * Google's published keys, issuer, expiry, and that the token was issued for one of OUR
 * client ids (web / Android / iOS). Nothing from the client is trusted before this passes.
 */
export async function verifyGoogleIdToken(idToken: string): Promise<GoogleIdentity> {
  const audiences = googleClientIds();
  if (!audiences.length) {
    throw new AppError(503, 'GOOGLE_NOT_CONFIGURED', 'Google sign-in is not available right now.');
  }
  client ??= new OAuth2Client();
  try {
    const ticket = await client.verifyIdToken({ idToken, audience: audiences });
    const p = ticket.getPayload();
    if (!p?.sub) throw new Error('no subject');
    return {
      googleId: p.sub, email: (p.email ?? '').toLowerCase(), emailVerified: p.email_verified === true,
      name: p.name ?? null, picture: p.picture ?? null,
    };
  } catch {
    throw new AppError(401, 'INVALID_GOOGLE_TOKEN', 'Google sign-in failed. Please try again.');
  }
}
