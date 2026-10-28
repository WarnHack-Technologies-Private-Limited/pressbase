'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCan } from '../shell/current-user';
import styles from './appearance-subnav.module.css';

/**
 * Themes · Styles — WordPress's Appearance submenu (themes.php, and the site
 * editor's Styles), as tabs. Other Appearance screens add their link here.
 */
export function AppearanceSubnav() {
  const pathname = usePathname();
  const canEditStyles = useCan('edit_theme_options');
  const links = [
    { href: '/admin/appearance', label: 'Themes', show: true },
    { href: '/admin/appearance/styles', label: 'Styles', show: canEditStyles },
  ];
  return (
    <nav className={styles.subnav} aria-label="Appearance">
      {links
        .filter((l) => l.show)
        .map((link) => (
          <Link
            key={link.href}
            href={link.href}
            aria-current={pathname === link.href ? 'page' : undefined}
          >
            {link.label}
          </Link>
        ))}
    </nav>
  );
}
