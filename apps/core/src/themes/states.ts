import { createHash } from 'node:crypto';
import {
  ELEMENTS,
  getViewportMediaQueries,
  type StyleEngineRule,
  styleEngineDeclarations,
  styleEngineStylesheet,
  VALID_BLOCK_PSEUDO_SELECTORS,
  VALID_ELEMENT_PSEUDO_SELECTORS,
} from '@pressbase/theme-json';

/**
 * Per-instance state styles (WordPress 7.1): a port of
 * wordpress/wp-includes/block-supports/states.php.
 *
 * A block's `style` attribute may hold pseudo states and viewport states:
 *
 * ```json
 * { "style": {
 *     "typography": { "fontSize": "3rem" },
 *     ":hover": { "color": { "background": "var:preset|color|contrast" } },
 *     "@mobile": {
 *       "typography": { "fontSize": "2rem" },
 *       "elements": { "link": { "color": { "text": "red" } } },
 *       ":hover": { "color": { "text": "blue" } }
 *     },
 *     "@tablet": { "spacing": { "padding": { "top": "1rem" } } } } }
 * ```
 *
 * Pseudo states are allowed only for the blocks in
 * VALID_BLOCK_PSEUDO_SELECTORS (Button, Navigation link); viewport states for
 * every block. The rules get a class named after a hash of the rules
 * (`wp-states-1a2b3c4d`, so identical instances share CSS), `!important`
 * declarations, and go to the block supports stylesheet, not the `style`
 * attribute. Layout values inside a state (`@mobile.layout`) are left to the
 * layout support, as in WordPress (not ported yet).
 */

type Style = Record<string, unknown>;

const isObject = (value: unknown): value is Style =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** PHP's empty() for the values states.php tests. */
const isEmpty = (value: unknown): boolean =>
  value === undefined ||
  value === null ||
  value === false ||
  value === '' ||
  value === '0' ||
  value === 0 ||
  (Array.isArray(value) && value.length === 0) ||
  (isObject(value) && Object.keys(value).length === 0);

/** array_replace_recursive() for style objects. */
function replaceRecursive(base: Style, replacement: Style): Style {
  const out: Style = { ...base };
  for (const [key, value] of Object.entries(replacement)) {
    const current = out[key];
    out[key] = isObject(current) && isObject(value) ? replaceRecursive(current, value) : value;
  }
  return out;
}

/** wp_normalize_state_preset_vars(): `var:preset|color|contrast` → `var(--wp--preset--color--contrast)`. */
export function normalizeStatePresetVars(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeStatePresetVars);
  if (isObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, normalizeStatePresetVars(v)]),
    );
  }
  if (typeof value !== 'string' || !value.startsWith('var:preset|')) return value;
  return `var(--wp--${value.slice('var:'.length).replaceAll('|', '--')})`;
}

/** wp_normalize_state_style_for_css_output(): layout is the layout support's. */
function normalizeStateStyle(style: Style): unknown {
  const { layout: _layout, ...rest } = style;
  return normalizeStatePresetVars(rest);
}

/** wp_get_state_declarations_with_fallback_border_styles() */
function fallbackBorderStyles(declarations: Style): Style {
  const has = (property: string) =>
    declarations[property] !== undefined &&
    declarations[property] !== null &&
    declarations[property] !== '';
  const out = { ...declarations };
  const hasBorderStyle = has('border-style');
  if (!hasBorderStyle && (has('border-color') || has('border-width')))
    out['border-style'] = 'solid';
  for (const side of ['top', 'right', 'bottom', 'left']) {
    if (
      !hasBorderStyle &&
      !has(`border-${side}-style`) &&
      (has(`border-${side}-color`) || has(`border-${side}-width`))
    ) {
      out[`border-${side}-style`] = 'solid';
    }
  }
  return out;
}

/** wp_get_state_declarations_with_background_resets(): a solid colour clears a gradient. */
function backgroundResets(declarations: Style): Style {
  const has = (property: string) =>
    declarations[property] !== undefined &&
    declarations[property] !== null &&
    declarations[property] !== '';
  if (has('background-color') && !has('background') && !has('background-image')) {
    return { ...declarations, 'background-image': 'unset' };
  }
  return declarations;
}

interface StyleGroup {
  selector: string | null;
  style: Style;
}

/** wp_add_state_style_group() */
function addGroup(groups: Map<string, StyleGroup>, selector: unknown, style: Style): void {
  const key = typeof selector === 'string' ? selector : '';
  const group = groups.get(key) ?? {
    selector: typeof selector === 'string' ? selector : null,
    style: {},
  };
  group.style = replaceRecursive(group.style, style);
  groups.set(key, group);
}

/** wp_get_state_style_groups(): splits a state's styles by the block's feature selectors. */
function stateStyleGroups(stateStyle: Style, blockSelectors: Style): StyleGroup[] {
  const groups = new Map<string, StyleGroup>();
  for (const [feature, featureStyles] of Object.entries(stateStyle)) {
    const featureSelectors = blockSelectors[feature];
    if (typeof featureSelectors === 'string') {
      addGroup(groups, featureSelectors, { [feature]: featureStyles });
      continue;
    }
    if (isObject(featureSelectors) && isObject(featureStyles)) {
      const remaining: Style = { ...featureStyles };
      for (const [subfeature, subSelector] of Object.entries(featureSelectors)) {
        if (
          subfeature === 'root' ||
          typeof subSelector !== 'string' ||
          !(subfeature in featureStyles)
        ) {
          continue;
        }
        addGroup(groups, subSelector, { [feature]: { [subfeature]: featureStyles[subfeature] } });
        delete remaining[subfeature];
      }
      if (Object.keys(remaining).length) {
        addGroup(groups, featureSelectors.root ?? blockSelectors.root ?? null, {
          [feature]: remaining,
        });
      }
      continue;
    }
    addGroup(groups, blockSelectors.root ?? null, { [feature]: featureStyles });
  }
  return [...groups.values()];
}

/** wp_get_root_state_style(): the state without its nested states. */
function rootStateStyle(stateStyle: Style, nestedKeys: string[]): Style {
  const out = { ...stateStyle };
  for (const key of nestedKeys) delete out[key];
  return out;
}

/** wp_split_selector_list(): top-level commas, parentheses respected, parts not trimmed. */
function splitSelectorList(selector: string): string[] {
  if (!selector.includes(',')) return [selector];
  const selectors: string[] = [];
  let current = '';
  let depth = 0;
  for (const char of selector) {
    if (char === '(') depth++;
    else if (char === ')' && depth > 0) depth--;
    else if (char === ',' && depth === 0) {
      selectors.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  selectors.push(current);
  return selectors;
}

/** wp_get_block_state_element_selectors(): each element's selector inside the block. */
function blockStateElementSelectors(rootSelector: string): Record<string, string> {
  if (rootSelector.trim() === '') return {};
  const blockSelectors = splitSelectorList(rootSelector);
  const out: Record<string, string> = {};
  for (const [element, elementSelector] of Object.entries(ELEMENTS)) {
    let selectors: string[] = [];
    for (const raw of blockSelectors) {
      const blockSelector = raw.trim();
      if (blockSelector === '') continue;
      if (blockSelector === elementSelector) {
        selectors = [elementSelector];
        break;
      }
      const prefix = `${blockSelector} `;
      if (!elementSelector.includes(',')) {
        selectors.push(prefix + elementSelector);
        continue;
      }
      selectors.push(
        splitSelectorList(elementSelector)
          .map((s) => prefix + s)
          .join(','),
      );
    }
    if (selectors.length) out[element] = selectors.join(',');
  }
  return out;
}

/** One compiled rule, as states.php keeps them (and hashes them). */
interface StateRule {
  state: string;
  selector: string | null;
  declarations: Style;
  rules_group?: string;
}

/** wp_add_block_state_style_rule() */
function addStateRule(
  rules: StateRule[],
  state: string,
  selector: string | null,
  style: unknown,
  rulesGroup?: string,
): void {
  if (isEmpty(style) || !isObject(style)) return;
  const declarations = styleEngineDeclarations(normalizeStateStyle(style)) as Style;
  // Base text alignment is a class, so a state needs a declaration.
  const typography = style.typography;
  const textAlign = isObject(typography) ? typography.textAlign : undefined;
  if (typeof textAlign === 'string' && textAlign.trim() !== '')
    declarations['text-align'] = textAlign;
  if (!Object.keys(declarations).length) return;
  const rule: StateRule = { state, selector, declarations };
  if (rulesGroup) rule.rules_group = rulesGroup;
  rules.push(rule);
}

/** wp_get_block_state_style_rules() */
function blockStateStyleRules(
  stateStyles: [string, unknown][],
  blockSelectors: Style,
  rulesGroup?: string,
): StateRule[] {
  const rules: StateRule[] = [];
  for (const [state, stateStyle] of stateStyles) {
    if (isEmpty(stateStyle) || !isObject(stateStyle)) continue;
    for (const group of stateStyleGroups(stateStyle, blockSelectors)) {
      addStateRule(rules, state, group.selector, group.style, rulesGroup);
    }
  }
  return rules;
}

/** wp_json_encode() as PHP prints it: `/` and non-ASCII characters escaped. */
function phpJsonEncode(value: unknown): string {
  return JSON.stringify(value)
    .replace(/\//g, '\\/')
    .replace(/[\u0080-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** wp_get_block_state_unique_class() */
function uniqueStateClass(blockName: string, rules: StateRule[]): string {
  const json = phpJsonEncode({ blockName, rules });
  return `wp-states-${createHash('md5').update(json).digest('hex').slice(0, 8)}`;
}

/** wp_build_state_selector(): the instance class replaces the selector's leading block part. */
export function buildStateSelector(
  base: string,
  blockSelector: string | null,
  state: string,
): string {
  if (typeof blockSelector !== 'string' || blockSelector.trim() === '') return base + state;
  const scoped: string[] = [];
  for (const raw of splitSelectorList(blockSelector)) {
    const selector = raw.trim();
    if (selector === '') continue;
    const match = /^([.#]?[-_a-zA-Z0-9]+|\[[^\]]+\])/.exec(selector);
    scoped.push(match ? base + selector.slice(match[0].length) + state : base + state);
  }
  return scoped.length ? scoped.join(', ') : base + state;
}

export interface BlockStatesInput {
  blockName: string;
  /** The block's `style` attribute. */
  style: unknown;
  /** The block type's `selectors` (block.json), `{}` when it has none. */
  selectors: Style;
  /** wp_get_block_css_selector( $block_type ): the block's root selector. */
  rootSelector: string;
  /** wp_get_global_settings( array( 'viewport' ) ) */
  viewport: unknown;
}

/**
 * The work of wp_render_block_states_support(): the class to add to the
 * block's first tag and the CSS for the block supports stylesheet, or null
 * when the block has no state styles.
 */
export function blockStateStyles(
  input: BlockStatesInput,
): { className: string; css: string } | null {
  const style = input.style;
  if (isEmpty(style) || !isObject(style)) return null;
  const pseudoStates = VALID_BLOCK_PSEUDO_SELECTORS[input.blockName] ?? [];
  const mediaQueries = getViewportMediaQueries(input.viewport);
  let rules: StateRule[] = [];

  for (const pseudo of pseudoStates) {
    if (isEmpty(style[pseudo]) || !isObject(style[pseudo])) continue;
    rules.push(...blockStateStyleRules([[pseudo, style[pseudo]]], input.selectors));
  }

  for (const [breakpoint, mediaQuery] of Object.entries(mediaQueries)) {
    const breakpointStyle = style[breakpoint];
    if (isEmpty(breakpointStyle) || !isObject(breakpointStyle)) continue;
    const root = rootStateStyle(breakpointStyle, ['elements', ...pseudoStates]);
    if (!isEmpty(root)) {
      rules.push(...blockStateStyleRules([['', root]], input.selectors, mediaQuery));
    }
    const elements = breakpointStyle.elements;
    if (!isEmpty(elements) && isObject(elements)) {
      const elementSelectors = blockStateElementSelectors(input.rootSelector);
      for (const [elementName, elementStyle] of Object.entries(elements)) {
        const elementSelector = elementSelectors[elementName];
        if (isEmpty(elementStyle) || !isObject(elementStyle) || !elementSelector) continue;
        const elementPseudoStates = VALID_ELEMENT_PSEUDO_SELECTORS[elementName] ?? [];
        addStateRule(
          rules,
          '',
          elementSelector,
          rootStateStyle(elementStyle, elementPseudoStates),
          mediaQuery,
        );
        for (const pseudo of elementPseudoStates) {
          const pseudoStyle = elementStyle[pseudo];
          if (isEmpty(pseudoStyle) || !isObject(pseudoStyle)) continue;
          addStateRule(rules, pseudo, elementSelector, pseudoStyle, mediaQuery);
        }
      }
    }
    for (const pseudo of pseudoStates) {
      const pseudoStyle = breakpointStyle[pseudo];
      if (isEmpty(pseudoStyle) || !isObject(pseudoStyle)) continue;
      rules = rules.concat(
        blockStateStyleRules([[pseudo, pseudoStyle]], input.selectors, mediaQuery),
      );
    }
  }
  if (!rules.length) return null;

  const className = uniqueStateClass(input.blockName, rules);
  const styleRules: StyleEngineRule[] = [];
  for (const rule of rules) {
    const selector = buildStateSelector(`.${className}`, rule.selector, rule.state);
    // State declarations are important, to win over inline styles and preset classes.
    styleRules.push({
      selector,
      declarations: backgroundResets(rule.declarations),
      important: true,
      rulesGroup: rule.rules_group,
    });
    const fallback = fallbackBorderStyles(rule.declarations);
    for (const property of Object.keys(rule.declarations)) delete fallback[property];
    if (!Object.keys(fallback).length) continue;
    styleRules.push({ selector, declarations: fallback, rulesGroup: rule.rules_group });
  }
  return { className, css: styleEngineStylesheet(styleRules) };
}
