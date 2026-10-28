import type { PluginApi } from '@pressbase/plugin-sdk';
import {
  type OwnSettings,
  SOCIAL_DEFAULTS,
  TITLE_DEFAULTS,
  WPSEO_DEFAULTS,
  type Wpseo,
  type WpseoSocial,
  type WpseoTitles,
} from './shared';

/**
 * Reading the plugin's settings: Yoast's three options merged over their
 * defaults, the plugin's own options, and the site options it needs.
 * `api.siteOptions` needs the `options` permission (plugin.json).
 */

export const CACHE_TAG = 'pressbase-seo:settings';

export function siteOptions(api: PluginApi) {
  const options = api.siteOptions;
  if (!options) throw new Error('Pressbase SEO needs the options permission.');
  return options;
}

async function merged<T extends object>(api: PluginApi, name: string, defaults: T): Promise<T> {
  const stored = await siteOptions(api).get<unknown>(name, {});
  return {
    ...defaults,
    ...(stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {}),
  } as T;
}

export const getTitles = (api: PluginApi) =>
  merged<WpseoTitles>(api, 'wpseo_titles', TITLE_DEFAULTS);
export const getSocial = (api: PluginApi) =>
  merged<WpseoSocial>(api, 'wpseo_social', SOCIAL_DEFAULTS);
export const getWpseo = (api: PluginApi) => merged<Wpseo>(api, 'wpseo', WPSEO_DEFAULTS);

/** `pressbase_seo_settings`: one object, so the settings page has no generic fields. */
export const OWN_OPTION = 'pressbase_seo_settings';
export const OWN_DEFAULTS: OwnSettings = {
  robots_txt: '',
  indexnow: null,
  setup_done: false,
  auto_redirects: true,
};

export async function getOwn(api: PluginApi): Promise<OwnSettings> {
  const stored = await api.options.get<unknown>('settings', {});
  const own = { ...OWN_DEFAULTS, ...(stored && typeof stored === 'object' ? stored : {}) };
  return {
    robots_txt: typeof own.robots_txt === 'string' ? own.robots_txt : '',
    indexnow: typeof own.indexnow === 'boolean' ? own.indexnow : null,
    setup_done: own.setup_done === true,
    auto_redirects: own.auto_redirects !== false,
  };
}

export interface Site {
  home: string;
  name: string;
  description: string;
  public: boolean;
  locale: string;
  permalinkStructure: string;
}

export async function getSite(api: PluginApi): Promise<Site> {
  const options = siteOptions(api);
  return {
    home: String(await options.get<string>('home', '')).replace(/\/+$/, ''),
    name: String(await options.get<string>('blogname', '')),
    description: String(await options.get<string>('blogdescription', '')),
    public: Boolean(await options.get<boolean>('blog_public', true)),
    locale: api.i18n.locale(),
    permalinkStructure: String(await options.get<string>('permalink_structure', '')),
  };
}

/** IndexNow is on by default only while the site lets search engines in. */
export function indexNowEnabled(own: OwnSettings, site: Site): boolean {
  return own.indexnow ?? site.public;
}
