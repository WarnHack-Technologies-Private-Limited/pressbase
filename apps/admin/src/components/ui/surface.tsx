import { AlertTriangle, CheckCircle2, Info, XCircle } from 'lucide-react';
import type { ReactNode } from 'react';
import styles from './surface.module.css';

type Tone = 'info' | 'success' | 'warning' | 'danger';

const ICONS = { info: Info, success: CheckCircle2, warning: AlertTriangle, danger: XCircle };

/**
 * An inline message. Danger notices are announced immediately (role=alert);
 * others politely, so they never interrupt a screen reader mid-sentence.
 */
export function Notice({
  tone = 'info',
  title,
  children,
  id,
}: {
  tone?: Tone;
  title?: ReactNode;
  children?: ReactNode;
  id?: string;
}) {
  const Icon = ICONS[tone];
  return (
    <div
      id={id}
      className={`${styles.notice} ${styles[tone]}`}
      role={tone === 'danger' ? 'alert' : 'status'}
      tabIndex={-1}
    >
      <Icon size={18} aria-hidden="true" />
      <div className={styles.noticeBody}>
        {title && <p className={styles.noticeTitle}>{title}</p>}
        {children && <div>{children}</div>}
      </div>
    </div>
  );
}

export function Card({
  title,
  description,
  actions,
  children,
  className,
  headingLevel: Heading = 'h2',
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  headingLevel?: 'h2' | 'h3';
}) {
  return (
    <section className={[styles.card, className].filter(Boolean).join(' ')}>
      {title && (
        <header className={styles.cardHeader}>
          <div>
            <Heading className={styles.cardTitle}>{title}</Heading>
            {description && <p className={styles.cardDescription}>{description}</p>}
          </div>
          {actions}
        </header>
      )}
      <div className={styles.cardBody}>{children}</div>
    </section>
  );
}

export function Badge({
  tone,
  children,
}: {
  tone?: 'success' | 'warning' | 'accent';
  children: ReactNode;
}) {
  return (
    <span className={[styles.badge, tone && styles[tone]].filter(Boolean).join(' ')}>
      {children}
    </span>
  );
}

export function EmptyState({
  icon,
  title,
  children,
  action,
}: {
  icon: ReactNode;
  title: ReactNode;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className={styles.empty}>
      <div className={styles.emptyIcon} aria-hidden="true">
        {icon}
      </div>
      <h2>{title}</h2>
      <div className={styles.emptyText}>{children}</div>
      {action}
    </div>
  );
}

export function Logo({ name = 'Pressbase' }: { name?: string }) {
  return (
    <span className={styles.logo}>
      <span className={styles.logoMark} aria-hidden="true">
        P
      </span>
      {name}
    </span>
  );
}
