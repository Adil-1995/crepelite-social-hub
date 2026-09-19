# Pinterest

| | |
| --- | --- |
| Provider id | `pinterest` |
| OAuth family | `pinterest` |
| API | Pinterest API `v5` |
| Manifest | `shared/src/providers/manifests/pinterest.ts` |
| Implementation | `functions/src/providers/pinterest/pinterestProvider.ts` |
| Status | **IMPLEMENTED — CREDENTIALS NEEDED** |

## OAuth

Authorisation-code flow with `state`.

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
| `boards:read` | List the boards a Pin can go to |
| `pins:read` | Read your own Pins (import / crosspost) |
| `pins:write` | Create and update Pins |
| `user_accounts:read` | Identify the connected account |

## Account requirements

- A Pinterest **business** account.
- At least one board. A Pin cannot exist without one, which is why **board is a
  required setting** in the composer.

## Boards

Boards are read at connection time and stored in
`socialChannel.metadata.boards` as `{ value, label }` pairs. The composer
renders the board picker from that metadata through the manifest's
`optionsFromChannel` mechanism — the UI has no Pinterest-specific code.

If a board is created in Pinterest after connecting, use **Refresh status** on
the connection to pick it up.

## Supported publication types

| Type | Supported | Notes |
| --- | --- | --- |
| Image Pin | Yes | |
| Video Pin | Yes | Asynchronous processing |
| Carousel | Yes | Multiple images in one Pin |
| Text only | No | A Pin requires media |

### Pin fields

| Field | Required | Notes |
| --- | --- | --- |
| Board | Yes | Chosen per channel in the composer |
| Title | Optional | |
| Description | Optional | |
| Destination link | Optional | The URL the Pin sends people to |

## After publishing

`canEditPublishedPost` is **true** — title, description and link can be updated
on an existing Pin.

## Rate limits

- Concurrency in CrepeLite: **2** per channel.
- Pinterest returns rate-limit headers; the client backs off on them.

## Sandbox

Pinterest offers a sandbox environment. When CrepeLite is pointed at it,
`getProviderStatus` returns `notices.pinterestSandbox` and the connections
screen warns that Pins will not appear publicly.

## Setup requirements

1. Create an app at
   [developers.pinterest.com](https://developers.pinterest.com).
2. Register the redirect URI above.
3. Request **standard access** for the scopes listed. Trial access works for
   testing against your own account.

No formal review video is required, but standard access is granted by Pinterest
and is not instant.

## Known limitations

- Business accounts only.
- A board must exist before the first Pin.
- Video Pins process asynchronously, so a delivery may sit in `processing`.
