# Database

Firestore in Native mode is the operational database. Types live in
`shared/src/domain/types.ts`, paths in `functions/src/utils/firestore.ts`, and
access control in `firestore.rules` — those three must stay in step with this
document.

## Layout

```
users/{uid}
users/{uid}/devices/{deviceId}                 server-only

workspaces/{workspaceId}
workspaces/{workspaceId}/members/{uid}
workspaces/{workspaceId}/invitations/{email}
workspaces/{workspaceId}/socialConnections/{connectionId}
workspaces/{workspaceId}/socialChannels/{channelId}
workspaces/{workspaceId}/posts/{postId}
workspaces/{workspaceId}/postVariants/{variantId}
workspaces/{workspaceId}/deliveries/{deliveryId}
workspaces/{workspaceId}/mediaAssets/{mediaId}
workspaces/{workspaceId}/bulkJobs/{jobId}
workspaces/{workspaceId}/importJobs/{jobId}
workspaces/{workspaceId}/auditLogs/{logId}
workspaces/{workspaceId}/notifications/{notificationId}

tokenVault/{key}                               server-only
oauthStates/{state}                            server-only, TTL
webhookEvents/{eventId}                        server-only
importMedia/{id}                               server-only
```

### Why variants and deliveries are flat, not nested under a post

They are queried *across* posts far more often than within one — the calendar,
the dashboard and reconciliation all ask "what is due / failed / stuck in this
workspace", never "what belongs to this post". Nesting them under
`posts/{id}/…` would force collection-group queries for the common case and
make the security rules harder to reason about. They carry `postId` instead.

### Why everything hangs off `workspaces/{workspaceId}`

Isolation is the top security property. A single membership check at the
workspace prefix secures every collection below it, and a rules bug cannot leak
across workspaces the way a flat top-level collection could.

---

## Document-id strategy

| Collection | Id | Why |
| --- | --- | --- |
| `members` | the user's `uid` | One membership per user; makes the rules a single `exists()` |
| `invitations` | lower-cased email | Re-inviting the same address overwrites instead of duplicating |
| `postVariants` | `{postId}_{channelId}` | Deterministic: re-running creation is idempotent |
| `deliveries` | `{postId}_{channelId}` | Same; one delivery per destination, never two |
| `tokenVault` | derived vault key | Never guessable from a connection id alone |
| `oauthStates` | the `state` value | Lookup is the verification |
| everything else | generated | |

Deterministic variant and delivery ids are load-bearing: they are what makes
"save the post again" not create a second delivery for the same channel.

---

## Collections

### `users/{uid}`

The signed-in person. Readable only by themselves; written only by the backend.

| Field | Type | Notes |
| --- | --- | --- |
| `uid` | string | |
| `email` | string \| null | |
| `displayName` | string \| null | |
| `defaultWorkspaceId` | string \| null | |
| `notificationPrefs` | object | `pushEnabled`, `onPublished`, `onPartial`, `onFailed`, `onReauth` |
| `createdAt` | Timestamp | |

`users/{uid}/devices/{deviceId}` holds FCM push tokens and is closed to clients
entirely — a push token is a credential.

### `workspaces/{workspaceId}`

| Field | Type | Notes |
| --- | --- | --- |
| `name` | string | 2–80 chars |
| `slug` | string | |
| `timezone` | string | IANA. Every schedule is interpreted in it |
| `ownerId` | string | Exactly one owner at a time |
| `createdAt` / `updatedAt` | Timestamp | |

**Security:** readable by members, never writable by a client.

### `members/{uid}`

| Field | Type | Notes |
| --- | --- | --- |
| `uid` | string | |
| `role` | `OWNER` \| `ADMIN` \| `EDITOR` \| `VIEWER` | Mirrors `shared/src/domain/roles.ts` |
| `email`, `displayName`, `photoURL` | | Denormalised so the team screen needs no user lookups |
| `addedAt`, `addedBy` | | |

This document is what the rules read on every single request, which is why it
is a direct child of the workspace and keyed by uid.

### `invitations/{email}`

Readable by owners and admins only — it contains other people's email
addresses. Fields: `email`, `role`, `invitedBy`, `createdAt`, `expiresAt`.

### `socialConnections/{connectionId}`

Public metadata of an OAuth grant. **Contains no tokens.**

| Field | Type | Notes |
| --- | --- | --- |
| `provider` | string | `facebook`, `instagram`, … |
| `authFamily` | string | Networks sharing one grant (`meta`) |
| `accountName` | string | |
| `externalAccountId` | string | |
| `status` | `connected` \| `expired` \| `needs_reauth` \| `revoked` \| `error` | |
| `scopes` | string[] | What was actually granted |
| `expiresAt` | Timestamp \| null | |
| `lastHealthCheckAt` | Timestamp \| null | |
| `lastError` | DeliveryError \| null | |

The tokens themselves live in `tokenVault`, encrypted, unreadable by any client.

### `socialChannels/{channelId}`

One publishing destination: a Page, an IG account, a TikTok user, a YouTube
channel.

| Field | Type | Notes |
| --- | --- | --- |
| `connectionId` | string | Parent grant |
| `provider`, `externalId`, `name`, `handle`, `avatarUrl` | | |
| `kind` | string | Provider-specific channel kind |
| `status` | ConnectionStatus | |
| `enabled` | boolean | Per-workspace on/off |
| `metadata` | object | **Non-secret** provider data — Pinterest boards, TikTok privacy options. The composer renders settings from it |

### `posts/{postId}`

| Field | Type | Notes |
| --- | --- | --- |
| `titleInternal` | string | Never published |
| `masterContent` | object | `text`, `title`, `description`, `hashtags[]`, `link` |
| `mediaIds` | string[] | Order matters: it is the carousel order |
| `status` | PostStatus | **Derived** from deliveries by `derivePostStatus` |
| `schedule` | object | `scheduledAt`, `timezone` |
| `channelIds` | string[] | |
| `source` | object | `manual` \| `bulk` \| `import`, with origin ids |
| `deliverySummary` | map | Denormalised per-channel status — lets lists and the calendar render without reading deliveries |
| `calendarAt` | Timestamp \| null | Earliest delivery time; the calendar range field |
| `searchKeywords` | string[] | |
| `revision` | number | Optimistic concurrency for the composer |

`deliverySummary` and `calendarAt` are denormalisations maintained by the
backend. They exist so the posts list and the calendar are one query each
rather than N+1.

### `postVariants/{postId}_{channelId}`

| Field | Type | Notes |
| --- | --- | --- |
| `postId`, `provider`, `channelId` | | |
| `syncMode` | `master` \| `custom` | Linked variants re-derive from the master |
| `format` | string | A format id from the provider manifest |
| `content` | object | Snapshot; the effective content is re-derived when linked |
| `mediaIds` | string[] \| null | `null` means "use the post's media" |
| `providerSettings` | object | Shape declared by the manifest's `settingsFields` |
| `offsetMinutes` | number | Stagger after the post time, ≤ 7 days |
| `scheduledAtOverride` | Timestamp \| null | Absolute override, wins over the offset |

### `deliveries/{postId}_{channelId}`

The unit of publishing, and the most security-sensitive document in the system.

| Field | Type | Notes |
| --- | --- | --- |
| `postId`, `variantId`, `provider`, `channelId`, `connectionId` | | |
| `status` | DeliveryStatus | Only ever changed through the state machine |
| `scheduledAt` | Timestamp \| null | |
| `scheduleVersion` | number | **Bumped on every reschedule; stale tasks are ignored** |
| `taskName` | string \| null | The Cloud Tasks task |
| `executor` | `functions` \| `worker` | |
| `externalPostId` / `externalPostUrl` | string \| null | Proof it published |
| `attemptCount` / `autoRetryCount` | number | |
| `publishingLease` | object \| null | `owner`, `acquiredAt`, `expiresAt` |
| `error` | DeliveryError \| null | `code`, `message`, `category`, `retryable` |
| `processingMetadata` | object | **Checkpoints** written before irreversible provider calls |
| `nextStatusCheckAt` / `statusCheckCount` | | Async processing polls |

Every field from `status` rightwards is server-only. A client that could write
`externalPostId` or `scheduleVersion` could cause a duplicate publication, which
is why the rules deny client writes outright — see `tests/rules`.

### `mediaAssets/{mediaId}`

| Field | Type | Notes |
| --- | --- | --- |
| `kind` | `image` \| `video` | |
| `storagePath` | string | `workspaces/{w}/media/{id}/original.{ext}` |
| `thumbnailPath` | string \| null | |
| `fileName`, `mimeType`, `size` | | Re-verified server-side against the stored object |
| `width`, `height`, `durationSec` | | Probed in the browser, used by validation |
| `usedBy` | string[] | Post ids. Deletion is refused while non-empty |
| `status` | `uploading` \| `ready` \| `error` | |
| `source` | `upload` \| `import` \| `copy` | |

Binary data is never stored in Firestore.

### `bulkJobs`, `importJobs`

Progress and results of a bulk schedule or an import, so a partially failed job
can be inspected rather than silently lost. `importJobs` also holds the fetched
`candidates`.

### `auditLogs/{logId}`

`actor` (uid, type, email), `action`, `entityType`, `entityId`, `metadata`,
`timestamp`. **Never contains secret values.** Readable by members, writable
only by the backend.

### `notifications/{id}`

`kind`, `title`, `body`, optional `postId` / `deliveryId` / `connectionId`,
`readBy[]`, `createdAt`. Read state is an array of uids, so one document serves
the whole workspace.

### Server-only collections

| Collection | Holds | Client access |
| --- | --- | --- |
| `tokenVault` | Encrypted provider access and refresh tokens | **None** |
| `oauthStates` | Short-lived single-use OAuth state, nonce, PKCE verifier | **None** (TTL on `expiresAt`) |
| `webhookEvents` | Raw provider webhook deliveries, for replay protection | **None** |
| `importMedia` | Temporary references to media being copied | **None** |

Rules deny these to everyone, including workspace owners.

---

## Indexes

Defined in `firestore.indexes.json`. Each exists for a query the app actually
makes.

| Collection | Fields | Used by |
| --- | --- | --- |
| `posts` | `status` ASC, `updatedAt` DESC | Posts list, filtered |
| `posts` | `status` ASC, `calendarAt` ASC | Dashboard "coming up" |
| `posts` | `calendarAt` ASC | Calendar range |
| `posts` | `searchKeywords` CONTAINS, `updatedAt` DESC | Search |
| `deliveries` | `scheduledAt` ASC | Dashboard "today" |
| `deliveries` | `postId` ASC, `scheduledAt` ASC | Post detail |
| `deliveries` | `status` ASC, `updatedAt` DESC | Attention list |
| `deliveries` | `channelId` ASC, `status` ASC | Disconnect impact check |
| `deliveries` | `connectionId` ASC, `status` ASC | Connection impact check |
| `deliveries` (group) | `status` ASC, `scheduledAt` ASC | Queue sweep |
| `deliveries` (group) | `status` ASC, `publishingLease.expiresAt` ASC | Expired-lease recovery |
| `deliveries` (group) | `status` ASC, `taskName` ASC, `updatedAt` ASC | Lost-task recovery |
| `deliveries` (group) | `status` ASC, `nextStatusCheckAt` ASC | Async status polls |
| `deliveries` (group) | `processingMetadata.publishId` ASC, `status` ASC | Webhook → delivery lookup |
| `mediaAssets` | `kind` ASC, `createdAt` DESC | Media filter |
| `mediaAssets` | `tags` CONTAINS, `createdAt` DESC | Tag filter |
| `auditLogs` | `entityType` ASC, `timestamp` DESC | Activity filter |
| `notifications` | `createdAt` DESC | Notification centre |

`oauthStates.expiresAt` carries a **TTL policy**, so expired state records
delete themselves rather than accumulating.

---

## Query conventions

- **Cursor pagination only.** `usePagedQuery` uses `startAfter(lastDoc)`; there
  are no offsets and no full scans.
- **Every query is bounded** by a `limit`.
- Realtime listeners are used only where the screen needs live data (dashboard,
  calendar, post detail). Lists are paged reads.
- Substring search is done on loaded pages, not in Firestore, which has no
  substring operator. Keyword search uses `searchKeywords`.

---

## Reading a status

Post status is **derived**, never authored:

```
deliveries → derivePostStatus() → post.status
```

Any mix of destination outcomes resolves to one of `draft`, `scheduled`,
`publishing`, `published`, `partially_published`, `failed` or `cancelled`. The
rule that matters: some published and some failed is
**`partially_published`**, never `failed` — the successful destinations are
real and must not be republished.
