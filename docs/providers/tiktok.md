# TikTok

| | |
| --- | --- |
| Provider id | `tiktok` |
| OAuth family | `tiktok` |
| API | TikTok Content Posting API `v2` |
| Manifest | `shared/src/providers/manifests/tiktok.ts` |
| Implementation | `functions/src/providers/tiktok/tiktokProvider.ts` |
| Status | **IMPLEMENTED — PROVIDER APPROVAL NEEDED** |

## OAuth

TikTok Login Kit, authorisation-code flow with **PKCE** and `state`.

Redirect URI to register:

```
https://<your-domain>/api/oauth/callback
```

This is **one shared redirect URI for every provider** — the backend
identifies the provider from the signed `state` parameter, not from the path.
It can be overridden with the `OAUTH_REDIRECT_URI` environment variable.


### Scopes requested

| Scope | Why |
| --- | --- |
| `user.info.basic` | Display name and avatar for the connected account |
| `video.publish` | Publish content directly |
| `video.upload` | Upload content to the creator's drafts |
| `video.list` | Read the creator's own posts (import / crosspost) |

## The audit gate

This is the single most important thing to know about TikTok.

Until an app passes TikTok's **Content Posting API audit**, every post it
creates is forced to **`SELF_ONLY`** (private) regardless of the privacy level
requested. This is TikTok's rule, not a CrepeLite limitation.

CrepeLite reflects the audit state rather than hiding it:

- `getProviderStatus` returns `notices.tiktokAudited`.
- The connections screen shows a banner while the audit is outstanding.
- The composer offers the privacy levels the creator's own account allows,
  read live from `creator_info`.

CrepeLite does **not** simulate public publishing before approval.

## Creator info

Before publishing, the API is asked for `creator_info`, which returns:

- The privacy levels this creator may use.
- Whether comments, duet and stitch are disabled for them.
- The maximum video duration their account allows.
- The remaining daily post quota.

These become the options in the composer, so a creator is never offered a
setting their account will reject.

## Supported publication types

| Type | Supported | Notes |
| --- | --- | --- |
| Video | Yes | Direct post or upload-to-drafts |
| Photo posts | Yes | Where the account is eligible |
| Text only | No | |

## Publishing model

Publishing is asynchronous. The API returns a `publish_id`; the real outcome
arrives later. CrepeLite writes `publish_id` into
`delivery.processingMetadata` before returning, then resolves the final state
through **both**:

- the status endpoint (polled on a decaying schedule), and
- TikTok **webhooks** (`webhooks: true` in the manifest).

Whichever arrives first wins, and the state machine rejects a second
transition, so the two paths cannot double-publish.

## After publishing

`canEditPublishedPost` is **false** — TikTok exposes no edit endpoint.

## Rate limits

- Concurrency in CrepeLite: **1** per channel.
- Documented: **init endpoints 6 requests/minute per user token**; the creator's
  daily cap is whatever `creator_info` reports.
- Fixed-window strategy (TikTok does not return usable quota headers).

## Approval requirements

1. Register an app at [developers.tiktok.com](https://developers.tiktok.com).
2. Add **Login Kit** and **Content Posting API**.
3. Register the redirect URI above.
4. Verify domain ownership for the redirect domain.
5. Apply for the **Content Posting API audit** and submit a demo video of the
   full flow. Until it passes, all posts stay private.

## Known limitations

- Private-only output until the audit passes.
- No editing after publishing.
- `importMediaRetrievable` is **false**: TikTok does not let you download the
  original file of your own post through the API, so imported posts are created
  as drafts with the text and a note that the media must be uploaded manually.
