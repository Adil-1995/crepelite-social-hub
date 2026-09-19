# Provider approval checklist

Everything on this page needs a human. None of it can be automated, because it
involves logging into provider consoles, accepting terms, recording demo videos
and waiting for review.

Development does not wait for any of it: the **MockProvider** exercises the
whole publishing pipeline — success, failure, async processing, expired auth and
rate limiting — with no external credentials at all.

Legend: `[ ]` not started · `[~]` submitted, waiting · `[x]` granted

---

## 1. Meta — Facebook Pages + Instagram

One app covers both networks. See [`providers/facebook.md`](./providers/facebook.md)
and [`providers/instagram.md`](./providers/instagram.md).

- [ ] Create a **Business**-type app at developers.facebook.com
- [ ] Add the **Facebook Login** and **Instagram** products
- [ ] Register redirect URI `https://<domain>/api/oauth/callback`
      (Facebook Login → Settings)
- [ ] Add the bare domain to **App Domains** (Settings → Basic) and a
      **Website** platform with the Site URL — Meta checks these separately
      from the redirect URI and blocks the dialog without them
- [ ] Complete **Business Verification** (needs company documents)
- [ ] Submit App Review for: `pages_show_list`, `pages_read_engagement`,
      `pages_manage_posts`, `business_management`, `instagram_basic`,
      `instagram_content_publish`
- [ ] Record the screencast App Review requires (connect → compose → publish)
- [ ] Provide **`META_APP_ID`** and **`META_APP_SECRET`**

**Before review passes:** only people with a role on the app (admin, developer,
tester) can connect. That is enough to test everything.

**Account prerequisites you must have:**
- A Facebook **Page** (not a personal profile)
- An Instagram **Professional** account **linked to that Page**

---

## 2. TikTok

See [`providers/tiktok.md`](./providers/tiktok.md).

- [ ] Register an app at developers.tiktok.com
- [ ] Add **Login Kit** and **Content Posting API**
- [ ] Register redirect URI `https://<domain>/api/oauth/callback`
- [ ] Verify domain ownership
- [ ] Apply for the **Content Posting API audit**
- [ ] Submit the demo video the audit requires
- [ ] Provide **`TIKTOK_CLIENT_KEY`** and **`TIKTOK_CLIENT_SECRET`**

> **Until the audit passes, every post TikTok accepts is forced to private
> (`SELF_ONLY`).** This is TikTok's rule. CrepeLite shows this state in the
> connections screen rather than pretending posts are public.

---

## 3. Pinterest

See [`providers/pinterest.md`](./providers/pinterest.md).

- [ ] Create an app at developers.pinterest.com
- [ ] Register redirect URI `https://<domain>/api/oauth/callback`
- [ ] Request **standard access** for `boards:read`, `pins:read`, `pins:write`,
      `user_accounts:read`
- [ ] Provide **`PINTEREST_APP_ID`** and **`PINTEREST_APP_SECRET`**

**Account prerequisites:** a Pinterest **business** account with at least one
board.

---

## 4. Google — YouTube

See [`providers/youtube.md`](./providers/youtube.md).

- [ ] Enable **YouTube Data API v3** in the Google Cloud project
- [ ] Create OAuth 2.0 credentials
- [ ] Configure the OAuth consent screen
- [ ] Register redirect URI `https://<domain>/api/oauth/callback`
- [ ] Submit for **OAuth verification** (both scopes are sensitive)
- [ ] Request the **YouTube API Services compliance audit**
- [ ] Provide **`GOOGLE_OAUTH_CLIENT_ID`** and **`GOOGLE_OAUTH_CLIENT_SECRET`**

**Before verification:** add up to 100 test users to the consent screen.

**Quota note:** `videos.insert` is capped at **100 uploads/day per project**,
shared across every workspace. Request an increase from Google if needed.

---

## 5. Google Cloud / Firebase

- [ ] Enable **Blaze** billing on the Firebase project (Cloud Functions, Cloud
      Tasks and Cloud Run all require it)
- [ ] Set budget alerts (see [`deployment.md`](./deployment.md#budget-alerts))
- [ ] Store every secret above with `firebase functions:secrets:set NAME`

---

> **All four providers share one redirect URI:** `https://<domain>/api/oauth/callback`.
> The backend tells them apart from the signed `state` parameter.

## 6. Domain

- [ ] Point the production domain at Firebase Hosting
- [ ] Complete DNS ownership verification
- [ ] Use the final HTTPS domain in every redirect URI above — providers match
      them exactly, so changing the domain later means editing every console

---

## Status summary

| Provider | Credentials | Review | Live publishing |
| --- | --- | --- | --- |
| Facebook | ☐ | ☐ App Review | Blocked on review |
| Instagram | ☐ (shared with Facebook) | ☐ App Review | Blocked on review |
| TikTok | ☐ | ☐ Content Posting audit | Private-only until audit |
| Pinterest | ☐ | ☐ Standard access | Blocked on access |
| YouTube | ☐ | ☐ OAuth verification | 100 test users until verified |
| Mock | n/a | n/a | Works now, development only |
