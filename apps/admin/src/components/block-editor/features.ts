import apiFetch from '@wordpress/api-fetch';

/**
 * Optional server features the editor adapts to. Media, the block engine,
 * patterns and oEmbed arrive in separate pieces of work; until a route
 * exists, the editor hides what depends on it instead of failing.
 *
 * A feature is "present" unless core answers `rest_no_route`: a 401/403 still
 * means the route exists (the user just can't use it).
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
}

export const NO_FEATURES: EditorFeatures = {
  media: false,
  blockRenderer: false,
  blockTypes: null,
  patterns: [],
  patternCategories: [],
  syncedPatterns: null,
  oembed: false,
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

let cached: Promise<EditorFeatures> | undefined;

/** Probes once per page load; every editor mount shares the answer. */
export function loadEditorFeatures(): Promise<EditorFeatures> {
  cached ??= (async () => {
    const [media, renderer, types, patterns, categories, synced, oembed] = await Promise.all([
      probe('/wp/v2/media?per_page=1'),
      probe('/wp/v2/block-renderer/core/archives?context=edit'),
      probe<RestBlockType[]>('/wp/v2/block-types?context=edit'),
      probe<RestBlockPattern[]>('/wp/v2/block-patterns/patterns'),
      probe<RestPatternCategory[]>('/wp/v2/block-patterns/categories'),
      probe<RestSyncedPattern[]>('/wp/v2/blocks?per_page=100&context=edit'),
      probe('/oembed/1.0/proxy'),
    ]);
    return {
      media: media.exists,
      blockRenderer: renderer.exists,
      blockTypes: types.exists ? (types.data ?? []) : null,
      patterns: Array.isArray(patterns.data) ? patterns.data : [],
      patternCategories: Array.isArray(categories.data) ? categories.data : [],
      syncedPatterns: synced.exists ? (Array.isArray(synced.data) ? synced.data : []) : null,
      oembed: oembed.exists,
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
