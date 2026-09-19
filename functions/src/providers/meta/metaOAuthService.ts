import { META_APP_SECRET, config, secretValue } from '../../config/env';
import { ProviderError } from '../errors';
import type { TokenSet } from '../../services/tokenVault';
import type { AuthorizationUrlRequest, DiscoveredDestination, OAuthAdapter, OAuthCallbackRequest, OAuthResult } from '../types';
import { MetaGraphClient } from './metaGraphClient';

/**
 * Meta OAuth (Facebook Login / Facebook Login for Business) shared by the
 * Facebook and Instagram providers: one grant → Facebook Pages + the
 * Instagram professional accounts linked to them.
 *
 * Flow: dialog → code → short-lived user token → long-lived user token (~60 days)
 * → page tokens (derived from a long-lived user token they do not expire).
 * Meta's web login flow is protected with `state` (+ server-side nonce);
 * PKCE is not used for this confidential server-side client.
 */
export const META_SCOPES = [
  'pages_show_list',
  'pages_read_engagement',
  'pages_manage_posts',
  'business_management',
  'instagram_basic',
  'instagram_content_publish',
];

interface PageAccount {
  id: string;
  name: string;
  access_token?: string;
  tasks?: string[];
  picture?: { data?: { url?: string } };
  instagram_business_account?: { id: string; username?: string; name?: string; profile_picture_url?: string };
}

export class MetaOAuthService implements OAuthAdapter {
  readonly family = 'meta';
  readonly displayName = 'Meta (Facebook & Instagram)';
  readonly usesPkce = false;
  readonly graph: MetaGraphClient;

  constructor(fetchImpl?: typeof fetch) {
    this.graph = new MetaGraphClient(() => secretValue(META_APP_SECRET), fetchImpl);
  }

  missingConfiguration(): string[] {
    const missing: string[] = [];
    if (!config.meta.appId()) missing.push('META_APP_ID');
    if (!secretValue(META_APP_SECRET)) missing.push('META_APP_SECRET (secret)');
    return missing;
  }

  isConfigured(): boolean {
    return this.missingConfiguration().length === 0;
  }

  getAuthorizationUrl(req: AuthorizationUrlRequest): string {
    const u = new URL(`https://www.facebook.com/${this.graph.version}/dialog/oauth`);
    u.searchParams.set('client_id', config.meta.appId());
    u.searchParams.set('redirect_uri', req.redirectUri);
    u.searchParams.set('state', req.state);
    u.searchParams.set('response_type', 'code');
    const configId = config.meta.loginConfigId();
    if (configId) {
      u.searchParams.set('config_id', configId); // Facebook Login for Business configuration
      u.searchParams.set('override_default_response_type', 'true');
    } else {
      u.searchParams.set('scope', META_SCOPES.join(','));
    }
    return u.toString();
  }

  async handleOAuthCallback(req: OAuthCallbackRequest): Promise<OAuthResult> {
    const short = await this.graph.get<{ access_token: string; expires_in?: number }>('oauth/access_token', '', {
      client_id: config.meta.appId(),
      client_secret: secretValue(META_APP_SECRET),
      redirect_uri: req.redirectUri,
      code: req.code,
    }).catch((e) => {
      throw e instanceof ProviderError ? e : ProviderError.validation('Meta code exchange failed');
    });
    const long = await this.exchangeLongLived(short.access_token);
    const me = await this.graph.get<{ id: string; name: string }>('me', long.accessToken, { fields: 'id,name' });
    const perms = await this.graph.get<{ data: Array<{ permission: string; status: string }> }>('me/permissions', long.accessToken);
    return {
      externalAccountId: me.id,
      accountName: me.name,
      scopes: perms.data.filter((p) => p.status === 'granted').map((p) => p.permission),
      tokens: long,
    };
  }

  private async exchangeLongLived(shortToken: string): Promise<TokenSet> {
    const res = await this.graph.get<{ access_token: string; expires_in?: number; token_type?: string }>('oauth/access_token', '', {
      grant_type: 'fb_exchange_token',
      client_id: config.meta.appId(),
      client_secret: secretValue(META_APP_SECRET),
      fb_exchange_token: shortToken,
    });
    return { accessToken: res.access_token, tokenType: res.token_type ?? 'bearer', expiresAt: res.expires_in ? Date.now() + res.expires_in * 1000 : null, refreshToken: null };
  }

  /** Meta long-lived user tokens cannot be refreshed server-side without the user → re-consent. */
  async refreshAuthorization(tokens: TokenSet): Promise<TokenSet> {
    const health = await this.checkHealth(tokens);
    if (health.ok) return { ...tokens, expiresAt: health.expiresAt ?? tokens.expiresAt ?? null };
    throw new ProviderError({ code: 'meta_token_expired', message: 'Meta authorization expired. Reconnect Facebook/Instagram.', category: 'AUTH', retryable: false });
  }

  async disconnect(tokens: TokenSet): Promise<void> {
    await this.graph.delete('me/permissions', tokens.accessToken).catch(() => undefined);
  }

  async getDestinations(tokens: TokenSet): Promise<DiscoveredDestination[]> {
    const pages = await this.graph.paginate<PageAccount>(
      'me/accounts',
      tokens.accessToken,
      { fields: 'id,name,access_token,tasks,picture{url},instagram_business_account{id,username,name,profile_picture_url}', limit: 100 },
      500,
    );
    const out: DiscoveredDestination[] = [];
    for (const p of pages) {
      const canPost = !p.tasks || p.tasks.includes('CREATE_CONTENT');
      if (!p.access_token) continue;
      const pageToken: TokenSet = { accessToken: p.access_token, expiresAt: null, refreshToken: null };
      out.push({
        provider: 'facebook',
        externalId: p.id,
        name: p.name,
        handle: null,
        avatarUrl: p.picture?.data?.url ?? null,
        kind: 'facebook_page',
        metadata: { tasks: p.tasks ?? [], canCreateContent: canPost },
        channelTokens: pageToken,
      });
      const ig = p.instagram_business_account;
      if (ig) {
        out.push({
          provider: 'instagram',
          externalId: ig.id,
          name: ig.name || ig.username || 'Instagram',
          handle: ig.username ? `@${ig.username}` : null,
          avatarUrl: ig.profile_picture_url ?? null,
          kind: 'instagram_professional',
          metadata: { pageId: p.id, accountType: 'BUSINESS_OR_CREATOR' },
          channelTokens: pageToken,
        });
      }
    }
    return out;
  }

  async checkHealth(tokens: TokenSet): Promise<{ ok: boolean; expiresAt?: number | null; scopes?: string[] }> {
    const appToken = `${config.meta.appId()}|${secretValue(META_APP_SECRET)}`;
    const res = await this.graph.get<{ data: { is_valid: boolean; expires_at?: number; data_access_expires_at?: number; scopes?: string[] } }>('debug_token', appToken, {
      input_token: tokens.accessToken,
    });
    const d = res.data;
    return { ok: d.is_valid, expiresAt: d.expires_at ? d.expires_at * 1000 : null, scopes: d.scopes ?? [] };
  }
}
