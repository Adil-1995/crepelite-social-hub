# Adding a social network

Adding a network should touch exactly two places: a **manifest** in `shared/`
and a **provider** in `functions/`. If you find yourself editing the composer,
the connections screen or the scheduler, something is wrong — say why in the
pull request, because it means the abstraction is leaking.

Nothing in the core may contain `if (provider === 'x')`. The UI renders from
capabilities; the backend dispatches through the registry.

---

## 1. The manifest — `shared/src/providers/manifests/<id>.ts`

The manifest is **client-safe and secret-free**. It is the single description of
what the network can do, and the composer builds itself from it.

```ts
export const threadsManifest: ProviderManifest = {
  id: 'threads',
  displayName: 'Threads',
  authFamily: 'meta',          // shares a grant with Facebook and Instagram
  brandColor: '#000000',
  iconPath: 'M12 2C6.48 2 …',  // single-path 24×24 SVG
  apiVersion: 'v1.0',
  docs: 'docs/providers/threads.md',
  channelKinds: [{ id: 'threads_user', label: 'Threads account' }],
  capabilities: { … },
  settingsFields: [ … ],
  rateLimit: { maxConcurrent: 1, strategy: 'headers' },
};
```

### Capabilities

Declare what the network really does, from its current official documentation —
never from memory, and never optimistically. A capability claimed but not
delivered becomes a publish-time failure the user cannot act on.

- `supports` — which media shapes exist at all.
- `fields` — which text fields exist, whether they are required, their limits
  and **how the limit is counted** (`utf16`, `bytes` or `graphemes`; YouTube
  descriptions count bytes).
- `formats` — feed, reel, story, pin…, each with its media min/max and whether
  images, videos or a mix are allowed.
- `media` — mime types, size ceilings, duration and aspect-ratio bounds.
- `canReadPosts`, `canEditPublishedPost`, `editableAfterPublish`,
  `importMediaRetrievable`, `asyncProcessing`, `webhooks`.

`editableAfterPublish` must be empty when `canEditPublishedPost` is false; a
test enforces that.

### Settings fields

Anything network-specific the user chooses — a Pinterest board, a TikTok
privacy level, YouTube's "made for kids". The composer renders each field type
with the matching PrimeVue control, so no UI change is needed.

Options can be static, or read from the channel at runtime:

```ts
{ key: 'boardId', label: 'Board', type: 'select',
  required: true, optionsFromChannel: 'boards' }
```

`optionsFromChannel: 'boards'` reads `socialChannel.metadata.boards`, which the
provider populated at connection time.

### Register it

Add it to `ALL_MANIFESTS` in `shared/src/providers/catalog.ts` and export it
from `shared/src/index.ts`. That is all the client needs — the network now
appears in the connections screen and the composer.

---

## 2. The provider — `functions/src/providers/<id>/<id>Provider.ts`

Implement `SocialProvider` (`functions/src/providers/types.ts`):

| Member | Responsibility |
| --- | --- |
| `id`, `manifest` | Must match; the registry rejects a mismatch |
| `auth` | An `OAuthAdapter`, shared across an `authFamily` |
| `publish` | Create the post. **Checkpoint before anything irreversible** |
| `fetchStatus` | Resolve an asynchronous publication |
| `listPosts` | Read the account's own posts, for import |
| `updatePublished` / `deletePublished` | Only if the capabilities claim them |
| `validate` | Runtime checks the pure manifest cannot express |

### The checkpoint rule

This is the part that keeps a retry from becoming a duplicate post.

Before any call that can create something on the network, write the identifier
you will need to find it again into `delivery.processingMetadata`:

```ts
await checkpoint({ containerId: container.id });
const published = await this.graph.post(`${igId}/media_publish`, token, {
  creation_id: container.id,
});
```

If the function dies between those two lines, reconciliation resolves the real
outcome from `containerId` instead of creating a second container. Without the
checkpoint, the only safe options are "never retry" or "risk a duplicate".

### Error classification

Throw `ProviderError` with a category and a `retryable` flag, because that is
what decides whether the delivery is retried automatically:

| Category | Retryable | Example |
| --- | --- | --- |
| `NETWORK` | yes | Timeout, connection reset |
| `RATE_LIMIT` | yes | 429 |
| `PLATFORM` | yes | Provider 5xx |
| `PROCESSING` | yes | Still transcoding |
| `AUTH` | no | Token revoked → `needs_reauth` |
| `PERMISSION` | no | Scope not granted |
| `VALIDATION` | no | Caption too long |
| `MEDIA` | no | Unsupported codec |
| `UNKNOWN` | no | Anything unrecognised |

`UNKNOWN` is deliberately non-retryable: an unrecognised outcome might mean the
post went out.

### Register it

Add it in `functions/src/providers/index.ts`. Providers sharing an `authFamily`
must share **the same adapter instance** — the registry rejects two different
adapters for one family.

---

## 3. OAuth

If the network joins an existing family (`meta`, `google`), reuse its adapter
and add the scopes.

For a new family, implement `OAuthAdapter`:

- `getAuthorizationUrl({ state, redirectUri, codeChallenge, nonce })` — use
  PKCE if the provider supports it.
- `handleOAuthCallback({ code, redirectUri, codeVerifier })` — exchange the
  code, then return the account plus **the channels it can publish to**.
- `refresh(tokens)` and `checkHealth(tokens)`.

The redirect URI is shared: `https://<domain>/api/oauth/callback`. Providers are
told apart by the signed `state`, not by the path, so there is nothing new to
register beyond the provider console entry.

---

## 4. Documentation and tests

Create `docs/providers/<id>.md` covering API version, scopes, account
requirements, supported types, post-publish editing, rate limits, approval
requirements and real limitations. Add the approval steps to
`provider-approval-checklist.md`.

The shared test suite picks up a new manifest automatically and will check that
it is coherent — unique format ids, settings scoped to real formats, capability
claims that do not contradict each other. Add provider-specific tests for
anything the generic suite cannot know.

---

## Checklist

- [ ] `shared/src/providers/manifests/<id>.ts`
- [ ] Added to `ALL_MANIFESTS` and exported from `shared/src/index.ts`
- [ ] `functions/src/providers/<id>/<id>Provider.ts`
- [ ] Registered in `functions/src/providers/index.ts`
- [ ] OAuth adapter (new family) or scopes added (existing family)
- [ ] Credentials read from Secret Manager, never hardcoded
- [ ] Checkpoints written before every irreversible call
- [ ] Errors classified with a category and a retryable flag
- [ ] `docs/providers/<id>.md`
- [ ] Approval steps added to the checklist
- [ ] `npm run typecheck && npm run lint && npm test` pass
- [ ] **No core file changed**
