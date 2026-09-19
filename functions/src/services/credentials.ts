import type { SocialChannel, SocialConnection } from '@shared/index';
import { ProviderError } from '../providers/errors';
import type { ProviderRegistry } from '../providers/registry';
import type { ChannelCredentials } from '../providers/types';
import { FieldValue, db, paths, tsFromMs } from '../utils/firestore';
import { log } from '../utils/logger';
import { TokenVaultService, vaultKeys, type TokenSet } from './tokenVault';

const REFRESH_MARGIN_MS = 5 * 60 * 1000;

/** Marks a connection (and its channels) as needing re-authorisation. */
export async function markConnectionNeedsReauth(workspaceId: string, connectionId: string, err: ProviderError): Promise<void> {
  const conn = db().doc(paths.connection(workspaceId, connectionId));
  await conn.set(
    { status: 'needs_reauth', lastError: err.toDeliveryError(), updatedAt: FieldValue.serverTimestamp() },
    { merge: true },
  );
  const channels = await db().collection(paths.channels(workspaceId)).where('connectionId', '==', connectionId).get();
  const batch = db().batch();
  channels.docs.forEach((d) => batch.update(d.ref, { status: 'needs_reauth', updatedAt: FieldValue.serverTimestamp() }));
  await batch.commit();
}

/**
 * Returns usable credentials for a channel, refreshing the OAuth grant when
 * it is about to expire. Tokens only ever exist in memory here.
 */
export async function resolveCredentials(registry: ProviderRegistry, channel: SocialChannel, connection: SocialConnection): Promise<ChannelCredentials> {
  if (connection.status === 'revoked' || connection.status === 'needs_reauth' || connection.status === 'expired') {
    throw new ProviderError({ code: 'connection_' + connection.status, message: `${connection.accountName}: the account must be reconnected`, category: 'AUTH', retryable: false });
  }
  const key = vaultKeys.connection(channel.workspaceId, connection.id);
  let tokens = await TokenVaultService.get(key);
  if (!tokens) throw new ProviderError({ code: 'tokens_missing', message: 'No stored authorization for this account. Reconnect it.', category: 'AUTH', retryable: false });

  if (tokens.expiresAt && tokens.expiresAt - Date.now() < REFRESH_MARGIN_MS) {
    tokens = await refreshConnectionTokens(registry, channel.workspaceId, connection, tokens);
  }
  const channelTokens = await TokenVaultService.get(vaultKeys.channel(channel.workspaceId, channel.id));
  return { accessToken: channelTokens?.accessToken ?? tokens.accessToken, connection: tokens, channel: channelTokens };
}

export async function refreshConnectionTokens(registry: ProviderRegistry, workspaceId: string, connection: SocialConnection, tokens: TokenSet): Promise<TokenSet> {
  const adapter = registry.authAdapter(connection.authFamily);
  try {
    const refreshed = await adapter.refreshAuthorization(tokens);
    await TokenVaultService.put(vaultKeys.connection(workspaceId, connection.id), refreshed, { workspaceId, provider: connection.authFamily });
    await db()
      .doc(paths.connection(workspaceId, connection.id))
      .set({ expiresAt: refreshed.expiresAt ? tsFromMs(refreshed.expiresAt) : null, status: 'connected', updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    return refreshed;
  } catch (e) {
    const err = e instanceof ProviderError ? e : new ProviderError({ code: 'refresh_failed', message: (e as Error).message, category: 'AUTH', retryable: false });
    if (err.needsReauth || err.category === 'AUTH') {
      log.warn('Token refresh requires re-authorisation', { workspaceId, connectionId: connection.id, code: err.code });
      await markConnectionNeedsReauth(workspaceId, connection.id, err);
    }
    throw err;
  }
}
