import type { SocialChannel, SocialConnection } from '@shared/index';
import type { ProviderRegistry } from '../providers/registry';
import type { DiscoveredDestination, OAuthResult } from '../providers/types';
import { FieldValue, Timestamp, db, paths } from '../utils/firestore';
import { TokenVaultService, vaultKeys, type TokenSet } from './tokenVault';
import { audit, userActor, SYSTEM_ACTOR, type AuditActor } from './audit';
import { ProviderError } from '../providers/errors';
import { markConnectionNeedsReauth, refreshConnectionTokens } from './credentials';
import { notify } from './notifications';
import { log } from '../utils/logger';

const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 100);

export const connectionIdFor = (family: string, externalAccountId: string) => `${family}_${safe(externalAccountId)}`;
export const channelIdFor = (provider: string, externalId: string) => `${provider}_${safe(externalId)}`;

/** Stores tokens server-side and upserts the public connection metadata. */
export async function saveConnection(workspaceId: string, family: string, result: OAuthResult, uid: string, existingId: string | null): Promise<string> {
  const id = existingId ?? connectionIdFor(family, result.externalAccountId);
  await TokenVaultService.put(vaultKeys.connection(workspaceId, id), result.tokens, { workspaceId, provider: family });
  const ref = db().doc(paths.connection(workspaceId, id));
  const existed = (await ref.get()).exists;
  await ref.set(
    {
      workspaceId,
      provider: family,
      authFamily: family,
      accountName: result.accountName,
      externalAccountId: result.externalAccountId,
      status: 'connected',
      scopes: result.scopes,
      expiresAt: result.tokens.expiresAt ? Timestamp.fromMillis(result.tokens.expiresAt) : null,
      lastHealthCheckAt: FieldValue.serverTimestamp(),
      lastError: null,
      updatedAt: FieldValue.serverTimestamp(),
      ...(existed ? {} : { createdBy: uid, createdAt: FieldValue.serverTimestamp() }),
    },
    { merge: true },
  );
  await audit({ workspaceId, actor: userActor(uid), action: existed ? 'connection.reauthorized' : 'connection.created', entityType: 'connection', entityId: id, metadata: { family, accountName: result.accountName } });
  return id;
}

/**
 * Upserts channels from discovered destinations. Destinations no longer
 * returned are marked revoked/disabled (history keeps referencing them).
 */
export async function syncChannels(registry: ProviderRegistry, workspaceId: string, connectionId: string, destinations: DiscoveredDestination[]): Promise<SocialChannel[]> {
  const existing = await db().collection(paths.channels(workspaceId)).where('connectionId', '==', connectionId).get();
  const seen = new Set<string>();
  const out: SocialChannel[] = [];
  for (const d of destinations) {
    if (!registry.has(d.provider)) continue; // e.g. provider disabled in this environment
    const id = channelIdFor(d.provider, d.externalId);
    seen.add(id);
    const ref = db().doc(paths.channel(workspaceId, id));
    const prev = await ref.get();
    const data = {
      workspaceId,
      provider: d.provider,
      connectionId,
      externalId: d.externalId,
      name: d.name,
      handle: d.handle,
      avatarUrl: d.avatarUrl,
      kind: d.kind,
      status: 'connected',
      metadata: d.metadata,
      updatedAt: FieldValue.serverTimestamp(),
      ...(prev.exists ? {} : { enabled: true, createdAt: FieldValue.serverTimestamp() }),
    };
    await ref.set(data, { merge: true });
    if (d.channelTokens) await TokenVaultService.put(vaultKeys.channel(workspaceId, id), d.channelTokens, { workspaceId, provider: d.provider });
    out.push({ id, ...(prev.data() ?? {}), ...data, enabled: prev.exists ? (prev.get('enabled') as boolean) : true } as unknown as SocialChannel);
  }
  for (const doc of existing.docs) {
    if (seen.has(doc.id)) continue;
    await doc.ref.set({ status: 'revoked', enabled: false, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    await TokenVaultService.delete(vaultKeys.channel(workspaceId, doc.id));
  }
  return out;
}

export async function loadConnection(workspaceId: string, connectionId: string): Promise<SocialConnection> {
  const snap = await db().doc(paths.connection(workspaceId, connectionId)).get();
  if (!snap.exists) throw ProviderError.validation('Connection not found', 'connection_missing');
  return { id: snap.id, ...snap.data() } as SocialConnection;
}

/** Health check + channel re-discovery. Used by the scheduled job and the "Refresh status" button. */
export async function refreshConnection(registry: ProviderRegistry, workspaceId: string, connectionId: string, actor: AuditActor = SYSTEM_ACTOR): Promise<SocialConnection> {
  const conn = await loadConnection(workspaceId, connectionId);
  if (conn.status === 'revoked') return conn;
  const adapter = registry.authAdapter(conn.authFamily);
  const ref = db().doc(paths.connection(workspaceId, connectionId));
  let tokens: TokenSet | null = await TokenVaultService.get(vaultKeys.connection(workspaceId, connectionId));
  try {
    if (!tokens) throw new ProviderError({ code: 'tokens_missing', message: 'No stored authorization', category: 'AUTH', retryable: false });
    // Refresh proactively (3 days ahead) so tokens never die at publish time.
    if (tokens.expiresAt && tokens.expiresAt - Date.now() < 3 * 24 * 3600 * 1000) tokens = await refreshConnectionTokens(registry, workspaceId, conn, tokens);
    const health = await adapter.checkHealth(tokens);
    if (!health.ok) throw new ProviderError({ code: 'token_invalid', message: `${conn.accountName}: authorization is no longer valid`, category: 'AUTH', retryable: false });
    const destinations = await adapter.getDestinations(tokens);
    await syncChannels(registry, workspaceId, connectionId, destinations);
    await ref.set(
      { status: 'connected', lastError: null, lastHealthCheckAt: FieldValue.serverTimestamp(), ...(health.expiresAt ? { expiresAt: Timestamp.fromMillis(health.expiresAt) } : {}), updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
    if (actor.type === 'user') await audit({ workspaceId, actor, action: 'connection.refreshed', entityType: 'connection', entityId: connectionId, metadata: {} });
  } catch (e) {
    const err = e instanceof ProviderError ? e : new ProviderError({ code: 'health_check_failed', message: (e as Error).message, category: 'UNKNOWN', retryable: true });
    if (err.category === 'AUTH' || err.needsReauth) {
      const wasConnected = conn.status === 'connected';
      await markConnectionNeedsReauth(workspaceId, connectionId, err);
      if (wasConnected) {
        await notify({
          workspaceId,
          kind: 'reauth',
          title: `🔐 ${conn.accountName} needs to be reconnected`,
          body: err.message,
          connectionId,
          dedupeKey: `conn_reauth_${connectionId}_${new Date().toISOString().slice(0, 10)}`,
        });
      }
    } else {
      log.warn('Connection health check error', { workspaceId, connectionId, code: err.code });
      await ref.set({ lastError: err.toDeliveryError(), lastHealthCheckAt: FieldValue.serverTimestamp(), ...(err.retryable ? {} : { status: 'error' }) }, { merge: true });
    }
  }
  return loadConnection(workspaceId, connectionId);
}
