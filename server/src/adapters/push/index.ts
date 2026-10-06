import { inArray } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { deviceTokens } from '../../db/schema.js';
import { env } from '../../config/env.js';

export type PushMessage = { title: string; body: string; data?: Record<string, unknown> };

export interface PushProvider {
  /** Never throws: a push problem must not break the order/payment action that triggered it. */
  send(tokens: string[], message: PushMessage): Promise<void>;
}

/** In-app only: notifications live in PostgreSQL and the app polls them. */
const inAppProvider: PushProvider = {
  async send() { /* nothing to push */ },
};

export const EXPO_TOKEN_RE = /^(ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_-]+\]$/;
const EXPO_URL = 'https://exp.host/--/api/v2/push/send';

type Ticket = { status: 'ok' | 'error'; message?: string; details?: { error?: string } };

/**
 * Expo push (REST, no SDK). Sends in batches of 100, and when Expo says a device is no longer
 * registered (app uninstalled / permission revoked) the dead token is deleted so we stop
 * sending to it.
 */
const expoProvider: PushProvider = {
  async send(tokens, message) {
    const valid = [...new Set(tokens)].filter((t) => EXPO_TOKEN_RE.test(t));
    for (let i = 0; i < valid.length; i += 100) {
      const batch = valid.slice(i, i + 100);
      try {
        const res = await fetch(EXPO_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json', Accept: 'application/json',
            ...(env.EXPO_ACCESS_TOKEN ? { Authorization: `Bearer ${env.EXPO_ACCESS_TOKEN}` } : {}),
          },
          body: JSON.stringify(batch.map((to) => ({
            to, title: message.title, body: message.body, data: message.data ?? {},
            sound: 'default', priority: 'high', channelId: 'orders',
          }))),
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) {
          console.error(JSON.stringify({ at: 'push', msg: 'expo http error', status: res.status }));
          continue;
        }
        const { data } = (await res.json()) as { data?: Ticket[] };
        const dead = (data ?? [])
          .map((t, idx) => (t.status === 'error' && t.details?.error === 'DeviceNotRegistered' ? batch[idx] : null))
          .filter((t): t is string => !!t);
        if (dead.length) {
          await db.delete(deviceTokens).where(inArray(deviceTokens.token, dead));
          console.log(JSON.stringify({ at: 'push', msg: 'removed dead device tokens', count: dead.length }));
        }
      } catch (e) {
        console.error(JSON.stringify({ at: 'push', msg: 'expo send failed', err: String((e as Error)?.message ?? e) }));
      }
    }
  },
};

export const pushProvider: PushProvider = env.PUSH_PROVIDER === 'expo' ? expoProvider : inAppProvider;
