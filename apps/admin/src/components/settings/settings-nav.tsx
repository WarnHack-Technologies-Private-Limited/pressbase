'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { isPageCurrent, pageHref, pagesUnder } from '@/lib/extensions/pages';
import { useI18n } from '@/lib/i18n/context';
import { msgid } from '@/lib/i18n/locale';
import { useAdminExtensions } from '../extensions/host';
import styles from './settings.module.css';

/** WordPress's settings screens, in the same order. Unbuilt ones show their release. */
const PAGES: { slug: string; label: string; release?: string }[] = [
  { slug: 'general', label: msgid('General') },
  { slug: 'writing', label: msgid('Writing') },
  { slug: 'reading', label: msgid('Reading') },
  { slug: 'discussion', label: msgid('Discussion') },
  { slug: 'media', label: msgid('Media') },
  { slug: 'permalinks', label: msgid('Permalinks') },
];

/** Pressbase's own screens after WordPress's (WordPress has no cron screen). */
PAGES.push({ slug: 'scheduled-tasks', label: msgid('Scheduled tasks') });

export function SettingsNav() {
  const pathname = usePathname();
  const { __ } = useI18n();
  // Plugins' settings pages (add_options_page), after core's, as in WordPress's Settings menu.
  const pluginPages = pagesUnder(useAdminExtensions(), 'settings');
  return (
    <nav aria-label={__('Settings', 'pressbase-admin')}>
      <ul className={styles.subnav}>
        {PAGES.map((page) => (
          <li key={page.slug}>
            {page.release ? (
              <span aria-disabled="true">
                {__(page.label, 'pressbase-admin')}
                <span className={styles.soon}>
                  <span className="visually-hidden">{__(', coming in ', 'pressbase-admin')}</span>
                  {page.release}
                </span>
              </span>
            ) : (
              <Link
                href={`/admin/settings/${page.slug}`}
                aria-current={pathname === `/admin/settings/${page.slug}` ? 'page' : undefined}
              >
                {__(page.label, 'pressbase-admin')}
              </Link>
            )}
          </li>
        ))}
        {pluginPages.map((page) => (
          <li key={`${page.plugin}/${page.slug}`} className={styles.pluginPage}>
            <Link
              href={pageHref(page)}
              aria-current={isPageCurrent(page, pathname) ? 'page' : undefined}
            >
              {page.title}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
