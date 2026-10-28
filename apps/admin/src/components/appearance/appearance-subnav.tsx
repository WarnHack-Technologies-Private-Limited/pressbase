'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCan } from '../shell/current-user';
import styles from './appearance-subnav.module.css';

/**
 * Themes · Styles · Menus — WordPress's Appearance submenu (themes.php, the
 * site editor's Styles, and navigation menus), as tabs. Each screen has its
 * own capability: switch_themes for Themes, edit_theme_options for the rest.
 */
export function AppearanceSubnav() {
  const pathname = usePathname();
  const canSwitch = useCan('switch_themes');
  const canEditTheme = useCan('edit_theme_options');
  const links = [
    { href: '/admin/appearance', label: 'Themes', show: canSwitch },
    { href: '/admin/appearance/styles', label: 'Styles', show: canEditTheme },
    { href: '/admin/appearance/menus', label: 'Menus', show: canEditTheme },
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
