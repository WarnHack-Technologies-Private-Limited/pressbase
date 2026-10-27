/**
 * Tables from WP_Theme_JSON (wordpress/wp-includes/class-wp-theme-json.php),
 * WordPress 7.1.3. Order matters: it is the order of the generated CSS.
 */

export const ROOT_BLOCK_SELECTOR = 'body';
export const ROOT_CSS_PROPERTIES_SELECTOR = ':root';
export const VALID_ORIGINS = ['default', 'blocks', 'theme', 'custom'] as const;
export const LATEST_SCHEMA = 3;

export interface PresetMetadata {
  path: string[];
  preventOverride: string[] | false;
  useDefaultNames: boolean;
  valueKey?: string;
  /** 'fontSize' uses wp_get_typography_font_size_value(). */
  valueFunc?: 'fontSize';
  cssVars: string | null;
  classes: Record<string, string>;
}

/** PRESETS_METADATA */
export const PRESETS_METADATA: PresetMetadata[] = [
  {
    path: ['dimensions', 'aspectRatios'],
    preventOverride: ['dimensions', 'defaultAspectRatios'],
    useDefaultNames: false,
    valueKey: 'ratio',
    cssVars: '--wp--preset--aspect-ratio--$slug',
    classes: {},
  },
  {
    path: ['color', 'palette'],
    preventOverride: ['color', 'defaultPalette'],
    useDefaultNames: false,
    valueKey: 'color',
    cssVars: '--wp--preset--color--$slug',
    classes: {
      '.has-$slug-color': 'color',
      '.has-$slug-background-color': 'background-color',
      '.has-$slug-border-color': 'border-color',
    },
  },
  {
    path: ['color', 'gradients'],
    preventOverride: ['color', 'defaultGradients'],
    useDefaultNames: false,
    valueKey: 'gradient',
    cssVars: '--wp--preset--gradient--$slug',
    classes: { '.has-$slug-gradient-background': 'background' },
  },
  {
    path: ['color', 'duotone'],
    preventOverride: ['color', 'defaultDuotone'],
    useDefaultNames: false,
    cssVars: null,
    classes: {},
  },
  {
    path: ['typography', 'fontSizes'],
    preventOverride: ['typography', 'defaultFontSizes'],
    useDefaultNames: true,
    valueFunc: 'fontSize',
    cssVars: '--wp--preset--font-size--$slug',
    classes: { '.has-$slug-font-size': 'font-size' },
  },
  {
    path: ['typography', 'fontFamilies'],
    preventOverride: false,
    useDefaultNames: false,
    valueKey: 'fontFamily',
    cssVars: '--wp--preset--font-family--$slug',
    classes: { '.has-$slug-font-family': 'font-family' },
  },
  {
    path: ['spacing', 'spacingSizes'],
    preventOverride: ['spacing', 'defaultSpacingSizes'],
    useDefaultNames: true,
    valueKey: 'size',
    cssVars: '--wp--preset--spacing--$slug',
    classes: {},
  },
  {
    path: ['shadow', 'presets'],
    preventOverride: ['shadow', 'defaultPresets'],
    useDefaultNames: false,
    valueKey: 'shadow',
    cssVars: '--wp--preset--shadow--$slug',
    classes: {},
  },
  {
    path: ['border', 'radiusSizes'],
    preventOverride: false,
    useDefaultNames: false,
    valueKey: 'size',
    cssVars: '--wp--preset--border-radius--$slug',
    classes: {},
  },
  {
    path: ['dimensions', 'dimensionSizes'],
    preventOverride: false,
    useDefaultNames: false,
    valueKey: 'size',
    cssVars: '--wp--preset--dimension--$slug',
    classes: {},
  },
];

/** PROPERTIES_METADATA: CSS property → path in a styles node. */
export const PROPERTIES_METADATA: [string, string[]][] = [
  ['aspect-ratio', ['dimensions', 'aspectRatio']],
  ['background', ['color', 'gradient']],
  ['background-color', ['color', 'background']],
  ['background-image', ['background', 'backgroundImage']],
  ['background-position', ['background', 'backgroundPosition']],
  ['background-repeat', ['background', 'backgroundRepeat']],
  ['background-size', ['background', 'backgroundSize']],
  ['background-attachment', ['background', 'backgroundAttachment']],
  ['border-radius', ['border', 'radius']],
  ['border-top-left-radius', ['border', 'radius', 'topLeft']],
  ['border-top-right-radius', ['border', 'radius', 'topRight']],
  ['border-bottom-left-radius', ['border', 'radius', 'bottomLeft']],
  ['border-bottom-right-radius', ['border', 'radius', 'bottomRight']],
  ['border-color', ['border', 'color']],
  ['border-width', ['border', 'width']],
  ['border-style', ['border', 'style']],
  ['border-top-color', ['border', 'top', 'color']],
  ['border-top-width', ['border', 'top', 'width']],
  ['border-top-style', ['border', 'top', 'style']],
  ['border-right-color', ['border', 'right', 'color']],
  ['border-right-width', ['border', 'right', 'width']],
  ['border-right-style', ['border', 'right', 'style']],
  ['border-bottom-color', ['border', 'bottom', 'color']],
  ['border-bottom-width', ['border', 'bottom', 'width']],
  ['border-bottom-style', ['border', 'bottom', 'style']],
  ['border-left-color', ['border', 'left', 'color']],
  ['border-left-width', ['border', 'left', 'width']],
  ['border-left-style', ['border', 'left', 'style']],
  ['color', ['color', 'text']],
  ['text-align', ['typography', 'textAlign']],
  ['column-count', ['typography', 'textColumns']],
  ['font-family', ['typography', 'fontFamily']],
  ['font-size', ['typography', 'fontSize']],
  ['font-style', ['typography', 'fontStyle']],
  ['font-weight', ['typography', 'fontWeight']],
  ['letter-spacing', ['typography', 'letterSpacing']],
  ['line-height', ['typography', 'lineHeight']],
  ['margin', ['spacing', 'margin']],
  ['margin-top', ['spacing', 'margin', 'top']],
  ['margin-right', ['spacing', 'margin', 'right']],
  ['margin-bottom', ['spacing', 'margin', 'bottom']],
  ['margin-left', ['spacing', 'margin', 'left']],
  ['min-height', ['dimensions', 'minHeight']],
  ['min-width', ['dimensions', 'minWidth']],
  ['outline-color', ['outline', 'color']],
  ['outline-offset', ['outline', 'offset']],
  ['outline-style', ['outline', 'style']],
  ['outline-width', ['outline', 'width']],
  ['padding', ['spacing', 'padding']],
  ['padding-top', ['spacing', 'padding', 'top']],
  ['padding-right', ['spacing', 'padding', 'right']],
  ['padding-bottom', ['spacing', 'padding', 'bottom']],
  ['padding-left', ['spacing', 'padding', 'left']],
  ['--wp--style--root--padding', ['spacing', 'padding']],
  ['--wp--style--root--padding-top', ['spacing', 'padding', 'top']],
  ['--wp--style--root--padding-right', ['spacing', 'padding', 'right']],
  ['--wp--style--root--padding-bottom', ['spacing', 'padding', 'bottom']],
  ['--wp--style--root--padding-left', ['spacing', 'padding', 'left']],
  ['text-decoration', ['typography', 'textDecoration']],
  ['text-shadow', ['typography', 'textShadow']],
  ['text-transform', ['typography', 'textTransform']],
  ['text-indent', ['typography', 'textIndent']],
  ['filter', ['filter', 'duotone']],
  ['box-shadow', ['shadow']],
  ['height', ['dimensions', 'height']],
  ['width', ['dimensions', 'width']],
  ['writing-mode', ['typography', 'writingMode']],
];

/** ELEMENTS */
export const ELEMENTS: Record<string, string> = {
  link: 'a:where(:not(.wp-element-button))',
  heading: 'h1, h2, h3, h4, h5, h6',
  h1: 'h1',
  h2: 'h2',
  h3: 'h3',
  h4: 'h4',
  h5: 'h5',
  h6: 'h6',
  button: '.wp-element-button, .wp-block-button__link',
  caption:
    '.wp-element-caption, .wp-block-audio figcaption, .wp-block-embed figcaption, .wp-block-gallery figcaption, .wp-block-image figcaption, .wp-block-table figcaption, .wp-block-video figcaption',
  cite: 'cite',
  textInput:
    'textarea, input:where([type=email],[type=number],[type=password],[type=search],[type=text],[type=tel],[type=url])',
  select: 'select',
};

/** __EXPERIMENTAL_ELEMENT_CLASS_NAMES */
export const ELEMENT_CLASS_NAMES: Record<string, string> = {
  button: 'wp-element-button',
  caption: 'wp-element-caption',
};

const STATES = [':link', ':any-link', ':visited', ':hover', ':focus', ':focus-visible', ':active'];

/** VALID_ELEMENT_PSEUDO_SELECTORS */
export const VALID_ELEMENT_PSEUDO_SELECTORS: Record<string, string[]> = {
  link: STATES,
  button: STATES,
};

/** VALID_BLOCK_PSEUDO_SELECTORS */
export const VALID_BLOCK_PSEUDO_SELECTORS: Record<string, string[]> = {
  'core/button': [':hover', ':focus', ':focus-visible', ':active'],
  'core/navigation-link': [':hover', ':focus', ':focus-visible', ':active'],
};

/** VALID_BLOCK_CUSTOM_STATES */
export const VALID_BLOCK_CUSTOM_STATES: Record<string, string[]> = {
  'core/navigation-link': ['-current'],
};

/** VALID_TOP_LEVEL_KEYS */
export const VALID_TOP_LEVEL_KEYS = [
  'blockTypes',
  'customTemplates',
  'description',
  'patterns',
  'settings',
  'slug',
  'styles',
  'templateParts',
  'title',
  'version',
];

/** APPEARANCE_TOOLS_OPT_INS */
export const APPEARANCE_TOOLS_OPT_INS: string[][] = [
  ['background', 'backgroundImage'],
  ['background', 'backgroundSize'],
  ['background', 'gradient'],
  ['border', 'color'],
  ['border', 'radius'],
  ['border', 'style'],
  ['border', 'width'],
  ['color', 'link'],
  ['color', 'heading'],
  ['color', 'button'],
  ['color', 'caption'],
  ['dimensions', 'aspectRatio'],
  ['dimensions', 'height'],
  ['dimensions', 'minHeight'],
  ['dimensions', 'minWidth'],
  ['dimensions', 'width'],
  ['position', 'sticky'],
  ['spacing', 'blockGap'],
  ['spacing', 'margin'],
  ['spacing', 'padding'],
  ['typography', 'lineHeight'],
  ['typography', 'textColumns'],
];

export interface LayoutRule {
  selector: string;
  /** A null value is replaced by the block gap. */
  rules: Record<string, string | null>;
}

export interface LayoutDefinition {
  name: string;
  slug: string;
  className: string;
  displayMode?: 'flex' | 'grid';
  baseStyles: LayoutRule[];
  spacingStyles: LayoutRule[];
}

const ALIGN_FLOATS: LayoutRule[] = [
  {
    selector: ' > .alignleft',
    rules: { float: 'left', 'margin-inline-start': '0', 'margin-inline-end': '2em' },
  },
  {
    selector: ' > .alignright',
    rules: { float: 'right', 'margin-inline-start': '2em', 'margin-inline-end': '0' },
  },
  {
    selector: ' > .aligncenter',
    rules: { 'margin-left': 'auto !important', 'margin-right': 'auto !important' },
  },
];

const FLOW_SPACING: LayoutRule[] = [
  { selector: ' > :first-child', rules: { 'margin-block-start': '0' } },
  { selector: ' > :last-child', rules: { 'margin-block-end': '0' } },
  { selector: ' > *', rules: { 'margin-block-start': null, 'margin-block-end': '0' } },
];

/** wp_get_layout_definitions() (wordpress/wp-includes/block-supports/layout.php) */
export const LAYOUT_DEFINITIONS: Record<string, LayoutDefinition> = {
  default: {
    name: 'default',
    slug: 'flow',
    className: 'is-layout-flow',
    baseStyles: ALIGN_FLOATS,
    spacingStyles: FLOW_SPACING,
  },
  constrained: {
    name: 'constrained',
    slug: 'constrained',
    className: 'is-layout-constrained',
    baseStyles: [
      ...ALIGN_FLOATS,
      {
        selector: ' > :where(:not(.alignleft):not(.alignright):not(.alignfull))',
        rules: {
          'max-width': 'var(--wp--style--global--content-size)',
          'margin-left': 'auto !important',
          'margin-right': 'auto !important',
        },
      },
      {
        selector: ' > .alignwide',
        rules: { 'max-width': 'var(--wp--style--global--wide-size)' },
      },
    ],
    spacingStyles: FLOW_SPACING,
  },
  flex: {
    name: 'flex',
    slug: 'flex',
    className: 'is-layout-flex',
    displayMode: 'flex',
    baseStyles: [
      { selector: '', rules: { 'flex-wrap': 'wrap', 'align-items': 'center' } },
      { selector: ' > :is(*, div)', rules: { margin: '0' } },
    ],
    spacingStyles: [{ selector: '', rules: { gap: null } }],
  },
  grid: {
    name: 'grid',
    slug: 'grid',
    className: 'is-layout-grid',
    displayMode: 'grid',
    baseStyles: [{ selector: ' > :is(*, div)', rules: { margin: '0' } }],
    spacingStyles: [{ selector: '', rules: { gap: null } }],
  },
};
