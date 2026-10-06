import { db } from '../db/index.js';
import { auditLogs } from '../db/schema.js';

/**
 * Records who did what for sensitive admin actions (money, fees, approvals, suspensions).
 * Never throws: an audit-write hiccup must not block the action, but it IS logged loudly.
 */
export async function audit(input: {
  actorId: string; action: string; entityType: string; entityId?: string | null;
  before?: unknown; after?: unknown;
}): Promise<void> {
  try {
    await db.insert(auditLogs).values({
      actorId: input.actorId, action: input.action, entityType: input.entityType,
      entityId: input.entityId ?? null, before: (input.before ?? null) as never, after: (input.after ?? null) as never,
    });
  } catch (e) {
    console.error(JSON.stringify({ at: 'audit', msg: 'FAILED to write audit log', action: input.action, err: String((e as Error)?.message ?? e) }));
  }
}
