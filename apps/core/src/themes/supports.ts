import { createHash } from 'node:crypto';
import {
  blockHasSupport,
  escAttr,
  type ParsedBlock,
  shouldSkipSerialization,
  type WPBlock,
} from '@pressbase/blocks';
import {
  blockStyleVariationInstanceStyles,
  getChildLayoutStyle,
  getLayoutStyle,
  type JsonObject,
  LAYOUT_DEFINITIONS,
  spacingValue,
  stylesheetFromRules,
  typographyFontSizeValue,
} from '@pressbase/theme-json';
import { isUnavailableDynamicBlock } from '../blocks/library';
import { currentPage } from '../frontend/page';
import type { Kernel } from '../kernel';
import type { ActiveTheme } from './service';

/**
 * The block supports that need the active theme's settings, as render
 * filters — ports of wordpress/wp-includes/block-supports/:
 *
 * - layout.php: `is-layout-*` classes, `wp-container-*` classes and their
 *   generated CSS, `has-global-padding`, child layout (`wp-container-content-*`);
 * - elements.php: `wp-elements-*` classes for link, heading and button colours;
 * - position.php: sticky and fixed positions;
 * - typography.php: fluid custom font sizes;
 * - block-style-variations.php: per-instance styles for variations that
 *   style inner elements or blocks (`is-style-section-1--3`).
 *
 * Generated CSS goes to the page being rendered (frontend/page.ts), which
 * prints it in the document head, like WordPress's `core-block-supports`
 * inline style. Outside a page render (REST previews) only the classes apply.
 */

type AnyBlock = WPBlock<unknown>;
type LayoutParsedBlock = ParsedBlock & { parentLayout?: JsonObject };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** wp_unique_id_from_values(): a stable hash of the values, as PHP's wp_json_encode() + md5. */
export function uniqueIdFromValues(data: unknown, prefix = ''): string {
  const json = JSON.stringify(data ?? []).replace(/\//g, '\\/');
  return `${prefix}${createHash('md5').update(json).digest('hex').slice(0, 8)}`;
}

/** sanitize_title() for class names. */
const sanitizeTitle = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');

const VOID_TAGS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'source',
  'track',
  'wbr',
]);

const TAG = /<([a-zA-Z][a-zA-Z0-9-]*)(\s[^>]*?)?(\/?)>/g;

function classOf(attributes: string): string | undefined {
  const match = /\sclass\s*=\s*("([^"]*)"|'([^']*)')/i.exec(attributes);
  return match ? (match[2] ?? match[3] ?? '') : undefined;
}

/**
 * WP_HTML_Tag_Processor::add_class() on the first tag (or, with `where`, the
 * first tag whose class attribute contains it). Returns the HTML unchanged
 * when there is no tag.
 */
export function addClasses(html: string, classes: string[], where?: string): string {
  if (!classes.length) return html;
  TAG.lastIndex = 0;
  let match: RegExpExecArray | null = TAG.exec(html);
  if (where) {
    while (match && !(classOf(match[2] ?? '') ?? '').includes(where)) match = TAG.exec(html);
    if (!match) {
      TAG.lastIndex = 0;
      match = TAG.exec(html);
    }
  }
  if (!match) return html;
  const [tag, name, attributes = '', selfClosing] = match;
  const existing = classOf(attributes);
  let updated: string;
  if (existing === undefined) {
    updated = `<${name} class="${escAttr(classes.join(' '))}"${attributes}${selfClosing}>`;
  } else {
    const current = existing.split(/\s+/).filter(Boolean);
    const merged = [...current, ...classes.filter((c) => !current.includes(c))].join(' ');
    updated = `<${name}${attributes.replace(/\sclass\s*=\s*("[^"]*"|'[^']*')/i, ` class="${escAttr(merged)}"`)}${selfClosing}>`;
  }
  return html.slice(0, match.index) + updated + html.slice(match.index + tag.length);
}

/** The class of the element inner blocks sit in, from the block's first HTML chunk. */
function innerWrapperClass(block: AnyBlock): string | undefined {
  const first = block.innerContent[0];
  if (typeof first !== 'string' || block.innerContent.length < 2) return undefined;
  const stack: (string | undefined)[] = [];
  for (const match of first.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9-]*)(\s[^>]*?)?(\/?)>/g)) {
    const [, closer, name = '', attributes = '', selfClosing] = match;
    if (closer) stack.pop();
    else if (!VOID_TAGS.has(name.toLowerCase()) && !selfClosing) stack.push(classOf(attributes));
  }
  return [...stack].reverse().find((c) => c);
}

const supportsLayout = (block: AnyBlock) =>
  blockHasSupport(block.blockType?.supports, 'layout') ||
  blockHasSupport(block.blockType?.supports, '__experimentalLayout');

/** wp_render_layout_support_flag() */
async function renderLayout(
  content: string,
  parsed: LayoutParsedBlock,
  block: AnyBlock,
  theme: ActiveTheme,
): Promise<string> {
  const type = block.blockType;
  if (!type || !block.name) return content;
  const layoutSupport = supportsLayout(block);
  const style = isObject(parsed.attrs.style) ? parsed.attrs.style : {};
  const childLayout = isObject(style.layout) ? style.layout : undefined;
  if (!layoutSupport && !childLayout) return content;
  const page = currentPage();
  const outer: string[] = [];

  if (childLayout) {
    const values: JsonObject = {};
    for (const key of [
      'selfStretch',
      'flexSize',
      'columnStart',
      'columnSpan',
      'rowStart',
      'rowSpan',
    ]) {
      if (childLayout[key] !== undefined) values[key] = childLayout[key] as JsonObject[string];
    }
    const parentLayout = parsed.parentLayout ?? {};
    const contentClass = uniqueIdFromValues(
      {
        layout: values,
        parentLayout: Object.fromEntries(
          Object.entries(parentLayout).filter(
            ([k]) => k === 'minimumColumnWidth' || k === 'columnCount',
          ),
        ),
      },
      'wp-container-content-',
    );
    const css = getChildLayoutStyle(`.${contentClass}`, values);
    if (css) {
      outer.push(contentClass);
      page?.addSupportStyle(css);
    }
  }
  if (!/<[a-zA-Z]/.test(content)) return content;
  if (!layoutSupport) return addClasses(content, outer);

  const supports = type.supports;
  const fallbackLayout = (
    isObject(supports.layout) && isObject(supports.layout.default)
      ? supports.layout.default
      : isObject(supports.__experimentalLayout) && isObject(supports.__experimentalLayout.default)
        ? supports.__experimentalLayout.default
        : {}
  ) as JsonObject;
  const used: JsonObject = {
    ...(isObject(parsed.attrs.layout) ? (parsed.attrs.layout as JsonObject) : fallbackLayout),
  };
  if (used.inherit || used.contentSize) used.type = 'constrained';
  const settings = theme.settings;
  const classes: string[] = [];
  if (settings.useRootPaddingAwareAlignments === true && used.type === 'constrained') {
    classes.push('has-global-padding');
  }
  const attrsLayout = isObject(parsed.attrs.layout) ? parsed.attrs.layout : {};
  if (typeof attrsLayout.orientation === 'string' && attrsLayout.orientation) {
    classes.push(`is-${sanitizeTitle(attrsLayout.orientation)}`);
  }
  if (typeof attrsLayout.justifyContent === 'string' && attrsLayout.justifyContent) {
    classes.push(`is-content-justification-${sanitizeTitle(attrsLayout.justifyContent)}`);
  }
  if (attrsLayout.flexWrap === 'nowrap') classes.push('is-nowrap');
  const definition =
    LAYOUT_DEFINITIONS[typeof used.type === 'string' ? used.type : 'default'] ??
    LAYOUT_DEFINITIONS.default;
  const layoutClass = definition?.className ?? '';
  if (layoutClass) classes.push(sanitizeTitle(layoutClass));

  // wp_sanitize_block_gap_value()
  const sanitizeGap = (value: unknown): unknown => {
    const bad = (v: unknown) => typeof v === 'string' && /[\\(&=}]|\/\*/.test(v);
    if (isObject(value)) {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, bad(v) ? null : v]));
    }
    return bad(value) ? null : value;
  };
  const spacing = isObject(style.spacing) ? style.spacing : undefined;
  const gapValue = sanitizeGap(spacing?.blockGap ?? null);
  let fallbackGap: unknown =
    isObject(supports.spacing) && isObject(supports.spacing.blockGap)
      ? (supports.spacing.blockGap.__experimentalDefault ?? '0.5em')
      : '0.5em';
  const skipGap = shouldSkipSerialization(supports, 'spacing', 'blockGap');
  const globalGap = isObject(settings.spacing) ? settings.spacing.blockGap : undefined;
  const hasBlockGapSupport = globalGap !== undefined && globalGap !== null;

  // The block gap from global styles: the variation's, the block's, then the root's.
  const styles = theme.themeJson.tree.getRawData().styles ?? {};
  const blockStyles = isObject(styles.blocks) ? styles.blocks[block.name] : undefined;
  let variationGap: unknown;
  const className = typeof parsed.attrs.className === 'string' ? parsed.attrs.className : '';
  for (const match of className.matchAll(/\bis-style-(?!default)(\S+)\b/g)) {
    const variations =
      isObject(blockStyles) && isObject(blockStyles.variations) ? blockStyles.variations : {};
    const variation = variations[match[1] as string];
    if (
      isObject(variation) &&
      isObject(variation.spacing) &&
      variation.spacing.blockGap !== undefined
    ) {
      variationGap = variation.spacing.blockGap;
      break;
    }
  }
  const globalBlockGap =
    variationGap ??
    (isObject(blockStyles) && isObject(blockStyles.spacing)
      ? blockStyles.spacing.blockGap
      : undefined) ??
    (isObject(styles.spacing) ? styles.spacing.blockGap : undefined);
  if (globalBlockGap !== undefined && globalBlockGap !== null) fallbackGap = globalBlockGap;

  const containerClass = uniqueIdFromValues(
    [used, hasBlockGapSupport, gapValue, skipGap, fallbackGap, spacing ?? null],
    `wp-container-${sanitizeTitle(block.name)}-is-layout-`,
  );
  const css = getLayoutStyle({
    selector: `.${containerClass}`,
    layout: used,
    hasBlockGapSupport,
    gapValue,
    shouldSkipGapSerialization: skipGap,
    fallbackGapValue: fallbackGap,
    blockSpacing: spacing ?? null,
  });
  if (css) {
    classes.push(containerClass);
    page?.addSupportStyle(css);
  }
  const [namespace = '', name = ''] = block.name.split('/');
  classes.push(`wp-block-${namespace === 'core' ? name : `${namespace}-${name}`}-${layoutClass}`);

  let html = addClasses(content, outer);
  const wrapper = innerWrapperClass(block);
  html = addClasses(html, classes, wrapper);
  return html;
}

/** wp_render_position_support() */
function renderPosition(
  content: string,
  parsed: ParsedBlock,
  block: AnyBlock,
  theme: ActiveTheme,
): string {
  if (!blockHasSupport(block.blockType?.supports, 'position')) return content;
  const style = isObject(parsed.attrs.style) ? parsed.attrs.style : {};
  const position = isObject(style.position) ? style.position : undefined;
  if (!position) return content;
  const settings = isObject(theme.settings.position) ? theme.settings.position : {};
  const allowed = [
    settings.sticky === true ? 'sticky' : '',
    settings.fixed === true ? 'fixed' : '',
  ];
  const type = typeof position.type === 'string' ? position.type : '';
  if (!type || !allowed.includes(type)) return content;
  const page = currentPage();
  const className = page ? page.uniqueId('wp-container-') : 'wp-container-position';
  const declarations: Record<string, string> = {};
  for (const side of ['top', 'right', 'bottom', 'left']) {
    let value = position[side];
    if (value === undefined || value === null) continue;
    if (side === 'top') {
      if (value === '0' || value === 0) value = '0px';
      value = `calc(${String(value)} + var(--wp-admin--admin-bar--position-offset, 0px))`;
    }
    declarations[side] = String(value);
  }
  page?.addSupportStyle(
    stylesheetFromRules([
      { selector: `.${className}`, declarations },
      { selector: `.${className}`, declarations: { position: type, 'z-index': '10' } },
    ]),
  );
  return addClasses(content, [className, `is-position-${type}`]);
}

/** wp_render_typography_support(): a custom font size becomes fluid when the theme asks for it. */
function renderFluidTypography(content: string, parsed: ParsedBlock, theme: ActiveTheme): string {
  const style = isObject(parsed.attrs.style) ? parsed.attrs.style : {};
  const typography = isObject(style.typography) ? style.typography : {};
  const size = typography.fontSize;
  if (typeof size !== 'string' && typeof size !== 'number') return content;
  const custom = String(size);
  const fluid = typographyFontSizeValue({ size: custom }, theme.settings as JsonObject);
  if (!fluid || fluid === custom) return content;
  const escaped = custom.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return content.replace(
    new RegExp(`font-size\\s*:\\s*${escaped}\\s*;?`),
    `font-size:${escAttr(fluid)};`,
  );
}

const ELEMENT_PATHS: Record<'button' | 'link' | 'heading', string[][]> = {
  button: [
    ['button', 'color', 'text'],
    ['button', 'color', 'background'],
    ['button', 'color', 'gradient'],
  ],
  link: [
    ['link', 'color', 'text'],
    ['link', ':hover', 'color', 'text'],
  ],
  heading: ['heading', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'].flatMap((el) => [
    [el, 'color', 'text'],
    [el, 'color', 'background'],
    [el, 'color', 'gradient'],
  ]),
};

const get = (value: unknown, path: string[]): unknown =>
  path.reduce<unknown>((v, key) => (isObject(v) ? v[key] : undefined), value);

/** The colour declarations of an element style object, as the style engine prints them. */
function elementDeclarations(style: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  const set = (property: string, value: unknown) => {
    if (typeof value !== 'string' || !value) return;
    const css = value.startsWith('var:') ? spacingValue(value) : value;
    if (css && !/[{}<>;]/.test(css)) out[property] = css;
  };
  set('color', get(style, ['color', 'text']));
  set('background-color', get(style, ['color', 'background']));
  set('background', get(style, ['color', 'gradient']));
  return out;
}

/** wp_render_elements_support_styles() (render_block_data). */
function elementsSupport(parsed: ParsedBlock, block: AnyBlock | undefined): ParsedBlock {
  const style = isObject(parsed.attrs.style) ? parsed.attrs.style : undefined;
  const elements = style && isObject(style.elements) ? style.elements : undefined;
  if (!elements || !block?.blockType) return parsed;
  const supports = block.blockType.supports;
  const skip = {
    link: shouldSkipSerialization(supports, 'color', 'link'),
    heading: shouldSkipSerialization(supports, 'color', 'heading'),
    button: shouldSkipSerialization(supports, 'color', 'button'),
  };
  const needed = (Object.keys(ELEMENT_PATHS) as (keyof typeof ELEMENT_PATHS)[]).some(
    (key) =>
      !skip[key] &&
      ELEMENT_PATHS[key].some((p) => get(elements, p) !== undefined && get(elements, p) !== null),
  );
  if (!needed) return parsed;
  const page = currentPage();
  const className = page ? page.uniqueId('wp-elements-') : 'wp-elements';
  const rules: { selector: string; declarations: Record<string, string> }[] = [];
  if (!skip.button && elements.button) {
    rules.push({
      selector: `.${className} .wp-element-button, .${className} .wp-block-button__link`,
      declarations: elementDeclarations(elements.button),
    });
  }
  if (!skip.link && elements.link) {
    rules.push({
      selector: `.${className} a:where(:not(.wp-element-button))`,
      declarations: elementDeclarations(elements.link),
    });
    const hover = get(elements.link, [':hover']);
    if (hover) {
      rules.push({
        selector: `.${className} a:where(:not(.wp-element-button)):hover`,
        declarations: elementDeclarations(hover),
      });
    }
  }
  if (!skip.heading) {
    if (elements.heading) {
      rules.push({
        selector: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].map((h) => `.${className} ${h}`).join(', '),
        declarations: elementDeclarations(elements.heading),
      });
    }
    for (const h of ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']) {
      if (elements[h])
        rules.push({
          selector: `.${className} ${h}`,
          declarations: elementDeclarations(elements[h]),
        });
    }
  }
  page?.addSupportStyle(stylesheetFromRules(rules));
  const current = typeof parsed.attrs.className === 'string' ? `${parsed.attrs.className} ` : '';
  return { ...parsed, attrs: { ...parsed.attrs, className: `${current}${className}` } };
}

/** wp_render_block_style_variation_support_styles() (render_block_data). */
function styleVariationSupport(parsed: ParsedBlock, theme: ActiveTheme): ParsedBlock {
  const className = parsed.attrs.className;
  if (typeof className !== 'string' || !parsed.blockName) return parsed;
  const raw = theme.themeJson.tree.getRawData();
  const blocks = isObject(raw.styles) && isObject(raw.styles.blocks) ? raw.styles.blocks : {};
  const variations = get(blocks, [parsed.blockName, 'variations']);
  if (!isObject(variations)) return parsed;
  for (const match of className.matchAll(/\bis-style-(?!default)(\S+)\b/g)) {
    const variation = match[1] as string;
    const data = variations[variation];
    if (!isObject(data) || !Object.keys(data).length) continue;
    const page = currentPage();
    if (!page) return parsed;
    const instance = page.uniqueId(`${variation}--`);
    const css = blockStyleVariationInstanceStyles(
      theme.themeJson,
      parsed.blockName,
      variation,
      instance,
    );
    if (!css) return parsed;
    page.variationStyles.push(css);
    return {
      ...parsed,
      attrs: { ...parsed.attrs, className: `${className} is-style-${instance}` },
    };
  }
  return parsed;
}

/** Registers the filters. Called once by the themes service. */
export function registerThemeSupports(kernel: Kernel): void {
  const { hooks } = kernel;
  const theme = async () => currentPage()?.theme ?? (await kernel.themes.active());

  // Core blocks WordPress renders on the server that Pressbase doesn't have
  // yet (comments, for one) render nothing instead of their saved placeholder.
  hooks.addFilter('pre_render_block', (pre, parsed) => {
    if (pre !== null && pre !== undefined) return pre;
    const name = parsed.blockName;
    return isUnavailableDynamicBlock(kernel.blocks.registry, name) ? '' : null;
  });

  // wp_add_parent_layout_to_parsed_block(), elements and style variations.
  hooks.addFilter(
    'render_block_data',
    async (value: unknown, _source: unknown, parent: unknown) => {
      let parsed = value as LayoutParsedBlock;
      const parentBlock = parent as AnyBlock | null;
      if (parentBlock && isObject(parentBlock.parsedBlock.attrs.layout)) {
        parsed = { ...parsed, parentLayout: parentBlock.parsedBlock.attrs.layout as JsonObject };
      }
      if (!parsed.blockName) return parsed;
      const type = kernel.blocks.registry.get(parsed.blockName);
      if (type)
        parsed = elementsSupport(parsed, { blockType: type } as AnyBlock) as LayoutParsedBlock;
      if (currentPage()) parsed = styleVariationSupport(parsed, await theme()) as LayoutParsedBlock;
      return parsed;
    },
  );

  hooks.addFilter('render_block', async (value: unknown, parsedBlock: unknown, block: unknown) => {
    let content = String(value ?? '');
    const parsed = parsedBlock as LayoutParsedBlock;
    const wpBlock = block as AnyBlock;
    if (!parsed.blockName || !content) return content;
    const active = await theme();
    const className = typeof parsed.attrs.className === 'string' ? parsed.attrs.className : '';
    const extra: string[] = [];
    // wp_render_elements_class_name() and wp_render_block_style_variation_class_name()
    const elementsClass = /\bwp-elements-\S+/.exec(className)?.[0];
    if (elementsClass) extra.push(elementsClass);
    const variationClass = /\bis-style-\S+?--\d+\b/.exec(className)?.[0];
    if (variationClass) extra.push(variationClass);
    if (extra.length) content = addClasses(content, extra);
    content = renderFluidTypography(content, parsed, active);
    content = await renderLayout(content, parsed, wpBlock, active);
    content = renderPosition(content, parsed, wpBlock, active);
    return content;
  });
}
