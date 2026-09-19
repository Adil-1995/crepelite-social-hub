import { z } from 'zod';
import {
  DEFAULT_NOTIFICATION_PREFS,
  canManageMember,
  inviteMemberSchema,
  notificationPrefsSchema,
  registerPushTokenSchema,
  removeMemberSchema,
  revokeInvitationSchema,
  updateMemberSchema,
  workspaceCreateSchema,
  workspaceUpdateSchema,
  zId,
  type Role,
  type WorkspaceMember,
} from '@shared/index';
import { createHash } from 'node:crypto';
import { requireAuth, requirePermission } from '../auth/access';
import { callable } from './callable';
import { FieldValue, Timestamp, db, paths } from '../utils/firestore';
import { fail } from '../utils/errors';
import { audit, userActor } from '../services/audit';
import { syncWorkspaceClaims, syncWorkspaceClaimsFor } from '../services/claims';
import { env } from '../config/env';

const INVITE_TTL_MS = 14 * 24 * 3600 * 1000;

function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}

async function writeMembership(workspaceId: string, uid: string, member: Omit<WorkspaceMember, 'addedAt'>, workspaceName: string, tx?: FirebaseFirestore.Transaction) {
  const memberRef = db().doc(paths.member(workspaceId, uid));
  const mirrorRef = db().doc(`users/${uid}/memberships/${workspaceId}`);
  const m = { ...member, addedAt: FieldValue.serverTimestamp() };
  const mirror = { workspaceId, workspaceName, role: member.role, updatedAt: FieldValue.serverTimestamp() };
  if (tx) {
    tx.set(memberRef, m);
    tx.set(mirrorRef, mirror);
  } else {
    await memberRef.set(m);
    await mirrorRef.set(mirror);
  }
}

/**
 * Called by the PWA after sign-in: creates the user profile and accepts
 * pending invitations addressed to the verified e-mail.
 */
export const bootstrapUserFn = callable(z.object({}).default({}), async (_data, req) => {
  const { uid, email, emailVerified } = requireAuth(req);
  const token = req.auth!.token as { name?: string; picture?: string; firebase?: { sign_in_provider?: string } };
  const userRef = db().doc(paths.user(uid));
  const snap = await userRef.get();
  if (!snap.exists) {
    await userRef.set({ uid, email, displayName: token.name ?? null, defaultWorkspaceId: null, notificationPrefs: DEFAULT_NOTIFICATION_PREFS, createdAt: FieldValue.serverTimestamp() });
  }
  // Google sign-in e-mails are verified by Google; password accounts must verify first.
  const trusted = emailVerified || token.firebase?.sign_in_provider === 'google.com';
  const accepted: string[] = [];
  if (email && trusted) {
    const invites = await db().collectionGroup('invitations').where('email', '==', email.toLowerCase()).get();
    for (const inv of invites.docs) {
      const workspaceId = inv.ref.parent.parent!.id;
      if ((inv.get('expiresAt') as Timestamp).toMillis() < Date.now()) continue;
      await db().runTransaction(async (tx) => {
        const ws = await tx.get(db().doc(paths.workspace(workspaceId)));
        const existing = await tx.get(db().doc(paths.member(workspaceId, uid)));
        if (!ws.exists || existing.exists) {
          tx.delete(inv.ref);
          return;
        }
        await writeMembership(workspaceId, uid, { uid, role: inv.get('role') as Role, email, displayName: token.name ?? null, photoURL: token.picture ?? null, addedBy: inv.get('invitedBy') as string }, ws.get('name') as string, tx);
        tx.delete(inv.ref);
        await audit({ workspaceId, actor: userActor(uid, email), action: 'member.joined', entityType: 'member', entityId: uid, metadata: { role: inv.get('role') } }, tx);
      });
      accepted.push(workspaceId);
    }
  }
  // Storage rules read this claim instead of doing a cross-service Firestore
  // lookup on every upload. Refreshed here so an existing user picks it up on
  // their next sign-in without any migration.
  await syncWorkspaceClaims(uid);

  const memberships = await db().collection(`users/${uid}/memberships`).get();
  return {
    acceptedInvitations: accepted,
    emailVerified: trusted,
    memberships: memberships.docs.map((d) => ({ workspaceId: d.id, workspaceName: d.get('workspaceName') as string, role: d.get('role') as Role })),
    canCreateWorkspace: env('ALLOW_WORKSPACE_CREATION', 'true') === 'true',
  };
});

export const createWorkspaceFn = callable(workspaceCreateSchema, async (data, req) => {
  const { uid, email } = requireAuth(req);
  if (env('ALLOW_WORKSPACE_CREATION', 'true') !== 'true') fail('permission-denied', 'Workspace creation is disabled');
  const ref = db().collection('workspaces').doc();
  await db().runTransaction(async (tx) => {
    tx.set(ref, { name: data.name, slug: slugify(data.name), timezone: data.timezone, ownerId: uid, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
    const token = req.auth!.token as { name?: string; picture?: string };
    await writeMembership(ref.id, uid, { uid, role: 'OWNER', email: email ?? '', displayName: token.name ?? null, photoURL: token.picture ?? null, addedBy: null }, data.name, tx);
    tx.set(db().doc(paths.user(uid)), { defaultWorkspaceId: ref.id }, { merge: true });
    await audit({ workspaceId: ref.id, actor: userActor(uid, email), action: 'workspace.created', entityType: 'workspace', entityId: ref.id, metadata: { name: data.name, timezone: data.timezone } }, tx);
  });
  await syncWorkspaceClaims(uid);
  return { workspaceId: ref.id };
});

export const updateWorkspaceFn = callable(workspaceUpdateSchema, async (data, req) => {
  const actor = await requirePermission(req, data.workspaceId, 'workspace.settings');
  const patch: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() };
  if (data.name) patch.name = data.name;
  if (data.timezone) patch.timezone = data.timezone;
  await db().doc(paths.workspace(data.workspaceId)).update(patch);
  if (data.name) {
    const members = await db().collection(paths.members(data.workspaceId)).get();
    await Promise.all(members.docs.map((m) => db().doc(`users/${m.id}/memberships/${data.workspaceId}`).set({ workspaceName: data.name }, { merge: true })));
  }
  await audit({ workspaceId: data.workspaceId, actor: userActor(actor.uid, actor.email), action: 'workspace.updated', entityType: 'workspace', entityId: data.workspaceId, metadata: { name: data.name, timezone: data.timezone } });
  return { ok: true };
});

export const inviteMemberFn = callable(inviteMemberSchema, async (data, req) => {
  const actor = await requirePermission(req, data.workspaceId, 'members.manage');
  if (!canManageMember(actor.role, null, data.role)) fail('permission-denied', 'You cannot grant this role');
  const existing = await db().collection(paths.members(data.workspaceId)).where('email', '==', data.email).limit(1).get();
  if (!existing.empty) fail('already-exists', 'This person is already a member');
  await db()
    .doc(`${paths.invitations(data.workspaceId)}/${createHash('sha256').update(data.email).digest('hex').slice(0, 32)}`)
    .set({ email: data.email, role: data.role, invitedBy: actor.uid, createdAt: FieldValue.serverTimestamp(), expiresAt: Timestamp.fromMillis(Date.now() + INVITE_TTL_MS) });
  await audit({ workspaceId: data.workspaceId, actor: userActor(actor.uid, actor.email), action: 'member.invited', entityType: 'member', entityId: data.email, metadata: { role: data.role } });
  return { ok: true };
});

export const revokeInvitationFn = callable(revokeInvitationSchema, async (data, req) => {
  const actor = await requirePermission(req, data.workspaceId, 'members.manage');
  await db().doc(`${paths.invitations(data.workspaceId)}/${createHash('sha256').update(data.email).digest('hex').slice(0, 32)}`).delete();
  await audit({ workspaceId: data.workspaceId, actor: userActor(actor.uid, actor.email), action: 'member.invitation_revoked', entityType: 'member', entityId: data.email, metadata: {} });
  return { ok: true };
});

export const updateMemberRoleFn = callable(updateMemberSchema, async (data, req) => {
  const actor = await requirePermission(req, data.workspaceId, 'members.manage');
  await db().runTransaction(async (tx) => {
    const ref = db().doc(paths.member(data.workspaceId, data.uid));
    const snap = await tx.get(ref);
    if (!snap.exists) fail('not-found', 'Member not found');
    const current = snap.get('role') as Role;
    if (!canManageMember(actor.role, current, data.role)) fail('permission-denied', 'You cannot change this member');
    tx.update(ref, { role: data.role });
    tx.set(db().doc(`users/${data.uid}/memberships/${data.workspaceId}`), { role: data.role, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    await audit({ workspaceId: data.workspaceId, actor: userActor(actor.uid, actor.email), action: 'member.role_changed', entityType: 'member', entityId: data.uid, metadata: { from: current, to: data.role } }, tx);
  });
  await syncWorkspaceClaims(data.uid);
  return { ok: true };
});

export const removeMemberFn = callable(removeMemberSchema, async (data, req) => {
  const { uid } = requireAuth(req);
  const leavingSelf = uid === data.uid;
  const actor = leavingSelf ? await requirePermission(req, data.workspaceId, 'workspace.read') : await requirePermission(req, data.workspaceId, 'members.manage');
  await db().runTransaction(async (tx) => {
    const ref = db().doc(paths.member(data.workspaceId, data.uid));
    const snap = await tx.get(ref);
    if (!snap.exists) fail('not-found', 'Member not found');
    const current = snap.get('role') as Role;
    if (current === 'OWNER') fail('failed-precondition', 'The owner cannot be removed. Transfer ownership first.');
    if (!leavingSelf && !canManageMember(actor.role, current, null)) fail('permission-denied', 'You cannot remove this member');
    tx.delete(ref);
    tx.delete(db().doc(`users/${data.uid}/memberships/${data.workspaceId}`));
    await audit({ workspaceId: data.workspaceId, actor: userActor(actor.uid, actor.email), action: 'member.removed', entityType: 'member', entityId: data.uid, metadata: { role: current } }, tx);
  });
  await syncWorkspaceClaims(data.uid);
  return { ok: true };
});

export const transferOwnershipFn = callable(z.object({ workspaceId: zId, uid: zId }), async (data, req) => {
  const actor = await requirePermission(req, data.workspaceId, 'workspace.transferOwnership');
  if (actor.uid === data.uid) fail('invalid-argument', 'You already own this workspace');
  await db().runTransaction(async (tx) => {
    const target = await tx.get(db().doc(paths.member(data.workspaceId, data.uid)));
    if (!target.exists) fail('not-found', 'The new owner must already be a member');
    tx.update(db().doc(paths.member(data.workspaceId, data.uid)), { role: 'OWNER' });
    tx.update(db().doc(paths.member(data.workspaceId, actor.uid)), { role: 'ADMIN' });
    tx.set(db().doc(`users/${data.uid}/memberships/${data.workspaceId}`), { role: 'OWNER' }, { merge: true });
    tx.set(db().doc(`users/${actor.uid}/memberships/${data.workspaceId}`), { role: 'ADMIN' }, { merge: true });
    tx.update(db().doc(paths.workspace(data.workspaceId)), { ownerId: data.uid, updatedAt: FieldValue.serverTimestamp() });
    await audit({ workspaceId: data.workspaceId, actor: userActor(actor.uid, actor.email), action: 'workspace.ownership_transferred', entityType: 'workspace', entityId: data.workspaceId, metadata: { to: data.uid } }, tx);
  });
  await syncWorkspaceClaimsFor([data.uid, actor.uid]);
  return { ok: true };
});

export const updateNotificationPrefsFn = callable(notificationPrefsSchema, async (data, req) => {
  const { uid } = requireAuth(req);
  await db().doc(paths.user(uid)).set({ notificationPrefs: data }, { merge: true });
  return { ok: true };
});

export const registerPushTokenFn = callable(registerPushTokenSchema, async (data, req) => {
  const { uid } = requireAuth(req);
  const id = createHash('sha256').update(data.token).digest('hex').slice(0, 40);
  await db().doc(`${paths.userDevices(uid)}/${id}`).set({ token: data.token, platform: data.platform, updatedAt: FieldValue.serverTimestamp() });
  return { ok: true };
});

export const markNotificationsReadFn = callable(z.object({ workspaceId: zId, ids: z.array(zId).max(100) }), async (data, req) => {
  const actor = await requirePermission(req, data.workspaceId, 'workspace.read');
  const batch = db().batch();
  for (const id of data.ids) batch.update(db().doc(`${paths.notifications(data.workspaceId)}/${id}`), { readBy: FieldValue.arrayUnion(actor.uid) });
  await batch.commit();
  return { ok: true };
});
