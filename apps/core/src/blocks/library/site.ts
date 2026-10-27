import {
  type BlockAttributes,
  escAttr,
  escHtml,
  escUrl,
  getBlockWrapperAttributes,
} from '@pressbase/blocks';
import { type CoreBlock, loginUrl, logoutUrl, siteInfo } from '../helpers';

/**
 * Site blocks: core/site-title (render_block_core_site_title(), site-title.php),
 * core/site-tagline (render_block_core_site_tagline(), site-tagline.php) and
 * core/loginout (render_block_core_loginout(), loginout.php), all in
 * wordpress/wp-includes/blocks/.
 */

function headingTag(level: unknown, fallback: string): string {
  if (typeof level !== 'number' || !Number.isInteger(level) || level < 0 || level > 6) {
    return fallback;
  }
  return level === 0 ? 'p' : `h${level}`;
}

export async function renderSiteTitle(
  attributes: BlockAttributes,
  _content: string,
  block: CoreBlock,
): Promise<string> {
  const site = await siteInfo(block.services.kernel);
  if (!site.name.trim()) return '';
  const tag = headingTag(attributes.level, 'h1');
  const classes = attributes.textAlign ? `has-text-align-${attributes.textAlign}` : '';
  let title = escHtml(site.name);
  if (attributes.isLink) {
    const target = attributes.linkTarget ? String(attributes.linkTarget) : '_self';
    title = `<a href="${escUrl(site.home)}" target="${escAttr(target)}" rel="home">${title}</a>`;
  }
  return `<${tag} ${getBlockWrapperAttributes(block, { class: classes.trim() })}>${title}</${tag}>`;
}

export async function renderSiteTagline(
  attributes: BlockAttributes,
  _content: string,
  block: CoreBlock,
): Promise<string> {
  const site = await siteInfo(block.services.kernel);
  if (!site.description) return '';
  const tag = attributes.level ? headingTag(attributes.level, 'p') : 'p';
  const classes = attributes.textAlign ? `has-text-align-${attributes.textAlign}` : '';
  // WordPress stores the tagline escaped (sanitize_option); here it is escaped on output.
  return `<${tag} ${getBlockWrapperAttributes(block, { class: classes })}>${escHtml(site.description)}</${tag}>`;
}

/**
 * core/loginout. "Display login as form" shows the link too: Pressbase signs
 * in through the admin app's login screen, which doesn't accept a posted form.
 */
export async function renderLoginOut(
  attributes: BlockAttributes,
  _content: string,
  block: CoreBlock,
): Promise<string> {
  const site = await siteInfo(block.services.kernel);
  const loggedIn = Boolean(block.services.user);
  // The current URL isn't known to a REST render; the home page stands in for it.
  const redirect = attributes.redirectToCurrent ? `${site.home}/` : '';
  const contents = loggedIn
    ? `<a href="${escUrl(logoutUrl(site, redirect))}">Log out</a>`
    : `<a href="${escUrl(loginUrl(site, redirect))}">Log in</a>`;
  const classes = loggedIn ? 'logged-in' : 'logged-out';
  return `<div ${getBlockWrapperAttributes(block, { class: classes })}>${contents}</div>`;
}
