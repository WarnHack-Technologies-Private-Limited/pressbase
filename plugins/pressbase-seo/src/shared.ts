/**
 * What the server and the admin modules share: Yoast SEO's meta keys,
 * option shapes and defaults. Pressbase SEO stores its data exactly where
 * Yoast does, so a site migrated from WordPress keeps its titles,
 * descriptions, canonicals and robots settings with no conversion.
 *
 * Yoast's keys come from its source (`WPSEO_Meta`, `WPSEO_Option_Titles`,
 * `WPSEO_Option_Social`, `WPSEO_Option_Wpseo`) as of Yoast SEO 25/26. Where
 * Pressbase needs something Yoast doesn't store, it uses its own option
 * (`pressbase_seo_*`) instead of inventing Yoast keys.
 */

export const SLUG = 'pressbase-seo';

/** Post meta, `_yoast_wpseo_{name}`. */
export const META = {
  title: '_yoast_wpseo_title',
  metadesc: '_yoast_wpseo_metadesc',
  focuskw: '_yoast_wpseo_focuskw',
  canonical: '_yoast_wpseo_canonical',
  /** '1' noindex, '2' index, '0' or missing: the post type's default. */
  noindex: '_yoast_wpseo_meta-robots-noindex',
  /** '1' nofollow, '0' or missing: follow. */
  nofollow: '_yoast_wpseo_meta-robots-nofollow',
  /** Comma-separated: noimageindex, noarchive, nosnippet ('-' or '' for none). */
  adv: '_yoast_wpseo_meta-robots-adv',
  ogTitle: '_yoast_wpseo_opengraph-title',
  ogDescription: '_yoast_wpseo_opengraph-description',
  ogImage: '_yoast_wpseo_opengraph-image',
  ogImageId: '_yoast_wpseo_opengraph-image-id',
  twitterTitle: '_yoast_wpseo_twitter-title',
  twitterDescription: '_yoast_wpseo_twitter-description',
  twitterImage: '_yoast_wpseo_twitter-image',
  twitterImageId: '_yoast_wpseo_twitter-image-id',
  primaryCategory: '_yoast_wpseo_primary_category',
  bctitle: '_yoast_wpseo_bctitle',
  /** '1' when the post is cornerstone content. */
  cornerstone: '_yoast_wpseo_is_cornerstone',
} as const;

export type MetaName = keyof typeof META;
export type SeoMeta = Partial<Record<MetaName, string>>;

/**
 * Term meta uses the same keys. (Yoast itself keeps term data in one option,
 * `wpseo_taxonomy_meta`, keyed `wpseo_title`, `wpseo_desc`…; Pressbase's MySQL
 * migration moves that onto each term as `_yoast_wpseo_*` term meta, which is
 * what's read here. The `wpseo_noindex` value there is 'noindex'/'index'/'default'
 * and is migrated to '1'/'2'/'0'.)
 */
export const TERM_META_NAMES: MetaName[] = [
  'title',
  'metadesc',
  'focuskw',
  'canonical',
  'noindex',
  'ogTitle',
  'ogDescription',
  'ogImage',
  'ogImageId',
  'twitterTitle',
  'twitterDescription',
  'twitterImage',
  'twitterImageId',
  'bctitle',
  'cornerstone',
];

/** Yoast's separator options (`wpseo_titles.separator`) and what each prints. */
export const SEPARATORS: Record<string, string> = {
  'sc-dash': '-',
  'sc-ndash': '–',
  'sc-mdash': '—',
  'sc-colon': ':',
  'sc-middot': '·',
  'sc-bull': '•',
  'sc-star': '*',
  'sc-smstar': '⋆',
  'sc-pipe': '|',
  'sc-tilde': '~',
  'sc-laquo': '«',
  'sc-raquo': '»',
  'sc-lt': '<',
  'sc-gt': '>',
};

export function separatorText(key: unknown): string {
  return (typeof key === 'string' && SEPARATORS[key]) || SEPARATORS['sc-dash'] || '-';
}

/** `wpseo_titles`: templates and search appearance. Only the keys Pressbase reads are typed. */
export interface WpseoTitles {
  separator: string;
  'title-home-wpseo': string;
  'metadesc-home-wpseo': string;
  'title-author-wpseo': string;
  'metadesc-author-wpseo': string;
  'noindex-author-wpseo': boolean;
  'disable-author': boolean;
  'title-archive-wpseo': string;
  'metadesc-archive-wpseo': string;
  'noindex-archive-wpseo': boolean;
  'disable-date': boolean;
  'title-search-wpseo': string;
  'title-404-wpseo': string;
  'noindex-attachment': boolean;
  'disable-attachment': boolean;
  /** 'company' or 'person'. */
  company_or_person: 'company' | 'person';
  company_name: string;
  company_logo: string;
  company_logo_id: number;
  company_or_person_user_id: number;
  person_logo: string;
  person_logo_id: number;
  website_name: string;
  alternate_website_name: string;
  'breadcrumbs-sep': string;
  'breadcrumbs-home': string;
  'breadcrumbs-searchprefix': string;
  'breadcrumbs-404crumb': string;
  'breadcrumbs-archiveprefix': string;
  /** `title-{type}`, `metadesc-{type}`, `noindex-{type}`, `title-tax-{tax}`… */
  [key: string]: unknown;
}

export const TITLE_DEFAULTS: WpseoTitles = {
  separator: 'sc-dash',
  'title-home-wpseo': '%%sitename%% %%page%% %%sep%% %%sitedesc%%',
  'metadesc-home-wpseo': '',
  'title-author-wpseo': '%%name%%, Author at %%sitename%% %%page%%',
  'metadesc-author-wpseo': '',
  'noindex-author-wpseo': false,
  'disable-author': false,
  'title-archive-wpseo': '%%date%% %%page%% %%sep%% %%sitename%%',
  'metadesc-archive-wpseo': '',
  'noindex-archive-wpseo': false,
  'disable-date': false,
  'title-search-wpseo': 'You searched for %%searchphrase%% %%page%% %%sep%% %%sitename%%',
  'title-404-wpseo': 'Page not found %%sep%% %%sitename%%',
  'noindex-attachment': true,
  'disable-attachment': true,
  company_or_person: 'company',
  company_name: '',
  company_logo: '',
  company_logo_id: 0,
  company_or_person_user_id: 0,
  person_logo: '',
  person_logo_id: 0,
  website_name: '',
  alternate_website_name: '',
  'breadcrumbs-sep': '»',
  'breadcrumbs-home': 'Home',
  'breadcrumbs-searchprefix': 'You searched for',
  'breadcrumbs-404crumb': 'Error 404: Page not found',
  'breadcrumbs-archiveprefix': 'Archives for',
};

/** The default templates Yoast uses for a post type or taxonomy without its own. */
export const POST_TYPE_TITLE = '%%title%% %%page%% %%sep%% %%sitename%%';
export const TAXONOMY_TITLE = '%%term_title%% Archives %%page%% %%sep%% %%sitename%%';

/** wpseo_titles values for a post type, with Yoast's defaults. */
export function postTypeAppearance(titles: Partial<WpseoTitles>, type: string) {
  return {
    title: str(titles[`title-${type}`], POST_TYPE_TITLE),
    metadesc: str(titles[`metadesc-${type}`], ''),
    noindex:
      type === 'attachment'
        ? bool(titles['noindex-attachment'], true)
        : bool(titles[`noindex-${type}`], false),
  };
}

/** wpseo_titles values for a taxonomy (`title-tax-category`…). */
export function taxonomyAppearance(titles: Partial<WpseoTitles>, taxonomy: string) {
  return {
    title: str(titles[`title-tax-${taxonomy}`], TAXONOMY_TITLE),
    metadesc: str(titles[`metadesc-tax-${taxonomy}`], ''),
    noindex: bool(titles[`noindex-tax-${taxonomy}`], taxonomy === 'post_format'),
  };
}

/** `wpseo_social` */
export interface WpseoSocial {
  opengraph: boolean;
  twitter: boolean;
  twitter_card_type: 'summary' | 'summary_large_image';
  og_default_image: string;
  og_default_image_id: number;
  og_frontpage_title: string;
  og_frontpage_desc: string;
  facebook_site: string;
  twitter_site: string;
  other_social_urls: string[];
  [key: string]: unknown;
}

export const SOCIAL_DEFAULTS: WpseoSocial = {
  opengraph: true,
  twitter: true,
  twitter_card_type: 'summary_large_image',
  og_default_image: '',
  og_default_image_id: 0,
  og_frontpage_title: '',
  og_frontpage_desc: '',
  facebook_site: '',
  twitter_site: '',
  other_social_urls: [],
};

/** `wpseo`: feature toggles. */
export interface Wpseo {
  enable_xml_sitemap: boolean;
  /** Yoast added llms.txt in 2025 under this key. */
  enable_llms_txt: boolean;
  keyword_analysis_active: boolean;
  [key: string]: unknown;
}

export const WPSEO_DEFAULTS: Wpseo = {
  enable_xml_sitemap: true,
  enable_llms_txt: false,
  keyword_analysis_active: true,
};

/**
 * Pressbase SEO's own settings (stored as `pressbase_seo_{name}`), for what
 * Yoast keeps elsewhere (its robots.txt editor writes a file) or doesn't have.
 */
export interface OwnSettings {
  /** Lines added to robots.txt. */
  robots_txt: string;
  /** null until the site owner decides: then on unless search engines are discouraged. */
  indexnow: boolean | null;
  setup_done: boolean;
  /** Add a 301 when a published post's address changes. */
  auto_redirects: boolean;
}

/** The settings the admin page reads and saves, in one object. */
export interface SettingsPayload {
  titles: WpseoTitles;
  social: WpseoSocial;
  wpseo: Wpseo;
  own: OwnSettings & { indexnow_effective: boolean; indexnow_key: string };
  site: {
    name: string;
    description: string;
    home: string;
    public: boolean;
    postTypes: { name: string; label: string }[];
    taxonomies: { name: string; label: string }[];
  };
}

export function str(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

export function bool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (value === 'on' || value === '1' || value === 1) return true;
  if (value === 'off' || value === '0' || value === 0 || value === '') return false;
  return fallback;
}

/** Robots meta from Yoast's post meta and the type's default: index? follow? extra directives. */
export function metaRobots(meta: SeoMeta, typeNoindex: boolean) {
  const noindexValue = meta.noindex ?? '0';
  const index = noindexValue === '1' ? false : noindexValue === '2' ? true : !typeNoindex;
  const follow = meta.nofollow !== '1';
  const adv = (meta.adv ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => ['noimageindex', 'noarchive', 'nosnippet'].includes(s));
  return { index, follow, adv };
}
