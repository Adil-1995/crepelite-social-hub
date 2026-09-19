import { z } from 'zod';
import { onRequest } from 'firebase-functions/v2/https';
import { channelToggleSchema, connectionRef, createManifestCatalog, disconnectSchema, startOAuthSchema, workspaceRef, type Delivery, type SocialConnection } from '@shared/index';
import { requirePermission } from '../auth/access';
import { callable } from './callable';
import { getRegistry } from '../providers';
import { getDispatcher } from '../tasks/dispatcher';
import { ALL_SECRETS, REGION, config, mockProviderEnabled, appEnv } from '../config/env';
import { createOAuthState, consumeOAuthState } from '../oauth/oauthState';
import { FieldValue, db, paths } from '../utils/firestore';
import { fail } from '../utils/errors';
import { log } from '../utils/logger';
import { ProviderError } from '../providers/errors';
import { refreshConnection, saveConnection, syncChannels } from '../services/connections';
import { TokenVaultService, vaultKeys } from '../services/tokenVault';
import { audit, userActor } from '../services/audit';
import { cancelPost } from '../scheduling/scheduler';

/** Registered redirect URI (must match exactly what is configured at each provider). */
export function oauthRedirectUri(): string {
  const explicit = process.env.OAUTH_REDIRECT_URI;
  if (explicit) return explicit;
  const base = config.apiBaseUrl() || `${config.appBaseUrl()}/api`;
  return `${base.replace(/\/$/, '')}/oauth/callback`;
}

/** Runtime provider status for the Connections screen — never includes secrets. */
export const getProviderStatusFn = callable(
  workspaceRef,
  async (data, req) => {
    await requirePermission(req, data.workspaceId, 'workspace.read');
    const registry = getRegistry();
    const catalog = createManifestCatalog({ includeDevOnly: mockProviderEnabled() });
    return {
      environment: appEnv(),
      mockEnabled: mockProviderEnabled(),
      families: registry.authFamilies().map((a) => ({
        family: a.family,
        displayName: a.displayName,
        configured: a.isConfigured(),
        missing: a.missingConfiguration(),
        providers: registry.providersForFamily(a.family).map((p) => p.id).filter((id) => catalog.has(id)),
      })),
      notices: {
        tiktokAudited: config.tiktok.audited(),
        youtubeAudited: config.google.youtubeAudited(),
        pinterestSandbox: config.pinterest.apiBase().includes('sandbox'),
      },
    };
  },
  { secrets: ALL_SECRETS },
);

export const startOAuthFn = callable(
  startOAuthSchema,
  async (data, req) => {
    const actor = await requirePermission(req, data.workspaceId, 'connections.manage');
    const registry = getRegistry();
    const adapter = registry.authFamilies().find((a) => a.family === data.authFamily) ?? fail('invalid-argument', 'Unknown provider');
    if (!adapter.isConfigured()) {
      fail('failed-precondition', 'Provider configuration required', { reason: 'provider_not_configured', missing: adapter.missingConfiguration() });
    }
    const redirectUri = oauthRedirectUri();
    const { state, nonce, codeChallenge } = await createOAuthState({
      workspaceId: data.workspaceId,
      uid: actor.uid,
      authFamily: data.authFamily,
      returnTo: data.returnTo,
      connectionId: data.connectionId ?? null,
      redirectUri,
      usePkce: adapter.usesPkce,
    });
    return { authorizationUrl: adapter.getAuthorizationUrl({ state, redirectUri, codeChallenge, nonce }) };
  },
  { secrets: ALL_SECRETS },
);

function appRedirect(returnTo: string, params: Record<string, string>): string {
  const u = new URL(returnTo.startsWith('/') ? returnTo : '/connections', config.appBaseUrl());
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}

/**
 * OAuth redirect target (GET /oauth/callback?code&state). Exchanges the code
 * server-side; the browser only ever receives a redirect back to the app.
 */
export const oauthCallback = onRequest({ region: REGION, secrets: ALL_SECRETS, timeoutSeconds: 120 }, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.set('Referrer-Policy', 'no-referrer');
  if (req.method !== 'GET') {
    res.status(405).send('Method not allowed');
    return;
  }
  const q = Object.fromEntries(Object.entries(req.query).map(([k, v]) => [k, String(Array.isArray(v) ? v[0] : v ?? '')]));
  const consumed = await consumeOAuthState(q.state ?? '');
  if (!consumed.ok) {
    log.warn('OAuth callback with invalid state', { reason: consumed.reason });
    res.redirect(302, appRedirect('/connections', { oauth: 'error', reason: consumed.reason }));
    return;
  }
  const st = consumed.record;
  if (q.error || !q.code) {
    res.redirect(302, appRedirect(st.returnTo, { oauth: 'error', reason: q.error || 'missing_code', family: st.authFamily }));
    return;
  }
  // Re-check the user still manages connections in that workspace.
  const member = await db().doc(paths.member(st.workspaceId, st.uid)).get();
  if (!member.exists || !['OWNER', 'ADMIN'].includes(member.get('role') as string)) {
    res.redirect(302, appRedirect(st.returnTo, { oauth: 'error', reason: 'forbidden' }));
    return;
  }
  try {
    const registry = getRegistry();
    const adapter = registry.authAdapter(st.authFamily);
    const result = await adapter.handleOAuthCallback({ code: q.code, redirectUri: st.redirectUri, codeVerifier: st.codeVerifier, query: {} });
    const connectionId = await saveConnection(st.workspaceId, st.authFamily, result, st.uid, st.connectionId);
    const destinations = await adapter.getDestinations(result.tokens);
    const channels = await syncChannels(registry, st.workspaceId, connectionId, destinations);
    res.redirect(302, appRedirect(st.returnTo, { oauth: 'success', family: st.authFamily, channels: String(channels.length) }));
  } catch (e) {
    const err = e instanceof ProviderError ? e : null;
    log.error('OAuth callback failed', { family: st.authFamily, code: err?.code ?? 'unexpected', message: (e as Error).message });
    res.redirect(302, appRedirect(st.returnTo, { oauth: 'error', reason: err?.code ?? 'exchange_failed', family: st.authFamily }));
  }
});

export const refreshConnectionFn = callable(
  connectionRef,
  async (data, req) => {
    const actor = await requirePermission(req, data.workspaceId, 'connections.manage');
    const conn = await refreshConnection(getRegistry(), data.workspaceId, data.connectionId, userActor(actor.uid, actor.email));
    return { status: conn.status };
  },
  { secrets: ALL_SECRETS },
);

export const disconnectConnectionFn = callable(
  disconnectSchema,
  async (data, req) => {
    const actor = await requirePermission(req, data.workspaceId, 'connections.manage');
    const connRef = db().doc(paths.connection(data.workspaceId, data.connectionId));
    const snap = await connRef.get();
    if (!snap.exists) fail('not-found', 'Connection not found');
    const conn = { id: snap.id, ...snap.data() } as SocialConnection;

    const pending = await db()
      .collection(paths.deliveries(data.workspaceId))
      .where('connectionId', '==', data.connectionId)
      .where('status', 'in', ['queued', 'awaiting_queue', 'failed', 'needs_reauth'])
      .get();
    const dependent = pending.docs.map((d) => d.data() as Delivery);
    if (dependent.length > 0 && !data.confirm) {
      return {
        requiresConfirmation: true,
        dependentScheduled: dependent.filter((d) => d.status === 'queued' || d.status === 'awaiting_queue').length,
        dependentPostIds: [...new Set(dependent.map((d) => d.postId))].slice(0, 50),
      };
    }
    // Cancel dependent deliveries explicitly (never let them silently fail later).
    const byPost = new Map<string, string[]>();
    for (const d of dependent) byPost.set(d.postId, [...(byPost.get(d.postId) ?? []), d.channelId]);
    for (const [postId, channelIds] of byPost) {
      await cancelPost({ registry: getRegistry(), dispatcher: getDispatcher() }, data.workspaceId, postId, channelIds, userActor(actor.uid, actor.email));
    }

    const tokens = await TokenVaultService.get(vaultKeys.connection(data.workspaceId, conn.id));
    if (tokens) await getRegistry().authAdapter(conn.authFamily).disconnect(tokens).catch(() => undefined);
    await TokenVaultService.delete(vaultKeys.connection(data.workspaceId, conn.id));
    const channels = await db().collection(paths.channels(data.workspaceId)).where('connectionId', '==', conn.id).get();
    for (const c of channels.docs) {
      await TokenVaultService.delete(vaultKeys.channel(data.workspaceId, c.id));
      await c.ref.update({ status: 'revoked', enabled: false, updatedAt: FieldValue.serverTimestamp() });
    }
    await connRef.update({ status: 'revoked', expiresAt: null, updatedAt: FieldValue.serverTimestamp() });
    await audit({ workspaceId: data.workspaceId, actor: userActor(actor.uid, actor.email), action: 'connection.removed', entityType: 'connection', entityId: conn.id, metadata: { family: conn.authFamily, cancelledDeliveries: dependent.length } });
    return { requiresConfirmation: false, cancelledDeliveries: dependent.length };
  },
  { secrets: ALL_SECRETS },
);

export const setChannelEnabledFn = callable(channelToggleSchema, async (data, req) => {
  const actor = await requirePermission(req, data.workspaceId, 'connections.manage');
  await db().doc(paths.channel(data.workspaceId, data.channelId)).update({ enabled: data.enabled, updatedAt: FieldValue.serverTimestamp() });
  await audit({ workspaceId: data.workspaceId, actor: userActor(actor.uid, actor.email), action: data.enabled ? 'channel.enabled' : 'channel.disabled', entityType: 'channel', entityId: data.channelId, metadata: {} });
  return { ok: true };
});

/** Dev/test helper to simulate token revocation on a MOCK connection (never available in production). */
export const mockRevokeConnectionFn = callable(z.object({ workspaceId: z.string(), connectionId: z.string() }), async (data, req) => {
  if (!mockProviderEnabled()) fail('permission-denied', 'Not available');
  await requirePermission(req, data.workspaceId, 'connections.manage');
  const conn = await db().doc(paths.connection(data.workspaceId, data.connectionId)).get();
  if (conn.get('authFamily') !== 'mock') fail('failed-precondition', 'Only MOCK connections');
  const key = vaultKeys.connection(data.workspaceId, data.connectionId);
  const tokens = await TokenVaultService.get(key);
  if (tokens) await TokenVaultService.put(key, { ...tokens, expiresAt: Date.now() - 1000, extra: { ...(tokens.extra ?? {}), mockRevoked: 'true', mockReauthed: 'false' } }, { workspaceId: data.workspaceId, provider: 'mock' });
  return { ok: true };
});
