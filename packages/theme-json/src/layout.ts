import type { JsonObject } from './types';
import { isObject, isSafeCssValue, toKebabCase } from './util';

/**
 * wp_get_layout_style() (wordpress/wp-includes/block-supports/layout.php):
 * the per-container CSS the layout block support generates, e.g.
 * `.wp-container-core-group-is-layout-1a2b3c4d{flex-wrap:nowrap;…}`.
 * Viewport (responsive) overrides are not ported.
 */

export interface CssRule {
  selector: string;
  declarations: Record<string, string>;
  rulesGroup?: string;
}

/** wp_style_engine_get_stylesheet_from_css_rules( …, prettify: false ) */
export function stylesheetFromRules(rules: CssRule[]): string {
  // The style engine's store merges rules with the same selector.
  const merged = new Map<string, CssRule>();
  for (const rule of rules) {
    const key = `${rule.rulesGroup ?? ''}\u0000${rule.selector}`;
    const existing = merged.get(key);
    if (existing) Object.assign(existing.declarations, rule.declarations);
    else merged.set(key, { ...rule, declarations: { ...rule.declarations } });
  }
  let css = '';
  for (const rule of merged.values()) {
    const body = Object.entries(rule.declarations)
      .filter(([, value]) => value !== '' && isSafeCssValue(value))
      .map(([name, value]) => `${name}:${value};`)
      .join('');
    if (!body) continue;
    const block = `${rule.selector}{${body}}`;
    css += rule.rulesGroup ? `${rule.rulesGroup}{${block}}` : block;
  }
  return css;
}

const presetSpacing = (value: unknown): unknown => {
  if (typeof value === 'string' && value.includes('var:preset|spacing|')) {
    const slug = toKebabCase(value.slice(value.lastIndexOf('|') + 1));
    return `var(--wp--preset--spacing--${slug})`;
  }
  return value;
};

/** A spacing value from block attributes as CSS (style engine): presets become custom properties. */
export function spacingValue(value: unknown): string | undefined {
  if (typeof value !== 'string' || value === '') return undefined;
  const preset = /^var:preset\|([a-z0-9-]+)\|([a-zA-Z0-9-]+)$/.exec(value);
  if (preset) return `var(--wp--preset--${preset[1]}--${toKebabCase(preset[2] as string)})`;
  return value;
}

function sideValue(spacing: unknown, side: 'left' | 'right'): string | undefined {
  if (!isObject(spacing)) return undefined;
  const padding = spacing.padding;
  if (typeof padding === 'string') return spacingValue(padding);
  if (isObject(padding)) return spacingValue(padding[side]);
  return undefined;
}

export interface LayoutStyleInput {
  selector: string;
  layout: JsonObject;
  hasBlockGapSupport: boolean;
  gapValue: unknown;
  shouldSkipGapSerialization: boolean;
  fallbackGapValue: unknown;
  blockSpacing: unknown;
}

/** wp_get_layout_style() */
export function getLayoutStyle(input: LayoutStyleInput): string {
  const { selector, layout, hasBlockGapSupport, shouldSkipGapSerialization } = input;
  const fallbackGap = input.fallbackGapValue;
  let gapValue = input.gapValue;
  const type = typeof layout.type === 'string' ? layout.type : 'default';
  const rules: CssRule[] = [];

  const flowGap = () => {
    if (!hasBlockGapSupport) return;
    if (isObject(gapValue)) gapValue = gapValue.top ?? null;
    if (gapValue === null || gapValue === undefined || shouldSkipGapSerialization) return;
    const gap = String(presetSpacing(gapValue));
    rules.push(
      {
        selector: `${selector} > *`,
        declarations: { 'margin-block-start': '0', 'margin-block-end': '0' },
      },
      {
        selector: `${selector} > * + *`,
        declarations: { 'margin-block-start': gap, 'margin-block-end': '0' },
      },
    );
  };

  const combinedGap = (): string | undefined => {
    if (gapValue === undefined || gapValue === null) return undefined;
    const sides = isObject(gapValue) ? ['top', 'left'] : ['top'];
    let combined = '';
    for (const side of sides) {
      let value: unknown = gapValue;
      if (isObject(gapValue)) {
        const fallback = isObject(fallbackGap)
          ? (fallbackGap[side] ?? Object.values(fallbackGap)[0])
          : fallbackGap;
        value = gapValue[side] ?? fallback;
      }
      combined += `${String(presetSpacing(value))} `;
    }
    return combined.trim();
  };

  if (type === 'default') {
    flowGap();
  } else if (type === 'constrained') {
    const contentSize = typeof layout.contentSize === 'string' ? layout.contentSize : '';
    const wideSize = typeof layout.wideSize === 'string' ? layout.wideSize : '';
    const justify = typeof layout.justifyContent === 'string' ? layout.justifyContent : 'center';
    const all = (contentSize || wideSize || 'var(--wp--style--global--content-size, none)').split(
      ';',
    )[0] as string;
    const wide = (wideSize || contentSize || 'var(--wp--style--global--wide-size, none)').split(
      ';',
    )[0] as string;
    const marginLeft = justify === 'left' ? '0 !important' : 'auto !important';
    const marginRight = justify === 'right' ? '0 !important' : 'auto !important';
    if (contentSize || wideSize) {
      rules.push(
        {
          selector: `${selector} > :where(:not(.alignleft):not(.alignright):not(.alignfull))`,
          declarations: {
            'max-width': all,
            'margin-left': marginLeft,
            'margin-right': marginRight,
          },
        },
        { selector: `${selector} > .alignwide`, declarations: { 'max-width': wide } },
        { selector: `${selector} .alignfull`, declarations: { 'max-width': 'none' } },
      );
    }
    if (input.blockSpacing !== undefined && input.blockSpacing !== null) {
      for (const side of ['right', 'left'] as const) {
        let value = sideValue(input.blockSpacing, side);
        if (value === undefined) continue;
        if (value === '0') value = '0px';
        rules.push({
          selector: `${selector} > .alignfull`,
          declarations: { [`margin-${side}`]: `calc(${value} * -1)` },
        });
      }
    }
    if (justify === 'left') {
      rules.push({
        selector: `${selector} > :where(:not(.alignleft):not(.alignright):not(.alignfull))`,
        declarations: { 'margin-left': '0 !important' },
      });
    }
    if (justify === 'right') {
      rules.push({
        selector: `${selector} > :where(:not(.alignleft):not(.alignright):not(.alignfull))`,
        declarations: { 'margin-right': '0 !important' },
      });
    }
    flowGap();
  } else if (type === 'flex') {
    const orientation = layout.orientation === 'vertical' ? 'vertical' : 'horizontal';
    const justifyOptions: Record<string, string> = {
      left: 'flex-start',
      right: 'flex-end',
      center: 'center',
    };
    const alignOptions: Record<string, string> = {
      top: 'flex-start',
      center: 'center',
      bottom: 'flex-end',
    };
    if (orientation === 'horizontal') {
      justifyOptions['space-between'] = 'space-between';
      alignOptions.stretch = 'stretch';
    } else {
      justifyOptions.stretch = 'stretch';
      alignOptions['space-between'] = 'space-between';
    }
    if (layout.flexWrap === 'nowrap') {
      rules.push({ selector, declarations: { 'flex-wrap': 'nowrap' } });
    }
    if (hasBlockGapSupport) {
      const gap = combinedGap();
      if (gap !== undefined && !shouldSkipGapSerialization) {
        rules.push({ selector, declarations: { gap } });
      }
    }
    const justify = typeof layout.justifyContent === 'string' ? layout.justifyContent : '';
    const align = typeof layout.verticalAlignment === 'string' ? layout.verticalAlignment : '';
    if (orientation === 'horizontal') {
      if (justify && justifyOptions[justify]) {
        rules.push({ selector, declarations: { 'justify-content': justifyOptions[justify] } });
      }
      if (align && alignOptions[align]) {
        rules.push({ selector, declarations: { 'align-items': alignOptions[align] } });
      }
    } else {
      rules.push({ selector, declarations: { 'flex-direction': 'column' } });
      rules.push({
        selector,
        declarations: {
          'align-items':
            justify && justifyOptions[justify] ? justifyOptions[justify] : 'flex-start',
        },
      });
      if (align && alignOptions[align]) {
        rules.push({ selector, declarations: { 'justify-content': alignOptions[align] } });
      }
    }
  } else if (type === 'grid') {
    let responsiveGap: unknown = isObject(fallbackGap)
      ? (fallbackGap.left ?? Object.values(fallbackGap)[0])
      : fallbackGap;
    let gap: string | undefined;
    if (hasBlockGapSupport) {
      gap = combinedGap();
      if (gap !== undefined) responsiveGap = gap;
    }
    if (responsiveGap === '0' || responsiveGap === 0) responsiveGap = '0px';
    const columnCount = layout.columnCount;
    const minimumColumnWidth =
      typeof layout.minimumColumnWidth === 'string' ? layout.minimumColumnWidth : '';
    const placement = layout.autoFit ? 'auto-fit' : 'auto-fill';
    const declarations: Record<string, string> = {};
    if (columnCount && minimumColumnWidth) {
      const max = `max(min(${minimumColumnWidth}, 100%), (100% - (${String(responsiveGap)} * (${String(columnCount)} - 1))) /${String(columnCount)})`;
      declarations['grid-template-columns'] = `repeat(${placement}, minmax(${max}, 1fr))`;
    } else if (columnCount) {
      declarations['grid-template-columns'] = `repeat(${String(columnCount)}, minmax(0, 1fr))`;
    } else {
      declarations['grid-template-columns'] =
        `repeat(${placement}, minmax(min(${minimumColumnWidth || '12rem'}, 100%), 1fr))`;
    }
    if (!columnCount || minimumColumnWidth) declarations['container-type'] = 'inline-size';
    rules.push({ selector, declarations });
    if (columnCount && layout.rowCount) {
      rules.push({
        selector,
        declarations: {
          'grid-template-rows': `repeat(${String(layout.rowCount)}, minmax(1rem, auto))`,
        },
      });
    }
    if (hasBlockGapSupport && gap !== undefined && !shouldSkipGapSerialization) {
      rules.push({ selector, declarations: { gap } });
    }
  }
  return stylesheetFromRules(rules);
}

/**
 * wp_get_child_layout_style_rules() (viewport overrides not ported). In a
 * responsive grid (the parent has a `minimumColumnWidth`, or no
 * `columnCount`), a span or start is dropped by a container query once the
 * grid is too narrow for it, so spanning children never overflow.
 */
export function getChildLayoutStyle(
  selector: string,
  childLayout: JsonObject,
  parentLayout: JsonObject = {},
): string {
  const declarations: Record<string, string> = {};
  const stretch = childLayout.selfStretch;
  if (
    (stretch === 'fixed' || stretch === 'fixedNoShrink') &&
    typeof childLayout.flexSize === 'string'
  ) {
    declarations['flex-basis'] = childLayout.flexSize;
    if (stretch === 'fixedNoShrink') declarations['flex-shrink'] = '0';
    declarations['box-sizing'] = 'border-box';
  } else if (stretch === 'fill') {
    declarations['flex-grow'] = '1';
  }
  const { columnStart, columnSpan, rowStart, rowSpan } = childLayout;
  if (columnStart && columnSpan)
    declarations['grid-column'] = `${columnStart} / span ${columnSpan}`;
  else if (columnStart) declarations['grid-column'] = `${columnStart}`;
  else if (columnSpan) declarations['grid-column'] = `span ${columnSpan}`;
  if (rowStart && rowSpan) declarations['grid-row'] = `${rowStart} / span ${rowSpan}`;
  else if (rowStart) declarations['grid-row'] = `${rowStart}`;
  else if (rowSpan) declarations['grid-row'] = `span ${rowSpan}`;
  const rules: CssRule[] = [{ selector, declarations }];

  const minimumColumnWidth = parentLayout.minimumColumnWidth;
  const columnCount = parentLayout.columnCount;
  if ((columnSpan || columnStart) && (minimumColumnWidth || !columnCount)) {
    const spanNumber = Number.parseFloat(String(columnSpan ?? '')) || 0;
    const startNumber = Number.parseFloat(String(columnStart ?? '')) || 0;
    const parentWidth =
      typeof minimumColumnWidth === 'string' && minimumColumnWidth ? minimumColumnWidth : '12rem';
    let value = Number.parseFloat(parentWidth) || 0;
    // PHP: explode( floatval( $width ), $width ).
    const parts = parentWidth.split(String(value));
    let unit = 'rem';
    if (parts.length <= 1) value = 12;
    else if (['px', 'rem', 'em'].includes(parts[1] as string)) unit = parts[1] as string;
    const breakAt =
      spanNumber && startNumber
        ? startNumber + spanNumber - 1
        : spanNumber
          ? spanNumber
          : startNumber;
    const gap = unit === 'px' ? 24 : 1.5;
    const query = Math.max(breakAt * value + (breakAt - 1) * gap, value * 2 + gap - 1);
    rules.push({
      rulesGroup: `@container (max-width: ${query}${unit} )`,
      selector,
      declarations: {
        'grid-column': columnSpan && Number(columnSpan) > 1 ? '1/-1' : 'auto',
        'grid-row': 'auto',
      },
    });
  }
  return stylesheetFromRules(rules);
}
