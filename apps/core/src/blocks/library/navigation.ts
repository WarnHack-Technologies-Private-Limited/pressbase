import {
  type BlockAttributes,
  escAttr,
  escUrl,
  getBlockWrapperAttributes,
  type ParsedBlock,
  parseBlocks,
  stripAllTags,
} from '@pressbase/blocks';
import {
  currentNavigationPreview,
  findFallbackNavigation,
  publishedNavigation,
} from '../../content/navigation';
import { sanitizePostTitle } from '../../content/sanitize';
import { currentPage, type PageRender } from '../../frontend/page';
import { type CoreBlock, siteInfo } from '../helpers';

/**
 * core/navigation (navigation.php), core/navigation-link (navigation-link.php),
 * core/navigation-submenu (navigation-submenu.php) and core/home-link
 * (home-link.php), in wordpress/wp-includes/blocks/. The menu itself is a
 * `wp_navigation` post (see content/navigation.ts and
 * docs/architecture/navigation.md).
 *
 * Markup and classes follow WordPress, so the block library's CSS applies.
 * The Interactivity API (view.js) is replaced by one small script
 * (NAVIGATION_SCRIPT) that opens the responsive overlay and the submenus.
 * Without JavaScript, a <noscript> style shows the overlay's items inline and
 * opens submenus on hover and keyboard focus, so the menu is always reachable.
 */

const OPEN_ICON =
  '<svg width="24" height="24" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 7.5h16v1.5H4z"></path><path d="M4 15h16v1.5H4z"></path></svg>';
const CLOSE_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false"><path d="m13.06 12 6.47-6.47-1.06-1.06L12 10.94 5.53 4.47 4.47 5.53 10.94 12l-6.47 6.47 1.06 1.06L12 13.06l6.47 6.47 1.06-1.06L13.06 12Z"></path></svg>';
/** block_core_shared_navigation_render_submenu_icon() */
export const SUBMENU_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true" focusable="false"><path d="M1.50002 4L6.00002 8L10.5 4" stroke-width="1.5"></path></svg>';

/**
 * What view.js does with the Interactivity API, without it:
 *
 * - the menu button opens the overlay as a modal dialog, moves focus to the
 *   close button and keeps Tab inside it; Escape or the close button closes it
 *   and returns focus to the menu button;
 * - submenu toggles flip `aria-expanded` (the block library's CSS shows a
 *   submenu whose toggle is expanded); opening one closes its open siblings;
 * - Escape closes the submenu that has focus and returns focus to its toggle;
 *   focus leaving a submenu, or a click elsewhere, closes it.
 */
export const NAVIGATION_SCRIPT = `(()=>{
const OPEN='.wp-block-navigation__responsive-container-open',CLOSE='.wp-block-navigation__responsive-container-close',TOGGLE='.wp-block-navigation-submenu__toggle';
const focusables=c=>[...c.querySelectorAll('a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"])')].filter(e=>!e.disabled&&e.offsetParent!==null);
const open=(c,b)=>{c.classList.add('has-modal-open','is-menu-open');const d=c.querySelector('.wp-block-navigation__responsive-dialog');d&&(d.setAttribute('aria-modal','true'),d.setAttribute('role','dialog'),d.setAttribute('aria-label','Menu'));document.documentElement.classList.add('has-modal-open');const x=c.querySelector(CLOSE);x&&x.focus();c._opener=b};
const close=c=>{c.classList.remove('has-modal-open','is-menu-open');const d=c.querySelector('.wp-block-navigation__responsive-dialog');d&&(d.removeAttribute('aria-modal'),d.removeAttribute('role'),d.removeAttribute('aria-label'));document.documentElement.classList.remove('has-modal-open');c._opener&&c._opener.focus()};
const setSub=(t,on)=>{t.setAttribute('aria-expanded',String(on));if(!on)t.closest('.has-child')?.querySelectorAll(TOGGLE+'[aria-expanded="true"]').forEach(s=>s.setAttribute('aria-expanded','false'))};
const closeSubs=(except)=>document.querySelectorAll('.wp-block-navigation '+TOGGLE+'[aria-expanded="true"]').forEach(t=>{if(!except||!t.closest('.has-child').contains(except))setSub(t,false)});
document.addEventListener('click',e=>{const t=e.target.closest&&e.target.closest(OPEN+','+CLOSE);if(t){const n=t.closest('.wp-block-navigation'),c=n&&n.querySelector('.wp-block-navigation__responsive-container');if(c)t.matches(OPEN)?open(c,t):close(c);return}
const s=e.target.closest&&e.target.closest(TOGGLE);if(s&&s.closest('.wp-block-navigation')){const on=s.getAttribute('aria-expanded')!=='true';const li=s.closest('.has-child');li.parentElement&&[...li.parentElement.children].forEach(o=>{if(o!==li)o.querySelectorAll(TOGGLE+'[aria-expanded="true"]').forEach(x=>setSub(x,false))});setSub(s,on);return}
closeSubs(e.target)});
document.addEventListener('keydown',e=>{const c=document.querySelector('.wp-block-navigation__responsive-container.is-menu-open');
if(e.key==='Escape'){let li=e.target.closest&&e.target.closest('.wp-block-navigation .has-child'),t=null;while(li&&!(t=li.querySelector(':scope>'+TOGGLE+'[aria-expanded="true"]')))li=li.parentElement&&li.parentElement.closest('.wp-block-navigation .has-child');if(t){setSub(t,false);t.focus();e.preventDefault();return}if(c){close(c);e.preventDefault()}return}
if(e.key==='Tab'&&c){const f=focusables(c);if(!f.length)return;const first=f[0],last=f[f.length-1];if(e.shiftKey&&document.activeElement===first){last.focus();e.preventDefault()}else if(!e.shiftKey&&document.activeElement===last){first.focus();e.preventDefault()}}});
document.addEventListener('focusout',e=>{const li=e.target.closest&&e.target.closest('.wp-block-navigation .has-child');if(!li||(e.relatedTarget&&li.contains(e.relatedTarget)))return;const t=li.querySelector(':scope>'+TOGGLE+'[aria-expanded="true"]');t&&e.relatedTarget&&setSub(t,false)});
})();`;

/**
 * Without JavaScript: the overlay's items show in place of the menu button,
 * and submenus open on hover and when anything inside them has keyboard
 * focus (the block library's CSS leaves `open-on-hover-click` submenus to
 * view.js for keyboard users).
 */
export const NAVIGATION_NOSCRIPT =
  '<noscript><style>.wp-block-navigation__responsive-container-open{display:none!important}.wp-block-navigation__responsive-container:not(.is-menu-open){display:block!important;position:relative!important;width:100%;background:inherit}.wp-block-navigation .has-child:focus-within>.wp-block-navigation__submenu-container{height:auto;min-width:200px;opacity:1;overflow:visible;visibility:visible;width:auto}</style></noscript>';

/* ----------------------------------------------------------------- helpers */

/** Keeps a colour value that can't break out of a style declaration. */
function cssColor(value: unknown): string | undefined {
  return typeof value === 'string' && /^[#a-z0-9(),.%\s-]+$/i.test(value) ? value : undefined;
}

/** A preset slug as a class name part (_wp_to_kebab_case(), enough for slugs). */
function slug(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  return value
    .replace(/([a-z])([A-Z0-9])/g, '$1-$2')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .toLowerCase();
}

/** block_core_navigation_build_css_colors() for the overlay (and the nav itself). */
function colorClasses(attributes: BlockAttributes, overlay: boolean) {
  const classes: string[] = [];
  const styles: string[] = [];
  const text = slug(overlay ? attributes.overlayTextColor : attributes.textColor);
  const customText = cssColor(
    overlay ? attributes.customOverlayTextColor : attributes.customTextColor,
  );
  const background = slug(overlay ? attributes.overlayBackgroundColor : attributes.backgroundColor);
  const customBackground = cssColor(
    overlay ? attributes.customOverlayBackgroundColor : attributes.customBackgroundColor,
  );
  if (text) classes.push('has-text-color', `has-${text}-color`);
  else if (customText) {
    classes.push('has-text-color');
    styles.push(`color: ${customText};`);
  }
  if (background) classes.push('has-background', `has-${background}-background-color`);
  else if (customBackground) {
    classes.push('has-background');
    styles.push(`background-color: ${customBackground};`);
  }
  return { classes, styles };
}

/**
 * The colours a submenu's list gets from the Navigation block's overlay
 * colours (navigation-submenu.php copies them onto the block, then
 * wp_apply_colors_support()), so dropdowns are readable on any background.
 */
export function submenuColors(context: Record<string, unknown>) {
  return colorClasses(
    {
      overlayTextColor: context.overlayTextColor,
      customOverlayTextColor: context.customOverlayTextColor,
      overlayBackgroundColor: context.overlayBackgroundColor,
      customOverlayBackgroundColor: context.customOverlayBackgroundColor,
    },
    true,
  );
}

/** block_core_navigation_get_submenu_visibility(), from attributes or context. */
export function submenuVisibility(source: Record<string, unknown>): 'hover' | 'click' | 'always' {
  const legacy = source.openSubmenusOnClick;
  if (legacy !== undefined && legacy !== null) return legacy ? 'click' : 'hover';
  const value = source.submenuVisibility;
  return value === 'click' || value === 'always' ? value : 'hover';
}

/** Parsed blocks without the whitespace-only freeform blocks between them. */
function realBlocks(blocks: ParsedBlock[]): ParsedBlock[] {
  return blocks.filter((b) => b.blockName);
}

/** block_core_navigation_block_tree_has_block_type() */
function treeHas(blocks: ParsedBlock[], name: string): boolean {
  return blocks.some((b) => b.blockName === name || treeHas(b.innerBlocks ?? [], name));
}

/** Navigation names seen on the page (get_unique_navigation_name()'s static). */
const seenNames = new WeakMap<PageRender, Map<string, number>>();

function uniqueName(name: string): string {
  const page = currentPage();
  if (!page || !name) return name;
  const seen = seenNames.get(page) ?? new Map<string, number>();
  seenNames.set(page, seen);
  const count = (seen.get(name) ?? 0) + 1;
  seen.set(name, count);
  return count > 1 ? `${name} ${count}` : name;
}

/** The text of a menu title, for aria-label (escaped when printed). */
const plainTitle = (title: string) => stripAllTags(sanitizePostTitle(title)).trim();

/* -------------------------------------------------------------- navigation */

interface InnerBlocks {
  blocks: ParsedBlock[];
  /** The wp_navigation post they came from, for the accessible name. */
  title?: string;
}

/**
 * WP_Navigation_Block_Renderer::get_inner_blocks(): the `ref` menu's blocks
 * (published menus only), else the block's own inner blocks, else the
 * fallback (block_core_navigation_get_fallback_blocks()).
 */
async function innerBlocksFor(attributes: BlockAttributes, block: CoreBlock): Promise<InnerBlocks> {
  const { kernel } = block.services;
  let result: InnerBlocks = { blocks: realBlocks(block.parsedBlock.innerBlocks) };
  // Blocks saved with the legacy attribute name still render.
  const ref = attributes.ref ?? block.parsedBlock.attrs?.navigationMenuId;
  if (ref !== undefined && ref !== null) {
    const menu = await publishedNavigation(kernel, ref);
    result = menu
      ? { blocks: realBlocks(parseBlocks(menu.content)), title: menu.title }
      : { blocks: [] };
  }
  if (!result.blocks.length) {
    const pageList: ParsedBlock = {
      blockName: 'core/page-list',
      attrs: {},
      innerBlocks: [],
      innerHTML: '',
      innerContent: [],
    };
    let fallback: ParsedBlock[] = kernel.blocks.registry.isRegistered('core/page-list')
      ? [pageList]
      : [];
    const menu = currentNavigationPreview() ?? (await findFallbackNavigation(kernel));
    if (menu) {
      const blocks = realBlocks(parseBlocks(menu.content));
      if (blocks.length) {
        fallback = blocks;
        result.title = menu.title;
      }
    }
    const filtered = await kernel.hooks.applyFilters(
      'block_core_navigation_render_fallback',
      fallback,
    );
    result.blocks = Array.isArray(filtered) ? realBlocks(filtered as ParsedBlock[]) : [];
  }
  const filtered = await kernel.hooks.applyFilters(
    'block_core_navigation_render_inner_blocks',
    result.blocks,
  );
  result.blocks = Array.isArray(filtered) ? (filtered as ParsedBlock[]) : result.blocks;
  return result;
}

/** Blocks that need an <li> around them inside a menu (block_core_navigation_listable_blocks). */
const LISTABLE = new Set(['core/site-title', 'core/site-logo', 'core/social-links']);

let modalCounter = 0;

/** render_block_core_navigation() / WP_Navigation_Block_Renderer::render() */
export async function renderNavigation(
  attributes: BlockAttributes,
  _content: string,
  block: CoreBlock,
): Promise<string> {
  const inner = await innerBlocksFor(attributes, block);
  // A menu that contains a Navigation block would render itself.
  if (treeHas(inner.blocks, 'core/navigation')) return '';

  const layout = (attributes.layout ?? {}) as Record<string, unknown>;
  const layoutClasses: string[] = [];
  if (
    typeof layout.justifyContent === 'string' &&
    ['left', 'right', 'center', 'space-between'].includes(layout.justifyContent)
  ) {
    layoutClasses.push(`items-justified-${layout.justifyContent}`);
  }
  if (layout.orientation === 'vertical') layoutClasses.push('is-vertical');
  if (layout.flexWrap === 'nowrap') layoutClasses.push('no-wrap');
  const colors = colorClasses(attributes, false);
  const responsive = attributes.overlayMenu !== 'never' || attributes.isResponsive === true;
  const classes = [...colors.classes, ...(responsive ? ['is-responsive'] : []), ...layoutClasses];

  // get_inner_blocks_html(): runs of list items go in the container list.
  const container = getBlockWrapperAttributes(block, {
    class: `wp-block-navigation__container ${classes.join(' ')}`,
    style: colors.styles.join(' '),
  });
  const ref = Number(attributes.ref);
  const list = await block.withRecursionGuard(
    `navigation:${Number.isInteger(ref) && ref > 0 ? ref : 'inline'}`,
    async () => {
      let html = '';
      let open = false;
      for (const parsed of inner.blocks) {
        let markup = await block.renderInnerBlocks([parsed]);
        if (markup && parsed.blockName && LISTABLE.has(parsed.blockName)) {
          markup = `<li class="wp-block-navigation-item">${markup}</li>`;
        }
        const isListItem = /^\s*<li[\s>]/i.test(markup);
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

  // get_navigation_name() + get_unique_navigation_name(). WordPress leaves a
  // fallback menu unnamed; Pressbase names it after the menu, or "Navigation",
  // so every <nav> on the page has an accessible name.
  const ariaLabel = typeof attributes.ariaLabel === 'string' ? attributes.ariaLabel.trim() : '';
  const name = uniqueName(
    ariaLabel || (inner.title ? plainTitle(inner.title) : '') || 'Navigation',
  );
  const wrapper = getBlockWrapperAttributes(block, {
    class: classes.join(' '),
    style: colors.styles.join(' '),
    'aria-label': name,
  });

  // is_interactive(): the overlay, or submenus with a toggle button.
  const page = currentPage();
  if (responsive || list.includes('wp-block-navigation-submenu__toggle')) {
    page?.inlineScripts.add(NAVIGATION_SCRIPT);
  }
  if (!responsive) return `<nav ${wrapper}>${list}</nav>`;

  const id = page ? page.uniqueId('modal-') : `modal-${++modalCounter}`;
  const overlay = colorClasses(attributes, true);
  const containerClasses = ['wp-block-navigation__responsive-container', ...overlay.classes];
  if (attributes.overlayMenu === 'always') containerClasses.splice(1, 0, 'hidden-by-default');
  const containerStyle = overlay.styles.length
    ? ` style="${escAttr(overlay.styles.join(' '))}"`
    : '';
  const openButtonClass = `wp-block-navigation__responsive-container-open${attributes.overlayMenu === 'always' ? ' always-shown' : ''}`;
  // WordPress only labels the buttons when they show icons; Pressbase always
  // shows the icons unless `hasIcon` is explicitly false.
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

/* ------------------------------------------------------------ menu items */

/**
 * Whether a menu item points at the page being shown: the queried object has
 * the item's ID and is of the item's kind (a post for `post-type`, a term for
 * `taxonomy`; never for `custom` links).
 */
function isCurrent(attributes: BlockAttributes): boolean {
  const object = currentPage()?.main.queriedObject;
  const id = Number(attributes.id);
  if (!object || !Number.isInteger(id) || id <= 0) return false;
  const kind =
    typeof attributes.kind === 'string' && attributes.kind ? attributes.kind : 'post-type';
  if (kind === 'taxonomy') return object.kind === 'term' && object.term.id === id;
  if (kind === 'post-type') return object.kind === 'post' && object.post.id === id;
  return false;
}

/**
 * block_core_shared_navigation_item_should_render(): links to posts and pages
 * render only while their target is published (filter
 * `render_block_core_navigation_link_allowed_post_status`), so a menu never
 * links to a draft, a trashed page or a deleted one.
 */
async function shouldRender(attributes: BlockAttributes, block: CoreBlock): Promise<boolean> {
  const id = attributes.id;
  const hasId = typeof id === 'number' || (typeof id === 'string' && /^\d+$/.test(id));
  const isPostType =
    attributes.kind === 'post-type' || attributes.type === 'post' || attributes.type === 'page';
  if (!isPostType || !hasId) return true;
  const { kernel } = block.services;
  const post = await kernel.posts.get(Number(id));
  const allowed = (await kernel.hooks.applyFilters(
    'render_block_core_navigation_link_allowed_post_status',
    ['publish'],
    attributes,
    block,
  )) as string[];
  return Boolean(post && allowed.includes(post.status));
}

/** block_core_navigation_link_maybe_urldecode() */
export function maybeUrlDecode(url: string): string {
  const query = url.split('#')[0]?.split('?')[1];
  if (!query) return url;
  for (const pair of query.split('&')) {
    const value = pair.split('=').slice(1).join('=');
    if (!value) continue;
    try {
      if (decodeURIComponent(value) !== value) return decodeURIComponent(url);
    } catch {
      return url;
    }
  }
  return url;
}

/** The attributes of a menu item's <a> after href: aria-current, target, rel, title. */
function linkAttributes(attributes: BlockAttributes, active: boolean): string {
  let html = '';
  if (active) html += ' aria-current="page"';
  if (attributes.opensInNewTab === true) html += ' target="_blank"  ';
  if (typeof attributes.rel === 'string') html += ` rel="${escAttr(attributes.rel)}"`;
  else if (attributes.nofollow === true) html += ' rel="nofollow"';
  if (typeof attributes.title === 'string') html += ` title="${escAttr(attributes.title)}"`;
  return html;
}

/** The label and description spans (wp_kses_post() on both). */
function labelMarkup(attributes: BlockAttributes): string {
  let html = `<span class="wp-block-navigation-item__label">${sanitizePostTitle(String(attributes.label))}</span>`;
  if (typeof attributes.description === 'string' && attributes.description) {
    html += `<span class="wp-block-navigation-item__description">${sanitizePostTitle(attributes.description)}</span>`;
  }
  return html;
}

/** render_block_core_navigation_link() */
export async function renderNavigationLink(
  attributes: BlockAttributes,
  content: string,
  block: CoreBlock,
): Promise<string> {
  if (!(await shouldRender(attributes, block))) return '';
  if (typeof attributes.label !== 'string' || !attributes.label) return '';
  const hasSubmenu = content.trim() !== '';
  const active = isCurrent(attributes);
  const wrapper = getBlockWrapperAttributes(block, {
    class: `wp-block-navigation-item${hasSubmenu ? ' has-child' : ''}${active ? ' current-menu-item' : ''}`,
  });
  let html = `<li ${wrapper}><a class="wp-block-navigation-item__content"`;
  if (typeof attributes.url === 'string') {
    html += ` href="${escUrl(maybeUrlDecode(attributes.url))}"`;
  }
  html += `${linkAttributes(attributes, active)}>${labelMarkup(attributes)}</a>`;
  if (block.context.showSubmenuIcon && hasSubmenu) {
    html += `<span class="wp-block-navigation__submenu-icon">${SUBMENU_ICON}</span>`;
  }
  if (hasSubmenu) html += `<ul class="wp-block-navigation__submenu-container">${content}</ul>`;
  return `${html}</li>`;
}

/** render_block_core_navigation_submenu() */
export async function renderNavigationSubmenu(
  attributes: BlockAttributes,
  content: string,
  block: CoreBlock,
): Promise<string> {
  if (!(await shouldRender(attributes, block))) return '';
  if (typeof attributes.label !== 'string' || !attributes.label) return '';
  const hasSubmenu = content.trim() !== '';
  const active = isCurrent(attributes);
  const showIcons = Boolean(block.context.showSubmenuIcon);
  const visibility = submenuVisibility(block.context);
  const onClick = visibility === 'click';
  const classes = ['wp-block-navigation-item'];
  if (hasSubmenu) classes.push('has-child');
  if (onClick) classes.push('open-on-click');
  if (visibility === 'hover' && showIcons) classes.push('open-on-hover-click');
  if (visibility === 'always') classes.push('open-always');
  if (active) classes.push('current-menu-item');
  // A submenu holding the current page is its ancestor.
  if (content.includes('current-menu-item')) classes.push('current-menu-ancestor');

  const label = sanitizePostTitle(attributes.label);
  const ariaLabel = `${stripAllTags(label)} submenu`;
  let html = `<li ${getBlockWrapperAttributes(block, { class: classes.join(' ') })}>`;
  if (!onClick) {
    // Hover (or always open): the label is a link, plus a toggle button when
    // submenu icons are on, so keyboard and touch users can open it.
    const url = typeof attributes.url === 'string' ? attributes.url : '';
    html += '<a class="wp-block-navigation-item__content"';
    if (url) html += ` href="${escUrl(url)}"`;
    html += `${linkAttributes(attributes, active)}>${labelMarkup(attributes)}</a>`;
    if (showIcons && hasSubmenu) {
      html += `<button aria-label="${escAttr(ariaLabel)}" class="wp-block-navigation__submenu-icon wp-block-navigation-submenu__toggle" aria-expanded="false">${SUBMENU_ICON}</button>`;
    }
  } else {
    // Click: the label itself is the toggle.
    html += `<button aria-label="${escAttr(ariaLabel)}" class="wp-block-navigation-item__content wp-block-navigation-submenu__toggle" aria-expanded="false">${labelMarkup(attributes)}</button>`;
    if (hasSubmenu) {
      html += `<span class="wp-block-navigation__submenu-icon">${SUBMENU_ICON}</span>`;
    }
  }
  if (hasSubmenu) {
    const colors = submenuColors(block.context);
    const container = getBlockWrapperAttributes(block, {
      class: ['wp-block-navigation__submenu-container', ...colors.classes].join(' '),
      style: colors.styles.join(' '),
    });
    html += `<ul ${container.replace(/\s?aria-label="[^"]*"/, '').replace(/\s?id="[^"]*"/, '')}>${content}</ul>`;
  }
  return `${html}</li>`;
}

/** render_block_core_home_link() */
export async function renderHomeLink(
  attributes: BlockAttributes,
  _content: string,
  block: CoreBlock,
): Promise<string> {
  const { kernel } = block.services;
  const site = await siteInfo(kernel);
  const label =
    typeof attributes.label === 'string' && attributes.label
      ? sanitizePostTitle(attributes.label)
      : 'Home';
  const main = currentPage()?.main;
  // is_front_page(), or the blog home when it isn't the posts page.
  let current = Boolean(main?.isFrontPage);
  if (!current && main?.isHome) {
    const postsPage = await kernel.options.get<number>('page_for_posts', 0);
    const queried = main.queriedObject;
    current = !(queried?.kind === 'post' && queried.post.id === postsPage && postsPage);
  }
  const wrapper = getBlockWrapperAttributes(block, {
    class: `wp-block-navigation-item${current ? ' current-menu-item' : ''}`,
  });
  const target = attributes.opensInNewTab === true ? ' target="_blank"' : '';
  const description =
    typeof attributes.description === 'string' && attributes.description
      ? `<span class="wp-block-navigation-item__description">${sanitizePostTitle(attributes.description)}</span>`
      : '';
  return `<li ${wrapper}><a class="wp-block-home-link__content wp-block-navigation-item__content" href="${escUrl(`${site.home}/`)}" rel="home"${target}${current ? ' aria-current="page"' : ''}>${label}${description}</a></li>`;
}
