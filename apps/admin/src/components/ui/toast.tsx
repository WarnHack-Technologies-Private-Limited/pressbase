'use client';

import { CheckCircle2, X, XCircle } from 'lucide-react';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from 'react';
import styles from './toast.module.css';

interface Toast {
  id: number;
  message: string;
  tone: 'success' | 'danger';
  action?: { label: string; onClick: () => void };
}

type Show = (message: string, options?: { tone?: Toast['tone']; action?: Toast['action'] }) => void;

const ToastContext = createContext<Show>(() => {});

/**
 * Short confirmations after an action ("Post moved to the Trash. Undo").
 * Polite live region; toasts with an action stay longer so it can be used.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(1);

  const dismiss = useCallback(
    (id: number) => setToasts((all) => all.filter((t) => t.id !== id)),
    [],
  );

  const show = useCallback<Show>(
    (message, options = {}) => {
      const id = next.current++;
      setToasts((all) => [
        ...all.slice(-2),
        { id, message, tone: options.tone ?? 'success', action: options.action },
      ]);
      setTimeout(() => dismiss(id), options.action ? 8000 : 4000);
    },
    [dismiss],
  );

  const value = useMemo(() => show, [show]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className={styles.region} aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className={styles.toast} data-tone={toast.tone}>
            {toast.tone === 'danger' ? (
              <XCircle size={16} aria-hidden="true" />
            ) : (
              <CheckCircle2 size={16} aria-hidden="true" />
            )}
            <span>{toast.message}</span>
            {toast.action && (
              <button
                type="button"
                className={styles.action}
                onClick={() => {
                  toast.action?.onClick();
                  dismiss(toast.id);
                }}
              >
                {toast.action.label}
              </button>
            )}
            <button
              type="button"
              className={styles.dismiss}
              onClick={() => dismiss(toast.id)}
              aria-label="Dismiss"
            >
              <X size={14} aria-hidden="true" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): Show {
  return useContext(ToastContext);
}
