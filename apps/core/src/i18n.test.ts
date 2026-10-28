import { existsSync } from 'node:fs';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { compileMo } from './i18n/translation-file';
import { createZip } from './plugins/zip';
import { setup } from './test-utils';

/**
 * Internationalisation (v0.6): text domains, the gettext filters, locales
 * per site and per user, the admin's and block editor's translations, theme
 * patterns and dates in the site's language, RTL, plugins' translations and
 * installing WordPress.org language packs (with the network mocked).
 * See docs/architecture/i18n.md.
 */

type Ctx = Awaited<ReturnType<typeof setup>>;

async function site() {
  const ctx = await setup();
  await ctx.install();
  return ctx;
}

const HEADER = (language: string, plural = 'nplurals=2; plural=n != 1;') => `msgid ""
msgstr ""
"Language: ${language}\\n"
"Plural-Forms: ${plural}\\n"
"Content-Type: text/plain; charset=UTF-8\\n"
`;

/** A `.po` file from pairs: [msgid, msgstr] or [msgid, msgstr, context]. */
function po(language: string, pairs: [string, string, string?][], plural?: string): string {
  return (
    HEADER(language, plural) +
    pairs
      .map(
        ([id, str, context]) =>
          `\n${context ? `msgctxt "${context}"\n` : ''}msgid "${id}"\nmsgstr "${str}"\n`,
      )
      .join('')
  );
}

async function writeLanguageFile(ctx: Ctx, relative: string, content: string | Uint8Array) {
  const file = path.join(ctx.dataDir, 'languages', relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}

/** WordPress's core strings for a small German "pack". */
const GERMAN_CORE = po('de_DE', [
  ['Posts', 'Beiträge'],
  ['Settings', 'Einstellungen'],
  ['General Settings', 'Einstellungen &rsaquo; Allgemein'],
  ['October', 'Oktober'],
  ['Skip to content', 'Zum Inhalt springen'],
  ['Paragraph', 'Absatz', 'block title'],
]);

async function german(ctx: Ctx) {
  await writeLanguageFile(ctx, 'de_DE.po', GERMAN_CORE);
}

describe('translating (l10n.php)', () => {
  it('translates through the default domain once a language is installed and chosen', async () => {
    const ctx = await site();
    const { i18n } = ctx.kernel;
    expect(i18n.__('Posts')).toBe('Posts');
    await german(ctx);
    expect(i18n.getAvailableLanguages()).toEqual(['de_DE']);

    // Site language: Settings → General (WPLANG, stored as `locale`).
    const saved = await ctx.request('POST', '/wp/v2/settings', { language: 'de_DE' });
    expect(saved.status).toBe(200);
    expect(saved.body.language).toBe('de_DE');
    expect(i18n.getLocale()).toBe('de_DE');
    expect(i18n.__('Posts')).toBe('Beiträge');
    expect(i18n._x('Paragraph', 'block title')).toBe('Absatz');
    expect(i18n.__('Paragraph')).toBe('Paragraph');
    expect(i18n.esc_html__('General Settings')).toBe('Einstellungen &amp;rsaquo; Allgemein');
    // A string a translation lacks stays English.
    expect(i18n.__('Untranslated text')).toBe('Untranslated text');
  });

  it('refuses a site language that isn’t installed', async () => {
    const ctx = await site();
    const res = await ctx.request('POST', '/wp/v2/settings', { language: 'fr_FR' });
    expect(res.status).toBe(400);
    expect(res.body.data.params.language).toMatch(/isn’t installed/);
    expect((await ctx.request('POST', '/wp/v2/settings', { language: 'en_US' })).status).toBe(200);
  });

  it('chooses plural forms by the language’s rule (_n, _nx)', async () => {
    const ctx = await site();
    await writeLanguageFile(
      ctx,
      'plugins/counter-fr_FR.mo',
      compileMo({ 'Plural-Forms': 'nplurals=2; plural=(n > 1);' }, [
        {
          singular: '%d item',
          plural: '%d items',
          translations: ['%d élément', '%d éléments'],
        },
        {
          singular: '%d file',
          plural: '%d files',
          context: 'upload',
          translations: ['%d fichier', '%d fichiers'],
        },
      ]),
    );
    const { i18n } = ctx.kernel;
    await i18n.withLocale('fr_FR', () => {
      expect(i18n._n('%d item', '%d items', 0, 'counter')).toBe('%d élément');
      expect(i18n._n('%d item', '%d items', 1, 'counter')).toBe('%d élément');
      expect(i18n._n('%d item', '%d items', 2, 'counter')).toBe('%d éléments');
      expect(i18n._nx('%d file', '%d files', 5, 'upload', 'counter')).toBe('%d fichiers');
      expect(i18n._n('%d page', '%d pages', 1, 'counter')).toBe('%d page');
      expect(i18n._n('%d page', '%d pages', 2, 'counter')).toBe('%d pages');
    });
    expect(i18n._n('%d item', '%d items', 2, 'counter')).toBe('%d items');
  });

  it('runs the gettext filters', async () => {
    const ctx = await site();
    const { i18n, hooks } = ctx.kernel;
    hooks.addFilter('gettext', (translation, text, domain) =>
      domain === 'my-plugin' && text === 'Howdy' ? 'Hello' : translation,
    );
    hooks.addFilter('gettext_with_context', (translation, _text, context) =>
      context === 'shout' ? translation.toUpperCase() : translation,
    );
    hooks.addFilter('ngettext', (translation, _single, _plural, number) =>
      number === 0 ? 'none' : translation,
    );
    hooks.addFilter('gettext_my-plugin', (translation) => `${translation}!`);
    expect(i18n.__('Howdy', 'my-plugin')).toBe('Hello!');
    expect(i18n._x('quiet', 'shout')).toBe('QUIET');
    expect(i18n._n('%d post', '%d posts', 0)).toBe('none');
    // An async callback can't run during a synchronous translation: it is skipped.
    hooks.addFilter('gettext_other', async (t) => `${t}?`);
    expect(i18n.__('Sure', 'other')).toBe('Sure');
  });

  it('loads and unloads text domains, with the load_textdomain hooks', async () => {
    const ctx = await site();
    const { i18n, hooks } = ctx.kernel;
    const file = path.join(ctx.dataDir, 'custom', 'mine-de_DE.po');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, po('de_DE', [['Hello', 'Hallo']]));
    const loaded: string[] = [];
    hooks.addAction('load_textdomain', (domain) => {
      loaded.push(domain);
    });
    // load_textdomain() tries the .mo, then a .po with the same name.
    expect(i18n.loadTextdomain('mine', file.replace(/\.po$/, '.mo'), 'de_DE')).toBe(true);
    expect(loaded).toEqual(['mine']);
    expect(i18n.isTextdomainLoaded('mine', 'de_DE')).toBe(true);
    expect(i18n.withLocale('de_DE', () => i18n.__('Hello', 'mine'))).toBe('Hallo');
    expect(i18n.unloadTextdomain('mine')).toBe(true);
    expect(i18n.withLocale('de_DE', () => i18n.__('Hello', 'mine'))).toBe('Hello');
    // override_load_textdomain short-circuits.
    hooks.addFilter('override_load_textdomain', () => true);
    expect(i18n.loadTextdomain('other', '/nowhere/other-de_DE.mo', 'de_DE')).toBe(true);
  });
});

describe('locales (determine_locale)', () => {
  it('uses a user’s own language for requests with _locale=user, the site’s otherwise', async () => {
    const ctx = await site();
    await german(ctx);
    await writeLanguageFile(ctx, 'fr_FR.po', po('fr_FR', [['Posts', 'Articles']]));
    expect((await ctx.request('POST', '/wp/v2/settings', { language: 'fr_FR' })).status).toBe(200);

    // Profile → Language: only installed languages ('' is the site's).
    const bad = await ctx.request('POST', '/wp/v2/users/me', { locale: 'es_ES' });
    expect(bad.status).toBe(400);
    const me = await ctx.request('POST', '/wp/v2/users/me?context=edit', { locale: 'de_DE' });
    expect(me.status).toBe(200);
    expect(me.body.locale).toBe('de_DE');
    expect(me.body.locale_setting).toBe('de_DE');

    const admin = await ctx.request('GET', '/pressbase/v1/i18n/admin?_locale=user');
    expect(admin.body).toMatchObject({ locale: 'de_DE', lang: 'de-DE', dir: 'ltr' });
    const site_ = await ctx.request('GET', '/pressbase/v1/i18n/admin');
    expect(site_.body.locale).toBe('fr_FR');
    // Anonymous visitors get the site's language.
    const anonymous = ctx.client();
    expect((await anonymous.request('GET', '/pressbase/v1/i18n/admin?_locale=user')).body.locale).toBe(
      'fr_FR',
    );
    // wp_lang= for the login screen, installed languages only.
    expect(
      (await anonymous.request('GET', '/pressbase/v1/i18n/admin?wp_lang=de_DE')).body.locale,
    ).toBe('de_DE');
    expect(
      (await anonymous.request('GET', '/pressbase/v1/i18n/admin?wp_lang=xx_YY')).body.locale,
    ).toBe('fr_FR');

    // Back to the site's language.
    const reset = await ctx.request('POST', '/wp/v2/users/me?context=edit', { locale: '' });
    expect(reset.body).toMatchObject({ locale: 'fr_FR', locale_setting: '' });
  });

  it('runs the locale filters', async () => {
    const ctx = await site();
    await german(ctx);
    ctx.kernel.hooks.addFilter('determine_locale', () => 'de_DE');
    const res = await ctx.request('GET', '/pressbase/v1/i18n/admin');
    expect(res.body.locale).toBe('de_DE');
    ctx.kernel.hooks.addFilter('locale', () => 'de_DE');
    expect(ctx.kernel.i18n.getLocale()).toBe('de_DE');
  });

  it('lists installed languages with their names for every signed-in user', async () => {
    const ctx = await site();
    await german(ctx);
    await writeLanguageFile(ctx, 'admin-de_DE.mo', compileMo({}, []));
    await writeLanguageFile(ctx, 'continents-cities-de_DE.mo', compileMo({}, []));
    const author = await ctx.loginAs('writer', 'author');
    const res = await author.request('GET', '/pressbase/v1/languages');
    expect(res.status).toBe(200);
    expect(res.body.can_install).toBe(false);
    expect(res.body.site_language).toBe('en_US');
    expect(res.body.installed).toEqual([
      expect.objectContaining({ language: 'en_US', native_name: 'English (United States)' }),
      expect.objectContaining({
        language: 'de_DE',
        english_name: 'German (Germany)',
        native_name: 'Deutsch (Deutschland)',
        dir: 'ltr',
        wordpress: true,
      }),
    ]);
    const admin = await ctx.request('GET', '/pressbase/v1/languages');
    expect(admin.body.can_install).toBe(true);
    expect((await ctx.client().request('GET', '/pressbase/v1/languages')).status).toBe(401);
  });
});

describe('translations for the admin and the block editor', () => {
  it('serves the admin’s strings, borrowing WordPress’s where Pressbase has none', async () => {
    const ctx = await site();
    await german(ctx);
    await writeLanguageFile(
      ctx,
      'pressbase/pressbase-admin-de_DE.po',
      po('de_DE', [['Site language', 'Sprache der Website']]),
    );
    const { i18n } = ctx.kernel;
    const data = i18n.jedLocaleData('pressbase-admin', 'de_DE', [
      'Site language',
      'Posts',
      'General Settings',
      'Paragraph',
    ]);
    expect(data['Site language']).toEqual(['Sprache der Website']);
    expect(data.Posts).toEqual(['Beiträge']);
    // WordPress's HTML entities become text.
    expect(data['General Settings']).toEqual(['Einstellungen › Allgemein']);
    expect(data.Paragraph).toBeUndefined();
    expect(data['']).toMatchObject({ domain: 'pressbase-admin', lang: 'de_DE' });

    // The endpoint borrows for the strings in languages/pressbase-admin.pot.
    await ctx.request('POST', '/wp/v2/settings', { language: 'de_DE' });
    const res = await ctx.app.request('/wp-json/pressbase/v1/i18n/admin');
    const body = (await res.json()) as { locale_data: Record<string, Record<string, unknown>> };
    expect(body.locale_data['pressbase-admin']?.Posts).toEqual(['Beiträge']);
    expect(body.locale_data['pressbase-admin']?.['Site language']).toEqual([
      'Sprache der Website',
    ]);
    // Cached by ETag.
    const again = await ctx.app.request('/wp-json/pressbase/v1/i18n/admin', {
      headers: { 'if-none-match': res.headers.get('etag') ?? '' },
    });
    expect(again.status).toBe(304);
  });

  it('works before installation, in English', async () => {
    const ctx = await setup();
    const res = await ctx.request('GET', '/pressbase/v1/i18n/admin');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ locale: 'en_US', lang: 'en-US', dir: 'ltr' });
  });

  it('merges a pack’s script translations for the block editor', async () => {
    const ctx = await site();
    await german(ctx);
    const jed = (reference: string, messages: Record<string, string[]>) =>
      JSON.stringify({
        domain: 'messages',
        locale_data: {
          messages: { '': { domain: 'messages', 'plural-forms': 'nplurals=2; plural=n != 1;' }, ...messages },
        },
        comment: { reference },
      });
    await writeLanguageFile(
      ctx,
      `de_DE-${'a'.repeat(32)}.json`,
      jed('wp-includes/js/dist/block-library.js', { 'Add block': ['Block hinzufügen'] }),
    );
    await writeLanguageFile(
      ctx,
      `de_DE-${'b'.repeat(32)}.json`,
      jed('wp-includes/js/dist/block-editor.js', { Undo: ['Rückgängig'] }),
    );
    // Not an editor script: left out.
    await writeLanguageFile(
      ctx,
      `de_DE-${'c'.repeat(32)}.json`,
      jed('wp-admin/js/privacy-tools.js', { 'Copied!': ['Kopiert!'] }),
    );
    await writeLanguageFile(ctx, `fr_FR-${'d'.repeat(32)}.json`, jed('wp-includes/js/dist/a.js', {}));
    const res = await ctx.request('GET', '/pressbase/v1/i18n/editor?_locale=user');
    expect(res.status).toBe(200);
    expect(res.body.locale).toBe('en_US');
    await ctx.request('POST', '/wp/v2/users/me', { locale: 'de_DE' });
    const de = await ctx.request('GET', '/pressbase/v1/i18n/editor?_locale=user');
    const data = de.body.locale_data.default;
    expect(de.body.locale).toBe('de_DE');
    expect(data['Add block']).toEqual(['Block hinzufügen']);
    expect(data.Undo).toEqual(['Rückgängig']);
    expect(data['Copied!']).toBeUndefined();
    // Block titles come from the core .mo, as WordPress's server translates them.
    expect(data['block title\u0004Paragraph']).toEqual(['Absatz']);
    expect(data.Posts).toBeUndefined();
  });
});

describe('the public site in the site’s language', () => {
  it('translates theme patterns, dates and the skip link', async () => {
    const ctx = await site();
    await german(ctx);
    await writeLanguageFile(
      ctx,
      'themes/twentytwentyfive-de_DE.po',
      po('de_DE', [
        ['Page not found', 'Seite nicht gefunden', '404 error message'],
        ['404', '404 (Fehler)', 'Pattern title'],
      ]),
    );
    const created = await ctx.request('POST', '/wp/v2/posts', {
      title: 'Autumn notes',
      status: 'publish',
      date: '2026-10-12T10:00:00',
    });
    expect(created.status).toBe(201);

    const render = async (url: string) => {
      const res = await ctx.app.request(`/wp-json/pressbase/v1/render?url=${encodeURIComponent(url)}`);
      return ((await res.json()) as { html: string }).html;
    };
    expect(await render('/no-such-page/')).toContain('Page not found');

    await ctx.request('POST', '/wp/v2/settings', { language: 'de_DE' });
    const missing = await render('/no-such-page/');
    expect(missing).toContain('Seite nicht gefunden');
    expect(missing).toContain('<html lang="de-DE">');
    expect(missing).toContain('Zum Inhalt springen');
    const pattern = ctx.kernel.blocks.patterns?.get?.('twentytwentyfive/hidden-404');
    if (pattern) expect(pattern.title).toBe('404 (Fehler)');

    const single = await render(new URL(created.body.link).pathname);
    expect(single).toContain('Oktober 12, 2026');
  });

  it('marks right-to-left languages: dir, body class and the RTL block styles', async () => {
    const ctx = await site();
    await writeLanguageFile(ctx, 'ar.po', po('ar', [['ltr', 'rtl', 'text direction']]));
    await ctx.request('POST', '/wp/v2/settings', { language: 'ar' });
    expect(ctx.kernel.i18n.isRtl()).toBe(true);
    const res = await ctx.app.request(`/wp-json/pressbase/v1/render?url=${encodeURIComponent('/')}`);
    const { html } = (await res.json()) as { html: string };
    expect(html).toContain('<html dir="rtl" lang="ar">');
    expect(html).toMatch(/<body class="[^"]*\brtl\b/);
    expect(html).toContain('block-library/style-rtl.min.css');
    const css = await ctx.app.request('/wp-includes/css/dist/block-library/style-rtl.min.css');
    expect(css.status).toBe(200);
    expect((await ctx.request('GET', '/pressbase/v1/i18n/admin')).body.dir).toBe('rtl');
  });

  it('knows right-to-left languages without a translation of the direction', async () => {
    const ctx = await site();
    expect(ctx.kernel.i18n.isRtl('he_IL')).toBe(true);
    expect(ctx.kernel.i18n.isRtl('de_DE')).toBe(false);
  });
});

describe('plugins', () => {
  it('load their languages/ folder for their text domain (api.i18n)', async () => {
    const ctx = await site();
    const dir = path.join(ctx.dataDir, 'plugins', 'greeter');
    await mkdir(path.join(dir, 'languages'), { recursive: true });
    await writeFile(
      path.join(dir, 'plugin.json'),
      JSON.stringify({ name: 'greeter', title: 'Greeter', version: '1.0.0', main: 'index.js' }),
    );
    await writeFile(
      path.join(dir, 'index.js'),
      `export default function register(api) {
        api.rest.registerRoute('greeter/v1', '/hello', {
          permission: () => true,
          handler: () => ({
            domain: api.i18n.domain,
            locale: api.i18n.locale(),
            text: api.i18n.__('Good morning'),
            context: api.i18n._x('Post', 'verb'),
            count: api.i18n._n('%d tip', '%d tips', 2),
          }),
        });
      }`,
    );
    await writeFile(
      path.join(dir, 'languages', 'greeter-de_DE.po'),
      po('de_DE', [
        ['Good morning', 'Guten Morgen'],
        ['Post', 'Veröffentlichen', 'verb'],
      ]) +
        '\nmsgid "%d tip"\nmsgid_plural "%d tips"\nmsgstr[0] "%d Tipp"\nmsgstr[1] "%d Tipps"\n',
    );
    await german(ctx);
    await ctx.kernel.plugins.activate('greeter');
    const english = await ctx.request('GET', '/greeter/v1/hello');
    expect(english.body).toMatchObject({ domain: 'greeter', text: 'Good morning' });
    await ctx.request('POST', '/wp/v2/settings', { language: 'de_DE' });
    const res = await ctx.request('GET', '/greeter/v1/hello');
    expect(res.body).toEqual({
      domain: 'greeter',
      locale: 'de_DE',
      text: 'Guten Morgen',
      context: 'Veröffentlichen',
      count: '%d Tipps',
    });
    // languages/plugins wins over the plugin's own folder.
    await writeLanguageFile(ctx, 'plugins/greeter-de_DE.po', po('de_DE', [['Good morning', 'Moin']]));
    ctx.kernel.i18n.reloadLocale('de_DE');
    expect((await ctx.request('GET', '/greeter/v1/hello')).body.text).toBe('Moin');
    // Deactivating forgets the plugin's folder.
    await ctx.kernel.plugins.deactivate('greeter');
    ctx.kernel.i18n.reloadLocale('de_DE');
    expect(ctx.kernel.i18n.textdomainFiles('greeter', 'de_DE').some((f) => f.startsWith(dir))).toBe(
      false,
    );
  });
});

describe('language packs (wp_download_language_pack)', () => {
  const CORE_ZIP = createZip([
    { name: 'de_DE.mo', data: compileMo({}, [{ singular: 'Posts', translations: ['Beiträge'] }]) },
    { name: 'de_DE.po', data: new TextEncoder().encode(po('de_DE', [['Posts', 'Beiträge']])) },
    {
      name: `de_DE-${'e'.repeat(32)}.json`,
      data: new TextEncoder().encode(
        JSON.stringify({
          domain: 'messages',
          locale_data: { messages: { '': {}, 'Add block': ['Block hinzufügen'] } },
          comment: { reference: 'wp-includes/js/dist/block-library.js' },
        }),
      ),
    },
    // PHP translation files are never written.
    { name: 'de_DE.l10n.php', data: new TextEncoder().encode('<?php return [];') },
  ]);
  const THEME_ZIP = createZip([
    {
      name: 'twentytwentyfive-de_DE.mo',
      data: compileMo({}, [
        { singular: 'Page not found', context: '404 error message', translations: ['Nicht da'] },
      ]),
    },
  ]);

  function mockNetwork(ctx: Ctx, overrides: Record<string, () => Response> = {}) {
    const requests: string[] = [];
    ctx.kernel.i18n.packs.fetch = async (input) => {
      const url = String(input);
      requests.push(url);
      for (const [prefix, respond] of Object.entries(overrides)) {
        if (url.startsWith(prefix)) return respond();
      }
      if (url.startsWith('https://api.wordpress.org/translations/core/1.0/')) {
        return Response.json({
          translations: [
            {
              language: 'de_DE',
              version: '7.1.3',
              updated: '2026-10-01 00:00:00',
              english_name: 'German',
              native_name: 'Deutsch',
              package: 'https://downloads.wordpress.org/translation/core/7.1.3/de_DE.zip',
              iso: { '1': 'de' },
              strings: { continue: 'Weiter' },
            },
          ],
        });
      }
      if (url.startsWith('https://api.wordpress.org/translations/themes/1.0/')) {
        const slug = new URL(url).searchParams.get('slug');
        return Response.json({
          translations:
            slug === 'twentytwentyfive'
              ? [
                  {
                    language: 'de_DE',
                    version: '1.5',
                    package:
                      'https://downloads.wordpress.org/translation/theme/twentytwentyfive/1.5/de_DE.zip',
                  },
                ]
              : [],
        });
      }
      if (url.endsWith('/core/7.1.3/de_DE.zip')) return new Response(CORE_ZIP);
      if (url.endsWith('/twentytwentyfive/1.5/de_DE.zip')) return new Response(THEME_ZIP);
      return new Response('Not found', { status: 404 });
    };
    return requests;
  }

  it('lists WordPress.org’s translations and caches the list', async () => {
    const ctx = await site();
    const requests = mockNetwork(ctx);
    const res = await ctx.request('GET', '/pressbase/v1/languages/available');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      expect.objectContaining({ language: 'de_DE', native_name: 'Deutsch', installed: false }),
    ]);
    expect(requests[0]).toContain('version=7.1.3');
    await ctx.request('GET', '/pressbase/v1/languages/available');
    expect(requests).toHaveLength(1);
  });

  it('installs a core pack and the themes’ packs, then serves them', async () => {
    const ctx = await site();
    const requests = mockNetwork(ctx);
    const res = await ctx.request('POST', '/pressbase/v1/languages', { language: 'de_DE' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ language: 'de_DE', core: true, themes: ['twentytwentyfive'] });
    expect(res.body.installed.map((l: { language: string }) => l.language)).toEqual([
      'en_US',
      'de_DE',
    ]);
    const files = await readdir(path.join(ctx.dataDir, 'languages'));
    expect(files.sort()).toEqual(['de_DE-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee.json', 'de_DE.mo', 'de_DE.po', 'themes']);
    expect(existsSync(path.join(ctx.dataDir, 'languages', 'themes', 'twentytwentyfive-de_DE.mo'))).toBe(
      true,
    );
    expect(requests.some((r) => r.includes('slug=twentytwentyfive'))).toBe(true);

    expect((await ctx.request('POST', '/wp/v2/settings', { language: 'de_DE' })).status).toBe(200);
    expect(ctx.kernel.i18n.__('Posts')).toBe('Beiträge');
    const editor = await ctx.request('GET', '/pressbase/v1/i18n/editor');
    expect(editor.body.locale_data.default['Add block']).toEqual(['Block hinzufügen']);

    // Installing again doesn't download the core pack.
    const again = await ctx.request('POST', '/pressbase/v1/languages', { language: 'de_DE' });
    expect(again.body.core).toBe(false);
  });

  it('needs install_languages, a known language and WordPress.org’s download host', async () => {
    const ctx = await site();
    mockNetwork(ctx);
    const editor = await ctx.loginAs('ed', 'editor');
    expect((await editor.request('POST', '/pressbase/v1/languages', { language: 'de_DE' })).status).toBe(
      403,
    );
    expect((await ctx.request('POST', '/pressbase/v1/languages', { language: '../x' })).status).toBe(
      400,
    );
    const missing = await ctx.request('POST', '/pressbase/v1/languages', { language: 'fr_FR' });
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('language_not_available');

    const evil = await setup();
    await evil.install();
    mockNetwork(evil, {
      'https://api.wordpress.org/translations/core/': () =>
        Response.json({
          translations: [
            {
              language: 'de_DE',
              version: '7.1.3',
              english_name: 'German',
              native_name: 'Deutsch',
              package: 'https://example.com/de_DE.zip',
            },
          ],
        }),
    });
    const refused = await evil.request('POST', '/pressbase/v1/languages', { language: 'de_DE' });
    expect(refused.status).toBe(400);
    expect(refused.body.message).toMatch(/downloads\.wordpress\.org/);
  });

  it('reports WordPress.org being unreachable', async () => {
    const ctx = await site();
    ctx.kernel.i18n.packs.fetch = async () => {
      throw new Error('getaddrinfo ENOTFOUND');
    };
    const res = await ctx.request('GET', '/pressbase/v1/languages/available');
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('translations_api_failed');
  });
});

describe('capabilities', () => {
  it('grants install_languages to those who can install plugins or themes', async () => {
    const ctx = await site();
    const me = await ctx.request('GET', '/wp/v2/users/me');
    expect(me.body.capabilities.install_languages).toBe(true);
    const editor = await ctx.loginAs('ed', 'editor');
    const res = await editor.request('GET', '/wp/v2/users/me');
    expect(res.body.capabilities.install_languages).toBeUndefined();
  });
});
