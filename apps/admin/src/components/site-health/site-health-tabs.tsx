'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import styles from './site-health.module.css';

/** Status · Info: WordPress's Site Health tabs (site-health.php, ?tab=debug). */
export function SiteHealthTabs() {
  const pathname = usePathname();
  const links = [
    { href: '/admin/tools/site-health', label: 'Status' },
    { href: '/admin/tools/site-health/info', label: 'Info' },
  ];
  return (
    <nav className={styles.subnav} aria-label="Site health">
      {links.map((link) => (
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
