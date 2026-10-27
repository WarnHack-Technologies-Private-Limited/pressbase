import {
  type BlockAttributes,
  escAttr,
  escUrl,
  getBlockWrapperAttributes,
  stripAllTags,
  toKebabCase,
} from '@pressbase/blocks';
import { sanitizePostTitle } from '../../content/sanitize';
import { type CoreBlock, siteInfo } from '../helpers';

/**
 * core/search — render_block_core_search() and its helpers
 * (wordpress/wp-includes/blocks/search.php). The form markup and class names
 * match WordPress. Of the inline styles, width, border radius and custom
 * text and background colours are supported; per-side borders are not yet.
 */

const SEARCH_ICON = `<svg class="search-icon" viewBox="0 0 24 24" width="24" height="24">
					<path d="M13 5c-3.3 0-6 2.7-6 6 0 1.4.5 2.7 1.3 3.7l-3.8 3.8 1.1 1.1 3.8-3.8c1 .8 2.3 1.3 3.7 1.3 3.3 0 6-2.7 6-6S16.3 5 13 5zm0 10.5c-2.5 0-4.5-2-4.5-4.5s2-4.5 4.5-4.5 4.5 2 4.5 4.5-2 4.5-4.5 4.5z"></path>
				</svg>`;

/** A CSS value that can't break out of its declaration. */
const safeCss = (value: unknown): string | undefined =>
  typeof value === 'string' && value && !/[;{}<>"\\]|url\s*\(|expression\s*\(/i.test(value)
    ? value
    : typeof value === 'number'
      ? String(value)
      : undefined;

/** classnames_for_block_core_search() */
function classNames(attributes: BlockAttributes): string {
  const out: string[] = [];
  const position = attributes.buttonPosition;
  if (position === 'button-inside') out.push('wp-block-search__button-inside');
  if (position === 'button-outside') out.push('wp-block-search__button-outside');
  if (position === 'no-button') out.push('wp-block-search__no-button');
  if (position === 'button-only') {
    out.push('wp-block-search__button-only wp-block-search__searchfield-hidden');
  }
  if (attributes.buttonUseIcon !== undefined && position && position !== 'no-button') {
    out.push(
      attributes.buttonUseIcon ? 'wp-block-search__icon-button' : 'wp-block-search__text-button',
    );
  }
  return out.join(' ');
}

/** get_color_classes_for_block_core_search() */
function colorClasses(attributes: BlockAttributes): string {
  const out: string[] = [];
  const style = (attributes.style ?? {}) as { color?: Record<string, unknown> };
  if (attributes.textColor || style.color?.text) out.push('has-text-color');
  if (typeof attributes.textColor === 'string')
    out.push(`has-${toKebabCase(attributes.textColor)}-color`);
  if (
    attributes.backgroundColor ||
    style.color?.background ||
    attributes.gradient ||
    style.color?.gradient
  ) {
    out.push('has-background');
  }
  if (typeof attributes.backgroundColor === 'string') {
    out.push(`has-${toKebabCase(attributes.backgroundColor)}-background-color`);
  }
  if (typeof attributes.gradient === 'string') {
    out.push(`has-${toKebabCase(attributes.gradient)}-gradient-background`);
  }
  return out.join(' ');
}

/** get_typography_classes_for_block_core_search() */
function typographyClasses(attributes: BlockAttributes): string {
  const out: string[] = [];
  if (typeof attributes.fontSize === 'string' && attributes.fontSize) {
    out.push(`has-${escAttr(attributes.fontSize)}-font-size`);
  }
  if (typeof attributes.fontFamily === 'string' && attributes.fontFamily) {
    out.push(`has-${escAttr(attributes.fontFamily)}-font-family`);
  }
  return out.join(' ');
}

/** styles_for_block_core_search(), for width, radius and custom colours. */
function inlineStyles(attributes: BlockAttributes) {
  const wrapper: string[] = [];
  const button: string[] = [];
  const input: string[] = [];
  const inside = attributes.buttonPosition === 'button-inside';
  const width = Number(attributes.width);
  const unit = safeCss(attributes.widthUnit);
  if (width && unit) wrapper.push(`width: ${Math.trunc(width)}${unit};`);

  const style = (attributes.style ?? {}) as {
    border?: { radius?: unknown };
    color?: Record<string, unknown>;
  };
  let radius = style.border?.radius;
  if (typeof radius === 'number') radius = `${radius}px`;
  const radiusValue = safeCss(radius);
  if (radiusValue) {
    input.push(`border-radius: ${radiusValue};`);
    button.push(`border-radius: ${radiusValue};`);
    if (inside && Number.parseInt(radiusValue, 10) !== 0) {
      wrapper.push(`border-radius: calc(${radiusValue} + 4px);`);
    }
  }
  const colorTarget = attributes.buttonPosition === 'no-button' ? input : button;
  const text = safeCss(style.color?.text);
  if (text) colorTarget.push(`color: ${text};`);
  const background = safeCss(style.color?.background);
  if (background) colorTarget.push(`background-color: ${background};`);

  const attr = (list: string[]) => (list.length ? ` style="${escAttr(list.join(' '))}"` : '');
  return { wrapper: attr(wrapper), button: attr(button), input: attr(input) };
}

export async function renderSearch(
  attrs: BlockAttributes,
  _content: string,
  block: CoreBlock,
): Promise<string> {
  // Old content saved without these; WordPress defaults both to "Search".
  const attributes: BlockAttributes = { label: 'Search', buttonText: 'Search', ...attrs };
  const site = await siteInfo(block.services.kernel);
  const inputId = block.uniqueId('wp-block-search__input-');
  const showLabel = Boolean(attributes.showLabel);
  const useIcon = Boolean(attributes.buttonUseIcon);
  const position = typeof attributes.buttonPosition === 'string' ? attributes.buttonPosition : '';
  const showButton = position !== 'no-button';
  const buttonOnly = position === 'button-only';
  const styles = inlineStyles(attributes);
  const colors = colorClasses(attributes);
  const typography = typographyClasses(attributes);

  const labelText = attributes.label ? sanitizePostTitle(String(attributes.label)) : 'Search';
  const labelClasses = ['wp-block-search__label'];
  if (showLabel && attributes.label) {
    if (typography) labelClasses.push(typography);
  } else labelClasses.push('screen-reader-text');
  const label = `<label class="${escAttr(labelClasses.join(' '))}" for="${escAttr(inputId)}" >${labelText}</label>`;

  const inputClasses = ['wp-block-search__input'];
  if (typography) inputClasses.push(typography);
  if (!showButton && colors) inputClasses.push(colors);
  let inputAttributes = `class="${escAttr(inputClasses.join(' '))}" id="${escAttr(inputId)}" placeholder="${escAttr(attributes.placeholder ?? '')}" value=""`;
  if (buttonOnly) inputAttributes += ' aria-hidden="true" tabindex="-1"';
  const input = `<input ${inputAttributes} type="search" name="s" required${styles.input} />`;

  let hidden = '';
  if (attributes.query && typeof attributes.query === 'object') {
    for (const [param, value] of Object.entries(attributes.query as Record<string, unknown>)) {
      hidden += `<input type="hidden" name="${escAttr(param)}" value="${escAttr(value)}" />`;
    }
  }

  let button = '';
  if (showButton) {
    const classes = ['wp-block-search__button'];
    if (colors) classes.push(colors);
    if (typography) classes.push(typography);
    let inner = '';
    if (useIcon) {
      classes.push('has-icon');
      inner = SEARCH_ICON;
    } else if (attributes.buttonText) {
      inner = sanitizePostTitle(String(attributes.buttonText));
    }
    classes.push('wp-element-button');
    const extra = buttonOnly
      ? `aria-label="Expand search field" aria-controls="wp-block-search__input-${escAttr(inputId)}" aria-expanded="false" type="button"`
      : `aria-label="${escAttr(stripAllTags(String(attributes.buttonText ?? '')))}" type="submit"`;
    button = `<button ${extra} class="${escAttr(classes.join(' '))}"${styles.button}>${inner}</button>`;
  }

  const field = `<div class="wp-block-search__inside-wrapper"${styles.wrapper}>${input}${hidden}${button}</div>`;
  const wrapper = getBlockWrapperAttributes(block, { class: classNames(attributes) });
  if (attributes.tagName === 'search') {
    return `<search ${wrapper}><form method="get" action="${escUrl(`${site.home}/`)}">${label}${field}</form></search>`;
  }
  return `<form role="search" method="get" action="${escUrl(`${site.home}/`)}" ${wrapper}>${label}${field}</form>`;
}
