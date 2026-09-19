import { onTaskDispatched } from 'firebase-functions/v2/tasks';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { z } from 'zod';
import { ALL_SECRETS, REGION } from '../config/env';
import { getRegistry } from '../providers';
import { getDispatcher, type DeliveryTaskPayload } from './dispatcher';
import { checkDeliveryStatus, executeDelivery } from '../publishing/engine';
import { queueUpcomingDeliveries, reconcileDeliveries } from '../scheduling/maintenance';
import { refreshConnection } from '../services/connections';
import { Timestamp, db } from '../utils/firestore';
import { log } from '../utils/logger';

const payloadSchema = z.object({
  kind: z.enum(['execute', 'status_check']),
  workspaceId: z.string().min(1),
  deliveryId: z.string().min(1),
  scheduleVersion: z.number().int().min(1),
  seq: z.number().int().min(0),
});

function parsePayload(data: unknown): DeliveryTaskPayload | null {
  const r = payloadSchema.safeParse(data);
  if (!r.success) {
    log.error('Malformed task payload ignored', { issues: r.error.issues.length });
    return null;
  }
  return r.data;
}

const deps = () => ({ registry: getRegistry(), dispatcher: getDispatcher() });

/**
 * One Cloud Task per delivery. Cloud Tasks may deliver a task more than once:
 * the engine's transactional claim makes duplicates no-ops. The handler only
 * throws on infrastructure errors (so Cloud Tasks retries); publication errors
 * are handled by the engine with its own backoff.
 */
export const executeDeliveryTask = onTaskDispatched(
  {
    region: REGION,
    secrets: ALL_SECRETS,
    timeoutSeconds: 1800,
    memory: '1GiB',
    retryConfig: { maxAttempts: 5, minBackoffSeconds: 30, maxBackoffSeconds: 600 },
    rateLimits: { maxConcurrentDispatches: 20 },
  },
  async (req) => {
    const payload = parsePayload(req.data);
    if (!payload) return;
    const outcome = await executeDelivery(payload, deps());
    log.info('executeDelivery', { deliveryId: payload.deliveryId, version: payload.scheduleVersion, outcome: outcome.action });
  },
);

export const checkDeliveryStatusTask = onTaskDispatched(
  {
    region: REGION,
    secrets: ALL_SECRETS,
    timeoutSeconds: 300,
    retryConfig: { maxAttempts: 5, minBackoffSeconds: 30 },
    rateLimits: { maxConcurrentDispatches: 20 },
  },
  async (req) => {
    const payload = parsePayload(req.data);
    if (!payload) return;
    const outcome = await checkDeliveryStatus(payload, deps());
    log.info('checkDeliveryStatus', { deliveryId: payload.deliveryId, outcome: outcome.action });
  },
);

/** Layer 2 of the 30-day strategy. */
export const queueUpcomingDeliveriesJob = onSchedule({ region: REGION, schedule: 'every day 02:00', timeZone: 'UTC', secrets: ALL_SECRETS, timeoutSeconds: 540 }, async () => {
  await queueUpcomingDeliveries(deps());
});

export const reconcileDeliveriesJob = onSchedule({ region: REGION, schedule: 'every 15 minutes', secrets: ALL_SECRETS, timeoutSeconds: 540 }, async () => {
  await reconcileDeliveries(deps());
});

/** Proactive token health checks: never discover a dead token at publish time. */
export const connectionHealthJob = onSchedule({ region: REGION, schedule: 'every 6 hours', secrets: ALL_SECRETS, timeoutSeconds: 540 }, async () => {
  const snaps = await db().collectionGroup('socialConnections').where('status', 'in', ['connected', 'error']).get();
  for (const doc of snaps.docs) {
    const workspaceId = doc.ref.parent.parent!.id;
    try {
      await refreshConnection(getRegistry(), workspaceId, doc.id);
    } catch (e) {
      log.warn('Health check failed', { workspaceId, connectionId: doc.id, error: (e as Error).message });
    }
  }
});

/** Belt and braces next to the Firestore TTL policy on oauthStates.expiresAt. */
export const cleanupOAuthStatesJob = onSchedule({ region: REGION, schedule: 'every 60 minutes' }, async () => {
  const expired = await db().collection('oauthStates').where('expiresAt', '<', Timestamp.now()).limit(500).get();
  const batch = db().batch();
  expired.docs.forEach((d) => batch.delete(d.ref));
  await batch.commit();
});
