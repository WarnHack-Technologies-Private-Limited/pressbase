'use client';

import { type ReactNode, useEffect, useId, useRef } from 'react';
import { Button } from './button';
import styles from './dialog.module.css';

/**
 * Confirmation for destructive or irreversible actions, built on <dialog>:
 * the browser handles the focus trap, Escape and the backdrop. Focus starts on
 * Cancel, so a stray Enter never destroys anything.
 */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  tone = 'danger',
  busy,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  tone?: 'danger' | 'primary';
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      cancelRef.current?.focus();
    }
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className={styles.dialog}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onCancel();
      }}
    >
      <div className={styles.body}>
        <h2 id={titleId} className={styles.title}>
          {title}
        </h2>
        <div className={styles.text}>{children}</div>
      </div>
      <div className={styles.actions}>
        <Button ref={cancelRef} variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button variant={tone} onClick={onConfirm} loading={busy}>
          {confirmLabel}
        </Button>
      </div>
    </dialog>
  );
}
