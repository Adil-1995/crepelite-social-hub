import { createHash, randomBytes } from 'node:crypto';
import { FieldValue, Timestamp, db, paths } from '../utils/firestore';

/**
 * OAuth state records (server-only collection `oauthStates`).
 * - The document id is SHA-256(state): the raw state is never stored.
 * - Single use: consumed (deleted) in a transaction by the callback.
 * - Expire after 10 minutes (also enforced by a Firestore TTL policy on `expiresAt`).
 * - Hold the PKCE verifier and nonce, bound to the user and workspace that started the flow.
 */
export const STATE_TTL_MS = 10 * 60 * 1000;

export interface OAuthStateRecord {
  workspaceId: string;
  uid: string;
  authFamily: string;
  codeVerifier: string | null;
  nonce: string;
  returnTo: string;
  connectionId: string | null;
  redirectUri: string;
  expiresAt: Timestamp;
}

export const b64url = (buf: Buffer): string => buf.toString('base64url');
export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(48)); // 64 chars, within RFC 7636's 43–128
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

export async function createOAuthState(input: Omit<OAuthStateRecord, 'expiresAt' | 'codeVerifier' | 'nonce'> & { usePkce: boolean }): Promise<{ state: string; nonce: string; codeChallenge: string | null }> {
  const state = b64url(randomBytes(32));
  const nonce = b64url(randomBytes(16));
  const pkce = input.usePkce ? pkcePair() : null;
  const record: OAuthStateRecord = {
    workspaceId: input.workspaceId,
    uid: input.uid,
    authFamily: input.authFamily,
    returnTo: input.returnTo,
    connectionId: input.connectionId,
    redirectUri: input.redirectUri,
    codeVerifier: pkce?.verifier ?? null,
    nonce,
    expiresAt: Timestamp.fromMillis(Date.now() + STATE_TTL_MS),
  };
  await db().doc(paths.oauthState(sha256(state))).set({ ...record, createdAt: FieldValue.serverTimestamp() });
  return { state, nonce, codeChallenge: pkce?.challenge ?? null };
}

export type ConsumeResult = { ok: true; record: OAuthStateRecord } | { ok: false; reason: 'unknown_state' | 'expired_state' };

/** Atomically reads and deletes the state (replay protection). */
export async function consumeOAuthState(state: string, nowMs = Date.now()): Promise<ConsumeResult> {
  if (!state || state.length > 200) return { ok: false, reason: 'unknown_state' };
  const ref = db().doc(paths.oauthState(sha256(state)));
  return db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return { ok: false, reason: 'unknown_state' } as const;
    tx.delete(ref);
    const record = snap.data() as OAuthStateRecord;
    if (record.expiresAt.toMillis() < nowMs) return { ok: false, reason: 'expired_state' } as const;
    return { ok: true, record } as const;
  });
}
