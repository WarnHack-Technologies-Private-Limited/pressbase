import {
  type BlockAttributes,
  cssValue,
  escAttr,
  escHtml,
  escUrl,
  getBlockWrapperAttributes,
  stripAllTags,
} from '@pressbase/blocks';
import { schema } from '@pressbase/db';
import { and, asc, desc, eq, gt, lt } from 'drizzle-orm';
import { permalink, permalinkContext } from '../../content/permalinks';
import type { Post } from '../../content/posts';
import { sanitizePostTitle } from '../../content/sanitize';
import { currentPage } from '../../frontend/page';
import { featuredMediaIds } from '../../media/featured';
import type { AttachmentMetadata } from '../../media/images';
import { fileUrl, getMetaMap, META_ALT, META_FILE, META_METADATA } from '../../media/service';
import {
  authorOf,
  authorPostsUrl,
  type CoreBlock,
  contextPost,
  siteInfo,
  theTitle,
} from '../helpers';
import { postPasswordRequired } from './template';

/**
 * Blocks around a post: core/post-featured-image, core/post-navigation-link,
 * core/read-more, core/post-author, core/avatar and core/site-logo
 * (wordpress/wp-includes/blocks/*.php), with wp_get_attachment_image().
 */

/** wp_get_attachment_image(): an <img> with width, height, srcset and sizes. */
export async function attachmentImage(
  block: CoreBlock,
  attachmentId: number,
  size: string,
  attr: Record<string, string>,
): Promise<string> {
  const { kernel } = block.services;
  const meta = (await getMetaMap(kernel, [attachmentId], [META_FILE, META_METADATA, META_ALT])).get(
    attachmentId,
  );
  const file = meta?.[META_FILE];
  if (typeof file !== 'string' || !file) return '';
  const metadata = (meta?.[META_METADATA] ?? {}) as AttachmentMetadata;
  const folder = file.includes('/') ? file.slice(0, file.lastIndexOf('/') + 1) : '';
  const sub = metadata.sizes?.[size];
  const width = sub?.width ?? metadata.width;
  const height = sub?.height ?? metadata.height;
  const src = await fileUrl(kernel, sub ? `${folder}${sub.file}` : file);

  // wp_calculate_image_srcset(): every size with the same aspect ratio.
  const candidates: string[] = [];
  if (width && height && metadata.width && metadata.height) {
    const ratio = width / height;
    const all = [
      { file: file.slice(folder.length), width: metadata.width, height: metadata.height },
      ...Object.values(metadata.sizes ?? {}),
    ];
    const seen = new Set<number>();
    for (const item of all) {
      if (!item.width || !item.height || seen.has(item.width)) continue;
      if (Math.abs(item.width / item.height - ratio) > 0.01 && item.width !== width) continue;
      seen.add(item.width);
      candidates.push(`${await fileUrl(kernel, `${folder}${item.file}`)} ${item.width}w`);
    }
  }
  const alt = typeof meta?.[META_ALT] === 'string' ? (meta[META_ALT] as string) : '';
  const attributes: [string, string][] = [];
  if (width) attributes.push(['width', String(width)]);
  if (height) attributes.push(['height', String(height)]);
  attributes.push(['src', src]);
  attributes.push(['class', attr.class ?? `attachment-${size} size-${size}`]);
  attributes.push(['alt', attr.alt ?? alt]);
  if (attr.style) attributes.push(['style', attr.style]);
  attributes.push(['decoding', 'async']);
  if (attr.loading) attributes.push(['loading', attr.loading]);
  if (attr.fetchpriority) attributes.push(['fetchpriority', attr.fetchpriority]);
  if (candidates.length > 1) {
    attributes.push(['srcset', candidates.join(', ')]);
    if (width) attributes.push(['sizes', `(max-width: ${width}px) 100vw, ${width}px`]);
  }
  return `<img ${attributes
    .map(([name, value]) => `${name}="${name === 'src' ? escUrl(value) : escAttr(value)}"`)
    .join(' ')} />`;
}

async function linkTo(block: CoreBlock, post: Post): Promise<string> {
  const { kernel } = block.services;
  return permalink(kernel, post, await permalinkContext(kernel));
}

/** get_block_core_post_featured_image_border_attributes() */
function borderAttributes(attributes: BlockAttributes): { class: string; style: string } {
  const style = (attributes.style ?? {}) as { border?: Record<string, unknown> };
  const border = style.border ?? {};
  const styles: string[] = [];
  const classes: string[] = [];
  const radius = cssValue(border.radius);
  if (radius) styles.push(`border-radius:${radius}`);
  if (typeof attributes.borderColor === 'string') {
    classes.push('has-border-color', `has-${attributes.borderColor}-border-color`);
  } else {
    const color = cssValue(border.color);
    if (color) styles.push(`border-color:${color}`);
  }
  for (const key of ['style', 'width'] as const) {
    const value = cssValue(border[key]);
    if (value) styles.push(`border-${key}:${value}`);
  }
  for (const side of ['top', 'right', 'bottom', 'left']) {
    const sideBorder = border[side] as Record<string, unknown> | undefined;
    for (const key of ['color', 'style', 'width'] as const) {
      const value = cssValue(sideBorder?.[key]);
      if (value) styles.push(`border-${side}-${key}:${value}`);
    }
  }
  return { class: classes.join(' '), style: styles.length ? `${styles.join(';')};` : '' };
}

let featuredCount = 0;

/** render_block_core_post_featured_image() */
export async function renderPostFeaturedImage(
  attributes: BlockAttributes,
  _content: string,
  block: CoreBlock,
): Promise<string> {
  const post = await contextPost(block);
  if (!post || postPasswordRequired(post)) return '';
  const isLink = Boolean(attributes.isLink);
  const size = typeof attributes.sizeSlug === 'string' ? attributes.sizeSlug : 'post-thumbnail';
  const border = borderAttributes(attributes);
  let style = border.style;
  const has = (key: string) =>
    attributes[key] !== undefined && attributes[key] !== null && attributes[key] !== '';
  const safe = (value: unknown) => cssValue(value) ?? '';
  if (typeof attributes.aspectRatio === 'string' && attributes.aspectRatio) {
    if (attributes.aspectRatio !== 'auto') style += `aspect-ratio:${safe(attributes.aspectRatio)};`;
    style += 'width:100%;';
  }
  if (has('height')) style += `height:${safe(attributes.height)};`;
  else if (has('width')) style += 'height:auto;';
  if (has('width')) style += `width:${safe(attributes.width)};`;
  if (typeof attributes.scale === 'string' && attributes.scale) {
    style += `object-fit:${safe(attributes.scale)};`;
  }
  const attr: Record<string, string> = {
    class: `attachment-${size} size-${size} wp-post-image${border.class ? ` ${border.class}` : ''}`,
  };
  if (style) attr.style = style;
  if (isLink) {
    const title = stripAllTags(theTitle(post)).trim();
    attr.alt = title || `Untitled post ${post.id}`;
  }
  // The first featured image on a page is likely the largest contentful paint.
  const page = currentPage();
  const first = page
    ? page.uniqueId('featured-image') === 'featured-image1'
    : ++featuredCount === 1;
  if (first) attr.fetchpriority = 'high';
  else attr.loading = 'lazy';

  const thumbnail = (await featuredMediaIds(block.services.kernel, [post.id])).get(post.id);
  let image = thumbnail ? await attachmentImage(block, thumbnail, size, attr) : '';
  if (!image) return '';
  const dim = Number(attributes.dimRatio) || 0;
  let overlay = '';
  if (dim) {
    const classes = [
      'wp-block-post-featured-image__overlay',
      'has-background-dim',
      `has-background-dim-${dim}`,
    ];
    if (typeof attributes.overlayColor === 'string')
      classes.push(`has-${attributes.overlayColor}-background-color`);
    overlay = `<span class="${escAttr(classes.join(' '))}" style="" aria-hidden="true"></span>`;
  }
  if (isLink) {
    const target = typeof attributes.linkTarget === 'string' ? attributes.linkTarget : '_self';
    const rel = attributes.rel ? `rel="${escAttr(attributes.rel)}"` : '';
    image = `<a href="${escUrl(await linkTo(block, post))}" target="${escAttr(target)}" ${rel}>${image}${overlay}</a>`;
  } else image += overlay;
  return `<figure ${getBlockWrapperAttributes(block)}>${image}</figure>`;
}

/** get_adjacent_post(): the next (newer) or previous (older) published post of the same type. */
async function adjacentPost(
  block: CoreBlock,
  post: Post,
  next: boolean,
): Promise<Post | undefined> {
  const { posts } = schema;
  const [row] = await block.services.kernel.db
    .select()
    .from(posts)
    .where(
      and(
        eq(posts.type, post.type),
        eq(posts.status, 'publish'),
        next ? gt(posts.date, post.date) : lt(posts.date, post.date),
      ),
    )
    .orderBy(next ? asc(posts.date) : desc(posts.date))
    .limit(1);
  return row;
}

/** render_block_core_post_navigation_link() */
export async function renderPostNavigationLink(
  attributes: BlockAttributes,
  _content: string,
  block: CoreBlock,
): Promise<string> {
  const main = currentPage()?.main;
  if (!main?.isSingular || main.queriedObject?.kind !== 'post') return '';
  const type =
    attributes.type === 'previous'
      ? 'previous'
      : attributes.type === 'next' || !attributes.type
        ? 'next'
        : '';
  if (!type) return '';
  let classes = `post-navigation-link-${type}`;
  if (typeof attributes.textAlign === 'string')
    classes += ` has-text-align-${attributes.textAlign}`;
  const wrapper = getBlockWrapperAttributes(block, { class: classes });

  let format = '%link';
  let link = type === 'next' ? 'Next' : 'Previous';
  let label = '';
  if (typeof attributes.label === 'string' && attributes.label) {
    label = attributes.label;
    link = label;
  }
  if (attributes.showTitle) {
    if (!attributes.linkLabel) {
      if (label)
        format = `<span class="post-navigation-link__label">${sanitizePostTitle(label)}</span> %link`;
      link = '%title';
    } else if (label) {
      link = `<span class="post-navigation-link__label">${sanitizePostTitle(label)}</span> <span class="post-navigation-link__title">%title</span>`;
    } else {
      label = type === 'next' ? 'Next:' : 'Previous:';
      link = `<span class="post-navigation-link__label">${label}</span> <span class="post-navigation-link__title">%title</span>`;
    }
  }
  const arrows: Record<string, { next: string; previous: string }> = {
    arrow: { next: '→', previous: '←' },
    chevron: { next: '»', previous: '«' },
  };
  const arrow = typeof attributes.arrow === 'string' ? arrows[attributes.arrow] : undefined;
  if (arrow) {
    format =
      type === 'next'
        ? `%link<span class="wp-block-post-navigation-link__arrow-next is-arrow-${attributes.arrow}" aria-hidden="true">${arrow.next}</span>`
        : `<span class="wp-block-post-navigation-link__arrow-previous is-arrow-${attributes.arrow}" aria-hidden="true">${arrow.previous}</span>%link`;
  }
  // get_adjacent_post_link()
  const adjacent = await adjacentPost(block, main.queriedObject.post, type === 'next');
  let content = '';
  if (adjacent) {
    const title = theTitle(adjacent) || (type === 'next' ? 'Next Post' : 'Previous Post');
    const anchor = `<a href="${escUrl(await linkTo(block, adjacent))}" rel="${type === 'next' ? 'next' : 'prev'}">${link.replace('%title', title)}</a>`;
    content = format.replace('%link', anchor);
  }
  return `<div ${wrapper}>${content}</div>`;
}

/** render_block_core_read_more() */
export async function renderReadMore(
  attributes: BlockAttributes,
  _content: string,
  block: CoreBlock,
): Promise<string> {
  const post = await contextPost(block);
  if (!post) return '';
  const title = theTitle(post) || `untitled post ${post.id}`;
  const justify =
    typeof attributes.justifyContent === 'string'
      ? `is-justified-${attributes.justifyContent}`
      : '';
  const more =
    typeof attributes.content === 'string' && attributes.content
      ? sanitizePostTitle(attributes.content)
      : 'Read more';
  const target = typeof attributes.linkTarget === 'string' ? attributes.linkTarget : '_self';
  return `<a ${getBlockWrapperAttributes(block, { class: justify })} href="${escUrl(await linkTo(block, post))}" target="${escAttr(target)}">${more}<span class="screen-reader-text">: ${title}</span></a>`;
}

/** Initials for a name: "Ada Lovelace" → "AL". */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? [words[0], words[words.length - 1]] : words;
  return letters
    .map((w) => Array.from(w ?? '')[0] ?? '')
    .join('')
    .toUpperCase();
}

/**
 * A privacy-friendly avatar: initials on a colour derived from the name,
 * as an inline SVG. WordPress asks Gravatar by default; Pressbase sends no
 * visitor's or author's email hash to a third party.
 */
export function avatarImage(name: string, size: number, className: string, style = ''): string {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
  const hue = hash % 360;
  const text = escHtml(initials(name) || '?');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 100 100"><rect width="100" height="100" fill="hsl(${hue},40%,42%)"/><text x="50" y="50" dy=".35em" text-anchor="middle" font-family="system-ui,sans-serif" font-size="40" fill="#fff">${text}</text></svg>`;
  const src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  return `<img alt="${escAttr(name)}" src="${escAttr(src)}" class="${escAttr(className)}" width="${size}" height="${size}"${style ? ` style="${escAttr(style)}"` : ''} />`;
}

/** render_block_core_avatar(): the post author's (or comment author's) avatar. */
export async function renderAvatar(
  attributes: BlockAttributes,
  _content: string,
  block: CoreBlock,
): Promise<string> {
  const { kernel } = block.services;
  const size = Number(attributes.size) || 96;
  let name = '';
  let link = '';
  if (block.context.commentId !== undefined) {
    const [comment] = await kernel.db
      .select({ author: schema.comments.author })
      .from(schema.comments)
      .where(eq(schema.comments.id, Number(block.context.commentId)));
    name = comment?.author ?? '';
  } else {
    const authorId = attributes.userId ?? (await contextPost(block))?.authorId;
    const author = await authorOf(kernel, Number(authorId) || null);
    if (!author) return '';
    name = author.displayName;
    if (attributes.isLink) link = authorPostsUrl(await siteInfo(kernel), author);
  }
  if (!name) return '';
  const border = borderAttributes(attributes);
  const image = avatarImage(
    name,
    size,
    `avatar avatar-${size} photo wp-block-avatar__image ${border.class}`.trim(),
    border.style,
  );
  const inner = link
    ? `<a href="${escUrl(link)}" class="wp-block-avatar__link" target="${escAttr(typeof attributes.linkTarget === 'string' ? attributes.linkTarget : '_self')}">${image}</a>`
    : image;
  return `<div ${getBlockWrapperAttributes(block)}>${inner}</div>`;
}

/** render_block_core_post_author() */
export async function renderPostAuthor(
  attributes: BlockAttributes,
  _content: string,
  block: CoreBlock,
): Promise<string> {
  const { kernel } = block.services;
  const post = await contextPost(block);
  const author = await authorOf(kernel, post?.authorId ?? null);
  if (!author) return '';
  const size = Number(attributes.avatarSize) || 48;
  const site = await siteInfo(kernel);
  const [bio] = await kernel.db
    .select({ value: schema.usermeta.value })
    .from(schema.usermeta)
    .where(and(eq(schema.usermeta.userId, author.id), eq(schema.usermeta.key, 'description')));
  const classes =
    typeof attributes.textAlign === 'string' ? `has-text-align-${attributes.textAlign}` : '';
  let name = escHtml(author.displayName);
  if (attributes.isLink) {
    name = `<a href="${escUrl(authorPostsUrl(site, author))}" target="${escAttr(typeof attributes.linkTarget === 'string' ? attributes.linkTarget : '_self')}">${name}</a>`;
  }
  const avatar =
    attributes.showAvatar === false
      ? ''
      : `<div class="wp-block-post-author__avatar">${avatarImage(author.displayName, size, `avatar avatar-${size} photo`)}</div>`;
  const byline =
    typeof attributes.byline === 'string' && attributes.byline
      ? `<p class="wp-block-post-author__byline">${sanitizePostTitle(attributes.byline)}</p>`
      : '';
  const description =
    attributes.showBio && typeof bio?.value === 'string' && bio.value
      ? `<p class="wp-block-post-author__bio">${escHtml(bio.value)}</p>`
      : '';
  return `<div ${getBlockWrapperAttributes(block, { class: classes })}>${avatar}<div class="wp-block-post-author__content">${byline}<p class="wp-block-post-author__name">${name}</p>${description}</div></div>`;
}

/** render_block_core_site_logo(): nothing until the site has a logo (site_logo option). */
export async function renderSiteLogo(
  attributes: BlockAttributes,
  _content: string,
  block: CoreBlock,
): Promise<string> {
  const { kernel } = block.services;
  const logo = Number(await kernel.options.get<number>('site_logo', 0));
  if (!logo) return '';
  const width = Number(attributes.width) || 0;
  const style = width ? `width:${width}px;` : '';
  const site = await siteInfo(kernel);
  let image = await attachmentImage(block, logo, 'full', {
    class: 'custom-logo',
    alt: site.name,
    ...(style ? { style } : {}),
  });
  if (!image) return '';
  if (attributes.isLink !== false) {
    image = `<a href="${escUrl(`${site.home}/`)}" class="custom-logo-link" rel="home"${attributes.linkTarget === '_blank' ? ' target="_blank"' : ''}>${image}</a>`;
  }
  const classes =
    attributes.className && String(attributes.className).includes('is-style-rounded') ? '' : '';
  return `<div ${getBlockWrapperAttributes(block, { class: classes })}>${image}</div>`;
}
