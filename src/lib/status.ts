import type { ConnectionStatus, DeliveryStatus, PostStatus } from '@shared/index';

/**
 * Domain status → PrimeVue Tag severity + PrimeIcon + label.
 *
 * Status is never conveyed by colour alone (accessibility): every tag carries
 * an icon and a text label.
 */
export type Severity = 'success' | 'info' | 'warn' | 'danger' | 'secondary' | 'contrast';

export interface StatusPresentation {
  label: string;
  severity: Severity;
  icon: string;
}

export const DELIVERY_STATUS_UI: Record<DeliveryStatus, StatusPresentation> = {
  draft: { label: 'Draft', severity: 'secondary', icon: 'pi pi-pencil' },
  awaiting_queue: { label: 'Awaiting queue', severity: 'info', icon: 'pi pi-hourglass' },
  queued: { label: 'Scheduled', severity: 'info', icon: 'pi pi-clock' },
  publishing: { label: 'Publishing', severity: 'warn', icon: 'pi pi-spin pi-spinner' },
  processing: { label: 'Processing', severity: 'warn', icon: 'pi pi-spin pi-spinner' },
  published: { label: 'Published', severity: 'success', icon: 'pi pi-check-circle' },
  failed: { label: 'Failed', severity: 'danger', icon: 'pi pi-times-circle' },
  cancelled: { label: 'Cancelled', severity: 'secondary', icon: 'pi pi-ban' },
  needs_reauth: { label: 'Needs reconnect', severity: 'danger', icon: 'pi pi-key' },
};

export const POST_STATUS_UI: Record<PostStatus, StatusPresentation> = {
  draft: { label: 'Draft', severity: 'secondary', icon: 'pi pi-pencil' },
  scheduled: { label: 'Scheduled', severity: 'info', icon: 'pi pi-clock' },
  publishing: { label: 'Publishing', severity: 'warn', icon: 'pi pi-spin pi-spinner' },
  published: { label: 'Published', severity: 'success', icon: 'pi pi-check-circle' },
  partially_published: { label: 'Partially published', severity: 'warn', icon: 'pi pi-exclamation-triangle' },
  failed: { label: 'Failed', severity: 'danger', icon: 'pi pi-times-circle' },
  cancelled: { label: 'Cancelled', severity: 'secondary', icon: 'pi pi-ban' },
};

export const CONNECTION_STATUS_UI: Record<ConnectionStatus, StatusPresentation> = {
  connected: { label: 'Connected', severity: 'success', icon: 'pi pi-check-circle' },
  expired: { label: 'Expired', severity: 'warn', icon: 'pi pi-clock' },
  needs_reauth: { label: 'Needs reconnect', severity: 'danger', icon: 'pi pi-key' },
  revoked: { label: 'Revoked', severity: 'danger', icon: 'pi pi-ban' },
  error: { label: 'Error', severity: 'danger', icon: 'pi pi-times-circle' },
};

/** Statuses that should pull the user's attention on the dashboard. */
export const ATTENTION_DELIVERY_STATUSES: DeliveryStatus[] = ['failed', 'needs_reauth'];
