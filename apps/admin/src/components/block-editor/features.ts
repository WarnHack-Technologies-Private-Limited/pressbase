import apiFetch from '@wordpress/api-fetch';

/**
 * Optional server features the editor adapts to. Media, the block engine,
 * patterns and oEmbed arrive in separate pieces of work; until a route
 * exists, the editor hides what depends on it instead of failing.
 *
 * A feature is "present" unless core answers `rest_no_route`: a 401/403 still
 * means the route exists (the user just can't use it). Routes in a namespace
 * the REST index doesn't list (oEmbed's `oembed/1.0`) aren't requested at all,
 * so a missing feature doesn't leave a 404 in the browser console.
 */

export interface RestBlockPattern {
  name: string;
  title: string;
  content: string;
  description?: string;
  categories?: string[];
  keywords?: string[];
  block_types?: string[];
  post_types?: string[];
  viewport_width?: number;
  inserter?: boolean;
}

export interface RestPatternCategory {
  name: string;
  label: string;
  description?: string;
}

/** The fields of /wp/v2/block-types the editor reads (WP_REST_Block_Types_Controller). */
export interface RestBlockType {
  name: string;
  title?: string;
  description?: string;
  category?: string | null;
  icon?: string | null;
  keywords?: string[];
  attributes?: Record<string, unknown> | null;
  supports?: Record<string, unknown>;
  uses_context?: string[];
  provides_context?: Record<string, string>;
  parent?: string[] | null;
  ancestor?: string[] | null;
  is_dynamic?: boolean;
}

/** A synced pattern: a `wp_block` post from /wp/v2/blocks. */
export interface RestSyncedPattern {
  id: number;
  title: { raw?: string; rendered?: string };
  content: { raw?: string };
  wp_pattern_sync_status?: string;
}

export interface EditorFeatures {
  /** POST /wp/v2/media exists. */
  media: boolean;
  /** /wp/v2/block-renderer exists, so dynamic blocks can render. */
  blockRenderer: boolean;
  /** Server block types (/wp/v2/block-types), or null without the block engine. */
  blockTypes: RestBlockType[] | null;
  patterns: RestBlockPattern[];
  patternCategories: RestPatternCategory[];
  /** Synced patterns (/wp/v2/blocks), or null when the route doesn't exist. */
  syncedPatterns: RestSyncedPattern[] | null;
  /** /oembed/1.0/proxy exists, so embeds can preview. */
  oembed: boolean;
  /** /wp/v2/navigation exists (wp_navigation menus), so the Navigation block can work. */
  navigation: boolean;
}

export const NO_FEATURES: EditorFeatures = {
  media: false,
  blockRenderer: false,
  blockTypes: null,
  patterns: [],
  patternCategories: [],
  syncedPatterns: null,
  oembed: false,
  navigation: false,
};

type Probe<T> = { exists: boolean; data?: T };

/** GET a route; `exists` is false only for "no route", data only on success. */
export async function probe<T>(path: string): Promise<Probe<T>> {
  try {
    return { exists: true, data: await apiFetch<T>({ path }) };
  } catch (error) {
    const code = (error as { code?: string } | undefined)?.code;
    // Network failures and HTML error pages are treated as "not available".
    if (code === 'rest_no_route' || code === 'fetch_error' || code === 'invalid_json') {
      return { exists: false };
    }
    return { exists: true };
  }
}

/** The parts of the REST index (GET /wp-json/) the probes read. */
export interface RestIndex {
  namespaces?: string[];
}

/**
 * Whether a route's namespace is served. Without an index (an error, an old
 * core) every namespace counts as served, so the route itself is probed.
 */
export function namespaceListed(index: RestIndex | undefined, path: string): boolean {
  if (!Array.isArray(index?.namespaces)) return true;
  const [vendor = '', version = ''] = path.replace(/^\/+/, '').split(/[/?]/);
  return index.namespaces.includes(`${vendor}/${version}`);
}

let cached: Promise<EditorFeatures> | undefined;

/** Probes once per page load; every editor mount shares the answer. */
export function loadEditorFeatures(): Promise<EditorFeatures> {
  cached ??= (async () => {
    const index = apiFetch<RestIndex>({ path: '/' }).catch(() => undefined);
    const probeListed = async (path: string): Promise<Probe<unknown>> =>
      namespaceListed(await index, path) ? probe(path) : { exists: false };
    const [media, renderer, types, patterns, categories, synced, oembed, navigation] =
      await Promise.all([
        probe('/wp/v2/media?per_page=1'),
        probe('/wp/v2/block-renderer/core/archives?context=edit'),
        probe<RestBlockType[]>('/wp/v2/block-types?context=edit'),
        probe<RestBlockPattern[]>('/wp/v2/block-patterns/patterns'),
        probe<RestPatternCategory[]>('/wp/v2/block-patterns/categories'),
        probe<RestSyncedPattern[]>('/wp/v2/blocks?per_page=100&context=edit'),
        probeListed('/oembed/1.0/proxy'),
        // Navigation menus (v0.4). A 401/403 still means the route exists.
        probe('/wp/v2/navigation?per_page=1'),
      ]);
    return {
      media: media.exists,
      blockRenderer: renderer.exists,
      blockTypes: types.exists ? (types.data ?? []) : null,
      patterns: Array.isArray(patterns.data) ? patterns.data : [],
      patternCategories: Array.isArray(categories.data) ? categories.data : [],
      syncedPatterns: synced.exists ? (Array.isArray(synced.data) ? synced.data : []) : null,
      oembed: oembed.exists,
      navigation: navigation.exists,
    };
  })();
  return cached;
}

/** Test hook: forget the cached answer. */
export function resetEditorFeatures(): void {
  cached = undefined;
}

/**
 * REST patterns use snake_case; the block editor expects camelCase, as
 * core-data's getBlockPatterns() resolver produces.
 */
export function toEditorPattern(pattern: RestBlockPattern) {
  return {
    name: pattern.name,
    title: pattern.title,
    content: pattern.content,
    description: pattern.description,
    categories: pattern.categories ?? [],
    keywords: pattern.keywords ?? [],
    blockTypes: pattern.block_types ?? [],
    postTypes: pattern.post_types,
    viewportWidth: pattern.viewport_width,
    inserter: pattern.inserter ?? true,
  };
}
