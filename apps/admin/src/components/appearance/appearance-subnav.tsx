'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCan } from '../shell/current-user';
import styles from './menus.module.css';

/**
 * Themes · Menus — WordPress's Appearance submenu, as tabs. Each screen has
 * its own capability (switch_themes, edit_theme_options).
 */
export function AppearanceSubnav() {
  const pathname = usePathname();
  const canSwitch = useCan('switch_themes');
  const canMenus = useCan('edit_theme_options');
  const links = [
    { href: '/admin/appearance', label: 'Themes', show: canSwitch },
    { href: '/admin/appearance/menus', label: 'Menus', show: canMenus },
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
