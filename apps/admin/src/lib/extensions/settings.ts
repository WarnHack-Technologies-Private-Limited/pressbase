/**
 * A plugin settings page as /pressbase/v1/plugin-pages/{plugin}/{page}
 * returns it, and the conversions the generic form needs: the admin draws
 * every field from this schema, so plugins ship no admin JavaScript for
 * settings. See docs/architecture/plugins.md#settings.
 */

import type { AdminPage } from './pages';

export type SettingControl =
  | 'text'
  | 'textarea'
  | 'number'
  | 'toggle'
  | 'select'
  | 'radio'
  | 'url'
  | 'email'
  | 'color';

export interface SettingField {
  /** The option name; the key in `values` and in the save request. */
  name: string;
  label: string;
  description: string;
  type: 'string' | 'boolean' | 'integer' | 'number' | 'array' | 'object';
  control: SettingControl;
  default: unknown;
  options: { value: string | number; label: string }[];
  min: number | null;
  max: number | null;
  step: number | null;
  max_length: number | null;
  placeholder: string;
  required: boolean;
}

export interface SettingSection {
  id: string;
  title: string;
  description: string;
  fields: SettingField[];
}

export interface PluginPageDetails extends AdminPage {
  sections: SettingSection[];
  values: Record<string, unknown>;
}

export function pageEndpoint(plugin: string, page: string): string {
  return `/pressbase/v1/plugin-pages/${encodeURIComponent(plugin)}/${encodeURIComponent(page)}`;
}

/** Form values for every field: what's stored, or the default. */
export function initialValues(page: Pick<PluginPageDetails, 'sections' | 'values'>) {
  const values: Record<string, unknown> = {};
  for (const section of page.sections) {
    for (const field of section.fields) {
      values[field.name] = field.name in page.values ? page.values[field.name] : field.default;
    }
  }
  return values;
}

/**
 * An input's string back to the field's type. Number fields keep an empty
 * or half-typed value as text, so the server can say what's wrong with it.
 */
export function fromInput(field: Pick<SettingField, 'control' | 'type'>, raw: string): unknown {
  const numeric = field.type === 'integer' || field.type === 'number';
  if (
    field.control === 'number' ||
    ((field.control === 'select' || field.control === 'radio') && numeric)
  ) {
    if (raw.trim() === '') return '';
    const n = Number(raw);
    return Number.isFinite(n) ? n : raw;
  }
  return raw;
}

/** An input's value attribute for the stored value. */
export function toInput(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value);
}

/** A colour input needs #rrggbb; expand #rgb and fall back to black. */
export function colorInputValue(value: unknown): string {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (/^#[0-9a-f]{6}$/.test(text)) return text;
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(text);
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;
  return '#000000';
}

/** A section's card title: its own, or the page's for the untitled first section. */
export function sectionTitle(section: SettingSection, pageTitle: string, index: number): string {
  return section.title || (index === 0 ? pageTitle : 'More settings');
}
