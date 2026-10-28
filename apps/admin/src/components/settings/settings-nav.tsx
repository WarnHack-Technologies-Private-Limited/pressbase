'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import styles from './settings.module.css';

/** WordPress's settings screens, in the same order. Unbuilt ones show their release. */
const PAGES: { slug: string; label: string; release?: string }[] = [
  { slug: 'general', label: 'General' },
  { slug: 'writing', label: 'Writing' },
  { slug: 'reading', label: 'Reading' },
  { slug: 'discussion', label: 'Discussion' },
  { slug: 'media', label: 'Media' },
  { slug: 'permalinks', label: 'Permalinks' },
];

/** Pressbase's own screens after WordPress's (WordPress has no cron screen). */
PAGES.push({ slug: 'scheduled-tasks', label: 'Scheduled tasks' });

export function SettingsNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Settings">
      <ul className={styles.subnav}>
        {PAGES.map((page) => (
          <li key={page.slug}>
            {page.release ? (
              <span aria-disabled="true">
                {page.label}
                <span className={styles.soon}>
                  <span className="visually-hidden">, coming in </span>
                  {page.release}
                </span>
              </span>
            ) : (
              <Link
                href={`/admin/settings/${page.slug}`}
                aria-current={pathname === `/admin/settings/${page.slug}` ? 'page' : undefined}
              >
                {page.label}
              </Link>
            )}
          </li>
        ))}
      </ul>
    </nav>
  );
}
