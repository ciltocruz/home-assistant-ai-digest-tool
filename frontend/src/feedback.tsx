import { useEffect, useRef } from 'react';

export function LiveFeedback({ message, error = false }: { message: string; error?: boolean }) {
  return message ? <p className={error ? 'error-copy' : 'feedback-copy'} role={error ? 'alert' : 'status'} aria-live="polite">{message}</p> : null;
}

export function ConfirmDialog({ open, title, description, confirmLabel, onCancel, onConfirm }: { open: boolean; title: string; description: string; confirmLabel: string; onCancel(): void; onConfirm(): void }) {
  const dialog = useRef<HTMLDivElement>(null);
  const restoreFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!open) return;
    restoreFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focus = () => dialog.current?.querySelector<HTMLButtonElement>('[data-dialog-confirm]')?.focus();
    queueMicrotask(focus);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onCancel(); return; }
      if (event.key !== 'Tab' || !dialog.current) return;
      const buttons = Array.from(dialog.current.querySelectorAll<HTMLButtonElement>('button:not([disabled])'));
      if (buttons.length === 0) return;
      const first = buttons[0]; const last = buttons.at(-1)!;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => { document.removeEventListener('keydown', onKeyDown); queueMicrotask(() => restoreFocus.current?.focus()); };
  }, [open, onCancel]);
  if (!open) return null;
  return <div className="dialog-backdrop" role="presentation"><div ref={dialog} className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="confirm-dialog-title" aria-describedby="confirm-dialog-description"><h2 id="confirm-dialog-title">{title}</h2><p id="confirm-dialog-description">{description}</p><div className="dialog-actions"><button type="button" className="secondary-action" onClick={onCancel}>Cancelar</button><button type="button" data-dialog-confirm onClick={onConfirm}>{confirmLabel}</button></div></div></div>;
}
