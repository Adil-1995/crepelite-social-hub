import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { readFileSync } from 'node:fs';
import { doc, getDoc, setDoc, collection, getDocs } from 'firebase/firestore';

/**
 * Firestore rules.
 *
 * The model is deliberately read-only for clients: every write goes through a
 * callable that re-validates the payload and the caller's role. So these tests
 * assert two things — that workspace isolation holds for reads, and that no
 * client can write anything at all, whatever their role. Role-specific write
 * behaviour is exercised against the callables in tests/integration.
 *
 * Requires the Firestore emulator (and therefore a JDK). Run with
 * `npm run test:emulator`.
 */
const PROJECT_ID = 'demo-crepelite';
const WS_A = 'workspace-a';
const WS_B = 'workspace-b';

let env: RulesTestEnvironment;

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      rules: readFileSync('firestore.rules', 'utf8'),
      host: '127.0.0.1',
      port: 8080,
    },
  });
});

afterAll(async () => {
  await env?.cleanup();
});

beforeEach(async () => {
  await env.clearFirestore();

  // Seed as admin: members of A, members of B, and one document per collection.
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, `workspaces/${WS_A}`), { name: 'A', timezone: 'Africa/Casablanca' });
    await setDoc(doc(db, `workspaces/${WS_B}`), { name: 'B', timezone: 'Africa/Casablanca' });

    await setDoc(doc(db, `workspaces/${WS_A}/members/owner-a`), { uid: 'owner-a', role: 'OWNER', email: 'o@a.test' });
    await setDoc(doc(db, `workspaces/${WS_A}/members/admin-a`), { uid: 'admin-a', role: 'ADMIN', email: 'a@a.test' });
    await setDoc(doc(db, `workspaces/${WS_A}/members/editor-a`), { uid: 'editor-a', role: 'EDITOR', email: 'e@a.test' });
    await setDoc(doc(db, `workspaces/${WS_A}/members/viewer-a`), { uid: 'viewer-a', role: 'VIEWER', email: 'v@a.test' });
    await setDoc(doc(db, `workspaces/${WS_B}/members/owner-b`), { uid: 'owner-b', role: 'OWNER', email: 'o@b.test' });

    for (const ws of [WS_A, WS_B]) {
      await setDoc(doc(db, `workspaces/${ws}/posts/post-1`), { titleInternal: 'secret', status: 'draft' });
      await setDoc(doc(db, `workspaces/${ws}/postVariants/var-1`), { postId: 'post-1' });
      await setDoc(doc(db, `workspaces/${ws}/deliveries/del-1`), { postId: 'post-1', status: 'queued' });
      await setDoc(doc(db, `workspaces/${ws}/mediaAssets/media-1`), { fileName: 'x.jpg' });
      await setDoc(doc(db, `workspaces/${ws}/socialConnections/conn-1`), { provider: 'mock' });
      await setDoc(doc(db, `workspaces/${ws}/socialChannels/chan-1`), { provider: 'mock' });
      await setDoc(doc(db, `workspaces/${ws}/auditLogs/log-1`), { action: 'post.created' });
      await setDoc(doc(db, `workspaces/${ws}/notifications/note-1`), { kind: 'failed' });
      await setDoc(doc(db, `workspaces/${ws}/bulkJobs/job-1`), { status: 'completed' });
      await setDoc(doc(db, `workspaces/${ws}/importJobs/imp-1`), { status: 'ready' });
      await setDoc(doc(db, `workspaces/${ws}/invitations/someone@test.dev`), { email: 'someone@test.dev', role: 'EDITOR' });
    }

    await setDoc(doc(db, 'users/owner-a'), { uid: 'owner-a', email: 'o@a.test' });
    await setDoc(doc(db, 'tokenVault/conn-1'), { accessToken: 'super-secret' });
    await setDoc(doc(db, 'oauthStates/state-1'), { state: 'xyz' });
    await setDoc(doc(db, 'webhookEvents/evt-1'), { provider: 'tiktok' });
    await setDoc(doc(db, 'importMedia/im-1'), { url: 'https://example.test/x.jpg' });
  });
});

const asOwnerA = () => env.authenticatedContext('owner-a').firestore();
const asEditorA = () => env.authenticatedContext('editor-a').firestore();
const asViewerA = () => env.authenticatedContext('viewer-a').firestore();
const asOwnerB = () => env.authenticatedContext('owner-b').firestore();
const asStranger = () => env.authenticatedContext('nobody').firestore();
const asAnonymous = () => env.unauthenticatedContext().firestore();

const WORKSPACE_COLLECTIONS = [
  'posts/post-1',
  'postVariants/var-1',
  'deliveries/del-1',
  'mediaAssets/media-1',
  'socialConnections/conn-1',
  'socialChannels/chan-1',
  'auditLogs/log-1',
  'notifications/note-1',
  'bulkJobs/job-1',
  'importJobs/imp-1',
];

describe('unauthenticated access', () => {
  it('cannot read a workspace', async () => {
    await assertFails(getDoc(doc(asAnonymous(), `workspaces/${WS_A}`)));
  });

  it.each(WORKSPACE_COLLECTIONS)('cannot read %s', async (path) => {
    await assertFails(getDoc(doc(asAnonymous(), `workspaces/${WS_A}/${path}`)));
  });

  it('cannot write anything', async () => {
    await assertFails(setDoc(doc(asAnonymous(), `workspaces/${WS_A}/posts/injected`), { titleInternal: 'x' }));
  });
});

describe('workspace isolation', () => {
  it('lets a member read their own workspace', async () => {
    await assertSucceeds(getDoc(doc(asOwnerA(), `workspaces/${WS_A}`)));
  });

  it('stops workspace B reading workspace A', async () => {
    await assertFails(getDoc(doc(asOwnerB(), `workspaces/${WS_A}`)));
  });

  it.each(WORKSPACE_COLLECTIONS)('stops workspace B reading A/%s', async (path) => {
    await assertFails(getDoc(doc(asOwnerB(), `workspaces/${WS_A}/${path}`)));
  });

  it.each(WORKSPACE_COLLECTIONS)('stops a non-member reading A/%s', async (path) => {
    await assertFails(getDoc(doc(asStranger(), `workspaces/${WS_A}/${path}`)));
  });

  it('stops a non-member listing a collection', async () => {
    await assertFails(getDocs(collection(asStranger(), `workspaces/${WS_A}/posts`)));
  });

  it.each(WORKSPACE_COLLECTIONS)('lets a member read their own A/%s', async (path) => {
    await assertSucceeds(getDoc(doc(asViewerA(), `workspaces/${WS_A}/${path}`)));
  });
});

describe('invitations', () => {
  it('are readable by owners and admins', async () => {
    await assertSucceeds(getDoc(doc(asOwnerA(), `workspaces/${WS_A}/invitations/someone@test.dev`)));
  });

  it('are hidden from editors and viewers', async () => {
    // Pending invitations carry other people's email addresses.
    await assertFails(getDoc(doc(asEditorA(), `workspaces/${WS_A}/invitations/someone@test.dev`)));
    await assertFails(getDoc(doc(asViewerA(), `workspaces/${WS_A}/invitations/someone@test.dev`)));
  });
});

describe('client writes are refused for every role', () => {
  const writers: Array<[string, () => ReturnType<typeof asOwnerA>]> = [
    ['owner', asOwnerA],
    ['editor', asEditorA],
    ['viewer', asViewerA],
  ];

  it.each(writers)('%s cannot create a post directly', async (_role, db) => {
    await assertFails(setDoc(doc(db(), `workspaces/${WS_A}/posts/injected`), { titleInternal: 'x', status: 'draft' }));
  });

  it.each(writers)('%s cannot edit a post directly', async (_role, db) => {
    await assertFails(setDoc(doc(db(), `workspaces/${WS_A}/posts/post-1`), { status: 'published' }, { merge: true }));
  });

  it.each(writers)('%s cannot touch delivery server fields', async (_role, db) => {
    // externalPostId, taskName and status are what make publishing idempotent.
    await assertFails(
      setDoc(
        doc(db(), `workspaces/${WS_A}/deliveries/del-1`),
        { status: 'published', externalPostId: 'forged', taskName: 'forged' },
        { merge: true },
      ),
    );
  });

  it.each(writers)('%s cannot change a member role', async (_role, db) => {
    await assertFails(setDoc(doc(db(), `workspaces/${WS_A}/members/viewer-a`), { role: 'OWNER' }, { merge: true }));
  });

  it.each(writers)('%s cannot add themselves to workspace B', async (_role, db) => {
    // The one escalation that would break isolation entirely.
    await assertFails(setDoc(doc(db(), `workspaces/${WS_B}/members/owner-a`), { role: 'OWNER' }));
  });

  it.each(writers)('%s cannot write an audit log entry', async (_role, db) => {
    await assertFails(setDoc(doc(db(), `workspaces/${WS_A}/auditLogs/forged`), { action: 'nothing.happened' }));
  });

  it.each(writers)('%s cannot forge a connection', async (_role, db) => {
    await assertFails(setDoc(doc(db(), `workspaces/${WS_A}/socialConnections/forged`), { provider: 'instagram' }));
  });

  it.each(writers)('%s cannot mark a notification read directly', async (_role, db) => {
    await assertFails(
      setDoc(doc(db(), `workspaces/${WS_A}/notifications/note-1`), { readBy: ['owner-a'] }, { merge: true }),
    );
  });
});

describe('server-only collections', () => {
  const secret = ['tokenVault/conn-1', 'oauthStates/state-1', 'webhookEvents/evt-1', 'importMedia/im-1'];

  it.each(secret)('%s is unreadable even by an owner', async (path) => {
    await assertFails(getDoc(doc(asOwnerA(), path)));
  });

  it.each(secret)('%s is unwritable even by an owner', async (path) => {
    await assertFails(setDoc(doc(asOwnerA(), path), { tampered: true }));
  });

  it('never exposes a provider access token to a client', async () => {
    await assertFails(getDoc(doc(asOwnerA(), 'tokenVault/conn-1')));
    await assertFails(getDoc(doc(asStranger(), 'tokenVault/conn-1')));
    await assertFails(getDoc(doc(asAnonymous(), 'tokenVault/conn-1')));
  });
});

describe('user documents', () => {
  it('are readable only by their owner', async () => {
    await assertSucceeds(getDoc(doc(asOwnerA(), 'users/owner-a')));
    await assertFails(getDoc(doc(asEditorA(), 'users/owner-a')));
    await assertFails(getDoc(doc(asAnonymous(), 'users/owner-a')));
  });

  it('cannot be written by the client', async () => {
    await assertFails(setDoc(doc(asOwnerA(), 'users/owner-a'), { admin: true }, { merge: true }));
  });

  it('never exposes device push tokens', async () => {
    await assertFails(getDoc(doc(asOwnerA(), 'users/owner-a/devices/device-1')));
  });
});

describe('unknown paths', () => {
  it('are denied by the catch-all', async () => {
    await assertFails(getDoc(doc(asOwnerA(), 'somethingElse/doc-1')));
    await assertFails(setDoc(doc(asOwnerA(), 'somethingElse/doc-1'), { x: 1 }));
  });
});
