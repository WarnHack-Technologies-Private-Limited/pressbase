import { isSafeCssDeclaration } from './sanitize';
import { arrayGet, isObject, toKebabCase } from './util';

/**
 * The style engine's declarations (wordpress/wp-includes/style-engine/):
 * WP_Style_Engine::parse_block_styles() for a block `style` object, without
 * class names, and a small CSS rules store that prints rules the way
 * WP_Style_Engine_Processor::get_css() does (not prettified), `!important`
 * and rules groups (`@media …`) included.
 */

interface StyleDefinition {
  path: [string, string] | [string];
  /** property_keys: `default`, and `individual` (`padding-%s`) for per-side values. */
  property: string;
  individual?: string;
  /** css_vars: preset type → custom property pattern. */
  cssVars?: Record<string, string>;
  valueFunc?: 'url' | 'individualSides';
}

const SIDE_COLOR_VARS = { color: '--wp--preset--color--$slug' };

/** WP_Style_Engine::BLOCK_STYLE_DEFINITIONS_METADATA, in its order. */
const DEFINITIONS: Record<string, StyleDefinition[]> = {
  background: [
    { path: ['background', 'backgroundImage'], property: 'background-image', valueFunc: 'url' },
    { path: ['background', 'backgroundPosition'], property: 'background-position' },
    { path: ['background', 'backgroundRepeat'], property: 'background-repeat' },
    { path: ['background', 'backgroundSize'], property: 'background-size' },
    { path: ['background', 'backgroundAttachment'], property: 'background-attachment' },
    {
      path: ['background', 'gradient'],
      property: 'background-image',
      cssVars: { gradient: '--wp--preset--gradient--$slug' },
    },
  ],
  color: [
    {
      path: ['color', 'text'],
      property: 'color',
      cssVars: { color: '--wp--preset--color--$slug' },
    },
    {
      path: ['color', 'background'],
      property: 'background-color',
      cssVars: { color: '--wp--preset--color--$slug' },
    },
    {
      path: ['color', 'gradient'],
      property: 'background',
      cssVars: { gradient: '--wp--preset--gradient--$slug' },
    },
  ],
  border: [
    { path: ['border', 'color'], property: 'border-color', individual: 'border-%s-color' },
    {
      path: ['border', 'radius'],
      property: 'border-radius',
      individual: 'border-%s-radius',
      cssVars: { 'border-radius': '--wp--preset--border-radius--$slug' },
    },
    { path: ['border', 'style'], property: 'border-style', individual: 'border-%s-style' },
    { path: ['border', 'width'], property: 'border-width', individual: 'border-%s-width' },
    ...(['top', 'right', 'bottom', 'left'] as const).map(
      (side): StyleDefinition => ({
        path: ['border', side],
        property: '',
        cssVars: SIDE_COLOR_VARS,
        valueFunc: 'individualSides',
      }),
    ),
  ],
  shadow: [
    {
      path: ['shadow'],
      property: 'box-shadow',
      cssVars: { shadow: '--wp--preset--shadow--$slug' },
    },
  ],
  dimensions: [
    { path: ['dimensions', 'aspectRatio'], property: 'aspect-ratio' },
    ...(
      [
        ['height', 'height'],
        ['minHeight', 'min-height'],
        ['minWidth', 'min-width'],
      ] as const
    ).map(
      ([key, property]): StyleDefinition => ({
        path: ['dimensions', key],
        property,
        cssVars: { dimension: '--wp--preset--dimension--$slug' },
      }),
    ),
    { path: ['dimensions', 'objectFit'], property: 'object-fit' },
    {
      path: ['dimensions', 'width'],
      property: 'width',
      cssVars: { dimension: '--wp--preset--dimension--$slug' },
    },
  ],
  spacing: (['padding', 'margin'] as const).map(
    (key): StyleDefinition => ({
      path: ['spacing', key],
      property: key,
      individual: `${key}-%s`,
      cssVars: { spacing: '--wp--preset--spacing--$slug' },
    }),
  ),
  typography: [
    {
      path: ['typography', 'fontSize'],
      property: 'font-size',
      cssVars: { 'font-size': '--wp--preset--font-size--$slug' },
    },
    {
      path: ['typography', 'fontFamily'],
      property: 'font-family',
      cssVars: { 'font-family': '--wp--preset--font-family--$slug' },
    },
    ...(
      [
        ['fontStyle', 'font-style'],
        ['fontWeight', 'font-weight'],
        ['lineHeight', 'line-height'],
        ['textColumns', 'column-count'],
        ['textDecoration', 'text-decoration'],
        ['textIndent', 'text-indent'],
        ['textTransform', 'text-transform'],
        ['letterSpacing', 'letter-spacing'],
        ['writingMode', 'writing-mode'],
      ] as const
    ).map(([key, property]): StyleDefinition => ({ path: ['typography', key], property })),
  ],
};

/** PHP's empty(). */
const phpEmpty = (value: unknown): boolean =>
  value === undefined ||
  value === null ||
  value === false ||
  value === '' ||
  value === '0' ||
  value === 0 ||
  (Array.isArray(value) && value.length === 0) ||
  (isObject(value) && Object.keys(value).length === 0);

/** is_valid_style_value(): `'0'` or anything not empty(). */
const isValidStyleValue = (value: unknown): boolean => value === '0' || !phpEmpty(value);

/** get_slug_from_preset_value() */
function slugFromPresetValue(value: unknown, propertyKey: string): string {
  if (typeof value === 'string' && value.includes(`var:preset|${propertyKey}|`)) {
    return toKebabCase(value.slice(value.lastIndexOf('|') + 1));
  }
  return '';
}

/** get_css_var_value() */
function cssVarValue(value: string, cssVars: Record<string, string>): string {
  for (const [propertyKey, pattern] of Object.entries(cssVars)) {
    const slug = slugFromPresetValue(value, propertyKey);
    if (isValidStyleValue(slug)) return `var(${pattern.replace('$slug', slug)})`;
  }
  return '';
}

const sprintfSide = (pattern: string, side: string) => pattern.replace('%s', side);

/** get_css_declarations() and its value functions. */
function cssDeclarations(value: unknown, definition: StyleDefinition): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (definition.valueFunc === 'url') {
    // get_url_or_value_css_declaration()
    if (phpEmpty(value)) return out;
    if (isObject(value) && !phpEmpty(value.url))
      out[definition.property] = `url('${String(value.url)}')`;
    else if (typeof value === 'string') out[definition.property] = value;
    return out;
  }
  if (definition.valueFunc === 'individualSides') {
    // get_individual_property_css_declarations()
    if (!isObject(value) || phpEmpty(value)) return out;
    const side = definition.path[1] as string;
    for (const [cssProperty, sideValue] of Object.entries(value)) {
      if (phpEmpty(sideValue)) continue;
      const sideDefinition = DEFINITIONS.border?.find((d) => d.path[1] === cssProperty);
      if (!sideDefinition?.individual) continue;
      let resolved = sideValue;
      if (typeof resolved === 'string' && resolved.includes('var:') && definition.cssVars) {
        resolved = cssVarValue(resolved, definition.cssVars);
      }
      out[sprintfSide(sideDefinition.individual, side)] = resolved;
    }
    return out;
  }
  if (typeof value === 'string' && value.includes('var:')) {
    if (definition.cssVars) {
      const cssVar = cssVarValue(value, definition.cssVars);
      if (isValidStyleValue(cssVar)) out[definition.property] = cssVar;
    }
    return out;
  }
  if (Array.isArray(value) || isObject(value)) {
    if (!definition.individual) return out;
    for (const [key, raw] of Object.entries(value)) {
      let sideValue: unknown = raw;
      if (typeof sideValue === 'string' && sideValue.includes('var:') && definition.cssVars) {
        sideValue = cssVarValue(sideValue, definition.cssVars);
      }
      const property = sprintfSide(definition.individual, toKebabCase(key));
      if (isValidStyleValue(sideValue)) out[property] = sideValue;
    }
    return out;
  }
  out[definition.property] = value;
  return out;
}

/**
 * wp_style_engine_get_styles( $style )['declarations']: CSS declarations for
 * a block `style` object, in the style engine's order. Values are kept as
 * given (a number stays a number), as WordPress hashes them; printing skips
 * anything that isn't a string.
 */
export function styleEngineDeclarations(style: unknown): Record<string, unknown> {
  const declarations: Record<string, unknown> = {};
  if (!isObject(style)) return declarations;
  for (const [group, definitions] of Object.entries(DEFINITIONS)) {
    if (phpEmpty(style[group])) continue;
    for (const definition of definitions) {
      const value = arrayGet(style, definition.path, null);
      if (!isValidStyleValue(value)) continue;
      const css = cssDeclarations(value, definition);
      if (!Object.keys(css).length) continue;
      // Combine background gradient and background image, as the JS style engine does.
      if (css['background-image'] !== undefined && declarations['background-image'] !== undefined) {
        css['background-image'] =
          `${String(css['background-image'])}, ${String(declarations['background-image'])}`;
      }
      Object.assign(declarations, css);
    }
  }
  return declarations;
}

export interface StyleEngineRule {
  selector: string;
  /** Property → value. Non-string values are skipped when printing, as add_declaration() does. */
  declarations: Record<string, unknown>;
  /** Properties printed with `!important`. */
  important?: boolean;
  /** A grouping rule such as `@media (width <= 480px)`. */
  rulesGroup?: string;
}

/**
 * WP_Style_Engine_CSS_Rules_Store + WP_Style_Engine_Processor::get_css():
 * rules with the same selector (and rules group) merge, a later declaration
 * replacing an earlier one in place; each value must pass
 * safecss_filter_attr() (isSafeCssDeclaration()), and `!important` is
 * appended for important declarations.
 */
export function styleEngineStylesheet(rules: StyleEngineRule[]): string {
  const store = new Map<
    string,
    {
      selector: string;
      group: string;
      declarations: Map<string, { value: string; important: boolean }>;
    }
  >();
  for (const rule of rules) {
    const selector = rule.selector.trim();
    const group = rule.rulesGroup?.trim() ?? '';
    if (!selector) continue;
    const key = group ? `${group} ${selector}` : selector;
    let entry = store.get(key);
    if (!entry) {
      entry = { selector, group, declarations: new Map() };
      store.set(key, entry);
    }
    for (const [rawProperty, value] of Object.entries(rule.declarations)) {
      // add_declaration(): sanitize_key() on the property, strings only, trimmed.
      const property = rawProperty.toLowerCase().replace(/[^a-z0-9_-]/g, '');
      if (!property || typeof value !== 'string' || value.trim() === '') continue;
      entry.declarations.set(property, { value: value.trim(), important: rule.important === true });
    }
  }
  let css = '';
  for (const { selector, group, declarations } of store.values()) {
    let body = '';
    for (const [property, { value, important }] of declarations) {
      // filter_declaration(): wp_strip_all_tags(), then safecss_filter_attr().
      const stripped = value
        .replace(/<[^>]*>/g, '')
        .replace(/[\r\n\t ]+/g, ' ')
        .trim();
      if (!stripped || !isSafeCssDeclaration(property, stripped)) continue;
      body += `${property}:${stripped}${important ? ' !important' : ''};`;
    }
    if (!body) continue;
    css += group ? `${group}{${selector}{${body}}}` : `${selector}{${body}}`;
  }
  return css;
}
