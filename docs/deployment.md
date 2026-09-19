# Deployment

Everything here assumes the Firebase CLI is installed and authenticated.

```bash
firebase login
firebase projects:list
```

## Project aliases

`.firebaserc` maps aliases to projects:

| Alias | Project | Use |
| --- | --- | --- |
| `production` (also `default`) | `crepelite-social-hub` | The live deployment |
| `development` | `demo-crepelite` | Emulator only; no cloud project exists |

Firestore lives in **europe-west1**, the same region as the functions and the
task queue, so a publish never crosses a continent. A Firestore location cannot
be changed after creation — if you ever recreate the database, set the location
explicitly rather than letting the CLI default to `nam5`.

### Adding staging

A staging project is not created by default — a second cloud project doubles the
fixed costs. To add one:

```bash
firebase projects:create crepelite-social-staging --display-name "CrepeLite Staging"
firebase use --add                    # choose it, alias it "staging"
```

Then repeat the billing, API and secret steps below for it. `npm run
deploy:staging` already targets the `staging` alias.

---

## 1. Billing

Cloud Functions v2, Cloud Tasks and Cloud Run all require the **Blaze**
(pay-as-you-go) plan. The free Spark plan cannot run any of them.

**This step cannot be automated** — it needs a billing account and a human:

1. Open <https://console.firebase.google.com/project/crepelite-social-hub/usage/details>
2. Select **Modify plan → Blaze**
3. Attach a billing account

Blaze keeps the free tiers; you are billed only above them. A workspace with a
few hundred scheduled posts a month typically stays inside them.

## 2. Google Cloud APIs

```bash
gcloud config set project crepelite-social-hub
gcloud services enable \
  cloudfunctions.googleapis.com \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  cloudtasks.googleapis.com \
  cloudscheduler.googleapis.com \
  secretmanager.googleapis.com \
  firestore.googleapis.com \
  storage.googleapis.com \
  logging.googleapis.com \
  eventarc.googleapis.com
```

Enable nothing beyond this list — each enabled API is extra surface.

> `gcloud` is a separate install from the Firebase CLI. If it is not present,
> the same APIs can be enabled from the Cloud console under
> **APIs & Services → Enable APIs**.

## 3. Secrets

Provider credentials go in Secret Manager, never in a file and never in the
repository.

```bash
firebase functions:secrets:set META_APP_SECRET --project crepelite-social-hub
firebase functions:secrets:set TIKTOK_CLIENT_SECRET --project crepelite-social-hub
firebase functions:secrets:set PINTEREST_CLIENT_SECRET --project crepelite-social-hub
firebase functions:secrets:set GOOGLE_OAUTH_CLIENT_SECRET --project crepelite-social-hub

# Application secrets
firebase functions:secrets:set APP_SIGNING_KEY --project crepelite-social-hub
firebase functions:secrets:set TOKEN_ENCRYPTION_KEY --project crepelite-social-hub
```

Generate the two application secrets with real entropy:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

`TOKEN_ENCRYPTION_KEY` encrypts provider tokens at rest. **Rotating it without
migrating the vault makes every stored token unreadable** and forces every
workspace to reconnect.

Non-secret values (app ids, base URLs) go in `functions/.env.<alias>`:

```
APP_ENV=production
PUBLIC_APP_URL=https://crepelite-social-hub.web.app
OAUTH_REDIRECT_URI=https://crepelite-social-hub.web.app/api/oauth/callback
META_APP_ID=...
TIKTOK_CLIENT_KEY=...
PINTEREST_APP_ID=...
GOOGLE_OAUTH_CLIENT_ID=...
ENABLE_MOCK_PROVIDER=false
```

`ENABLE_MOCK_PROVIDER=false` is important: the mock provider must never be
reachable in production.

## 4. OAuth redirect URI

Every provider uses **one** redirect URI:

```
https://<your-domain>/api/oauth/callback
```

Register it in all four provider consoles — see
[`provider-approval-checklist.md`](./provider-approval-checklist.md). Providers
match it exactly, so decide on the final domain before registering.

## 5. Build and deploy

```bash
npm run build          # web + functions + worker
```

Deploy in dependency order so nothing runs against rules or indexes that do not
exist yet:

```bash
firebase deploy --only firestore:indexes --project crepelite-social-hub
firebase deploy --only firestore:rules,storage --project crepelite-social-hub
firebase deploy --only functions --project crepelite-social-hub
firebase deploy --only hosting --project crepelite-social-hub
```

Or everything at once:

```bash
npm run deploy:production     # asks for confirmation first
```

Indexes build asynchronously. Deploy them first and let them finish before
sending traffic, or queries will fail with "index not ready".

### Cloud Run worker

```bash
npm run deploy:worker
```

Deploy it with `--min-instances=0` so it costs nothing when idle, and keep it
**private** — it is invoked by authenticated Cloud Tasks only, never from the
internet.

## 6. Cloud Tasks and Scheduler

The functions create their task queue on first use. To create it ahead of time:

```bash
gcloud tasks queues create deliveries \
  --location=europe-west1 \
  --max-concurrent-dispatches=10 \
  --max-attempts=5 \
  --min-backoff=10s \
  --max-backoff=600s
```

`max-attempts` is Cloud Tasks' own retry, which is separate from CrepeLite's
delivery retries. Both are safe because the engine is idempotent.

Scheduled functions (the daily queue sweep and reconciliation) register their
Cloud Scheduler jobs automatically on deploy. Verify:

```bash
gcloud scheduler jobs list --location=europe-west1
```

## 7. Verify the deployment

```bash
firebase hosting:sites:list --project crepelite-social-hub
```

Then walk the smoke test:

| Check | Expected |
| --- | --- |
| Site opens | App shell renders, no console errors |
| Sign in | Email and Google both work |
| Onboarding | A new account can create a workspace |
| Connections | Provider families listed; unconfigured ones marked so |
| Media | Upload shows progress and appears in the library |
| Composer | Six steps, validation reacts, draft saves |
| Calendar | Loads with the correct timezone |
| Settings | Workspace name and timezone save |
| Install | The browser offers to install the PWA |
| Offline | Reload with the network off still opens the shell |

Watch the logs while testing:

```bash
firebase functions:log --project crepelite-social-hub
```

## Budget alerts

Budgets are a **billing-account** resource, so the Firebase CLI cannot create
them and neither can a project-scoped token. This step is manual:

1. <https://console.cloud.google.com/billing> → your billing account
2. **Budgets & alerts → Create budget**
3. Scope it to the `crepelite-social-hub` project
4. Suggested thresholds: **€5, €10, €20, €30**
5. Alert at 50%, 90% and 100% of each

With `gcloud` authenticated as a billing administrator it can also be done with
`gcloud billing budgets create`, but that permission is rarely granted to a
normal project owner.

## Rollback

```bash
firebase hosting:rollback --project crepelite-social-hub       # previous hosting release
firebase functions:delete <name> --project crepelite-social-hub
```

Firestore rules and indexes are versioned in git — redeploy the previous commit
rather than editing them in the console, or the repository stops matching
reality.

## Cost control

Already built in:

- Cloud Run scales to zero.
- No polling scheduler; Cloud Tasks fires at the exact time.
- Queries are cursor-paginated and bounded.
- Large media never passes through a Function.
- Static assets are served with a one-year immutable cache header.

Worth setting explicitly:

```bash
gcloud run services update crepelite-worker \
  --region=europe-west1 --min-instances=0 --max-instances=5
```

A `maxInstances` ceiling on the functions caps the worst case if something
misbehaves.
