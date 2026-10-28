/**
 * The admin's colour scheme: follow the operating system, or force light or
 * dark. The choice is stored per user in core (the pressbase_admin_color_scheme
 * user meta) and mirrored in localStorage, so the login screen and the first
 * paint of every page use it before anything has been fetched.
 *
 * "system" removes `data-theme` from <html>; globals.css then follows
 * prefers-color-scheme. "light" and "dark" set it and override the OS.
 */

export type ColorScheme = 'system' | 'light' | 'dark';

export const COLOR_SCHEMES: readonly ColorScheme[] = ['system', 'light', 'dark'];

/** The user meta key in core (apps/core/src/people/user-meta.ts). */
export const COLOR_SCHEME_META = 'pressbase_admin_color_scheme';

/** The localStorage mirror. */
export const COLOR_SCHEME_STORAGE_KEY = 'pressbase-admin-color-scheme';

export function parseColorScheme(value: unknown): ColorScheme {
  return value === 'light' || value === 'dark' ? value : 'system';
}

/**
 * The inline script that applies the scheme before the first paint. With no
 * argument it reads the localStorage mirror; with a scheme (the server's copy
 * for the logged-in user) it applies that and refreshes the mirror. Storage
 * can throw (private modes, blocked cookies), so every access is guarded.
 */
export function colorSchemeScript(scheme?: ColorScheme): string {
  const key = JSON.stringify(COLOR_SCHEME_STORAGE_KEY);
  const read =
    scheme === undefined
      ? `var s;try{s=localStorage.getItem(${key})}catch(e){}`
      : `var s=${JSON.stringify(parseColorScheme(scheme))};try{localStorage.setItem(${key},s)}catch(e){}`;
  return `(function(){${read}var r=document.documentElement;if(s==="light"||s==="dark")r.setAttribute("data-theme",s);else r.removeAttribute("data-theme")})()`;
}

/** Applies a scheme now and remembers it in this browser. */
export function applyColorScheme(scheme: ColorScheme): void {
  const root = document.documentElement;
  if (scheme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', scheme);
  try {
    localStorage.setItem(COLOR_SCHEME_STORAGE_KEY, scheme);
  } catch {
    // Storage unavailable: the choice still applies and is saved to the account.
  }
}
