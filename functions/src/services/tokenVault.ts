import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { KeyManagementServiceClient } from '@google-cloud/kms';
import { TOKEN_ENCRYPTION_KEY, config, isEmulator, isProduction, secretValue } from '../config/env';
import { FieldPath } from 'firebase-admin/firestore';
import { FieldValue, db, paths } from '../utils/firestore';
import { log } from '../utils/logger';

/**
 * Server-side token storage.
 *
 * Tokens are envelope-encrypted: a random 256-bit data key encrypts the
 * payload with AES-256-GCM; the data key is wrapped by Cloud KMS
 * (KMS_KEY_NAME) or — when KMS is not configured (emulator/dev) — by a key
 * from Secret Manager (TOKEN_ENCRYPTION_KEY). Documents live in the top-level
 * `tokenVault` collection, which Firestore rules deny to every client.
 * The PWA only ever sees connection metadata (status, account name, expiry).
 */
export interface TokenSet {
  accessToken: string;
  refreshToken?: string | null;
  /** epoch ms */
  expiresAt?: number | null;
  refreshExpiresAt?: number | null;
  tokenType?: string | null;
  scope?: string | null;
  /** Provider-specific secret values (e.g. Facebook page access token). */
  extra?: Record<string, string>;
}

interface EncryptedRecord {
  v: 1;
  alg: 'AES-256-GCM';
  keyProvider: 'kms' | 'local';
  kmsKeyName: string | null;
  wrappedKey: string; // base64
  iv: string;
  tag: string;
  ciphertext: string;
}

export interface KeyWrapper {
  readonly provider: 'kms' | 'local';
  readonly keyName: string | null;
  wrap(dek: Buffer): Promise<Buffer>;
  unwrap(wrapped: Buffer): Promise<Buffer>;
}

class KmsKeyWrapper implements KeyWrapper {
  readonly provider = 'kms' as const;
  private client = new KeyManagementServiceClient();
  constructor(readonly keyName: string) {}
  async wrap(dek: Buffer): Promise<Buffer> {
    const [res] = await this.client.encrypt({ name: this.keyName, plaintext: dek });
    return Buffer.from(res.ciphertext as Uint8Array);
  }
  async unwrap(wrapped: Buffer): Promise<Buffer> {
    const [res] = await this.client.decrypt({ name: this.keyName, ciphertext: wrapped });
    return Buffer.from(res.plaintext as Uint8Array);
  }
}

export class LocalKeyWrapper implements KeyWrapper {
  readonly provider = 'local' as const;
  readonly keyName = null;
  private readonly kek: Buffer;
  constructor(secret: string) {
    // Accept a base64 32-byte key; otherwise derive one (development convenience only).
    const raw = Buffer.from(secret, 'base64');
    this.kek = raw.length === 32 ? raw : createHash('sha256').update(secret).digest();
  }
  async wrap(dek: Buffer): Promise<Buffer> {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.kek, iv);
    const ct = Buffer.concat([c.update(dek), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), ct]);
  }
  async unwrap(wrapped: Buffer): Promise<Buffer> {
    const iv = wrapped.subarray(0, 12);
    const tag = wrapped.subarray(12, 28);
    const d = createDecipheriv('aes-256-gcm', this.kek, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(wrapped.subarray(28)), d.final()]);
  }
}

let defaultWrapper: KeyWrapper | null = null;
export function getKeyWrapper(): KeyWrapper {
  if (defaultWrapper) return defaultWrapper;
  const kms = config.kmsKeyName();
  if (kms) {
    defaultWrapper = new KmsKeyWrapper(kms);
  } else {
    const secret = secretValue(TOKEN_ENCRYPTION_KEY);
    if (!secret) {
      if (isProduction() && !isEmulator()) throw new Error('Token encryption is not configured: set KMS_KEY_NAME (recommended) or TOKEN_ENCRYPTION_KEY');
      log.warn('TokenVault: using the development key. Never use this outside the emulator.');
      defaultWrapper = new LocalKeyWrapper('crepelite-dev-only-key');
    } else {
      if (isProduction()) log.warn('TokenVault: KMS_KEY_NAME not set; using TOKEN_ENCRYPTION_KEY from Secret Manager');
      defaultWrapper = new LocalKeyWrapper(secret);
    }
  }
  return defaultWrapper;
}

/** Test hook. */
export function setKeyWrapper(w: KeyWrapper | null): void {
  defaultWrapper = w;
}

export async function encryptTokens(tokens: TokenSet, wrapper: KeyWrapper = getKeyWrapper()): Promise<EncryptedRecord> {
  const dek = randomBytes(32);
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', dek, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(tokens), 'utf8'), c.final()]);
  const wrapped = await wrapper.wrap(dek);
  return {
    v: 1,
    alg: 'AES-256-GCM',
    keyProvider: wrapper.provider,
    kmsKeyName: wrapper.keyName,
    wrappedKey: wrapped.toString('base64'),
    iv: iv.toString('base64'),
    tag: c.getAuthTag().toString('base64'),
    ciphertext: ct.toString('base64'),
  };
}

export async function decryptTokens(rec: EncryptedRecord, wrapper: KeyWrapper = getKeyWrapper()): Promise<TokenSet> {
  const dek = await wrapper.unwrap(Buffer.from(rec.wrappedKey, 'base64'));
  const d = createDecipheriv('aes-256-gcm', dek, Buffer.from(rec.iv, 'base64'));
  d.setAuthTag(Buffer.from(rec.tag, 'base64'));
  const pt = Buffer.concat([d.update(Buffer.from(rec.ciphertext, 'base64')), d.final()]);
  return JSON.parse(pt.toString('utf8')) as TokenSet;
}

export const vaultKeys = {
  connection: (workspaceId: string, connectionId: string) => `${workspaceId}__conn__${connectionId}`,
  channel: (workspaceId: string, channelId: string) => `${workspaceId}__chan__${channelId}`,
};

export const TokenVaultService = {
  async put(key: string, tokens: TokenSet, meta: { workspaceId: string; provider: string }): Promise<void> {
    const record = await encryptTokens(tokens);
    await db().doc(paths.tokenVault(key)).set({ ...record, workspaceId: meta.workspaceId, provider: meta.provider, updatedAt: FieldValue.serverTimestamp() });
  },
  async get(key: string): Promise<TokenSet | null> {
    const snap = await db().doc(paths.tokenVault(key)).get();
    if (!snap.exists) return null;
    return decryptTokens(snap.data() as EncryptedRecord);
  },
  async delete(key: string): Promise<void> {
    await db().doc(paths.tokenVault(key)).delete();
  },
  async deleteForWorkspacePrefix(prefix: string): Promise<void> {
    const snaps = await db().collection('tokenVault').where(FieldPath.documentId(), '>=', prefix).where(FieldPath.documentId(), '<', `${prefix}`).get();
    const batch = db().batch();
    snaps.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
  },
};
