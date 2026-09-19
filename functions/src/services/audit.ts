import type { Transaction, WriteBatch } from 'firebase-admin/firestore';
import type { AuditLog } from '@shared/index';
import { FieldValue, clean, db, paths } from '../utils/firestore';
import { sanitize } from '../utils/logger';

export type AuditActor = AuditLog['actor'];

export const SYSTEM_ACTOR: AuditActor = { uid: null, type: 'system' };
export const userActor = (uid: string, email: string | null = null): AuditActor => ({ uid, type: 'user', email });

export interface AuditEntry {
  workspaceId: string;
  actor: AuditActor;
  action: string;
  entityType: AuditLog['entityType'];
  entityId: string;
  metadata?: Record<string, unknown>;
}

function toDoc(e: AuditEntry) {
  return clean({
    workspaceId: e.workspaceId,
    actor: e.actor,
    action: e.action,
    entityType: e.entityType,
    entityId: e.entityId,
    metadata: sanitize(e.metadata ?? {}) as Record<string, unknown>,
    timestamp: FieldValue.serverTimestamp(),
  });
}

/** Audit logs are append-only and written exclusively by the backend. */
export async function audit(e: AuditEntry, tx?: Transaction | WriteBatch): Promise<void> {
  const ref = db().collection(paths.auditLogs(e.workspaceId)).doc();
  if (tx) {
    (tx as Transaction).set(ref, toDoc(e));
    return;
  }
  await ref.set(toDoc(e));
}
