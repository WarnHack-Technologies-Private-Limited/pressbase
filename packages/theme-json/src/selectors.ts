/**
 * Selector helpers of WP_Theme_JSON (wordpress/wp-includes/class-wp-theme-json.php):
 * split_selector_list(), append_to_selector(), prepend_to_selector(),
 * scope_selector() and the block style variation selectors.
 */

const trimCss = (value: string) => value.replace(/^[ \t\n]+|[ \t\n]+$/g, '');

/** split_selector_list(): splits on top-level commas, respecting (), strings and comments. */
export function splitSelectorList(selector: string): string[] {
  if (!selector.includes(',')) return [trimCss(selector)];
  const selectors: string[] = [];
  let depth = 0;
  let start = 0;
  let at = 0;
  while (at < selector.length) {
    const ch = selector[at] as string;
    if (ch === '\\') {
      at += 2;
      continue;
    }
    if (ch === '(' || ch === ')') {
      depth += ch === '(' ? 1 : -1;
      at++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let end = at + 1;
      while (end < selector.length && selector[end] !== ch) end += selector[end] === '\\' ? 2 : 1;
      at = end + 1;
      continue;
    }
    if (ch === '/' && selector[at + 1] === '*') {
      const close = selector.indexOf('*/', at + 2);
      at = close === -1 ? selector.length : close + 2;
      continue;
    }
    if (ch === ',' && depth === 0) {
      selectors.push(trimCss(selector.slice(start, at)));
      start = at + 1;
    }
    at++;
  }
  if (start < selector.length) selectors.push(trimCss(selector.slice(start)));
  return selectors;
}

const SIMPLE = /^[^/'"(<\\]*$/;

/** append_to_selector(): `.a, .b` + `:hover` → `.a:hover, .b:hover`. */
export function appendToSelector(selector: string, toAppend: string): string {
  if (!selector.includes(',')) return trimCss(selector) + toAppend;
  if (SIMPLE.test(selector)) {
    return trimCss(selector).replace(/[ \t\n]*,[ \t\n]*/g, `${toAppend}, `) + toAppend;
  }
  return splitSelectorList(selector)
    .map((s) => s + toAppend)
    .join(', ');
}

/** prepend_to_selector(): `.a, .b` with `.x ` → `.x .a, .x .b`. */
export function prependToSelector(selector: string, toPrepend: string): string {
  if (!selector.includes(',')) return toPrepend + trimCss(selector);
  if (SIMPLE.test(selector)) {
    return toPrepend + trimCss(selector).replace(/[ \t\n]*,[ \t\n]*/g, `, ${toPrepend}`);
  }
  return splitSelectorList(selector)
    .map((s) => toPrepend + s)
    .join(', ');
}

/** scope_selector(): every combination of scope and selector, joined by a space. */
export function scopeSelector(scope: string | undefined, selector: string): string {
  if (!scope || !selector) return selector;
  const out: string[] = [];
  for (const outer of splitSelectorList(scope)) {
    for (const inner of splitSelectorList(selector)) {
      if (outer && inner) out.push(`${outer} ${inner}`);
      else if (!outer) out.push(inner);
      else out.push(outer);
    }
  }
  return out.join(', ');
}

/**
 * get_block_style_variation_selector(): adds `.is-style-{name}` to the first
 * compound selector of each part, e.g. `.wp-block-button .wp-block-button__link`
 * → `.wp-block-button.is-style-outline .wp-block-button__link`.
 */
export function blockStyleVariationSelector(variation: string, blockSelector: string): string {
  const variationClass = `.is-style-${variation}`;
  if (!blockSelector) return variationClass;
  return splitSelectorList(blockSelector)
    .map((part) => part.replace(/[^\s:]+/, (match) => match + variationClass))
    .join(', ');
}

/** get_block_style_variation_feature_selector() */
export function blockStyleVariationFeatureSelector(
  variation: { name: string; selector: string },
  featureSelector: string,
): string {
  const prefix = `.is-style-${variation.name} `;
  const parts = splitSelectorList(featureSelector).map((s) =>
    s.startsWith(prefix) ? s.slice(prefix.length) : s,
  );
  return blockStyleVariationSelector(variation.name, parts.join(', '));
}
