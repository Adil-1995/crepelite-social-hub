import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { readFileSync } from 'node:fs';
import { doc, setDoc } from 'firebase/firestore';
import { getBytes, ref, uploadBytes, deleteObject } from 'firebase/storage';

/**
 * Storage rules.
 *
 * Media originals are large, so they are uploaded straight to Storage rather
 * than through a Function. That makes these rules the only thing standing
 * between a member and someone else's media, and the only place object size and
 * content type are checked before the object exists.
 *
 * Requires the Storage and Firestore emulators (the rules read membership from
 * Firestore), and therefore a JDK. Run with `npm run test:emulator`.
 */
const PROJECT_ID = 'demo-crepelite';
const WS_A = 'workspace-a';
const WS_B = 'workspace-b';
const MEDIA_ID = 'abcdefgh12345678';

let env: RulesTestEnvironment;

const jpeg = () => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { rules: readFileSync('firestore.rules', 'utf8'), host: '127.0.0.1', port: 8080 },
    storage: { rules: readFileSync('storage.rules', 'utf8'), host: '127.0.0.1', port: 9199 },
  });
});

afterAll(async () => {
  await env?.cleanup();
});

beforeEach(async () => {
  await env.clearFirestore();
  await env.clearStorage();

  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, `workspaces/${WS_A}/members/owner-a`), { uid: 'owner-a', role: 'OWNER' });
    await setDoc(doc(db, `workspaces/${WS_A}/members/editor-a`), { uid: 'editor-a', role: 'EDITOR' });
    await setDoc(doc(db, `workspaces/${WS_A}/members/viewer-a`), { uid: 'viewer-a', role: 'VIEWER' });
    await setDoc(doc(db, `workspaces/${WS_B}/members/owner-b`), { uid: 'owner-b', role: 'OWNER' });

    const storage = ctx.storage();
    await uploadBytes(ref(storage, `workspaces/${WS_A}/media/${MEDIA_ID}/original.jpg`), jpeg(), {
      contentType: 'image/jpeg',
    });
  });
});

const asUser = (uid: string) => env.authenticatedContext(uid).storage();
const asAnonymous = () => env.unauthenticatedContext().storage();

const originalPath = (ws: string, id = MEDIA_ID) => `workspaces/${ws}/media/${id}/original.jpg`;

describe('reading media', () => {
  it('lets any member of the workspace read', async () => {
    for (const uid of ['owner-a', 'editor-a', 'viewer-a']) {
      await assertSucceeds(getBytes(ref(asUser(uid), originalPath(WS_A))));
    }
  });

  it('stops another workspace reading', async () => {
    await assertFails(getBytes(ref(asUser('owner-b'), originalPath(WS_A))));
  });

  it('stops a non-member reading', async () => {
    await assertFails(getBytes(ref(asUser('nobody'), originalPath(WS_A))));
  });

  it('stops an anonymous visitor reading', async () => {
    await assertFails(getBytes(ref(asAnonymous(), originalPath(WS_A))));
  });
});

describe('uploading media', () => {
  const fresh = 'zyxwvuts87654321';

  it('allows owners, admins and editors', async () => {
    for (const uid of ['owner-a', 'editor-a']) {
      await assertSucceeds(
        uploadBytes(ref(asUser(uid), `workspaces/${WS_A}/media/${fresh}-${uid}/original.jpg`), jpeg(), {
          contentType: 'image/jpeg',
        }),
      );
    }
  });

  it('refuses viewers', async () => {
    await assertFails(
      uploadBytes(ref(asUser('viewer-a'), `workspaces/${WS_A}/media/${fresh}/original.jpg`), jpeg(), {
        contentType: 'image/jpeg',
      }),
    );
  });

  it('refuses another workspace', async () => {
    await assertFails(
      uploadBytes(ref(asUser('owner-b'), `workspaces/${WS_A}/media/${fresh}/original.jpg`), jpeg(), {
        contentType: 'image/jpeg',
      }),
    );
  });

  it('refuses a non-image, non-video content type', async () => {
    await assertFails(
      uploadBytes(ref(asUser('owner-a'), `workspaces/${WS_A}/media/${fresh}/original.pdf`), jpeg(), {
        contentType: 'application/pdf',
      }),
    );
  });

  it('refuses a media id that does not match the expected shape', async () => {
    // Short or exotic ids would let a caller collide with, or guess, another
    // workspace member's object path.
    for (const badId of ['short', 'has spaces', '../escape']) {
      await assertFails(
        uploadBytes(ref(asUser('owner-a'), `workspaces/${WS_A}/media/${badId}/original.jpg`), jpeg(), {
          contentType: 'image/jpeg',
        }),
      );
    }
  });

  it('refuses a filename outside the allowed two', async () => {
    await assertFails(
      uploadBytes(ref(asUser('owner-a'), `workspaces/${WS_A}/media/${fresh}/sneaky.jpg`), jpeg(), {
        contentType: 'image/jpeg',
      }),
    );
  });

  it('allows a jpeg poster frame', async () => {
    await assertSucceeds(
      uploadBytes(ref(asUser('owner-a'), `workspaces/${WS_A}/media/${fresh}/thumbnail.jpg`), jpeg(), {
        contentType: 'image/jpeg',
      }),
    );
  });

  it('refuses a poster frame that is not a jpeg', async () => {
    await assertFails(
      uploadBytes(ref(asUser('owner-a'), `workspaces/${WS_A}/media/${fresh}/thumbnail.jpg`), jpeg(), {
        contentType: 'image/png',
      }),
    );
  });
});

describe('immutability', () => {
  it('refuses overwriting an existing original', async () => {
    // Overwriting would let someone swap the bytes behind an already-approved
    // MediaAsset document.
    await assertFails(
      uploadBytes(ref(asUser('owner-a'), originalPath(WS_A)), jpeg(), { contentType: 'image/jpeg' }),
    );
  });

  it('refuses client deletion, even by the owner', async () => {
    await assertFails(deleteObject(ref(asUser('owner-a'), originalPath(WS_A))));
  });
});

describe('paths outside the media tree', () => {
  it('are closed to everyone', async () => {
    await assertFails(
      uploadBytes(ref(asUser('owner-a'), 'somewhere/else/file.jpg'), jpeg(), { contentType: 'image/jpeg' }),
    );
    await assertFails(getBytes(ref(asUser('owner-a'), 'somewhere/else/file.jpg')));
  });
});
