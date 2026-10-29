import type { BlockPatternCategory } from '../blocks/patterns';

/**
 * What block themes' functions.php files do, reproduced without PHP.
 * Pressbase never runs functions.php; for bundled and well-known themes the
 * effects that matter on the front end are listed here. Other themes get
 * none of them — the vision's promise is theme.json plus HTML templates.
 *
 * Twenty Twenty-Five's functions.php (WordPress 7.1.3):
 * - add_theme_support( 'post-formats', … ): reproduced (`postFormats`), but
 *   Pressbase has no post formats yet, so posts are always "standard".
 * - add_editor_style( 'assets/css/editor-style.css' ): editor only; the
 *   admin's editor doesn't load theme styles yet.
 * - wp_enqueue_style( 'twentytwentyfive-style', style.min.css ): reproduced.
 * - register_block_style( 'core/list', checkmark-list ): reproduced, with
 *   its inline CSS.
 * - register_block_pattern_category( twentytwentyfive_page / _post-format ):
 *   reproduced.
 * - register_block_bindings_source( 'twentytwentyfive/format' ): not
 *   reproduced (block bindings arrive later); the binding-format pattern
 *   renders its fallback text.
 *
 * Pressbase's functions.php (themes/pressbase):
 * - add_editor_style( 'style.css' ): editor only, not reproduced yet.
 * - wp_enqueue_style( 'pressbase-style', style.css ): reproduced.
 * - register_block_style() for the motion and surface styles (Reveal, Lift,
 *   Glass, Gradient, Marquee, Animated links, Pill): reproduced; their CSS is
 *   in style.css, so they have no inline style.
 * - register_block_pattern_category( pressbase / pressbase_page ): reproduced.
 */
export interface ThemeCompat {
  /** Stylesheets the theme enqueues, relative to its folder. */
  stylesheets: string[];
  blockStyles: { block: string; name: string; label: string; inlineStyle?: string }[];
  patternCategories: BlockPatternCategory[];
  postFormats: string[];
}

export const THEME_COMPAT: Record<string, ThemeCompat> = {
  twentytwentyfive: {
    stylesheets: ['style.min.css'],
    blockStyles: [
      {
        block: 'core/list',
        name: 'checkmark-list',
        label: 'Checkmark',
        inlineStyle:
          'ul.is-style-checkmark-list{list-style-type:"\\2713";}ul.is-style-checkmark-list li{padding-inline-start:1ch;}',
      },
    ],
    patternCategories: [
      {
        name: 'twentytwentyfive_page',
        label: 'Pages',
        description: 'A collection of full page layouts.',
      },
      {
        name: 'twentytwentyfive_post-format',
        label: 'Post formats',
        description: 'A collection of post format patterns.',
      },
    ],
    postFormats: ['aside', 'audio', 'chat', 'gallery', 'image', 'link', 'quote', 'status', 'video'],
  },
  pressbase: {
    stylesheets: ['style.css'],
    blockStyles: [
      { block: 'core/group', name: 'reveal', label: 'Reveal' },
      { block: 'core/group', name: 'lift', label: 'Lift' },
      { block: 'core/group', name: 'glass', label: 'Glass' },
      { block: 'core/group', name: 'gradient', label: 'Gradient' },
      { block: 'core/group', name: 'marquee', label: 'Marquee' },
      { block: 'core/group', name: 'links', label: 'Animated links' },
      { block: 'core/columns', name: 'reveal', label: 'Reveal' },
      { block: 'core/column', name: 'lift', label: 'Lift' },
      { block: 'core/column', name: 'glass', label: 'Glass' },
      { block: 'core/image', name: 'reveal', label: 'Reveal' },
      { block: 'core/cover', name: 'gradient', label: 'Gradient' },
      { block: 'core/paragraph', name: 'pill', label: 'Pill' },
    ],
    patternCategories: [
      {
        name: 'pressbase',
        label: 'Pressbase',
        description: 'Sections from the Pressbase theme: heroes, features, pricing and more.',
      },
      { name: 'pressbase_page', label: 'Pages', description: 'Full page layouts.' },
    ],
    postFormats: [],
  },
};
