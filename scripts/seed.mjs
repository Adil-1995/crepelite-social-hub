#!/usr/bin/env node
/**
 * Seeds demo data into the Firebase emulators.
 *
 * Emulator only, by design: the script refuses to run unless
 * FIRESTORE_EMULATOR_HOST is set and the project id looks like a demo project,
 * so it can never touch a real database.
 *
 * Creates a workspace with a mock connection, media, and posts in every
 * interesting state — draft, scheduled, published, and one partially published
 * with a failed destination — so every screen has something real to render
 * without any provider credentials.
 *
 * Usage:  npm run emulators   (in one terminal)
 *         npm run seed        (in another)
 */
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';

const PROJECT_ID = process.env.GCLOUD_PROJECT || process.env.FIREBASE_PROJECT || 'demo-crepelite';
const WORKSPACE_ID = 'demo-workspace';
const TZ = 'Africa/Casablanca';

// ── Safety ──────────────────────────────────────────────────────────────────

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
}
if (!process.env.FIREBASE_AUTH_EMULATOR_HOST) {
  process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';
}

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST;
const looksLocal = /^(127\.0\.0\.1|localhost|\[::1\]):/.test(emulatorHost);

if (!looksLocal) {
  console.error(`Refusing to seed: FIRESTORE_EMULATOR_HOST is "${emulatorHost}", which is not local.`);
  process.exit(1);
}
if (!PROJECT_ID.startsWith('demo-')) {
  console.error(
    `Refusing to seed: project id "${PROJECT_ID}" does not start with "demo-".\n` +
      'Seeding is for the emulator only — never run it against a real project.',
  );
  process.exit(1);
}

initializeApp({ projectId: PROJECT_ID });
const db = getFirestore();
const auth = getAuth();

// ── Helpers ─────────────────────────────────────────────────────────────────

const now = Date.now();
const DAY = 24 * 60 * 60 * 1000;
const at = (offsetMs) => Timestamp.fromMillis(now + offsetMs);
const id = (prefix, n) => `${prefix}-${String(n).padStart(3, '0')}`;

const USERS = [
  { uid: 'demo-owner', email: 'owner@crepelite.test', displayName: 'Demo Owner', role: 'OWNER' },
  { uid: 'demo-editor', email: 'editor@crepelite.test', displayName: 'Demo Editor', role: 'EDITOR' },
  { uid: 'demo-viewer', email: 'viewer@crepelite.test', displayName: 'Demo Viewer', role: 'VIEWER' },
];

const CHANNELS = [
  { id: 'chan-mock-a', name: 'CrepeLite (Mock A)', handle: '@crepelite', kind: 'mock' },
  { id: 'chan-mock-b', name: 'CrepeLite (Mock B)', handle: '@crepelite_b', kind: 'mock' },
];

async function seedAuth() {
  for (const u of USERS) {
    await auth
      .createUser({ uid: u.uid, email: u.email, displayName: u.displayName, password: 'crepelite' })
      .catch((e) => {
        if (e.code !== 'auth/uid-already-exists') throw e;
      });
  }
}

async function seedWorkspace() {
  const batch = db.batch();

  batch.set(db.doc(`workspaces/${WORKSPACE_ID}`), {
    id: WORKSPACE_ID,
    name: 'CrepeLite',
    slug: 'crepelite',
    timezone: TZ,
    ownerId: USERS[0].uid,
    createdAt: at(-30 * DAY),
    updatedAt: at(0),
  });

  for (const u of USERS) {
    batch.set(db.doc(`workspaces/${WORKSPACE_ID}/members/${u.uid}`), {
      uid: u.uid,
      role: u.role,
      email: u.email,
      displayName: u.displayName,
      photoURL: null,
      addedAt: at(-30 * DAY),
      addedBy: USERS[0].uid,
    });

    batch.set(db.doc(`users/${u.uid}`), {
      uid: u.uid,
      email: u.email,
      displayName: u.displayName,
      defaultWorkspaceId: WORKSPACE_ID,
      notificationPrefs: { pushEnabled: false, onPublished: false, onPartial: true, onFailed: true, onReauth: true },
      createdAt: at(-30 * DAY),
    });
  }

  batch.set(db.doc(`workspaces/${WORKSPACE_ID}/invitations/pending@crepelite.test`), {
    id: 'pending@crepelite.test',
    email: 'pending@crepelite.test',
    role: 'EDITOR',
    invitedBy: USERS[0].uid,
    createdAt: at(-2 * DAY),
    expiresAt: at(5 * DAY),
  });

  batch.set(db.doc(`workspaces/${WORKSPACE_ID}/socialConnections/conn-mock`), {
    id: 'conn-mock',
    workspaceId: WORKSPACE_ID,
    provider: 'mock',
    authFamily: 'mock',
    accountName: 'Mock Account',
    externalAccountId: 'mock-account-1',
    status: 'connected',
    scopes: ['mock.publish', 'mock.read'],
    expiresAt: at(90 * DAY),
    lastHealthCheckAt: at(-2 * 60 * 60 * 1000),
    lastError: null,
    createdBy: USERS[0].uid,
    createdAt: at(-20 * DAY),
    updatedAt: at(0),
  });

  for (const c of CHANNELS) {
    batch.set(db.doc(`workspaces/${WORKSPACE_ID}/socialChannels/${c.id}`), {
      id: c.id,
      workspaceId: WORKSPACE_ID,
      provider: 'mock',
      connectionId: 'conn-mock',
      externalId: `ext-${c.id}`,
      name: c.name,
      handle: c.handle,
      avatarUrl: null,
      kind: c.kind,
      status: 'connected',
      enabled: true,
      metadata: {},
      createdAt: at(-20 * DAY),
      updatedAt: at(0),
    });
  }

  await batch.commit();
}

async function seedMedia() {
  const batch = db.batch();
  for (let i = 1; i <= 8; i++) {
    const mediaId = id('media', i);
    const isVideo = i % 4 === 0;
    batch.set(db.doc(`workspaces/${WORKSPACE_ID}/mediaAssets/${mediaId}`), {
      id: mediaId,
      workspaceId: WORKSPACE_ID,
      kind: isVideo ? 'video' : 'image',
      // Seeded metadata only: no bytes are written to the Storage emulator, so
      // previews fall back to the placeholder tile.
      storagePath: `workspaces/${WORKSPACE_ID}/media/${mediaId}/original.${isVideo ? 'mp4' : 'jpg'}`,
      thumbnailPath: null,
      fileName: isVideo ? `crepe-clip-${i}.mp4` : `crepe-photo-${i}.jpg`,
      mimeType: isVideo ? 'video/mp4' : 'image/jpeg',
      size: isVideo ? 12_000_000 : 850_000,
      width: 1080,
      height: isVideo ? 1920 : 1080,
      durationSec: isVideo ? 24 : null,
      checksum: null,
      tags: i % 2 === 0 ? ['product'] : ['behind-the-scenes'],
      usedBy: [],
      status: 'ready',
      source: 'upload',
      createdBy: USERS[0].uid,
      createdAt: at(-(10 - i) * DAY),
      lastUsedAt: null,
    });
  }
  await batch.commit();
}

/** One post plus its variants and deliveries, in a chosen end state. */
function buildPost(batch, { postId, title, text, status, whenMs, deliveryStates }) {
  const deliverySummary = {};
  const channelIds = [];

  deliveryStates.forEach((state, i) => {
    const channel = CHANNELS[i % CHANNELS.length];
    const deliveryId = `${postId}-del-${i + 1}`;
    const variantId = `${postId}-var-${i + 1}`;
    channelIds.push(channel.id);

    const failed = state === 'failed';
    const published = state === 'published';

    batch.set(db.doc(`workspaces/${WORKSPACE_ID}/postVariants/${variantId}`), {
      id: variantId,
      workspaceId: WORKSPACE_ID,
      postId,
      provider: 'mock',
      channelId: channel.id,
      syncMode: i === 0 ? 'master' : 'custom',
      format: 'feed',
      content: {
        text: i === 0 ? text : `${text} (tailored for ${channel.name})`,
        title,
        description: '',
        hashtags: ['crepes'],
        link: '',
      },
      mediaIds: null,
      providerSettings: {},
      scheduledAtOverride: null,
      offsetMinutes: i * 15,
      createdAt: at(-3 * DAY),
      updatedAt: at(-3 * DAY),
    });

    batch.set(db.doc(`workspaces/${WORKSPACE_ID}/deliveries/${deliveryId}`), {
      id: deliveryId,
      workspaceId: WORKSPACE_ID,
      postId,
      variantId,
      provider: 'mock',
      channelId: channel.id,
      connectionId: 'conn-mock',
      status: state,
      scheduledAt: Timestamp.fromMillis(whenMs + i * 15 * 60_000),
      scheduleVersion: 1,
      taskName: state === 'queued' ? `projects/${PROJECT_ID}/locations/europe-west1/queues/deliveries/tasks/${deliveryId}-v1-a0` : null,
      executor: 'functions',
      externalPostId: published ? `mock-post-${deliveryId}` : null,
      externalPostUrl: published ? `https://mock.test/p/${deliveryId}` : null,
      attemptCount: failed ? 2 : published ? 1 : 0,
      autoRetryCount: failed ? 1 : 0,
      lastAttemptAt: published || failed ? Timestamp.fromMillis(whenMs) : null,
      publishedAt: published ? Timestamp.fromMillis(whenMs) : null,
      publishingLease: null,
      error: failed
        ? {
            code: 'mock_rate_limited',
            message: 'The mock provider reported a rate limit. Retry in a few minutes.',
            category: 'RATE_LIMIT',
            retryable: true,
            httpStatus: 429,
            at: Timestamp.fromMillis(whenMs),
          }
        : null,
      processingMetadata: {},
      nextStatusCheckAt: null,
      statusCheckCount: 0,
      createdAt: at(-3 * DAY),
      updatedAt: at(0),
    });

    deliverySummary[channel.id] = {
      deliveryId,
      provider: 'mock',
      status: state,
      scheduledAt: Timestamp.fromMillis(whenMs + i * 15 * 60_000),
      externalPostUrl: published ? `https://mock.test/p/${deliveryId}` : null,
      errorMessage: failed ? 'The mock provider reported a rate limit.' : null,
    };
  });

  batch.set(db.doc(`workspaces/${WORKSPACE_ID}/posts/${postId}`), {
    id: postId,
    workspaceId: WORKSPACE_ID,
    titleInternal: title,
    masterContent: { text, title, description: '', hashtags: ['crepes', 'casablanca'], link: '' },
    mediaIds: [id('media', 1), id('media', 2)],
    status,
    schedule: { scheduledAt: Timestamp.fromMillis(whenMs), timezone: TZ },
    channelIds,
    internalNotes: '',
    source: { kind: 'manual' },
    deliverySummary,
    calendarAt: Timestamp.fromMillis(whenMs),
    searchKeywords: title.toLowerCase().split(/\s+/),
    createdBy: USERS[0].uid,
    updatedBy: USERS[0].uid,
    createdAt: at(-3 * DAY),
    updatedAt: at(0),
    revision: 1,
  });
}

async function seedPosts() {
  const batch = db.batch();

  buildPost(batch, {
    postId: 'post-draft',
    title: 'New seasonal menu',
    text: 'Something sweet is coming to the CrepeLite menu this week.',
    status: 'draft',
    whenMs: now + 5 * DAY,
    deliveryStates: ['draft', 'draft'],
  });

  buildPost(batch, {
    postId: 'post-scheduled',
    title: 'Weekend special',
    text: 'Salted caramel, all weekend long. Come and find us.',
    status: 'scheduled',
    whenMs: now + 2 * DAY,
    deliveryStates: ['queued', 'queued'],
  });

  buildPost(batch, {
    postId: 'post-far-future',
    title: 'Winter campaign teaser',
    text: 'Planning ahead for the winter menu.',
    status: 'scheduled',
    whenMs: now + 60 * DAY,
    deliveryStates: ['awaiting_queue', 'awaiting_queue'],
  });

  buildPost(batch, {
    postId: 'post-published',
    title: 'Opening hours',
    text: 'We are open every day from 9am. See you soon.',
    status: 'published',
    whenMs: now - 2 * DAY,
    deliveryStates: ['published', 'published'],
  });

  buildPost(batch, {
    postId: 'post-partial',
    title: 'Crepe of the month',
    text: 'This month it is pistachio. Limited run.',
    status: 'partially_published',
    whenMs: now - 6 * 60 * 60 * 1000,
    deliveryStates: ['published', 'failed'],
  });

  await batch.commit();
}

async function seedNotificationsAndLogs() {
  const batch = db.batch();

  batch.set(db.doc(`workspaces/${WORKSPACE_ID}/notifications/note-failed`), {
    id: 'note-failed',
    workspaceId: WORKSPACE_ID,
    kind: 'partial',
    title: 'Crepe of the month published partially',
    body: 'CrepeLite (Mock B) could not publish: rate limited.',
    postId: 'post-partial',
    deliveryId: 'post-partial-del-2',
    connectionId: null,
    readBy: [],
    createdAt: at(-6 * 60 * 60 * 1000),
  });

  const actions = [
    ['post.created', 'post', 'post-published'],
    ['post.scheduled', 'post', 'post-scheduled'],
    ['post.published', 'post', 'post-published'],
    ['delivery.failed', 'delivery', 'post-partial-del-2'],
    ['connection.created', 'connection', 'conn-mock'],
    ['member.invited', 'member', 'pending@crepelite.test'],
  ];

  actions.forEach(([action, entityType, entityId], i) => {
    const logId = id('log', i + 1);
    batch.set(db.doc(`workspaces/${WORKSPACE_ID}/auditLogs/${logId}`), {
      id: logId,
      workspaceId: WORKSPACE_ID,
      actor: { uid: USERS[0].uid, type: 'user', email: USERS[0].email },
      action,
      entityType,
      entityId,
      metadata: {},
      timestamp: at(-(actions.length - i) * 60 * 60 * 1000),
    });
  });

  await batch.commit();
}

// ── Run ─────────────────────────────────────────────────────────────────────

async function main() {
  console.warn(`Seeding project "${PROJECT_ID}" at ${emulatorHost}…`);
  await seedAuth();
  await seedWorkspace();
  await seedMedia();
  await seedPosts();
  await seedNotificationsAndLogs();

  console.warn('');
  console.warn('Done. Sign in at http://localhost:5173 with:');
  for (const u of USERS) console.warn(`  ${u.email}  /  crepelite   (${u.role})`);
  console.warn('');
  console.warn('Seeded: 1 workspace, 3 members, 1 pending invitation, 1 mock connection,');
  console.warn('        2 destinations, 8 media assets, 5 posts (draft, scheduled,');
  console.warn('        awaiting-queue, published, partially published), 1 notification,');
  console.warn('        6 audit entries.');
}

main().catch((e) => {
  console.error('Seeding failed:', e);
  process.exit(1);
});
