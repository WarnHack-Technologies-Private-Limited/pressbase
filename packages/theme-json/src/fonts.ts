import type { JsonObject } from './types';
import { isObject, isSafeCssValue } from './util';

/**
 * @font-face rules for the fonts a theme declares in theme.json —
 * WP_Font_Face_Resolver::get_fonts_from_theme_json() and WP_Font_Face
 * (wordpress/wp-includes/fonts/), as wp_print_font_faces() prints them.
 */

const VALID_PROPERTIES = [
  'ascent-override',
  'descent-override',
  'font-display',
  'font-family',
  'font-stretch',
  'font-style',
  'font-weight',
  'font-variant',
  'font-feature-settings',
  'font-variation-settings',
  'line-gap-override',
  'size-adjust',
  'src',
  'unicode-range',
];
const FONT_DISPLAY = ['auto', 'block', 'fallback', 'swap', 'optional'];
const FORMATS: [string, string][] = [
  ['woff2', 'woff2'],
  ['woff', 'woff'],
  ['ttf', 'truetype'],
  ['eot', 'embedded-opentype'],
  ['otf', 'opentype'],
];

const kebab = (key: string) => key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/**
 * `fontFamilies` is the merged settings.typography.fontFamilies (keyed by
 * origin or a flat list). `resolveFileUri` turns `file:./assets/x.woff2`
 * into a URL (get_theme_file_uri()).
 */
export function fontFaceCss(
  fontFamilies: unknown,
  resolveFileUri: (relativePath: string) => string,
): string {
  const families: JsonObject[] = [];
  if (Array.isArray(fontFamilies)) families.push(...fontFamilies.filter(isObject));
  else if (isObject(fontFamilies)) {
    for (const list of Object.values(fontFamilies)) {
      if (Array.isArray(list)) families.push(...list.filter(isObject));
    }
  }

  const rules: string[] = [];
  for (const family of families) {
    if (!Array.isArray(family.fontFace)) continue;
    for (const face of family.fontFace) {
      if (!isObject(face)) continue;
      const declarations: Record<string, unknown> = {
        'font-family': '',
        'font-style': 'normal',
        'font-weight': '400',
        'font-display': 'fallback',
      };
      for (const [key, value] of Object.entries(face)) declarations[kebab(key)] = value;
      let name = typeof declarations['font-family'] === 'string' ? declarations['font-family'] : '';
      name = name.replace(/^["']|["']$/g, '').trim();
      if (!name) continue;
      const sources = (Array.isArray(face.src) ? face.src : [face.src]).filter(
        (s): s is string => typeof s === 'string' && s !== '',
      );
      if (!sources.length) continue;
      if (
        typeof declarations['font-weight'] !== 'string' &&
        typeof declarations['font-weight'] !== 'number'
      ) {
        continue;
      }
      if (!FONT_DISPLAY.includes(String(declarations['font-display']))) {
        declarations['font-display'] = 'fallback';
      }

      // order_src(): data URIs, then woff2, woff, ttf, eot, otf.
      const byFormat = new Map<string, string>();
      const ordered: string[] = [];
      for (const raw of sources) {
        const url = raw.startsWith('file:./') ? resolveFileUri(raw.slice('file:./'.length)) : raw;
        if (url.trim().startsWith('data:')) {
          ordered.push(`url('${url}')`);
          continue;
        }
        const ext = /\.([a-z0-9]+)(?:[?#].*)?$/i.exec(url)?.[1]?.toLowerCase() ?? '';
        byFormat.set(ext, url);
      }
      for (const [ext, format] of FORMATS) {
        const url = byFormat.get(ext);
        if (url) ordered.push(`url('${url.replace(/'/g, '%27')}') format('${format}')`);
      }
      if (!ordered.length) continue;

      if (name.includes(' ')) name = `"${name}"`;
      let css = '';
      for (const [key, value] of Object.entries({ ...declarations, 'font-family': name })) {
        if (!VALID_PROPERTIES.includes(key)) continue;
        let text: string;
        if (key === 'src') text = ordered.join(', ');
        else if (key === 'font-variation-settings' && isObject(value)) {
          text = Object.entries(value)
            .map(([axis, v]) => `"${axis}" ${String(v)}`)
            .join(', ');
        } else text = String(value ?? '');
        if (!text || (key !== 'src' && !isSafeCssValue(text))) continue;
        css += `${key}:${text};`;
      }
      rules.push(`@font-face{${css}}`);
    }
  }
  return rules.join('\n');
}
