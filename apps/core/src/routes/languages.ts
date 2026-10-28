import { createHash } from 'node:crypto';
import { type Context, Hono, type MiddlewareHandler } from 'hono';
import { z } from 'zod';
import {
  type AppEnv,
  invalidParams,
  readJson,
  requireCapability,
  requireInstalled,
  restError,
} from '../http';
import { ADMIN_DOMAIN } from '../i18n/l10n';
import { installedLanguages, LanguagePackError } from '../i18n/language-packs';
import { localeToLang } from '../i18n/locale';

/**
 * Languages and translations over REST. WordPress has no REST routes for
 * these; its admin screens call the PHP functions directly.
 *
 * - `/pressbase/v1/i18n/admin`: the admin's own strings (`pressbase-admin`)
 *   for `@wordpress/i18n`, in the request's locale (`?_locale=user` for the
 *   user's). Public, and served before installation (in English), because
 *   the login screen and the installer need it.
 * - `/pressbase/v1/i18n/editor`: the block editor's translations, as
 *   wp_set_script_translations() prints them for Gutenberg's scripts.
 * - `/pressbase/v1/languages`: installed languages (get_available_languages(),
 *   for the language selects), WordPress.org's packs, and installing one
 *   (wp_download_language_pack(), `install_languages`).
 */

/**
 * determine_locale() for every REST request: the locale travels with the
 * request (AsyncLocalStorage), so `kernel.i18n.__()` anywhere below
 * translates into it.
 */
export const requestLocale: MiddlewareHandler<AppEnv> = async (c, next) => {
  const kernel = c.get('kernel');
  const locale = await kernel.i18n.localeForRequest({
    user: c.get('user') ?? null,
    query: { _locale: c.req.query('_locale'), wp_lang: c.req.query('wp_lang') },
  });
  await kernel.i18n.withLocale(locale, () => next());
};

/** A JSON response with an ETag, answered with 304 when the client has it. */
function cachedJson(c: Context<AppEnv>, body: unknown) {
  const json = JSON.stringify(body);
  const etag = `"${createHash('sha1').update(json).digest('base64url')}"`;
  c.header('ETag', etag);
  c.header('Cache-Control', 'private, no-cache');
  c.header('Vary', 'Cookie');
  if (c.req.header('if-none-match') === etag) return c.body(null, 304);
  return c.body(json, 200, { 'content-type': 'application/json; charset=UTF-8' });
}

export function i18nRoutes() {
  const app = new Hono<AppEnv>({ strict: false });

  app.get('/admin', (c) => {
    const i18n = c.get('kernel').i18n;
    const locale = i18n.determineLocale();
    return cachedJson(c, {
      locale,
      lang: localeToLang(locale),
      dir: i18n.isRtl(locale) ? 'rtl' : 'ltr',
      locale_data: {
        [ADMIN_DOMAIN]: i18n.jedLocaleData(ADMIN_DOMAIN, locale, i18n.catalogue(ADMIN_DOMAIN)),
      },
    });
  });

  app.get('/editor', requireInstalled, async (c) => {
    const i18n = c.get('kernel').i18n;
    const locale = i18n.determineLocale();
    return cachedJson(c, {
      locale,
      lang: localeToLang(locale),
      dir: i18n.isRtl(locale) ? 'rtl' : 'ltr',
      locale_data: { default: await i18n.scriptTranslations(locale) },
    });
  });

  return app;
}

const installBody = z.object({
  language: z.string().regex(/^[a-z]{2,3}(?:_[A-Z]{2})?(?:_[a-z0-9]+)?$/, {
    message: 'Choose a language from the list.',
  }),
});

export function languagesRoutes() {
  const app = new Hono<AppEnv>({ strict: false });

  // Every signed-in user picks their own language on Profile.
  app.get('/', requireCapability('read'), async (c) => {
    const kernel = c.get('kernel');
    const user = c.get('user');
    const cached = await kernel.options.get<Record<string, never> | null>(
      '_site_transient_available_translations',
      null,
    );
    return c.json({
      site_language: kernel.i18n.getLocale(),
      installed: await installedLanguages(kernel, cached),
      can_install: Boolean(user?.capabilities.install_languages),
    });
  });

  // wp_get_available_translations(): needs the network.
  app.get('/available', requireCapability('install_languages'), async (c) => {
    const kernel = c.get('kernel');
    try {
      const available = await kernel.i18n.packs.available();
      const installed = new Set(kernel.i18n.getAvailableLanguages());
      return c.json(
        Object.values(available)
          .map((t) => ({
            language: t.language,
            english_name: t.english_name,
            native_name: t.native_name,
            version: t.version,
            updated: t.updated,
            installed: installed.has(t.language) && kernel.i18n.hasCorePack(t.language),
          }))
          .sort((a, b) => a.english_name.localeCompare(b.english_name)),
      );
    } catch (error) {
      if (error instanceof LanguagePackError) {
        return restError(c, error.status as 502, error.code, error.message);
      }
      throw error;
    }
  });

  // wp_download_language_pack(): an explicit administrator action.
  app.post('/', requireCapability('install_languages'), async (c) => {
    const kernel = c.get('kernel');
    const parsed = installBody.safeParse(await readJson(c));
    if (!parsed.success) return invalidParams(c, parsed.error);
    try {
      const result = await kernel.i18n.packs.install(parsed.data.language);
      const cached = await kernel.options.get<Record<string, never> | null>(
        '_site_transient_available_translations',
        null,
      );
      return c.json({ ...result, installed: await installedLanguages(kernel, cached) });
    } catch (error) {
      if (error instanceof LanguagePackError) {
        return restError(c, error.status as 400, error.code, error.message);
      }
      throw error;
    }
  });

  return app;
}
