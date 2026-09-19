# CrepeLite Social Hub — UI architecture

> **PrimeVue is the official UI component library of this project.**
> Do not rebuild functionality PrimeVue already provides.

## The hierarchy

```
PrimeVue v4  (components, a11y, overlays, focus management)
      ↓
CrepeLite theme/config  (src/theme/*)
      ↓
Domain wrappers  (src/components/domain/*)
      ↓
Features  (src/features/*)
```

Tailwind CSS v4 stays, but its job is layout, responsive composition, spacing,
positioning and CrepeLite-specific branding — **not** building UI primitives.
There is one design system, not two.

## The rule before writing any component

1. Check whether PrimeVue provides it.
2. If it does, use PrimeVue.
3. Only implement it yourself if PrimeVue genuinely cannot satisfy the requirement.
4. If you do, document why in the component's header comment.

Generic primitives (`CustomButton.vue`, `CustomInput.vue`, `CustomModal.vue`,
`CustomSelect.vue`, …) must not exist. Custom components represent **business
concepts** and use PrimeVue internally:

| Valid custom component | Built from |
| --- | --- |
| `PostCard.vue` | Card, Tag, Menu, Button |
| `PostPreview.vue` | Card, Image, Tabs |
| `MediaAssetCard.vue` | Card, Image, ProgressBar, Tag, Button |
| `SocialNetworkSelector.vue` | ToggleButton / MultiSelect / Checkbox |
| `DeliveryStatusTag.vue` | Tag |
| `ConnectionCard.vue` | Card, Tag, Menu, Button, Dialog |
| `EditorialCalendar.vue` | Button, Menu, Popover, Dialog, Tag |

## Mapping

| Need | Use |
| --- | --- |
| Button / split / speed dial | `Button`, `SplitButton`, `SpeedDial` |
| Text, password, number, textarea | `InputText`, `Password`, `InputNumber`, `Textarea` |
| Single / multi choice | `Select`, `MultiSelect`, `AutoComplete`, `TreeSelect` |
| Checkbox / radio / switch | `Checkbox`, `RadioButton`, `ToggleSwitch` |
| Dates & times | `DatePicker` |
| Overlays | `Dialog`, `Drawer`, `Popover`, `ConfirmDialog` |
| Menus | `Menu`, `ContextMenu`, `Breadcrumb` |
| Navigation & flow | `Tabs`, `Stepper`, `Accordion` |
| Tables & paging | `DataTable`, `Paginator` |
| Feedback | `Toast` (transient), `Message` (persistent inline) |
| Loading | `Skeleton`, `ProgressBar`, `ProgressSpinner` |
| Status | `Tag`, `Badge` |
| Media | `Image`, `Carousel`, `FileUpload` (see below) |
| Misc | `Tooltip` (directive), `Timeline`, `Tree`, `Rating`, `ColorPicker` |

## Theme

All theming lives in `src/theme/`:

- `tokens.ts` — brand ramps, surfaces, radii, touch-target size. Mirrored by the
  `@theme` block in `src/styles/main.css`; change both together.
- `crepelite-theme.ts` — `definePreset(Aura, …)`: semantic tokens, light/dark
  colour schemes, component defaults, focus ring.
- `primevue.ts` — `installPrimeVue(app)`: the plugin plus `ToastService`,
  `ConfirmationService`, `DialogService`, `v-tooltip` and `v-focustrap`.

Scattered per-page PrimeVue overrides are not allowed. If a component needs a
different look everywhere, change the preset. If it needs it in one place, use
Tailwind classes on the component or its `pt` prop — never `:deep()` restyling
of PrimeVue internals.

**CSS layer order** is `theme, base, primevue` (set in `themeOptions`), so
Tailwind utilities always win over PrimeVue component styles. Dark mode is
class-driven (`.dark` on `<html>`), applied by `useUiStore().initTheme()` and
pre-applied by the inline script in `index.html` to avoid a flash.

## Feedback, confirmation, dialogs

Use `useFeedback()` (`src/composables/useFeedback.ts`):

```ts
const { success, error, reportApiError, confirmDestructive } = useFeedback();

success('Post scheduled');
reportApiError(e, 'Could not schedule');
if (await confirmDestructive({ header: 'Disconnect Instagram?', message: '…' })) { … }
```

- Never `alert()`, `confirm()` or `prompt()` in application UI.
- Never build another toast/notification component — `Toast`, `ConfirmDialog`
  and `DynamicDialog` are mounted once in `App.vue`.
- Avoid bare `Loading…` text; use `Skeleton` / `ProgressSpinner` (with an
  accessible label where a screen reader needs one).

## Mobile-first

PrimeVue adoption must not turn this into a desktop admin panel. The app is a
mobile-first, touch-friendly PWA.

- Verify layouts at **375px, 390px and 430px** before tablet and desktop.
- Touch targets stay ≥44px (enforced for coarse pointers in `main.css`).
- Do not force desktop `DataTable` layouts on phones — switch to card/list
  presentations at small breakpoints. `DataTable` is for administrative lists
  (posts, deliveries, import jobs, bulk jobs, audit logs, team members).
- Prefer `Drawer`, `Dialog`, `Popover`, `Menu`, `Tabs`, `Stepper` and, where
  useful, `SpeedDial` for mobile interactions.

## Accessibility

Lean on PrimeVue's built-in keyboard navigation, focus management, ARIA, dialog
focus trapping and accessible labelling rather than reimplementing them.

## Icons

PrimeIcons (`pi pi-*`) is the default icon set. Social network brand marks may
come from a lightweight brand-icon source, since PrimeIcons does not cover them.
Do not add a second generic icon library.

## Imports & bundle

PrimeVue components auto-import via `unplugin-vue-components` +
`@primevue/auto-import-resolver` (configured in `vite.config.ts`, types emitted
to `src/components.d.ts`). Only components actually used are bundled — "use
PrimeVue everywhere" means *use it whenever its functionality is required*, not
*ship all 80+ components*.

## Providers in the UI

Never hardcode the five networks into a screen. `SocialNetworkSelector.vue`
and every platform-aware UI read from the shared provider
catalog/manifests (`shared/src/providers/*`) so new providers appear
automatically.

## Media uploads

Firebase resumable uploads (progress, pause, cancel, retry) are implemented
directly against the Firebase SDK — PrimeVue `FileUpload`'s own uploader is not
used where it would compromise that reliability. The surrounding UI still uses
PrimeVue (`Button`, `ProgressBar`, `Message`, `Image`, `Tag`, `Dialog`).
Functionality wins over component purity.
