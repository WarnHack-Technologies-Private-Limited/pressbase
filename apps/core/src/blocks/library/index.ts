import type { BlockTypeArgs, BlockTypeRegistry, RenderCallback } from '@pressbase/blocks';
import { COMMENT_BLOCK_METADATA } from '../comment-metadata';
import type { BlockServices } from '../helpers';
import { CORE_BLOCK_METADATA } from '../metadata';
import { WORDPRESS_BLOCK_METADATA, WORDPRESS_DYNAMIC_BLOCKS } from '../wordpress-blocks';
import { renderArchives } from './archives';
import { renderBlockReference } from './block';
import {
  renderCommentAuthorName,
  renderCommentContent,
  renderCommentDate,
  renderCommentEditLink,
  renderCommentReplyLink,
  renderComments,
  renderCommentsPagination,
  renderCommentsPaginationNext,
  renderCommentsPaginationNumbers,
  renderCommentsPaginationPrevious,
  renderCommentsTitle,
  renderCommentTemplate,
  renderLatestComments,
  renderPostCommentsForm,
} from './comments';
import { renderLatestPosts } from './latest-posts';
import {
  renderHomeLink,
  renderNavigation,
  renderNavigationLink,
  renderNavigationSubmenu,
} from './navigation';
import { renderPageList } from './page-list';
import {
  renderPostAuthorName,
  renderPostDate,
  renderPostExcerpt,
  renderPostTerms,
  renderPostTitle,
} from './post';
import {
  renderAvatar,
  renderPostAuthor,
  renderPostFeaturedImage,
  renderPostNavigationLink,
  renderReadMore,
  renderSiteLogo,
} from './post-media';
import {
  renderPostTemplate,
  renderQuery,
  renderQueryNoResults,
  renderQueryPagination,
  renderQueryPaginationNext,
  renderQueryPaginationNumbers,
  renderQueryPaginationPrevious,
  renderQueryTitle,
  renderTermDescription,
} from './query';
import { renderSearch } from './search';
import { renderLoginOut, renderSiteTagline, renderSiteTitle } from './site';
import { renderPattern, renderPostContent, renderTemplatePart } from './template';
import { renderCategories, renderTagCloud } from './terms';

/**
 * The server-rendered core blocks — what the register_block_core_*()
 * functions in wordpress/wp-includes/blocks/*.php do on `init`.
 */
const RENDERERS: Record<string, RenderCallback<BlockServices>> = {
  'core/archives': renderArchives,
  'core/block': renderBlockReference,
  'core/categories': renderCategories,
  'core/latest-posts': renderLatestPosts,
  'core/loginout': renderLoginOut,
  'core/page-list': renderPageList,
  'core/post-author-name': renderPostAuthorName,
  'core/post-date': renderPostDate,
  'core/post-excerpt': renderPostExcerpt,
  'core/post-terms': renderPostTerms,
  'core/post-title': renderPostTitle,
  'core/search': renderSearch,
  'core/site-tagline': renderSiteTagline,
  'core/site-title': renderSiteTitle,
  'core/tag-cloud': renderTagCloud,
  // Comments (comment-metadata.ts).
  'core/comments': renderComments,
  'core/comment-template': renderCommentTemplate,
  'core/comment-author-name': renderCommentAuthorName,
  'core/comment-content': renderCommentContent,
  'core/comment-date': renderCommentDate,
  'core/comment-edit-link': renderCommentEditLink,
  'core/comment-reply-link': renderCommentReplyLink,
  'core/comments-title': renderCommentsTitle,
  'core/comments-pagination': renderCommentsPagination,
  'core/comments-pagination-next': renderCommentsPaginationNext,
  'core/comments-pagination-numbers': renderCommentsPaginationNumbers,
  'core/comments-pagination-previous': renderCommentsPaginationPrevious,
  'core/post-comments-form': renderPostCommentsForm,
  'core/latest-comments': renderLatestComments,
};

/**
 * Theme blocks (v0.4): templates, the Query Loop, navigation and post parts.
 * Their metadata comes from WordPress's block.json (wordpress-blocks.ts).
 */
const THEME_RENDERERS: Record<string, RenderCallback<BlockServices>> = {
  'core/avatar': renderAvatar,
  'core/home-link': renderHomeLink,
  'core/navigation': renderNavigation,
  'core/navigation-link': renderNavigationLink,
  'core/navigation-submenu': renderNavigationSubmenu,
  'core/pattern': renderPattern,
  'core/post-author': renderPostAuthor,
  'core/post-content': renderPostContent,
  'core/post-featured-image': renderPostFeaturedImage,
  'core/post-navigation-link': renderPostNavigationLink,
  'core/post-template': renderPostTemplate,
  'core/query': renderQuery,
  'core/query-no-results': renderQueryNoResults,
  'core/query-pagination': renderQueryPagination,
  'core/query-pagination-next': renderQueryPaginationNext,
  'core/query-pagination-numbers': renderQueryPaginationNumbers,
  'core/query-pagination-previous': renderQueryPaginationPrevious,
  'core/query-title': renderQueryTitle,
  'core/read-more': renderReadMore,
  'core/site-logo': renderSiteLogo,
  'core/template-part': renderTemplatePart,
  'core/term-description': renderTermDescription,
};

type Metadata = BlockTypeArgs<BlockServices> & { name: string };

/**
 * Core blocks with a PHP render callback in WordPress that still save their
 * own HTML (the callback only adjusts it): their saved markup is the output.
 */
const SAVES_MARKUP = new Set([
  'core/accordion',
  'core/accordion-item',
  'core/button',
  'core/cover',
  'core/details',
  'core/file',
  'core/gallery',
  'core/heading',
  'core/image',
  'core/list',
  'core/media-text',
  'core/paragraph',
  'core/shortcode',
  'core/tab-panel',
  'core/tabs',
  'core/video',
]);

/** Core blocks WordPress only renders on the server (no saved HTML of their own). */
const serverOnly = (name: string) => WORDPRESS_DYNAMIC_BLOCKS.has(name) && !SAVES_MARKUP.has(name);

export function registerCoreBlocks(registry: BlockTypeRegistry<BlockServices>): void {
  for (const [name, render] of Object.entries(RENDERERS)) {
    const { name: _name, ...metadata } = (CORE_BLOCK_METADATA[name] ??
      COMMENT_BLOCK_METADATA[name] ??
      WORDPRESS_BLOCK_METADATA[name] ?? { name }) as Metadata;
    registry.register(name, { ...metadata, render });
  }
  for (const [name, render] of Object.entries(THEME_RENDERERS)) {
    if (registry.isRegistered(name)) continue;
    const { name: _name, ...metadata } = (WORDPRESS_BLOCK_METADATA[name] ?? { name }) as Metadata;
    registry.register(name, { ...metadata, render });
  }
  // WordPress registers every core block on the server. The static ones
  // (Group, Columns, Buttons…) need their block.json here so block supports
  // such as layout apply when templates render. Core blocks WordPress renders
  // dynamically but Pressbase doesn't yet stay unregistered, so they can be
  // added later (comments, for one) and render nothing meanwhile.
  for (const [name, metadata] of Object.entries(WORDPRESS_BLOCK_METADATA)) {
    if (registry.isRegistered(name) || serverOnly(name)) continue;
    const { name: _name, ...args } = metadata as Metadata;
    registry.register(name, args);
  }
}

/**
 * Core blocks WordPress renders on the server that aren't registered here:
 * their saved markup is only a placeholder, so they render as nothing
 * rather than showing it (see themes/supports.ts).
 */
export function isUnavailableDynamicBlock(
  registry: BlockTypeRegistry<BlockServices>,
  name: string | null,
): boolean {
  return Boolean(name && serverOnly(name) && !registry.isRegistered(name));
}
