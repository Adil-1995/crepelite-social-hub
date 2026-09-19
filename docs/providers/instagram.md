# Instagram

| | |
| --- | --- |
| Provider id | `instagram` |
| OAuth family | `meta` (shared with [Facebook](./facebook.md)) |
| API | Instagram Graph API via Meta Graph `v26.0` |
| Manifest | `shared/src/providers/manifests/instagram.ts` |
| Implementation | `functions/src/providers/instagram/instagramProvider.ts` |
| Status | **IMPLEMENTED — APP REVIEW NEEDED** |

## OAuth

Instagram shares the Meta grant. Connecting "Meta" in CrepeLite authorises
Facebook Pages **and** the Instagram professional accounts linked to them —
there is no separate Instagram connection to make. Scopes are listed in the
[Facebook document](./facebook.md#scopes-requested); the Instagram-specific
ones are `instagram_basic` and `instagram_content_publish`.

## Account requirements

Publishing through the API requires **all** of:

- An Instagram **Professional** account (Business or Creator).
- That account **linked to a Facebook Page**.
- The connecting user holding a content role on that Page.

A personal Instagram account cannot publish through any official API. CrepeLite
surfaces this as a capability rather than failing at publish time: accounts that
do not qualify are not offered as destinations.

## Publishing model

Instagram publishes in two steps, and CrepeLite persists a checkpoint between
them:

1. **Create a container** for the media (`/media`), which returns a container id.
2. **Publish the container** (`/media_publish`).

The container id is written to `delivery.processingMetadata` *before* the
publish call. If the function dies mid-flight, reconciliation resolves the real
outcome from that container instead of creating a second post. This is the
mechanism that stops a retry becoming a duplicate.

## Supported publication types

| Type | Supported | Notes |
| --- | --- | --- |
| Feed image | Yes | |
| Carousel | Yes | 2–10 items, images and video may be mixed |
| Feed video | Yes | Delivered as a Reel by Instagram |
| Reels | Yes | Vertical video |
| Stories | Yes | 24-hour expiry; no permalink after expiry |
| Text only | No | Instagram requires media |

## After publishing

`canEditPublishedPost` is **false**. The Instagram API exposes no edit endpoint
for a published media object, so CrepeLite disables the action and explains why
rather than offering a delete-and-repost that would lose the post's engagement.

## Rate limits

- Concurrency in CrepeLite: **1** publish per channel — Instagram rejects
  concurrent container publishes for the same account.
- Documented quota: **100 API-published posts per account per rolling 24 hours**
  (a carousel counts as one).
- Quota usage is read from the response headers and backed off on.

## App Review requirements

Same app and review cycle as [Facebook](./facebook.md#app-review-requirements).
`instagram_content_publish` is reviewed separately from the Page scopes and
needs a screencast that shows a real publish.

## Known limitations

- No personal accounts.
- No editing after publishing.
- Stories lose their permalink once they expire, so a delivery that published a
  Story may end up with a null `externalPostUrl` — this is expected, not an
  error.
- Import (`canReadPosts`) returns your own media; original files are
  retrievable, so crossposting can reuse them.
