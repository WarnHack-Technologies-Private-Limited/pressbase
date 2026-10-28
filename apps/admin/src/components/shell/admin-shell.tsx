'use client';

import {
  Check,
  ChevronDown,
  ExternalLink,
  LogOut,
  Menu,
  Monitor,
  Moon,
  Puzzle,
  Sun,
  UserRound,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { api } from '@/lib/api';
import {
  applyColorScheme,
  COLOR_SCHEME_META,
  type ColorScheme,
  colorSchemeScript,
  parseColorScheme,
} from '@/lib/color-scheme';
import type { Me } from '@/lib/core';
import {
  type AdminExtensions,
  isPageCurrent,
  NO_EXTENSIONS,
  pageHref,
  pagesUnder,
} from '@/lib/extensions/pages';
import { SECTION_GROUPS } from '@/lib/sections';
import { ExtensionErrors, ExtensionsProvider, PluginArea } from '../extensions/host';
import { Button } from '../ui/button';
import { ToastProvider } from '../ui/toast';
import { CurrentUserProvider } from './current-user';
import styles from './shell.module.css';

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || '?';
}

const SCHEME_CHOICES: { value: ColorScheme; label: string; icon: typeof Sun }[] = [
  { value: 'system', label: 'System', icon: Monitor },
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
];

/** Arrow keys, Home and End move between a menu's items (WAI-ARIA menu pattern). */
function onMenuKeyDown(event: ReactKeyboardEvent<HTMLDivElement>, close: () => void) {
  if (event.key === 'Tab') {
    close();
    return;
  }
  const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role^="menuitem"]')];
  if (!items.length) return;
  const index = items.indexOf(document.activeElement as HTMLElement);
  const next = {
    ArrowDown: (index + 1) % items.length,
    ArrowUp: (index - 1 + items.length) % items.length,
    Home: 0,
    End: items.length - 1,
  }[event.key];
  if (next === undefined) return;
  event.preventDefault();
  items[next]?.focus();
}

const noSubscription = () => () => {};

/**
 * True while rendering on the server and hydrating that HTML, false on a
 * client-side render. An inline script only runs when it arrives as HTML.
 */
function useIsServerHtml() {
  return useSyncExternalStore(
    noSubscription,
    () => false,
    () => true,
  );
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
  siteUrl,
  siteIcon,
  version,
  extensions = NO_EXTENSIONS,
  children,
}: {
  /** Plugins' admin pages and browser modules (/pressbase/v1/admin-extensions). */
  extensions?: AdminExtensions;
  user: Me;
  siteName: string;
  /** The public site's address (the `home` option). */
  siteUrl: string;
  /** The site icon's URL (get_site_icon_url()), shown instead of the initial. */
  siteIcon?: string;
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
  const themeLabelId = useId();
  // The account's saved scheme, as rendered by the server; the inline script
  // below applies it before paint and refreshes the localStorage mirror.
  const [savedScheme] = useState(() => parseColorScheme(user.meta?.[COLOR_SCHEME_META]));
  const [scheme, setScheme] = useState(savedScheme);
  const serverHtml = useIsServerHtml();

  // After a client-side navigation (from the login screen, say) the inline
  // script never ran; apply the account's scheme now.
  useEffect(() => applyColorScheme(savedScheme), [savedScheme]);

  async function chooseScheme(next: ColorScheme) {
    setScheme(next);
    applyColorScheme(next);
    // Saved to the account, so it follows the person to other browsers. If this
    // fails, the local copy still applies in this browser.
    await api('/wp/v2/users/me', {
      method: 'POST',
      body: { meta: { [COLOR_SCHEME_META]: next } },
    }).catch(() => {});
  }

  // Focus moves into the user menu when it opens (React's autoFocus skips links).
  useEffect(() => {
    if (menuOpen) menuRef.current?.querySelector<HTMLElement>('[role^="menuitem"]')?.focus();
  }, [menuOpen]);

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
  const topPages = pagesUnder(extensions, null);
  const toolPages = pagesUnder(extensions, 'tools');

  return (
    <ExtensionsProvider extensions={extensions}>
      <div className={styles.shell}>
        {serverHtml && (
          <script dangerouslySetInnerHTML={{ __html: colorSchemeScript(savedScheme) }} />
        )}
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
            <span className={styles.siteIcon} aria-hidden="true" data-image={Boolean(siteIcon)}>
              {siteIcon ? (
                <img src={siteIcon} alt="" />
              ) : (
                initials(siteName || 'Pressbase').slice(0, 1)
              )}
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
                    .map((item) => {
                      // Tools is built once a plugin adds a page to it (add_management_page).
                      const release =
                        item.slug === 'tools' && toolPages.length ? undefined : item.release;
                      return (
                        <li key={item.slug}>
                          <Link
                            href={item.slug ? `/admin/${item.slug}` : '/admin'}
                            className={styles.link}
                            aria-current={isCurrent(item.slug) ? 'page' : undefined}
                          >
                            <item.icon size={18} aria-hidden="true" />
                            {item.label}
                            {release && (
                              <span className={styles.soon}>
                                <span className="visually-hidden">, coming in </span>
                                {release}
                              </span>
                            )}
                          </Link>
                        </li>
                      );
                    })}
                  {/* Plugins' top-level pages (add_menu_page), after Plugins. */}
                  {group.label === 'Extend' &&
                    topPages.map((page) => (
                      <li key={`${page.plugin}/${page.slug}`}>
                        <Link
                          href={pageHref(page)}
                          className={styles.link}
                          aria-current={isPageCurrent(page, pathname) ? 'page' : undefined}
                        >
                          <Puzzle size={18} aria-hidden="true" />
                          {page.title}
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
            <a href={siteUrl || '/'} className={styles.visitSite} target="_blank" rel="noreferrer">
              Visit site
              <ExternalLink size={14} aria-hidden="true" />
              <span className="visually-hidden">(opens in a new tab)</span>
            </a>
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
                <div
                  className={styles.userMenu}
                  role="menu"
                  aria-label="Account"
                  onKeyDown={(event) => onMenuKeyDown(event, () => setMenuOpen(false))}
                >
                  <div className={styles.userMenuHeader}>
                    <div className={styles.userMenuName}>{user.name}</div>
                    <div className={styles.userMenuMeta}>{user.email}</div>
                    {role && <div className={styles.userMenuMeta}>{role}</div>}
                  </div>
                  <Link
                    href="/admin/profile"
                    role="menuitem"
                    className={styles.menuItem}
                    style={{ color: 'inherit', textDecoration: 'none' }}
                    onClick={() => setMenuOpen(false)}
                  >
                    <UserRound size={16} aria-hidden="true" />
                    Profile
                  </Link>
                  <fieldset aria-labelledby={themeLabelId} className={styles.menuGroup}>
                    <div id={themeLabelId} className={styles.menuLabel}>
                      Theme
                    </div>
                    {SCHEME_CHOICES.map((choice) => (
                      <button
                        key={choice.value}
                        type="button"
                        role="menuitemradio"
                        aria-checked={scheme === choice.value}
                        className={styles.menuItem}
                        onClick={() => chooseScheme(choice.value)}
                      >
                        <choice.icon size={16} aria-hidden="true" />
                        {choice.label}
                        {scheme === choice.value && (
                          <Check size={16} aria-hidden="true" className={styles.menuCheck} />
                        )}
                      </button>
                    ))}
                  </fieldset>
                  <button
                    type="button"
                    role="menuitem"
                    className={styles.menuItem}
                    onClick={logOut}
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
              <ToastProvider>
                <ExtensionErrors />
                {children}
                {/* Plugins' browser modules render their Fills from here. */}
                <PluginArea />
              </ToastProvider>
            </CurrentUserProvider>
          </main>
        </div>
      </div>
    </ExtensionsProvider>
  );
}
