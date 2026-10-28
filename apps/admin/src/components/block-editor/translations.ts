import { setLocaleData } from '@wordpress/i18n';

/**
 * The block editor's translations, as wp_set_script_translations() gives
 * them to WordPress's scripts: core merges a language pack's JSON files for
 * the editor packages (and the block titles its `.mo` has) into the
 * `default` domain, in the user's language (`_locale=user`).
 *
 * They go into `@wordpress/i18n`'s shared instance, which every Gutenberg
 * package uses. That's safe here: the editor only ever runs in the browser.
 * It must happen before block-editor.tsx is evaluated, because
 * registerCoreBlocks() translates block titles as it registers them.
 */
export async function loadEditorTranslations(): Promise<void> {
  try {
    const res = await fetch('/wp-json/pressbase/v1/i18n/editor?_locale=user', {
      credentials: 'same-origin',
    });
    if (!res.ok) return;
    const body = (await res.json()) as {
      locale_data?: { default?: Parameters<typeof setLocaleData>[0] };
    };
    if (body.locale_data?.default) setLocaleData(body.locale_data.default, 'default');
  } catch {
    // Untranslated is better than no editor.
  }
}
