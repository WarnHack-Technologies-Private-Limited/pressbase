import type { EditorFeatures } from './features';

/**
 * Which blocks the inserter offers. Every core block stays *registered*, so
 * existing content always parses and renders; blocks that can't work yet are
 * only left out of the inserter (the editor's `allowedBlockTypes` setting).
 */

/** Blocks the post editor doesn't support in v0.3, whatever the server offers. */
export const UNSUPPORTED_BLOCKS: ReadonlySet<string> = new Set([
  // Needs TinyMCE (wp.oldEditor). Raw HTML opens as a Custom HTML block instead.
  'core/freeform',
  // Stores its notes in post meta through core-data's entity editing.
  'core/footnotes',
  // Navigation menus and site editing arrive with themes (v0.4).
  'core/navigation',
  'core/navigation-link',
  'core/navigation-submenu',
  'core/navigation-overlay-close',
  'core/home-link',
  'core/page-list',
  'core/page-list-item',
  'core/template-part',
  'core/post-content',
  'core/pattern',
  'core/site-logo',
  'core/site-title',
  'core/site-tagline',
  // Comments have no REST endpoints yet.
  'core/comments',
  'core/comment-template',
  'core/comment-author-avatar',
  'core/comment-author-name',
  'core/comment-content',
  'core/comment-date',
  'core/comment-edit-link',
  'core/comment-reply-link',
  'core/comments-title',
  'core/comments-pagination',
  'core/comments-pagination-next',
  'core/comments-pagination-numbers',
  'core/comments-pagination-previous',
  'core/post-comment',
  'core/post-comments-count',
  'core/post-comments-form',
  'core/post-comments-link',
  'core/latest-comments',
]);

/**
 * Core blocks rendered on the server (no saved HTML): they need the block
 * engine (`/wp/v2/block-renderer`) to show anything on the site.
 * From block-library: the blocks without a `save` function, plus containers
 * that only make sense with them.
 */
export const DYNAMIC_BLOCKS: ReadonlySet<string> = new Set([
  'core/archives',
  'core/avatar',
  'core/breadcrumbs',
  'core/calendar',
  'core/categories',
  'core/icon',
  'core/latest-posts',
  'core/loginout',
  'core/playlist',
  'core/playlist-track',
  'core/query',
  'core/post-template',
  'core/query-no-results',
  'core/query-pagination',
  'core/query-pagination-next',
  'core/query-pagination-numbers',
  'core/query-pagination-previous',
  'core/query-title',
  'core/query-total',
  'core/post-title',
  'core/post-excerpt',
  'core/post-featured-image',
  'core/post-date',
  'core/post-author',
  'core/post-author-name',
  'core/post-author-biography',
  'core/post-terms',
  'core/post-navigation-link',
  'core/post-time-to-read',
  'core/read-more',
  'core/rss',
  'core/search',
  'core/social-links',
  'core/social-link',
  'core/table-of-contents',
  'core/tag-cloud',
  'core/terms-query',
  'core/term-template',
  'core/term-count',
  'core/term-description',
  'core/term-name',
]);

/** The server features `unavailableReason()` looks at. */
export type BlockFeatures = Pick<EditorFeatures, 'blockRenderer' | 'oembed' | 'syncedPatterns'> &
  Partial<Pick<EditorFeatures, 'blockTypes'>>;

/**
 * Why a block is left out of the inserter, or null when it's offered.
 *
 * Dynamic core blocks need the block engine, and once core reports its block
 * types, only the ones it can actually render are offered: a Query Loop the
 * server can't render would preview as an error and publish as nothing.
 * Static blocks (image, gallery, cover, media & text, file, audio, video…)
 * are always offered; without the media library they still take URLs.
 */
export function unavailableReason(name: string, features: BlockFeatures): string | null {
  if (UNSUPPORTED_BLOCKS.has(name)) return 'not supported in the post editor yet';
  if (DYNAMIC_BLOCKS.has(name)) {
    if (!features.blockRenderer) return 'needs the block engine';
    if (features.blockTypes && !features.blockTypes.some((type) => type.name === name)) {
      return 'not rendered by the server yet';
    }
  }
  if (name === 'core/embed' && !features.oembed) return 'needs the oEmbed proxy';
  if (name === 'core/block' && features.syncedPatterns === null) return 'needs synced patterns';
  return null;
}

/** The `allowedBlockTypes` editor setting. */
export function allowedBlockTypes(
  registered: readonly string[],
  features: BlockFeatures,
): string[] {
  return registered.filter((name) => unavailableReason(name, features) === null);
}

/** Words in a piece of block markup, for the "N words · M min read" line. */
export function countWords(markup: string): number {
  const text = markup
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&[a-z0-9#]+;/gi, 'x');
  return text.split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
}

/** About 230 words a minute, never less than one. */
export const readingMinutes = (words: number) => Math.max(1, Math.round(words / 230));
