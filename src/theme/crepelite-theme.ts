import { definePreset } from '@primeuix/themes';
import Aura from '@primeuix/themes/aura';
import { brand, radius, surfaceDark, surfaceLight } from '@/theme/tokens';

/**
 * The CrepeLite PrimeVue preset.
 *
 * CrepeLite branding is layered on top of Aura through design tokens — we never
 * fork or restyle PrimeVue components. Anything visual that applies to a whole
 * component belongs here; per-page `:deep()` overrides do not.
 */
export const CrepeLitePreset = definePreset(Aura, {
  primitive: {
    borderRadius: radius,
    brand,
  },
  semantic: {
    primary: brand,
    // Warm, slightly rounded surfaces to match the CrepeLite card language.
    borderRadius: {
      none: radius.none,
      xs: radius.xs,
      sm: radius.sm,
      md: radius.md,
      lg: radius.lg,
      xl: radius.xl,
    },
    focusRing: {
      width: '2px',
      style: 'solid',
      color: '{primary.500}',
      offset: '2px',
      shadow: 'none',
    },
    // Mobile-first sizing: comfortable targets by default, denser on desktop
    // is opt-in per component via `size="small"`.
    formField: {
      paddingX: '0.875rem',
      paddingY: '0.7rem',
      borderRadius: '{border.radius.md}',
      focusRing: {
        width: '2px',
        style: 'solid',
        color: '{primary.500}',
        offset: '2px',
        shadow: 'none',
      },
    },
    content: {
      borderRadius: '{border.radius.xl}',
    },
    overlay: {
      select: { borderRadius: '{border.radius.md}' },
      popover: { borderRadius: '{border.radius.lg}', padding: '0.875rem' },
      modal: { borderRadius: '{border.radius.xl}', padding: '1.25rem' },
    },
    colorScheme: {
      light: {
        surface: surfaceLight,
        primary: {
          color: '{brand.600}',
          contrastColor: '#ffffff',
          hoverColor: '{brand.700}',
          activeColor: '{brand.800}',
        },
        highlight: {
          background: '{brand.50}',
          focusBackground: '{brand.100}',
          color: '{brand.800}',
          focusColor: '{brand.900}',
        },
        content: {
          background: '{surface.0}',
          borderColor: '{surface.200}',
        },
        text: {
          color: '{surface.900}',
          mutedColor: '{surface.700}',
        },
        formField: {
          background: '{surface.0}',
          borderColor: '{surface.200}',
          hoverBorderColor: '{brand.300}',
          focusBorderColor: '{brand.500}',
          placeholderColor: '{surface.500}',
        },
      },
      dark: {
        surface: surfaceDark,
        primary: {
          color: '{brand.300}',
          contrastColor: '{surface.900}',
          hoverColor: '{brand.200}',
          activeColor: '{brand.100}',
        },
        highlight: {
          background: 'color-mix(in srgb, {brand.400}, transparent 84%)',
          focusBackground: 'color-mix(in srgb, {brand.400}, transparent 76%)',
          color: '{brand.100}',
          focusColor: '{brand.50}',
        },
        content: {
          background: '{surface.800}',
          borderColor: '{surface.600}',
        },
        text: {
          color: '{surface.50}',
          mutedColor: '{surface.200}',
        },
        formField: {
          background: '{surface.800}',
          borderColor: '{surface.600}',
          hoverBorderColor: '{brand.400}',
          focusBorderColor: '{brand.300}',
          placeholderColor: '{surface.300}',
        },
      },
    },
  },
  components: {
    button: {
      root: {
        // Touch-comfortable by default (see tokens.touchTargetPx).
        paddingY: '0.7rem',
        paddingX: '1.1rem',
        borderRadius: '{border.radius.md}',
        roundedBorderRadius: '2rem',
        iconOnlyWidth: '2.75rem',
        sm: { paddingY: '0.45rem', paddingX: '0.8rem' },
        lg: { paddingY: '0.9rem', paddingX: '1.4rem' },
        label: { fontWeight: '600' },
      },
    },
    card: {
      root: { borderRadius: '{border.radius.xl}' },
      body: { padding: '1.1rem', gap: '0.65rem' },
      caption: { gap: '0.35rem' },
      colorScheme: {
        light: { root: { background: '{surface.0}', color: '{surface.900}' } },
        dark: { root: { background: '{surface.800}', color: '{surface.50}' } },
      },
    },
    dialog: {
      root: { borderRadius: '{border.radius.xl}' },
      header: { padding: '1.15rem 1.25rem 0.5rem' },
      content: { padding: '0 1.25rem 1.25rem' },
      footer: { padding: '0 1.25rem 1.25rem', gap: '0.5rem' },
    },
    drawer: {
      header: { padding: '1.15rem 1.25rem 0.5rem' },
      content: { padding: '0 1.25rem 1.25rem' },
    },
    toast: {
      root: {
        borderRadius: '{border.radius.lg}',
        width: 'min(26rem, calc(100vw - 2rem))',
      },
    },
    tag: {
      root: {
        borderRadius: '{border.radius.sm}',
        fontWeight: '600',
        padding: '0.2rem 0.55rem',
      },
    },
    tabs: {
      tab: { fontWeight: '600' },
    },
    datatable: {
      headerCell: { padding: '0.7rem 0.85rem' },
      bodyCell: { padding: '0.7rem 0.85rem' },
    },
  },
});

/**
 * PrimeVue theme options. `cssLayer` keeps PrimeVue below Tailwind utilities so
 * a `class="p-2"` on a PrimeVue component always wins — this is the officially
 * documented Tailwind v4 integration order.
 */
export const themeOptions = {
  darkModeSelector: '.dark',
  cssLayer: {
    name: 'primevue',
    // Must mirror the @layer statement at the top of src/styles/main.css.
    order: 'properties, theme, base, components, primevue, utilities',
  },
} as const;
