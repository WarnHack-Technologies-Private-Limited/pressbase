import { escAttr, escUrl } from '@pressbase/blocks';
import type { HookBus } from '@pressbase/hooks';
import { NAVIGATION_NOSCRIPT } from '../blocks/library/navigation';
import { permalink, permalinkContext } from '../content/permalinks';
import type { Kernel } from '../kernel';
import { siteIconTags } from '../themes/site-identity';
import { PRESSBASE_VERSION } from '../version';
import { Scripts, type Strategy, Styles, type Version } from './dependencies';
import { feedLinkTags } from './feeds';
import { currentPage, type PageRender } from './page';
import { documentTitle } from './title';

/**
 * Public page hooks: what wp_head(), wp_body_open(), wp_footer() and
 * wp_enqueue_scripts do for a theme (wordpress/wp-includes/general-template.php,
 * default-filters.php, script-loader.php), and the `kernel.scripts` /
 * `kernel.styles` API plugins use to add to public pages
 * (functions.wp-scripts.php, functions.wp-styles.php).
 *
 * Output model. WordPress's head callbacks `echo`. Here a callback receives
 * an `HtmlOutput` and calls `out.print(html)`; callbacks run one after the
 * other in priority order (async ones are awaited), so what they print lands
 * in priority order too. Core's own head pieces are callbacks on the same
 * actions, so a plugin's `wp_head` callback at priority 10 prints after the
 * styles (8) and head scripts (9) and before the fonts (50) and site icon
 * (99), as in WordPress.
 *
 * Everything printed is part of the cached page (ADR 0008): anonymous
 * visitors share it. Never print per-visitor output (names, nonces, cart
 * contents) from these hooks; `page.user` is null for every cacheable render.
 *
 * See docs/architecture/scripts-and-styles.md.
 */

/** Collects HTML printed by `wp_head`, `wp_body_open` and `wp_footer` callbacks. */
export class HtmlOutput {
  #parts: string[] = [];

  /** Adds HTML to the page as is: escape what you print (escHtml, escAttr, escUrl). */
  print(...html: (string | false | null | undefined)[]): void {
    for (const piece of html) {
      if (typeof piece !== 'string') continue;
      const trimmed = piece.replace(/^\n+|\s+$/g, '');
      if (trimmed) this.#parts.push(trimmed);
    }
  }

  get empty(): boolean {
    return this.#parts.length === 0;
  }

  toString(): string {
    return this.#parts.join('\n');
  }
}

declare module '@pressbase/hooks' {
  interface ActionRegistry {
    wp_enqueue_scripts: [page: PageRender];
    wp_head: [out: HtmlOutput, page: PageRender];
    wp_body_open: [out: HtmlOutput, page: PageRender];
    wp_footer: [out: HtmlOutput, page: PageRender];
  }
  interface FilterRegistry {
    wp_robots: [robots: Record<string, string | boolean>];
    the_generator: [html: string, type: string];
  }
}

/** The URL of WordPress's front-end block styles, served by core (routes/frontend.ts). */
export const BLOCK_LIBRARY_CSS = '/wp-includes/css/dist/block-library/style.min.css';
const SKIP_LINK_CSS =
  '.skip-link.screen-reader-text{border:0;clip-path:inset(50%);height:1px;margin:-1px;overflow:hidden;padding:0;position:absolute!important;width:1px;word-wrap:normal!important;word-break:normal!important}.skip-link.screen-reader-text:focus{background-color:#eee;clip-path:none;color:#444;display:block;font-size:1em;height:auto;left:5px;line-height:normal;padding:15px 23px 14px;text-decoration:none;top:5px;width:auto;z-index:100000}';

export interface ScriptOptions {
  /** Print in the footer (`wp_footer`) rather than the head. */
  inFooter?: boolean;
  /** `defer` or `async`; falls back to blocking when a dependent script needs it to (WordPress 6.3+). */
  strategy?: Strategy;
}

/**
 * `kernel.scripts`: wp_register_script(), wp_enqueue_script(),
 * wp_add_inline_script(), wp_localize_script()…
 *
 * Called while a page renders (in `wp_enqueue_scripts`, a block's render
 * callback, `wp_head`), it changes that page only. Called outside a render
 * (when a plugin loads, on `init`), it changes the site-wide registrations
 * every page starts from: a script enqueued then is on every public page.
 */
export class ScriptsApi {
  readonly #base: Scripts;

  constructor(hooks: HookBus) {
    this.#base = new Scripts(PRESSBASE_VERSION, hooks);
  }

  get #target(): Scripts {
    return currentPage()?.scripts ?? this.#base;
  }

  /** A copy of the site-wide registrations for one page render. */
  forPage(): Scripts {
    return this.#base.clone();
  }

  /** wp_register_script(): false when the handle is taken. `ver` undefined means Pressbase's version, null none. */
  register(
    handle: string,
    src: string | false,
    deps: string[] = [],
    ver?: Version,
    options: ScriptOptions | boolean = {},
  ): boolean {
    const target = this.#target;
    if (!target.add(handle, src, deps, ver)) return false;
    const opts = typeof options === 'boolean' ? { inFooter: options } : options;
    if (opts.inFooter) target.addData(handle, 'group', 1);
    if (opts.strategy) target.setStrategy(handle, opts.strategy);
    return true;
  }

  /** wp_enqueue_script(): registers first when a source (or options) is given. */
  enqueue(
    handle: string,
    src?: string | false,
    deps: string[] = [],
    ver?: Version,
    options: ScriptOptions | boolean = {},
  ): void {
    if (src || options === true || (typeof options === 'object' && options.inFooter)) {
      this.register(handle.split('?')[0] ?? handle, src ?? false, deps, ver, options);
    }
    this.#target.enqueue(handle);
  }

  /** wp_dequeue_script() */
  dequeue(handle: string): void {
    this.#target.dequeue(handle);
  }

  /** wp_deregister_script() */
  deregister(handle: string): void {
    this.#target.remove(handle);
  }

  /** wp_script_is() */
  is(handle: string, status: 'registered' | 'enqueued' | 'to_do' | 'done' = 'enqueued'): boolean {
    return this.#target.query(handle, status);
  }

  /** wp_add_inline_script(): code without `<script>` tags, printed before or after the script. */
  addInline(handle: string, code: string, position: 'before' | 'after' = 'after'): boolean {
    return this.#target.addInlineScript(handle, code, position);
  }

  /** wp_localize_script(): `var objectName = {…};` printed before the script. */
  localize(handle: string, objectName: string, data: Record<string, unknown>): boolean {
    return this.#target.localize(handle, objectName, data);
  }
}

/** `kernel.styles`: wp_register_style(), wp_enqueue_style(), wp_add_inline_style()… (same scoping as `kernel.scripts`). */
export class StylesApi {
  readonly #base: Styles;

  constructor(hooks: HookBus) {
    this.#base = new Styles(PRESSBASE_VERSION, hooks);
  }

  get #target(): Styles {
    return currentPage()?.styles ?? this.#base;
  }

  forPage(): Styles {
    return this.#base.clone();
  }

  /** wp_register_style(): `src` false for a handle that only carries inline CSS or groups others. */
  register(
    handle: string,
    src: string | false,
    deps: string[] = [],
    ver?: Version,
    media = 'all',
  ): boolean {
    return this.#target.add(handle, src, deps, ver, media);
  }

  /** wp_enqueue_style() */
  enqueue(handle: string, src?: string | false, deps: string[] = [], ver?: Version, media = 'all') {
    if (src) this.register(handle.split('?')[0] ?? handle, src, deps, ver, media);
    this.#target.enqueue(handle);
  }

  dequeue(handle: string): void {
    this.#target.dequeue(handle);
  }

  deregister(handle: string): void {
    this.#target.remove(handle);
  }

  /** wp_style_is() */
  is(handle: string, status: 'registered' | 'enqueued' | 'to_do' | 'done' = 'enqueued'): boolean {
    return this.#target.query(handle, status);
  }

  /** wp_add_inline_style(): CSS without `<style>` tags, printed after the stylesheet. */
  addInline(handle: string, css: string): boolean {
    return this.#target.addInlineStyle(handle, css);
  }
}

/**
 * The styles every page of a block theme enqueues: the block library
 * (wp_common_block_scripts_and_styles()), the skip link
 * (wp_enqueue_block_template_skip_link()), global styles
 * (wp_enqueue_global_styles()), block supports and style variations
 * (wp_enqueue_stored_styles()), the theme's block styles and stylesheets
 * (its functions.php, see themes/compat.ts).
 */
function enqueueThemeStyles(kernel: Kernel, page: PageRender): void {
  const styles = kernel.styles;
  const theme = page.theme;
  const inline = (handle: string, css: string) => {
    styles.register(handle, false);
    styles.addInline(handle, css);
    styles.enqueue(handle);
  };
  styles.enqueue('wp-block-library', BLOCK_LIBRARY_CSS);
  if (page.skipLinkTarget) inline('wp-block-template-skip-link', SKIP_LINK_CSS);
  inline('global-styles', theme.css.global + theme.css.custom);
  inline('block-style-variation-styles', page.variationStyles.join(''));
  inline('core-block-supports', page.supportStyles.join(''));
  inline('theme-block-styles', theme.css.blockStyles);
  theme.stylesheets.forEach((href, i) => {
    styles.enqueue(
      `${theme.info.stylesheet}-style${i ? `-${i}` : ''}`,
      href,
      [],
      theme.info.version,
    );
  });
}

/**
 * Core's own `wp_enqueue_scripts`, `wp_head` and `wp_footer` callbacks, at
 * WordPress's priorities (default-filters.php) where the page's order allows:
 * viewport 0; robots, title, generator and canonical 1 (WordPress prints the
 * last two at 10); feed links 2; styles 8; head scripts 9; fonts 50; site
 * icon 99. In the footer: the navigation script 10, late styles and footer
 * scripts 20.
 */
export function registerPublicPageHooks(kernel: Kernel): void {
  const { hooks } = kernel;

  hooks.addAction('wp_enqueue_scripts', (page) => enqueueThemeStyles(kernel, page));

  // _block_template_viewport_meta_tag()
  hooks.addAction(
    'wp_head',
    (out) => out.print('<meta name="viewport" content="width=device-width, initial-scale=1" />'),
    0,
  );
  // wp_robots(), with wp_robots_noindex() and wp_robots_max_image_preview_large() as defaults.
  hooks.addAction(
    'wp_head',
    async (out) => {
      const blogPublic = await kernel.options.get<boolean>('blog_public', true);
      const defaults: Record<string, string | boolean> = blogPublic
        ? { 'max-image-preview': 'large' }
        : { noindex: true, nofollow: true };
      const robots = (await hooks.applyFilters('wp_robots', defaults)) ?? {};
      const directives = Object.entries(robots).flatMap(([name, value]) =>
        typeof value === 'string' ? [`${name}:${value}`] : value ? [name] : [],
      );
      if (directives.length) {
        out.print(`<meta name='robots' content='${escAttr(directives.join(', '))}' />`);
      }
    },
    1,
  );
  // _wp_render_title_tag()
  hooks.addAction(
    'wp_head',
    async (out, page) => out.print(`<title>${await documentTitle(kernel, page.main)}</title>`),
    1,
  );
  // wp_generator()
  hooks.addAction(
    'wp_head',
    async (out) => {
      const tag = `<meta name="generator" content="Pressbase ${escAttr(PRESSBASE_VERSION)}" />`;
      out.print(await hooks.applyFilters('the_generator', tag, 'html'));
    },
    1,
  );
  // rel_canonical()
  hooks.addAction(
    'wp_head',
    async (out, page) => {
      const object = page.main.queriedObject;
      if (!page.main.isSingular || object?.kind !== 'post' || object.post.status !== 'publish')
        return;
      const link = await permalink(kernel, object.post, await permalinkContext(kernel));
      out.print(`<link rel="canonical" href="${escUrl(link)}" />`);
    },
    1,
  );
  // feed_links() and feed_links_extra(): block themes support automatic-feed-links.
  hooks.addAction(
    'wp_head',
    async (out, page) => {
      if (!page.main.is404) out.print(...(await feedLinkTags(kernel, page.main)));
    },
    2,
  );
  // wp_print_styles(), wp_print_head_scripts()
  hooks.addAction('wp_head', async (out, page) => out.print(await page.styles?.doItems()), 8);
  hooks.addAction('wp_head', async (out, page) => out.print(await page.scripts?.doHeadItems()), 9);
  // wp_print_font_faces()
  hooks.addAction(
    'wp_head',
    (out, page) => {
      const faces = page.theme.css.fontFaces;
      if (faces) out.print(`<style class='wp-fonts-local'>\n${faces}\n</style>`);
    },
    50,
  );
  // The navigation block works without JavaScript too.
  hooks.addAction(
    'wp_head',
    (out, page) => {
      if (page.inlineScripts.size) out.print(NAVIGATION_NOSCRIPT);
    },
    50,
  );
  // wp_site_icon()
  hooks.addAction('wp_head', async (out) => out.print(await siteIconTags(kernel)), 99);

  // The navigation block's toggle script (WordPress prints its view script module in the footer).
  hooks.addAction('wp_footer', (out, page) => {
    for (const js of page.inlineScripts)
      out.print(`<script>${js.replaceAll('</script', '<\\/script')}</script>`);
  });
  // wp_print_footer_scripts(): late styles, then footer scripts.
  hooks.addAction(
    'wp_footer',
    async (out, page) => {
      out.print(await page.styles?.doItems(), await page.scripts?.doFooterItems());
    },
    20,
  );
}
