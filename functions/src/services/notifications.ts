import { getMessaging } from 'firebase-admin/messaging';
import { DEFAULT_NOTIFICATION_PREFS, type NotificationKind, type NotificationPrefs } from '@shared/index';
import { FieldValue, db, paths } from '../utils/firestore';
import { log } from '../utils/logger';
import { config } from '../config/env';

const PREF_FOR_KIND: Record<NotificationKind, keyof NotificationPrefs> = {
  published: 'onPublished',
  partial: 'onPartial',
  failed: 'onFailed',
  reauth: 'onReauth',
};

export interface NotifyInput {
  workspaceId: string;
  kind: NotificationKind;
  title: string;
  body: string;
  postId?: string | null;
  deliveryId?: string | null;
  connectionId?: string | null;
  /** Dedupe key: at most one notification per key (e.g. post + final status). */
  dedupeKey: string;
}

/**
 * In-app notification (always) + optional web push (FCM) honouring each
 * member's preferences. Push failures never affect publishing.
 */
export async function notify(input: NotifyInput): Promise<void> {
  const id = input.dedupeKey.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 200);
  const ref = db().collection(paths.notifications(input.workspaceId)).doc(id);
  try {
    await ref.create({
      workspaceId: input.workspaceId,
      kind: input.kind,
      title: input.title,
      body: input.body,
      postId: input.postId ?? null,
      deliveryId: input.deliveryId ?? null,
      connectionId: input.connectionId ?? null,
      readBy: [],
      createdAt: FieldValue.serverTimestamp(),
    });
  } catch (e) {
    if ((e as { code?: number }).code === 6) return; // ALREADY_EXISTS → already notified
    throw e;
  }
  await sendPush(input).catch((e) => log.warn('Push delivery failed', { error: String(e) }));
}

async function sendPush(input: NotifyInput): Promise<void> {
  const members = await db().collection(paths.members(input.workspaceId)).get();
  const tokens: string[] = [];
  for (const m of members.docs) {
    const user = await db().doc(paths.user(m.id)).get();
    const prefs = { ...DEFAULT_NOTIFICATION_PREFS, ...((user.data()?.notificationPrefs as Partial<NotificationPrefs>) ?? {}) };
    if (!prefs.pushEnabled || !prefs[PREF_FOR_KIND[input.kind]]) continue;
    const devices = await db().collection(paths.userDevices(m.id)).get();
    devices.docs.forEach((d) => tokens.push(d.data().token as string));
  }
  if (tokens.length === 0) return;
  const link = input.postId ? `${config.appBaseUrl()}/posts/${input.postId}` : `${config.appBaseUrl()}/connections`;
  const res = await getMessaging().sendEachForMulticast({
    tokens: tokens.slice(0, 500),
    notification: { title: input.title, body: input.body },
    webpush: { fcmOptions: { link }, notification: { icon: '/icons/icon-192.png', badge: '/icons/badge-72.png' } },
    data: { kind: input.kind, postId: input.postId ?? '', workspaceId: input.workspaceId },
  });
  // Remove tokens FCM reports as invalid
  const stale = res.responses
    .map((r, i) => (!r.success && /registration-token-not-registered|invalid-registration-token/.test(r.error?.code ?? '') ? tokens[i] : null))
    .filter((t): t is string => !!t);
  if (stale.length) {
    const q = await db().collectionGroup('devices').where('token', 'in', stale.slice(0, 30)).get();
    await Promise.all(q.docs.map((d) => d.ref.delete()));
  }
}
