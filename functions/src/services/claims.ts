import { getAuth } from 'firebase-admin/auth';
import type { Role } from '@shared/index';
import { db } from '../utils/firestore';
import { log } from '../utils/logger';

/**
 * Workspace membership mirrored into the user's ID token.
 *
 * Cloud Storage rules need to know which workspaces a user may write media to.
 * They can read Firestore across services, but that costs a document read on
 * every upload and depends on an IAM grant that is easy to miss on a fresh
 * project — when it is missing, every upload is denied with no useful error.
 *
 * Putting the answer in a custom claim removes both problems. The claim is a
 * plain list of workspace ids where the user holds a content-writing role, and
 * the Storage rules fall back to the Firestore lookup when it is absent, so an
 * out-of-date token is never *more* permissive.
 *
 * Claims are capped at 1000 bytes by Firebase, so the list is bounded.
 */

/** Roles allowed to upload media. Mirrors `media.write` in shared/domain/roles. */
const WRITE_ROLES: readonly Role[] = ['OWNER', 'ADMIN', 'EDITOR'];

/** Custom-claim key: workspaces this user may write to. */
export const WORKSPACE_WRITE_CLAIM = 'wsw';

const MAX_WORKSPACES = 40;

/**
 * Recomputes the claim from the membership mirror and writes it to the user.
 *
 * Call this after any change to a membership, and never inside the transaction
 * that makes the change — the claim must reflect committed state.
 */
export async function syncWorkspaceClaims(uid: string): Promise<string[]> {
  const snap = await db().collection(`users/${uid}/memberships`).get();

  const writable = snap.docs
    .filter((d) => WRITE_ROLES.includes(d.get('role') as Role))
    .map((d) => d.id)
    .sort()
    .slice(0, MAX_WORKSPACES);

  try {
    const user = await getAuth().getUser(uid);
    const existing = (user.customClaims ?? {}) as Record<string, unknown>;
    const current = Array.isArray(existing[WORKSPACE_WRITE_CLAIM]) ? (existing[WORKSPACE_WRITE_CLAIM] as string[]) : [];

    // Setting claims invalidates nothing by itself, but it does force the
    // client to refresh before the new value is visible. Skip the write when
    // nothing changed so a plain sign-in does not churn tokens.
    if (current.length === writable.length && current.every((w, i) => w === writable[i])) {
      return writable;
    }

    await getAuth().setCustomUserClaims(uid, { ...existing, [WORKSPACE_WRITE_CLAIM]: writable });
    log.info('workspace claims updated', { uid, count: writable.length });
  } catch (e) {
    // A claim failure must not break sign-in or workspace creation: the
    // Storage rules still have the Firestore fallback.
    log.warn('could not update workspace claims', { uid, error: (e as Error).message });
  }

  return writable;
}

/** Recomputes claims for several users, tolerating individual failures. */
export async function syncWorkspaceClaimsFor(uids: readonly string[]): Promise<void> {
  await Promise.all([...new Set(uids)].map((uid) => syncWorkspaceClaims(uid)));
}
