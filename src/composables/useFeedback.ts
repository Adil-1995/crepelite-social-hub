import { useToast } from 'primevue/usetoast';
import { useConfirm } from 'primevue/useconfirm';
import { apiError } from '@/services/api';

/**
 * Domain wrapper over PrimeVue's ToastService and ConfirmationService.
 *
 * Every transient message and every destructive confirmation in the app goes
 * through here, so severity, timing and wording stay consistent. Never call
 * `window.alert` / `window.confirm`, and never build another toast component.
 */
export function useFeedback() {
  const toast = useToast();
  const confirm = useConfirm();

  const success = (summary: string, detail?: string) => toast.add({ severity: 'success', summary, detail, life: 4000 });
  const info = (summary: string, detail?: string) => toast.add({ severity: 'info', summary, detail, life: 4000 });
  const warn = (summary: string, detail?: string) => toast.add({ severity: 'warn', summary, detail, life: 6000 });

  /** Errors are sticky when offline, so the user can read them after reconnecting. */
  const error = (summary: string, detail?: string) => toast.add({ severity: 'error', summary, detail, life: 8000 });

  /** Normalises a callable error and shows it. Returns the parsed info for inline Messages. */
  function reportApiError(e: unknown, summary = 'Something went wrong') {
    const info = apiError(e);
    toast.add({
      severity: info.offline ? 'warn' : 'error',
      summary: info.offline ? 'You are offline' : summary,
      detail: info.message,
      life: info.offline ? 6000 : 8000,
    });
    return info;
  }

  /** Destructive confirmation (cancel a scheduled post, disconnect an account, delete media…). */
  function confirmDestructive(opts: {
    message: string;
    header: string;
    acceptLabel?: string;
    rejectLabel?: string;
    icon?: string;
  }): Promise<boolean> {
    return new Promise((resolve) => {
      confirm.require({
        message: opts.message,
        header: opts.header,
        icon: opts.icon ?? 'pi pi-exclamation-triangle',
        acceptLabel: opts.acceptLabel ?? 'Confirm',
        rejectLabel: opts.rejectLabel ?? 'Cancel',
        acceptProps: { severity: 'danger' },
        rejectProps: { severity: 'secondary', outlined: true },
        accept: () => resolve(true),
        reject: () => resolve(false),
        onHide: () => resolve(false),
      });
    });
  }

  return { success, info, warn, error, reportApiError, confirmDestructive, toast, confirm };
}
