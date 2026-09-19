import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import PrimeVue from 'primevue/config';
import { CONNECTION_STATUSES, DELIVERY_STATUSES, POST_STATUSES } from '@shared/index';
import { CONNECTION_STATUS_UI, DELIVERY_STATUS_UI, POST_STATUS_UI } from '@/lib/status';
import DeliveryStatusTag from '@/components/domain/DeliveryStatusTag.vue';
import PostStatusTag from '@/components/domain/PostStatusTag.vue';

const SEVERITIES = ['success', 'info', 'warn', 'danger', 'secondary', 'contrast'];

/**
 * Status is the one thing a user reads at a glance, so every domain status must
 * map to something renderable — and never to colour alone.
 */
describe('status maps', () => {
  it('covers every delivery status', () => {
    for (const s of DELIVERY_STATUSES) {
      const ui = DELIVERY_STATUS_UI[s];
      expect(ui, `missing mapping for ${s}`).toBeDefined();
      expect(ui.label).toBeTruthy();
      expect(ui.icon).toMatch(/^pi /);
      expect(SEVERITIES).toContain(ui.severity);
    }
  });

  it('covers every post status', () => {
    for (const s of POST_STATUSES) {
      const ui = POST_STATUS_UI[s];
      expect(ui, `missing mapping for ${s}`).toBeDefined();
      expect(ui.label).toBeTruthy();
      expect(ui.icon).toMatch(/^pi /);
      expect(SEVERITIES).toContain(ui.severity);
    }
  });

  it('covers every connection status', () => {
    for (const s of CONNECTION_STATUSES) {
      const ui = CONNECTION_STATUS_UI[s];
      expect(ui, `missing mapping for ${s}`).toBeDefined();
      expect(ui.label).toBeTruthy();
      expect(ui.icon).toMatch(/^pi /);
      expect(SEVERITIES).toContain(ui.severity);
    }
  });

  it('uses danger only for states that need a human', () => {
    expect(DELIVERY_STATUS_UI.failed.severity).toBe('danger');
    expect(DELIVERY_STATUS_UI.needs_reauth.severity).toBe('danger');
    expect(DELIVERY_STATUS_UI.published.severity).toBe('success');
  });

  it('gives each delivery status a distinct label', () => {
    const labels = DELIVERY_STATUSES.map((s) => DELIVERY_STATUS_UI[s].label);
    expect(new Set(labels).size).toBe(labels.length);
  });
});

// PrimeVue needs installing for its components to resolve; the theme is not
// exercised here, so it is switched off to keep the mount cheap.
const mountOpts = { global: { plugins: [[PrimeVue, { theme: 'none' }] as [typeof PrimeVue, Record<string, unknown>]] } };

describe('status tags', () => {
  it('renders a text label, not just a colour', () => {
    for (const s of DELIVERY_STATUSES) {
      const w = mount(DeliveryStatusTag, { props: { status: s }, ...mountOpts });
      expect(w.text()).toContain(DELIVERY_STATUS_UI[s].label);
      w.unmount();
    }
  });

  it('keeps an accessible label even in compact mode', () => {
    const w = mount(DeliveryStatusTag, { props: { status: 'failed', compact: true }, ...mountOpts });
    // Compact hides the text, so the meaning has to survive in the ARIA label.
    expect(w.attributes('aria-label')).toContain('Failed');
    expect(w.text()).not.toContain('Failed');
  });

  it('renders every post status', () => {
    for (const s of POST_STATUSES) {
      const w = mount(PostStatusTag, { props: { status: s }, ...mountOpts });
      expect(w.text()).toContain(POST_STATUS_UI[s].label);
      expect(w.attributes('aria-label')).toContain(POST_STATUS_UI[s].label);
      w.unmount();
    }
  });
});
