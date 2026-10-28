'use client';

import { ChevronDown } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import styles from './site-health.module.css';

/**
 * One row of a Site Health accordion (WordPress's .health-check-accordion):
 * a heading holding a button with aria-expanded, and the panel it controls.
 */
export function AccordionItem({
  title,
  icon,
  badge,
  headingLevel: Heading = 'h3',
  defaultOpen = false,
  children,
}: {
  title: ReactNode;
  icon?: ReactNode;
  badge?: ReactNode;
  headingLevel?: 'h2' | 'h3' | 'h4';
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  return (
    <div className={styles.item}>
      <Heading className={styles.itemHeading}>
        <button
          type="button"
          className={styles.trigger}
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen(!open)}
        >
          {icon}
          <span className={styles.triggerLabel}>{title}</span>
          {badge}
          <ChevronDown size={18} className={styles.chevron} aria-hidden="true" />
        </button>
      </Heading>
      <div id={id} className={styles.panel} hidden={!open}>
        {children}
      </div>
    </div>
  );
}
