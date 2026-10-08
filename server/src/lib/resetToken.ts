import crypto from 'node:crypto';

/** A random reset token, and the sha256 hash of it that's safe to store in the DB. */
export function generateResetToken(): { token: string; tokenHash: string } {
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  return { token, tokenHash };
}

/** Constant-time comparison so timing can't leak whether a guess was close. */
export function verifyResetToken(token: string, storedHash: string): boolean {
  const candidateHash = crypto.createHash('sha256').update(token).digest('hex');
  const a = Buffer.from(candidateHash, 'hex');
  const b = Buffer.from(storedHash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
