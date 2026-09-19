# CrepeLite Social Hub

Multi-network social publishing PWA. npm workspaces monorepo: web app at the
root, plus `shared/`, `functions/` (Firebase) and `worker/`.

## UI: PrimeVue is mandatory

**PrimeVue v4 is the official UI component library.** Full rules in
[`docs/ui-architecture.md`](docs/ui-architecture.md) — read it before writing
any UI.

Before creating **any** generic UI component:

1. Check whether PrimeVue provides it.
2. Use PrimeVue if it does.
3. Only write a custom implementation if PrimeVue cannot satisfy the
   requirement — and document why in the file.

- Never rebuild toasts, confirmation modals, dropdown engines, date pickers,
  overlay positioning, focus trapping or accessible dialogs. Use PrimeVue.
- Never `alert()` / `confirm()` / `prompt()` in application UI.
- Custom components represent **business** concepts (`PostCard.vue`,
  `DeliveryStatusTag.vue`, `SocialNetworkSelector.vue`) and use PrimeVue
  internally. No `src/components/ui/` of generic primitives.
- Tailwind v4 is for layout, responsive composition, spacing and CrepeLite
  branding — not for building primitives. One design system, not two.
- All theming goes in `src/theme/*`. No scattered PrimeVue overrides.
- Feedback and confirmation go through `useFeedback()`.
- Icons: PrimeIcons (`pi pi-*`); brand marks may use a lightweight brand set.

## Non-negotiables

- **Mobile-first PWA.** Verify at 375 / 390 / 430px before tablet and desktop;
  touch targets ≥44px. Do not force desktop tables onto phones.
- **Provider architecture.** UI reads platforms from the shared provider
  catalog/manifests (`shared/src/providers/*`). Never hardcode the five
  networks into a screen.
- **Firebase architecture.** No social-network token, secret or provider
  credential ever reaches the client. Callables re-validate every payload with
  the shared zod schemas.
- **Resumable media uploads.** Firebase resumable upload reliability wins over
  using PrimeVue `FileUpload`'s own uploader.

## Commands

```
npm run dev          # Vite dev server (port 5173)
npm run emulators    # Firebase emulators (needs JDK 21+)
npm run typecheck    # vue-tsc + tsc across all projects
npm run lint
npm test             # vitest: shared, functions, web
npm run test:emulator# rules + integration tests
npm run build        # web + functions + worker
```

## Status

See [`docs/TODO.md`](docs/TODO.md) — note the accuracy banner at the top: the
backend matches the plan, the web app is still being built.
