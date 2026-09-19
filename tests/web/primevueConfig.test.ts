import { describe, expect, it } from 'vitest';
import { createApp, defineComponent, h, nextTick } from 'vue';
import Dialog from 'primevue/dialog';
import { usePrimeVue } from 'primevue/config';
import { installPrimeVue } from '@/theme/primevue';

/**
 * Guards the PrimeVue installation itself.
 *
 * The config object is merged *over* PrimeVue's defaults, so passing an
 * explicit `undefined` for a key replaces the default instead of leaving it
 * alone. That is not obvious, and it shipped once: `locale: undefined` wiped
 * the built-in locale, and every component reading `locale.aria.*` — Dialog,
 * DatePicker, Paginator — threw "Cannot read properties of undefined
 * (reading 'aria')" the moment it opened.
 */
function mountWithPrimeVue(component = defineComponent({ render: () => h('div') })) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const app = createApp(component);
  installPrimeVue(app);
  const instance = app.mount(host);
  return { app, instance, host };
}

describe('PrimeVue installation', () => {
  it('keeps the built-in locale, including the aria strings', () => {
    const probe = defineComponent({
      setup() {
        const pv = usePrimeVue();
        return () => h('div', { 'data-aria': pv.config.locale?.aria ? 'present' : 'missing' });
      },
    });

    const { app, host } = mountWithPrimeVue(probe);
    expect(host.querySelector('div')?.getAttribute('data-aria')).toBe('present');
    app.unmount();
  });

  it('exposes the aria keys the overlay components read', () => {
    const probe = defineComponent({
      setup() {
        const pv = usePrimeVue();
        // Dialog reads aria.close for its header button; a missing key here is
        // exactly what crashed the media picker.
        return () => h('div', { 'data-close': String(pv.config.locale?.aria?.close ?? '') });
      },
    });

    const { app, host } = mountWithPrimeVue(probe);
    expect(host.querySelector('div')?.getAttribute('data-close')).toBeTruthy();
    app.unmount();
  });

  it('opens a Dialog without throwing', async () => {
    const errors: unknown[] = [];
    const probe = defineComponent({
      setup: () => () => h(Dialog, { visible: true, modal: true, header: 'Choose media' }, { default: () => h('p', 'body') }),
    });

    const host = document.createElement('div');
    document.body.appendChild(host);
    const app = createApp(probe);
    app.config.errorHandler = (e) => errors.push(e);
    installPrimeVue(app);
    app.mount(host);
    // Dialog teleports to body, so let the append settle before asserting.
    await nextTick();
    await nextTick();

    expect(errors).toEqual([]);
    expect(document.body.textContent).toContain('Choose media');
    app.unmount();
  });

  it('applies the CrepeLite theme options', () => {
    const probe = defineComponent({
      setup() {
        const pv = usePrimeVue();
        const opts = (pv.config.theme as { options?: Record<string, unknown> } | undefined)?.options;
        return () => h('div', { 'data-dark': String(opts?.darkModeSelector ?? '') });
      },
    });

    const { app, host } = mountWithPrimeVue(probe);
    expect(host.querySelector('div')?.getAttribute('data-dark')).toBe('.dark');
    app.unmount();
  });
});
