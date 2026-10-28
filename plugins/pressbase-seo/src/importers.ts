import type { PluginApi } from '@pressbase/plugin-sdk';
import { META, type MetaName } from './shared';
import { aioseoToYoast, rankMathToYoast } from './vars';

/**
 * One-time imports from other SEO plugins' post and term meta into Yoast's
 * keys (Tools → SEO → Import). Yoast's own data needs no import. Values
 * already set in Yoast's keys are kept: an import never overwrites.
 *
 * - Rank Math: `rank_math_*` meta, with `%var%` variables.
 * - All in One SEO: the post meta copies AIOSEO 4 keeps (`_aioseo_*`) and
 *   AIOSEO 3's `_aioseop_*`, with `#tag` variables. AIOSEO 4's own table
 *   (`wp_aioseo_posts`) isn't part of a WordPress export, so it isn't read.
 */

export type ImportSource = 'rankmath' | 'aioseo';

type Converter = (value: unknown) => string | undefined;

const text =
  (convert: (s: string) => string = (s) => s): Converter =>
  (value) => {
    if (typeof value !== 'string' && typeof value !== 'number') return undefined;
    const s = String(value).trim();
    return s ? convert(s) : undefined;
  };

/** Rank Math's robots meta: a list (or PHP-serialised list) of directives. */
const robotsHas =
  (directive: string): Converter =>
  (value) => {
    const s = Array.isArray(value) ? value.join(',') : String(value ?? '');
    return new RegExp(`\\b${directive}\\b`).test(s) ? '1' : undefined;
  };

const onOff: Converter = (value) =>
  value === 'on' || value === '1' || value === true || value === 1 ? '1' : undefined;

const firstKeyword: Converter = (value) => text()(String(value ?? '').split(',')[0]);

type Mapping = [source: string, target: MetaName, convert: Converter][];

export const MAPPINGS: Record<ImportSource, Mapping> = {
  rankmath: [
    ['rank_math_title', 'title', text(rankMathToYoast)],
    ['rank_math_description', 'metadesc', text(rankMathToYoast)],
    ['rank_math_focus_keyword', 'focuskw', firstKeyword],
    ['rank_math_canonical_url', 'canonical', text()],
    ['rank_math_robots', 'noindex', robotsHas('noindex')],
    ['rank_math_robots', 'nofollow', robotsHas('nofollow')],
    ['rank_math_facebook_title', 'ogTitle', text(rankMathToYoast)],
    ['rank_math_facebook_description', 'ogDescription', text(rankMathToYoast)],
    ['rank_math_facebook_image', 'ogImage', text()],
    ['rank_math_facebook_image_id', 'ogImageId', text()],
    ['rank_math_twitter_title', 'twitterTitle', text(rankMathToYoast)],
    ['rank_math_twitter_description', 'twitterDescription', text(rankMathToYoast)],
    ['rank_math_twitter_image', 'twitterImage', text()],
    ['rank_math_twitter_image_id', 'twitterImageId', text()],
    ['rank_math_primary_category', 'primaryCategory', text()],
    ['rank_math_breadcrumb_title', 'bctitle', text()],
    ['rank_math_pillar_content', 'cornerstone', onOff],
  ],
  aioseo: [
    ['_aioseo_title', 'title', text(aioseoToYoast)],
    ['_aioseop_title', 'title', text(aioseoToYoast)],
    ['_aioseo_description', 'metadesc', text(aioseoToYoast)],
    ['_aioseop_description', 'metadesc', text(aioseoToYoast)],
    ['_aioseo_keywords', 'focuskw', firstKeyword],
    ['_aioseop_keywords', 'focuskw', firstKeyword],
    ['_aioseop_custom_link', 'canonical', text()],
    ['_aioseop_noindex', 'noindex', onOff],
    ['_aioseop_nofollow', 'nofollow', onOff],
    ['_aioseo_og_title', 'ogTitle', text(aioseoToYoast)],
    ['_aioseo_og_description', 'ogDescription', text(aioseoToYoast)],
    ['_aioseo_twitter_title', 'twitterTitle', text(aioseoToYoast)],
    ['_aioseo_twitter_description', 'twitterDescription', text(aioseoToYoast)],
  ],
};

export interface ImportResult {
  posts: number;
  terms: number;
  fields: number;
}

async function importObject(
  api: PluginApi,
  type: 'post' | 'term',
  id: number,
  mapping: Mapping,
): Promise<number> {
  let fields = 0;
  const done = new Set<MetaName>();
  for (const [source, target, convert] of mapping) {
    if (done.has(target)) continue;
    const raw = await api.meta.get(type, id, source, true);
    if (raw === undefined || raw === null || raw === '') continue;
    const value = convert(raw);
    if (value === undefined) continue;
    const current = await api.meta.get(type, id, META[target], true);
    done.add(target);
    if (current !== undefined && current !== null && current !== '') continue;
    await api.meta.update(type, id, META[target], value);
    fields++;
  }
  return fields;
}

export async function runImport(api: PluginApi, source: ImportSource): Promise<ImportResult> {
  const mapping = MAPPINGS[source];
  const result: ImportResult = { posts: 0, terms: 0, fields: 0 };
  for (let page = 1; ; page++) {
    const { posts, maxPages } = await api.content.query({
      post_type: ['post', 'page'],
      post_status: 'any',
      orderby: 'id',
      order: 'ASC',
      posts_per_page: 200,
      paged: page,
    });
    for (const post of posts) {
      const n = await importObject(api, 'post', post.id, mapping);
      if (n) {
        result.posts++;
        result.fields += n;
      }
    }
    if (page >= maxPages || !posts.length) break;
  }
  for (const taxonomy of ['category', 'post_tag']) {
    for (let page = 1; ; page++) {
      const { terms, total } = await api.content.terms.list(taxonomy, { perPage: 200, page });
      for (const term of terms) {
        const n = await importObject(api, 'term', term.id, mapping);
        if (n) {
          result.terms++;
          result.fields += n;
        }
      }
      if (page * 200 >= total || !terms.length) break;
    }
  }
  await api.cache.purge(['site']);
  return result;
}
