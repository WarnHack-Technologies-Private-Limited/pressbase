import type { WPBlock } from './block';
import { escAttr } from './escape';
import { blockHasSupport } from './registry';

/**
 * Block supports on the server — get_block_wrapper_attributes()
 * (wordpress/wp-includes/class-wp-block-supports.php) and the class and style
 * output of the supports in wordpress/wp-includes/block-supports/.
 *
 * Covered: the generated `wp-block-{name}` class, align, className, anchor,
 * preset and custom colours (text, background, gradient, link), preset and
 * custom font sizes, font family and text alignment. Spacing, border, layout
 * and duotone styles need the theme.json engine (v0.4).
 */

/** wp_get_block_default_classname(): `core/latest-posts` → `wp-block-latest-posts`. */
export function getBlockDefaultClassname(blockName: string): string {
  return `wp-block-${blockName.replace('/', '-').replace(/^core-/, '')}`;
}

/** _wp_to_kebab_case() for preset slugs: `vividRed` → `vivid-red`. */
export function toKebabCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([a-zA-Z])([0-9])/g, '$1-$2')
    .replace(/[\s_]+/g, '-')
    .toLowerCase();
}

/** `var:preset|color|vivid-red` → `var(--wp--preset--color--vivid-red)` (style engine). */
function cssValue(value: unknown): string | undefined {
  if (typeof value !== 'string' || value === '') return undefined;
  const preset = /^var:preset\|([a-z-]+)\|([a-z0-9-]+)$/i.exec(value);
  if (preset) return `var(--wp--preset--${preset[1]}--${preset[2]})`;
  // safecss_filter_attr(): refuse anything that could break out of the declaration.
  if (/[;{}<>"\\]|url\s*\(|expression\s*\(/i.test(value)) return undefined;
  return value;
}

function get(object: unknown, ...path: string[]): unknown {
  let value = object;
  for (const key of path) {
    if (!value || typeof value !== 'object') return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

interface Generated {
  classes: string[];
  styles: string[];
  id?: string;
}

/** WP_Block_Supports::apply_block_supports(), for the supports listed above. */
function applyBlockSupports(block: WPBlock<unknown>): Generated {
  const out: Generated = { classes: [], styles: [] };
  const type = block.blockType;
  if (!type || !block.name) return out;
  const attrs = block.attributes;
  const supports = type.supports;
  const skip = (feature: string) =>
    get(supports, feature, '__experimentalSkipSerialization') === true;

  // align.php
  if (blockHasSupport(supports, 'align') && typeof attrs.align === 'string' && attrs.align) {
    out.classes.push(`align${attrs.align}`);
  }

  // colors.php
  if (blockHasSupport(supports, 'color') && !skip('color')) {
    const style = attrs.style;
    const textPreset = typeof attrs.textColor === 'string' ? attrs.textColor : undefined;
    const textCustom = cssValue(get(style, 'color', 'text'));
    if (textPreset || textCustom) out.classes.push('has-text-color');
    if (textPreset) out.classes.push(`has-${toKebabCase(textPreset)}-color`);
    else if (textCustom) out.styles.push(`color:${textCustom}`);

    const gradientPreset = typeof attrs.gradient === 'string' ? attrs.gradient : undefined;
    const gradientCustom = cssValue(get(style, 'color', 'gradient'));
    const backgroundPreset =
      typeof attrs.backgroundColor === 'string' ? attrs.backgroundColor : undefined;
    const backgroundCustom = cssValue(get(style, 'color', 'background'));
    if (backgroundPreset || backgroundCustom || gradientPreset || gradientCustom) {
      out.classes.push('has-background');
    }
    if (backgroundPreset) out.classes.push(`has-${toKebabCase(backgroundPreset)}-background-color`);
    else if (backgroundCustom) out.styles.push(`background-color:${backgroundCustom}`);
    if (gradientPreset) out.classes.push(`has-${toKebabCase(gradientPreset)}-gradient-background`);
    else if (gradientCustom) out.styles.push(`background:${gradientCustom}`);
    if (get(style, 'elements', 'link', 'color', 'text') !== undefined) {
      out.classes.push('has-link-color');
    }
  }

  // custom-classname.php
  if (
    blockHasSupport(supports, 'customClassName', true) &&
    typeof attrs.className === 'string' &&
    attrs.className.trim()
  ) {
    out.classes.push(...attrs.className.trim().split(/\s+/));
  }

  // generated-classname.php
  if (blockHasSupport(supports, 'className', true)) {
    out.classes.push(getBlockDefaultClassname(block.name));
  }

  // typography.php
  if (blockHasSupport(supports, 'typography') && !skip('typography')) {
    const style = attrs.style;
    if (typeof attrs.fontSize === 'string' && attrs.fontSize) {
      out.classes.push(`has-${toKebabCase(attrs.fontSize)}-font-size`);
    } else {
      const size = cssValue(get(style, 'typography', 'fontSize'));
      if (size) out.styles.push(`font-size:${size}`);
    }
    if (typeof attrs.fontFamily === 'string' && attrs.fontFamily) {
      out.classes.push(`has-${toKebabCase(attrs.fontFamily)}-font-family`);
    }
    const textAlign = get(style, 'typography', 'textAlign');
    if (blockHasSupport(supports, ['typography', 'textAlign']) && typeof textAlign === 'string') {
      out.classes.push(`has-text-align-${textAlign}`);
    }
  }

  // anchor.php
  if (blockHasSupport(supports, 'anchor') && typeof attrs.anchor === 'string' && attrs.anchor) {
    out.id = attrs.anchor;
  }
  return out;
}

export interface WrapperAttributes {
  class?: string;
  style?: string;
  id?: string;
  'aria-label'?: string;
  [attribute: string]: string | number | undefined;
}

/**
 * get_block_wrapper_attributes(): the attributes for a dynamic block's outer
 * element, e.g. `class="wp-block-latest-posts__list has-dates wp-block-latest-posts"`.
 * Extra classes come first, as in WordPress. Values are escaped.
 */
export function getBlockWrapperAttributes<S>(
  block: WPBlock<S>,
  extra: WrapperAttributes = {},
): string {
  const generated = applyBlockSupports(block as WPBlock<unknown>);
  const attributes: [string, string][] = [];

  const extraClasses = String(extra.class ?? '')
    .split(/\s+/)
    .filter(Boolean);
  const classes = [...new Set([...extraClasses, ...generated.classes])];
  if (classes.length) attributes.push(['class', classes.join(' ')]);

  const styles = [
    generated.styles.join(';'),
    String(extra.style ?? '')
      .trim()
      .replace(/;$/, ''),
  ].filter(Boolean);
  if (styles.length) attributes.push(['style', `${styles.join(';')};`]);

  const id = extra.id !== undefined && extra.id !== '' ? String(extra.id) : generated.id;
  if (id) attributes.push(['id', id]);
  if (extra['aria-label']) attributes.push(['aria-label', String(extra['aria-label'])]);

  for (const [name, value] of Object.entries(extra)) {
    if (['class', 'style', 'id', 'aria-label'].includes(name) || value === undefined) continue;
    attributes.push([name, String(value)]);
  }
  return attributes.map(([name, value]) => `${name}="${escAttr(value)}"`).join(' ');
}
