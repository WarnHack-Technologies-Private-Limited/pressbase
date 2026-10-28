import { useSyncExternalStore } from 'react';
import { host } from './host';

/**
 * Translations for the admin modules, in the `pressbase-seo` text domain:
 * the server translates the strings the build extracted (dist/admin-strings.json)
 * through api.i18n, and the modules look them up here.
 */

let strings: Record<string, string> = {};
let version = 0;
const listeners = new Set<() => void>();
let loading = false;

function load(): void {
  if (loading) return;
  loading = true;
  host
    .api<{ strings: Record<string, string> }>('/pressbase-seo/v1/l10n')
    .then((res) => {
      strings = res.strings ?? {};
      version++;
      for (const l of listeners) l();
    })
    .catch(() => {});
}

export function __(text: string): string {
  return strings[text] ?? text;
}

/** Re-renders once the translations arrive. */
export function useL10n(): void {
  load();
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => version,
  );
}
