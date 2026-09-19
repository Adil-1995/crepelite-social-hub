import { queueWindowEnd, statusCheckTaskId, type Delivery } from '@shared/index';
import { Timestamp, db, paths, FieldValue } from '../utils/firestore';
import { log } from '../utils/logger';
import { promoteAwaitingDelivery, reEnqueueDelivery, type SchedulerDeps } from './scheduler';
import { readPostDeliveries, writePostAggregate } from '../publishing/aggregate';

const PAGE = 200;
const STALE_QUEUED_MS = 10 * 60 * 1000;
const STALE_PROCESSING_CHECK_MS = 15 * 60 * 1000;
const PROCESSING_TIMEOUT_MS = 48 * 60 * 60 * 1000;
const UNTRACKED_TASK_MS = 5 * 60 * 1000;

function toDelivery(doc: FirebaseFirestore.QueryDocumentSnapshot): Delivery {
  return { id: doc.id, ...doc.data() } as Delivery;
}

/**
 * Daily job (layer 2): enqueue Cloud Tasks for awaiting_queue deliveries that
 * are now within the Cloud Tasks window. Uses a collection-group query on
 * (status, scheduledAt) — never a full scan of the database.
 */
export async function queueUpcomingDeliveries(deps: SchedulerDeps): Promise<{ promoted: number }> {
  const nowMs = (deps.now ?? Date.now)();
  const end = Timestamp.fromMillis(queueWindowEnd(nowMs));
  let promoted = 0;
  let cursor: FirebaseFirestore.QueryDocumentSnapshot | null = null;
  for (;;) {
    let q = db().collectionGroup('deliveries').where('status', '==', 'awaiting_queue').where('scheduledAt', '<=', end).orderBy('scheduledAt').limit(PAGE);
    if (cursor) q = q.startAfter(cursor);
    const snap = await q.get();
    for (const doc of snap.docs) {
      const d = toDelivery(doc);
      if (await promoteAwaitingDelivery(deps, d.workspaceId, d.id)) promoted++;
    }
    if (snap.size < PAGE) break;
    cursor = snap.docs[snap.docs.length - 1] ?? null;
  }
  log.info('queueUpcomingDeliveries done', { promoted });
  return { promoted };
}

export interface ReconcileReport {
  expiredLeases: number;
  lostQueued: number;
  untracked: number;
  staleProcessing: number;
  processingTimeouts: number;
  promoted: number;
}

/**
 * Periodic safety net. Detects and repairs:
 * - publishing deliveries whose lease expired (executor crashed) → recovery task
 *   (the engine resolves them via provider status/checkpoint, never blind re-publish)
 * - queued deliveries whose time passed but never ran (lost/missing task)
 * - queued deliveries without a task name (enqueue failed after commit)
 * - processing deliveries whose status check is overdue, or processing for too long
 * - awaiting_queue deliveries already inside the window (missed daily job)
 */
export async function reconcileDeliveries(deps: SchedulerDeps): Promise<ReconcileReport> {
  const nowMs = (deps.now ?? Date.now)();
  const now = Timestamp.fromMillis(nowMs);
  const bucket = Math.floor(nowMs / (15 * 60 * 1000));
  const report: ReconcileReport = { expiredLeases: 0, lostQueued: 0, untracked: 0, staleProcessing: 0, processingTimeouts: 0, promoted: 0 };

  // 1. Stuck in publishing with an expired lease
  const publishing = await db().collectionGroup('deliveries').where('status', '==', 'publishing').where('publishingLease.expiresAt', '<', now).limit(PAGE).get();
  for (const doc of publishing.docs) {
    await reEnqueueDelivery(deps, toDelivery(doc), bucket);
    report.expiredLeases++;
  }

  // 2. Queued, due, but still queued long after its time → task missing
  const lost = await db()
    .collectionGroup('deliveries')
    .where('status', '==', 'queued')
    .where('scheduledAt', '<', Timestamp.fromMillis(nowMs - STALE_QUEUED_MS))
    .limit(PAGE)
    .get();
  for (const doc of lost.docs) {
    const d = toDelivery(doc);
    // Pending automatic retry in the future is not "lost".
    if (d.nextAttemptAt && d.nextAttemptAt.toMillis() > nowMs - STALE_QUEUED_MS) continue;
    await reEnqueueDelivery(deps, d, bucket);
    report.lostQueued++;
  }

  // 3. Queued without taskName (enqueue failed after the scheduling transaction)
  const untracked = await db()
    .collectionGroup('deliveries')
    .where('status', '==', 'queued')
    .where('taskName', '==', null)
    .where('updatedAt', '<', Timestamp.fromMillis(nowMs - UNTRACKED_TASK_MS))
    .limit(PAGE)
    .get();
  for (const doc of untracked.docs) {
    await reEnqueueDelivery(deps, toDelivery(doc), bucket);
    report.untracked++;
  }

  // 4. Processing: overdue status check or too long overall
  const processing = await db()
    .collectionGroup('deliveries')
    .where('status', '==', 'processing')
    .where('nextStatusCheckAt', '<', Timestamp.fromMillis(nowMs - STALE_PROCESSING_CHECK_MS))
    .limit(PAGE)
    .get();
  for (const doc of processing.docs) {
    const d = toDelivery(doc);
    if (d.publishingLease && d.publishingLease.expiresAt.toMillis() > nowMs) continue;
    if (d.lastAttemptAt && nowMs - d.lastAttemptAt.toMillis() > PROCESSING_TIMEOUT_MS) {
      await db().runTransaction(async (tx) => {
        const ref = db().doc(paths.delivery(d.workspaceId, d.id));
        const s = await tx.get(ref);
        if (s.get('status') !== 'processing' || s.get('scheduleVersion') !== d.scheduleVersion) return;
        const deliveries = await readPostDeliveries(tx, d.workspaceId, d.postId);
        const upd = {
          status: 'failed' as const,
          publishingLease: null,
          error: { code: 'processing_timeout', message: 'The platform did not finish processing in 48 h. Verify on the platform.', category: 'PROCESSING' as const, retryable: false },
        };
        tx.update(ref, { ...upd, updatedAt: FieldValue.serverTimestamp() });
        writePostAggregate(tx, d.workspaceId, d.postId, deliveries, new Map([[d.id, upd]]));
      });
      report.processingTimeouts++;
      continue;
    }
    const seq = 1_000_000 + bucket;
    await deps.dispatcher.enqueue(
      'functions',
      { kind: 'status_check', workspaceId: d.workspaceId, deliveryId: d.id, scheduleVersion: d.scheduleVersion, seq },
      { id: statusCheckTaskId(d.id, d.scheduleVersion, seq), scheduleAt: new Date(nowMs) },
    );
    report.staleProcessing++;
  }

  // 5. Awaiting queue already inside the window
  const due = await db()
    .collectionGroup('deliveries')
    .where('status', '==', 'awaiting_queue')
    .where('scheduledAt', '<=', Timestamp.fromMillis(queueWindowEnd(nowMs)))
    .orderBy('scheduledAt')
    .limit(PAGE)
    .get();
  for (const doc of due.docs) {
    const d = toDelivery(doc);
    if (await promoteAwaitingDelivery(deps, d.workspaceId, d.id)) report.promoted++;
  }

  if (Object.values(report).some((v) => v > 0)) log.warn('reconcileDeliveries repaired inconsistencies', { ...report });
  return report;
}
