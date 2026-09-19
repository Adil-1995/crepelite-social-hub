import { getApps, initializeApp } from 'firebase-admin/app';
import { FieldValue, Timestamp, getFirestore, type Firestore } from 'firebase-admin/firestore';

if (getApps().length === 0) initializeApp();

let _db: Firestore | null = null;
export function db(): Firestore {
  if (!_db) {
    _db = getFirestore();
    try {
      _db.settings({ ignoreUndefinedProperties: true });
    } catch {
      // settings() can only be called once; ignore when already configured
    }
  }
  return _db;
}

export { FieldValue, Timestamp };

export const now = (): Timestamp => Timestamp.now();
export const tsFromMs = (ms: number): Timestamp => Timestamp.fromMillis(ms);
export const tsFromIso = (iso: string): Timestamp => Timestamp.fromDate(new Date(iso));

/** Canonical Firestore paths. Keep in sync with firestore.rules and docs/DATABASE.md. */
export const paths = {
  user: (uid: string) => `users/${uid}`,
  userDevices: (uid: string) => `users/${uid}/devices`,
  workspace: (w: string) => `workspaces/${w}`,
  members: (w: string) => `workspaces/${w}/members`,
  member: (w: string, uid: string) => `workspaces/${w}/members/${uid}`,
  invitations: (w: string) => `workspaces/${w}/invitations`,
  connections: (w: string) => `workspaces/${w}/socialConnections`,
  connection: (w: string, id: string) => `workspaces/${w}/socialConnections/${id}`,
  channels: (w: string) => `workspaces/${w}/socialChannels`,
  channel: (w: string, id: string) => `workspaces/${w}/socialChannels/${id}`,
  posts: (w: string) => `workspaces/${w}/posts`,
  post: (w: string, id: string) => `workspaces/${w}/posts/${id}`,
  variants: (w: string) => `workspaces/${w}/postVariants`,
  variant: (w: string, id: string) => `workspaces/${w}/postVariants/${id}`,
  deliveries: (w: string) => `workspaces/${w}/deliveries`,
  delivery: (w: string, id: string) => `workspaces/${w}/deliveries/${id}`,
  media: (w: string) => `workspaces/${w}/mediaAssets`,
  mediaAsset: (w: string, id: string) => `workspaces/${w}/mediaAssets/${id}`,
  bulkJobs: (w: string) => `workspaces/${w}/bulkJobs`,
  importJobs: (w: string) => `workspaces/${w}/importJobs`,
  importJob: (w: string, id: string) => `workspaces/${w}/importJobs/${id}`,
  auditLogs: (w: string) => `workspaces/${w}/auditLogs`,
  notifications: (w: string) => `workspaces/${w}/notifications`,
  // Server-only collections (rules deny all client access)
  oauthState: (state: string) => `oauthStates/${state}`,
  tokenVault: (key: string) => `tokenVault/${key}`,
  webhookEvent: (id: string) => `webhookEvents/${id}`,
};

/** Deterministic ids keep variant/delivery creation idempotent: one per (post, channel). */
export const variantIdFor = (postId: string, channelId: string): string => `${postId}_${channelId}`;
export const deliveryIdFor = (postId: string, channelId: string): string => `${postId}_${channelId}`;

export function newId(): string {
  return db().collection('_').doc().id;
}

/** Strips undefined values recursively (Firestore rejects them). */
export function clean<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => clean(v)) as unknown as T;
  if (value && typeof value === 'object' && !(value instanceof Timestamp) && !(value instanceof Date) && Object.getPrototypeOf(value) === Object.prototype) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) if (v !== undefined) out[k] = clean(v);
    return out as T;
  }
  return value;
}
