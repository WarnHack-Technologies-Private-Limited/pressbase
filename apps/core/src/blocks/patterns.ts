/**
 * Block patterns — WP_Block_Patterns_Registry and
 * WP_Block_Pattern_Categories_Registry (wordpress/wp-includes/class-wp-block-patterns-registry.php,
 * class-wp-block-pattern-categories-registry.php), plus Pressbase's built-in
 * patterns and WordPress's core pattern categories
 * (_register_core_block_patterns_and_categories() in block-patterns.php).
 *
 * Built-in patterns use core blocks only, in exactly the markup the block
 * editor saves, so they insert without validation warnings.
 */

export interface BlockPattern {
  name: string;
  title: string;
  content: string;
  description?: string;
  categories?: string[];
  keywords?: string[];
  viewportWidth?: number;
  blockTypes?: string[];
  postTypes?: string[];
  templateTypes?: string[];
  inserter?: boolean;
  /** 'core' for Pressbase's own, 'plugin' or 'theme' for others. */
  source?: string;
}

export interface BlockPatternCategory {
  name: string;
  label: string;
  description?: string;
}

export const CORE_PATTERN_CATEGORIES: BlockPatternCategory[] = [
  {
    name: 'banner',
    label: 'Banners',
    description: 'Bold sections designed to showcase key content.',
  },
  {
    name: 'buttons',
    label: 'Buttons',
    description: 'Patterns that contain buttons and call to actions.',
  },
  {
    name: 'columns',
    label: 'Columns',
    description: 'Multi-column patterns with more complex layouts.',
  },
  { name: 'text', label: 'Text', description: 'Patterns containing mostly text.' },
  {
    name: 'query',
    label: 'Posts',
    description: 'Display your latest posts in lists, grids or other layouts.',
  },
  { name: 'featured', label: 'Featured', description: 'A set of high quality curated patterns.' },
  {
    name: 'call-to-action',
    label: 'Call to action',
    description: 'Sections whose purpose is to trigger a specific action.',
  },
  {
    name: 'team',
    label: 'Team',
    description: 'A variety of designs to display your team members.',
  },
  {
    name: 'testimonials',
    label: 'Testimonials',
    description: 'Share reviews and feedback about your brand/business.',
  },
  {
    name: 'services',
    label: 'Services',
    description: 'Briefly describe what your business does and how you can help.',
  },
  { name: 'contact', label: 'Contact', description: 'Display your contact information.' },
  { name: 'about', label: 'About', description: 'Introduce yourself.' },
  { name: 'portfolio', label: 'Portfolio', description: 'Showcase your latest work.' },
  { name: 'gallery', label: 'Gallery', description: 'Different layouts for displaying images.' },
  { name: 'media', label: 'Media', description: 'Different layouts containing video or audio.' },
  { name: 'videos', label: 'Videos', description: 'Different layouts containing videos.' },
  { name: 'audio', label: 'Audio', description: 'Different layouts containing audio.' },
  {
    name: 'posts',
    label: 'Posts',
    description: 'Display your latest posts in lists, grids or other layouts.',
  },
  {
    name: 'footer',
    label: 'Footers',
    description: 'A variety of footer designs displaying information and site navigation.',
  },
  {
    name: 'header',
    label: 'Headers',
    description: 'A variety of header designs displaying your site title and navigation.',
  },
];

const paragraph = (text: string) => `<!-- wp:paragraph -->\n<p>${text}</p>\n<!-- /wp:paragraph -->`;
const heading = (level: number, text: string) =>
  `<!-- wp:heading${level === 2 ? '' : ` {"level":${level}}`} -->\n<h${level} class="wp-block-heading">${text}</h${level}>\n<!-- /wp:heading -->`;
const button = (text: string, outline = false) =>
  outline
    ? `<!-- wp:button {"className":"is-style-outline"} -->\n<div class="wp-block-button is-style-outline"><a class="wp-block-button__link wp-element-button">${text}</a></div>\n<!-- /wp:button -->`
    : `<!-- wp:button -->\n<div class="wp-block-button"><a class="wp-block-button__link wp-element-button">${text}</a></div>\n<!-- /wp:button -->`;
const buttons = (...items: string[]) =>
  `<!-- wp:buttons -->\n<div class="wp-block-buttons">${items.join('\n\n')}</div>\n<!-- /wp:buttons -->`;
const group = (inner: string[], align?: 'wide' | 'full') =>
  `<!-- wp:group {${align ? `"align":"${align}",` : ''}"layout":{"type":"constrained"}} -->\n<div class="wp-block-group${align ? ` align${align}` : ''}">${inner.join('\n\n')}</div>\n<!-- /wp:group -->`;
const column = (inner: string[]) =>
  `<!-- wp:column -->\n<div class="wp-block-column">${inner.join('\n\n')}</div>\n<!-- /wp:column -->`;
const columns = (...items: string[]) =>
  `<!-- wp:columns -->\n<div class="wp-block-columns">${items.join('\n\n')}</div>\n<!-- /wp:columns -->`;

export const CORE_PATTERNS: BlockPattern[] = [
  {
    name: 'pressbase/hero',
    title: 'Hero with heading, text and buttons',
    description: 'A large headline with a short introduction and two buttons.',
    categories: ['banner', 'featured'],
    keywords: ['hero', 'intro', 'header', 'cover'],
    viewportWidth: 1200,
    source: 'core',
    content: group(
      [
        heading(1, 'A headline that says what you do'),
        paragraph(
          'One or two sentences that tell visitors they’re in the right place, and what they can do next.',
        ),
        buttons(button('Get started'), button('Learn more', true)),
      ],
      'full',
    ),
  },
  {
    name: 'pressbase/two-columns-text',
    title: 'Two columns of text',
    description: 'Two short sections side by side, each with a heading.',
    categories: ['text', 'columns'],
    keywords: ['columns', 'features', 'text'],
    viewportWidth: 1200,
    source: 'core',
    content: columns(
      column([
        heading(3, 'What we do'),
        paragraph('Describe the first thing your readers should know. Keep it short and specific.'),
      ]),
      column([
        heading(3, 'How we do it'),
        paragraph('Follow it with a second point that builds on the first, in a sentence or two.'),
      ]),
    ),
  },
  {
    name: 'pressbase/call-to-action',
    title: 'Call to action',
    description: 'A heading, a sentence and one clear button.',
    categories: ['call-to-action', 'buttons'],
    keywords: ['cta', 'button', 'signup', 'subscribe'],
    viewportWidth: 1000,
    source: 'core',
    content: group(
      [
        heading(2, 'Ready when you are'),
        paragraph('Tell readers what happens when they click, and why it’s worth it.'),
        buttons(button('Start now')),
      ],
      'wide',
    ),
  },
  {
    name: 'pressbase/quote',
    title: 'Quote',
    description: 'A short quotation with its source.',
    categories: ['text', 'testimonials'],
    keywords: ['quote', 'testimonial', 'review'],
    viewportWidth: 800,
    source: 'core',
    content: `<!-- wp:quote -->\n<blockquote class="wp-block-quote">${paragraph(
      '“Pressbase made it easy to publish exactly what we meant to say.”',
    )}<cite>Ada Writer, Editor</cite></blockquote>\n<!-- /wp:quote -->`,
  },
  {
    name: 'pressbase/about-me',
    title: 'About me',
    description: 'A short introduction with a list of things you do.',
    categories: ['about', 'text'],
    keywords: ['about', 'bio', 'profile', 'introduction'],
    viewportWidth: 800,
    source: 'core',
    content: group([
      heading(2, 'About me'),
      paragraph(
        'I write about the things I build and the lessons I learn along the way. This is the place to say who you are and what readers can expect.',
      ),
      `<!-- wp:list -->\n<ul class="wp-block-list"><!-- wp:list-item -->\n<li>Writing and editing</li>\n<!-- /wp:list-item -->\n\n<!-- wp:list-item -->\n<li>Design and photography</li>\n<!-- /wp:list-item -->\n\n<!-- wp:list-item -->\n<li>Speaking and teaching</li>\n<!-- /wp:list-item --></ul>\n<!-- /wp:list -->`,
      '<!-- wp:separator -->\n<hr class="wp-block-separator has-alpha-channel-opacity"/>\n<!-- /wp:separator -->',
      paragraph('Say hello any time.'),
    ]),
  },
  {
    name: 'pressbase/image-and-text',
    title: 'Image and text',
    description: 'An image beside a heading and a paragraph. Choose the image after inserting.',
    categories: ['media', 'columns', 'featured'],
    keywords: ['image', 'media', 'text', 'side by side'],
    viewportWidth: 1200,
    source: 'core',
    content: `<!-- wp:media-text -->\n<div class="wp-block-media-text is-stacked-on-mobile"><figure class="wp-block-media-text__media"></figure><div class="wp-block-media-text__content">${heading(
      3,
      'A picture and a few words',
    )}\n\n${paragraph(
      'Pair an image with a short story about it. Replace the image from the block toolbar.',
    )}</div></div>\n<!-- /wp:media-text -->`,
  },
];
