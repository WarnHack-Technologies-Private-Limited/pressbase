'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCan } from '../shell/current-user';
import styles from './list.module.css';

/** All posts · Categories · Tags — WordPress's Posts submenu, as tabs. */
export function PostsSubnav() {
  const pathname = usePathname();
  const canManage = useCan('manage_categories');
  const links = [
    { href: '/admin/posts', label: 'All posts', show: true },
    { href: '/admin/posts/categories', label: 'Categories', show: canManage },
    { href: '/admin/posts/tags', label: 'Tags', show: canManage },
  ];
  return (
    <nav className={styles.subnav} aria-label="Posts">
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
