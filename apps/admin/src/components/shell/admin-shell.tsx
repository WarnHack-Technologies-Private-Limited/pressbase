'use client';

import { ChevronDown, LogOut, Menu } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import type { Me } from '@/lib/core';
import { SECTION_GROUPS } from '@/lib/sections';
import { Button } from '../ui/button';
import { ToastProvider } from '../ui/toast';
import { CurrentUserProvider } from './current-user';
import styles from './shell.module.css';

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || '?';
}

function useIsNarrow(query = '(max-width: 860px)') {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setNarrow(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [query]);
  return narrow;
}

export function AdminShell({
  user,
  siteName,
  version,
  children,
}: {
  user: Me;
  siteName: string;
  version: string;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const narrow = useIsNarrow();
  const [navOpen, setNavOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);

  // Close the drawer after navigating.
  useEffect(() => setNavOpen(false), [pathname]);

  // Escape closes whichever overlay is open; clicks outside close the user menu.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (menuOpen) {
        setMenuOpen(false);
        menuButtonRef.current?.focus();
      }
      setNavOpen(false);
    };
    const onClick = (e: MouseEvent) => {
      if (menuOpen && !menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onClick);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onClick);
    };
  }, [menuOpen]);

  async function logOut() {
    await api('/pressbase/v1/auth/logout', { method: 'POST' }).catch(() => {});
    router.replace('/login');
    router.refresh();
  }

  const isCurrent = (slug: string) =>
    slug === ''
      ? pathname === '/admin'
      : pathname === `/admin/${slug}` || pathname.startsWith(`/admin/${slug}/`);

  const role = user.roles[0] ? user.roles[0][0]?.toUpperCase() + user.roles[0].slice(1) : '';

  return (
    <div className={styles.shell}>
      <a href="#main" className="skip-link">
        Skip to content
      </a>

      <aside
        className={styles.sidebar}
        data-open={navOpen}
        inert={narrow && !navOpen}
        aria-label="Admin"
      >
        <div className={styles.site}>
          <span className={styles.siteIcon} aria-hidden="true">
            {initials(siteName || 'Pressbase').slice(0, 1)}
          </span>
          <div style={{ minWidth: 0 }}>
            <div className={styles.siteName}>{siteName || 'Untitled site'}</div>
            <div className={styles.siteMeta}>Pressbase {version}</div>
          </div>
        </div>

        <nav className={styles.nav}>
          {SECTION_GROUPS.map((group, i) => (
            <div key={group.label ?? i}>
              {group.label && (
                <div className={styles.groupLabel} id={`nav-${group.label}`}>
                  {group.label}
                </div>
              )}
              <ul
                className={styles.group}
                aria-labelledby={group.label ? `nav-${group.label}` : undefined}
              >
                {group.items
                  .filter((item) => user.capabilities[item.capability])
                  .map((item) => (
                    <li key={item.slug}>
                      <Link
                        href={item.slug ? `/admin/${item.slug}` : '/admin'}
                        className={styles.link}
                        aria-current={isCurrent(item.slug) ? 'page' : undefined}
                      >
                        <item.icon size={18} aria-hidden="true" />
                        {item.label}
                        {item.release && (
                          <span className={styles.soon}>
                            <span className="visually-hidden">, coming in </span>
                            {item.release}
                          </span>
                        )}
                      </Link>
                    </li>
                  ))}
              </ul>
            </div>
          ))}
        </nav>

        <p className={styles.sidebarFooter}>
          Developer preview. Sections marked with a version are on the way.
        </p>
      </aside>

      <div
        className={styles.scrim}
        data-open={navOpen}
        onClick={() => setNavOpen(false)}
        aria-hidden="true"
      />

      <div className={styles.main}>
        <header className={styles.topbar}>
          <Button
            variant="ghost"
            size="sm"
            className={styles.menuButton}
            onClick={() => setNavOpen(true)}
            aria-label="Open menu"
            aria-expanded={navOpen}
            icon={<Menu size={18} aria-hidden="true" />}
          />
          <div className={styles.spacer} />
          <div ref={menuRef}>
            <button
              ref={menuButtonRef}
              type="button"
              className={styles.userButton}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((open) => !open)}
            >
              <span className={styles.avatar} aria-hidden="true">
                {initials(user.name)}
              </span>
              <span>{user.name}</span>
              <ChevronDown size={14} aria-hidden="true" />
            </button>
            {menuOpen && (
              <div className={styles.userMenu} role="menu" aria-label="Account">
                <div className={styles.userMenuHeader}>
                  <div className={styles.userMenuName}>{user.name}</div>
                  <div className={styles.userMenuMeta}>{user.email}</div>
                  {role && <div className={styles.userMenuMeta}>{role}</div>}
                </div>
                <button
                  type="button"
                  role="menuitem"
                  className={styles.menuItem}
                  onClick={logOut}
                  // biome-ignore lint/a11y/noAutofocus: focus moves into the menu when it opens.
                  autoFocus
                >
                  <LogOut size={16} aria-hidden="true" />
                  Log out
                </button>
              </div>
            )}
          </div>
        </header>
        <main id="main" className={styles.content} tabIndex={-1}>
          <CurrentUserProvider user={user}>
            <ToastProvider>{children}</ToastProvider>
          </CurrentUserProvider>
        </main>
      </div>
    </div>
  );
}
