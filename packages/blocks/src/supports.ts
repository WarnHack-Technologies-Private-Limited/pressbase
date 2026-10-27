import type { WPBlock } from './block';
import { escAttr } from './escape';
import { blockHasSupport } from './registry';

/**
 * Block supports on the server — get_block_wrapper_attributes()
 * (wordpress/wp-includes/class-wp-block-supports.php) and the class and style
 * output of the supports in wordpress/wp-includes/block-supports/.
 *
 * Covered: align, colours (text, background, gradient, link), className,
 * the generated `wp-block-{name}` class, typography (preset and custom sizes,
 * family, style, weight, line height, columns, decoration, transform,
 * letter spacing, writing mode, text alignment), border (radius, colour,
 * style, width, per side), spacing (padding, margin), dimensions, shadow,
 * aria-label and anchor, honouring `__experimentalSkipSerialization`.
 * Layout, elements, position and fluid font sizes need the active theme's
 * settings, so core applies them in render_block filters (apps/core/src/themes/supports.ts).
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
export function cssValue(value: unknown): string | undefined {
  if (typeof value === 'number') return String(value);
  if (typeof value !== 'string' || value === '') return undefined;
  const preset = /^var:preset\|([a-z-]+)\|([a-zA-Z0-9-]+)$/i.exec(value);
  if (preset) return `var(--wp--preset--${preset[1]}--${toKebabCase(preset[2] as string)})`;
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
  ariaLabel?: string;
}

/** wp_should_skip_block_supports_serialization() */
export function shouldSkipSerialization(
  supports: Record<string, unknown>,
  feature: string,
  subfeature?: string,
): boolean {
  const skip = get(supports, feature, '__experimentalSkipSerialization');
  if (Array.isArray(skip) && subfeature) return skip.includes(subfeature);
  return Boolean(skip) && !Array.isArray(skip);
}

const SIDES = ['top', 'right', 'bottom', 'left'] as const;

/** The style engine's box rules: `padding:1px` or `padding-top:…;padding-right:…`. */
function boxStyles(property: string, value: unknown): string[] {
  if (typeof value === 'string') {
    const css = cssValue(value);
    return css ? [`${property}:${css}`] : [];
  }
  const out: string[] = [];
  for (const side of SIDES) {
    const css = cssValue(get(value, side));
    if (css) out.push(`${property}-${side}:${css}`);
  }
  return out;
}

/** WP_Block_Supports::apply_block_supports(), in WordPress's support order. */
function applyBlockSupports(block: WPBlock<unknown>): Generated {
  const out: Generated = { classes: [], styles: [] };
  const type = block.blockType;
  if (!type || !block.name) return out;
  const attrs = block.attributes;
  const supports = type.supports;
  const style = attrs.style;
  const skip = (feature: string, subfeature?: string) =>
    shouldSkipSerialization(supports, feature, subfeature);

  // align.php
  if (blockHasSupport(supports, 'align') && typeof attrs.align === 'string' && attrs.align) {
    out.classes.push(`align${attrs.align}`);
  }

  // colors.php
  if (blockHasSupport(supports, 'color') && !skip('color')) {
    const textPreset = typeof attrs.textColor === 'string' ? attrs.textColor : undefined;
    const textCustom = cssValue(get(style, 'color', 'text'));
    if (!skip('color', 'text') && (textPreset || textCustom)) {
      out.classes.push('has-text-color');
      if (textPreset) out.classes.push(`has-${toKebabCase(textPreset)}-color`);
      else if (textCustom) out.styles.push(`color:${textCustom}`);
    }

    const gradientPreset = typeof attrs.gradient === 'string' ? attrs.gradient : undefined;
    const gradientCustom = cssValue(get(style, 'color', 'gradient'));
    const backgroundPreset =
      typeof attrs.backgroundColor === 'string' ? attrs.backgroundColor : undefined;
    const backgroundCustom = cssValue(get(style, 'color', 'background'));
    const skipBackground = skip('color', 'background');
    const skipGradient = skip('color', 'gradients');
    if (
      (!skipBackground && (backgroundPreset || backgroundCustom)) ||
      (!skipGradient && (gradientPreset || gradientCustom))
    ) {
      out.classes.push('has-background');
    }
    if (!skipBackground) {
      if (backgroundPreset) {
        out.classes.push(`has-${toKebabCase(backgroundPreset)}-background-color`);
      } else if (backgroundCustom) out.styles.push(`background-color:${backgroundCustom}`);
    }
    if (!skipGradient) {
      if (gradientPreset) {
        out.classes.push(`has-${toKebabCase(gradientPreset)}-gradient-background`);
      } else if (gradientCustom) out.styles.push(`background:${gradientCustom}`);
    }
    if (get(style, 'elements', 'link', 'color', 'text') !== undefined && !skip('color', 'link')) {
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
    if (!skip('typography', 'fontSize')) {
      if (typeof attrs.fontSize === 'string' && attrs.fontSize) {
        out.classes.push(`has-${toKebabCase(attrs.fontSize)}-font-size`);
      } else {
        const size = cssValue(get(style, 'typography', 'fontSize'));
        if (size) out.styles.push(`font-size:${size}`);
      }
    }
    if (!skip('typography', 'fontFamily')) {
      if (typeof attrs.fontFamily === 'string' && attrs.fontFamily) {
        out.classes.push(`has-${toKebabCase(attrs.fontFamily)}-font-family`);
      } else {
        const family = cssValue(get(style, 'typography', 'fontFamily'));
        if (family) out.styles.push(`font-family:${family}`);
      }
    }
    const typographyStyles: [string, string][] = [
      ['fontStyle', 'font-style'],
      ['fontWeight', 'font-weight'],
      ['lineHeight', 'line-height'],
      ['textColumns', 'column-count'],
      ['textDecoration', 'text-decoration'],
      ['textTransform', 'text-transform'],
      ['letterSpacing', 'letter-spacing'],
      ['writingMode', 'writing-mode'],
    ];
    for (const [key, property] of typographyStyles) {
      if (skip('typography', key)) continue;
      const value = cssValue(get(style, 'typography', key));
      if (value) out.styles.push(`${property}:${value}`);
    }
    const textAlign = get(style, 'typography', 'textAlign');
    if (blockHasSupport(supports, ['typography', 'textAlign']) && typeof textAlign === 'string') {
      out.classes.push(`has-text-align-${textAlign}`);
    }
  }

  // border.php
  if (blockHasSupport(supports, '__experimentalBorder') && !skip('__experimentalBorder')) {
    const border = get(style, 'border');
    const radius = get(border, 'radius');
    if (!skip('__experimentalBorder', 'radius')) {
      if (typeof radius === 'string' || typeof radius === 'number') {
        const css = cssValue(radius);
        if (css) out.styles.push(`border-radius:${css}`);
      } else if (radius && typeof radius === 'object') {
        for (const [corner, property] of [
          ['topLeft', 'border-top-left-radius'],
          ['topRight', 'border-top-right-radius'],
          ['bottomLeft', 'border-bottom-left-radius'],
          ['bottomRight', 'border-bottom-right-radius'],
        ] as const) {
          const css = cssValue(get(radius, corner));
          if (css) out.styles.push(`${property}:${css}`);
        }
      }
    }
    if (!skip('__experimentalBorder', 'color')) {
      const preset = typeof attrs.borderColor === 'string' ? attrs.borderColor : undefined;
      const custom = cssValue(get(border, 'color'));
      if (preset) out.classes.push('has-border-color', `has-${toKebabCase(preset)}-border-color`);
      else if (custom) out.styles.push(`border-color:${custom}`);
    }
    for (const key of ['style', 'width'] as const) {
      if (skip('__experimentalBorder', key)) continue;
      const css = cssValue(get(border, key));
      if (css) out.styles.push(`border-${key}:${css}`);
    }
    for (const side of SIDES) {
      for (const key of ['color', 'style', 'width'] as const) {
        const css = cssValue(get(border, side, key));
        if (css) out.styles.push(`border-${side}-${key}:${css}`);
      }
    }
  }

  // spacing.php
  if (blockHasSupport(supports, 'spacing') && !skip('spacing')) {
    if (blockHasSupport(supports, ['spacing', 'padding']) && !skip('spacing', 'padding')) {
      out.styles.push(...boxStyles('padding', get(style, 'spacing', 'padding')));
    }
    if (blockHasSupport(supports, ['spacing', 'margin']) && !skip('spacing', 'margin')) {
      out.styles.push(...boxStyles('margin', get(style, 'spacing', 'margin')));
    }
  }

  // dimensions.php
  if (blockHasSupport(supports, 'dimensions') && !skip('dimensions')) {
    for (const [key, property] of [
      ['minHeight', 'min-height'],
      ['height', 'height'],
      ['minWidth', 'min-width'],
      ['width', 'width'],
    ] as const) {
      if (!blockHasSupport(supports, ['dimensions', key]) || skip('dimensions', key)) continue;
      const css = cssValue(get(style, 'dimensions', key));
      if (css) out.styles.push(`${property}:${css}`);
    }
  }

  // shadow.php
  if (blockHasSupport(supports, 'shadow') && !skip('shadow')) {
    const css = cssValue(get(style, 'shadow'));
    if (css) out.styles.push(`box-shadow:${css}`);
  }

  // aria-label.php
  if (
    blockHasSupport(supports, 'ariaLabel') &&
    typeof attrs.ariaLabel === 'string' &&
    attrs.ariaLabel
  ) {
    out.ariaLabel = attrs.ariaLabel;
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
  const label = extra['aria-label'] ? String(extra['aria-label']) : generated.ariaLabel;
  if (label) attributes.push(['aria-label', label]);

  for (const [name, value] of Object.entries(extra)) {
    if (['class', 'style', 'id', 'aria-label'].includes(name) || value === undefined) continue;
    attributes.push([name, String(value)]);
  }
  return attributes.map(([name, value]) => `${name}="${escAttr(value)}"`).join(' ');
}
