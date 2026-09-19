import { FieldValue } from 'firebase-admin/firestore';
import type { Timestamp } from 'firebase-admin/firestore';
import { AI_QUOTA_DEFAULTS } from '@shared/index';
import { db, paths } from '../utils/firestore';
import { env } from '../config/env';
import { fail } from '../utils/errors';

/**
 * Per-workspace spending guard.
 *
 * Generation is the only feature in the product that costs money on every
 * click, and the cost is incurred before anyone sees the result. Without a cap
 * a stuck retry loop, or someone leaning on the button, turns into a bill.
 *
 * Counters live in one document per workspace and are incremented inside the
 * same transaction that checks them, so two concurrent requests cannot both
 * see the last remaining unit.
 */
const perDay = () => Number(env('AI_QUOTA_PER_DAY', String(AI_QUOTA_DEFAULTS.perDay)));
const perHour = () => Number(env('AI_QUOTA_PER_HOUR', String(AI_QUOTA_DEFAULTS.perHour)));

interface QuotaDoc {
  dayKey: string;
  dayCount: number;
  hourKey: string;
  hourCount: number;
  updatedAt: Timestamp;
}

function keys(now: Date): { dayKey: string; hourKey: string } {
  const iso = now.toISOString();
  return { dayKey: iso.slice(0, 10), hourKey: iso.slice(0, 13) };
}

function quotaRef(workspaceId: string) {
  return db().doc(`${paths.workspace(workspaceId)}/aiQuota/counters`);
}

export interface QuotaState {
  dayRemaining: number;
  hourRemaining: number;
}

/**
 * Reserves one generation. Throws when the workspace is out of budget.
 *
 * Reserved up front rather than recorded afterwards: a call that fails partway
 * still consumed provider tokens, so it must still count.
 */
export async function consumeAiQuota(workspaceId: string, now = new Date()): Promise<QuotaState> {
  const { dayKey, hourKey } = keys(now);
  const ref = quotaRef(workspaceId);
  const dayLimit = perDay();
  const hourLimit = perHour();

  return db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const cur = (snap.data() as QuotaDoc | undefined) ?? null;

    const dayCount = cur?.dayKey === dayKey ? cur.dayCount : 0;
    const hourCount = cur?.hourKey === hourKey ? cur.hourCount : 0;

    if (dayCount >= dayLimit) {
      fail('resource-exhausted', `This workspace has used its ${dayLimit} AI generations for today.`, {
        reason: 'ai_quota_day',
        limit: dayLimit,
      });
    }
    if (hourCount >= hourLimit) {
      fail('resource-exhausted', `This workspace has used its ${hourLimit} AI generations for this hour.`, {
        reason: 'ai_quota_hour',
        limit: hourLimit,
      });
    }

    tx.set(
      ref,
      { dayKey, dayCount: dayCount + 1, hourKey, hourCount: hourCount + 1, updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );

    return { dayRemaining: dayLimit - dayCount - 1, hourRemaining: hourLimit - hourCount - 1 };
  });
}

/** Read-only view, so the UI can warn before the button is pressed. */
export async function readAiQuota(workspaceId: string, now = new Date()): Promise<QuotaState> {
  const { dayKey, hourKey } = keys(now);
  const snap = await quotaRef(workspaceId).get();
  const cur = (snap.data() as QuotaDoc | undefined) ?? null;
  return {
    dayRemaining: perDay() - (cur?.dayKey === dayKey ? cur.dayCount : 0),
    hourRemaining: perHour() - (cur?.hourKey === hourKey ? cur.hourCount : 0),
  };
}
