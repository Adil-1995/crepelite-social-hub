# CrepeLite Social Hub

A mobile-first PWA for planning, scheduling and publishing social content to
Facebook Pages, Instagram, TikTok, Pinterest and YouTube from one place.

Write a post once, let each network adapt it, schedule it months ahead, and see
exactly what happened on every destination — including when only some of them
succeeded.

---

## What it does

- **One post, many networks.** A master content block plus one variant per
  destination. Variants follow the master until you customise them.
- **Independent delivery.** Each destination is its own delivery with its own
  status. One network failing never blocks the others, and retrying a failed
  one never republishes the ones that worked.
- **Scheduling that survives.** Cloud Tasks per delivery, a two-layer queue for
  dates beyond the 30-day task horizon, and idempotency that holds even when a
  task is delivered twice.
- **Bulk planning.** Spread dozens of posts over a date range with chosen
  weekdays, times and per-network offsets, previewed before anything is created.
- **Import and crosspost.** Read your own posts back through official APIs and
  turn them into drafts elsewhere. Nothing is scraped.
- **Offline-capable.** Installable PWA with an offline app shell and drafts that
  survive losing connection.

## Architecture in one picture

```
PWA (Vue 3 + PrimeVue)
  ├─ Firebase Auth            sign-in
  ├─ Firestore                realtime reads (writes are refused by rules)
  ├─ Cloud Storage            media originals, uploaded directly
  └─ Cloud Functions v2       every write, via typed callables
        ├─ Cloud Tasks        one task per delivery
        ├─ Cloud Scheduler    daily queue sweep + reconciliation
        ├─ Secret Manager     provider credentials
        ├─ Provider Registry  facebook · instagram · tiktok · pinterest · youtube
        └─ Cloud Run worker   large video uploads (streamed, never buffered)
```

Full detail, including the publishing and idempotency flows, is in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Repository layout

```
├── src/              Web app (Vue 3, PrimeVue, Tailwind v4)
│   ├── app/          Firebase bootstrap, PWA lifecycle
│   ├── components/   domain/ (business components) + layout/
│   ├── composables/  Firestore binding, composer, uploads, feedback
│   ├── features/     One folder per route
│   ├── lib/          Formatting, status maps, timezones
│   ├── stores/       Pinia: auth, workspace, providers, ui
│   └── theme/        The single PrimeVue theme
├── shared/           Domain model, provider manifests, scheduling maths, zod schemas
├── functions/        Cloud Functions v2: callables, providers, scheduler, webhooks
├── worker/           Cloud Run worker for large media
├── tests/            shared · functions · web · rules · integration
└── docs/             Architecture, database, deployment, per-provider notes
```

`shared/` is the contract. The PWA and the backend both import it, so
validation cannot drift between them.

## Requirements

| | |
| --- | --- |
| Node | 22 or newer |
| npm | 10 or newer |
| Java | **JDK 21+ — required by the Firestore and Storage emulators** |
| Firebase CLI | 15 or newer |

## Getting started

```bash
npm install
cp .env.example .env     # fill in the Firebase web config
npm run dev              # Vite dev server on :5173
```

By default `.env` points at the emulators. To run them:

```bash
npm run emulators        # Auth, Firestore, Functions, Storage, Tasks, UI on :4000
```

Seed a workspace with demo data (emulator only, never production):

```bash
npm run seed
```

That creates a workspace with mock connections, media, drafts, scheduled posts,
a published post and a failed delivery — enough to exercise every screen
without any provider credentials.

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Vite dev server |
| `npm run emulators` | Firebase Emulator Suite (needs a JDK) |
| `npm run seed` | Seed demo data into the emulator |
| `npm run typecheck` | `vue-tsc` + `tsc` across every project |
| `npm run lint` / `lint:fix` | ESLint |
| `npm test` | Unit tests: shared, functions, web |
| `npm run test:emulator` | Rules and integration tests (needs a JDK) |
| `npm run test:all` | Both of the above |
| `npm run build` | Build web, functions and worker |
| `npm run deploy:staging` | Deploy to the staging alias |
| `npm run deploy:production` | Deploy to production (asks for confirmation) |

## UI conventions

**PrimeVue v4 is the official component library.** Never rebuild something
PrimeVue already provides — buttons, inputs, dialogs, toasts, confirmations,
date pickers, tables, overlays and focus management all come from it. Tailwind
handles layout, spacing, responsive composition and CrepeLite branding. Custom
components represent business concepts, not generic widgets.

The rules, the theme structure and the mapping from need to component are in
[`docs/ui-architecture.md`](docs/ui-architecture.md). They are binding —
read them before writing UI.

## Providers

| Provider | API | Status |
| --- | --- | --- |
| [Facebook](docs/providers/facebook.md) | Graph v26.0 | Implemented — App Review needed |
| [Instagram](docs/providers/instagram.md) | Graph v26.0 | Implemented — App Review needed |
| [TikTok](docs/providers/tiktok.md) | Content Posting v2 | Implemented — audit needed (posts stay private until then) |
| [Pinterest](docs/providers/pinterest.md) | API v5 | Implemented — credentials needed |
| [YouTube](docs/providers/youtube.md) | Data API v3 | Implemented — OAuth verification needed |
| Mock | — | Works now, development only |

Everything a human has to do in a provider console is collected in
[`docs/provider-approval-checklist.md`](docs/provider-approval-checklist.md).

Adding a sixth network is a manifest plus a provider implementation and nothing
else: see [`docs/adding-provider.md`](docs/adding-provider.md).

## Security

- No social-network token, secret or provider credential ever reaches the
  client. Tokens live encrypted in a server-only collection; secrets live in
  Secret Manager.
- Firestore rules make the client **read-only**. Every write goes through a
  callable that re-validates the payload with the shared zod schema and checks
  the caller's role.
- Storage objects are immutable and cannot be deleted by a client.
- OAuth uses `state`, a server-side nonce, PKCE where the provider supports it,
  and short-lived single-use state records.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md#security) and the rules tests
in `tests/rules/`.

## Deployment

[`docs/deployment.md`](docs/deployment.md) covers project setup, billing,
required Google Cloud APIs, secrets, Cloud Tasks and Scheduler, the deploy
order and post-deploy verification.

## Status

[`docs/TODO.md`](docs/TODO.md) tracks what is built, what is waiting on external
approval and what is not started. It uses `[x]` only for functionality that
exists and was tested.
