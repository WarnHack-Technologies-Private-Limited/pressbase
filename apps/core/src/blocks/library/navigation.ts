import {
  type BlockAttributes,
  escAttr,
  escUrl,
  getBlockWrapperAttributes,
  type ParsedBlock,
  parseBlocks,
  stripAllTags,
} from '@pressbase/blocks';
import { schema } from '@pressbase/db';
import { and, desc, eq } from 'drizzle-orm';
import { sanitizePostTitle } from '../../content/sanitize';
import { currentPage } from '../../frontend/page';
import { type CoreBlock, siteInfo } from '../helpers';

/**
 * core/navigation (navigation.php), core/navigation-link (navigation-link.php),
 * core/navigation-submenu (navigation-submenu.php) and core/home-link
 * (home-link.php), in wordpress/wp-includes/blocks/.
 *
 * Markup and classes follow WordPress, so the block library's CSS applies.
 * The responsive overlay is opened by a small script instead of the
 * Interactivity API (NAVIGATION_SCRIPT); without JavaScript a <noscript>
 * style shows the items inline, so the menu is always reachable.
 */

const OPEN_ICON =
  '<svg width="24" height="24" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 7.5h16v1.5H4z"></path><path d="M4 15h16v1.5H4z"></path></svg>';
const CLOSE_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false"><path d="m13.06 12 6.47-6.47-1.06-1.06L12 10.94 5.53 4.47 4.47 5.53 10.94 12l-6.47 6.47 1.06 1.06L12 13.06l6.47 6.47 1.06-1.06L13.06 12Z"></path></svg>';

/** Opens and closes responsive navigation overlays (what view.js does with the Interactivity API). */
export const NAVIGATION_SCRIPT = `(()=>{const open=(c,b)=>{c.classList.add('has-modal-open','is-menu-open');const d=c.querySelector('.wp-block-navigation__responsive-dialog');d&&(d.setAttribute('aria-modal','true'),d.setAttribute('role','dialog'));document.documentElement.classList.add('has-modal-open');const x=c.querySelector('.wp-block-navigation__responsive-container-close');x&&x.focus();c._opener=b};const close=c=>{c.classList.remove('has-modal-open','is-menu-open');const d=c.querySelector('.wp-block-navigation__responsive-dialog');d&&(d.removeAttribute('aria-modal'),d.removeAttribute('role'));document.documentElement.classList.remove('has-modal-open');c._opener&&c._opener.focus()};document.addEventListener('click',e=>{const t=e.target.closest&&e.target.closest('.wp-block-navigation__responsive-container-open,.wp-block-navigation__responsive-container-close');if(!t)return;const n=t.closest('.wp-block-navigation');const c=n&&n.querySelector('.wp-block-navigation__responsive-container');if(!c)return;t.classList.contains('wp-block-navigation__responsive-container-open')?open(c,t):close(c)});document.addEventListener('keydown',e=>{if(e.key!=='Escape')return;document.querySelectorAll('.wp-block-navigation__responsive-container.is-menu-open').forEach(close)});document.addEventListener('click',e=>{const s=e.target.closest&&e.target.closest('.wp-block-navigation-submenu__toggle');if(!s)return;const x=s.getAttribute('aria-expanded')==='true';s.setAttribute('aria-expanded',String(!x))})})();`;

/** Without JavaScript, show the overlay's items in place of the menu button. */
export const NAVIGATION_NOSCRIPT =
  '<noscript><style>.wp-block-navigation__responsive-container-open{display:none!important}.wp-block-navigation__responsive-container:not(.is-menu-open){display:block!important;position:relative!important;width:100%;background:inherit}</style></noscript>';

/** block_core_navigation_build_css_colors() for the overlay (and the nav itself). */
function colorClasses(attributes: BlockAttributes, overlay: boolean) {
  const classes: string[] = [];
  const styles: string[] = [];
  const text = overlay ? attributes.overlayTextColor : attributes.textColor;
  const customText = overlay ? attributes.customOverlayTextColor : attributes.customTextColor;
  const background = overlay ? attributes.overlayBackgroundColor : attributes.backgroundColor;
  const customBackground = overlay
    ? attributes.customOverlayBackgroundColor
    : attributes.customBackgroundColor;
  if (typeof text === 'string' && text) classes.push('has-text-color', `has-${text}-color`);
  else if (typeof customText === 'string' && customText) {
    classes.push('has-text-color');
    styles.push(`color: ${customText};`);
  }
  if (typeof background === 'string' && background) {
    classes.push('has-background', `has-${background}-background-color`);
  } else if (typeof customBackground === 'string' && customBackground) {
    classes.push('has-background');
    styles.push(`background-color: ${customBackground};`);
  }
  return { classes, styles };
}

/** block_core_navigation_get_fallback_blocks(): the newest menu, else a page list. */
async function fallbackBlocks(block: CoreBlock): Promise<ParsedBlock[]> {
  const { kernel } = block.services;
  if (kernel.postTypes.get('wp_navigation')) {
    const [menu] = await kernel.db
      .select({ content: schema.posts.content })
      .from(schema.posts)
      .where(and(eq(schema.posts.type, 'wp_navigation'), eq(schema.posts.status, 'publish')))
      .orderBy(desc(schema.posts.date))
      .limit(1);
    if (menu) return parseBlocks(menu.content).filter((b) => b.blockName);
  }
  return [
    { blockName: 'core/page-list', attrs: {}, innerBlocks: [], innerHTML: '', innerContent: [] },
  ];
}

let modalCounter = 0;

/** render_block_core_navigation() */
export async function renderNavigation(
  attributes: BlockAttributes,
  _content: string,
  block: CoreBlock,
): Promise<string> {
  const { kernel } = block.services;
  let blocks = block.parsedBlock.innerBlocks.filter((b) => b.blockName);
  let label = 'Navigation';
  const ref = Number(attributes.ref);
  if (Number.isInteger(ref) && ref > 0) {
    const menu = await kernel.posts.get(ref);
    if (menu?.type === 'wp_navigation' && menu.status === 'publish') {
      blocks = parseBlocks(menu.content).filter((b) => b.blockName);
      if (menu.title) label = stripAllTags(sanitizePostTitle(menu.title));
    }
  }
  if (!blocks.length) blocks = await fallbackBlocks(block);

  const layout = (attributes.layout ?? {}) as Record<string, unknown>;
  const layoutClasses: string[] = [];
  if (typeof layout.justifyContent === 'string') {
    layoutClasses.push(`items-justified-${layout.justifyContent}`);
  }
  if (layout.orientation === 'vertical') layoutClasses.push('is-vertical');
  if (layout.flexWrap === 'nowrap') layoutClasses.push('no-wrap');
  const colors = colorClasses(attributes, false);
  const responsive = attributes.overlayMenu !== 'never';
  const classes = [...colors.classes, ...(responsive ? ['is-responsive'] : []), ...layoutClasses];

  // get_inner_blocks_html(): runs of list items go in the container list.
  const container = getBlockWrapperAttributes(block, {
    class: `wp-block-navigation__container ${classes.join(' ')}`,
    style: colors.styles.join(' '),
  });
  const list = await block.withRecursionGuard(
    `navigation:${Number.isInteger(ref) && ref > 0 ? ref : 'inline'}`,
    async () => {
      let html = '';
      let open = false;
      for (const inner of blocks) {
        const markup = await block.renderInnerBlocks([inner]);
        const isListItem = /<li[\s>]/i.test(markup);
        if (isListItem && !open) {
          open = true;
          html += `<ul ${container}>`;
        }
        if (!isListItem && open) {
          open = false;
          html += '</ul>';
        }
        html += markup;
      }
      return open ? `${html}</ul>` : html;
    },
    '',
  );
  if (!list.replace(/<\/?ul[^>]*>/g, '').trim()) return '';
  const wrapper = getBlockWrapperAttributes(block, {
    class: classes.join(' '),
    style: colors.styles.join(' '),
    'aria-label': label,
  });

  if (!responsive) return `<nav ${wrapper}>${list}</nav>`;

  const page = currentPage();
  page?.scripts.add(NAVIGATION_SCRIPT);
  const id = page ? page.uniqueId('modal-') : `modal-${++modalCounter}`;
  const overlay = colorClasses(attributes, true);
  const containerClasses = ['wp-block-navigation__responsive-container', ...overlay.classes];
  if (attributes.overlayMenu === 'always') containerClasses.push('hidden-by-default');
  const containerStyle = overlay.styles.length
    ? ` style="${escAttr(overlay.styles.join(' '))}"`
    : '';
  const openButtonClass = `wp-block-navigation__responsive-container-open${attributes.overlayMenu === 'always' ? ' always-shown' : ''}`;
  const hasIcon = attributes.hasIcon !== false;
  const openLabel = hasIcon ? OPEN_ICON : 'Menu';
  const closeLabel = hasIcon ? CLOSE_ICON : 'Close';
  return `<nav ${wrapper}><button aria-haspopup="dialog" aria-label="${hasIcon ? 'Open menu' : ''}" class="${openButtonClass}">${openLabel}</button>
<div class="${escAttr(containerClasses.join(' '))}"${containerStyle} id="${id}">
<div class="wp-block-navigation__responsive-close" tabindex="-1">
<div class="wp-block-navigation__responsive-dialog">
<button aria-label="${hasIcon ? 'Close menu' : ''}" class="wp-block-navigation__responsive-container-close">${closeLabel}</button>
<div class="wp-block-navigation__responsive-container-content" id="${id}-content">
${list}
</div>
</div>
</div>
</div></nav>`;
}

/** Whether a menu item points at the page being shown (current-menu-item). */
function isCurrent(attributes: BlockAttributes): boolean {
  const object = currentPage()?.main.queriedObject;
  const id = Number(attributes.id);
  if (!object || !Number.isInteger(id) || id <= 0) return false;
  const kind = typeof attributes.kind === 'string' ? attributes.kind : 'post-type';
  if (kind === 'taxonomy') return object.kind === 'term' && object.term.id === id;
  return object.kind === 'post' && object.post.id === id;
}

/** render_block_core_navigation_link() */
export async function renderNavigationLink(
  attributes: BlockAttributes,
  content: string,
  block: CoreBlock,
): Promise<string> {
  if (typeof attributes.label !== 'string' || !attributes.label) return '';
  const hasSubmenu = content.trim() !== '';
  const active = isCurrent(attributes);
  const wrapper = getBlockWrapperAttributes(block, {
    class: `wp-block-navigation-item${hasSubmenu ? ' has-child' : ''}${active ? ' current-menu-item' : ''}`,
  });
  let html = `<li ${wrapper}><a class="wp-block-navigation-item__content"`;
  if (typeof attributes.url === 'string') html += ` href="${escUrl(attributes.url)}"`;
  if (active) html += ' aria-current="page"';
  if (attributes.opensInNewTab === true) html += ' target="_blank"  ';
  if (typeof attributes.rel === 'string') html += ` rel="${escAttr(attributes.rel)}"`;
  if (typeof attributes.title === 'string') html += ` title="${escAttr(attributes.title)}"`;
  html += `><span class="wp-block-navigation-item__label">${sanitizePostTitle(attributes.label)}</span>`;
  if (typeof attributes.description === 'string' && attributes.description) {
    html += `<span class="wp-block-navigation-item__description">${sanitizePostTitle(attributes.description)}</span>`;
  }
  html += '</a>';
  if (hasSubmenu) html += `<ul class="wp-block-navigation__submenu-container">${content}</ul>`;
  return `${html}</li>`;
}

/** render_block_core_navigation_submenu(), as an always-visible nested list. */
export async function renderNavigationSubmenu(
  attributes: BlockAttributes,
  content: string,
  block: CoreBlock,
): Promise<string> {
  if (typeof attributes.label !== 'string' || !attributes.label) return '';
  const label = sanitizePostTitle(attributes.label);
  const showIcon = block.context.showSubmenuIcon !== false;
  const icon =
    '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true" focusable="false"><path d="M1.50002 4L6.00002 8L10.5 4" stroke-width="1.5"></path></svg>';
  const wrapper = getBlockWrapperAttributes(block, {
    class: `wp-block-navigation-item has-child open-on-hover-click${isCurrent(attributes) ? ' current-menu-item' : ''}`,
  });
  let html = `<li ${wrapper}><a class="wp-block-navigation-item__content"${typeof attributes.url === 'string' ? ` href="${escUrl(attributes.url)}"` : ''}>${label}</a>`;
  if (showIcon) {
    html += `<button aria-label="${escAttr(`${stripAllTags(label)} submenu`)}" class="wp-block-navigation__submenu-icon wp-block-navigation-submenu__toggle" aria-expanded="false">${icon}</button>`;
  }
  html += `<ul class="wp-block-navigation__submenu-container">${content}</ul></li>`;
  return html;
}

/** render_block_core_home_link() */
export async function renderHomeLink(
  attributes: BlockAttributes,
  _content: string,
  block: CoreBlock,
): Promise<string> {
  const site = await siteInfo(block.services.kernel);
  const label =
    typeof attributes.label === 'string' && attributes.label
      ? sanitizePostTitle(attributes.label)
      : 'Home';
  const main = currentPage()?.main;
  const current = Boolean(main?.isFrontPage);
  const wrapper = getBlockWrapperAttributes(block, {
    class: `wp-block-navigation-item${current ? ' current-menu-item' : ''}`,
  });
  return `<li ${wrapper}><a class="wp-block-home-link__content wp-block-navigation-item__content" href="${escUrl(`${site.home}/`)}" rel="home"${current ? ' aria-current="page"' : ''}>${label}</a></li>`;
}
