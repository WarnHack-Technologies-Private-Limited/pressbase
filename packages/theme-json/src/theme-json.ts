import { getBlocksMetadata } from './blocks-metadata';
import {
  APPEARANCE_TOOLS_OPT_INS,
  ELEMENT_CLASS_NAMES,
  ELEMENTS,
  LATEST_SCHEMA,
  LAYOUT_DEFINITIONS,
  PRESETS_METADATA,
  PROPERTIES_METADATA,
  type PresetMetadata,
  ROOT_BLOCK_SELECTOR,
  ROOT_CSS_PROPERTIES_SELECTOR,
  VALID_BLOCK_CUSTOM_STATES,
  VALID_BLOCK_PSEUDO_SELECTORS,
  VALID_ELEMENT_PSEUDO_SELECTORS,
  VALID_ORIGINS,
  VALID_TOP_LEVEL_KEYS,
} from './constants';
import { appendToSelector, blockStyleVariationFeatureSelector, scopeSelector } from './selectors';
import type {
  BlockMetadata,
  BlocksMetadata,
  Declaration,
  JsonObject,
  JsonValue,
  Origin,
  StylesheetOptions,
  StylesheetType,
  ThemeJsonData,
} from './types';
import { typographyFontSizeValue } from './typography';
import {
  arrayGet,
  arraySet,
  clone,
  isArrayLike,
  isEmpty,
  isNumeric,
  isObject,
  isSafeCssValue,
  replaceRecursive,
  resolveCustomCssFormat,
  toKebabCase,
} from './util';

/**
 * WP_Theme_JSON (wordpress/wp-includes/class-wp-theme-json.php), the parts
 * that build a site's global styles: sanitising and merging origins, and
 * get_stylesheet() — preset custom properties, preset classes, root layout
 * rules and the styles of the body, elements and blocks.
 *
 * Not ported: responsive (viewport) style states, duotone SVG filters, the
 * editor-only settings API and remove_insecure_properties() beyond a
 * conservative value filter for user (`custom`) data.
 */

interface StyleNode {
  path: string[];
  selector: string | null;
  name?: string;
  selectors?: JsonObject;
  elements?: Record<string, string>;
  duotone?: string;
  variations?: { name: string; path: string[]; selector: string }[];
  css?: string | null;
}

interface SettingNode {
  path: string[];
  selector: string | null;
  selectors?: JsonObject;
}

const toRuleset = (selector: string, declarations: Declaration[]): string => {
  const body = declarations
    .filter((d) => typeof d.value === 'string' || typeof d.value === 'number')
    .map((d) => `${d.name}: ${String(d.value)};`)
    .join('');
  return body ? `${selector}{${body}}` : '';
};

/** WP_Theme_JSON_Schema::migrate() for schema versions 2 → 3. */
function migrate(input: ThemeJsonData, origin: Origin): ThemeJsonData {
  const data = clone(input);
  if ((data.version ?? 1) < 3 && origin === 'theme') {
    const settings = isObject(data.settings) ? data.settings : undefined;
    if (settings) {
      if (
        arrayGet(settings, ['typography', 'fontSizes']) !== undefined &&
        arrayGet(settings, ['typography', 'defaultFontSizes']) === undefined
      ) {
        arraySet(settings, ['typography', 'defaultFontSizes'], false);
      }
      if (
        (arrayGet(settings, ['spacing', 'spacingSizes']) !== undefined ||
          arrayGet(settings, ['spacing', 'spacingScale']) !== undefined) &&
        arrayGet(settings, ['spacing', 'defaultSpacingSizes']) === undefined
      ) {
        arraySet(settings, ['spacing', 'defaultSpacingSizes'], false);
      }
    }
  }
  data.version = LATEST_SCHEMA;
  return data;
}

/** Removes CSS values that could escape their declaration, for user-provided data. */
function stripUnsafeValues(tree: JsonObject): JsonObject {
  const out: JsonObject = {};
  for (const [key, value] of Object.entries(tree)) {
    if (key === 'css') continue;
    if (typeof value === 'string') {
      if (isSafeCssValue(value) && !/url\s*\(/i.test(value)) out[key] = value;
    } else if (isObject(value)) {
      out[key] = stripUnsafeValues(value);
    } else if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

/** compute_spacing_sizes(): the spacing presets a spacingScale generates. */
export function computeSpacingSizes(scale: JsonObject): JsonObject[] {
  const { steps, mediumStep, unit: rawUnit, operator, increment } = scale;
  if (
    typeof steps !== 'number' ||
    steps === 0 ||
    typeof mediumStep !== 'number' ||
    typeof rawUnit !== 'string' ||
    (operator !== '+' && operator !== '*') ||
    typeof increment !== 'number'
  ) {
    return [];
  }
  const unit = rawUnit === '%' ? '%' : rawUnit.toLowerCase().replace(/[^a-z0-9-]/g, '');
  const round2 = (n: number) => Math.round(n * 100) / 100;
  const midpoint = Math.round(steps / 2);
  let current = mediumStep;
  let xSmall: number | null = null;
  const below: JsonObject[] = [];
  let slug = 40;
  let remainder = 0;
  for (let count = midpoint - 1; steps > 1 && slug > 0 && count > 0; count--) {
    if (operator === '+') current -= increment;
    else if (increment > 1) current /= increment;
    else current *= increment;
    if (current <= 0) {
      remainder = count;
      break;
    }
    below.push({
      name: count === midpoint - 1 ? 'Small' : `${xSmall ?? ''}X-Small`,
      slug: String(slug),
      size: `${round2(current)}${unit}`,
    });
    if (count === midpoint - 2) xSmall = 2;
    if (count < midpoint - 2 && xSmall !== null) xSmall++;
    slug -= 10;
  }
  below.reverse();
  below.push({ name: 'Medium', slug: '50', size: `${mediumStep}${unit}` });
  current = mediumStep;
  let xLarge: number | null = null;
  const above: JsonObject[] = [];
  slug = 60;
  const stepsAbove = steps - midpoint + remainder;
  for (let count = 0; count < stepsAbove; count++) {
    current =
      operator === '+'
        ? current + increment
        : increment >= 1
          ? current * increment
          : current / increment;
    above.push({
      name: count === 0 ? 'Large' : `${xLarge ?? ''}X-Large`,
      slug: String(slug),
      size: `${round2(current)}${unit}`,
    });
    if (count === 1) xLarge = 2;
    if (count > 1 && xLarge !== null) xLarge++;
    slug += 10;
  }
  return [...below, ...above];
}

/** merge_spacing_sizes(): generated sizes, overridden by slug, sorted by slug. */
function mergeSpacingSizes(base: JsonObject[], incoming: JsonValue): JsonValue {
  if (!base.length) return incoming;
  const merged = new Map<string, JsonObject>();
  for (const item of base) merged.set(String(item.slug), item);
  if (Array.isArray(incoming)) {
    for (const item of incoming) if (isObject(item)) merged.set(String(item.slug), item);
  }
  return [...merged.entries()]
    .sort(([a], [b]) => Number(a) - Number(b) || (a < b ? -1 : a > b ? 1 : 0))
    .map(([, item]) => item);
}

export class ThemeJson {
  #data: ThemeJsonData;
  readonly blocks: BlocksMetadata;

  /**
   * `blocks` is get_blocks_metadata() for the registered block types; it
   * defaults to WordPress's core blocks.
   */
  constructor(
    input: ThemeJsonData = { version: LATEST_SCHEMA },
    readonly origin: Origin = 'theme',
    blocks: BlocksMetadata = getBlocksMetadata(),
  ) {
    this.blocks = blocks;
    let data = migrate(input, origin);
    data = this.#unwrapSharedVariations(data);
    data = this.#sanitize(data);
    if (origin === 'custom' && isObject(data.styles)) data.styles = stripUnsafeValues(data.styles);
    this.#optIn(data);

    // Presets are keyed by origin internally.
    for (const node of this.#settingNodes(data)) {
      for (const preset of PRESETS_METADATA) {
        const path = [...node.path, ...preset.path];
        const value = arrayGet(data, path, null);
        if (Array.isArray(value)) arraySet(data, path, { [origin]: value });
      }
    }
    const scalePath = ['settings', 'spacing', 'spacingScale'];
    const scale = arrayGet(data, scalePath, null);
    if (
      isObject(scale) &&
      !Object.keys(scale).some((k) => (VALID_ORIGINS as readonly string[]).includes(k))
    ) {
      arraySet(data, scalePath, { [origin]: scale });
    }
    const originScale = arrayGet(data, [...scalePath, origin], null);
    if (isObject(originScale)) {
      const sizesPath = ['settings', 'spacing', 'spacingSizes', origin];
      arraySet(
        data,
        sizesPath,
        mergeSpacingSizes(
          computeSpacingSizes(originScale),
          arrayGet(data, sizesPath, []) as JsonValue,
        ),
      );
    }
    this.#data = data;
  }

  /** The tree as stored: presets keyed by origin. */
  getRawData(): ThemeJsonData {
    return this.#data;
  }

  /** get_settings() */
  getSettings(): JsonObject {
    return isObject(this.#data.settings) ? this.#data.settings : {};
  }

  /** Settings with presets flattened to their highest-priority origin (wp_get_global_settings()). */
  getGlobalSettings(): JsonObject {
    const settings = clone(this.getSettings());
    for (const preset of PRESETS_METADATA) {
      const value = arrayGet(settings, preset.path);
      if (!isObject(value)) continue;
      const merged: JsonValue[] = [];
      for (const origin of VALID_ORIGINS) {
        const list = value[origin];
        if (Array.isArray(list)) merged.push(...list);
      }
      arraySet(settings, preset.path, merged);
    }
    return settings;
  }

  /** get_custom_templates() */
  getCustomTemplates(): JsonObject[] {
    return (this.#data.customTemplates ?? []).filter(isObject);
  }

  /** get_template_parts() */
  getTemplateParts(): JsonObject[] {
    return (this.#data.templateParts ?? []).filter(isObject);
  }

  /* ---------------------------------------------------------- sanitising */

  /** unwrap_shared_block_style_variations() */
  #unwrapSharedVariations(input: ThemeJsonData): ThemeJsonData {
    const shared = arrayGet(input, ['styles', 'variations']);
    if (!isObject(shared)) return input;
    const data = clone(input);
    for (const [blockName, block] of Object.entries(this.blocks)) {
      for (const variation of Object.keys(block.styleVariations)) {
        const blockLevel = arrayGet(
          data,
          ['styles', 'blocks', blockName, 'variations', variation],
          {},
        );
        const topLevel = shared[variation] ?? {};
        const merged = replaceRecursive(topLevel, blockLevel as JsonValue);
        if (!isEmpty(merged)) {
          arraySet(data, ['styles', 'blocks', blockName, 'variations', variation], merged);
        }
      }
    }
    delete (data.styles as JsonObject).variations;
    return data;
  }

  /**
   * sanitize(), simplified: keeps the valid top-level keys, drops style and
   * setting nodes for blocks that aren't registered and unknown variations,
   * and turns `var:preset|…` references into CSS custom properties.
   */
  #sanitize(input: ThemeJsonData): ThemeJsonData {
    const out: ThemeJsonData = {};
    for (const key of VALID_TOP_LEVEL_KEYS) {
      if (input[key] !== undefined) out[key] = input[key];
    }
    for (const subtree of ['styles', 'settings'] as const) {
      const value = out[subtree];
      if (value === undefined) continue;
      if (!isObject(value)) {
        delete out[subtree];
        continue;
      }
      const tree = clone(value);
      const blocks = tree.blocks;
      if (isObject(blocks)) {
        for (const [name, node] of Object.entries(blocks)) {
          const metadata = this.blocks[name];
          if (!metadata || !isObject(node)) {
            delete blocks[name];
            continue;
          }
          if (subtree === 'styles' && isObject(node.variations)) {
            for (const variation of Object.keys(node.variations)) {
              if (!(variation in metadata.styleVariations)) delete node.variations[variation];
            }
          }
        }
      }
      if (Object.keys(tree).length === 0) delete out[subtree];
      else out[subtree] = resolveCustomCssFormat(tree);
    }
    return out;
  }

  /** maybe_opt_in_into_settings() */
  #optIn(data: ThemeJsonData): void {
    const optIn = (context: JsonObject) => {
      for (const path of APPEARANCE_TOOLS_OPT_INS) {
        if (arrayGet(context, path, 'unset prop') === 'unset prop') arraySet(context, path, true);
      }
      delete context.appearanceTools;
    };
    const settings = data.settings;
    if (!isObject(settings)) return;
    if (settings.appearanceTools === true) optIn(settings);
    if (isObject(settings.blocks)) {
      for (const block of Object.values(settings.blocks)) {
        if (isObject(block) && block.appearanceTools === true) optIn(block);
      }
    }
  }

  /* ------------------------------------------------------------- merging */

  /** merge(): `incoming` takes precedence; presets are replaced per origin. */
  merge(incoming: ThemeJson): void {
    const incomingData = clone(incoming.getRawData());
    this.#data = replaceRecursive(this.#data, incomingData) as ThemeJsonData;

    // Spacing scales: merge partial scales with lower layers, then regenerate.
    let flattened: JsonObject = {};
    for (const origin of VALID_ORIGINS) {
      const scalePath = ['settings', 'spacing', 'spacingScale', origin];
      const base = arrayGet(this.#data, scalePath, {});
      if (isObject(base)) flattened = { ...flattened, ...base };
      const scale = arrayGet(incomingData, scalePath, null);
      if (!isObject(scale)) continue;
      flattened = { ...flattened, ...scale };
      const sizesPath = ['settings', 'spacing', 'spacingSizes', origin];
      arraySet(
        incomingData,
        sizesPath,
        mergeSpacingSizes(
          computeSpacingSizes(flattened),
          arrayGet(incomingData, sizesPath, []) as JsonValue,
        ),
      );
    }

    const slugsGlobal = this.#defaultSlugs(['settings']);
    for (const node of this.#settingNodes(incomingData)) {
      const unitsPath = [...node.path, 'spacing', 'units'];
      const units = arrayGet(incomingData, unitsPath);
      if (units !== undefined && units !== null)
        arraySet(this.#data, unitsPath, units as JsonValue);

      for (const preset of PRESETS_METADATA) {
        let preventOverride: unknown = preset.preventOverride;
        if (Array.isArray(preventOverride)) {
          const globalValue = arrayGet(this.#data, ['settings', ...preventOverride], null);
          preventOverride = arrayGet(this.#data, [...node.path, ...preventOverride], globalValue);
        }
        const basePath = [...node.path, ...preset.path];
        for (const origin of VALID_ORIGINS) {
          const path = [...basePath, origin];
          let content = arrayGet(incomingData, path, null);
          if (!Array.isArray(content)) continue;
          if (origin === 'theme' && preset.useDefaultNames) {
            content = content.map((item) => {
              if (!isObject(item) || item.name !== undefined) return item;
              const name = this.#nameFromDefaults(String(item.slug), basePath);
              return name === undefined ? item : { ...item, name };
            });
          }
          if (origin === 'theme' && preventOverride) {
            const nodeSlugs = this.#defaultSlugs(node.path);
            const slugs = [
              ...((arrayGet(slugsGlobal, preset.path, []) as string[]) ?? []),
              ...((arrayGet(nodeSlugs, preset.path, []) as string[]) ?? []),
            ];
            if (slugs.length) {
              content = (content as JsonValue[]).filter(
                (item) => !(isObject(item) && slugs.includes(String(item.slug))),
              );
            }
          }
          arraySet(this.#data, path, content as JsonValue);
        }
      }
    }
  }

  /** get_default_slugs() */
  #defaultSlugs(nodePath: string[]): JsonObject {
    const slugs: JsonObject = {};
    for (const preset of PRESETS_METADATA) {
      const list = arrayGet(this.#data, [...nodePath, ...preset.path, 'default'], null);
      if (!Array.isArray(list)) continue;
      arraySet(
        slugs,
        preset.path,
        list.filter(isObject).map((item) => String(item.slug)),
      );
    }
    return slugs;
  }

  /** get_name_from_defaults() */
  #nameFromDefaults(slug: string, basePath: string[]): string | undefined {
    const list = arrayGet(this.#data, [...basePath, 'default'], null);
    if (!Array.isArray(list)) return undefined;
    const match = list.find((item) => isObject(item) && item.slug === slug);
    return isObject(match) && typeof match.name === 'string' ? match.name : undefined;
  }

  /* --------------------------------------------------------------- nodes */

  /** get_setting_nodes() */
  #settingNodes(data: ThemeJsonData = this.#data): SettingNode[] {
    if (!isObject(data.settings)) return [];
    const nodes: SettingNode[] = [{ path: ['settings'], selector: ROOT_CSS_PROPERTIES_SELECTOR }];
    const blocks = data.settings.blocks;
    if (!isObject(blocks)) return nodes;
    for (const name of Object.keys(blocks)) {
      nodes.push({
        path: ['settings', 'blocks', name],
        selector: this.blocks[name]?.selector ?? null,
        selectors: this.blocks[name]?.selectors ?? {},
      });
    }
    return nodes;
  }

  /** get_style_nodes() */
  #styleNodes(options: StylesheetOptions): StyleNode[] {
    const styles = this.#data.styles;
    if (!isObject(styles)) return [];
    const nodes: StyleNode[] = [{ path: ['styles'], selector: ROOT_BLOCK_SELECTOR }];
    const elements = styles.elements;
    if (isObject(elements)) {
      for (const [element, selector] of Object.entries(ELEMENTS)) {
        const node = elements[element];
        if (node === undefined) continue;
        nodes.push({ path: ['styles', 'elements', element], selector });
        for (const pseudo of VALID_ELEMENT_PSEUDO_SELECTORS[element] ?? []) {
          if (isObject(node) && node[pseudo] !== undefined) {
            nodes.push({
              path: ['styles', 'elements', element],
              selector: appendToSelector(selector, pseudo),
            });
          }
        }
      }
    }
    if (isObject(styles.blocks)) nodes.push(...this.#blockNodes(styles.blocks, options));
    return nodes;
  }

  /** get_block_nodes() */
  #blockNodes(blocks: JsonObject, options: StylesheetOptions): StyleNode[] {
    const nodes: StyleNode[] = [];
    for (const [name, node] of Object.entries(blocks)) {
      const metadata = this.blocks[name];
      const selector = metadata?.selector ?? null;
      const variations: StyleNode['variations'] = [];
      if (options.includeBlockStyleVariations && isObject(node) && isObject(node.variations)) {
        for (const variation of Object.keys(node.variations)) {
          const variationSelector = metadata?.styleVariations[variation];
          if (!variationSelector) continue;
          variations.push({
            name: variation,
            path: ['styles', 'blocks', name, 'variations', variation],
            selector: variationSelector,
          });
        }
      }
      nodes.push({
        name,
        path: ['styles', 'blocks', name],
        selector,
        selectors: metadata?.selectors,
        elements: metadata?.elements ?? {},
        duotone: metadata?.duotone,
        variations,
        css: selector,
      });

      if (!isObject(node)) continue;
      for (const pseudo of VALID_BLOCK_PSEUDO_SELECTORS[name] ?? []) {
        if (node[pseudo] === undefined || !selector) continue;
        const pseudoSelectors: JsonObject = {};
        for (const [feature, featureSelector] of Object.entries(metadata?.selectors ?? {})) {
          if (isObject(featureSelector)) {
            const sub: JsonObject = {};
            for (const [key, value] of Object.entries(featureSelector)) {
              if (typeof value === 'string') sub[key] = appendToSelector(value, pseudo);
            }
            pseudoSelectors[feature] = sub;
          } else if (typeof featureSelector === 'string') {
            pseudoSelectors[feature] = appendToSelector(featureSelector, pseudo);
          }
        }
        nodes.push({
          name,
          path: ['styles', 'blocks', name, pseudo],
          selector: appendToSelector(selector, pseudo),
          selectors: pseudoSelectors,
          elements: metadata?.elements ?? {},
          duotone: metadata?.duotone,
          variations,
          css: appendToSelector(selector, pseudo),
        });
      }
      for (const state of VALID_BLOCK_CUSTOM_STATES[name] ?? []) {
        const stateSelector = metadata?.states?.[state];
        if (node[state] === undefined || typeof stateSelector !== 'string') continue;
        nodes.push({
          name,
          path: ['styles', 'blocks', name, state],
          selector: stateSelector,
          selectors: metadata?.selectors,
          elements: metadata?.elements ?? {},
          variations,
          css: stateSelector,
        });
      }

      const elements = node.elements;
      if (isObject(elements)) {
        for (const element of Object.keys(elements)) {
          const elementSelector = metadata?.elements[element];
          if (!elementSelector) continue;
          nodes.push({
            path: ['styles', 'blocks', name, 'elements', element],
            selector: elementSelector,
          });
          const elementNode = elements[element];
          for (const pseudo of VALID_ELEMENT_PSEUDO_SELECTORS[element] ?? []) {
            if (isObject(elementNode) && elementNode[pseudo] !== undefined) {
              nodes.push({
                path: ['styles', 'blocks', name, 'elements', element],
                selector: appendToSelector(elementSelector, pseudo),
              });
            }
          }
        }
      }
    }
    return nodes;
  }

  /* ---------------------------------------------------------- stylesheet */

  /**
   * get_stylesheet(): `variables` (preset and custom properties), `styles`
   * (root layout rules, body, elements and blocks), `presets` (the
   * `.has-*` classes) and `custom-css` (styles.css).
   */
  getStylesheet(
    types: StylesheetType[] = ['variables', 'styles', 'presets'],
    origins: readonly Origin[] = VALID_ORIGINS,
    options: StylesheetOptions = {},
  ): string {
    let styleNodes = this.#styleNodes(options);
    let settingNodes = this.#settingNodes();
    if (options.scope) {
      const scope = options.scope;
      settingNodes = settingNodes.map((node) => ({
        ...node,
        selector: node.selector === null ? null : scopeSelector(scope, node.selector),
      }));
      styleNodes = styleNodes.map((node) => this.#scopeNode(scope, node));
    }
    if (options.rootSelector) {
      const settingsRoot = settingNodes.find((n) => n.path.length === 1);
      if (settingsRoot) settingsRoot.selector = options.rootSelector;
      const styleRoot = styleNodes.find((n) => n.path.length === 1);
      if (styleRoot) styleRoot.selector = options.rootSelector;
    }

    let css = '';
    if (types.includes('variables')) css += this.#cssVariables(settingNodes, origins);
    if (types.includes('styles')) {
      const root = styleNodes.find((n) => n.path.length === 1 && n.path[0] === 'styles');
      if (root?.selector && !options.skipRootLayoutStyles) {
        css += this.getRootLayoutRules(root);
      }
      for (const node of styleNodes) {
        if (node.selector !== null) css += this.getStylesForBlock(node);
      }
    }
    if (types.includes('presets')) css += this.#presetClasses(settingNodes, origins);
    if (types.includes('custom-css')) {
      const custom = arrayGet(this.#data, ['styles', 'css']);
      if (typeof custom === 'string') css += custom;
    }
    return css;
  }

  /** scope_style_node_selectors() */
  #scopeNode(scope: string, node: StyleNode): StyleNode {
    const out: StyleNode = {
      ...node,
      selector: node.selector === null ? null : scopeSelector(scope, node.selector),
    };
    if (!node.selectors || !Object.keys(node.selectors).length) return out;
    const selectors: JsonObject = {};
    for (const [feature, selector] of Object.entries(node.selectors)) {
      if (typeof selector === 'string') selectors[feature] = scopeSelector(scope, selector);
      else if (isObject(selector)) {
        const sub: JsonObject = {};
        for (const [key, value] of Object.entries(selector)) {
          sub[key] = typeof value === 'string' ? scopeSelector(scope, value) : value;
        }
        selectors[feature] = sub;
      }
    }
    out.selectors = selectors;
    return out;
  }

  /** get_settings_values_by_slug() */
  #valuesBySlug(settings: JsonObject, preset: PresetMetadata, origins: readonly Origin[]) {
    const perOrigin = arrayGet(settings, preset.path, {});
    const result = new Map<string, string>();
    if (!isObject(perOrigin)) return result;
    const global = this.getGlobalSettings();
    for (const origin of origins) {
      const list = perOrigin[origin];
      if (!Array.isArray(list)) continue;
      for (const item of list) {
        if (!isObject(item)) continue;
        const slug = toKebabCase(String(item.slug ?? ''));
        let value: unknown;
        if (preset.valueKey && item[preset.valueKey] !== undefined) value = item[preset.valueKey];
        else if (preset.valueFunc === 'fontSize') {
          value = typographyFontSizeValue(item, { ...global, ...settings });
        } else continue;
        if (typeof value === 'string' || typeof value === 'number') result.set(slug, String(value));
      }
    }
    return result;
  }

  /** get_settings_slugs() */
  #slugs(settings: JsonObject, preset: PresetMetadata, origins: readonly Origin[]): string[] {
    const perOrigin = arrayGet(settings, preset.path, {});
    const result = new Set<string>();
    if (!isObject(perOrigin)) return [];
    for (const origin of origins) {
      const list = perOrigin[origin];
      if (!Array.isArray(list)) continue;
      for (const item of list) if (isObject(item)) result.add(toKebabCase(String(item.slug ?? '')));
    }
    return [...result];
  }

  /** get_css_variables() */
  #cssVariables(nodes: SettingNode[], origins: readonly Origin[]): string {
    let css = '';
    for (const node of nodes) {
      if (node.selector === null) continue;
      const settings = arrayGet(this.#data, node.path, {});
      if (!isObject(settings)) continue;
      const bySelector = new Map<string, Declaration[]>([[node.selector, []]]);
      for (const preset of PRESETS_METADATA) {
        if (!preset.cssVars) continue;
        const values = this.#valuesBySlug(settings, preset, origins);
        if (!values.size) continue;
        const target = featureSelectorOf(
          node.selectors ?? {},
          preset.path[0] as string,
          node.selector,
        );
        const list = bySelector.get(target) ?? [];
        bySelector.set(target, list);
        for (const [slug, value] of values) {
          list.push({ name: preset.cssVars.replace('$slug', slug), value });
        }
      }
      // compute_theme_vars(): settings.custom → --wp--custom--*.
      const custom = settings.custom;
      if (isObject(custom)) {
        const list = bySelector.get(node.selector) ?? [];
        for (const [name, value] of Object.entries(flattenTree(custom))) {
          list.push({ name: `--wp--custom--${name}`, value });
        }
      }
      for (const [selector, declarations] of bySelector) css += toRuleset(selector, declarations);
    }
    return css;
  }

  /** get_preset_classes() / compute_preset_classes() */
  #presetClasses(nodes: SettingNode[], origins: readonly Origin[]): string {
    let css = '';
    for (const node of nodes) {
      if (node.selector === null) continue;
      const settings = arrayGet(this.#data, node.path, {});
      if (!isObject(settings)) continue;
      const selector =
        node.selector === ROOT_BLOCK_SELECTOR || node.selector === ROOT_CSS_PROPERTIES_SELECTOR
          ? ''
          : node.selector;
      for (const preset of PRESETS_METADATA) {
        if (!preset.cssVars || !Object.keys(preset.classes).length) continue;
        const slugs = this.#slugs(settings, preset, origins);
        for (const [className, property] of Object.entries(preset.classes)) {
          for (const slug of slugs) {
            const cssVar = preset.cssVars.replace('$slug', slug);
            const name = className.replace('$slug', slug);
            const full = selector === '' ? name : `:where(${selector})${name}`;
            css += toRuleset(full, [{ name: property, value: `var(${cssVar}) !important` }]);
          }
        }
      }
    }
    return css;
  }

  /** get_property_value(): resolves `{ ref: "styles.color.text" }`. */
  #propertyValue(styles: JsonObject, path: string[]): unknown {
    const value = arrayGet(styles, path, '');
    if (value === '' || value === null) return '';
    if (isObject(value) && typeof value.ref === 'string') {
      const ref = arrayGet(this.#data, value.ref.split('.'));
      if (typeof ref === 'string' && ref !== '') return ref;
      if (isObject(ref) && typeof ref.url === 'string') return ref;
    }
    return value;
  }

  /** compute_style_properties() */
  computeStyleProperties(
    styles: unknown,
    selector?: string,
    useRootPadding = false,
  ): Declaration[] {
    if (!isObject(styles) || !Object.keys(styles).length) return [];
    const settings = this.getGlobalSettings();
    const declarations: Declaration[] = [];
    const duplicates: string[] = [];
    for (const [property, path] of PROPERTIES_METADATA) {
      const isRootStyle = property.startsWith('--wp--style--root--');
      if (isRootStyle && (selector !== ROOT_BLOCK_SELECTOR || !useRootPadding)) continue;
      let value = this.#propertyValue(styles, path);
      if (property === '--wp--style--root--padding' && typeof value === 'string') continue;
      if (isRootStyle && useRootPadding)
        duplicates.push(property.slice('--wp--style--root--'.length));

      if (property === 'background-image') {
        if (isObject(value) && typeof value.url === 'string' && isSafeCssValue(value.url)) {
          value = `url('${value.url.replace(/'/g, '%27')}')`;
        }
        const gradient = arrayGet(styles, ['background', 'gradient']);
        if (typeof gradient === 'string' && gradient) {
          value = typeof value === 'string' && value ? `${value}, ${gradient}` : gradient;
        }
      }
      if ((isEmpty(value) && !isNumeric(value)) || isArrayLike(value)) continue;
      let text = String(value);
      if (property === 'font-size')
        text = typographyFontSizeValue({ size: text }, settings) ?? text;
      if (property === 'aspect-ratio') declarations.push({ name: 'min-height', value: 'unset' });
      declarations.push({ name: property, value: text });
    }
    return declarations.filter((d) => !duplicates.includes(d.name));
  }

  /** get_feature_declarations_for_node(): removes the features it handles from `node`. */
  #featureDeclarations(metadata: StyleNode, node: JsonObject): Map<string, Declaration[]> {
    const out = new Map<string, Declaration[]>();
    if (!metadata.selectors) return out;
    const add = (selector: string, declarations: Declaration[]) => {
      out.set(selector, [...(out.get(selector) ?? []), ...declarations]);
    };
    for (const [feature, featureSelectors] of Object.entries(metadata.selectors)) {
      if (feature === 'root' || feature === 'css' || isEmpty(node[feature])) continue;
      if (isObject(featureSelectors)) {
        for (const [subfeature, subSelector] of Object.entries(featureSelectors)) {
          const featureNode = node[feature];
          if (subfeature === 'root' || !isObject(featureNode) || isEmpty(featureNode[subfeature])) {
            continue;
          }
          if (typeof subSelector !== 'string') continue;
          add(
            subSelector,
            this.computeStyleProperties({ [feature]: { [subfeature]: featureNode[subfeature] } }),
          );
          delete featureNode[subfeature];
        }
      }
      const root =
        typeof featureSelectors === 'string'
          ? featureSelectors
          : isObject(featureSelectors) && typeof featureSelectors.root === 'string'
            ? featureSelectors.root
            : '';
      if (root && node[feature] !== undefined) {
        add(root, this.computeStyleProperties({ [feature]: node[feature] }));
        delete node[feature];
      }
    }
    return out;
  }

  /** process_blocks_custom_css(): `&`-nested CSS from theme.json, under `:root :where()`. */
  static processBlocksCustomCss(css: string, selector: string): string {
    let out = '';
    for (const part of css.split('&')) {
      if (!part) continue;
      if (!part.includes('{')) {
        out += `:root :where(${selector.trim()}){${part.trim()}}`;
        continue;
      }
      const pieces = part.replaceAll('}', '').split('{');
      if (pieces.length !== 2) continue;
      let nested = pieces[0] as string;
      const value = pieces[1] as string;
      const pseudo = /([>+~\s]*::[a-zA-Z-]+)/.exec(nested)?.[1] ?? '';
      if (pseudo) nested = nested.replace(pseudo, '');
      const partSelector = nested.startsWith(' ')
        ? scopeSelector(selector, nested)
        : appendToSelector(selector, nested);
      out += `:root :where(${partSelector})${pseudo}{${value.trim()}}`;
    }
    return out;
  }

  /** process_pseudo_selectors() for a block style variation's states. */
  #pseudoDeclarations(
    node: JsonObject,
    baseSelector: string,
    blockName: string | undefined,
    metadata: StyleNode,
    variation: { name: string; selector: string },
  ): Map<string, Declaration[]> {
    const out = new Map<string, Declaration[]>();
    if (!blockName) return out;
    const add = (selector: string, declarations: Declaration[]) => {
      if (!declarations.length) return;
      out.set(selector, [...(out.get(selector) ?? []), ...declarations]);
    };
    for (const pseudo of VALID_BLOCK_PSEUDO_SELECTORS[blockName] ?? []) {
      const pseudoNode = node[pseudo];
      if (!isObject(pseudoNode)) continue;
      const copy = clone(pseudoNode);
      for (const [selector, declarations] of this.#featureDeclarations(metadata, copy)) {
        add(
          appendToSelector(blockStyleVariationFeatureSelector(variation, selector), pseudo),
          declarations,
        );
      }
      add(appendToSelector(baseSelector, pseudo), this.computeStyleProperties(pseudoNode));
    }
    return out;
  }

  /** get_styles_for_block() */
  getStylesForBlock(metadata: StyleNode): string {
    const selector = metadata.selector;
    if (selector === null) return '';
    const node = clone(arrayGet(this.#data, metadata.path, {})) as JsonObject;
    const useRootPadding = this.getSettings().useRootPaddingAwareAlignments === true;
    const isRoot = selector === ROOT_BLOCK_SELECTOR;
    const features = isObject(node) ? this.#featureDeclarations(metadata, node) : new Map();
    const blockName =
      metadata.name ?? (metadata.path[1] === 'blocks' ? metadata.path[2] : undefined);

    // Block style variations (only when requested, as WordPress does).
    const variationDeclarations = new Map<string, Declaration[]>();
    const variationCss = new Map<string, string>();
    const variationLayout = new Map<string, { metadata: StyleNode; node: JsonObject }>();
    for (const variation of metadata.variations ?? []) {
      const variationNode = clone(arrayGet(this.#data, variation.path, {})) as JsonObject;
      if (!isObject(variationNode)) continue;
      for (const [featureSelector, declarations] of this.#featureDeclarations(
        metadata,
        variationNode,
      )) {
        variationDeclarations.set(
          blockStyleVariationFeatureSelector(variation, featureSelector),
          declarations,
        );
      }
      variationDeclarations.set(variation.selector, this.computeStyleProperties(variationNode));
      for (const [s, d] of this.#pseudoDeclarations(
        variationNode,
        variation.selector,
        blockName,
        metadata,
        variation,
      )) {
        variationDeclarations.set(s, d);
      }
      if (typeof variationNode.css === 'string') {
        variationCss.set(
          variation.selector,
          ThemeJson.processBlocksCustomCss(variationNode.css, variation.selector),
        );
      }
      if (arrayGet(variationNode, ['spacing', 'blockGap']) !== undefined) {
        variationLayout.set(variation.selector, {
          metadata: {
            ...variation,
            name: blockName,
            selector: `${variation.selector}${metadata.css ?? ''}`,
          },
          node: variationNode,
        });
      }
    }

    // The node itself; element pseudo states use their own sub-node.
    const elementIndex = metadata.path.indexOf('elements');
    const currentElement = elementIndex >= 0 ? metadata.path[metadata.path.length - 1] : undefined;
    const allowed = currentElement ? (VALID_ELEMENT_PSEUDO_SELECTORS[currentElement] ?? []) : [];
    const pseudo = allowed.find((p) =>
      new RegExp(`${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?!-)`).test(selector),
    );
    let declarations =
      pseudo && isObject(node[pseudo])
        ? this.computeStyleProperties(node[pseudo], selector, useRootPadding)
        : this.computeStyleProperties(node, selector, useRootPadding);

    let css = '';
    const duotone: Declaration[] = [];
    let rootMinHeight = false;
    declarations = declarations.filter((d) => {
      if (isRoot && (d.name === 'background-image' || d.name === 'background'))
        rootMinHeight = true;
      if (d.name === 'filter') {
        if (d.value !== 'unset') duotone.push(d);
        return false;
      }
      return true;
    });
    if (rootMinHeight) {
      css += toRuleset('html', [
        { name: 'min-height', value: 'calc(100% - var(--wp-admin--admin-bar--height, 0px))' },
      ]);
    }
    if (selector === '.wp-block-separator')
      declarations = updateSeparatorDeclarations(declarations);

    const elementOnly =
      isRoot ||
      (currentElement !== undefined &&
        ELEMENTS[currentElement] !== undefined &&
        ELEMENT_CLASS_NAMES[currentElement] === undefined &&
        ELEMENTS[currentElement] === selector);
    css += toRuleset(elementOnly ? selector : `:root :where(${selector})`, declarations);
    if (metadata.duotone && duotone.length) css += toRuleset(metadata.duotone, duotone);
    if (!isRoot && metadata.name) css += this.getLayoutStyles(metadata);
    for (const [featureSelector, list] of features) {
      css += toRuleset(`:root :where(${featureSelector})`, list);
    }
    for (const [variationSelector, list] of variationDeclarations) {
      css += toRuleset(`:root :where(${variationSelector})`, list);
      const layout = variationLayout.get(variationSelector);
      if (layout) css += this.getLayoutStyles(layout.metadata, layout.node);
      css += variationCss.get(variationSelector) ?? '';
    }
    if (typeof node.css === 'string' && !isRoot) {
      const cssFeature = metadata.selectors?.css;
      const cssSelector =
        typeof cssFeature === 'string'
          ? cssFeature
          : isObject(cssFeature) && typeof cssFeature.root === 'string'
            ? cssFeature.root
            : selector;
      css += ThemeJson.processBlocksCustomCss(node.css, cssSelector);
    }
    return css;
  }

  /** get_layout_styles(): block gap rules per layout type, and base layout styles at the root. */
  getLayoutStyles(metadata: StyleNode, nodeOverride?: JsonObject): string {
    let css = '';
    const block = metadata.name ? this.blocks[metadata.name] : undefined;
    if (metadata.name) {
      if (!block || !supportsLayout(block)) return css;
    }
    const selector = metadata.selector ?? '';
    const hasBlockGapSupport =
      arrayGet(this.#data, ['settings', 'spacing', 'blockGap']) !== undefined &&
      arrayGet(this.#data, ['settings', 'spacing', 'blockGap']) !== null;
    const node = nodeOverride ?? (arrayGet(this.#data, metadata.path, {}) as JsonObject);
    const pattern = /^[a-zA-Z0-9\-., *+>:()]*$/;

    let gap: unknown = null;
    if (!hasBlockGapSupport) {
      gap = selector === ROOT_BLOCK_SELECTOR ? '0.5em' : null;
      if (block)
        gap = arrayGet(block.supports, ['spacing', 'blockGap', '__experimentalDefault'], null);
    } else {
      gap = this.#propertyValue(node, ['spacing', 'blockGap']);
    }
    if (isObject(gap)) {
      if (gap.top !== undefined && gap.left !== undefined) {
        const row = this.#propertyValue(node, ['spacing', 'blockGap', 'top']);
        const column = this.#propertyValue(node, ['spacing', 'blockGap', 'left']);
        gap = row === column ? row : `${row} ${column}`;
      } else gap = null;
    }
    if (gap !== null && gap !== false && gap !== '' && gap !== undefined) {
      for (const [key, definition] of Object.entries(LAYOUT_DEFINITIONS)) {
        if (!hasBlockGapSupport && key !== 'flex' && key !== 'grid') continue;
        for (const rule of definition.spacingStyles) {
          if (!pattern.test(rule.selector)) continue;
          const declarations: Declaration[] = [];
          for (const [property, value] of Object.entries(rule.rules)) {
            const resolved = typeof value === 'string' ? value : String(gap);
            if (isSafeCssValue(resolved)) declarations.push({ name: property, value: resolved });
          }
          const layoutSelector = !hasBlockGapSupport
            ? selector === ROOT_BLOCK_SELECTOR
              ? `:where(.${definition.className}${rule.selector})`
              : `:where(${selector}.${definition.className}${rule.selector})`
            : selector === ROOT_BLOCK_SELECTOR
              ? `:root :where(.${definition.className})${rule.selector}`
              : `:root :where(${selector}-${definition.className})${rule.selector}`;
          css += toRuleset(layoutSelector, declarations);
        }
      }
    }

    if (selector === ROOT_BLOCK_SELECTOR) {
      const hasSizes =
        arrayGet(this.#data, ['settings', 'layout', 'contentSize']) !== undefined ||
        arrayGet(this.#data, ['settings', 'layout', 'wideSize']) !== undefined;
      for (const definition of Object.values(LAYOUT_DEFINITIONS)) {
        if (definition.displayMode) {
          css += toRuleset(`${selector} .${definition.className}`, [
            { name: 'display', value: definition.displayMode },
          ]);
        }
        for (const rule of definition.baseStyles) {
          if (!pattern.test(rule.selector)) continue;
          const declarations: Declaration[] = [];
          for (const [property, value] of Object.entries(rule.rules)) {
            if (value === null) continue;
            if (
              (value.includes('--global--content-size') || value.includes('--global--wide-size')) &&
              !hasSizes
            ) {
              continue;
            }
            declarations.push({ name: property, value });
          }
          css += toRuleset(`.${definition.className}${rule.selector}`, declarations);
        }
      }
    }
    return css;
  }

  /** get_root_layout_rules() */
  getRootLayoutRules(metadata: StyleNode): string {
    let css = '';
    const settings = this.getSettings();
    const layout = isObject(settings.layout) ? settings.layout : {};
    const useRootPadding = settings.useRootPaddingAwareAlignments === true;
    if (layout.contentSize !== undefined || layout.wideSize !== undefined) {
      const safe = (v: unknown) => (typeof v === 'string' && isSafeCssValue(v) ? v : 'initial');
      const content = safe(layout.contentSize ?? layout.wideSize);
      const wide = safe(layout.wideSize ?? layout.contentSize);
      css += `${ROOT_CSS_PROPERTIES_SELECTOR} { --wp--style--global--content-size: ${content};`;
      css += `--wp--style--global--wide-size: ${wide}; }`;
    }
    css += ':where(body) { margin: 0; }';
    if (useRootPadding) {
      css +=
        '.wp-site-blocks { padding-top: var(--wp--style--root--padding-top); padding-bottom: var(--wp--style--root--padding-bottom); }';
      css +=
        '.has-global-padding { padding-right: var(--wp--style--root--padding-right); padding-left: var(--wp--style--root--padding-left); }';
      css +=
        '.has-global-padding > .alignfull { margin-right: calc(var(--wp--style--root--padding-right) * -1); margin-left: calc(var(--wp--style--root--padding-left) * -1); }';
      css +=
        '.has-global-padding :where(:not(.alignfull.is-layout-flow) > .has-global-padding:not(.wp-block-block, .alignfull)) { padding-right: 0; padding-left: 0; }';
      css +=
        '.has-global-padding :where(:not(.alignfull.is-layout-flow) > .has-global-padding:not(.wp-block-block, .alignfull)) > .alignfull { margin-left: 0; margin-right: 0; }';
    }
    css += '.wp-site-blocks > .alignleft { float: left; margin-right: 2em; }';
    css += '.wp-site-blocks > .alignright { float: right; margin-left: 2em; }';
    css +=
      '.wp-site-blocks > .aligncenter { justify-content: center; margin-left: auto; margin-right: auto; }';
    const blockGap = arrayGet(this.#data, ['settings', 'spacing', 'blockGap']);
    if (blockGap !== undefined && blockGap !== null) {
      const value = String(this.#propertyValue(this.#data, ['styles', 'spacing', 'blockGap']));
      css += `:where(.wp-site-blocks) > * { margin-block-start: ${value}; margin-block-end: 0; }`;
      css += ':where(.wp-site-blocks) > :first-child { margin-block-start: 0; }';
      css += ':where(.wp-site-blocks) > :last-child { margin-block-end: 0; }';
      css += `${ROOT_CSS_PROPERTIES_SELECTOR} { --wp--style--block-gap: ${value}; }`;
    }
    css += this.getLayoutStyles(metadata);
    return css;
  }
}

/** get_feature_selector() */
function featureSelectorOf(selectors: JsonObject, feature: string, fallback: string): string {
  const value = selectors[feature];
  if (typeof value === 'string') return value;
  if (isObject(value) && typeof value.root === 'string') return value.root;
  return fallback;
}

/** flatten_tree(): settings.custom → `--wp--custom--{a}--{b}` names. */
function flattenTree(tree: JsonObject, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(tree)) {
    const name = prefix + toKebabCase(key).toLowerCase().replaceAll('/', '-');
    if (isObject(value)) Object.assign(out, flattenTree(value, `${name}--`));
    else if (value !== undefined && value !== null && !Array.isArray(value))
      out[name] = String(value);
  }
  return out;
}

/** update_separator_declarations(): a background colour also colours the separator's line. */
function updateSeparatorDeclarations(declarations: Declaration[]): Declaration[] {
  const background = declarations.find((d) => d.name === 'background-color')?.value;
  const hasBorder = declarations.some((d) => d.name === 'border-color');
  const hasText = declarations.some((d) => d.name === 'color');
  if (background && !hasBorder && !hasText)
    return [...declarations, { name: 'color', value: background }];
  return declarations;
}

/** block_has_support( 'layout' ) || block_has_support( '__experimentalLayout' ) */
export function supportsLayout(block: Pick<BlockMetadata, 'supports'>): boolean {
  const layout = block.supports.layout ?? block.supports.__experimentalLayout;
  return layout !== undefined && layout !== false && layout !== null;
}
