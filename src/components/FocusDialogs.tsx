import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { useFocusStore, type FocusDialog } from '@/stores/focusStore';
import { maaService } from '@/services/maaService';
import * as wsService from '@/services/wsService';
import { resolveFocusContent } from '@/utils/useMaaCallbackLogger';
import { loggers } from '@/utils/logger';
import { ModalPortal, useModalFocusTrap } from './ui/Modal';
import type { FocusTemplate } from '@/types/interface';

function FocusDialogView({ dialog }: { dialog: FocusDialog }) {
  const { t } = useTranslation();
  const titleId = useId();
  const ref = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (dialog.blocking) await maaService.acknowledgeFocus(dialog.id);
      useFocusStore.getState().close(dialog.id);
    } catch {
      toast.error(t('focus.confirmFailed'));
    } finally {
      setBusy(false);
    }
  };
  useModalFocusTrap({
    containerRef: ref,
    initialFocusRef: buttonRef,
    onEscape: () => {
      void confirm();
    },
  });
  return (
    <ModalPortal>
      <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50">
        <div
          ref={ref}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          className="mx-4 flex max-h-[80vh] w-full max-w-lg flex-col rounded-xl bg-bg-secondary shadow-2xl border border-border"
        >
          <h2 id={titleId} className="p-5 text-lg font-semibold text-text-primary">
            {t('focus.title')}
          </h2>
          <div className="overflow-y-auto px-5 pb-5 text-text-secondary">
            {dialog.html ? (
              <div
                className="prose prose-sm max-w-none"
                dangerouslySetInnerHTML={{ __html: dialog.html }}
              />
            ) : (
              dialog.message
            )}
          </div>
          <div className="border-t border-border p-4 flex justify-end">
            <button
              ref={buttonRef}
              disabled={busy}
              onClick={() => {
                void confirm();
              }}
              className="rounded-md bg-accent px-5 py-2 text-white disabled:opacity-50"
            >
              {t('common.confirm')}
            </button>
          </div>
        </div>
      </div>
    </ModalPortal>
  );
}

export function FocusDialogs() {
  const dialog = useFocusStore((state) => state.dialogs[0]);
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    const restore = async () => {
      const pending = await maaService.pendingFocus();
      for (const request of pending) {
        const focus = request.details.focus as Record<string, FocusTemplate> | undefined;
        const entry = focus?.[request.message];
        const content = typeof entry === 'string' ? entry : entry?.content;
        if (!content) continue;
        const resolved = await resolveFocusContent(content, request.details, request.instance_id);
        if (!cancelled)
          useFocusStore.getState().enqueue({
            id: request.request_id,
            instanceId: request.instance_id,
            blocking: true,
            message: resolved.message,
            html: resolved.html,
          });
      }
    };
    const setup = async () => {
      const unsubscribe = await maaService.onFocusClosed((id) =>
        useFocusStore.getState().close(id),
      );
      if (cancelled) {
        unsubscribe();
        return;
      }
      unlisten = unsubscribe;
      await restore();
    };
    void setup().catch((error) => loggers.ui.debug('Restore focus requests:', error));
    const reconnect = wsService.onConnectionStatus((connected) => {
      if (connected)
        void restore().catch((error) => loggers.ui.debug('Restore focus requests:', error));
    });
    return () => {
      cancelled = true;
      unlisten?.();
      reconnect();
    };
  }, []);
  return dialog ? <FocusDialogView key={dialog.id} dialog={dialog} /> : null;
}
