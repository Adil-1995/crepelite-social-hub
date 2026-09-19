import type { CallableRequest } from 'firebase-functions/v2/https';
import { can, type Permission, type Role, type WorkspaceMember } from '@shared/index';
import { db, paths } from '../utils/firestore';
import { fail } from '../utils/errors';

export interface Actor {
  uid: string;
  email: string | null;
  role: Role;
  member: WorkspaceMember;
}

export function requireAuth(request: Pick<CallableRequest, 'auth'>): { uid: string; email: string | null; emailVerified: boolean } {
  if (!request.auth) fail('unauthenticated', 'Sign in required');
  const token = request.auth.token as { email?: string; email_verified?: boolean };
  return { uid: request.auth.uid, email: token.email ?? null, emailVerified: token.email_verified === true };
}

/** Verifies workspace membership and permission from the authoritative members doc. */
export async function requirePermission(request: Pick<CallableRequest, 'auth'>, workspaceId: string, permission: Permission): Promise<Actor> {
  const { uid, email } = requireAuth(request);
  const snap = await db().doc(paths.member(workspaceId, uid)).get();
  if (!snap.exists) fail('permission-denied', 'You are not a member of this workspace');
  const member = snap.data() as WorkspaceMember;
  if (!can(member.role, permission)) fail('permission-denied', `Your role (${member.role}) cannot perform this action`);
  return { uid, email, role: member.role, member };
}
