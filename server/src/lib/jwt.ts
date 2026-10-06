import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';

export type JwtPayload = {
  sub: string;
  role: 'CUSTOMER' | 'VENDOR' | 'DELIVERY' | 'ADMIN';
  /** Token version; must match users.token_version (bumped on logout). Missing = 0. */
  tv?: number;
};

export const signToken = (payload: JwtPayload): string =>
  jwt.sign(payload, env.JWT_SECRET, { algorithm: 'HS256', expiresIn: env.JWT_EXPIRES_IN } as jwt.SignOptions);

/** Algorithm is pinned so a forged "alg" header can never downgrade verification. */
export const verifyToken = (token: string): JwtPayload =>
  jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'] }) as JwtPayload;
