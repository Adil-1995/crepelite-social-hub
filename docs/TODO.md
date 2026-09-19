# CrepeLite Social Hub — Technical TODO

Status legend: `[x]` done · `[~]` implemented, needs external credentials/approval to verify live · `[ ]` pending

> **UI rule:** PrimeVue v4 is the official component library — see
> [`docs/ui-architecture.md`](./ui-architecture.md). Never rebuild a generic UI
> primitive that PrimeVue already provides.

> **Accuracy note (2026-09-19):** the phase marks below describe the *plan*.
> `shared/`, `functions/` and `worker/` match it. The **web app does not yet**:
> `src/` currently holds the bootstrap only (firebase, stores, router, api
> service, theme, `main.ts`, `App.vue`, a minimal `sw.ts`). No
> `src/features/**` views, no `src/components/**`, and no test files exist yet.
> Treat every UI-facing `[x]` in phases 1–10 as *designed, not built*.
> `npm run build:web` therefore fails on the 20 views the router imports.

## Phase 0 — Repository inspection
- [x] Repository was empty (no previous code, no git). Initialised a new git repo.
- [x] Toolchain: Node 24, npm 11, firebase-tools 15. Java is required by the Firestore/Storage emulators (JDK 21+).
- [x] Stack decision: npm workspaces monorepo — web app at the root, `shared/`, `functions/`, `worker/`.
- [x] TypeScript pinned to 6.0.x (TS 7 native is not yet supported by typescript-eslint).

## Phase 1 — Core foundation
- [x] Vue 3 + Vite + TS + Pinia + Vue Router + Tailwind v4, PWA via vite-plugin-pwa
- [x] Firebase Web SDK (Auth email/password + Google, Firestore with offline cache, Storage, Functions, Messaging)
- [x] Workspaces + members + roles (OWNER/ADMIN/EDITOR/VIEWER), invitations
- [x] Mobile layout (bottom nav with centred Create, safe areas) → desktop sidebar
- [~] Design system → **superseded by PrimeVue** (see Phase 1.1). No custom generic primitives were ever written, so there is nothing to migrate away from.
- [x] Firestore + Storage rules and rules tests

## Phase 1.1 — PrimeVue adoption

Groundwork (done — the library is installed, themed and wired):

- [x] Install PrimeVue v4 (`primevue@4.5.5`, latest 4.x) + `@primeuix/themes@2`.
- [x] Install PrimeIcons (`primeicons@7`).
- [x] Install/configure the official Tailwind v4 integration (`tailwindcss-primeui` via `@plugin`, CSS layer order `theme, base, primevue`).
- [x] Centralized CrepeLite theme: `src/theme/tokens.ts`, `src/theme/crepelite-theme.ts`, `src/theme/primevue.ts`.
- [x] Class-driven dark mode (`.dark`) shared by PrimeVue `darkModeSelector` and Tailwind `dark:`, with an anti-FOUC script in `index.html`.
- [x] Global ToastService, ConfirmationService, DialogService; `v-tooltip` and `v-focustrap` directives.
- [x] Service outlets mounted once in `App.vue` (`Toast`, `ConfirmDialog`, `DynamicDialog`).
- [x] `useFeedback()` composable — the single entry point for toasts, API error reporting and destructive confirmations.
- [x] Removed the hand-rolled toast/confirm engine from `src/stores/ui.ts` (it duplicated PrimeVue; nothing consumed it yet).
- [x] Auto-import with tree-shaking (`unplugin-vue-components` + `@primevue/auto-import-resolver`, types in `src/components.d.ts`); `primevue` build chunk.
- [x] Audit existing design-system components — result: none existed, so there is nothing to replace or delete.

Application work (pending — these land as each feature is built):

- [ ] Forms on PrimeVue: login, composer, bulk planner, connections, settings.
- [ ] Dialogs/confirmations on `Dialog` / `ConfirmDialog` everywhere (no `alert`/`confirm`/`prompt`).
- [ ] Notifications on `Toast` (transient) and `Message` (persistent inline).
- [ ] `DeliveryStatusTag.vue` — domain states → `Tag` severity/icon, used globally.
- [ ] `SocialNetworkSelector.vue` — driven by the provider catalog, never hardcoded platforms.
- [ ] Administrative lists on `DataTable` (posts, deliveries, import jobs, bulk jobs, audit logs, team members) with responsive card/list fallbacks on phones.
- [ ] Composer on `Stepper`/`Tabs` (Media → Content → Platforms → Customize → Schedule → Review).
- [ ] Bulk planner on `DatePicker`/`Select`/`MultiSelect`/`InputNumber`/`DataTable`; calendar preview stays a domain component with PrimeVue controls.
- [ ] Connections UI on `Card`/`Tag`/`Menu`/`Dialog`.
- [ ] Media UX: Firebase resumable uploads kept, wrapped in PrimeVue `Button`/`ProgressBar`/`Message`/`Image`.
- [ ] Loading states on `Skeleton`/`ProgressBar`/`ProgressSpinner`.
- [ ] Validate mobile responsiveness at 375 / 390 / 430px, then tablet and desktop.
- [ ] Validate accessibility (keyboard, focus trapping, ARIA, labels).
- [ ] Run lint, typecheck, tests and a production build.

Verified so far: `npm run typecheck` passes across every project, `npm run lint`
passes (0 errors), and an isolated build confirms the Tailwind↔PrimeVue
integration — `tailwindcss-primeui` utilities resolve to PrimeVue tokens and the
cascade layer order is `properties, theme, base, components, primevue,
utilities`, so Tailwind utilities override PrimeVue component styles.
A full `npm run build:web` still fails on the missing feature views.

Picked up along the way (needed to run the checks above):

- [x] `eslint.config.js` — flat config was missing entirely, so `npm run lint` could not run.
- [x] `src/sw.ts` — minimal dependency-free app-shell precache; the PWA build had no entry. Runtime caching strategies remain Phase 10 work.

Mark this phase `[x]` only when the application work above is actually done.

## Phase 2 — Content system
- [x] Master post + per-platform variants (linked/custom sync)
- [x] Media library (resumable uploads, progress, cancel, usage tracking)
- [x] Composer stepper (Media → Content → Platforms → Customize → Schedule → Review)
- [x] Drafts (server + offline local drafts)

## Phase 3 — Scheduler
- [x] Deliveries, state machine, aggregated post status
- [x] Cloud Tasks dispatcher (per-delivery named tasks), 30-day two-layer strategy
- [x] schedule / reschedule / cancel / publish now / retry
- [x] Idempotent execution (transaction + scheduleVersion + lease)
- [x] Reconciliation + processing status checks
- [x] MockProvider (dev/test only)

## Phase 4–7 — Providers
- [~] Facebook Pages, Instagram (Meta Graph API)
- [~] TikTok Content Posting API
- [~] Pinterest API v5
- [~] YouTube Data API v3

## Phase 8 — Bulk planner
- [x] Planner algorithm (dates, frequency, weekdays, times, distribution, per-platform offsets)
- [x] Preview calendar → confirm → server-side creation

## Phase 9 — Import / crosspost
- [x] Import jobs through provider `listPosts` (official APIs only)
- [x] Media copy when permitted; "upload original manually" flag otherwise

## Phase 10 — PWA polish
- [x] Offline app shell + offline drafts
- [x] Push notifications (FCM) with preferences
- [x] Install UX

## Open items that need external input
See `docs/provider-approval-checklist.md` and `docs/deployment.md`.
