import type { BlockTypeArgs, BlockTypeRegistry, RenderCallback } from '@pressbase/blocks';
import type { BlockServices } from '../helpers';
import { CORE_BLOCK_METADATA } from '../metadata';
import { renderArchives } from './archives';
import { renderBlockReference } from './block';
import { renderLatestPosts } from './latest-posts';
import { renderPageList } from './page-list';
import {
  renderPostAuthorName,
  renderPostDate,
  renderPostExcerpt,
  renderPostTerms,
  renderPostTitle,
} from './post';
import { renderSearch } from './search';
import { renderLoginOut, renderSiteTagline, renderSiteTitle } from './site';
import { renderCategories, renderTagCloud } from './terms';

/**
 * The server-rendered core blocks — what the register_block_core_*()
 * functions in wordpress/wp-includes/blocks/*.php do on `init`. Static
 * blocks (paragraph, heading, list…) need no registration on the server:
 * their saved HTML is their output.
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
};

export function registerCoreBlocks(registry: BlockTypeRegistry<BlockServices>): void {
  for (const [name, render] of Object.entries(RENDERERS)) {
    const { name: _name, ...metadata } = (CORE_BLOCK_METADATA[name] ?? {
      name,
    }) as BlockTypeArgs<BlockServices> & { name: string };
    registry.register(name, { ...metadata, render });
  }
}
