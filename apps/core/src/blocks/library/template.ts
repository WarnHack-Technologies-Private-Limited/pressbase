import { createHash } from 'node:crypto';
import {
  type BlockAttributes,
  escAttr,
  escHtml,
  getBlockWrapperAttributes,
  parseBlocks,
} from '@pressbase/blocks';
import { currentPage } from '../../frontend/page';
import { type CoreBlock, contextPost, siteInfo } from '../helpers';

/**
 * Template blocks: core/template-part (template-part.php), core/pattern
 * (pattern.php) and core/post-content (post-content.php), in
 * wordpress/wp-includes/blocks/.
 */

/** WordPress's template part areas and the element each one uses (get_allowed_block_template_part_areas()). */
const AREA_TAGS: Record<string, string> = { header: 'header', footer: 'footer' };

/** render_block_core_template_part() */
export async function renderTemplatePart(
  attributes: BlockAttributes,
  _content: string,
  block: CoreBlock,
): Promise<string> {
  const slug = typeof attributes.slug === 'string' ? attributes.slug : '';
  if (!slug) return '';
  const theme = currentPage()?.theme ?? (await block.services.kernel.themes.active());
  const part = theme.parts.get(slug);
  // A part from another theme (`theme` attribute) isn't available.
  const themeAttr = typeof attributes.theme === 'string' ? attributes.theme : '';
  if (
    !part ||
    (themeAttr && themeAttr !== theme.info.stylesheet && themeAttr !== theme.parent?.stylesheet)
  ) {
    return block.services.user
      ? `Template part has been deleted or is unavailable: ${escHtml(slug)}`
      : '';
  }
  const rendered = await block.withRecursionGuard(
    `template-part:${part.theme}/${slug}`,
    () => block.renderInnerBlocks(parseBlocks(part.content)),
    '',
  );
  const allowed = ['header', 'footer', 'div', 'main', 'section', 'article', 'aside'];
  const tag =
    typeof attributes.tagName === 'string' && allowed.includes(attributes.tagName)
      ? attributes.tagName
      : (AREA_TAGS[typeof attributes.area === 'string' ? attributes.area : part.area] ?? 'div');
  return `<${tag} ${getBlockWrapperAttributes(block)}>${rendered.replaceAll(']]>', ']]&gt;')}</${tag}>`;
}

/**
 * render_block_core_pattern(). The pattern's blocks render in place, with the
 * surrounding context, the way WordPress resolves pattern blocks in templates.
 */
export async function renderPattern(
  attributes: BlockAttributes,
  _content: string,
  block: CoreBlock,
): Promise<string> {
  const slug = typeof attributes.slug === 'string' ? attributes.slug : '';
  const pattern = block.services.kernel.blocks.patterns().find((p) => p.name === slug);
  if (!pattern) return '';
  return block.withRecursionGuard(
    `pattern:${slug}`,
    () => block.renderInnerBlocks(parseBlocks(pattern.content)),
    '',
  );
}

/** The cookie that unlocks password-protected posts (wp-postpass_{COOKIEHASH} in WordPress). */
export const POSTPASS_COOKIE = 'wp-postpass';

/** The cookie value for a password: a hash, so the password itself is never stored. */
export function postPasswordHash(password: string): string {
  return createHash('sha256').update(`pressbase-postpass:${password}`).digest('hex');
}

/** post_password_required() */
export function postPasswordRequired(post: { password: string }): boolean {
  if (!post.password) return false;
  const cookie = currentPage()?.cookies.get(POSTPASS_COOKIE);
  return cookie !== postPasswordHash(post.password);
}

/** get_the_password_form() */
async function passwordForm(block: CoreBlock, postId: number): Promise<string> {
  const site = await siteInfo(block.services.kernel);
  const page = currentPage();
  const redirect = page ? `${site.home}${page.path}` : site.home;
  const label = `pwbox-${postId}`;
  return `<form action="${escAttr(`${site.home}/wp-login.php?action=postpass`)}" class="post-password-form" method="post"><input type="hidden" name="redirect_to" value="${escAttr(redirect)}" /><p>This content is password-protected. To view it, please enter the password below.</p><p><label for="${label}">Password: <input name="post_password" id="${label}" type="password" spellcheck="false" required size="20" /></label> <input type="submit" name="Submit" value="Enter" /></p></form>`;
}

/** render_block_core_post_content() */
export async function renderPostContent(
  attributes: BlockAttributes,
  _content: string,
  block: CoreBlock,
): Promise<string> {
  const post = await contextPost(block);
  if (!post) return '';
  let content: string;
  if (postPasswordRequired(post)) {
    content = await passwordForm(block, post.id);
  } else {
    content = await block.withRecursionGuard(
      `post-content:${post.id}`,
      () => block.renderContent(post.content, { postId: post.id, postType: post.type }),
      '',
    );
  }
  if (!content.trim()) return '';
  const allowed = ['div', 'main', 'section', 'article'];
  const tag =
    typeof attributes.tagName === 'string' && allowed.includes(attributes.tagName.toLowerCase())
      ? attributes.tagName.toLowerCase()
      : 'div';
  return `<${tag} ${getBlockWrapperAttributes(block, { class: 'entry-content' })}>${content.replaceAll(']]>', ']]&gt;')}</${tag}>`;
}
