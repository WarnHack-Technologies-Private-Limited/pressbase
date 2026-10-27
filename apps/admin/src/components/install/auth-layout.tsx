import type { ReactNode } from 'react';
import { Logo } from '../ui/surface';
import styles from './auth-layout.module.css';

/** The focused, single-column frame used by the installer and the login screen. */
export function AuthLayout({
  children,
  footer,
  narrow,
}: {
  children: ReactNode;
  footer?: ReactNode;
  narrow?: boolean;
}) {
  return (
    <div className={styles.page}>
      <div className={styles.brand}>
        <Logo />
      </div>
      <main id="main" className={[styles.panel, narrow && styles.narrow].filter(Boolean).join(' ')}>
        {children}
      </main>
      {footer && <footer className={styles.footer}>{footer}</footer>}
    </div>
  );
}
