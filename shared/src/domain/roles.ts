import type { Role } from './types';

/**
 * Permission matrix. Firestore rules mirror this (see firestore.rules) and the
 * backend enforces it on every callable via `requireRole`.
 */
export const PERMISSIONS = {
  'workspace.read': ['OWNER', 'ADMIN', 'EDITOR', 'VIEWER'],
  'workspace.settings': ['OWNER', 'ADMIN'],
  'workspace.transferOwnership': ['OWNER'],
  'workspace.delete': ['OWNER'],
  'members.manage': ['OWNER', 'ADMIN'],
  'connections.manage': ['OWNER', 'ADMIN'],
  'content.write': ['OWNER', 'ADMIN', 'EDITOR'],
  'content.schedule': ['OWNER', 'ADMIN', 'EDITOR'],
  'media.write': ['OWNER', 'ADMIN', 'EDITOR'],
  'logs.read': ['OWNER', 'ADMIN', 'EDITOR', 'VIEWER'],
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMISSIONS;

export function can(role: Role | null | undefined, permission: Permission): boolean {
  if (!role) return false;
  return (PERMISSIONS[permission] as readonly Role[]).includes(role);
}

const RANK: Record<Role, number> = { OWNER: 4, ADMIN: 3, EDITOR: 2, VIEWER: 1 };

/**
 * Whether `actor` may assign `targetRole` to / remove a member currently holding `currentRole`.
 * Nobody but the owner touches the owner; admins cannot create owners.
 */
export function canManageMember(actor: Role, currentRole: Role | null, targetRole: Role | null): boolean {
  if (!can(actor, 'members.manage')) return false;
  if (currentRole === 'OWNER' || targetRole === 'OWNER') return false; // ownership transfer is a dedicated flow
  if (actor === 'OWNER') return true;
  // ADMIN may manage ADMIN/EDITOR/VIEWER but never above own rank
  return (currentRole === null || RANK[currentRole] <= RANK[actor]) && (targetRole === null || RANK[targetRole] <= RANK[actor]);
}
