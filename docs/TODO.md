# CrepeLite Social Hub — Technical TODO

Status legend:
`[x]` built **and** tested · `[~]` code exists, live verification blocked by an
external credential or approval · `[ ]` not done

> **UI rule:** PrimeVue v4 is the official component library — see
> [`ui-architecture.md`](./ui-architecture.md). Never rebuild a generic UI
> primitive PrimeVue already provides.

Last verified: 2026-09-19 — `typecheck`, `lint`, `test` (148 unit tests) and
`build` (web + functions + worker) all pass.

---

## Phase 0 — Repository

- [x] npm workspaces monorepo: web app at the root, `shared/`, `functions/`, `worker/`
- [x] TypeScript 6.0.x (TS 7 native is not yet supported by typescript-eslint)
- [x] `.gitignore`, `.gitattributes`, initial commit
- [x] `eslint.config.js` (flat config)
- [x] `vitest.config.ts` with five projects
- [x] GitHub remote: https://github.com/Adil-1995/crepelite-social-hub

## Phase 1 — Core foundation

- [x] Vue 3 + Vite + TS + Pinia + Vue Router + Tailwind v4, PWA via vite-plugin-pwa
- [x] Firebase Web SDK (Auth, Firestore with offline cache, Storage, Functions, Messaging)
- [x] Workspaces, members, roles (OWNER/ADMIN/EDITOR/VIEWER), invitations
- [x] Mobile bottom navigation with centred Create → desktop sidebar
- [x] Firestore and Storage rules
- [~] Rules tests written (`tests/rules/`) — **cannot run: the emulators need a JDK**

## Phase 1.1 — PrimeVue

- [x] PrimeVue 4.5.5, `@primeuix/themes` 2, PrimeIcons 7, `tailwindcss-primeui`
- [x] Centralised theme (`src/theme/tokens.ts`, `crepelite-theme.ts`, `primevue.ts`)
- [x] Cascade layer order `properties, theme, base, components, primevue, utilities`
      so Tailwind utilities win over PrimeVue component styles
- [x] Class-driven dark mode shared by PrimeVue and Tailwind, with anti-FOUC script
- [x] Global ToastService, ConfirmationService, DialogService, tooltip, focus trap
- [x] `useFeedback()` as the single entry point for toasts, API errors and confirmations
- [x] Auto-import with tree-shaking; no forced PrimeVue chunk
- [x] Every screen built on PrimeVue; no custom generic primitives exist

## Phase 2 — Content system

- [x] Master post + per-platform variants (master/custom sync)
- [x] Media library: resumable uploads, progress, cancel, in-use protection
- [x] Composer stepper: Media → Content → Platforms → Customise → Schedule → Review
- [x] Offline drafts in IndexedDB, restored on reopen
- [x] Shared validation drives the composer, so client and server cannot disagree

## Phase 3 — Scheduler

- [x] Deliveries, state machine, aggregated post status
- [x] Cloud Tasks dispatcher, 30-day two-layer strategy
- [x] schedule / reschedule / cancel / publish now / retry
- [x] Idempotency: scheduleVersion + transaction + lease + checkpoints
- [x] Reconciliation and processing status checks
- [x] MockProvider (development only)
- [~] End-to-end idempotency tests — **written against the emulator, blocked on the JDK**

## Phase 4–7 — Providers

All five are implemented against their current official APIs. None can be
verified live without credentials and approval — see
[`provider-approval-checklist.md`](./provider-approval-checklist.md).

- [~] Facebook Pages — App Review needed
- [~] Instagram — App Review needed
- [~] TikTok — Content Posting audit needed (posts stay private until it passes)
- [~] Pinterest — credentials needed
- [~] YouTube — OAuth verification needed

## Phase 8 — Bulk planner

- [x] Planner algorithm (dates, frequency, weekdays, times, distribution, offsets)
- [x] Seeded preview the server reproduces exactly
- [x] Preview → confirm → server-side creation

## Phase 9 — Import / crosspost

- [x] Import through provider `listPosts` (official APIs only, never scraping)
- [x] "Upload original manually" flag where the API forbids media retrieval

## Phase 10 — PWA

- [x] Offline app shell, offline drafts
- [x] Install affordance, standalone detection, update prompt
- [x] Icons, manifest, theme colour, safe areas
- [~] Push notifications (FCM) — code and preferences UI done; **needs a VAPID key**
- [x] Live accessibility and layout audit across 8 screens: zero unlabelled
      inputs, zero unnamed buttons, zero horizontal overflow, one h1 per page
- [ ] Verified by eye on a real handset (the extension cannot resize the
      viewport, so the breakpoints themselves are unproven)

## Phase 11 — Screens

- [x] Sign in / sign up / password reset, Google sign-in
- [x] Onboarding (workspace creation)
- [x] Dashboard, Calendar (month/week/agenda), Posts, Post detail
- [x] Composer, Bulk planner, Import, Media
- [x] Connections, Connection detail
- [x] Notifications, Activity log, Settings, Team, More
- [x] Every screen has loading, empty and error states

## Phase 12 — Tests

- [x] 148 unit tests across shared, functions and web
- [x] State machine, bulk planner, roles, queue window, provider catalog,
      validation, error classification, registry, formatting, status maps
- [~] Firestore rules tests — written, **blocked on the JDK**
- [~] Storage rules tests — written, **blocked on the JDK**
- [~] Integration tests written and typechecked, **blocked on the JDK**:
      duplicate task delivery, concurrent execution, stale scheduleVersion,
      cancelled delivery, partial publication, retrying one destination without
      republishing the others, error classification, async checkpointing,
      and the 30-posts-across-October bulk scenario
- [x] Tests are now inside a tsconfig (`tsconfig.tests.json`) and typechecked
      by `npm run typecheck` — they were outside every project before, which
      had already let three type errors through in the shared suite

## Phase 13 — Documentation

- [x] `README.md`
- [x] `ARCHITECTURE.md` with Mermaid diagrams
- [x] `DATABASE.md` — every collection, field, index and id strategy
- [x] `deployment.md`
- [x] `provider-approval-checklist.md`
- [x] `providers/*.md` for all five networks
- [x] `adding-provider.md`
- [x] `ui-architecture.md`

## Phase 14 — Infrastructure

Project: **`crepelite-social-hub`** (733722881127).
Live at **https://crepelite-social-hub.web.app**.

- [x] Firebase project configured; `.firebaserc` aliases set
- [x] Web app registered; `.env` and `.env.production` wired to it
- [x] Firestore database created in **europe-west1**, same region as the
      functions and the task queue
- [x] Firestore rules deployed
- [x] Storage rules written (deploy blocked: Storage needs Blaze)
- [x] 15 composite indexes deployed and confirmed live
- [x] Hosting deployed; PWA manifest, service worker, icons and security
      headers all verified over HTTPS
- [x] `functions/.env.crepelite-social-hub` (public config only)
- [x] Emulator configuration, seed script guarded against real projects
- [x] **Blaze billing enabled**
- [x] Firestore TTL policy on `oauthStates.expiresAt`
- [x] Six secrets in Secret Manager (provider secrets hold the `unset`
      placeholder the code understands; the two application keys are real
      32-byte random values)
- [x] **43 Cloud Functions deployed** to europe-west1 — exactly the 43 the
      source exports
- [x] 4 scheduled functions live: `queueUpcomingDeliveries`,
      `reconcileDeliveries`, `connectionHealth`, `cleanupOAuthStates`
- [x] Artifact Registry cleanup policy (3 days) so container images do not
      accumulate a monthly bill
- [x] Hosting rewrites verified end to end: `/api/oauth/callback` → 302,
      `/webhooks/tiktok` → 403 (unsigned request rejected), `/media-pull` → 403
- [x] Callables reject unauthenticated calls (401), SPA deep links serve the
      shell, PWA assets served
- [x] Email/password sign-in confirmed working against the live project
      (test account created and deleted)
- [x] Firebase Storage bucket created and `storage.rules` deployed;
      unauthenticated reads confirmed denied (403)
- [ ] Google sign-in provider — console toggle; both hosting domains are
      already authorised
- [ ] Budget alerts — billing-account permission, not available from the CLI

---

## Blocked on a human

These are the only things stopping the rest. Each needs an account, a payment
method, an approval or an elevated install that cannot be automated.

| # | Blocker | Unblocks |
| --- | --- | --- |
| 1 | Install a JDK 21+ (needs UAC elevation) | Emulators, rules tests, integration tests, seeding |
| 2 | **Enable Blaze billing on `crepelite-social-hub`** | Functions, Tasks, Scheduler, Cloud Run, Storage, Secret Manager, the TTL policy — in short, everything server-side |
| 3 | Enable Google in Authentication (console) — email/password already works | Google sign-in |
| 4 | Install `gcloud` (optional) | Queue pre-creation, budget alerts |
| 5 | Meta App Review | Live Facebook and Instagram publishing |
| 6 | TikTok Content Posting audit | Public TikTok posts |
| 7 | Pinterest standard access | Live Pinterest publishing |
| 8 | Google OAuth verification | YouTube beyond 100 test users |
| 9 | FCM VAPID key | Push notifications |

Everything not in that table is either done or genuinely not started, and is
marked accordingly above.
