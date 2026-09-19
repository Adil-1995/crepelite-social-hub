# YouTube

| | |
| --- | --- |
| Provider id | `youtube` |
| OAuth family | `google` |
| API | YouTube Data API `v3` |
| Manifest | `shared/src/providers/manifests/youtube.ts` |
| Implementation | `functions/src/providers/youtube/youtubeProvider.ts` |
| Status | **IMPLEMENTED — OAUTH VERIFICATION NEEDED** |

## OAuth

Google OAuth 2.0, authorisation-code flow with `state`, `access_type=offline`
and `include_granted_scopes=true` so a refresh token is issued.

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
| `https://www.googleapis.com/auth/youtube.upload` | Upload videos |
| `https://www.googleapis.com/auth/youtube.force-ssl` | Read and update your own videos |

Both are **sensitive/restricted** scopes. If the upload scope is not granted,
CrepeLite fails the connection immediately with a clear message rather than
letting the user discover it at publish time.

## Account requirements

- A Google account with a YouTube channel.
- The channel must be verified to upload videos longer than 15 minutes.

## Uploading

Videos use YouTube's **resumable upload** protocol:

1. Start a resumable session; the session URI is written to
   `delivery.processingMetadata` before any bytes are sent.
2. Stream the file. Large files go through the **Cloud Run worker**, not a
   Cloud Function — a Function would have to buffer the whole video in memory.
3. YouTube processes the video asynchronously; CrepeLite polls until it is
   `published` or failed.

Because the session URI is checkpointed, a crashed upload resumes instead of
starting a second one.

## Video metadata

| Field | Notes |
| --- | --- |
| Title | Required |
| Description | Counted in **bytes**, not characters — the composer counts the same way |
| Tags | Optional |
| Category | From the manifest's category list |
| Privacy | `public`, `unlisted`, `private` |
| Made for kids | Required by COPPA; exposed as a provider setting |
| Scheduled publish | YouTube can hold a `private` video and publish it itself |

## Shorts

A Short is an ordinary upload that happens to be vertical and under the length
limit — YouTube classifies it automatically. There is no separate Shorts API,
and CrepeLite does not pretend otherwise.

## After publishing

`canEditPublishedPost` is **true**: title, description, tags and privacy can be
updated through `videos.update`.

## Rate limits

- Concurrency in CrepeLite: **1** per channel.
- Documented: **`videos.insert` — 100 per day per project**; other calls draw on
  a 10,000 unit/day quota.
- The daily upload cap is a *project* quota, shared by every workspace using the
  same Google Cloud project. A quota increase must be requested from Google.

## Verification requirements

1. Create OAuth credentials in the
   [Google Cloud console](https://console.cloud.google.com) for the project.
2. Enable the **YouTube Data API v3**.
3. Register the redirect URI above.
4. Configure the OAuth consent screen.
5. Submit for **OAuth verification**, including a demo video, because both
   scopes are sensitive.
6. Unverified apps are limited to **100 test users** added manually to the
   consent screen. That is enough to run the full flow.

Google also requires a **YouTube API Services compliance audit** for production
use of upload scopes.

## Known limitations

- 100 uploads per day per Google Cloud project.
- Unverified apps are capped at 100 test users.
- `importMediaRetrievable` is **false**: the API does not let you download your
  own video file, so imported videos become drafts with metadata and a note that
  the file must be uploaded manually.
